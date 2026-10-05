from __future__ import annotations

import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import Any

from netseer.exporters.layout import (
    clean_parents,
    container_boxes,
    covered_by_container,
    layout_positions,
    node_size,
    page_extent,
)
from netseer.exporters.xmlutil import manual_caption, manual_info, xml_text
from netseer.graph import device_map_label
from netseer.models import Link, Node, SurveyGraph

DPI = 96.0


def _shape_color(kind: str, medium: str) -> tuple[str, str]:
    if kind == "ap" or medium == "wireless":
        return "#FBBF24", "#422006"
    if kind == "gateway":
        return "#C4B5FD", "#2E1065"
    if kind == "server":
        return "#38BDF8", "#082F49"
    if kind == "vlan":
        return "#A78BFA", "#1E1B4B"
    if kind == "subnet":
        return "#9CA3AF", "#111827"
    return "#5EEAD4", "#042F2E"


def _link_color(kind: str, medium: str) -> str:
    if kind == "bridge":
        return "#F472B6"
    if kind == "wireless" or medium == "wireless":
        return "#FBBF24"
    if kind == "l2":
        return "#5EEAD4"
    if kind == "client-server":
        return "#38BDF8"
    if kind == "vlan":
        return "#C4B5FD"
    return "#86EFAC"


def _link_caption(link) -> str:
    return manual_caption(link, _plain_link_caption(link))


def _plain_link_caption(link) -> str:
    if getattr(link, "kind", "") == "bridge":
        mechanism = (getattr(link, "extra", None) or {}).get("bridge_kind")
        tag = {"wds": "WDS", "stp": "STP bridge", "spanning-host": "Attachment"}.get(
            str(mechanism or ""), link.label or "Attachment"
        )
        return tag
    displays = []
    for item in getattr(link, "ports", None) or []:
        text = item.get("display")
        if text and text not in displays:
            displays.append(str(text))
    if displays:
        return ", ".join(displays[:4])
    if getattr(link, "services", None):
        return ", ".join(str(s) for s in link.services[:4])
    return link.label or ("" if manual_info(link) is not None else link.kind)


@dataclass
class _Shape:
    sid: int
    node: Node
    pin_x: float
    pin_y: float
    width: float
    height: float
    container: bool


@dataclass
class _Edge:
    sid: int
    link: Link
    begin: tuple[float, float]
    end: tuple[float, float]


@dataclass
class _Page:
    width: float
    height: float
    shapes: list[_Shape]
    edges: list[_Edge]


def _page(graph: SurveyGraph, positions: dict[str, Any] | None, parents: dict[str, Any] | None) -> _Page:
    """Geometry in inches with Visio's bottom-left origin; containers come first so they sit behind."""
    placed = layout_positions(graph, positions)
    containment = clean_parents(graph, parents)
    boxes = container_boxes(graph, placed, containment)
    page_w, page_h = page_extent(graph, placed, boxes)
    ordered = [n for n in graph.nodes if n.id in boxes] + [n for n in graph.nodes if n.id not in boxes]
    ids = {node.id: i + 1 for i, node in enumerate(ordered)}
    centers: dict[str, tuple[float, float]] = {}
    shapes: list[_Shape] = []
    for node in ordered:
        if node.id in boxes:
            left, top, w, h = boxes[node.id]
            cx, cy = left + w / 2, top + h / 2
        else:
            cx, cy = placed[node.id]
            w, h = node_size(node)
        centers[node.id] = (cx / DPI, (page_h - cy) / DPI)
        shapes.append(_Shape(ids[node.id], node, *centers[node.id], w / DPI, h / DPI, node.id in boxes))
    edges: list[_Edge] = []
    next_id = len(ordered) + 1
    for link in graph.links:
        if link.source not in ids or link.target not in ids or covered_by_container(link, containment):
            continue
        edges.append(_Edge(next_id, link, centers[link.source], centers[link.target]))
        next_id += 1
    return _Page(page_w / DPI, page_h / DPI, shapes, edges)


def _ids(page: _Page) -> dict[str, int]:
    return {s.node.id: s.sid for s in page.shapes}


