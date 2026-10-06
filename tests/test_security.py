from __future__ import annotations

import gzip
import json

import pytest
from scapy.all import IP, TCP, Ether, Raw, wrpcap  # type: ignore[import-untyped]

from netseer.ingest import ingest_files
from netseer.security import assess_graph, distro_name, service_findings, tls_findings, vulndb, wifi_findings
from netseer.security import fetch as vfetch
from netseer.security.software import parse_banner, version_key
from netseer.services import infer_service_from_payload

SERVER_MAC, CLIENT_MAC = "00:11:22:33:44:01", "00:11:22:33:44:02"


@pytest.fixture(autouse=True)
def own_vulndb_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("NETSEER_VULNDB_DIR", str(tmp_path / "vulndb"))


def small_db(generated="2026-01-01T00:00:00Z", epss=0.5):
    return {
        "generated": generated,
        "epss_date": "2026-01-01",
        "kev_date": "2026-01-01",
        "products": {
            "openbsd:openssh": [
                {"id": "CVE-2024-6387", "summary": "regreSSHion", "cvss": 8.1, "severity": "HIGH", "epss": epss, "percentile": 0.99, "kev": False, "ranges": [["8.5p1", True, "9.8p1", False]], "versions": []},
                {"id": "CVE-2000-0001", "summary": "old", "cvss": 5.0, "severity": "MEDIUM", "epss": 0.01, "percentile": 0.2, "kev": False, "ranges": [], "versions": ["7.4"]},
            ],
            "apache:http_server": [
                {"id": "CVE-2021-41773", "summary": "path traversal", "cvss": 7.5, "severity": "HIGH", "epss": 0.99, "percentile": 1.0, "kev": True, "ranges": [], "versions": ["2.4.49"]},
            ],
        },
    }


def test_banners_name_products_and_versions():
    [ssh] = parse_banner("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13", "SSH banner")
    assert (ssh.name, ssh.version, ssh.cpes) == ("OpenSSH", "9.6p1", ("openbsd:openssh",))
    [drop] = parse_banner("SSH-2.0-dropbear_2020.81", "SSH banner")
    assert (drop.name, drop.version) == ("Dropbear SSH", "2020.81")
    found = {(s.name, s.version) for s in parse_banner("Apache/2.4.49 (Unix) OpenSSL/1.1.1k PHP/7.4.3", "HTTP Server header")}
    assert found == {("Apache HTTP Server", "2.4.49"), ("OpenSSL", "1.1.1k"), ("PHP", "7.4.3")}
    [jetty] = parse_banner("Jetty(9.4.43.v20210629)", "HTTP Server header")
    assert jetty.name == "Eclipse Jetty" and jetty.version.startswith("9.4.43")
    [bare] = parse_banner("nginx", "HTTP Server header")
    assert (bare.name, bare.version, bare.cpes) == ("nginx", None, ("f5:nginx", "nginx:nginx"))
    [unknown] = parse_banner("GoAhead-Webs", "HTTP Server header")
    assert (unknown.name, unknown.version, unknown.cpes) == ("GoAhead-Webs", None, ())
    [cisco] = parse_banner("SSH-2.0-Cisco-1.25", "SSH banner")
    assert cisco.cpes == () and cisco.version == "1.25" and cisco.key == "cisco"  # unknown, but a version to look up


def test_version_order():
    assert version_key("9.6") < version_key("9.6p1") < version_key("9.7") < version_key("10.0")
    assert version_key("1.0.2") < version_key("1.0.2k") < version_key("1.0.2l") < version_key("1.1.0")
    assert version_key("2.4.9") < version_key("2.4.29")


