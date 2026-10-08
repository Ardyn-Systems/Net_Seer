from __future__ import annotations

from netseer.detect import sniff_format
from netseer.exporters.drawio import export_drawio
from netseer.exporters.reports import (
    device_csv,
    device_pdf,
    device_plain_text,
    device_properties,
    device_xml,
    map_report_pdf,
)
from netseer.exporters.visio import export_vdx, export_vsdx
from netseer.generate_samples import write_all
from netseer.ingest import ingest_files
from netseer.samples import DATA_DIR, files_for_sample


def test_samples_exist_after_generate(tmp_path):
    dest = write_all(tmp_path)
    assert (dest / "office-lan.pcap").stat().st_size > 0
    assert (dest / "wifi-campus.pcapng").stat().st_size > 0


def test_office_lan_has_ports_and_services():
    if not (DATA_DIR / "office-lan.pcap").exists():
        write_all(DATA_DIR)
    graph = ingest_files(files_for_sample("office-lan"))
    services = {s for n in graph.nodes for s in n.services}
    assert "http" in services
    assert "dns" in services
    assert "ssh" in services
    assert "dhcp" in services
    listen = [p for n in graph.nodes for p in n.ports if p.get("role") == "listen"]
    ports = {p.get("port") for p in listen}
    assert 80 in ports
    assert 53 in ports
    assert 22 in ports
    cs = [e for e in graph.links if e.kind == "client-server"]
    assert cs
    labels = " ".join(e.label for e in cs)
    assert "http" in labels
    xml = export_drawio(graph)
    assert "http" in xml.lower()
    assert 'host="NetSeer"' in xml
    vdx = export_vdx(graph)
    assert "http" in vdx.lower() or "tcp/80" in vdx.lower()
    assert "<Creator>NetSeer</Creator>" in vdx
    vsdx = export_vsdx(graph)
    assert vsdx[:2] == b"PK"
    web = next(n for n in graph.nodes if "10.10.20.80" in n.ips)
    assert web.label == "Server"
    assert web.inferred_type == "Server"
    props = device_properties(graph, web)
    names = {row["name"] for row in props}
    assert "TX MAC" in names
    assert "RX MAC" in names
    assert "DA MAC" in names
    assert "RA MAC" in names
    assert "MAC addresses" not in names
    assert "IP addresses" in names
    assert web.mac_tx
    assert "00:25:90:20:00:50" in web.mac_tx
    assert web.mac_ra == []
    text = device_plain_text(graph, web)
    assert "TX MAC:" in text
    assert "RA MAC: not present" in text
    assert "Services" in names
    assert "Ports" in names
    assert "OUI manufacturer" in names
    assert web.vendor
    assert "Unknown" not in web.vendor
    assert "Super Micro" in web.vendor or "Supermicro" in web.vendor
    text = device_plain_text(graph, web)
    assert "http tcp/80" in text
    assert web.vendor in text
    assert "NetSeer device:" in text
    csv_body = device_csv(graph, web)
    assert "Field,Value" in csv_body
    xml = device_xml(graph, web)
    assert "<device" in xml and "http" in xml
    pdf = device_pdf(graph, web)
    assert pdf.startswith(b"%PDF")
    assert b"NetSeer" in pdf
    report = map_report_pdf(graph, title="Office")
    assert report.startswith(b"%PDF")
    assert len(report) > 500
    assert b"NetSeer" in report
    assert b"/Image" in report or b"/XObject" in report


def test_kismet_and_airodump():
    if not (DATA_DIR / "kismet-walk.netxml").exists():
        write_all(DATA_DIR)
    kismet = ingest_files(files_for_sample("kismet-walk"))
    ssids = {s for n in kismet.nodes for s in n.ssids}
    assert "HQ-Secure" in ssids
    gps_nodes = [n for n in kismet.nodes if n.gps]
    assert gps_nodes
    dump = ingest_files(files_for_sample("airodump"))
    assert any(n.kind == "ap" for n in dump.nodes)
    assert any(e.kind == "wireless" for e in dump.links)


def test_mac_roles_from_wired_and_dot11():
    if not (DATA_DIR / "office-lan.pcap").exists():
        write_all(DATA_DIR)
    wired = ingest_files(files_for_sample("office-lan"))
    gw = next(n for n in wired.nodes if "10.10.10.1" in n.ips)
    assert gw.mac_da
    assert gw.mac_rx
    assert gw.mac_ra == []
    wifi = ingest_files(files_for_sample("wifi-campus"))
    assert any(n.mac_ra for n in wifi.nodes)
    assert any(n.mac_tx for n in wifi.nodes)
    xml = export_drawio(wifi)
    assert "Access point" in xml
    phone = next(n for n in wifi.nodes if n.macs and n.macs[0].startswith("a4:c3:f0"))
    assert phone.label == "Wireless client"
    text = device_plain_text(wifi, phone)
    assert "TX MAC:" in text
    assert "RA MAC:" in text