def export_vdx(
    graph: SurveyGraph,
    title: str = "NetSeer map",
    positions: dict[str, Any] | None = None,
    parents: dict[str, Any] | None = None,
) -> str:
    """Visio 2003 XML (.vdx), openable in Visio and many converters."""
    page = _page(graph, positions, parents)
    ids = _ids(page)
    shapes: list[str] = []
    connects: list[str] = []
    for s in page.shapes:
        line, fill = _shape_color(s.node.kind, s.node.medium)
        fill_xml = (
            "<FillPattern>0</FillPattern>"
            if s.container
            else f"<FillForegnd>{fill}</FillForegnd>\n        <FillBkgnd>{fill}</FillBkgnd>\n        <FillPattern>1</FillPattern>"
        )
        shapes.append(
            f'''    <Shape ID="{s.sid}" Type="Shape" LineStyle="1" FillStyle="1" TextStyle="1">
      <XForm>
        <PinX Unit="IN">{s.pin_x:.3f}</PinX>
        <PinY Unit="IN">{s.pin_y:.3f}</PinY>
        <Width Unit="IN">{s.width:.3f}</Width>
        <Height Unit="IN">{s.height:.3f}</Height>
        <LocPinX Unit="IN" F="Width*0.5">{s.width / 2:.3f}</LocPinX>
        <LocPinY Unit="IN" F="Height*0.5">{s.height / 2:.3f}</LocPinY>
      </XForm>
      <Fill>
        {fill_xml}
      </Fill>
      <Line>
        <LineWeight>0.01</LineWeight>
        <LineColor>{line}</LineColor>
        <LinePattern>{2 if s.container else 1}</LinePattern>
      </Line>
      <TextBlock><VerticalAlign>{0 if s.container else 1}</VerticalAlign></TextBlock>
      <Text><cp IX="0"/>{xml_text(device_map_label(s.node))}</Text>
    </Shape>'''
        )
    for e in page.edges:
        link = e.link
        color = _link_color(link.kind, link.medium)
        dashed = "4" if manual_info(link) is not None else "2" if link.kind in {"wireless", "l3", "vlan", "bridge", "subnet"} else "1"
        weight = "0.018" if link.kind == "bridge" else "0.012"
        shapes.append(
            f'''    <Shape ID="{e.sid}" Type="Shape" LineStyle="1">
      <XForm1D>
        <BeginX Unit="IN">{e.begin[0]:.3f}</BeginX>
        <BeginY Unit="IN">{e.begin[1]:.3f}</BeginY>
        <EndX Unit="IN">{e.end[0]:.3f}</EndX>
        <EndY Unit="IN">{e.end[1]:.3f}</EndY>
      </XForm1D>
      <Line>
        <LineWeight>{weight}</LineWeight>
        <LineColor>{color}</LineColor>
        <LinePattern>{dashed}</LinePattern>
      </Line>
      <Text>{xml_text(_link_caption(link))}</Text>
    </Shape>'''
        )
        connects.append(f'    <Connect FromSheet="{e.sid}" FromCell="BeginX" ToSheet="{ids[link.source]}" ToCell="PinX"/>')
        connects.append(f'    <Connect FromSheet="{e.sid}" FromCell="EndX" ToSheet="{ids[link.target]}" ToCell="PinX"/>')
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<VisioDocument xmlns="urn:schemas-microsoft-com:office:visio" xmlns:v="urn:schemas-microsoft-com:vml">
  <DocumentProperties>
    <Title>{xml_text(title)}</Title>
    <Creator>NetSeer</Creator>
  </DocumentProperties>
  <Pages>
    <Page ID="0" Name="NetSeer">
      <PageSheet>
        <PageProps>
          <PageWidth Unit="IN">{page.width:.3f}</PageWidth>
          <PageHeight Unit="IN">{page.height:.3f}</PageHeight>
        </PageProps>
      </PageSheet>
      <Shapes>
{chr(10).join(shapes)}
      </Shapes>
      <Connects>
{chr(10).join(connects)}
      </Connects>
    </Page>
  </Pages>
