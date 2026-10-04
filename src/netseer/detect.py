from __future__ import annotations

import json

PCAP_MAGICS = {
    b"\xd4\xc3\xb2\xa1",
    b"\xa1\xb2\xc3\xd4",
    b"\x4d\x3c\xb2\xa1",
    b"\xa1\xb2\x3c\x4d",
}
PCAPNG_MAGIC = b"\x0a\x0d\x0d\x0a"


class UnsupportedSurveyError(ValueError):
    """Raised when a file is not a supported survey format."""


class EmptySurveyError(ValueError):
    """Raised when a file parses but contains no usable survey data."""


def sniff_format(data: bytes, filename: str = "") -> str:
    name = filename.lower()
    head = data[:512].lstrip(b"\xef\xbb\xbf")
    if not data:
        raise UnsupportedSurveyError("The file is empty.")
    if head[:4] in PCAP_MAGICS:
        return "pcap"
    if head[:4] == PCAPNG_MAGIC:
        return "pcapng"
    text_prefix = head[:400].decode("utf-8", errors="replace")
    lowered = text_prefix.lower()
    stripped = data.lstrip()
    if stripped[:1] in (b"{", b"[") or name.endswith(".json"):
        try:
            obj = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            obj = None
        if isinstance(obj, dict) and (
            obj.get("netseer") or ("nodes" in obj and "links" in obj)
        ):
            return "netseer-json"
    if "<detection-run" in lowered or "<wireless-network" in lowered or "kismet-3." in lowered:
        return "kismet-netxml"
    if "bssid" in lowered and ("station mac" in lowered or "probed essids" in lowered or "# iv" in lowered):
        return "airodump-csv"
    if "bssid" in lowered and ("essid" in lowered or "nettype" in lowered or "gpsbestlat" in lowered):
        return "kismet-csv"
    if name.endswith((".pcap", ".cap")):
        return "pcap"
    if name.endswith(".pcapng"):
        return "pcapng"
    if name.endswith(".netxml"):
        return "kismet-netxml"
    if name.endswith(".csv") and "bssid" in lowered:
        return "airodump-csv" if "station mac" in lowered else "kismet-csv"
    raise UnsupportedSurveyError(
        "Unsupported survey format. Use Wireshark/tshark .pcap/.pcapng, tcpdump .pcap, "
        "Kismet .pcap/.netxml/.csv, airodump-ng CSV/.cap, or a NetSeer Unwanted/*.json dump."
    )