def test_matching_uses_ranges_and_exact_versions_without_guessing():
    db = small_db()
    vuln = lambda banner: [v["id"] for v in vulndb.vulnerabilities(parse_banner(banner, "x")[0], db)]  # noqa: E731
    assert vuln("SSH-2.0-OpenSSH_9.6p1") == ["CVE-2024-6387"]
    assert vuln("SSH-2.0-OpenSSH_8.5p1") == ["CVE-2024-6387"]  # start is inclusive
    assert vuln("SSH-2.0-OpenSSH_9.8p1") == []  # end is exclusive
    assert vuln("SSH-2.0-OpenSSH_7.4") == ["CVE-2000-0001"]
    assert vuln("Apache/2.4.49") == ["CVE-2021-41773"] and vuln("Apache/2.4.50") == []
    assert vuln("nginx") == []  # no version: nothing to match


def test_bundled_database_loads_and_a_newer_download_wins(tmp_path):
    db, source = vulndb.load()
    assert source == "bundled" and db["products"]["openbsd:openssh"]
    info = vulndb.info()
    assert info["bundled"]["vulnerabilities"] > 500 and info["downloaded"] is None
    vulndb.write(vulndb.downloaded_path(), small_db(generated="2999-01-01T00:00:00Z"))
    assert vulndb.load()[1] == "downloaded" and vulndb.info()["active"] == "downloaded"
    vulndb.write(vulndb.downloaded_path(), small_db(generated="2000-01-01T00:00:00Z"))
    assert vulndb.load()[1] == "bundled"  # an older download doesn't replace newer bundled data
    vulndb.downloaded_path().write_bytes(b"not gzip")
    assert vulndb.load()[1] == "bundled"  # a damaged download is ignored


def ap(enc, **extra):
    return {"id": "mac:aa", "kind": "ap", "label": "Lab", "roles": ["ap"], "ssids": ["Lab"], "encryption": enc, "extra": extra}


def test_wifi_findings():
    ids = lambda node: [f["id"] for f in wifi_findings(node)]  # noqa: E731
    assert ids(ap(["Open"])) == ["wifi-open"]
    assert ids(ap(["WEP"])) == ["wifi-wep"]
    assert ids(ap(["WPA-PSK"])) == ["wifi-wpa1", "wifi-psk"]
    assert ids(ap(["WPA/WPA2-PSK"])) == ["wifi-mixed", "wifi-psk"]
    assert ids(ap(["WPA2-PSK", "WPA2 CCMP PSK", "WPA+PSK+WPA+AES-CCM"])) == ["wifi-psk"]
    assert ids(ap(["WPA3-SAE"])) == [] and ids(ap(["WPA2-802.1X", "WPA2 CCMP MGT"])) == [] and ids(ap(["OWE"])) == []
    assert ids(ap(["WPA2-PSK"], wps=True)) == ["wifi-wps", "wifi-psk"]
    assert wifi_findings({"id": "x", "kind": "host", "encryption": ["Open"]}) == []  # only access points
    assert wifi_findings(ap(["WEP"]))[0]["severity"] == "critical"


def test_service_and_tls_findings():
    node = {"ports": [{"role": "listen", "service": "telnet", "display": "telnet tcp/23"}, {"role": "listen", "service": "ssh", "display": "ssh tcp/22"}], "services": ["telnet", "ssh"]}
    [telnet] = service_findings(node)
    assert (telnet["id"], telnet["severity"], telnet["evidence"]) == ("svc-telnet", "high", "Seen offering telnet tcp/23")
    assert [f["id"] for f in tls_findings({"extra": {"tls_versions": ["TLS 1.0", "TLS 1.2"]}})] == ["tls-old"]
    assert [f["id"] for f in tls_findings({"extra": {"tls_versions": ["SSL 3.0"]}})] == ["tls-ssl3"]
    assert tls_findings({"extra": {"tls_versions": ["TLS 1.3"]}}) == []


def server_hello(version: int, tls13: bool = False) -> bytes:
    body = b"\x02" + b"\x00\x00\x46" + version.to_bytes(2, "big") + b"\x00" * 32 + b"\x00" + b"\x13\x01" + b"\x00"
    ext = b"\x00\x2b\x00\x02\x03\x04" if tls13 else b""
    body += len(ext).to_bytes(2, "big") + ext
    return b"\x16\x03\x03" + len(body).to_bytes(2, "big") + body


