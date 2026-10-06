from __future__ import annotations

from importlib import resources
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"

SAMPLES: list[dict[str, Any]] = [
    {
        "id": "campus-all",
        "name": "Campus survey (combined)",
        "kind": "combined",
        "summary": "Office VLANs, Wi-Fi RF, Kismet GPS walk, and airodump stations in one map.",
        "files": [
            "office-lan.pcap",
            "wifi-campus.pcapng",
            "kismet-walk.netxml",
            "kismet-aps.csv",
            "airodump-ng.csv",
        ],
    },
    {
        "id": "office-lan",
        "name": "Office LAN (pcap)",
        "kind": "pcap",
        "summary": "802.1Q VLANs, DHCP, DNS, HTTP, SSH, TLS, NTP, and OSPF on 10.10.10.0/24 and 10.10.20.0/24.",
        "files": ["office-lan.pcap"],
    },
    {
        "id": "wifi-campus",
        "name": "Campus Wi-Fi (pcapng)",
        "kind": "pcapng",
        "summary": "RadioTap beacons, associations, and a station HTTP session over 802.11.",
        "files": ["wifi-campus.pcapng"],
    },
    {
        "id": "kismet-walk",
        "name": "Kismet walk (netxml)",
        "kind": "kismet-netxml",
        "summary": "SSIDs, BSSIDs, channels, encryption, signal, GPS, and associated clients.",
        "files": ["kismet-walk.netxml"],
    },
    {
        "id": "kismet-csv",
        "name": "Kismet AP export (csv)",
        "kind": "kismet-csv",
        "summary": "Classic Kismet CSV with GPS and encryption columns.",
        "files": ["kismet-aps.csv"],
    },
    {
        "id": "airodump",
        "name": "airodump-ng (csv)",
        "kind": "airodump-csv",
        "summary": "AP and station table with channels, privacy, and probed ESSIDs.",
        "files": ["airodump-ng.csv"],
    },
    {
        "id": "branch-baseline",
        "name": "Branch Wi-Fi: baseline (pcapng)",
        "kind": "pcapng",
        "summary": "A branch office's Wi-Fi. Compare it with the survey from a week later.",
        "files": ["branch-baseline.pcapng"],
    },
    {
        "id": "branch-later",
        "name": "Branch Wi-Fi: a week later (pcapng)",
        "kind": "pcapng",
        "summary": "The same branch a week on: devices joined, left, moved, and one rotated its MAC.",
        "files": ["branch-later.pcapng"],
    },
    {
        "id": "security-lab",
        "name": "Small office: security check (pcap)",
        "kind": "pcap",
        "summary": "Old servers, Telnet, an open and a WEP network: something for every Security finding.",
        "files": ["security-lab.pcap", "security-lab-wifi.pcapng"],
    },
    {
        "id": "empty-capture",
        "name": "Empty capture (pcap)",
        "kind": "pcap",
        "summary": "Valid pcap with no frames — used to show the empty-survey state.",
        "files": ["empty-capture.pcap"],
    },
]


def sample_path(filename: str) -> Path:
    path = DATA_DIR / filename
    if path.exists():
        return path
    try:
        ref = resources.files("netseer").joinpath("data", filename)
        return Path(str(ref))
    except Exception as exc:
        raise FileNotFoundError(filename) from exc


def files_for_sample(sample_id: str) -> list[tuple[str, bytes]]:
    rec = next((s for s in SAMPLES if s["id"] == sample_id), None)
    if rec is None:
        raise KeyError(sample_id)
    out: list[tuple[str, bytes]] = []
    for name in rec["files"]:
        path = sample_path(name)
        out.append((name, path.read_bytes()))
    return out
