from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime
from typing import Any
from xml.sax.saxutils import escape

from netseer.exporters.xmlutil import clean, manual_info, xml_attr, xml_text

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Image as RLImage,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from netseer.brand import DEFAULT_REPORT_TITLE, MOTTO, PRODUCT_NAME, pdf_logo_path
from netseer.models import Link, Node, SurveyGraph

FIELD_ORDER = [
    ("id", "ID"),
    ("label", "Map name"),
    ("inferred_type", "Inferred type"),
    ("caption", "On-map extra"),
    ("kind", "Kind"),
    ("medium", "Medium"),
    ("roles", "Roles (server/client)"),
    ("vendor", "OUI manufacturer"),
    ("mac_tx", "TX MAC"),
    ("mac_rx", "RX MAC"),
    ("mac_da", "DA MAC"),
    ("mac_ra", "RA MAC"),
    ("macs", "MAC addresses"),
    ("ips", "IP addresses"),
    ("vlans", "VLANs"),
    ("ssids", "SSIDs"),
    ("channels", "Wireless channels"),
    ("frequencies_mhz", "RF frequency (MHz)"),
    ("encryption", "Encryption"),
    ("signal_dbm", "Signal (dBm)"),
    ("signal_min_dbm", "Signal min (dBm)"),
    ("signal_max_dbm", "Signal max (dBm)"),
    ("services", "Services"),
    ("ports", "Ports"),
    ("gps", "GPS"),
    ("routing", "Routing"),
    ("extra", "Other extracted data"),
    ("notes", "Notes"),
]


def _stringify(value: Any) -> str:
    if value is None or value == "" or value == [] or value == {}:
        return ""
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, list):
        if value and isinstance(value[0], dict):
            parts = []
            for item in value:
                if item.get("display"):
                    extra = []
                    if item.get("role"):
                        extra.append(str(item["role"]))
                    if item.get("sport") is not None and item.get("dport") is not None:
                        extra.append(f"src {item['sport']} → dst {item['dport']}")
                    text = str(item["display"])
                    if extra:
                        text += f" ({', '.join(extra)})"
                    parts.append(text)
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            return "; ".join(parts)
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        if {"lat", "lon"} <= set(value.keys()):
            lat, lon = value["lat"], value["lon"]
            alt = value.get("alt")
            text = f"{lat}, {lon}"
            if alt is not None:
                text += f", alt {alt}"
            return text
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)


def related_links(graph: SurveyGraph, node_id: str) -> list[Link]:
    return [link for link in graph.links if link.source == node_id or link.target == node_id]


def links_by_node(graph: SurveyGraph) -> dict[str, list[Link]]:
    """Adjacency index so whole-map reports don't rescan every link per device."""
    index: dict[str, list[Link]] = {}
    for link in graph.links:
        index.setdefault(link.source, []).append(link)
        if link.target != link.source:
            index.setdefault(link.target, []).append(link)
    return index


def device_properties(
    graph: SurveyGraph, node: Node, links_index: dict[str, list[Link]] | None = None
) -> list[dict[str, str]]:
    """Every extracted field for a device, including empty ones, plus related links."""
    if is_dataclass(node) and not isinstance(node, type):
        raw = asdict(node)
    elif hasattr(node, "__dict__"):
        raw = dict(node.__dict__)
    else:
        raw = dict(node)
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    has_mac_roles = any(raw.get(k) for k in ("mac_tx", "mac_rx", "mac_da", "mac_ra"))
    for key, title in FIELD_ORDER:
        seen.add(key)
        value = raw.get(key)
        if key == "macs" and has_mac_roles:
            continue
        if key in {"notes", "caption"} and not _stringify(value):
            continue
        if key in {"mac_tx", "mac_rx", "mac_da", "mac_ra"}:
            rows.append({"name": title, "key": key, "value": _stringify(value) or "not present"})
            continue
        if key in {"routing", "extra"} and isinstance(value, dict) and value:
            rows.append({"name": title, "key": key, "value": _stringify(value)})
            for nested_key, nested_val in value.items():
                rows.append(
                    {
                        "name": f"{title} · {nested_key}",
                        "key": f"{key}.{nested_key}",
                        "value": _stringify(nested_val),
                    }
                )
            continue
        rows.append({"name": title, "key": key, "value": _stringify(value)})
    for key, value in raw.items():
        if key in seen:
            continue
        rows.append({"name": key.replace("_", " ").title(), "key": key, "value": _stringify(value)})
    links = links_index.get(node.id, []) if links_index is not None else related_links(graph, node.id)
    for i, link in enumerate(links, start=1):
        bits = [
            link.kind,
            link.label,
            f"{link.source} → {link.target}",
            _stringify(link.services),
            _stringify(link.ports),
        ]
        rows.append(
            {
                "name": f"Link {i}",
                "key": f"link.{i}",
                "value": " | ".join(b for b in bits if b),
            }
        )
    return rows