def test_payloads_reveal_software_and_tls_versions():
    _, meta = infer_service_from_payload(b"HTTP/1.1 200 OK\r\nServer: Apache/2.4.49 (Unix)\r\nX-Powered-By: PHP/7.4.3\r\n\r\n", 80, 51000)
    assert meta["software"] == [{"raw": "Apache/2.4.49 (Unix)", "source": "HTTP Server header"}, {"raw": "PHP/7.4.3", "source": "HTTP X-Powered-By header"}]
    _, meta = infer_service_from_payload(b"GET / HTTP/1.1\r\nHost: x\r\nServer: fake/1.0\r\n\r\n", 51000, 80)
    assert "software" not in meta  # only responses describe the server
    assert infer_service_from_payload(server_hello(0x0301), 443, 51000)[1]["tls_version"] == "TLS 1.0"
    assert infer_service_from_payload(server_hello(0x0303), 443, 51000)[1]["tls_version"] == "TLS 1.2"
    assert infer_service_from_payload(server_hello(0x0303, tls13=True), 443, 51000)[1]["tls_version"] == "TLS 1.3"


def test_capture_to_findings_end_to_end(tmp_path):
    def pkt(src, dst, sport, dport, load, smac=SERVER_MAC, dmac=CLIENT_MAC):
        return Ether(src=smac, dst=dmac) / IP(src=src, dst=dst) / TCP(sport=sport, dport=dport, flags="PA") / Raw(load=load)

    pkts = [
        pkt("10.0.0.2", "10.0.0.5", 51000, 80, b"GET / HTTP/1.1\r\nHost: cam\r\n\r\n", CLIENT_MAC, SERVER_MAC),
        pkt("10.0.0.5", "10.0.0.2", 80, 51000, b"HTTP/1.1 200 OK\r\nServer: Apache/2.4.49 (Unix)\r\n\r\n"),
        pkt("10.0.0.5", "10.0.0.2", 22, 51001, b"SSH-2.0-OpenSSH_9.6p1\r\n"),
        pkt("10.0.0.2", "10.0.0.5", 51002, 23, b"\xff\xfd\x18", CLIENT_MAC, SERVER_MAC),
        pkt("10.0.0.5", "10.0.0.2", 443, 51003, server_hello(0x0301)),
    ]
    path = tmp_path / "lab.pcap"
    wrpcap(str(path), pkts)
    graph = ingest_files([(path.name, path.read_bytes())]).to_dict()
    # Plain TCP doesn't tie an address to the Ethernet sender (it may be a router), so the server is its IP.
    server = next(n for n in graph["nodes"] if n["id"] == "ip:10.0.0.5")
    assert {s["raw"] for s in server["extra"]["software"]} == {"Apache/2.4.49 (Unix)", "SSH-2.0-OpenSSH_9.6p1"}
    assert server["extra"]["tls_versions"] == ["TLS 1.0"]
    client = next(n for n in graph["nodes"] if n["id"] == "ip:10.0.0.2")
    assert not client["extra"].get("software")
    vulndb.write(vulndb.downloaded_path(), small_db(generated="2999-01-01T00:00:00Z"))
    result = assess_graph(graph)["nodes"]["ip:10.0.0.5"]
    assert {f["id"] for f in result["findings"]} >= {"svc-telnet", "svc-http", "tls-old"}
    by_name = {s["name"]: s for s in result["software"]}
    assert [v["id"] for v in by_name["Apache HTTP Server"]["vulnerabilities"]] == ["CVE-2021-41773"]
    assert [v["id"] for v in by_name["OpenSSH"]["vulnerabilities"]] == ["CVE-2024-6387"]
    assert result["worst"] == "high" and result["kev"] is True and result["max_epss"] == 0.99


