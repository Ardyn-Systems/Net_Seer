"""Escaping for XML exports. SSIDs and captions are untrusted and may hold quotes or control bytes."""

from __future__ import annotations

import html
import re
from typing import Any
from xml.sax.saxutils import escape

# Characters XML 1.0 forbids outright (everything below 0x20 except tab, LF, CR).
_INVALID_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_ATTR_ENTITIES = {'"': "&quot;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;"}


def clean(value: Any) -> str:
    return _INVALID_XML.sub("", "" if value is None else str(value))


def xml_text(value: Any) -> str:
    """Safe element content."""
    return escape(clean(value))


def xml_attr(value: Any) -> str:
    """Safe double-quoted attribute value."""
    return escape(clean(value), _ATTR_ENTITIES)


def html_label(value: Any) -> str:
    """draw.io `html=1` label: HTML-escape the text, keep line breaks as <br>."""
    return html.escape(clean(value), quote=False).replace("\n", "<br>")