def device_plain_text(graph: SurveyGraph, node: Node) -> str:
    lines = [f"{PRODUCT_NAME} device: {node.label}", ""]
    for row in device_properties(graph, node):
        value = row["value"] or "—"
        lines.append(f"{row['name']}: {value}")
    return "\n".join(lines) + "\n"


def device_csv(graph: SurveyGraph, node: Node) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Field", "Value"])
    for row in device_properties(graph, node):
        writer.writerow([row["name"], row["value"]])
    return buf.getvalue()


def device_xml(graph: SurveyGraph, node: Node) -> str:
    props = "\n".join(
        f'    <property key="{xml_attr(row["key"])}" name="{xml_attr(row["name"])}">'
        f"{xml_text(row['value'])}</property>"
        for row in device_properties(graph, node)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<device id="{xml_attr(node.id)}" label="{xml_attr(node.label)}">\n'
        f"{props}\n"
        "</device>\n"
    )


# ---------------------------------------------------------------------------
# PDF layout. Print-friendly: dark header rows with white text, light zebra rows.

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#6b7280")
HEADER_BG = colors.HexColor("#1f2937")
GROUP_BG = colors.HexColor("#eef1f5")
ZEBRA = colors.HexColor("#f7f8fa")
GRID = colors.HexColor("#d9dee6")
ACCENT = colors.HexColor("#b7791f")
PAGE_MARGIN = 0.6 * inch
CONTENT_W = letter[0] - 2 * PAGE_MARGIN


def _styles() -> dict:
    base = getSampleStyleSheet()
    body = ParagraphStyle("NsBody", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=12, textColor=INK)
    return {
        "title": ParagraphStyle("NsTitle", parent=body, fontName="Helvetica-Bold", fontSize=20, leading=24, spaceAfter=4),
        "subtitle": ParagraphStyle("NsSubtitle", parent=body, fontSize=9.5, leading=13, textColor=MUTED, spaceAfter=12),
        "h2": ParagraphStyle("NsH2", parent=body, fontName="Helvetica-Bold", fontSize=13, leading=16, spaceBefore=14, spaceAfter=6),
        "h3": ParagraphStyle("NsH3", parent=body, fontName="Helvetica-Bold", fontSize=10.5, leading=13, spaceBefore=10, spaceAfter=1),
        "meta": ParagraphStyle("NsMeta", parent=body, fontSize=8.5, leading=11, textColor=MUTED, spaceAfter=4),
        "body": body,
        "cell": ParagraphStyle("NsCell", parent=body, fontSize=8, leading=10),
        "cell_muted": ParagraphStyle("NsCellMuted", parent=body, fontSize=7.5, leading=9.5, textColor=MUTED),
        "cell_mono": ParagraphStyle("NsCellMono", parent=body, fontName="Courier", fontSize=7.5, leading=9.5),
        # Header text must be set on the Paragraph itself: TableStyle TEXTCOLOR doesn't reach Paragraphs.
        "th": ParagraphStyle("NsTh", parent=body, fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.white),
        "group": ParagraphStyle("NsGroup", parent=body, fontName="Helvetica-Bold", fontSize=7.5, leading=9.5, textColor=MUTED),
        "kpi": ParagraphStyle("NsKpi", parent=body, fontName="Helvetica-Bold", fontSize=18, leading=21, alignment=1),
        "kpi_label": ParagraphStyle("NsKpiLabel", parent=body, fontSize=8, leading=10, textColor=MUTED, alignment=1),
    }


def _p(text: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(clean(text)).replace("\n", "<br/>"), style)