</VisioDocument>
'''


def export_vsdx(
    graph: SurveyGraph,
    title: str = "NetSeer map",
    positions: dict[str, Any] | None = None,
    parents: dict[str, Any] | None = None,
) -> bytes:
    """Office Open XML Visio drawing (.vsdx)."""
    page = _page(graph, positions, parents)
    ids = _ids(page)
    shapes_xml: list[str] = []
    connects_xml: list[str] = []
    for s in page.shapes:
        line, fill = _shape_color(s.node.kind, s.node.medium)
        shapes_xml.append(
            f'''<Shape ID="{s.sid}" NameU="{'Container' if s.container else 'Box'}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
  <Cell N="PinX" V="{s.pin_x:.4f}"/>
  <Cell N="PinY" V="{s.pin_y:.4f}"/>
  <Cell N="Width" V="{s.width:.4f}"/>
  <Cell N="Height" V="{s.height:.4f}"/>
  <Cell N="LocPinX" V="{s.width / 2:.4f}"/>
  <Cell N="LocPinY" V="{s.height / 2:.4f}"/>
  <Cell N="FillForegnd" V="{fill}"/>
  <Cell N="FillPattern" V="{0 if s.container else 1}"/>
  <Cell N="LineColor" V="{line}"/>
  <Cell N="LinePattern" V="{2 if s.container else 1}"/>
  <Cell N="LineWeight" V="0.01"/>
  <Cell N="VerticalAlign" V="{0 if s.container else 1}"/>
  <Section N="Geometry" IX="0">
    <Cell N="NoFill" V="{1 if s.container else 0}"/>
    <Cell N="NoLine" V="0"/>
    <Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
    <Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>
    <Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>
    <Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>
    <Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
  </Section>
  <Text>{xml_text(device_map_label(s.node))}</Text>
</Shape>'''
        )
    for e in page.edges:
        link = e.link
        weight = "0.018" if link.kind == "bridge" else "0.012"
        shapes_xml.append(
            f'''<Shape ID="{e.sid}" NameU="Dynamic connector" Type="Shape" LineStyle="0" FillStyle="0">
  <Cell N="BeginX" V="{e.begin[0]:.4f}"/>
  <Cell N="BeginY" V="{e.begin[1]:.4f}"/>
  <Cell N="EndX" V="{e.end[0]:.4f}"/>
  <Cell N="EndY" V="{e.end[1]:.4f}"/>
  <Cell N="LineColor" V="{_link_color(link.kind, link.medium)}"/>
  <Cell N="LineWeight" V="{weight}"/>
  <Cell N="LinePattern" V="{4 if manual_info(link) is not None else 2 if link.kind in {"wireless", "l3", "vlan", "bridge", "subnet"} else 1}"/>
  <Cell N="EndArrow" V="0"/>
  <Text>{xml_text(_link_caption(link))}</Text>
</Shape>'''
        )
        connects_xml.append(
            f'<Connect FromSheet="{e.sid}" FromCell="BeginX" FromPart="9" ToSheet="{ids[link.source]}" ToCell="PinX" ToPart="3"/>'
        )
        connects_xml.append(
            f'<Connect FromSheet="{e.sid}" FromCell="EndX" FromPart="12" ToSheet="{ids[link.target]}" ToCell="PinX" ToPart="3"/>'
        )

    page1 = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main" xml:space="preserve">
  <Shapes>
    {''.join(shapes_xml)}
  </Shapes>
  <Connects>
    {''.join(connects_xml)}
  </Connects>
</PageContents>
'''
    pages = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Page ID="0" Name="Survey" NameU="Survey">
    <PageSheet>
      <Cell N="PageWidth" V="{page.width:.4f}"/>
      <Cell N="PageHeight" V="{page.height:.4f}"/>
    </PageSheet>
    <Rel r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  </Page>
</Pages>
'''
    document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <DocumentSheet>
    <Cell N="DocLockReplace" V="0"/>
  </DocumentSheet>
</VisioDocument>
'''
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
  <Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
'''
    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
'''
    doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
</Relationships>
'''
    pages_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>
</Relationships>
'''
    core = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>{xml_text(title)}</dc:title>
  <dc:creator>NetSeer</dc:creator>
</cp:coreProperties>
'''
    app = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>NetSeer</Application>
</Properties>
'''
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("visio/document.xml", document)
        zf.writestr("visio/_rels/document.xml.rels", doc_rels)
        zf.writestr("visio/pages/pages.xml", pages)
        zf.writestr("visio/pages/_rels/pages.xml.rels", pages_rels)
        zf.writestr("visio/pages/page1.xml", page1)
        zf.writestr("docProps/core.xml", core)
        zf.writestr("docProps/app.xml", app)
    return buf.getvalue()
