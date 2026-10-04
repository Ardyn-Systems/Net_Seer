from __future__ import annotations

import csv
import io

from netseer.graph import GraphBuilder


def parse_airodump_csv(builder: GraphBuilder, data: bytes, filename: str) -> None:
    text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
    parts = text.split("\n\n")
    ap_block = parts[0] if parts else text
    sta_block = parts[1] if len(parts) > 1 else ""

    ap_reader = csv.reader(io.StringIO(ap_block.strip() + "\n"))
    header = next(ap_reader, None)
    if not header or not any("BSSID" in (col or "").upper() for col in header):
        raise ValueError(f"{filename} is not an airodump-ng AP/station CSV.")
    idx = {name.strip(): i for i, name in enumerate(header) if name}

    def cell(row: list[str], name: str) -> str:
        i = idx.get(name)
        if i is None or i >= len(row):
            return ""
        return row[i].strip()

    for row in ap_reader:
        if not row or not row[0].strip() or row[0].strip().upper() == "STATION MAC":
            continue
        builder.packet_count += 1
        bssid = cell(row, "BSSID")
        ssid = cell(row, "ESSID")
        channel = cell(row, "channel") or cell(row, "Channel")
        privacy = cell(row, "Privacy")
        cipher = cell(row, "Cipher")
        auth = cell(row, "Authentication")
        power = cell(row, "Power")
        lan_ip = cell(row, "LAN IP")
        enc_parts = [p for p in (privacy, cipher, auth) if p]
        try:
            ch = int(float(channel)) if channel else None
        except ValueError:
            ch = None
        try:
            sig = float(power) if power else None
        except ValueError:
            sig = None
        node = builder.add_ap(
            bssid,
            ssid=ssid or None,
            channel=ch,
            encryption=" ".join(enc_parts) if enc_parts else None,
            signal_dbm=sig,
        )
        if lan_ip and lan_ip not in {"0.0.0.0", ""} and node:
            builder.bind_ip_mac(lan_ip, bssid)

    if not sta_block.strip():
        return
    sta_reader = csv.reader(io.StringIO(sta_block.strip() + "\n"))
    sta_header = next(sta_reader, None)
    if not sta_header:
        return
    sidx = {name.strip(): i for i, name in enumerate(sta_header) if name}

    def scell(row: list[str], name: str) -> str:
        i = sidx.get(name)
        if i is None or i >= len(row):
            return ""
        return row[i].strip()

    for row in sta_reader:
        if not row or not row[0].strip():
            continue
        builder.packet_count += 1
        sta = scell(row, "Station MAC")
        bssid = scell(row, "BSSID")
        power = scell(row, "Power")
        probed = scell(row, "Probed ESSIDs")
        try:
            sig = float(power) if power else None
        except ValueError:
            sig = None
        ssid = probed.split(",")[0].strip() if probed else None
        if bssid and bssid != "(not associated)":
            builder.add_wireless_link(sta, bssid, ssid=ssid, associated=True)
        sta_id = builder.observe_mac(sta, wireless=True)
        if sta_id:
            builder.add_role(sta_id, "station")
            builder.observe_signal(sta_id, sig)
            if ssid:
                builder.observe_rf(sta_id, ssid=ssid)
