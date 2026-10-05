from __future__ import annotations

import io
import time

import pytest

from netseer.graph import GraphBuilder


def wifi_capture(tmp_path, repeats: int = 30):
    """A radiotap capture shaped like a real one: lots of repeated beacons and encrypted data."""
    from scapy.layers.dot11 import Dot11, Dot11Beacon, Dot11Elt, Dot11ProbeReq, Dot11QoS, RadioTap
    from scapy.utils import wrpcap

    def rt(signal, freq=2437):
        return RadioTap(present=0x2A, Flags=0, ChannelFrequency=freq, ChannelFlags=0x00A0, dBm_AntSignal=signal)

    ap1, ap2, sta = "aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02", "d0:3f:27:26:dd:7f"
    rsn = bytes.fromhex("0100000fac040100000fac040100000fac020000")
    frames = []
    for i in range(repeats):
        frames.append(rt(-40 - i % 7) / Dot11(type=0, subtype=8, addr1="ff:ff:ff:ff:ff:ff", addr2=ap1, addr3=ap1, SC=i << 4)
                      / Dot11Beacon(cap=0x1411, timestamp=i * 102400) / Dot11Elt(ID=0, info=b"HQ-Secure") / Dot11Elt(ID=3, info=b"\x06")
                      / Dot11Elt(ID=5, info=bytes([0, 1, i % 3, 0])) / Dot11Elt(ID=48, info=rsn))
        frames.append(rt(-70 + i % 5, 5180) / Dot11(type=0, subtype=8, addr1="ff:ff:ff:ff:ff:ff", addr2=ap2, addr3=ap2, SC=i << 4)
                      / Dot11Beacon(cap=0x0401, timestamp=i * 102400) / Dot11Elt(ID=0, info=b"Lobby") / Dot11Elt(ID=3, info=b"\x24"))
        frames.append(rt(-55 - i % 9) / Dot11(type=2, subtype=8, FCfield=0x41, addr1=ap1, addr2=sta, addr3=ap1, SC=i << 4)
                      / Dot11QoS() / (b"\x00" * 40))
        if i % 10 == 0:
            frames.append(rt(-60) / Dot11(type=0, subtype=4, addr1="ff:ff:ff:ff:ff:ff", addr2=sta, addr3="ff:ff:ff:ff:ff:ff")
                          / Dot11ProbeReq() / Dot11Elt(ID=0, info=b"HomeNet"))
    path = tmp_path / "walk.pcap"
    wrpcap(str(path), frames)
    return path


def graph_dict(builder):
    g = builder.finalize().to_dict()
    return {n["id"]: n for n in g["nodes"]}, {l["id"]: l for l in g["links"]}


def test_radiotap_header_fields():
    from scapy.layers.dot11 import Dot11, RadioTap

    from netseer.parsers.fastwifi import radiotap

    raw = bytes(RadioTap(present=0x2B, mac_timestamp=5, Flags=0x10, ChannelFrequency=5240, ChannelFlags=0x0140, dBm_AntSignal=-63) / Dot11())
    length, flags, freq, signal = radiotap(raw)
    assert flags == 0x10 and freq == 5240 and signal == -63 and length < len(raw)
    assert radiotap(b"\x00\x00") is None


def test_fast_path_builds_the_same_map_as_full_decoding(tmp_path):
    from scapy.utils import PcapReader

    import netseer.parsers.pcap as pcapmod

    data = wifi_capture(tmp_path).read_bytes()
    old = GraphBuilder()
    reader = PcapReader(io.BytesIO(data))
    pcapmod.feed_packets(old, reader, "walk.pcap")
    reader.close()
    new = GraphBuilder()
    pcapmod.parse_pcap(new, data, "walk.pcap")
    assert old.packet_count == new.packet_count
    old_nodes, old_links = graph_dict(old)
    new_nodes, new_links = graph_dict(new)
    assert old_nodes == new_nodes  # SSIDs, channels, encryption, signal min/max all match
    assert old_links == new_links  # including frame counts
    hq = new_nodes["mac:aa:bb:cc:00:00:01"]
    assert hq["ssids"] == ["HQ-Secure"] and hq["signal_max_dbm"] == -40 and hq["signal_min_dbm"] == -63  # beacons and data to it