def test_nvd_records_become_ranges_and_versions():
    cve = {"configurations": [{"nodes": [{"cpeMatch": [
        {"vulnerable": True, "criteria": "cpe:2.3:a:openbsd:openssh:*:*:*:*:*:*:*:*", "versionStartIncluding": "8.5", "versionEndExcluding": "9.8"},
        {"vulnerable": True, "criteria": "cpe:2.3:a:openbsd:openssh:7.4:p1:*:*:*:*:*:*"},
        {"vulnerable": True, "criteria": "cpe:2.3:a:openbsd:openssh:*:*:*:*:*:*:*:*"},  # every version: too vague
        {"vulnerable": False, "criteria": "cpe:2.3:o:linux:linux_kernel:-:*:*:*:*:*:*:*"},
    ]}]}]}
    assert vfetch._matches(cve, "openbsd:openssh") == ([["8.5", True, "9.8", False]], ["7.4p1"])


def test_epss_file(monkeypatch):
    csv_text = "#model_version:v1,score_date:2026-10-06T00:00:00Z\ncve,epss,percentile\nCVE-1,0.5,0.9\nCVE-2,0.1,0.2\n"
    monkeypatch.setattr(vfetch, "_get", lambda url, **kw: gzip.compress(csv_text.encode()))
    assert vfetch.fetch_epss({"CVE-1"}) == ({"CVE-1": (0.5, 0.9)}, "2026-10-06")


def test_security_api(monkeypatch):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    client = TestClient(webmod.app)
    graph = {"nodes": [ap(["WEP"])], "links": []}
    res = client.post("/api/security/assess", json=graph).json()
    assert res["nodes"]["mac:aa"]["worst"] == "critical" and res["database"]["source"] == "bundled"
    info = client.get("/api/security/database").json()
    assert info["can_refresh"] is True and info["refresh"]["state"] == "idle"
    # A refresh runs in the background and saves a downloaded copy.
    monkeypatch.setattr(webmod.vuln_fetch, "build", lambda progress=None, should_stop=None, extra_products=None: small_db(generated="2999-01-01T00:00:00Z"))
    assert client.post("/api/security/refresh").status_code == 200
    import time

    for _ in range(50):
        if client.get("/api/security/database").json()["refresh"]["state"] == "done":
            break
        time.sleep(0.05)
    info = client.get("/api/security/database").json()
    assert info["refresh"]["state"] == "done" and info["active"] == "downloaded"
    # The public copy can't download.
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert client.post("/api/security/refresh").status_code == 403
    assert client.get("/api/security/database").json()["can_refresh"] is False
    webmod.VULN_JOB.update(state="idle")
    json.dumps(res)  # plain JSON


def test_distribution_banners_are_flagged():
    assert distro_name("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.4") == "Ubuntu"
    assert distro_name("SSH-2.0-OpenSSH_7.4p1 Debian-10+deb9u7") == "Debian"
    assert distro_name("Apache/2.4.6 (CentOS) OpenSSL/1.0.2k-fips") == "CentOS"
    assert distro_name("SSH-2.0-OpenSSH_8.0p1 el8") == "Red Hat"
    assert distro_name("SSH-2.0-OpenSSH_9.6p1") is None and distro_name("nginx/1.24.0") is None


def test_wep_beacons_decoded_by_scapy_are_wep():
    # Scapy numbers the capability bits differently from the wire; WEP used to read as open.
    from netseer.generate_samples import security_lab_wifi_packets
    from netseer.parsers.pcap import _encryption_from_elements
    from scapy.layers.dot11 import Dot11Beacon

    wep_beacon = security_lab_wifi_packets()[1]
    assert _encryption_from_elements({}, wep_beacon[Dot11Beacon].cap) == "WEP"
    assert _encryption_from_elements({}, security_lab_wifi_packets()[0][Dot11Beacon].cap) == "Open"


