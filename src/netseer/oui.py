"""IEEE OUI / MA-M / MA-S / CID manufacturer lookup."""

from __future__ import annotations

import gzip
from functools import lru_cache
from importlib import resources
from pathlib import Path

UNKNOWN = "Unknown manufacturer (OUI not in IEEE registry)"
LOCALLY_ADMINISTERED = "Locally administered"
MULTICAST = "Multicast"

_TABLE: dict[int, dict[str, str]] | None = None
_PREFIX_LENGTHS = (9, 7, 6)


def _table_path() -> Path:
    packaged = Path(__file__).resolve().parent / "data" / "ieee-oui.tsv.gz"
    if packaged.exists():
        return packaged
    ref = resources.files("netseer").joinpath("data", "ieee-oui.tsv.gz")
    return Path(str(ref))


def _load_table() -> dict[int, dict[str, str]]:
    global _TABLE
    if _TABLE is not None:
        return _TABLE
    buckets: dict[int, dict[str, str]] = {6: {}, 7: {}, 9: {}}
    path = _table_path()
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line or line.startswith("#"):
                continue
            prefix, _, name = line.rstrip("\n").partition("\t")
            if prefix and name:
                buckets.setdefault(len(prefix), {})[prefix] = name
    _TABLE = buckets
    return buckets


def mac_hex(mac: str | None) -> str | None:
    if not mac:
        return None
    hexed = "".join(c for c in mac.lower() if c in "0123456789abcdef")
    return hexed if len(hexed) >= 6 else None


def is_multicast(mac: str | None) -> bool:
    hexed = mac_hex(mac)
    return bool(hexed) and int(hexed[0:2], 16) & 0x01


def is_locally_administered(mac: str | None) -> bool:
    hexed = mac_hex(mac)
    return bool(hexed) and int(hexed[0:2], 16) & 0x02


def format_oui_prefix(hexed: str, length: int) -> str:
    raw = hexed[:length].ljust(6, "0")
    pairs = [raw[i : i + 2] for i in range(0, min(len(raw), 12), 2)]
    return ":".join(pairs)


def lookup_oui(mac: str | None) -> dict[str, str]:
    """Return manufacturer, OUI prefix, and assignment class for a MAC."""
    return dict(_lookup_oui_cached(mac))


@lru_cache(maxsize=8192)
def _lookup_oui_cached(mac: str | None) -> dict[str, str]:
    # Callers get a copy via lookup_oui, so the cached dict is never mutated.
    hexed = mac_hex(mac)
    if not hexed:
        return {
            "manufacturer": UNKNOWN,
            "oui_prefix": "",
            "oui_assignment": "unknown",
        }
    if is_multicast(mac):
        return {
            "manufacturer": MULTICAST,
            "oui_prefix": format_oui_prefix(hexed, 6),
            "oui_assignment": "multicast",
        }
    if is_locally_administered(mac):
        return {
            "manufacturer": LOCALLY_ADMINISTERED,
            "oui_prefix": format_oui_prefix(hexed, 6),
            "oui_assignment": "locally-administered",
        }
    table = _load_table()
    for length in _PREFIX_LENGTHS:
        prefix = hexed[:length]
        name = table.get(length, {}).get(prefix)
        if name:
            assignment = {6: "MA-L/CID", 7: "MA-M", 9: "MA-S"}[length]
            return {
                "manufacturer": name,
                "oui_prefix": format_oui_prefix(hexed, length if length >= 6 else 6),
                "oui_assignment": assignment,
            }
    return {
        "manufacturer": UNKNOWN,
        "oui_prefix": format_oui_prefix(hexed, 6),
        "oui_assignment": "unregistered",
    }


def vendor_from_mac(mac: str | None) -> str:
    return _lookup_oui_cached(mac)["manufacturer"]


def manufacturers_for_macs(macs: list[str]) -> str:
    names: list[str] = []
    for mac in macs:
        name = vendor_from_mac(mac)
        if name not in names:
            names.append(name)
    return ", ".join(names)