def test_no_size_or_packet_limit_when_installed(monkeypatch):
    from netseer.ingest import max_upload_bytes, size_error
    from netseer.parsers.pcap import max_packets

    for name in ("NETSEER_HOSTED", "NETSEER_MAX_UPLOAD_MB", "NETSEER_MAX_PACKETS"):
        monkeypatch.delenv(name, raising=False)
    assert max_upload_bytes() is None and max_packets() is None
    assert size_error(50 * 1024**3) is None
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert max_upload_bytes() == 20 * 1024 * 1024
    assert "Install NetSeer" in str(size_error(21 * 1024 * 1024))
    monkeypatch.setenv("NETSEER_MAX_UPLOAD_MB", "0")
    assert max_upload_bytes() is None


def test_reading_from_disk_matches_reading_bytes(tmp_path):
    from netseer.ingest import ingest_sources

    path = wifi_capture(tmp_path)
    seen = []
    from_disk = ingest_sources([(path.name, path)], progress=seen.append)
    from_bytes = ingest_sources([(path.name, path.read_bytes())])
    assert from_disk.to_dict()["nodes"] == from_bytes.to_dict()["nodes"]
    assert seen == [] or seen[-1]["fraction"] <= 1.0


def _wait(client, job_id, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        status = client.get(f"/api/parse/jobs/{job_id}").json()
        if status["state"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError("job didn't finish")


def test_reading_jobs_upload_progress_and_result(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    monkeypatch.delenv("NETSEER_MAX_UPLOAD_MB", raising=False)
    client = TestClient(webmod.app)
    data = wifi_capture(tmp_path).read_bytes()
    started = client.post("/api/parse/jobs?name=walk.pcap", content=data, headers={"content-type": "application/octet-stream"}).json()
    assert started["state"] == "running" and started["bytes"] == len(data)
    done = _wait(client, started["id"])
    assert done["state"] == "done" and done["packets"] > 0
    graph = client.get(f"/api/parse/jobs/{started['id']}/result").json()
    assert any(n["id"] == "mac:aa:bb:cc:00:00:01" for n in graph["nodes"])
    assert client.get(f"/api/parse/jobs/{started['id']}").status_code == 404  # result collected

    bad = client.post("/api/parse/jobs?name=notes.txt", content=b"hello", headers={"content-type": "application/octet-stream"}).json()
    status = _wait(client, bad["id"])
    assert status["state"] == "error"
    assert client.get(f"/api/parse/jobs/{bad['id']}/result").status_code == 400

    cancelled = client.post("/api/parse/jobs?name=walk.pcap", content=data, headers={"content-type": "application/octet-stream"}).json()
    assert client.delete(f"/api/parse/jobs/{cancelled['id']}").status_code == 204


def test_online_copy_refuses_big_uploads(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    monkeypatch.setenv("NETSEER_HOSTED", "1")
    monkeypatch.setenv("NETSEER_MAX_UPLOAD_MB", "1")
    client = TestClient(webmod.app)
    res = client.post("/api/parse/jobs?name=big.pcap", content=b"\0" * (2 * 1024 * 1024), headers={"content-type": "application/octet-stream"})
    assert res.status_code == 413 and "Install NetSeer" in res.json()["detail"]
    assert client.get("/api/health").json()["max_upload_mb"] == 1


def test_kismet_and_netxml_stream_from_disk(tmp_path):
    from netseer.ingest import ingest_sources
    from netseer.samples import DATA_DIR

    netxml = DATA_DIR / "kismet-walk.netxml"
    assert ingest_sources([(netxml.name, netxml)]).to_dict()["nodes"] == ingest_sources([(netxml.name, netxml.read_bytes())]).to_dict()["nodes"]

    from tests.test_kismetdb import device, make_kismet

    data = make_kismet(tmp_path, devices=[("IEEE802.11", "AA:BB:CC:00:00:01", "Wi-Fi AP", device("AA:BB:CC:00:00:01", "Wi-Fi AP", ssids=["HQ"]), 0, 0)])
    log = tmp_path / "walk.kismet"
    log.write_bytes(data)
    graph = ingest_sources([(log.name, log)])
    assert any("HQ" in n.ssids for n in graph.nodes)


@pytest.mark.parametrize("stop_after", [1])
def test_stop_keeps_what_was_read(tmp_path, stop_after):
    from netseer.ingest import ingest_sources

    path = wifi_capture(tmp_path, repeats=2000)
    calls = {"n": 0}

    def should_stop():
        calls["n"] += 1
        return calls["n"] >= stop_after

    graph = ingest_sources([(path.name, path)], should_stop=should_stop)
    assert graph.nodes and any("stopped reading after" in w for w in graph.meta["warnings"])