def test_inferred_names_and_export_notes():
    from netseer.graph import infer_display_name

    assert infer_display_name({"kind": "ap", "roles": ["ap"]}) == "Access point"
    assert infer_display_name({"kind": "host", "roles": ["station"], "medium": "wireless"}) == "Wireless client"
    assert infer_display_name({"kind": "gateway", "roles": ["gateway"], "routing": {"ospf_router_id": "10.10.10.1"}, "services": ["ospf"]}) == "Router"
    assert infer_display_name({"kind": "host", "ports": [{"role": "listen", "port": 80}]}) == "Server"
    assert infer_display_name({"kind": "host"}) == "Host"
    if not (DATA_DIR / "office-lan.pcap").exists():
        write_all(DATA_DIR)
    graph = ingest_files(files_for_sample("office-lan"))
    gw = next(n for n in graph.nodes if "10.10.10.1" in n.ips)
    assert gw.label == "Router"
    web = next(n for n in graph.nodes if "10.10.20.80" in n.ips)
    web.notes = "Rack A1"
    web.caption = "Intranet"
    web.label = "Lobby server"
    text = device_plain_text(graph, web)
    assert "Notes: Rack A1" in text
    assert "On-map extra: Intranet" in text
    assert "Lobby server" in text
    xml = export_drawio(graph)
    assert "Lobby server" in xml
    assert "Intranet" in xml


def test_bridge_attachments_from_evidence_only():
    from netseer.graph import GraphBuilder

    lonely = GraphBuilder()
    host = lonely.observe_mac("00:11:22:33:44:55")
    lonely.observe_vlan(10, host)
    lonely.observe_ip("10.10.10.8", "00:11:22:33:44:55")
    graph = lonely.finalize()
    assert not any(link.kind == "bridge" for link in graph.links)

    spanned = GraphBuilder()
    gw = spanned.observe_mac("00:1a:2f:aa:00:01")
    spanned.observe_vlan(10, gw)
    spanned.observe_vlan(20, gw)
    spanned.observe_stp(gw, root="00:1a:2f:aa:00:01")
    graph = spanned.finalize()
    bridges = [link for link in graph.links if link.kind == "bridge"]
    assert len(bridges) == 1
    assert {bridges[0].source, bridges[0].target} == {"vlan:10", "vlan:20"}
    assert bridges[0].label == "STP bridge"
    assert "stp" in (bridges[0].extra or {}).get("bridge_kind", "")

    if not (DATA_DIR / "office-lan.pcap").exists():
        write_all(DATA_DIR)
    office = ingest_files(files_for_sample("office-lan"))
    office_bridges = [link for link in office.links if link.kind == "bridge"]
    assert office_bridges
    vlan_bridge = next(link for link in office_bridges if {link.source, link.target} == {"vlan:10", "vlan:20"})
    assert vlan_bridge.extra.get("vias") == ["mac:00:1a:2f:aa:00:01"]
    assert vlan_bridge.label == "STP bridge"
    xml = export_drawio(office)
    assert "STP bridge" in xml
    vdx = export_vdx(office)
    assert "bridge" in vdx.lower() or "Attachment" in vdx or "STP" in vdx
    gw_node = next(n for n in office.nodes if "10.10.10.1" in n.ips)
    gw_node.vendor = "Edited OUI Co"
    text = device_plain_text(office, gw_node)
    assert "Edited OUI Co" in text

    if not (DATA_DIR / "wifi-campus.pcapng").exists():
        write_all(DATA_DIR)
    wifi = ingest_files(files_for_sample("wifi-campus"))
    wds = [link for link in wifi.links if link.kind == "bridge"]
    assert wds
    assert any(link.label == "WDS" or (link.extra or {}).get("bridge_kind") == "wds" for link in wds)
    wifi_xml = export_drawio(wifi)
    assert "WDS" in wifi_xml
    from netseer.serialize import graph_from_dict

    roundtrip = graph_from_dict(office.to_dict())
    assert any(link.kind == "bridge" for link in roundtrip.links)


def test_unsupported_and_empty(tmp_path):
    assert sniff_format(b"\xd4\xc3\xb2\xa1", "x.pcap") == "pcap"
    try:
        ingest_files([("note.txt", b"hello world")])
        assert False, "expected unsupported"
    except Exception as exc:
        assert "Unsupported" in str(exc) or "unsupported" in str(exc).lower()
    try:
        ingest_files(files_for_sample("empty-capture"))
        assert False, "expected empty survey"
    except Exception as exc:
        assert "No hosts" in str(exc)


