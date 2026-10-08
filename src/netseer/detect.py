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


def netseer_payload(data: bytes, filename: str = "") -> dict | None:
    """Parsed NetSeer JSON dump, or None if `data` is not one."""
    if data.lstrip()[:1] not in (b"{", b"[") and not filename.lower().endswith(".json"):
        return None
    try:
        obj = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(obj, dict) and (obj.get("netseer") or ("nodes" in obj and "links" in obj)):
        return obj
    return None


def sniff_format(data: bytes, filename: str = "") -> str:
    name = filename.lower()
    if not data:
        raise UnsupportedSurveyError("The file is empty.")
    head = data[:512].removeprefix(b"\xef\xbb\xbf")
    if head[:4] in PCAP_MAGICS:
        return "pcap"
    if head[:4] == PCAPNG_MAGIC:
        return "pcapng"
    if head[:16] == b"SQLite format 3\x00":
        if name.endswith(".kismet") or not name:
            return "kismetdb"
        raise UnsupportedSurveyError("This is an SQLite database. NetSeer reads Kismet logs (.kismet); rename the file if it is one.")
    text_prefix = head[:400].decode("utf-8", errors="replace")
    lowered = text_prefix.lower()
    if netseer_payload(data, filename) is not None:
        return "netseer-json"
    if "<detection-run" in lowered or "<wireless-network" in lowered or "kismet-3." in lowered:
        return "kismet-netxml"
    if lowered.lstrip().startswith("wiglewifi-"):
        return "wigle-csv"
    if "network survey" in lowered or ("bssid" in lowered and "frequencymhz" in lowered and "signalstrength" in lowered):
        return "craxiom-csv"
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
        "Kismet .kismet/.pcap/.netxml/.csv, airodump-ng CSV/.cap, WiGLE (WigleWifi) CSV, "
        "Craxiom Network Survey CSV, or a NetSeer Unwanted/*.json dump."
    )
