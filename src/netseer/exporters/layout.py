"""Diagram coordinates for exports. All positions are shape centers."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Callable

from netseer.models import Node, SurveyGraph

MARGIN = 80.0
CELL_W = 170.0
CELL_H = 110.0
MAX_PER_ROW = 8
CONTAINER_PAD = 26.0
CONTAINER_HEADER = 26.0

Box = tuple[float, float, float, float]  # left, top, width, height


def node_size(node: Node) -> tuple[float, float]:
    """Shape size shared by every exporter so containers fit their members."""
    w, h = (140.0, 56.0) if node.kind == "ap" else (130.0, 48.0)
    if getattr(node, "caption", ""):
        h += 14.0
    return w, h


def _valid_point(value: Any) -> tuple[float, float] | None:
    if isinstance(value, dict):
        value = (value.get("x"), value.get("y"))
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        x, y = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return x, y


def _fallback(nodes: list[Node], graph: SurveyGraph, top: float) -> dict[str, tuple[float, float]]:
    """Tiered grid that wraps, with wireless clients listed right after their access point."""
    ap_of: dict[str, str] = {}
    ids = {n.id for n in nodes}
    by_id = {n.id: n for n in graph.nodes}
    for link in graph.links:
        if link.kind != "wireless":
            continue
        for ap, sta in ((link.source, link.target), (link.target, link.source)):
            if by_id.get(ap) is not None and by_id[ap].kind == "ap" and sta in ids:
                ap_of.setdefault(sta, ap)

    tiers: dict[int, list[Node]] = defaultdict(list)
    for node in nodes:
        if node.kind == "subnet":
            tier = 0
        elif node.kind == "ap":
            tier = 1
        elif node.medium == "wireless":
            tier = 2
        elif node.kind == "vlan":
            tier = 4
        else:
            tier = 3
        tiers[tier].append(node)
    ap_order = {n.id: i for i, n in enumerate(tiers.get(1, []))}
    tiers[2].sort(key=lambda n: (ap_order.get(ap_of.get(n.id, ""), len(ap_order)), n.id))

    positions: dict[str, tuple[float, float]] = {}
    y = top
    for tier in sorted(tiers):
        row = tiers[tier]
        for i, node in enumerate(row):
            col, line = i % MAX_PER_ROW, i // MAX_PER_ROW
            positions[node.id] = (MARGIN + CELL_W / 2 + col * CELL_W, y + line * CELL_H)
        y += math.ceil(len(row) / MAX_PER_ROW) * CELL_H + CELL_H * 0.5
    return positions


def layout_positions(
    graph: SurveyGraph,
    positions: dict[str, Any] | None = None,
) -> dict[str, tuple[float, float]]:
    """Use the map's on-screen positions when given (shifted into the page), else a wrapped grid."""
    given: dict[str, tuple[float, float]] = {}
    for node in graph.nodes:
        point = _valid_point((positions or {}).get(node.id))
        if point is not None:
            given[node.id] = point
    out: dict[str, tuple[float, float]] = {}
    top = MARGIN + CELL_H / 2
    if given:
        placed = [(given[n.id], node_size(n)) for n in graph.nodes if n.id in given]
        dx = MARGIN - min(x - w / 2 for (x, _), (w, _) in placed)
        dy = MARGIN - min(y - h / 2 for (_, y), (_, h) in placed)
        out = {nid: (x + dx, y + dy) for nid, (x, y) in given.items()}
        top = max(y for _, y in out.values()) + CELL_H * 1.5
    missing = [n for n in graph.nodes if n.id not in out]
    if missing:
        out.update(_fallback(missing, graph, top))
    return out


def clean_parents(graph: SurveyGraph, parents: dict[str, Any] | None) -> dict[str, str]:
    """child -> container id, only for real children of real subnet nodes."""
    kinds = {n.id: n.kind for n in graph.nodes}
    out: dict[str, str] = {}
    for child, parent in (parents or {}).items():
        if isinstance(child, str) and isinstance(parent, str) and child in kinds and kinds.get(parent) == "subnet" and child != parent:
            out[child] = parent
    return out


def container_boxes(
    graph: SurveyGraph,
    positions: dict[str, tuple[float, float]],
    parents: dict[str, str],
    size: Callable[[Node], tuple[float, float]] = node_size,
) -> dict[str, Box]:
    by_id = {n.id: n for n in graph.nodes}
    members: dict[str, list[str]] = defaultdict(list)
    for child, parent in parents.items():
        members[parent].append(child)
    boxes: dict[str, Box] = {}
    for parent, kids in members.items():
        lefts, tops, rights, bottoms = [], [], [], []
        for kid in kids:
            x, y = positions[kid]
            w, h = size(by_id[kid])
            lefts.append(x - w / 2)
            tops.append(y - h / 2)
            rights.append(x + w / 2)
            bottoms.append(y + h / 2)
        left = min(lefts) - CONTAINER_PAD
        top = min(tops) - CONTAINER_PAD - CONTAINER_HEADER
        boxes[parent] = (left, top, max(rights) + CONTAINER_PAD - left, max(bottoms) + CONTAINER_PAD - top)
    return boxes


def covered_by_container(link: Any, parents: dict[str, str]) -> bool:
    """Subnet-membership links are redundant once the device sits inside its subnet box."""
    return link.kind == "subnet" and (parents.get(link.source) == link.target or parents.get(link.target) == link.source)


def page_extent(
    graph: SurveyGraph,
    positions: dict[str, tuple[float, float]],
    boxes: dict[str, Box],
    size: Callable[[Node], tuple[float, float]] = node_size,
) -> tuple[float, float]:
    right = bottom = 0.0
    for node in graph.nodes:
        if node.id in boxes:
            left, top, w, h = boxes[node.id]
            right, bottom = max(right, left + w), max(bottom, top + h)
            continue
        x, y = positions[node.id]
        w, h = size(node)
        right, bottom = max(right, x + w / 2), max(bottom, y + h / 2)
    return right + MARGIN, bottom + MARGIN