def test_ieee_oui_lookup_and_special_macs():
    from netseer.oui import (
        LOCALLY_ADMINISTERED,
        UNKNOWN,
        lookup_oui,
        vendor_from_mac,
    )

    cisco = lookup_oui("00:1a:2f:aa:00:01")
    assert "Cisco" in cisco["manufacturer"]
    assert cisco["oui_assignment"].startswith("MA-")
    apple = vendor_from_mac("3c:22:fb:10:00:01")
    assert "Apple" in apple
    local = vendor_from_mac("02:11:22:33:44:55")
    assert local == LOCALLY_ADMINISTERED
    unknown = lookup_oui("04:00:00:00:00:01")
    # Either unregistered or a real assignment; never locally administered.
    assert unknown["manufacturer"] != LOCALLY_ADMINISTERED
    if unknown["oui_assignment"] == "unregistered":
        assert unknown["manufacturer"] == UNKNOWN


def test_netseer_json_dump_reload_and_unwanted_filenames(tmp_path, monkeypatch):
    import json

    from netseer.detect import sniff_format
    from netseer.ingest import ingest_files
    from netseer.web import _safe_unwanted_stem, dump_unwanted
    import netseer.web as webmod

    monkeypatch.setattr(webmod, "UNWANTED_DIR", tmp_path)
    payload = {
        "netseer": "unwanted-v1",
        "original_capture": "office-lan.pcap",
        "nodes": [
            {
                "id": "mac:00:11:22:33:44:55",
                "label": "Access point",
                "kind": "ap",
                "medium": "wireless",
                "inferred_type": "Access point",
            }
        ],
        "links": [],
        "device_meta": {"mac:00:11:22:33:44:55": {"notes": "lobby"}},
    }
    raw = json.dumps(payload).encode()
    assert sniff_format(raw, "Unwanted-office-lan.json") == "netseer-json"
    graph = ingest_files([("Unwanted-office-lan.json", raw)])
    assert graph.nodes[0].kind == "ap"
    assert graph.meta["device_meta"]["mac:00:11:22:33:44:55"]["notes"] == "lobby"
    assert _safe_unwanted_stem("office-lan.pcap") == "office-lan"
    assert _safe_unwanted_stem("") == "unknown"
    result = dump_unwanted(
        {
            "groups": [
                {
                    "capture": "office-lan.pcap",
                    "nodes": payload["nodes"],
                    "links": [],
                    "device_meta": payload["device_meta"],
                }
            ]
        }
    )
    assert result["files"][0] == "Unwanted-office-lan.json"
    assert (tmp_path / "Unwanted-office-lan.json").is_file()


def test_port_records_stay_bounded_and_ephemeral_ports_are_not_listeners():
    from netseer.graph import GraphBuilder

    builder = GraphBuilder()
    for i in range(500):
        builder.add_l3("10.0.0.1", "10.0.0.2", proto="tcp", sport=40000 + i, dport=443)
    link = builder.links["l3:ip:10.0.0.1:ip:10.0.0.2"]
    assert len(link["ports"]) == 1
    assert link["ports"][0]["port"] == 443

    p2p = GraphBuilder()
    p2p.add_l3("10.0.0.5", "10.0.0.6", proto="udp", sport=40001, dport=40002)
    assert p2p.devices["ip:10.0.0.6"]["ports"] == []
    assert {n.inferred_type for n in p2p.finalize().nodes if n.kind != "subnet"} == {"Host"}


def test_from_ds_frames_do_not_bind_remote_ips_to_the_station():
    from scapy.layers.dot11 import Dot11
    from scapy.layers.inet import IP, TCP
    from scapy.layers.l2 import LLC, SNAP

    from netseer.graph import GraphBuilder
    from netseer.parsers.pcap import _handle_packet

    ap, sta = "00:11:22:33:44:55", "00:aa:bb:cc:dd:ee"
    builder = GraphBuilder()
    down = Dot11(type=2, FCfield=0x2, addr1=sta, addr2=ap, addr3="00:99:99:99:99:99") / LLC() / SNAP() / IP(
        src="93.184.216.34", dst="192.168.1.20"
    ) / TCP(sport=443, dport=50000)
    _handle_packet(builder, down)
    assert "93.184.216.34" not in builder.devices[f"mac:{sta}"]["ips"]
    up = Dot11(type=2, FCfield=0x1, addr1=ap, addr2=sta, addr3="00:99:99:99:99:99") / LLC() / SNAP() / IP(
        src="192.168.1.20", dst="93.184.216.34"
    ) / TCP(sport=50000, dport=443)
    _handle_packet(builder, up)
    assert builder.devices[f"mac:{sta}"]["ips"] == ["192.168.1.20"]


