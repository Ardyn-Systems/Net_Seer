from __future__ import annotations

from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any


def _to_dict(obj: Any) -> Any:
    if is_dataclass(obj):
        return {k: _to_dict(v) for k, v in asdict(obj).items()}
    if isinstance(obj, list):
        return [_to_dict(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    return obj


@dataclass
class GpsFix:
    lat: float
    lon: float
    alt: float | None = None


@dataclass
class Node:
    id: str
    kind: str
    label: str
    medium: str = "wired"
    macs: list[str] = field(default_factory=list)
    mac_tx: list[str] = field(default_factory=list)
    mac_rx: list[str] = field(default_factory=list)
    mac_da: list[str] = field(default_factory=list)
    mac_ra: list[str] = field(default_factory=list)
    ips: list[str] = field(default_factory=list)
    ssids: list[str] = field(default_factory=list)
    channels: list[int] = field(default_factory=list)
    frequencies_mhz: list[float] = field(default_factory=list)
    signal_dbm: float | None = None
    signal_min_dbm: float | None = None
    signal_max_dbm: float | None = None
    encryption: list[str] = field(default_factory=list)
    vlans: list[int] = field(default_factory=list)
    gps: GpsFix | None = None
    vendor: str | None = None
    roles: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    ports: list[dict[str, Any]] = field(default_factory=list)
    routing: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)
    inferred_type: str = "Host"
    caption: str = ""
    notes: str = ""


@dataclass
class Link:
    id: str
    source: str
    target: str
    kind: str
    label: str = ""
    medium: str = "wired"
    vlans: list[int] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    ports: list[dict[str, Any]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class SurveyGraph:
    nodes: list[Node] = field(default_factory=list)
    links: list[Link] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return _to_dict(self)
