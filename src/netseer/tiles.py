"""Offline basemap packs (MBTiles) for the geo map.

An MBTiles file is a SQLite database of raster map tiles. Loading one gives the geo map roads,
water, and land without going online — handy in the field, where the public street tiles aren't
reachable. Packs are kept in the per-user data dir and served tile-by-tile to Leaflet.

Only raster packs (PNG/JPEG/WebP tiles) are supported; vector (pbf) packs would need a vector
renderer in the browser. Not available on the hosted copy, which never writes to the server's disk.
"""

from __future__ import annotations

import re
import sqlite3
import threading
from pathlib import Path

from netseer.paths import data_dir

# MBTiles stores rows TMS-style (y counts up from the south); Leaflet asks in XYZ (y down from the
# north). Flip with y_tms = 2**z - 1 - y_xyz.

RASTER_FORMATS = {"png", "jpg", "jpeg", "webp"}
CONTENT_TYPE = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB — a generous ceiling for a city/region pack.

# One cached read-only connection per pack, reused across tile requests. SQLite is happy to be read
# from several threads on one connection as long as writes are serialized — and we never write.
_conns: dict[str, sqlite3.Connection] = {}
_conns_lock = threading.Lock()


def packs_dir() -> Path:
    path = data_dir() / "mappacks"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_id(name: str) -> str:
    """A filesystem- and URL-safe id from a pack's filename stem."""
    stem = Path(name or "pack").stem
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-").lower()
    return (cleaned or "pack")[:60]


def _unique_id(base: str) -> str:
    existing = {p.stem for p in packs_dir().glob("*.mbtiles")}
    if base not in existing:
        return base
    i = 2
    while f"{base}-{i}" in existing:
        i += 1
    return f"{base}-{i}"


def _pack_path(pack_id: str) -> Path | None:
    """The file for a pack id, or None if the id is unsafe or missing."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,60}", pack_id):
        return None
    path = packs_dir() / f"{pack_id}.mbtiles"
    return path if path.is_file() else None


def _open_ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)


def _read_metadata(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT name, value FROM metadata").fetchall()
    return {str(k): str(v) for k, v in rows}


def _num(meta: dict[str, str], key: str) -> float | None:
    try:
        return float(meta[key])
    except (KeyError, ValueError, TypeError):
        return None


def _bounds(meta: dict[str, str]) -> list[float] | None:
    """[minLon, minLat, maxLon, maxLat] from the metadata, if present and well-formed."""
    raw = meta.get("bounds")
    if not raw:
        return None
    try:
        parts = [float(x) for x in raw.split(",")]
    except ValueError:
        return None
    return parts if len(parts) == 4 else None


def _center(meta: dict[str, str]) -> list[float] | None:
    """[lon, lat] (zoom dropped) from the metadata, if present."""
    raw = meta.get("center")
    if not raw:
        return None
    try:
        parts = [float(x) for x in raw.split(",")]
    except ValueError:
        return None
    return parts[:2] if len(parts) >= 2 else None


def _zoom_range(conn: sqlite3.Connection, meta: dict[str, str]) -> tuple[int, int]:
    lo = _num(meta, "minzoom")
    hi = _num(meta, "maxzoom")
    if lo is None or hi is None:
        row = conn.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles").fetchone()
        lo = lo if lo is not None else (row[0] if row and row[0] is not None else 0)
        hi = hi if hi is not None else (row[1] if row and row[1] is not None else 19)
    return int(lo), int(hi)


def _describe(pack_id: str, path: Path, conn: sqlite3.Connection) -> dict:
    meta = _read_metadata(conn)
    fmt = (meta.get("format") or "").lower()
    lo, hi = _zoom_range(conn, meta)
    return {
        "id": pack_id,
        "name": meta.get("name") or pack_id,
        "format": fmt,
        "attribution": meta.get("attribution") or "",
        "bounds": _bounds(meta),
        "center": _center(meta),
        "minzoom": lo,
        "maxzoom": hi,
        "bytes": path.stat().st_size,
    }


def _conn_for(pack_id: str, path: Path) -> sqlite3.Connection:
    with _conns_lock:
        conn = _conns.get(pack_id)
        if conn is None:
            conn = _open_ro(path)
            _conns[pack_id] = conn
        return conn


def _drop_conn(pack_id: str) -> None:
    with _conns_lock:
        conn = _conns.pop(pack_id, None)
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def validate(path: Path) -> str:
    """Check a file is a raster MBTiles pack. Returns its format; raises ValueError if it isn't."""
    try:
        conn = _open_ro(path)
    except sqlite3.Error as exc:
        raise ValueError("That file isn't a readable MBTiles pack.") from exc
    try:
        try:
            names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
            if "tiles" not in names or "metadata" not in names:
                raise ValueError("That file isn't an MBTiles pack (no tiles/metadata).")
            meta = _read_metadata(conn)
            row = conn.execute("SELECT tile_data FROM tiles LIMIT 1").fetchone()
        except sqlite3.Error as exc:
            raise ValueError("That file isn't a readable MBTiles pack.") from exc
        fmt = (meta.get("format") or "").lower()
        if fmt in {"pbf", "mvt"}:
            raise ValueError("That's a vector pack. NetSeer needs a raster (PNG/JPEG) MBTiles pack.")
        if not row or not row[0]:
            raise ValueError("That pack has no map tiles in it.")
        if fmt not in RASTER_FORMATS:
            # Fall back to sniffing the first tile's magic bytes when the metadata omits the format.
            blob = bytes(row[0])
            if blob[:8] == b"\x89PNG\r\n\x1a\n":
                fmt = "png"
            elif blob[:3] == b"\xff\xd8\xff":
                fmt = "jpg"
            elif blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
                fmt = "webp"
            else:
                raise ValueError("Unsupported tile format. Use a raster (PNG/JPEG/WebP) MBTiles pack.")
        return fmt
    finally:
        conn.close()


def add_pack(src_name: str, tmp_path: Path) -> dict:
    """Validate a staged .mbtiles upload and move it into the packs dir. Returns its description."""
    validate(tmp_path)
    pack_id = _unique_id(_safe_id(src_name))
    dest = packs_dir() / f"{pack_id}.mbtiles"
    tmp_path.replace(dest)
    conn = _open_ro(dest)
    try:
        return _describe(pack_id, dest, conn)
    finally:
        conn.close()


def list_packs() -> list[dict]:
    out: list[dict] = []
    for path in sorted(packs_dir().glob("*.mbtiles")):
        try:
            conn = _open_ro(path)
            try:
                out.append(_describe(path.stem, path, conn))
            finally:
                conn.close()
        except sqlite3.Error:
            continue  # a corrupt file shouldn't break the list
    return out


def read_tile(pack_id: str, z: int, x: int, y: int) -> bytes | None:
    path = _pack_path(pack_id)
    if path is None:
        return None
    conn = _conn_for(pack_id, path)
    row_y = (1 << z) - 1 - y  # XYZ -> TMS
    try:
        row = conn.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
            (z, x, row_y),
        ).fetchone()
    except sqlite3.Error:
        _drop_conn(pack_id)
        return None
    return bytes(row[0]) if row and row[0] else None


def delete_pack(pack_id: str) -> bool:
    path = _pack_path(pack_id)
    if path is None:
        return False
    _drop_conn(pack_id)
    try:
        path.unlink()
    except OSError:
        return False
    return True