def test_association_response_does_not_mark_ap_as_station():
    from scapy.layers.dot11 import Dot11, Dot11AssoResp

    from netseer.graph import GraphBuilder
    from netseer.parsers.pcap import _handle_packet

    ap, sta = "00:11:22:33:44:55", "00:aa:bb:cc:dd:ee"
    builder = GraphBuilder()
    _handle_packet(builder, Dot11(type=0, subtype=1, addr1=sta, addr2=ap, addr3=ap) / Dot11AssoResp())
    assert "station" not in builder.devices[f"mac:{ap}"]["roles"]
    assert "station" in builder.devices[f"mac:{sta}"]["roles"]
    assert any(link["kind"] == "wireless" for link in builder.links.values())


def test_ip_mac_merge_rekeys_links_and_members():
    from netseer.graph import GraphBuilder

    builder = GraphBuilder()
    builder.add_l3("10.0.0.1", "10.0.0.2", proto="icmp")
    builder.bind_ip_mac("10.0.0.1", "00:11:22:33:44:01")
    builder.add_l3("10.0.0.1", "10.0.0.2", proto="icmp")
    l3 = [link for link in builder.links.values() if link["kind"] == "l3"]
    assert len(l3) == 1
    assert l3[0]["extra"]["count"] == 2
    assert "ip:10.0.0.1" not in {l3[0]["source"], l3[0]["target"]}
    graph = builder.finalize()
    node_ids = {n.id for n in graph.nodes}
    subnet = next(n for n in graph.nodes if n.kind == "subnet")
    assert set(subnet.extra["members"]) <= node_ids

    # A second MAC claiming the IP is a different device, not a merge.
    builder = GraphBuilder()
    builder.bind_ip_mac("10.0.0.9", "00:11:22:33:44:01")
    builder.bind_ip_mac("10.0.0.9", "00:11:22:33:44:02")
    assert "mac:00:11:22:33:44:01" in builder.devices
    assert "mac:00:11:22:33:44:02" in builder.devices


def test_subnet_broadcast_is_not_a_host():
    from netseer.graph import GraphBuilder

    builder = GraphBuilder()
    builder.add_l3("10.0.0.7", "10.0.0.255", proto="udp", sport=137, dport=137)
    assert "ip:10.0.0.255" not in builder.devices
    builder.netmasks["10.1.0.7"] = 16
    assert builder.observe_ip("10.1.3.255") == "ip:10.1.3.255"
    assert builder.observe_ip("10.1.255.255") is None


def test_exports_escape_quotes_and_control_characters():
    import xml.dom.minidom as minidom
    import zipfile
    from io import BytesIO

    from netseer.serialize import graph_from_dict

    graph = graph_from_dict(
        {
            "nodes": [
                {"id": "mac:00:11:22:33:44:55", "kind": "ap", "label": 'Bob"s <AP>', "caption": 'x\x01"y"'},
                {"id": "mac:00:11:22:33:44:66", "kind": "host", "label": "Host"},
            ],
            "links": [
                {
                    "id": "l:1",
                    "source": "mac:00:11:22:33:44:55",
                    "target": "mac:00:11:22:33:44:66",
                    "kind": "l2",
                    "label": 'a"b',
                }
            ],
        }
    )
    minidom.parseString(export_drawio(graph, title='My "map"'))
    vdx = export_vdx(graph, title='My "map"')
    minidom.parseString(vdx)
    assert "\\n" not in vdx
    minidom.parseString(device_xml(graph, graph.nodes[0]))
    with zipfile.ZipFile(BytesIO(export_vsdx(graph))) as zf:
        minidom.parseString(zf.read("visio/pages/page1.xml"))
        types = zf.read("[Content_Types].xml").decode()
    assert "extended-properties+xml" in types


def test_malformed_graphs_are_rejected_cleanly():
    import pytest
    from fastapi.testclient import TestClient

    from netseer.detect import UnsupportedSurveyError
    from netseer.serialize import graph_from_dict
    from netseer.web import app

    with pytest.raises(UnsupportedSurveyError):
        graph_from_dict({"nodes": [{"id": "a"}], "links": []})
    with pytest.raises(UnsupportedSurveyError):
        graph_from_dict({"nodes": ["nope"], "links": []})
    coerced = graph_from_dict(
        {"nodes": [{"id": "a", "kind": "host", "label": "A", "signal_dbm": "<img src=x>", "ips": "1.2.3.4"}], "links": []}
    )
    assert coerced.nodes[0].signal_dbm is None
    assert coerced.nodes[0].ips == []

    client = TestClient(app)
    res = client.post("/api/export/drawio", json={"nodes": [{"id": "a"}], "links": []})
    assert res.status_code == 400
    res = client.post("/api/parse", files={"file": ("bad.json", b'{"nodes":[{"id":"a"}],"links":[]}')})
    assert res.status_code == 400
    # Installed copies have no size limit, so a big Content-Length isn't refused up front.
    res = client.post(
        "/api/parse",
        content=b"x",
        headers={"content-length": str(60 * 1024 * 1024), "content-type": "application/octet-stream"},
    )
    assert res.status_code != 413


