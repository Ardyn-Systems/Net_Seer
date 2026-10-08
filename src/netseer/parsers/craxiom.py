"""Craxiom Network Survey Wi-Fi CSV.

Exported by the Craxiom "Network Survey" app (one row per Wi-Fi observation). The file opens with
"# Created by Network Survey ..." comment lines, then a column header with bssid, ssid, channel,
frequencyMhz, signalStrength, encryptionType, wps, and a GPS fix per row.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime

from netseer.graph import GraphBuilder
from netseer.models import GpsFix


def _craxiom_time(text: str) -> float | None:
    """Network Survey deviceTime, ISO 8601 with offset (e.g. 2026-10-03T19:25:10.38-04:00)."""
    text = text.strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None

# Network Survey's encryptionType enum -> tokens NetSeer's security engine understands.
_ENCRYPTION = {
    "OPEN": "OPEN",
    "NONE": "OPEN",
    "WEP": "WEP",
    "WPA": "WPA1",
    "WPA_WPA2": "WPA/WPA2",
    "WPA2": "WPA2",
    "WPA2_WPA3": "WPA2 WPA3",
    "WPA3": "WPA3",
}


def _craxiom_encryption(enc_type: str, wps: str) -> str | None:
    key = (enc_type or "").strip().upper()
    if not key:
        return None
    base = _ENCRYPTION.get(key, enc_type.strip())
    if base and base != "OPEN" and wps.strip().lower() == "true":
        base += " WPS"
    return base


def parse_craxiom_csv(builder: GraphBuilder, data: bytes, filename: str) -> None:
    text = data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    # Drop the leading "# ..." comment lines before the CSV header.
    lines = [line for line in text.split("\n") if not line.lstrip().startswith("#")]
    reader = csv.DictReader(io.StringIO("\n".join(lines)))
    fields = {name.strip().lower(): name for name in (reader.fieldnames or []) if name}
    if "bssid" not in fields:
        raise ValueError(f"{filename} is not a Craxiom Network Survey CSV: no bssid column.")

    def col(row: dict, name: str) -> str:
        key = fields.get(name.lower())
        return (row.get(key) or "").strip() if key else ""

    def num(text: str, cast):
        try:
            return cast(float(text)) if text else None
        except ValueError:
            return None

    try:
        for row in reader:
            bssid = col(row, "bssid")
            if not bssid:
                continue
            builder.packet_count += 1
            sig = num(col(row, "signalStrength"), float)
            lat, lon, alt = num(col(row, "latitude"), float), num(col(row, "longitude"), float), num(col(row, "altitude"), float)
            gps = GpsFix(lat=lat, lon=lon, alt=alt) if lat is not None and lon is not None else None
            t = _craxiom_time(col(row, "deviceTime"))
            builder.now = t
            node_id = builder.add_ap(
                bssid,
                ssid=col(row, "ssid") or None,
                channel=num(col(row, "channel"), int),
                frequency_mhz=num(col(row, "frequencyMhz"), float),
                encryption=_craxiom_encryption(col(row, "encryptionType"), col(row, "wps")),
                signal_dbm=sig,
                gps=gps,
            )
            if node_id:
                builder.observe_track(node_id, lat, lon, t, sig)
    finally:
        builder.now = None
