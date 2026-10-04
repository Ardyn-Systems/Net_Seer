from __future__ import annotations

from typing import Any

from netseer.exporters.layout import (
    clean_parents,
    container_boxes,
    covered_by_container,
    layout_positions,
    node_size,
    page_extent,
)
from netseer.exporters.xmlutil import html_label, xml_attr
from netseer.graph import device_map_label
from netseer.models import SurveyGraph

KIND_STYLE = {
    "ap": "rounded=0;whiteSpace=wrap;html=1;shape=hexagon;fillColor=#422006;strokeColor=#FBBF24;fontColor=#FEF3C7;fontStyle=1;",
    "gateway": "rounded=1;whiteSpace=wrap;html=1;fillColor=#2E1065;strokeColor=#C4B5FD;fontColor=#F5F3FF;fontStyle=1;",
    "server": "rounded=1;whiteSpace=wrap;html=1;fillColor=#082F49;strokeColor=#38BDF8;fontColor=#E0F2FE;fontStyle=1;",
    "host": "rounded=1;whiteSpace=wrap;html=1;fillColor=#042F2E;strokeColor=#5EEAD4;fontColor=#CCFBF1;",
    "subnet": "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#111827;strokeColor=#9CA3AF;fontColor=#E5E7EB;",
    "vlan": "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#1E1B4B;strokeColor=#A78BFA;fontColor=#EDE9FE;",
}

EDGE_STYLE = {
    "l2": "endArrow=none;strokeColor=#5EEAD4;strokeWidth=2;",
    "l3": "endArrow=none;strokeColor=#86EFAC;strokeWidth=2;dashed=1;",
    "wireless": "endArrow=none;strokeColor=#FBBF24;strokeWidth=2;dashed=1;dashPattern=8 8;",
    "vlan": "endArrow=none;strokeColor=#C4B5FD;strokeWidth=1;dashed=1;",
    "subnet": "endArrow=none;strokeColor=#9CA3AF;strokeWidth=1;dashed=1;",
    "client-server": "endArrow=block;strokeColor=#38BDF8;strokeWidth=2;",
    "bridge": "endArrow=diamond;startArrow=diamond;strokeColor=#F472B6;strokeWidth=3;dashed=1;dashPattern=1 6;",
}


def _label(node) -> str:
    # Vertex styles use html=1, so the value is HTML inside an XML attribute.
    return xml_attr(html_label(device_map_label(node)))


CONTAINER_STYLE = (
    "rounded=1;arcSize=4;whiteSpace=wrap;html=1;dashed=1;container=1;collapsible=0;"
    "fillColor=#111827;fillOpacity=35;strokeColor=#9CA3AF;fontColor=#E5E7EB;fontStyle=1;"
    "verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;"
)


def export_drawio(
    graph: SurveyGraph,
    title: str = "NetSeer map",
    positions: dict[str, Any] | None = None,
    parents: dict[str, Any] | None = None,
) -> str:
    placed = layout_positions(graph, positions)
    containment = clean_parents(graph, parents)
    boxes = container_boxes(graph, placed, containment)
    page_w, page_h = page_extent(graph, placed, boxes)
    cells: list[str] = ['        <mxCell id="0"/>', '        <mxCell id="1" parent="0"/>']
    # Containers first so they sit behind their members.
    by_id = {n.id: n for n in graph.nodes}
    for parent_id, (left, top, w, h) in boxes.items():
        cells.append(
            f'        <mxCell id="{xml_attr(parent_id)}" value="{_label(by_id[parent_id])}" style="{CONTAINER_STYLE}" '
            f'vertex="1" parent="1"><mxGeometry x="{left:.1f}" y="{top:.1f}" width="{w:.1f}" height="{h:.1f}" as="geometry"/>'
            f"</mxCell>"
        )
    for node in graph.nodes:
        if node.id in boxes:
            continue
        cx, cy = placed[node.id]
        style = KIND_STYLE.get(node.kind, KIND_STYLE["host"])
        if node.medium == "wireless" and node.kind == "host":
            style = "rounded=1;whiteSpace=wrap;html=1;fillColor=#451A03;strokeColor=#FBBF24;fontColor=#FEF3C7;"
        w, h = node_size(node)
        x, y = cx - w / 2, cy - h / 2
        parent = containment.get(node.id)
        if parent in boxes:
            # Children of a container use coordinates relative to it.
            x -= boxes[parent][0]
            y -= boxes[parent][1]
        cells.append(
            f'        <mxCell id="{xml_attr(node.id)}" value="{_label(node)}" style="{style}" '
            f'vertex="1" parent="{xml_attr(parent if parent in boxes else "1")}">'
            f'<mxGeometry x="{x:.1f}" y="{y:.1f}" width="{w:.0f}" height="{h:.0f}" as="geometry"/>'
            f"</mxCell>"
        )
    for link in graph.links:
        if covered_by_container(link, containment):
            continue
        style = EDGE_STYLE.get(link.kind, EDGE_STYLE["l2"])
        if link.kind == "bridge":
            label = xml_attr(link.label or "Attachment")
        else:
            label = xml_attr(link.label or link.kind)
            if link.ports:
                displays = []
                for item in link.ports:
                    text = item.get("display")
                    if text and text not in displays:
                        displays.append(str(text))
                if displays:
                    label = xml_attr(", ".join(displays[:4]))
        cells.append(
            f'        <mxCell id="{xml_attr(link.id)}" value="{label}" style="{style}" edge="1" parent="1" '
            f'source="{xml_attr(link.source)}" target="{xml_attr(link.target)}">'
            f'<mxGeometry relative="1" as="geometry"/></mxCell>'
        )
    body = "\n".join(cells)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<mxfile host="NetSeer" modified="2026-09-20" agent="NetSeer" version="22.1.0">\n'
        f'  <diagram id="netseer" name="{xml_attr(title)}">\n'
        '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" '
        'connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        f'pageWidth="{max(1600, round(page_w))}" pageHeight="{max(1100, round(page_h))}" math="0" shadow="0">\n'
        "      <root>\n"
        f"{body}\n"
        "      </root>\n"
        "    </mxGraphModel>\n"
        "  </diagram>\n"
        "</mxfile>\n"
    )
