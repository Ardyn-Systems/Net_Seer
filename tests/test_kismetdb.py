from __future__ import annotations

import json
import sqlite3

import pytest

from netseer.detect import EmptySurveyError, UnsupportedSurveyError, sniff_format
from netseer.ingest import ingest_files
from netseer.parsers.kismetdb import kismet_encryption

SCHEMA = """
CREATE TABLE KISMET (kismet_version TEXT, db_version INT, db_module TEXT);
CREATE TABLE devices (first_time INT, last_time INT, devkey TEXT, phyname TEXT, devmac TEXT, strongest_signal INT,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL, avg_lat REAL, avg_lon REAL, bytes_data INT, type TEXT, device BLOB);
CREATE TABLE packets (ts_sec INT, ts_usec INT, phyname TEXT, sourcemac TEXT, destmac TEXT, transmac TEXT, frequency REAL,
  devkey TEXT, lat REAL, lon REAL, alt REAL, speed REAL, heading REAL, packet_len INT, signal INT, datasource TEXT,
  dlt INT, packet BLOB, error INT, tags TEXT, datarate REAL, hash INT, packetid INT, packet_full_len INT);
"""


def device(mac, kind, *, crypt="", manuf="", channel="", freq=0, ssids=(), hidden=False, clients=(), probed=(), signal=-60):
    dot11 = {}
    adv = [{"dot11.advertisedssid.ssid": s, "dot11.advertisedssid.channel": channel, "dot11.advertisedssid.crypt_string": crypt} for s in ssids]
    if hidden:
        adv.append({"dot11.advertisedssid.ssid": "", "dot11.advertisedssid.cloaked": 1, "dot11.advertisedssid.channel": channel})
    if adv:
        dot11["dot11.device.advertised_ssid_map"] = adv
    if clients:
        dot11["dot11.device.client_map"] = {b: {"dot11.client.bssid": b, "dot11.client.type": 0} for b in clients}
    if probed:
        dot11["dot11.device.probed_ssid_map"] = [{"dot11.probedssid.ssid": p} for p in probed]
    return {
        "kismet.device.base.macaddr": mac,
        "kismet.device.base.type": kind,
        "kismet.device.base.crypt": crypt,
        "kismet.device.base.manuf": manuf,
        "kismet.device.base.channel": channel,
        "kismet.device.base.frequency": freq,
        "kismet.device.base.signal": {"kismet.common.signal.last_signal": signal},
        "dot11.device": dot11,
    }


def beacon(bssid: str, ssid: str) -> bytes:
    from scapy.layers.dot11 import Dot11, Dot11Beacon, Dot11Elt, RadioTap

    pkt = RadioTap() / Dot11(type=0, subtype=8, addr1="ff:ff:ff:ff:ff:ff", addr2=bssid, addr3=bssid) / Dot11Beacon(cap=0x0411) / Dot11Elt(ID=0, info=ssid.encode())
    return bytes(pkt)


def make_kismet(tmp_path, *, devices=(), packets=()) -> bytes:
    path = tmp_path / "survey.kismet"
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.execute("INSERT INTO KISMET VALUES ('2025.09.0', 9, 'kismetlog')")
    for phy, mac, kind, dev, lat, lon in devices:
        con.execute("INSERT INTO devices (phyname, devmac, type, device, avg_lat, avg_lon) VALUES (?, ?, ?, ?, ?, ?)", (phy, mac, kind, json.dumps(dev), lat, lon))
    for i, (dlt, blob) in enumerate(packets):
        con.execute("INSERT INTO packets (ts_sec, ts_usec, phyname, dlt, packet) VALUES (?, 0, 'IEEE802.11', ?, ?)", (1_791_168_955 + i, dlt, blob))
    con.commit()
    con.close()
    return path.read_bytes()