def test_security_lab_sample_has_every_kind_of_finding():
    from netseer.samples import files_for_sample

    graph = ingest_files(files_for_sample("security-lab")).to_dict()
    result = assess_graph(graph)["nodes"]
    found = {f["id"] for r in result.values() for f in r["findings"]}
    assert found >= {"wifi-open", "wifi-wep", "wifi-wps", "wifi-psk", "svc-telnet", "svc-ftp", "svc-smb", "svc-snmp", "svc-http", "tls-old"}
    software = {s["label"]: len(s["vulnerabilities"]) for r in result.values() for s in r["software"]}
    assert software["Apache HTTP Server 2.4.49"] > 0 and software["RomPager 4.07"] > 0 and software["OpenSSH 7.4"] > 0
    assert any(r["kev"] for r in result.values())
    secure_ap = next(n["id"] for n in graph["nodes"] if "Lab-Secure" in (n.get("ssids") or []))
    assert secure_ap not in result  # WPA3: nothing to report


def _handshake_pcap(tmp_path, messages, ap="00:1b:2f:99:00:01", sta="a4:c3:f0:99:00:02", psk=True):
    from netseer.generate_samples import RSN_PSK, RSN_SAE, _beacon, _eapol
    from scapy.all import PcapNgWriter

    beacon = _beacon(ap, "TestNet", 11, 2462, -50, RSN_PSK if psk else RSN_SAE)
    pkts = [beacon]
    for m in messages:
        f = _eapol(m)
        d = f.getlayer("Dot11")
        from_ap = m in (1, 3)
        d.addr1, d.addr2, d.addr3 = (sta if from_ap else ap), (ap if from_ap else sta), ap
        pkts.append(f)
    path = tmp_path / "hs.pcapng"
    with PcapNgWriter(str(path)) as w:
        for p in pkts:
            w.write(p)
    return ingest_files([(path.name, path.read_bytes())]).to_dict()


def test_handshake_message_numbers_from_eapol():
    from netseer.parsers.pcap import _eapol_message
    from netseer.generate_samples import _eapol

    assert [_eapol_message(_eapol(m).getlayer("Dot11")) for m in (1, 2, 3, 4)] == [1, 2, 3, 4]


def test_full_handshake_is_recorded_on_both_and_flagged(tmp_path):
    graph = _handshake_pcap(tmp_path, [1, 2, 3, 4])
    ap = next(n for n in graph["nodes"] if n["id"] == "mac:00:1b:2f:99:00:01")
    sta = next(n for n in graph["nodes"] if n["id"] == "mac:a4:c3:f0:99:00:02")
    assert ap["extra"]["handshakes"]["a4:c3:f0:99:00:02"]["messages"] == [1, 2, 3, 4]
    assert sta["extra"]["handshakes"]["00:1b:2f:99:00:01"]["messages"] == [1, 2, 3, 4]
    res = assess_graph(graph)["nodes"]
    sh = res["mac:a4:c3:f0:99:00:02"]["handshakes"][0]
    assert sh["complete"] is True and sh["crackable"] is True
    assert "wifi-handshake" in {f["id"] for f in res["mac:a4:c3:f0:99:00:02"]["findings"]}
    assert res["mac:a4:c3:f0:99:00:02"]["worst"] == "high"


def test_partial_handshake_crackable_rules(tmp_path):
    # Message 2 plus message 1 or 3 is enough to attempt an offline crack.
    crackable = assess_graph(_handshake_pcap(tmp_path, [1, 2]))["nodes"]["mac:a4:c3:f0:99:00:02"]["handshakes"][0]
    assert crackable["crackable"] is True and crackable["complete"] is False
    # Message 1 alone is not.
    only1 = assess_graph(_handshake_pcap(tmp_path, [1]))["nodes"]["mac:a4:c3:f0:99:00:02"]["handshakes"][0]
    assert only1["messages"] == [1] and only1["crackable"] is False


