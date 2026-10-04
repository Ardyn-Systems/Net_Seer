from __future__ import annotations

import math
from collections import defaultdict

from netseer.models import SurveyGraph


def layout_positions(graph: SurveyGraph, width: float = 1400, height: float = 900) -> dict[str, tuple[float, float]]:
    """Deterministic layered layout for diagram exports."""
    groups: dict[str, list[str]] = defaultdict(list)
    for node in graph.nodes:
        groups[node.kind].append(node.id)

    positions: dict[str, tuple[float, float]] = {}
    aps = groups.get("ap", [])
    stations = groups.get("host", []) + groups.get("server", []) + groups.get("gateway", [])
    wireless_stations = [n.id for n in graph.nodes if n.kind in {"host", "server", "gateway"} and n.medium == "wireless"]
    wired = [n.id for n in graph.nodes if n.kind in {"host", "server", "gateway"} and n.medium != "wireless"]
    subnets = groups.get("subnet", [])
    vlans = groups.get("vlan", [])

    def place_row(ids: list[str], y: float, x0: float, x1: float) -> None:
        if not ids:
            return
        span = x1 - x0
        for i, nid in enumerate(ids):
            x = x0 + (span * (i + 1) / (len(ids) + 1))
            positions[nid] = (x, y)

    place_row(subnets, 80, 80, width - 80)
    place_row(aps, 220, 80, width - 80)
    place_row(wireless_stations, 400, 80, width - 80)
    place_row(wired, 620, 80, width - 80)
    place_row(vlans, 800, 80, width - 80)

    # Stations orbit their AP when a wireless link exists
    ap_set = set(aps)
    ap_children: dict[str, dict[str, None]] = defaultdict(dict)
    for link in graph.links:
        if link.kind == "wireless":
            ap = link.target if link.target in ap_set else link.source if link.source in ap_set else None
            sta = link.source if link.source != ap else link.target
            if ap and sta:
                ap_children[ap][sta] = None
    for ap, children in ap_children.items():
        ax, ay = positions.get(ap, (width / 2, 220))
        # Spread over distinct stations; duplicates used to leave gaps in the ring.
        for i, sta in enumerate(children):
            angle = (2 * math.pi * i / max(len(children), 1)) - math.pi / 2
            positions[sta] = (ax + 140 * math.cos(angle), ay + 110 * math.sin(angle) + 130)

    for node in graph.nodes:
        if node.id not in positions:
            positions[node.id] = (width / 2, height / 2)
    return positions