def test_kismet_logs_are_recognized():
    sqlite_head = b"SQLite format 3\x00" + b"\0" * 100
    assert sniff_format(sqlite_head, "Kismet-20261005-02-55-33-1.kismet") == "kismetdb"
    with pytest.raises(UnsupportedSurveyError, match="SQLite"):
        sniff_format(sqlite_head, "contacts.db")


def test_kismet_encryption_matches_the_pcap_labels():
    assert kismet_encryption("Open") == "Open"
    assert kismet_encryption("WPA2 WPA2-PSK AES-CCMP") == "WPA2-PSK"
    assert kismet_encryption("WPA3 WPA3-PSK WPA3-SAE AES-CCMP") == "WPA3-SAE"
    assert kismet_encryption("WPA2 WPA2-EAP AES-CCMP") == "WPA2-802.1X"
    assert kismet_encryption("WPA1 WPA1-PSK AES-CCMP") == "WPA-PSK"
    assert kismet_encryption("") is None


def test_kismet_log_gives_aps_clients_and_details(tmp_path):
    ap, hidden_ap, client, bridged = "AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "D0:3F:27:26:DD:7F", "78:D2:94:9C:A2:3A"
    data = make_kismet(
        tmp_path,
        devices=[
            ("IEEE802.11", ap, "Wi-Fi AP", device(ap, "Wi-Fi AP", crypt="WPA2 WPA2-PSK AES-CCMP", manuf="eero inc.", channel="6", freq=2437000, ssids=["HQ-Secure"]), 35.1, -77.2),
            ("IEEE802.11", hidden_ap, "Wi-Fi AP", device(hidden_ap, "Wi-Fi AP", crypt="WPA3 WPA3-SAE AES-CCMP", channel="149", hidden=True), 0, 0),
            ("IEEE802.11", client, "Wi-Fi Client", device(client, "Wi-Fi Client", manuf="Wyze Labs Inc", channel="6", clients=[ap], probed=["HomeNet"]), 0, 0),
            ("IEEE802.11", bridged, "Wi-Fi Bridged", device(bridged, "Wi-Fi Bridged", manuf="NETGEAR"), 0, 0),
            ("BTLE", "11:22:33:44:55:66", "BTLE", {}, 0, 0),
        ],
        packets=[(127, beacon("aa:bb:cc:00:00:09", "Lobby-Guest"))],
    )
    graph = ingest_files([("survey.kismet", data)])
    by_mac = {m.upper(): n for n in graph.nodes for m in (n.macs or [])}

    hq = by_mac[ap]
    assert hq.kind == "ap" and "HQ-Secure" in hq.ssids and "WPA2-PSK" in hq.encryption and 6 in hq.channels
    assert hq.gps and round(hq.gps.lat, 1) == 35.1
    hidden = by_mac[hidden_ap]
    assert hidden.kind == "ap" and not hidden.ssids and hidden.extra.get("hidden_ssid") is True and "WPA3-SAE" in hidden.encryption

    sta = by_mac[client]
    assert "station" in sta.roles and sta.extra.get("probed_ssids") == ["HomeNet"]
    assert any(l.kind == "wireless" and {l.source, l.target} == {sta.id, hq.id} for l in graph.links)

    assert by_mac[bridged].medium == "wired"
    # From the packets table: an access point only heard in a beacon.
    assert "Lobby-Guest" in by_mac["AA:BB:CC:00:00:09"].ssids
    assert not any("11:22:33" in (m or "") for n in graph.nodes for m in n.macs)
    assert any("BTLE" in w for w in graph.meta["warnings"])


def test_empty_kismet_log_says_so(tmp_path):
    with pytest.raises(EmptySurveyError, match="no devices or packets"):
        ingest_files([("Kismet-empty.kismet", make_kismet(tmp_path))])


def test_sqlite_that_isnt_kismet_is_refused(tmp_path):
    path = tmp_path / "other.kismet"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE notes (body TEXT)")
    con.commit()
    con.close()
    with pytest.raises(UnsupportedSurveyError, match="not a Kismet log"):
        ingest_files([("other.kismet", path.read_bytes())])
