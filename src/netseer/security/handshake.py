"""Export a captured WPA handshake for offline password-strength testing of your own network.

Two formats, both built only from frames already in the capture:

- **pcap** (`.pcap`): the access point's beacon and the 4-way handshake frames, repackaged. Opens
  in Wireshark and converts to any tool's format (e.g. hcxpcapngtool for hashcat).
- **hashcat 22000** (`.hc22000`): the WPA line hashcat and aircrack read directly, built from the
  EAPOL nonces and MIC.

This repackages data the user already captured; it recovers no password itself. Use it only on
networks you're authorised to test.
"""

from __future__ import annotations

import struct
import time
from typing import Any

DLT_IEEE802_11 = 105


def _normalize(mac: str | None) -> str:
    return str(mac or "").lower()


def find_handshake(graph: dict[str, Any], node_id: str, peer: str | None = None) -> dict[str, Any] | None:
    """The frames, beacon, and identities for a handshake the given device took part in.

    Works whether ``node_id`` is the access point (which holds the frames) or the station (whose
    frames live on its access point). ``peer`` picks one when a device has several.
    """
    nodes = {n["id"]: n for n in graph.get("nodes") or []}
    by_mac: dict[str, dict] = {}
    for n in nodes.values():
        for mac in n.get("macs") or []:
            by_mac.setdefault(_normalize(mac), n)
    node = nodes.get(node_id)
    if not node:
        return None

    candidates: list[tuple[dict, str, dict, dict]] = []  # (ap_node, sta_mac, ap_mac, entry)
    own = (node.get("extra") or {}).get("handshakes") or {}
    is_ap = node.get("kind") == "ap" or "ap" in (node.get("roles") or [])
    if is_ap and any((e.get("frames") for e in own.values())):
        ap_mac = _normalize(next(iter(node.get("macs") or []), node_id.replace("mac:", "")))
        for sta_mac, entry in own.items():
            if entry.get("frames"):
                candidates.append((node, _normalize(sta_mac), ap_mac, entry))
    else:
        # A station: the frames are on each access point it handshook with.
        for ap_mac, entry in own.items():
            ap_node = by_mac.get(_normalize(ap_mac))
            for mymac in node.get("macs") or []:
                ap_entry = ((ap_node or {}).get("extra") or {}).get("handshakes", {}).get(_normalize(mymac))
                if ap_entry and ap_entry.get("frames"):
                    candidates.append((ap_node, _normalize(mymac), _normalize(ap_mac), ap_entry))
                    break

    if peer:
        candidates = [c for c in candidates if peer.lower() in (c[1], c[2])]
    if not candidates:
        return None
    ap_node, sta_mac, ap_mac, entry = candidates[0]
    ssids = ap_node.get("ssids") or []
    return {
        "ap_mac": ap_mac,
        "sta_mac": sta_mac,
        "essid": next((s for s in ssids if str(s).strip()), ""),
        "frames": {int(k): bytes.fromhex(v) for k, v in (entry.get("frames") or {}).items()},
        "beacon": bytes.fromhex(ap_node["extra"]["beacon"]) if (ap_node.get("extra") or {}).get("beacon") else None,
    }


def build_pcap(hs: dict[str, Any]) -> bytes:
    """A pcap (link type 802.11) of the beacon and handshake frames, in order."""
    frames = ([hs["beacon"]] if hs.get("beacon") else []) + [hs["frames"][m] for m in sorted(hs["frames"])]
    out = bytearray(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, DLT_IEEE802_11))
    ts = int(time.time())
    for i, frame in enumerate(frames):
        out += struct.pack("<IIII", ts, i, len(frame), len(frame)) + frame
    return bytes(out)


def _eapol_bytes(frame: bytes) -> bytes | None:
    """The 802.1X (EAPOL) portion of an 802.11 data frame: after the header and LLC/SNAP."""
    if len(frame) < 24:
        return None
    fc1 = frame[1]
    ds = fc1 & 3
    header = 30 if ds == 3 else 24
    if fc1 & 0x80:  # QoS data: a 2-byte QoS control field follows the addresses
        header += 2
    body = frame[header:]
    # LLC/SNAP for EAPOL: AA AA 03 00 00 00 88 8E
    if body[:8] == b"\xaa\xaa\x03\x00\x00\x00\x88\x8e":
        return body[8:]
    return None


def build_hc22000(hs: dict[str, Any]) -> str:
    """The hashcat 22000 (WPA*02) line, from message 2 plus message 1 or 3."""
    parsed: dict[int, bytes] = {}
    for msg, frame in hs["frames"].items():
        eapol = _eapol_bytes(frame)
        if eapol and len(eapol) >= 95 + 4:
            parsed[msg] = eapol
    if 2 not in parsed or not (1 in parsed or 3 in parsed):
        raise ValueError("Not enough of the handshake was captured for hashcat (need message 2, and 1 or 3).")
    mic_msg, anonce_msg, pair = (2, 1, 0x00) if 1 in parsed else (2, 3, 0x02)
    mic_eapol = parsed[mic_msg]
    body = mic_eapol[4:]  # after the 4-byte EAPOL header
    mic = body[77:93]
    anonce = parsed[anonce_msg][4:][13:45]
    zeroed = mic_eapol[:4 + 77] + b"\x00" * 16 + mic_eapol[4 + 93:]
    fields = [
        "WPA", "02",
        mic.hex(),
        hs["ap_mac"].replace(":", ""),
        hs["sta_mac"].replace(":", ""),
        (hs.get("essid") or "").encode().hex(),
        anonce.hex(),
        zeroed.hex(),
        f"{pair:02x}",
    ]
    return "*".join(fields) + "\n"
