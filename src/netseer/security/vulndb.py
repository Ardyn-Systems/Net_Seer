"""Known vulnerabilities for the products NetSeer recognizes, kept on disk.

Two copies can exist: the one bundled with this version of NetSeer, and one downloaded later
with Settings → Security → Update (see ``fetch``). The newer of the two is used.

File format (gzip JSON)::

    {"generated": "2026-10-06T12:00:00Z", "epss_date": "2026-10-06", "kev_date": "...",
     "products": {"openbsd:openssh": [
        {"id": "CVE-2024-6387", "summary": "...", "cvss": 8.1, "severity": "HIGH",
         "epss": 0.91, "percentile": 0.99, "kev": true,
         "ranges": [["", true, "9.8", false]],   # start, start inclusive, end, end inclusive
         "versions": ["7.4p1"]}]}}
"""

from __future__ import annotations

import gzip
import json
import os
import threading
from pathlib import Path
from typing import Any

from netseer.security.software import Software, version_key

BUNDLED = Path(__file__).resolve().parents[1] / "data" / "vulndb.json.gz"
SEVERITY_RANK = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "NONE": 0, "": 0}

_lock = threading.Lock()
_cache: dict[str, Any] = {"key": None, "db": None}


def cache_dir() -> Path:
    """Where a downloaded copy is kept (next to NetSeer's other app data)."""
    override = os.environ.get("NETSEER_VULNDB_DIR")
    if override:
        path = Path(override)
    else:
        from netseer.paths import data_dir

        path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def downloaded_path() -> Path:
    return cache_dir() / "vulndb.json.gz"


def _read(path: Path) -> dict[str, Any] | None:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) and isinstance(data.get("products"), dict) else None
    except (OSError, ValueError, EOFError):
        return None


def write(path: Path, db: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(db, fh, separators=(",", ":"))
    os.replace(tmp, path)
    with _lock:
        _cache["key"] = None


def _stamp(path: Path) -> tuple:
    try:
        st = path.stat()
        return (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return (str(path), None)


def summary(db: dict[str, Any] | None) -> dict[str, Any] | None:
    if not db:
        return None
    products = db.get("products") or {}
    return {
        "generated": db.get("generated"),
        "epss_date": db.get("epss_date"),
        "kev_date": db.get("kev_date"),
        "products": len(products),
        "vulnerabilities": len({v["id"] for items in products.values() for v in items}),
    }


def load() -> tuple[dict[str, Any], str]:
    """The database to use and where it came from ("downloaded", "bundled", or "none")."""
    key = (_stamp(BUNDLED), _stamp(downloaded_path()))
    with _lock:
        if _cache["key"] == key:
            return _cache["db"]
    bundled = _read(BUNDLED)
    downloaded = _read(downloaded_path())
    if downloaded and (not bundled or str(downloaded.get("generated") or "") >= str(bundled.get("generated") or "")):
        result = (downloaded, "downloaded")
    elif bundled:
        result = (bundled, "bundled")
    else:
        result = ({"products": {}}, "none")
    with _lock:
        _cache.update(key=key, db=result)
    return result


def info() -> dict[str, Any]:
    db, source = load()
    return {
        "active": source,
        "bundled": summary(_read(BUNDLED)),
        "downloaded": summary(_read(downloaded_path())),
        "in_use": summary(db) if source != "none" else None,
    }


def _in_range(version: str, rng: list) -> bool:
    start, start_incl, end, end_incl = (list(rng) + ["", True, "", False])[:4]
    v = version_key(version)
    if start:
        s = version_key(start)
        if v < s or (v == s and not start_incl):
            return False
    if end:
        e = version_key(end)
        if v > e or (v == e and not end_incl):
            return False
    return bool(start or end)


def affects(entry: dict[str, Any], version: str) -> bool:
    v = version_key(version)
    if any(version_key(x) == v for x in entry.get("versions") or []):
        return True
    return any(_in_range(version, rng) for rng in entry.get("ranges") or [])


def vulnerabilities(soft: Software, db: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Known vulnerabilities that apply to this product and version, most likely to be exploited first."""
    if not soft.version or not soft.cpes:
        return []
    db = db if db is not None else load()[0]
    found: dict[str, dict[str, Any]] = {}
    for cpe in soft.cpes:
        for entry in (db.get("products") or {}).get(cpe) or []:
            if entry["id"] not in found and affects(entry, soft.version):
                found[entry["id"]] = {k: entry.get(k) for k in ("id", "summary", "cvss", "severity", "epss", "percentile", "kev", "published")}
    return sorted(found.values(), key=lambda v: (bool(v.get("kev")), v.get("epss") or 0, v.get("cvss") or 0), reverse=True)
