"""Kismet's native log (.kismet): an SQLite database of packets and device records.

Two passes, so the map gets the best of both:
1. The packets table holds the raw frames (radiotap 802.11, Ethernet, ...). They go
   through the same decoder as a pcap, which finds addresses, traffic, and services.
2. The devices table holds Kismet's own summary of every device: SSIDs, channels,
   encryption, maker, signal, location, and which clients joined which access points.
   That fills in what the packets alone don't show (for example, networks only heard
   in a beacon or two, or packet logging switched off).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Callable

from netseer.detect import EmptySurveyError, UnsupportedSurveyError
from netseer.graph import GraphBuilder
from netseer.models import GpsFix
from netseer.parsers.fastwifi import feed_raw
from netseer.parsers.pcap import _handle_packet, decode_frame, max_packets

SQLITE_MAGIC = b"SQLite format 3\x00"
# Link types the packet decoder understands (Ethernet, 802.11, Prism, radiotap, AVS).
PACKET_DLTS = {1, 105, 119, 127, 163}
ZERO_MACS = {"00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF"}


def is_sqlite(data: bytes) -> bool:
    return data[:16] == SQLITE_MAGIC


def _open(data: bytes | Path) -> tuple[sqlite3.Connection, str | None]:
    """The log read in place from disk, or an in-memory copy of bytes (a temporary file on older SQLite builds)."""
    if isinstance(data, Path):
        return sqlite3.connect(f"{data.resolve().as_uri()}?mode=ro&immutable=1", uri=True), None
    con = sqlite3.connect(":memory:")
    try:
        con.deserialize(data)
        return con, None
    except (AttributeError, sqlite3.Error):
        con.close()
    fd, path = tempfile.mkstemp(suffix=".kismet")
    with os.fdopen(fd, "wb") as out:
        out.write(data)
    return sqlite3.connect(path), path


def _tables(con: sqlite3.Connection) -> set[str]:
    return {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def kismet_encryption(crypt: str | None) -> str | None:
    """Kismet's crypt string ("WPA2 WPA2-PSK AES-CCMP") in the labels the pcap decoder uses."""
    text = (crypt or "").upper()
    if not text:
        return None
    if text.startswith("OPEN") or text == "NONE":
        return "Open"
    if "OWE" in text:
        return "OWE"
    if "EAP" in text or "802.1X" in text:
        return "WPA3-802.1X-192" if "GCMP256" in text and "WPA3" in text else ("WPA2-802.1X" if "WPA2" in text or "WPA3" in text else "WPA-802.1X")
    if "SAE" in text:
        return "WPA3-SAE"
    if "WPA2-PSK" in text or "WPA3-PSK" in text:
        return "WPA/WPA2-PSK" if "WPA1" in text else "WPA2-PSK"
    if "WPA1" in text or "WPA-PSK" in text:
        return "WPA-PSK"
    if "WEP" in text:
        return "WEP"
    return crypt.strip() if crypt else None


def _int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _mac(value: Any) -> str | None:
    mac = str(value or "").strip().upper()
    return mac if re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", mac) and mac not in ZERO_MACS else None


def _records(value: Any) -> list[dict]:
    """Kismet stores maps both as lists of records and as {key: record}."""
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        return [v for v in value.values() if isinstance(v, dict)]
    return []


def _gps(lat: Any, lon: Any) -> GpsFix | None:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    # Kismet writes 0,0 when it had no GPS fix.
    if lat == 0 and lon == 0:
        return None
    return GpsFix(lat=lat, lon=lon, alt=None)


def _frames(con: sqlite3.Connection, counts: Counter, limit: int | None) -> Any:
    """(link type, bytes) for each logged packet the decoder understands."""
    query = "SELECT dlt, packet FROM packets ORDER BY ts_sec, ts_usec"
    rows = con.execute(query + " LIMIT ?", (limit + 1,)) if limit else con.execute(query)
    for dlt, blob in rows:
        if dlt not in PACKET_DLTS or not blob:
            counts["other_packets"] += 1
            continue
        yield dlt, bytes(blob)


