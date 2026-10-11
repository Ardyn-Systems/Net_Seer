"""Accumulate a live wardrive into a graph as a companion app streams observations.

A LiveSession holds one GraphBuilder and folds each observation message (see the schema in
docs/integration-api.md) into it with the same calls the airodump/Kismet parsers use, so the live
map renders exactly like a parsed one. web.py owns the session store, the WebSocket, and the
throttled broadcast to NetSeer's own pages.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from netseer.graph import GraphBuilder
from netseer.models import GpsFix

# Security label from the observation's short name to what the rest of NetSeer shows.
_ENCRYPTION = {"open": "Open", "wep": "WEP", "wpa": "WPA", "wpa2": "WPA2", "wpa3": "WPA3", "owe": "OWE"}


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    n = _num(value)
    return int(n) if n is not None else None


def _gps(source: Any) -> GpsFix | None:
    if not isinstance(source, dict):
        return None
    lat, lon = _num(source.get("lat")), _num(source.get("lon"))
    if lat is None or lon is None:
        return None
    return GpsFix(lat=lat, lon=lon, alt=_num(source.get("alt")))


def _ts(value: Any) -> float | None:
    """An observation time as epoch seconds, from an ISO-8601 string or a number. None if unparseable."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).strip().replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


class LiveSession:
    def __init__(self, session_id: str, device_name: str) -> None:
        self.id = session_id
        self.device = device_name
        self.observations = 0
        self.builder = GraphBuilder()
        self.builder.note_source(f"Live wardrive — {device_name}")

    def apply(self, message: dict) -> None:
        """Fold one observation delta into the running graph."""
        fallback_gps = _gps(message.get("position"))
        msg_ts = _ts(message.get("ts"))
        for dev in message.get("devices") or []:
            mac = dev.get("mac")
            if not mac:
                continue
            enc = _ENCRYPTION.get(str(dev.get("security") or "").lower())
            gps = _gps(dev.get("gps")) or fallback_gps
            sig = _num(dev.get("signal_dbm"))
            when = _ts(dev.get("seen_at")) or msg_ts
            if str(dev.get("kind") or "").lower() == "ap":
                node_id = self.builder.add_ap(
                    mac,
                    ssid=dev.get("ssid"),
                    channel=_int(dev.get("channel")),
                    encryption=enc,
                    signal_dbm=sig,
                    gps=gps,
                    vendor=dev.get("vendor"),
                )
            else:
                node_id = self.builder.observe_mac(mac, wireless=True, vendor=dev.get("vendor"))
                if node_id:
                    self.builder.add_role(node_id, "station")
                    self.builder.observe_signal(node_id, sig)
                    self.builder.observe_rf(node_id, ssid=dev.get("ssid"), channel=_int(dev.get("channel")), encryption=enc, gps=gps)
            # Each GPS sighting builds the device's track, so a live wardrive gets the operator route,
            # signal-weighted estimated locations, and the timeline — like an imported wardrive, not a
            # single point pinned to the operator.
            if node_id and gps is not None:
                self.builder.observe_track(node_id, gps.lat, gps.lon, when, sig)
            self.observations += 1
        for link in message.get("links") or []:
            # Convention: a station associating to an access point, so from=client, to=AP.
            frm, to = link.get("from"), link.get("to")
            if frm and to:
                self.builder.add_wireless_link(frm, to, ssid=link.get("ssid"), associated=link.get("kind") != "probe")

    def graph_dict(self) -> dict | None:
        """The accumulated graph as JSON, or None while nothing has been observed yet."""
        graph = self.builder.finalize()
        return graph.to_dict() if graph.nodes else None
