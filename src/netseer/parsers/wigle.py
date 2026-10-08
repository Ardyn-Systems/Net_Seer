"""WiGLE wardrive CSV (WigleWifi-1.x).

Exported by WiGLE WiFi Wardriving and compatible apps (one row per observation). The file starts
with a "WigleWifi-1.x,appRelease=..." preamble line, then a column header. Columns vary by version:
1.4 has no Frequency/RCOIs/MfgrId; 1.6 adds them. We read the Wi-Fi rows (Type=WIFI) and skip the
Bluetooth and cellular ones, since NetSeer maps Wi-Fi and wired networks.
"""

from __future__ import annotations

import csv
import io
import re

from netseer.graph import GraphBuilder
from netseer.models import GpsFix

# Bracketed AuthMode tokens that describe the BSS or features, not the encryption.
_NON_SECURITY = {"ESS", "IBSS", "MESH"}


def _wigle_encryption(authmode: str) -> str | None:
    """Turn WiGLE's AuthMode (e.g. "[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]") into NetSeer's form."""
    tokens = re.findall(r"\[([^\]]*)\]", authmode)
    if not tokens:
        tokens = [authmode] if authmode.strip() else []
    if not tokens:
        return None
    security = [t for t in tokens if t and t.upper() not in _NON_SECURITY and t.upper() != "WPS"]
    if not security:
        return "OPEN"  # only ESS/IBSS/WPS present: an open network
    if any(t.upper() == "WPS" for t in tokens):
        security.append("WPS")
    return " ".join(security)


def parse_wigle_csv(builder: GraphBuilder, data: bytes, filename: str) -> None:
    text = data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    lines = text.split("\n")
    # Skip the "WigleWifi-1.x,..." preamble; find the column header (MAC,SSID,AuthMode,...).
    start = None
    for i, line in enumerate(lines[:5]):
        cols = [c.strip().lower() for c in line.split(",")]
        if "mac" in cols and "ssid" in cols:
            start = i
            break
    if start is None:
        raise ValueError(f"{filename} is not a WiGLE (WigleWifi) CSV: no MAC/SSID header.")

    reader = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    fields = {name.strip().lower(): name for name in (reader.fieldnames or []) if name}

    def col(row: dict, name: str) -> str:
        key = fields.get(name.lower())
        return (row.get(key) or "").strip() if key else ""

    def num(text: str, cast):
        try:
            return cast(float(text)) if text else None
        except ValueError:
            return None

    for row in reader:
        mac = col(row, "MAC")
        if not mac:
            continue
        rtype = col(row, "Type").upper()
        sig = num(col(row, "RSSI"), float)
        lat, lon, alt = col(row, "CurrentLatitude"), col(row, "CurrentLongitude"), col(row, "AltitudeMeters")
        gps = None
        try:
            if lat and lon:
                gps = GpsFix(lat=float(lat), lon=float(lon), alt=float(alt) if alt else None)
        except ValueError:
            gps = None
        builder.packet_count += 1
        if rtype in ("BT", "BLE", "BTLE"):
            builder.add_bluetooth(
                mac,
                name=col(row, "SSID") or None,
                device_class=col(row, "AuthMode") or None,
                variant="BLE" if rtype in ("BLE", "BTLE") else "BT",
                signal_dbm=sig,
                gps=gps,
            )
        elif rtype in ("GSM", "CDMA", "WCDMA", "UMTS", "LTE", "NR"):
            auth = col(row, "AuthMode")  # "LTE;310260" -> radio;PLMN
            plmn = auth.split(";", 1)[1].strip() if ";" in auth else None
            builder.add_cell_tower(
                mac,
                carrier=col(row, "SSID") or None,
                radio=rtype,
                plmn=plmn,
                channel_arfcn=col(row, "Channel") or None,
                signal_dbm=sig,
                gps=gps,
            )
        else:  # WIFI, W, or blank -> an access point
            builder.add_ap(
                mac,
                ssid=col(row, "SSID") or None,
                channel=num(col(row, "Channel"), int),
                frequency_mhz=num(col(row, "Frequency"), float),
                encryption=_wigle_encryption(col(row, "AuthMode")),
                signal_dbm=sig,
                gps=gps,
            )
