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