def _table(
    rows: list[list[Any]],
    widths: list[float],
    *,
    header: list[str] | None,
    styles: dict,
    group_rows: tuple[int, ...] = (),
) -> Table:
    data: list[list[Any]] = []
    if header:
        data.append([_p(h, styles["th"]) for h in header])
    data.extend(rows)
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    first = 1 if header else 0
    commands: list[tuple] = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, first), (-1, -1), 0.3, GRID),
        ("BOX", (0, 0), (-1, -1), 0.4, GRID),
    ]
    if header:
        commands += [("BACKGROUND", (0, 0), (-1, 0), HEADER_BG), ("TOPPADDING", (0, 0), (-1, 0), 4), ("BOTTOMPADDING", (0, 0), (-1, 0), 4)]
    stripe = False
    for r in range(first, len(data)):
        if r - first in group_rows:
            commands += [("SPAN", (0, r), (-1, r)), ("BACKGROUND", (0, r), (-1, r), GROUP_BG)]
            stripe = False
            continue
        if stripe:
            commands.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
        stripe = not stripe
    table.setStyle(TableStyle(commands))
    return table


def _property_table(rows: list[dict[str, str]], styles: dict) -> Table:
    body = [[_p(row["name"], styles["cell"]), _p(row["value"] or "—", styles["cell"])] for row in rows]
    return _table(body, [1.8 * inch, CONTENT_W - 1.8 * inch], header=["Field", "Value"], styles=styles)