def test_rsn_akm_parsing_labels():
    from netseer.parsers.pcap import _encryption_from_elements

    def rsn(*akms: int) -> bytes:
        body = b"\x01\x00" + b"\x00\x0f\xac\x04" + b"\x01\x00\x00\x0f\xac\x04"
        body += len(akms).to_bytes(2, "little") + b"".join(b"\x00\x0f\xac" + bytes([a]) for a in akms)
        return body + b"\x00\x00"

    assert _encryption_from_elements({48: [rsn(2)]}, 0x11) == "WPA2-PSK"
    assert _encryption_from_elements({48: [rsn(8)]}, 0x11) == "WPA3-SAE"
    assert _encryption_from_elements({48: [rsn(2, 8)]}, 0x11) == "WPA3-SAE"
    assert _encryption_from_elements({48: [rsn(1)]}, 0x11) == "WPA2-802.1X"
    assert _encryption_from_elements({48: [rsn(5)]}, 0x11) == "WPA2-802.1X"
    assert _encryption_from_elements({48: [rsn(12)]}, 0x11) == "WPA3-802.1X-192"
    assert _encryption_from_elements({48: [rsn(18)]}, 0x11) == "OWE"
    assert _encryption_from_elements({}, 0x11) == "WEP"
    assert _encryption_from_elements({}, 0x01) == "Open"


def test_per_capture_packet_cap_and_small_parser_fixes(monkeypatch, tmp_path):
    from scapy.all import wrpcap
    from scapy.layers.inet import IP, UDP
    from scapy.layers.l2 import Ether

    import netseer.parsers.pcap as pcapmod
    from netseer.graph import GraphBuilder
    from netseer.parsers.airodump import parse_airodump_csv

    monkeypatch.setenv("NETSEER_MAX_PACKETS", "3")
    pkt = Ether(src="00:11:22:33:44:01", dst="00:11:22:33:44:02") / IP(src="10.0.0.1", dst="10.0.0.2") / UDP()
    path = tmp_path / "a.pcap"
    wrpcap(str(path), [pkt] * 5)
    data = path.read_bytes()
    builder = GraphBuilder()
    pcapmod.parse_pcap(builder, data, "a.pcap")
    pcapmod.parse_pcap(builder, data, "b.pcap")
    assert builder.packet_count == 6
    assert len(builder.warnings) == 2

    assert pcapmod._channel_from_elements({}, 2484.0) == 14
    assert pcapmod._channel_from_elements({}, 2437.0) == 6

    csv_text = (
        "\r\nBSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, "
        "Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key\r\n"
        "00:15:6D:C0:00:09, 2026-09-20 16:02:11, 2026-09-20 16:18:02, 6, 54, WPA2, CCMP, PSK, "
        "-1, 4, 0, 192.168.  1. 10, 3, lab, \r\n"
    )
    ap_builder = GraphBuilder()
    parse_airodump_csv(ap_builder, csv_text.encode(), "dump.csv")
    rec = ap_builder.devices["mac:00:15:6d:c0:00:09"]
    assert "192.168.1.10" in rec["ips"]
    assert rec["signal_dbm"] is None



def _containment_graph():
    from netseer.serialize import graph_from_dict

    return graph_from_dict(
        {
            "nodes": [
                {"id": "subnet:10.0.0.0/24", "kind": "subnet", "label": "10.0.0.0/24"},
                {"id": "ip:10.0.0.1", "kind": "gateway", "label": "Router"},
                {"id": "ip:10.0.0.2", "kind": "host", "label": "Host"},
                {"id": "vlan:10", "kind": "vlan", "label": "VLAN 10"},
            ],
            "links": [
                {"id": "s1", "source": "ip:10.0.0.1", "target": "subnet:10.0.0.0/24", "kind": "subnet"},
                {"id": "s2", "source": "ip:10.0.0.2", "target": "subnet:10.0.0.0/24", "kind": "subnet"},
                {"id": "l1", "source": "ip:10.0.0.1", "target": "ip:10.0.0.2", "kind": "l3", "label": "ICMP"},
                {"id": "v1", "source": "ip:10.0.0.1", "target": "vlan:10", "kind": "vlan"},
            ],
        }
    )


