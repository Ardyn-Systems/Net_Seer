from __future__ import annotations

from dataclasses import fields
from typing import Any

from netseer.models import GpsFix, Link, Node, SurveyGraph


def graph_from_dict(data: dict[str, Any]) -> SurveyGraph:
    node_fields = {f.name for f in fields(Node)}
    link_fields = {f.name for f in fields(Link)}
    nodes: list[Node] = []
    for raw in data.get("nodes") or []:
        item = {k: v for k, v in raw.items() if k in node_fields}
        gps = item.get("gps")
        if isinstance(gps, dict) and "lat" in gps and "lon" in gps:
            item["gps"] = GpsFix(
                lat=float(gps["lat"]),
                lon=float(gps["lon"]),
                alt=gps.get("alt"),
            )
        elif gps in (None, "", []):
            item["gps"] = None
        nodes.append(Node(**item))
    links: list[Link] = []
    for raw in data.get("links") or []:
        item = {k: v for k, v in raw.items() if k in link_fields}
        links.append(Link(**item))
    return SurveyGraph(nodes=nodes, links=links, meta=data.get("meta") or {})