def _chrome(title: str, generated: str):
    def draw(canvas, _doc) -> None:
        canvas.saveState()
        page_w, page_h = letter
        logo = pdf_logo_path()
        top = page_h - 0.42 * inch
        text_x = PAGE_MARGIN
        if logo is not None:
            canvas.drawImage(str(logo), PAGE_MARGIN, top - 0.12 * inch, width=0.36 * inch, height=0.36 * inch, mask="auto", preserveAspectRatio=True)
            text_x = PAGE_MARGIN + 0.46 * inch
        canvas.setFillColor(INK)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.drawString(text_x, top + 0.07 * inch, PRODUCT_NAME)
        canvas.setFillColor(MUTED)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(text_x, top - 0.07 * inch, MOTTO)
        canvas.drawRightString(page_w - PAGE_MARGIN, top + 0.07 * inch, clean(title)[:90])
        canvas.setStrokeColor(GRID)
        canvas.setLineWidth(0.5)
        canvas.line(PAGE_MARGIN, page_h - 0.66 * inch, page_w - PAGE_MARGIN, page_h - 0.66 * inch)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(PAGE_MARGIN, 0.35 * inch, f"Generated {generated}")
        canvas.drawRightString(page_w - PAGE_MARGIN, 0.35 * inch, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    return draw


def _doc(buf: io.BytesIO, title: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        buf,
        pagesize=letter,
        title=title,
        author=PRODUCT_NAME,
        leftMargin=PAGE_MARGIN,
        rightMargin=PAGE_MARGIN,
        topMargin=0.9 * inch,
        bottomMargin=0.65 * inch,
    )


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def device_pdf(graph: SurveyGraph, node: Node, title: str | None = None) -> bytes:
    buf = io.BytesIO()
    styles = _styles()
    heading = title or f"{PRODUCT_NAME} device details"
    story = [
        _p(node.label, styles["title"]),
        _p(" · ".join(b for b in (node.inferred_type, node.medium, (node.vendor or "").split(",")[0]) if b), styles["subtitle"]),
        _property_table(device_properties(graph, node), styles),
    ]
    chrome = _chrome(heading, _now())
    _doc(buf, heading).build(story, onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Full map report, with options for what goes in.

REPORT_SECTIONS = ("summary", "geomap", "inventory", "devices", "links")
DEVICE_CATEGORIES = {
    "router": "Routers and gateways",
    "server": "Servers",
    "ap": "Access points",
    "host": "Hosts",
    "wireless": "Wireless clients",
    "network": "Subnets and VLANs",
}
FIELD_GROUPS = {
    "identity": "Identity",
    "radio": "Radio",
    "services": "Services and ports",
    "routing": "Routing",
    "connections": "Connections",
    "notes": "Notes",
    "other": "Other extracted data",
}
DEFAULT_FIELD_GROUPS = ("identity", "radio", "services", "routing", "connections", "notes")
LINK_KIND_NAMES = {
    "l2": "Wired (L2)",
    "l3": "IP traffic (L3)",
    "client-server": "Ports and services",
    "wireless": "Wireless",
    "vlan": "VLAN membership",
    "subnet": "Subnet membership",
    "bridge": "Bridge",
    "manual": "Other connection",
}
ADDED_BY_YOU = "added by you"


def _link_detail(link) -> str:
    """Services and ports, or for a link added by a person, their label and note."""
    info = manual_info(link)
    if info is not None:
        parts = [p for p in ((link.label or "").strip(), (info.get("note") or "").strip()) if p]
        return " · ".join(parts) or "—"
    return _stringify(link.ports) or _stringify(link.services) or "—"
_CATEGORY_RANK = {key: i for i, key in enumerate(DEVICE_CATEGORIES)}
_IDENTITY_FIELDS = (
    ("caption", "Caption"),
    ("ips", "IP addresses"),
    ("macs", "MAC addresses"),
    ("mac_tx", "TX MAC"),
    ("mac_rx", "RX MAC"),
    ("mac_da", "DA MAC"),
    ("mac_ra", "RA MAC"),
    ("vendor", "Maker (OUI)"),
    ("vlans", "VLANs"),
    ("roles", "Roles"),
    ("id", "ID"),
)
_RADIO_FIELDS = (("ssids", "SSIDs"), ("channels", "Channels"), ("frequencies_mhz", "Frequency (MHz)"), ("encryption", "Security"))


@dataclass
class ReportOptions:
    sections: tuple[str, ...] = REPORT_SECTIONS
    categories: tuple[str, ...] = tuple(DEVICE_CATEGORIES)
    field_groups: tuple[str, ...] = DEFAULT_FIELD_GROUPS
    include_empty: bool = False
    node_ids: tuple[str, ...] | None = None
    link_kinds: tuple[str, ...] | None = None

    @classmethod
    def from_dict(cls, data: Any) -> "ReportOptions":
        """Lenient: unknown names are dropped, missing keys keep their defaults."""
        if not isinstance(data, dict):
            return cls()

        def pick(key: str, allowed, default):
            value = data.get(key)
            if not isinstance(value, list):
                return default
            return tuple(v for v in allowed if v in value)

        node_ids = data.get("node_ids")
        link_kinds = data.get("link_kinds")
        return cls(
            sections=pick("sections", REPORT_SECTIONS, REPORT_SECTIONS),
            categories=pick("categories", DEVICE_CATEGORIES, tuple(DEVICE_CATEGORIES)),
            field_groups=pick("field_groups", FIELD_GROUPS, DEFAULT_FIELD_GROUPS),
            include_empty=bool(data.get("include_empty", False)),
            node_ids=tuple(str(n) for n in node_ids) if isinstance(node_ids, list) else None,
            link_kinds=tuple(str(k) for k in link_kinds) if isinstance(link_kinds, list) else None,
        )


def device_category(node: Node) -> str:
    """Same buckets as the map legend."""
    roles = set(node.roles or [])
    kind = node.kind
    inferred = (node.inferred_type or "").lower()
    if kind in {"subnet", "vlan"}:
        return "network"
    if kind == "ap" or "ap" in roles or inferred == "access point":
        return "ap"
    if kind == "gateway" or inferred in {"router", "gateway"}:
        return "router"
    if kind == "server" or inferred == "server":
        return "server"
    if "station" in roles or inferred == "wireless client" or node.medium == "wireless":
        return "wireless"
    return "host"


def _display_name(node: Node) -> str:
    """Label plus the first address, so ten 'Host' rows can be told apart."""
    address = (node.ips or node.macs or [""])[0]
    label = node.label or node.inferred_type or node.id
    return f"{label} ({address})" if address and address != label else label


def _signal(node: Node) -> str:
    if node.signal_dbm is None:
        return ""
    text = f"{node.signal_dbm:g} dBm"
    lo, hi = node.signal_min_dbm, node.signal_max_dbm
    if lo is not None and hi is not None and lo != hi:
        text += f" (range {lo:g} to {hi:g})"
    return text


_ACRONYMS = {"ospf", "dns", "dhcp", "ip", "id", "oui", "stp", "wds", "ssid", "http", "ssh", "mac", "vlan", "gps"}


def _pretty_key(key: str) -> str:
    words = [w.upper() if w.lower() in _ACRONYMS else w for w in key.replace("_", " ").split()]
    text = " ".join(words)
    return text[:1].upper() + text[1:]


def _device_groups(
    node: Node,
    links: list[Link],
    names: dict[str, str],
    opts: ReportOptions,
) -> list[tuple[str, list[tuple[str, str]]]]:
    keep_empty = opts.include_empty

    def rows_for(fields) -> list[tuple[str, str]]:
        out = []
        has_roles = any(getattr(node, k) for k in ("mac_tx", "mac_rx", "mac_da", "mac_ra"))
        for key, title in fields:
            if key == "macs" and has_roles and not keep_empty:
                continue
            value = _stringify(getattr(node, key, None))
            if value or keep_empty:
                out.append((title, value or "—"))
        return out

    groups: list[tuple[str, list[tuple[str, str]]]] = []
    if "identity" in opts.field_groups:
        groups.append(("identity", rows_for(_IDENTITY_FIELDS)))
    if "radio" in opts.field_groups:
        rows = rows_for(_RADIO_FIELDS)
        for title, value in (("Signal", _signal(node)), ("GPS", _stringify(asdict(node.gps)) if node.gps else "")):
            if value or keep_empty:
                rows.append((title, value or "—"))
        groups.append(("radio", rows))
    if "services" in opts.field_groups:
        rows = []
        if node.services or keep_empty:
            rows.append(("Services", _stringify(node.services) or "—"))
        if node.ports or keep_empty:
            rows.append(("Ports", _stringify(node.ports) or "—"))
        groups.append(("services", rows))
    if "routing" in opts.field_groups:
        groups.append(("routing", [(_pretty_key(k), _stringify(v) or "—") for k, v in (node.routing or {}).items() if _stringify(v) or keep_empty]))
    if "connections" in opts.field_groups:
        # One row per neighbour, listing every way they're connected.
        peers: dict[str, list[str]] = {}
        for link in links:
            other = link.target if link.source == node.id else link.source
            detail = ", ".join(dict.fromkeys(p.get("display", "") for p in link.ports if p.get("display"))) or _stringify(link.services)
            if link.kind == "client-server":
                text = f"{'uses' if link.source == node.id else 'serves'} {detail}".strip()
            else:
                text = LINK_KIND_NAMES.get(link.kind, link.kind) + (f" ({detail})" if detail else "")
            if manual_info(link) is not None:
                note = (manual_info(link).get("note") or "").strip()
                text += f", {ADDED_BY_YOU}" + (f": {note}" if note else "")
            peers.setdefault(other, [])
            if text not in peers[other]:
                peers[other].append(text)
        rows = [(names.get(other, other), "; ".join(parts)) for other, parts in sorted(peers.items(), key=lambda kv: names.get(kv[0], kv[0]).lower())]
        groups.append(("connections", rows))
    if "notes" in opts.field_groups and (node.notes or keep_empty):
        groups.append(("notes", [("Notes", node.notes or "—")]))
    if "other" in opts.field_groups:
        extra = dict(node.extra or {})
        rows = []
        if node.kind in {"subnet", "vlan"} and isinstance(extra.get("members"), list):
            rows.append(("Members", f"{len(extra.pop('members'))} devices"))
        for key, value in extra.items():
            text = _stringify(value)
            if text or keep_empty:
                rows.append((_pretty_key(key), text or "—"))
        groups.append(("other", rows))
    return [(FIELD_GROUPS[key], rows) for key, rows in groups if rows]


def _kpis(items: list[tuple[str, Any]], styles: dict) -> Table:
    values = [_p(value, styles["kpi"]) for _, value in items]
    labels = [_p(label, styles["kpi_label"]) for label, _ in items]
    table = Table([values, labels], colWidths=[CONTENT_W / len(items)] * len(items))
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.4, GRID),
                ("INNERGRID", (0, 0), (-1, -1), 0, colors.white),
                ("LINEAFTER", (0, 0), (-2, -1), 0.4, GRID),
                ("BACKGROUND", (0, 0), (-1, -1), ZEBRA),
                ("TOPPADDING", (0, 0), (-1, 0), 8),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
            ]
        )
    )
    return table