def _apply_device(builder: GraphBuilder, row: tuple, counts: Counter) -> None:
    phyname, devmac, avg_lat, avg_lon, kind, blob = row
    if phyname != "IEEE802.11":
        counts[phyname or "unknown"] += 1
        return
    mac = _mac(devmac)
    if not mac:
        return
    try:
        dev = json.loads(blob)
    except (TypeError, ValueError):
        return
    dot11 = dev.get("dot11.device") or {}
    vendor = (dev.get("kismet.device.base.manuf") or "").strip() or None
    if vendor and vendor.lower() in {"unknown", "private"}:
        vendor = None
    signal = (dev.get("kismet.device.base.signal") or {}).get("kismet.common.signal.last_signal")
    signal = signal if isinstance(signal, (int, float)) and signal < 0 else None
    channel = _int(dev.get("kismet.device.base.channel"))
    freq_khz = dev.get("kismet.device.base.frequency") or 0
    freq = freq_khz / 1000 if isinstance(freq_khz, (int, float)) and freq_khz > 0 else None
    gps = _gps(avg_lat, avg_lon)

    if kind == "Wi-Fi AP":
        node_id = builder.add_ap(mac, channel=channel, frequency_mhz=freq, signal_dbm=signal, gps=gps, vendor=vendor,
                                 encryption=kismet_encryption(dev.get("kismet.device.base.crypt")))
        if not node_id:
            return
        hidden = False
        for rec in _records(dot11.get("dot11.device.advertised_ssid_map")):
            ssid = (rec.get("dot11.advertisedssid.ssid") or "").strip()
            if ssid:
                builder.observe_rf(node_id, ssid=ssid, channel=_int(rec.get("dot11.advertisedssid.channel")),
                                   encryption=kismet_encryption(rec.get("dot11.advertisedssid.crypt_string")))
            elif rec.get("dot11.advertisedssid.cloaked"):
                hidden = True
        if hidden:
            builder._device(node_id)["extra"]["hidden_ssid"] = True
        counts["aps"] += 1
        return

    if kind == "Wi-Fi Bridged":
        # A wired device whose traffic an access point bridged onto the air.
        builder.observe_mac(mac, wireless=False, vendor=vendor)
        counts["bridged"] += 1
        return

    node_id = builder.observe_mac(mac, wireless=True, vendor=vendor)
    if not node_id:
        return
    builder.observe_signal(node_id, signal)
    builder.observe_rf(node_id, channel=channel, frequency_mhz=freq, gps=gps)
    probed = [(r.get("dot11.probedssid.ssid") or "").strip() for r in _records(dot11.get("dot11.device.probed_ssid_map"))]
    probed = sorted({p for p in probed if p})
    if probed:
        builder._device(node_id)["extra"]["probed_ssids"] = probed
    if kind == "Wi-Fi Client":
        builder.add_role(node_id, "station")
        for rec in _records(dot11.get("dot11.device.client_map")):
            bssid = _mac(rec.get("dot11.client.bssid"))
            if bssid and bssid != mac:
                builder.add_wireless_link(mac, bssid, associated=True)
        counts["clients"] += 1
    else:
        counts["other_wifi"] += 1


def parse_kismetdb(
    builder: GraphBuilder,
    data: bytes | Path,
    filename: str,
    *,
    progress: Callable[[int, float], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> None:
    con, temp_path = _open(data)
    try:
        try:
            tables = _tables(con)
        except sqlite3.DatabaseError as exc:
            raise UnsupportedSurveyError(f"{filename} isn't a readable Kismet log: {exc}") from exc
        if "KISMET" not in tables or "devices" not in tables:
            raise UnsupportedSurveyError(f"{filename} is an SQLite database, but not a Kismet log (.kismet).")
        n_devices = con.execute("SELECT count(*) FROM devices").fetchone()[0]
        n_packets = con.execute("SELECT count(*) FROM packets").fetchone()[0] if "packets" in tables else 0
        if not n_devices and not n_packets:
            raise EmptySurveyError("This Kismet log has no devices or packets in it. Kismet may have stopped before it heard anything.")
        counts: Counter = Counter()
        if "packets" in tables:
            limit = max_packets()
            total = min(n_packets, limit) if limit else n_packets
            report = (lambda seen: progress(seen, seen / total if total else 1.0)) if progress else None
            feed_raw(builder, _frames(con, counts, limit), filename, decode_frame, _handle_packet, max_packets=limit, progress=report, should_stop=should_stop)
        for row in con.execute("SELECT phyname, devmac, avg_lat, avg_lon, type, device FROM devices"):
            _apply_device(builder, row, counts)
        if not builder.packet_count:
            builder.packet_count += 1  # device records alone still make a survey
        skipped = {k: v for k, v in counts.items() if k not in {"aps", "clients", "bridged", "other_wifi", "other_packets", "bad_packets"}}
        if skipped:
            what = ", ".join(f"{n} {phy}" for phy, n in sorted(skipped.items()))
            builder.warnings.append(f"{filename}: left out {what} device(s); NetSeer maps Wi-Fi and wired networks.")
        if counts["bad_packets"]:
            builder.warnings.append(f"{filename}: skipped {counts['bad_packets']} packets that could not be decoded.")
    finally:
        con.close()
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
