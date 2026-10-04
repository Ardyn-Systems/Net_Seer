from __future__ import annotations

import csv
import io
import xml.etree.ElementTree as ET

from netseer.graph import GraphBuilder
from netseer.models import GpsFix


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    text = el.text.strip()
    return text or None


def _float(el: ET.Element | None) -> float | None:
    text = _text(el)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _int(el: ET.Element | None) -> int | None:
    text = _text(el)
    if text is None:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _find(parent: ET.Element, name: str) -> ET.Element | None:
    direct = parent.find(name)
    if direct is not None:
        return direct
    return parent.find(f".//{name}")


def parse_kismet_netxml(builder: GraphBuilder, data: bytes, filename: str) -> None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid Kismet netxml ({filename}): {exc}") from exc
    builder.packet_count += 1
    for net in root.iter("wireless-network"):
        bssid = _text(_find(net, "BSSID"))
        ssid_el = _find(net, "SSID")
        essid = None
        encs: list[str] = []
        if ssid_el is not None:
            essid_el = ssid_el.find("essid")
            essid = _text(essid_el) or _text(ssid_el.find("essid"))
            for enc in ssid_el.findall("encryption"):
                if enc.text:
                    encs.append(enc.text.strip())
        channel = _int(_find(net, "channel"))
        freq = _float(_find(net, "freqmhz"))
        snr = _find(net, "snr-info")
        signal = _float(snr.find("last_signal_dbm") if snr is not None else None)
        gps_el = _find(net, "gps-info")
        gps = None
        if gps_el is not None:
            lat = _float(gps_el.find("avg-lat")) or _float(gps_el.find("peak-lat"))
            lon = _float(gps_el.find("avg-lon")) or _float(gps_el.find("peak-lon"))
            alt = _float(gps_el.find("avg-alt")) or _float(gps_el.find("peak-alt"))
            if lat is not None and lon is not None:
                gps = GpsFix(lat=lat, lon=lon, alt=alt)
        vendor = _text(_find(net, "manuf"))
        node_id = builder.add_ap(
            bssid,
            ssid=essid,
            channel=channel,
            frequency_mhz=freq,
            encryption="+".join(encs) if encs else None,
            signal_dbm=signal,
            gps=gps,
            vendor=vendor,
        )
        carrier = _text(_find(net, "carrier"))
        if node_id and carrier:
            builder._device(node_id)["extra"]["carrier"] = carrier
        for client in net.findall("wireless-client"):
            c_mac = _text(_find(client, "client-mac"))
            c_manuf = _text(_find(client, "client-manuf"))
            c_snr = _find(client, "snr-info")
            c_sig = _float(c_snr.find("last_signal_dbm") if c_snr is not None else None)
            c_gps_el = _find(client, "gps-info")
            c_gps = None
            if c_gps_el is not None:
                lat = _float(c_gps_el.find("avg-lat"))
                lon = _float(c_gps_el.find("avg-lon"))
                if lat is not None and lon is not None:
                    c_gps = GpsFix(lat=lat, lon=lon, alt=_float(c_gps_el.find("avg-alt")))
            sta_id = builder.observe_mac(c_mac, wireless=True, vendor=c_manuf)
            if sta_id:
                builder.add_role(sta_id, "station")
                builder.observe_signal(sta_id, c_sig)
                builder.observe_rf(sta_id, ssid=essid, channel=channel, gps=c_gps)
            builder.add_wireless_link(c_mac, bssid, ssid=essid, associated=True)


def parse_kismet_csv(builder: GraphBuilder, data: bytes, filename: str) -> None:
    text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError(f"Kismet CSV {filename} has no header.")
    fields = {name.strip(): name for name in reader.fieldnames if name}
    def col(row: dict, *names: str) -> str | None:
        for name in names:
            key = fields.get(name) or next((k for k in row if k and k.strip().lower() == name.lower()), None)
            if key is None:
                continue
            value = (row.get(key) or "").strip()
            if value:
                return value
        return None

    for row in reader:
        builder.packet_count += 1
        bssid = col(row, "BSSID")
        ssid = col(row, "ESSID", "SSID")
        channel = col(row, "Channel")
        enc = col(row, "Encryption", "Privacy")
        signal = col(row, "BestSignal", "BestQuality", "Power")
        lat = col(row, "GPSBestLat", "GPSAvgLat", "BestLat")
        lon = col(row, "GPSBestLon", "GPSAvgLon", "BestLon")
        alt = col(row, "GPSBestAlt")
        gps = None
        try:
            if lat and lon:
                gps = GpsFix(lat=float(lat), lon=float(lon), alt=float(alt) if alt else None)
        except ValueError:
            gps = None
        try:
            ch = int(float(channel)) if channel else None
        except ValueError:
            ch = None
        try:
            sig = float(signal) if signal else None
        except ValueError:
            sig = None
        builder.add_ap(
            bssid,
            ssid=ssid,
            channel=ch,
            encryption=enc,
            signal_dbm=sig,
            gps=gps,
        )