def report_scope(graph: SurveyGraph, opts: ReportOptions) -> tuple[list[Node], list[Link]]:
    """The devices and links a report with these options covers."""
    wanted = set(opts.node_ids) if opts.node_ids is not None else None
    nodes = [
        n
        for n in graph.nodes
        if device_category(n) in opts.categories and (wanted is None or n.id in wanted)
    ]
    nodes.sort(key=lambda n: (_CATEGORY_RANK[device_category(n)], (n.label or "").lower(), n.id))
    ids = {n.id for n in nodes}
    links = [
        link
        for link in graph.links
        if (link.source in ids or link.target in ids)
        and (opts.link_kinds is None or link.kind in opts.link_kinds)
    ]
    return nodes, links


def _fitted_image(png: bytes, max_w: float, max_h: float) -> RLImage:
    """A reportlab Image scaled to fit max_w x max_h, keeping its aspect ratio."""
    try:
        iw, ih = ImageReader(io.BytesIO(png)).getSize()
    except Exception as exc:  # PIL raises its own error types for unreadable data
        raise ValueError("The map image couldn't be read.") from exc
    if not iw or not ih:
        raise ValueError("The map image is empty.")
    scale = min(max_w / iw, max_h / ih)
    img = RLImage(io.BytesIO(png), width=iw * scale, height=ih * scale)
    img.hAlign = "CENTER"
    return img


