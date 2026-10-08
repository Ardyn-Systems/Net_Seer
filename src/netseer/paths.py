"""Where NetSeer keeps per-user data on disk.

Used by the integration store (pairing tokens) and the security vulndb cache.
Kept separate from any run mode so the browser, CLI, and Electron builds share one location.
"""

from __future__ import annotations

import os
from pathlib import Path

from netseer.brand import PRODUCT_NAME


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    path = Path(base) / PRODUCT_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path
