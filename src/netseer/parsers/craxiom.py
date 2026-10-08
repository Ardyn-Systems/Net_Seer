"""Craxiom Network Survey Wi-Fi CSV.

Exported by the Craxiom "Network Survey" app (one row per Wi-Fi observation). The file opens with
"# Created by Network Survey ..." comment lines, then a column header with bssid, ssid, channel,
frequencyMhz, signalStrength, encryptionType, wps, and a GPS fix per row.
"""

from __future__ import annotations

import csv
import io

from netseer.graph import GraphBuilder
from netseer.models import GpsFix

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

    for row in reader:
        bssid = col(row, "bssid")
        if not bssid:
            continue
        builder.packet_count += 1
        ssid = col(row, "ssid") or None
        channel = col(row, "channel")
        freq = col(row, "frequencyMhz")
        signal = col(row, "signalStrength")
        lat, lon, alt = col(row, "latitude"), col(row, "longitude"), col(row, "altitude")
        try:
            ch = int(float(channel)) if channel else None
        except ValueError:
            ch = None
        try:
            mhz = float(freq) if freq else None
        except ValueError:
            mhz = None
        try:
            sig = float(signal) if signal else None
        except ValueError:
            sig = None
        gps = None
        try:
            if lat and lon:
                gps = GpsFix(lat=float(lat), lon=float(lon), alt=float(alt) if alt else None)
        except ValueError:
            gps = None
        builder.add_ap(
            bssid,
            ssid=ssid,
            channel=ch,
            frequency_mhz=mhz,
            encryption=_craxiom_encryption(col(row, "encryptionType"), col(row, "wps")),
            signal_dbm=sig,
            gps=gps,
        )