def test_exports_follow_map_positions_and_draw_subnet_containers():
    import xml.dom.minidom as minidom
    import zipfile
    from io import BytesIO

    graph = _containment_graph()
    positions = {"ip:10.0.0.1": [-500, -200], "ip:10.0.0.2": [-300, -200], "vlan:10": [-400, 100], "subnet:10.0.0.0/24": [-400, -200]}
    parents = {"ip:10.0.0.1": "subnet:10.0.0.0/24", "ip:10.0.0.2": "subnet:10.0.0.0/24", "bogus": "subnet:10.0.0.0/24"}

    xml = export_drawio(graph, positions=positions, parents=parents)
    doc = minidom.parseString(xml)
    cells = {c.getAttribute("id"): c for c in doc.getElementsByTagName("mxCell")}
    assert "container=1" in cells["subnet:10.0.0.0/24"].getAttribute("style")
    assert cells["ip:10.0.0.1"].getAttribute("parent") == "subnet:10.0.0.0/24"
    assert cells["vlan:10"].getAttribute("parent") == "1"
    assert "s1" not in cells and "s2" not in cells  # membership is the box itself
    assert "l1" in cells and "v1" in cells
    # Children keep the map's relative spacing (200 px apart) inside the container.
    g1 = cells["ip:10.0.0.1"].getElementsByTagName("mxGeometry")[0]
    g2 = cells["ip:10.0.0.2"].getElementsByTagName("mxGeometry")[0]
    assert float(g2.getAttribute("x")) - float(g1.getAttribute("x")) == 200
    # Everything is shifted onto the page.
    box = cells["subnet:10.0.0.0/24"].getElementsByTagName("mxGeometry")[0]
    assert float(box.getAttribute("x")) >= 0 and float(box.getAttribute("y")) >= 0

    vdx = export_vdx(graph, positions=positions, parents=parents)
    minidom.parseString(vdx)
    assert vdx.index("10.0.0.0/24") < vdx.index(">Router<")  # container drawn first, behind members
    with zipfile.ZipFile(BytesIO(export_vsdx(graph, positions=positions, parents=parents))) as zf:
        page = zf.read("visio/pages/page1.xml").decode()
    minidom.parseString(page)
    assert 'NameU="Container"' in page


def test_fallback_layout_wraps_instead_of_one_long_row():
    from netseer.exporters.layout import CELL_W, MARGIN, MAX_PER_ROW, layout_positions
    from netseer.serialize import graph_from_dict

    graph = graph_from_dict({"nodes": [{"id": f"ip:10.0.0.{i}", "kind": "host", "label": "Host"} for i in range(40)], "links": []})
    placed = layout_positions(graph)
    xs = [x for x, _ in placed.values()]
    assert max(xs) <= MARGIN + CELL_W * MAX_PER_ROW
    assert len({(round(x), round(y)) for x, y in placed.values()}) == 40  # no overlaps


def test_export_api_accepts_layout_hints():
    from fastapi.testclient import TestClient

    from netseer.web import app

    body = _containment_graph().to_dict()
    body.update(
        positions={"ip:10.0.0.1": [0, 0], "ip:10.0.0.2": [200, 0], "vlan:10": "nonsense"},
        parents={"ip:10.0.0.1": "subnet:10.0.0.0/24", "ip:10.0.0.2": "subnet:10.0.0.0/24"},
    )
    client = TestClient(app)
    for kind in ("drawio", "vdx", "vsdx"):
        assert client.post(f"/api/export/{kind}", json=body).status_code == 200
    body["positions"] = ["not", "a", "dict"]
    assert client.post("/api/export/drawio", json=body).status_code == 200


def test_version_matches_pyproject():
    import tomllib
    from pathlib import Path

    from netseer import __version__

    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == __version__


def _pdf_pages(blob: bytes) -> int:
    import re

    return len(re.findall(rb"/Type /Page[^s]", blob))


def test_report_headers_use_white_text():
    from reportlab.lib import colors

    from netseer.exporters.reports import _styles

    # Table header cells are Paragraphs; TableStyle TEXTCOLOR doesn't reach them.
    assert _styles()["th"].textColor == colors.white


def test_report_options_parse_leniently():
    from netseer.exporters.reports import DEFAULT_FIELD_GROUPS, REPORT_SECTIONS, ReportOptions

    assert ReportOptions.from_dict(None).sections == REPORT_SECTIONS
    opts = ReportOptions.from_dict(
        {"sections": ["links", "bogus", "summary"], "categories": ["server"], "field_groups": "nope", "node_ids": ["a"], "include_empty": 1}
    )
    assert opts.sections == ("summary", "links")  # canonical order, unknowns dropped
    assert opts.categories == ("server",)
    assert opts.field_groups == DEFAULT_FIELD_GROUPS
    assert opts.node_ids == ("a",) and opts.include_empty is True


