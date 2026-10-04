"""User-visible product identity."""

from __future__ import annotations

from pathlib import Path

PRODUCT_NAME = "NetSeer"
MOTTO = "Turn traffic into terrain."
USER_AGENT = "NetSeer/0.1"
DEFAULT_MAP_TITLE = "NetSeer map"
DEFAULT_REPORT_TITLE = "NetSeer map report"

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
LOGO_PNG = WEB_DIR / "logo.png"
LOGO_MARK = WEB_DIR / "logo-192.png"
FAVICON_ICO = WEB_DIR / "favicon.ico"


def logo_path() -> Path | None:
    for candidate in (LOGO_PNG, LOGO_MARK):
        if candidate.exists():
            return candidate
    return None


def pdf_logo_path() -> Path | None:
    for candidate in (LOGO_MARK, LOGO_PNG):
        if candidate.exists():
            return candidate
    return None
