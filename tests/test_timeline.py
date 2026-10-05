from __future__ import annotations

from netseer.graph import merge_seen


def test_merge_seen_joins_close_sightings():
    assert merge_seen([[100, 100], [130, 140], [300, 310], [150, 160]]) == [[100.0, 160.0], [300.0, 310.0]]
    assert merge_seen([]) == []


def test_pcap_records_when_devices_and_links_were_active(tmp_path):
    from scapy.all import wrpcap
    from scapy.layers.inet import IP, UDP
    from scapy.layers.l2 import Ether

    from netseer.ingest import ingest_sources

    a, b, c = "00:11:22:33:44:01", "00:11:22:33:44:02", "00:11:22:33:44:03"
    frames = []
    for t, (src, dst) in [(1_791_000_000, (a, b)), (1_791_000_030, (a, b)), (1_791_000_500, (a, c)), (1_791_000_510, (a, b))]:
        pkt = Ether(src=src, dst=dst) / IP(src="10.0.0.1", dst="10.0.0.2") / UDP()
        pkt.time = t
        frames.append(pkt)
    path = tmp_path / "t.pcap"
    wrpcap(str(path), frames)
    graph = ingest_sources([(path.name, path)])
    by_mac = {m: n for n in graph.nodes for m in n.macs}
    assert by_mac[a].seen == [[1_791_000_000.0, 1_791_000_030.0], [1_791_000_500.0, 1_791_000_510.0]]
    assert by_mac[c].seen == [[1_791_000_500.0, 1_791_000_500.0]]
    l2 = next(l for l in graph.links if l.kind == "l2" and {l.source, l.target} == {by_mac[a].id, by_mac[b].id})
    assert l2.seen == [[1_791_000_000.0, 1_791_000_030.0], [1_791_000_510.0, 1_791_000_510.0]]
    assert graph.meta["time_start"] == 1_791_000_000.0 and graph.meta["time_end"] == 1_791_000_510.0
    # The times survive a round trip through the page and back.
    from netseer.serialize import graph_from_dict

    again = graph_from_dict(graph.to_dict())
    assert {m: n for n in again.nodes for m in n.macs}[a].seen == by_mac[a].seen


def test_kismet_first_and_last_seen(tmp_path):
    import sqlite3

    from netseer.ingest import ingest_sources
    from tests.test_kismetdb import device, make_kismet

    data = make_kismet(tmp_path, devices=[("IEEE802.11", "AA:BB:CC:00:00:01", "Wi-Fi AP", device("AA:BB:CC:00:00:01", "Wi-Fi AP", ssids=["HQ"]), 0, 0)])
    log = tmp_path / "walk.kismet"
    log.write_bytes(data)
    con = sqlite3.connect(log)
    con.execute("UPDATE devices SET first_time = 1791168955, last_time = 1791169023")
    con.commit()
    con.close()
    graph = ingest_sources([(log.name, log)])
    ap = next(n for n in graph.nodes if "HQ" in n.ssids)
    assert ap.seen == [[1791168955.0, 1791169023.0]]


def test_surveys_without_times_have_none(tmp_path):
    from netseer.ingest import ingest_sources
    from netseer.samples import DATA_DIR

    netxml = DATA_DIR / "kismet-walk.netxml"
    graph = ingest_sources([(netxml.name, netxml)])
    assert all(not n.seen for n in graph.nodes) and "time_start" not in graph.meta
