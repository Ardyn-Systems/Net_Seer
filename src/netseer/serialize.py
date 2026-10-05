from __future__ import annotations

from dataclasses import MISSING, fields
from typing import Any

from netseer.detect import UnsupportedSurveyError
from netseer.models import GpsFix, Link, Node, SurveyGraph

_NODE_FIELDS = {f.name: f for f in fields(Node)}
_LINK_FIELDS = {f.name: f for f in fields(Link)}
_FLOAT_FIELDS = {"signal_dbm", "signal_min_dbm", "signal_max_dbm"}
_STR_OPTIONAL_FIELDS = {"vendor"}


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce(name: str, spec: Any, value: Any) -> Any:
    """Force JSON values into the dataclass field's shape so exports and the UI can trust them."""
    if name in _FLOAT_FIELDS:
        return _optional_float(value)
    if name in _STR_OPTIONAL_FIELDS:
        return None if value is None else str(value)
    if spec.default_factory is list:
        if not isinstance(value, list):
            return []
        if name in {"ports"}:
            return [item for item in value if isinstance(item, dict)]
        if name in {"channels", "vlans"}:
            out = []
            for item in value:
                try:
                    out.append(int(item))
                except (TypeError, ValueError):
                    continue
            return out
        if name == "frequencies_mhz":
            return [f for f in (_optional_float(item) for item in value) if f is not None]
        if name == "seen":  # [[start, end], ...] in Unix seconds
            pairs = []
            for item in value:
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    start, end = _optional_float(item[0]), _optional_float(item[1])
                    if start is not None and end is not None and end >= start:
                        pairs.append([start, end])
            return pairs
        return [str(item) for item in value if item is not None]
    if spec.default_factory is dict:
        return value if isinstance(value, dict) else {}
    if spec.type in ("str", str):
        return "" if value is None else str(value)
    return value


def _build(cls: type, spec_map: dict[str, Any], raw: Any, what: str, index: int) -> Any:
    if not isinstance(raw, dict):
        raise UnsupportedSurveyError(f"{what} {index} must be an object.")
    item: dict[str, Any] = {}
    for name, spec in spec_map.items():
        if name == "gps":
            continue
        if name in raw:
            item[name] = _coerce(name, spec, raw[name])
        elif spec.default is MISSING and spec.default_factory is MISSING:
            raise UnsupportedSurveyError(f"{what} {index} is missing required field '{name}'.")
    return cls(**item)


def _gps(value: Any) -> GpsFix | None:
    if not isinstance(value, dict):
        return None
    lat, lon = _optional_float(value.get("lat")), _optional_float(value.get("lon"))
    if lat is None or lon is None:
        return None
    return GpsFix(lat=lat, lon=lon, alt=_optional_float(value.get("alt")))


def graph_from_dict(data: dict[str, Any]) -> SurveyGraph:
    """Rebuild a graph from JSON. Raises UnsupportedSurveyError on malformed input."""
    if not isinstance(data, dict):
        raise UnsupportedSurveyError("Graph must be a JSON object.")
    raw_nodes = data.get("nodes") or []
    raw_links = data.get("links") or []
    if not isinstance(raw_nodes, list) or not isinstance(raw_links, list):
        raise UnsupportedSurveyError("Graph 'nodes' and 'links' must be lists.")
    nodes: list[Node] = []
    for i, raw in enumerate(raw_nodes):
        node = _build(Node, _NODE_FIELDS, raw, "Node", i)
        node.gps = _gps(raw.get("gps"))
        nodes.append(node)
    links = [_build(Link, _LINK_FIELDS, raw, "Link", i) for i, raw in enumerate(raw_links)]
    meta = data.get("meta")
    return SurveyGraph(nodes=nodes, links=links, meta=meta if isinstance(meta, dict) else {})