def test_wpa3_handshake_is_recorded_but_not_crackable(tmp_path):
    res = assess_graph(_handshake_pcap(tmp_path, [1, 2, 3, 4], psk=False))["nodes"]
    sh = res["mac:a4:c3:f0:99:00:02"]["handshakes"][0]
    assert sh["complete"] is True and sh["crackable"] is False
    assert "wifi-handshake" not in {f["id"] for f in res["mac:a4:c3:f0:99:00:02"]["findings"]}


def test_discoverable_finds_unknown_products_with_versions():
    from netseer.security import discoverable

    banners = [
        "GoAhead-Webs/2.5.0",          # unknown, has a version -> discoverable
        "Apache/2.4.49 (Unix)",        # known -> excluded
        "nginx",                       # no version -> excluded
        "RomPager/4.07 UPnP/1.0",      # RomPager known; UPnP is a protocol -> both excluded
        "SSH-2.0-Foobar-3.1",          # unknown SSH product with a version
    ]
    found = {d["token"]: d for d in discoverable(banners, db={"products": {}})}
    assert set(found) == {"goahead-webs", "foobar"}
    assert found["goahead-webs"]["name"] == "GoAhead-Webs" and found["goahead-webs"]["versions"] == ["2.5.0"]
    # Once an alias exists from a previous rebuild, it's no longer "discoverable".
    assert discoverable(["GoAhead-Webs/2.5.0"], db={"products": {}, "aliases": {"goahead-webs": {"cpes": ["goahead:goahead_webserver"]}}}) == []


def test_resolve_relation_rules():
    from netseer.security.fetch import _related, _norm

    assert _related("goaheadwebs", _norm("goahead_webserver"))  # shared leading run
    assert _related("lighttpd", "lighttpd")
    assert not _related("ab", "abcdef")  # too short
    assert not _related("acme", "zeus")


def test_aliases_let_a_rebuilt_product_match(tmp_path):
    db = {
        "products": {"goahead:goahead_webserver": [
            {"id": "CVE-2021-42342", "summary": "GoAhead RCE", "cvss": 9.8, "severity": "CRITICAL", "epss": 0.5, "percentile": 0.9, "kev": False, "ranges": [["", False, "5.1.5", False]], "versions": []},
        ]},
        "aliases": {"goahead-webs": {"name": "GoAhead WebServer", "cpes": ["goahead:goahead_webserver"]}},
    }
    vulndb.write(vulndb.downloaded_path(), {**db, "generated": "2999-01-01T00:00:00Z"})
    node = {"id": "mac:aa", "kind": "host", "label": "Relay", "extra": {"software": [{"raw": "GoAhead-Webs/2.5.0", "source": "HTTP Server header"}]}}
    res = assess_graph({"nodes": [node], "links": []})["nodes"]["mac:aa"]
    soft = res["software"][0]
    assert soft["name"] == "GoAhead WebServer" and [v["id"] for v in soft["vulnerabilities"]] == ["CVE-2021-42342"]
    assert res["worst"] == "critical"


def test_refresh_passes_capture_products_to_build(monkeypatch):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    captured = {}

    def fake_build(progress=None, should_stop=None, extra_products=None):
        captured["extra"] = extra_products
        return small_db(generated="2999-01-01T00:00:00Z")

    monkeypatch.setattr(webmod.vuln_fetch, "build", fake_build)
    client = TestClient(webmod.app)
    assert client.post("/api/security/discoverable", json={"banners": ["GoAhead-Webs/2.5.0", "nginx"]}).json()["products"][0]["token"] == "goahead-webs"
    client.post("/api/security/refresh", json={"banners": ["GoAhead-Webs/2.5.0", "Apache/2.4.49"]})
    import time

    for _ in range(50):
        if client.get("/api/security/database").json()["refresh"]["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert captured["extra"] == [{"token": "goahead-webs", "name": "GoAhead-Webs"}]
    webmod.VULN_JOB.update(state="idle")
