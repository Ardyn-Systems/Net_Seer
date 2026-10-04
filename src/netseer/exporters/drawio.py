from __future__ import annotations

from netseer.exporters.layout import layout_positions
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


def export_drawio(graph: SurveyGraph, title: str = "NetSeer map") -> str:
    positions = layout_positions(graph)
    cells: list[str] = ['        <mxCell id="0"/>', '        <mxCell id="1" parent="0"/>']
    for node in graph.nodes:
        x, y = positions[node.id]
        style = KIND_STYLE.get(node.kind, KIND_STYLE["host"])
        if node.medium == "wireless" and node.kind == "host":
            style = "rounded=1;whiteSpace=wrap;html=1;fillColor=#451A03;strokeColor=#FBBF24;fontColor=#FEF3C7;"
        w, h = (130, 48) if node.kind != "ap" else (140, 56)
        if getattr(node, "caption", ""):
            h += 14
        cells.append(
            f'        <mxCell id="{xml_attr(node.id)}" value="{_label(node)}" style="{style}" '
            f'vertex="1" parent="1"><mxGeometry x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" as="geometry"/>'
            f"</mxCell>"
        )
    for link in graph.links:
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
        'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1100" math="0" shadow="0">\n'
        "      <root>\n"
        f"{body}\n"
        "      </root>\n"
        "    </mxGraphModel>\n"
        "  </diagram>\n"
        "</mxfile>\n"
    )