def _geo_story(png: bytes, styles: dict, caption: str | None, max_h: float) -> list:
    flow: list = [_p("Geo map", styles["h2"])]
    if caption:
        flow.append(_p(caption, styles["meta"]))
    flow += [Spacer(1, 6), _fitted_image(png, CONTENT_W, max_h)]
    return flow


def geo_map_pdf(png: bytes, title: str = DEFAULT_REPORT_TITLE, caption: str | None = None) -> bytes:
    """A one-page PDF of a captured geo map, for briefings."""
    buf = io.BytesIO()
    styles = _styles()
    story: list = [_p(title, styles["title"])]
    if caption:
        story.append(_p(caption, styles["subtitle"]))
    story += [Spacer(1, 10), _fitted_image(png, CONTENT_W, 8.0 * inch)]
    chrome = _chrome(title, _now())
    _doc(buf, title).build(story, onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()


def map_report_pdf(
    graph: SurveyGraph,
    title: str = DEFAULT_REPORT_TITLE,
    options: ReportOptions | None = None,
    geo_png: bytes | None = None,
) -> bytes:
    opts = options or ReportOptions()
    styles = _styles()
    nodes, links = report_scope(graph, opts)
    names = {n.id: _display_name(n) for n in graph.nodes}
    meta = graph.meta or {}
    generated = _now()
    story: list = [_p(title, styles["title"])]
    sources = ", ".join(meta.get("sources") or []) or "none recorded"
    scope = "all devices" if opts.node_ids is None and len(opts.categories) == len(DEVICE_CATEGORIES) else f"{len(nodes)} selected devices"
    window = f" · Time window: {meta['time_window']}" if meta.get("time_window") else ""
    story.append(_p(f"Generated {generated} · Sources: {sources} · Covers {scope}{window}", styles["subtitle"]))

    # The captured geo map, when the page sent one and the section is on. A briefing wants it up front.
    if "geomap" in opts.sections and geo_png:
        try:
            story += [Spacer(1, 10), *_geo_story(geo_png, styles, None, 7.2 * inch)]
        except ValueError:
            pass  # a bad image shouldn't sink the whole report

    if "summary" in opts.sections:
        devices = [n for n in nodes if device_category(n) != "network"]
        services = {s for n in nodes for s in (n.services or [])}
        story.append(
            _kpis(
                [
                    ("Devices", len(devices)),
                    ("Links", len(links)),
                    ("Subnets", sum(1 for n in nodes if n.kind == "subnet")),
                    ("VLANs", sum(1 for n in nodes if n.kind == "vlan")),
                    ("Services", len(services)),
                ],
                styles,
            )
        )
        by_cat: dict[str, int] = {}
        for n in nodes:
            by_cat[device_category(n)] = by_cat.get(device_category(n), 0) + 1
        by_kind: dict[str, int] = {}
        for link in links:
            by_kind[link.kind] = by_kind.get(link.kind, 0) + 1
        added = sum(1 for link in links if manual_info(link) is not None)
        half = (CONTENT_W - 0.25 * inch) / 2
        left = _table(
            [[_p(DEVICE_CATEGORIES[c], styles["cell"]), _p(by_cat[c], styles["cell"])] for c in DEVICE_CATEGORIES if c in by_cat],
            [half - 0.7 * inch, 0.7 * inch],
            header=["Device type", "Count"],
            styles=styles,
        )
        right = _table(
            [[_p(LINK_KIND_NAMES.get(k, k), styles["cell"]), _p(v, styles["cell"])] for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])]
            + ([[_p("Of these, added by you", styles["cell"]), _p(added, styles["cell"])]] if added else []),
            [half - 0.7 * inch, 0.7 * inch],
            header=["Link type", "Count"],
            styles=styles,
        )
        side = Table([[left, right]], colWidths=[half + 0.125 * inch, half + 0.125 * inch])
        side.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
        story += [Spacer(1, 12), side]
        warnings = meta.get("warnings") or []
        if warnings:
            story.append(_p("Parser warnings", styles["h3"]))
            story += [_p(f"• {w}", styles["meta"]) for w in warnings]

    if "inventory" in opts.sections and nodes:
        story.append(_p("Device inventory", styles["h2"]))
        rows = []
        for n in nodes:
            device = Paragraph(
                f"<b>{escape(clean(n.label or n.id))}</b>"
                + (f"<br/><font color='#6b7280'>{escape(clean(n.caption))}</font>" if n.caption else ""),
                styles["cell"],
            )
            address = "<br/>".join(escape(clean(a)) for a in [*(n.ips or [])[:2], *(n.macs or [])[:1]]) or "—"
            rows.append(
                [
                    device,
                    _p(n.inferred_type or n.kind, styles["cell"]),
                    Paragraph(address, styles["cell_mono"]),
                    _p((n.vendor or "—").split(",")[0], styles["cell"]),
                    _p(_stringify((n.services or [])[:6]) or "—", styles["cell"]),
                ]
            )
        widths = [1.75 * inch, 1.05 * inch, 1.6 * inch, 1.45 * inch]
        widths.append(CONTENT_W - sum(widths))
        story.append(_table(rows, widths, header=["Device", "Type", "Address", "Maker", "Services"], styles=styles))

    if "devices" in opts.sections and nodes and opts.field_groups:
        story += [PageBreak(), _p("Device details", styles["h2"])]
        index = links_by_node(graph)
        allowed = set(opts.link_kinds) if opts.link_kinds is not None else None
        for n in nodes:
            device_links = [l for l in index.get(n.id, []) if allowed is None or l.kind in allowed]
            groups = _device_groups(n, device_links, names, opts)
            head = [
                _p(names[n.id], styles["h3"]),
                _p(" · ".join(b for b in (n.inferred_type, n.medium, (n.vendor or "").split(",")[0]) if b), styles["meta"]),
            ]
            if not groups:
                story.append(KeepTogether([*head, _p("Nothing extracted for the chosen fields.", styles["meta"])]))
                continue
            rows: list[list[Any]] = []
            group_rows: list[int] = []
            for group_title, items in groups:
                group_rows.append(len(rows))
                rows.append([_p(group_title.upper(), styles["group"]), ""])
                rows += [[_p(name, styles["cell_muted"]), _p(value, styles["cell"])] for name, value in items]
            table = _table(rows, [1.6 * inch, CONTENT_W - 1.6 * inch], header=None, styles=styles, group_rows=tuple(group_rows))
            # Short tables stay on one page with their heading; long ones may split.
            if len(rows) <= 30:
                story.append(KeepTogether([*head, table]))
            else:
                story += [*head, table]

    if "links" in opts.sections and links:
        story += [PageBreak(), _p("Links", styles["h2"])]
        order = {k: i for i, k in enumerate(LINK_KIND_NAMES)}
        rows = []
        for link in sorted(links, key=lambda l: (order.get(l.kind, 99), names.get(l.source, ""), names.get(l.target, ""))):
            rows.append(
                [
                    _p(LINK_KIND_NAMES.get(link.kind, link.kind) + (f" ({ADDED_BY_YOU})" if manual_info(link) is not None else ""), styles["cell"]),
                    _p(names.get(link.source, link.source), styles["cell"]),
                    _p(names.get(link.target, link.target), styles["cell"]),
                    _p(_link_detail(link), styles["cell"]),
                    _p((link.extra or {}).get("count", "—"), styles["cell"]),
                ]
            )
        widths = [1.15 * inch, 1.8 * inch, 1.8 * inch]
        widths += [CONTENT_W - sum(widths) - 0.55 * inch, 0.55 * inch]
        story.append(_table(rows, widths, header=["Type", "From", "To", "Services / ports", "Frames"], styles=styles))

    if len(story) == 2:
        story.append(_p("Nothing to show: the chosen options leave this report empty.", styles["body"]))
    buf = io.BytesIO()
    chrome = _chrome(title, generated)
    _doc(buf, title).build(story, onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()


def safe_filename(name: str, suffix: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "netseer"
    return f"{stem[:80]}{suffix}"
