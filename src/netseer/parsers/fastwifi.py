"""Fast path for big Wi-Fi captures.

Decoding every frame with scapy costs about half a millisecond, and long captures are
mostly repeats: an access point beacons ten times a second, and encrypted data between
the same pair of radios looks the same to NetSeer every time. So for 802.11 frames
whose payload NetSeer doesn't read (management, control, and encrypted or empty data),
work out a small signature from the raw bytes: frame type, addresses, channel, and the
information elements NetSeer uses (SSID, channel, RSN/WPA, HT). The first frame with a
signature goes through the full decoder while the builder records what it touched;
later frames with the same signature replay that (a frame counted on each link, and
their own signal strength) without decoding. The map comes out the same.
"""

from __future__ import annotations

import struct
import zlib
from typing import Any, Callable, Iterable

from netseer.graph import GraphBuilder

RADIOTAP = 127
RAW_80211 = 105
WIFI_LINKTYPES = {RADIOTAP, RAW_80211}
CACHE_LIMIT = 250_000  # signatures kept; a cleared cache only costs speed

# Management subtypes and the fixed fields before their information elements.
_MGMT_FIXED = {0: 4, 1: 6, 2: 10, 3: 6, 4: 0, 5: 12, 8: 12}
_WPA_OUI = b"\x00\x50\xf2\x01"


def radiotap(data: bytes) -> tuple[int, int, float | None, float | None] | None:
    """(header length, flags, frequency MHz, antenna signal dBm) from a radiotap header."""
    if len(data) < 8 or data[0] != 0:
        return None
    length = struct.unpack_from("<H", data, 2)[0]
    if length < 8 or length > len(data):
        return None
    present = struct.unpack_from("<I", data, 4)[0]
    offset = 8
    word = present
    while word & 0x80000000:  # extended presence bitmaps
        if offset + 4 > length:
            return None
        word = struct.unpack_from("<I", data, offset)[0]
        offset += 4
    flags = 0
    freq = signal = None
    # Fields 0-5 in bit order, each aligned to its natural size from the header start.
    for bit, size, align in ((0, 8, 8), (1, 1, 1), (2, 1, 1), (3, 4, 2), (4, 2, 1), (5, 1, 1)):
        if not present & (1 << bit):
            continue
        offset = (offset + align - 1) & ~(align - 1)
        if offset + size > length:
            return None
        if bit == 1:
            flags = data[offset]
        elif bit == 3:
            freq = float(struct.unpack_from("<H", data, offset)[0]) or None
        elif bit == 5:
            signal = float(struct.unpack_from("<b", data, offset)[0])
        offset += size
    return length, flags, freq, signal


def _elements(body: bytes) -> tuple:
    """The information elements NetSeer reads, in a hashable form."""
    ssid = channel = rsn = wpa = ht = None
    i = 0
    n = len(body)
    while i + 2 <= n:
        eid, elen = body[i], body[i + 1]
        value = body[i + 2 : i + 2 + elen]
        if eid == 0 and ssid is None:
            ssid = value
        elif eid == 3 and channel is None:
            channel = value
        elif eid == 48 and rsn is None:
            rsn = value
        elif eid == 61 and ht is None:
            ht = value[:1]
        elif eid == 221 and wpa is None and value.startswith(_WPA_OUI):
            wpa = value
        i += 2 + elen
    return ssid, channel, rsn, wpa, ht


def signature(frame: bytes, freq: float | None) -> tuple | None:
    """What NetSeer would learn from this 802.11 frame, or None to decode it in full."""
    if len(frame) < 10:
        return None
    fc0, fc1 = frame[0], frame[1]
    ftype = (fc0 >> 2) & 3
    subtype = fc0 >> 4
    ds = fc1 & 3
    protected = fc1 & 0x40
    if ftype == 1:  # control: just the addresses present
        return (1, subtype, frame[4:16], freq)
    if len(frame) < 24:
        return None
    addrs = frame[4:22]
    if ftype == 2:
        empty = subtype in (4, 12)  # null and QoS null carry nothing
        if not (protected or empty):
            return None  # may hold IP, ARP, DHCP, DNS: read it
        return (2, subtype, ds, protected, addrs, frame[24:30] if ds == 3 else b"", freq)
    if ftype != 0:
        return None
    body = frame[24:]
    fixed = _MGMT_FIXED.get(subtype)
    if fixed is None:  # auth, deauth, action...: rare, so key on the whole body
        return (0, subtype, ds, addrs, zlib.crc32(body), freq)
    cap = body[fixed - 2 : fixed] if subtype in (5, 8) else body[0:2] if subtype in (0, 2) else b""
    return (0, subtype, ds, addrs, cap, _elements(body[fixed:]), freq)


def feed_raw(
    builder: GraphBuilder,
    frames: Iterable[tuple[int, bytes, float | None]],
    filename: str,
    decode: Callable[[int, bytes], Any],
    handle: Callable[[GraphBuilder, Any], None],
    *,
    max_packets: int | None = None,
    progress: Callable[[int], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> None:
    """Run raw (link type, bytes, time) frames into the builder, decoding only what's new."""
    cache: dict[tuple, list] = {}
    try:
        _feed(builder, frames, filename, decode, handle, cache, max_packets, progress, should_stop)
    finally:
        builder.now = None  # later updates (finalizing, survey records) aren't packet sightings


def _feed(builder, frames, filename, decode, handle, cache, max_packets, progress, should_stop) -> None:
    seen = failed = 0
    for linktype, data, when in frames:
        builder.now = when
        if max_packets is not None and seen >= max_packets:
            builder.warnings.append(f"{filename}: stopped after {max_packets:,} packets.")
            break
        seen += 1
        builder.packet_count += 1
        if progress is not None and seen % 2000 == 0:
            progress(seen)
            if should_stop is not None and should_stop():
                builder.warnings.append(f"{filename}: you stopped reading after {seen:,} packets, so the map shows only that part.")
                break
        sig = None
        signal = None
        if linktype in WIFI_LINKTYPES:
            frame = data
            freq = None
            if linktype == RADIOTAP:
                rt = radiotap(data)
                if rt is not None:
                    length, flags, freq, signal = rt
                    frame = data[length:-4] if flags & 0x10 and len(data) - length > 4 else data[length:]
                else:
                    frame = b""
            if frame:
                sig = signature(frame, freq)
        if sig is not None:
            effects = cache.get(sig)
            if effects is not None:
                for what, key in effects:
                    if what == "link":
                        rec = builder.links.get(key)
                        if rec is not None:
                            rec["extra"]["count"] = int(rec["extra"].get("count") or 0) + 1
                            builder.touch(rec)
                    elif what == "dev":
                        rec = builder.devices.get(key)
                        if rec is not None:
                            builder.touch(rec)
                    elif signal is not None and key in builder.devices:
                        builder.observe_signal(key, signal)
                continue
        try:
            pkt = decode(linktype, data)
            if sig is None:
                handle(builder, pkt)
            else:
                recorded: list = []
                builder.recorder = recorded
                try:
                    handle(builder, pkt)
                finally:
                    builder.recorder = None
                if len(cache) >= CACHE_LIMIT:
                    cache.clear()
                cache[sig] = list(dict.fromkeys(recorded))  # each device or link once
        except Exception:
            failed += 1
    if progress is not None:
        progress(seen)
    if failed:
        builder.warnings.append(f"{filename}: skipped {failed:,} packets that could not be decoded.")