def test_report_options_shape_the_pdf():
    from netseer.exporters.reports import ReportOptions, device_category, report_scope

    if not (DATA_DIR / "office-lan.pcap").exists():
        write_all(DATA_DIR)
    graph = ingest_files(files_for_sample("campus-all"))
    full = map_report_pdf(graph, title="Full")
    overview = map_report_pdf(graph, title="Overview", options=ReportOptions.from_dict({"sections": ["summary", "inventory"]}))
    assert _pdf_pages(overview) < _pdf_pages(full)
    servers = ReportOptions.from_dict({"categories": ["server"], "sections": ["devices"]})
    nodes, links = report_scope(graph, servers)
    assert nodes and all(device_category(n) == "server" for n in nodes)
    assert all(l.source in {n.id for n in nodes} or l.target in {n.id for n in nodes} for l in links)
    one = graph.nodes[0].id
    nodes, _ = report_scope(graph, ReportOptions.from_dict({"node_ids": [one]}))
    assert [n.id for n in nodes] == [one]
    empty = map_report_pdf(graph, title="Empty", options=ReportOptions.from_dict({"categories": []}))
    assert empty.startswith(b"%PDF")


def test_report_api_accepts_options():
    from fastapi.testclient import TestClient

    from netseer.web import app

    graph = ingest_files(files_for_sample("office-lan")).to_dict()
    client = TestClient(app)
    small = client.post("/api/export/report.pdf", json={**graph, "report": {"sections": ["summary"]}})
    big = client.post("/api/export/report.pdf", json=graph)
    assert small.status_code == big.status_code == 200
    assert _pdf_pages(small.content) < _pdf_pages(big.content)


def test_wired_hosts_behind_an_access_point_stay_wired():
    from scapy.layers.dot11 import Dot11
    from scapy.layers.inet import IP, TCP
    from scapy.layers.l2 import LLC, SNAP

    from netseer.graph import GraphBuilder
    from netseer.parsers.pcap import _handle_packet

    ap, sta, server = "00:11:22:33:44:55", "00:aa:bb:cc:dd:ee", "00:25:90:20:00:50"
    builder = GraphBuilder()
    frame = Dot11(type=2, FCfield=0x1, addr1=ap, addr2=sta, addr3=server) / LLC() / SNAP() / IP(src="10.0.0.5", dst="10.0.0.80") / TCP(sport=50000, dport=80)
    _handle_packet(builder, frame)
    assert builder.devices[f"mac:{sta}"]["medium"] == "wireless"
    assert builder.devices[f"mac:{server}"]["medium"] == "wired"


def test_heartbeat_tracks_open_and_closed_pages():
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    webmod.PRESENCE.update(last=None, bye=None)
    client = TestClient(webmod.app)
    assert client.post("/api/heartbeat").status_code == 204
    assert webmod.PRESENCE["last"] is not None and webmod.PRESENCE["bye"] is None
    assert client.post("/api/heartbeat?bye=true").status_code == 204
    assert webmod.PRESENCE["bye"] >= webmod.PRESENCE["last"]


def test_logo_assets_are_self_contained():
    from pathlib import Path

    web = Path(__file__).resolve().parents[1] / "src" / "netseer" / "web"
    for name in ("logo.svg", "logo-small.svg"):
        svg = (web / name).read_text(encoding="utf-8")
        assert "<svg" in svg
        # Some renderers (MuPDF, older librsvg) ignore clipPath; the art must not depend on it.
        assert "clipPath" not in svg and "clip-path" not in svg
    for name in ("logo.png", "logo-192.png", "favicon.png", "favicon.ico"):
        assert (web / name).stat().st_size > 1000
    html = (web / "index.html").read_text(encoding="utf-8")
    assert "/static/logo.svg" in html


