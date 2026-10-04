from __future__ import annotations

import zipfile
from io import BytesIO
from netseer.exporters.layout import layout_positions
from netseer.exporters.xmlutil import xml_text
from netseer.graph import device_map_label
from netseer.models import SurveyGraph


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
    return link.label or link.kind


def export_vdx(graph: SurveyGraph, title: str = "NetSeer map") -> str:
    """Visio 2003 XML (.vdx), openable in Visio and many converters."""
    positions = layout_positions(graph)
    shapes: list[str] = []
    connects: list[str] = []
    id_map = {node.id: i + 1 for i, node in enumerate(graph.nodes)}
    for node in graph.nodes:
        sid = id_map[node.id]
        x, y = positions[node.id]
        # Visio uses inches; map canvas pixels (~96 dpi)
        pin_x = max(x, 40) / 96.0
        pin_y = max(900 - y, 40) / 96.0
        line, fill = _shape_color(node.kind, node.medium)
        label = xml_text(device_map_label(node))
        shapes.append(
            f'''    <Shape ID="{sid}" Type="Shape" LineStyle="1" FillStyle="1" TextStyle="1">
      <XForm>
        <PinX Unit="IN">{pin_x:.3f}</PinX>
        <PinY Unit="IN">{pin_y:.3f}</PinY>
        <Width Unit="IN">1.70</Width>
        <Height Unit="IN">0.70</Height>
        <LocPinX Unit="IN" F="Width*0.5">0.85</LocPinX>
        <LocPinY Unit="IN" F="Height*0.5">0.35</LocPinY>
      </XForm>
      <Fill>
        <FillForegnd>{fill}</FillForegnd>
        <FillBkgnd>{fill}</FillBkgnd>
        <FillPattern>1</FillPattern>
      </Fill>
      <Line>
        <LineWeight>0.01</LineWeight>
        <LineColor>{line}</LineColor>
        <LinePattern>1</LinePattern>
      </Line>
      <Text><cp IX="0"/>{label}</Text>
    </Shape>'''
        )
    next_id = len(graph.nodes) + 1
    for link in graph.links:
        if link.source not in id_map or link.target not in id_map:
            continue
        sid = next_id
        next_id += 1
        sx, sy = positions[link.source]
        tx, ty = positions[link.target]
        color = _link_color(link.kind, link.medium)
        dashed = "2" if link.kind in {"wireless", "l3", "vlan", "bridge"} else "1"
        weight = "0.018" if link.kind == "bridge" else "0.012"
        shapes.append(
            f'''    <Shape ID="{sid}" Type="Shape" LineStyle="1">
      <XForm1D>
        <BeginX Unit="IN">{sx / 96.0:.3f}</BeginX>
        <BeginY Unit="IN">{(900 - sy) / 96.0:.3f}</BeginY>
        <EndX Unit="IN">{tx / 96.0:.3f}</EndX>
        <EndY Unit="IN">{(900 - ty) / 96.0:.3f}</EndY>
      </XForm1D>
      <Line>
        <LineWeight>{weight}</LineWeight>
        <LineColor>{color}</LineColor>
        <LinePattern>{dashed}</LinePattern>
      </Line>
      <Text>{xml_text(_link_caption(link))}</Text>
    </Shape>'''
        )
        connects.append(
            f'    <Connect FromSheet="{sid}" FromCell="BeginX" ToSheet="{id_map[link.source]}" ToCell="PinX"/>'
        )
        connects.append(
            f'    <Connect FromSheet="{sid}" FromCell="EndX" ToSheet="{id_map[link.target]}" ToCell="PinX"/>'
        )
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
          <PageWidth Unit="IN">16.667</PageWidth>
          <PageHeight Unit="IN">11.458</PageHeight>
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


def export_vsdx(graph: SurveyGraph, title: str = "NetSeer map") -> bytes:
    """Office Open XML Visio drawing (.vsdx)."""
    positions = layout_positions(graph)
    shapes_xml: list[str] = []
    connects_xml: list[str] = []
    id_map = {node.id: i + 1 for i, node in enumerate(graph.nodes)}
    for node in graph.nodes:
        sid = id_map[node.id]
        x, y = positions[node.id]
        pin_x = max(x, 40) / 96.0
        pin_y = max(900 - y, 40) / 96.0
        line, fill = _shape_color(node.kind, node.medium)
        fill_hex = fill.lstrip("#")
        line_hex = line.lstrip("#")
        text = xml_text(device_map_label(node))
        shapes_xml.append(
            f'''<Shape ID="{sid}" NameU="Box" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
  <Cell N="PinX" V="{pin_x:.4f}"/>
  <Cell N="PinY" V="{pin_y:.4f}"/>
  <Cell N="Width" V="1.7"/>
  <Cell N="Height" V="0.7"/>
  <Cell N="LocPinX" V="0.85"/>
  <Cell N="LocPinY" V="0.35"/>
  <Cell N="FillForegnd" V="#{fill_hex}"/>
  <Cell N="LineColor" V="#{line_hex}"/>
  <Cell N="LineWeight" V="0.01"/>
  <Section N="Geometry" IX="0">
    <Cell N="NoFill" V="0"/>
    <Cell N="NoLine" V="0"/>
    <Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
    <Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>
    <Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>
    <Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>
    <Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
  </Section>
  <Text>{text}</Text>
</Shape>'''
        )
    next_id = len(graph.nodes) + 1
    for link in graph.links:
        if link.source not in id_map or link.target not in id_map:
            continue
        sid = next_id
        next_id += 1
        sx, sy = positions[link.source]
        tx, ty = positions[link.target]
        color = _link_color(link.kind, link.medium).lstrip("#")
        weight = "0.018" if link.kind == "bridge" else "0.012"
        shapes_xml.append(
            f'''<Shape ID="{sid}" NameU="Dynamic connector" Type="Shape" LineStyle="0" FillStyle="0">
  <Cell N="BeginX" V="{sx / 96.0:.4f}"/>
  <Cell N="BeginY" V="{(900 - sy) / 96.0:.4f}"/>
  <Cell N="EndX" V="{tx / 96.0:.4f}"/>
  <Cell N="EndY" V="{(900 - ty) / 96.0:.4f}"/>
  <Cell N="LineColor" V="#{color}"/>
  <Cell N="LineWeight" V="{weight}"/>
  <Cell N="EndArrow" V="0"/>
  <Text>{xml_text(_link_caption(link))}</Text>
</Shape>'''
        )
        connects_xml.append(
            f'<Connect FromSheet="{sid}" FromCell="BeginX" FromPart="9" ToSheet="{id_map[link.source]}" ToCell="PinX" ToPart="3"/>'
        )
        connects_xml.append(
            f'<Connect FromSheet="{sid}" FromCell="EndX" FromPart="12" ToSheet="{id_map[link.target]}" ToCell="PinX" ToPart="3"/>'
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
    pages = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Page ID="0" Name="Survey" NameU="Survey">
    <PageSheet>
      <Cell N="PageWidth" V="16.6667"/>
      <Cell N="PageHeight" V="11.4583"/>
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