def test_hosted_mode_blocks_server_writes_and_reports_limits(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    monkeypatch.setattr(webmod, "UNWANTED_DIR", tmp_path)
    client = TestClient(webmod.app)
    group = {"groups": [{"capture": "a.pcap", "nodes": [{"id": "n1", "kind": "host", "label": "Host"}]}]}

    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    monkeypatch.delenv("NETSEER_MAX_UPLOAD_MB", raising=False)
    info = client.get("/api/health").json()
    assert info["hosted"] is False and info["max_upload_mb"] is None  # installed: no limit
    assert client.post("/api/unwanted/dump", json=group).status_code == 200

    monkeypatch.setenv("NETSEER_HOSTED", "1")
    monkeypatch.setenv("NETSEER_MAX_UPLOAD_MB", "20")
    info = client.get("/api/health").json()
    assert info["hosted"] is True and info["max_upload_mb"] == 20
    assert client.post("/api/unwanted/dump", json=group).status_code == 403
    assert len(list(tmp_path.glob("*.json"))) == 1  # only the non-hosted write
    big = client.post(
        "/api/parse",
        content=b"x",
        headers={"content-length": str(25 * 1024 * 1024), "content-type": "application/octet-stream"},
    )
    assert big.status_code == 413 and "20 MB" in big.json()["detail"]


def test_upload_limit_and_port_come_from_the_environment(monkeypatch):
    import pytest

    from netseer.cli import default_port
    from netseer.detect import UnsupportedSurveyError
    from netseer.ingest import ingest_files

    monkeypatch.setenv("NETSEER_MAX_UPLOAD_MB", "1")
    with pytest.raises(UnsupportedSurveyError, match="1 MB"):
        ingest_files([("big.pcap", b"\xd4\xc3\xb2\xa1" + b"\0" * (1024 * 1024 + 10))])
    monkeypatch.setenv("PORT", "10000")
    assert default_port() == 10000
    monkeypatch.setenv("PORT", "nope")
    assert default_port() == 47331
    monkeypatch.delenv("PORT")
    assert default_port() == 47331


def test_health_reports_how_netseer_runs(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    client = TestClient(webmod.app)
    for name in ("NETSEER_HOSTED", "NETSEER_MODE", "NETSEER_PACKAGE", "APPIMAGE"):
        monkeypatch.delenv(name, raising=False)
    info = client.get("/api/health").json()
    assert info["mode"] == "server" and info["package"] == "source" and info["frozen"] is False
    assert info["repo"] == "ardyn-systems/NetSeer" and info["platform"] in {"windows", "linux", "macos"}
    assert info["updater"] is False

    # The Electron shell sets these; the API just reports them back.
    monkeypatch.setenv("NETSEER_MODE", "desktop")
    monkeypatch.setenv("NETSEER_PACKAGE", "installer")
    info = client.get("/api/health").json()
    assert info["mode"] == "desktop" and info["package"] == "installer"
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert client.get("/api/health").json()["mode"] == "hosted"


def test_links_added_by_a_person_are_marked_in_exports():
    import re as _re

    from netseer.exporters.reports import ReportOptions
    from netseer.serialize import graph_from_dict

    graph = graph_from_dict({
        "nodes": [
            {"id": "mac:aa", "kind": "host", "label": "Printer"},
            {"id": "mac:bb", "kind": "gateway", "label": "Core switch"},
            {"id": "subnet:10.20.0.0/24", "kind": "subnet", "label": "10.20.0.0/24", "extra": {"manual": {"note": ""}}},
        ],
        "links": [
            {"id": "manual:l2:mac:aa|mac:bb", "source": "mac:aa", "target": "mac:bb", "kind": "l2", "label": "Port 14",
             "extra": {"manual": {"note": "IT closet label", "added": "2026-10-05T10:00:00Z"}}},
            {"id": "manual:subnet:mac:aa|subnet:10.20.0.0/24", "source": "mac:aa", "target": "subnet:10.20.0.0/24", "kind": "subnet",
             "extra": {"manual": {"note": "DHCP list"}}},
        ],
    })
    assert graph.links[0].extra["manual"]["note"] == "IT closet label"  # survives the round trip

    drawio = export_drawio(graph)
    edge = _re.search(r'<mxCell id="manual:l2:mac:aa\|mac:bb" value="([^"]*)" style="([^"]*)"', drawio)
    assert edge and edge.group(1) == "\u270e Port 14" and "dashPattern=10 3 2 3" in edge.group(2)

    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(export_vsdx(graph))) as zf:
        page = zf.read("visio/pages/page1.xml").decode("utf-8")
    assert "\u270e Port 14" in page and 'N="LinePattern" V="4"' in page

    pdf = map_report_pdf(graph, options=ReportOptions.from_dict({"preset": "standard"}))
    assert pdf[:4] == b"%PDF"


def test_page_and_files_are_never_reused_unchecked():
    # After an update the app window must load the new page, not one it cached before.
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    client = TestClient(webmod.app)
    for path in ("/", "/?v=9.9.9", "/static/app.js", "/static/styles.css?v=x", "/static/topo.svg", "/favicon.ico"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.headers["cache-control"] == "no-cache", path
    # Checking a file that didn't change is a cheap "not modified".
    etag = client.get("/static/app.js").headers["etag"]
    assert client.get("/static/app.js", headers={"If-None-Match": etag}).status_code == 304
    assert "cache-control" not in client.get("/api/samples").headers
