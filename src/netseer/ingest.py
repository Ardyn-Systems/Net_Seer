from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

from netseer.detect import EmptySurveyError, UnsupportedSurveyError, netseer_payload, sniff_format
from netseer.graph import GraphBuilder
from netseer.models import SurveyGraph
from netseer.parsers import parse_into
from netseer.serialize import graph_from_dict

HOSTED_MAX_UPLOAD_MB = 20


def _hosted() -> bool:
    return os.environ.get("NETSEER_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}


def max_upload_bytes() -> int | None:
    """Largest capture accepted, or None for no limit.

    Installed copies (the desktop app, or netseer on your own machine) take captures of
    any size: they stream from disk. A public copy (NETSEER_HOSTED=1) defaults to 20 MB.
    NETSEER_MAX_UPLOAD_MB sets a limit either way; 0 means none.
    """
    raw = os.environ.get("NETSEER_MAX_UPLOAD_MB")
    if raw is None or not raw.strip():
        return HOSTED_MAX_UPLOAD_MB * 1024 * 1024 if _hosted() else None
    try:
        megabytes = float(raw)
    except ValueError:
        megabytes = HOSTED_MAX_UPLOAD_MB if _hosted() else 0
    return int(megabytes * 1024 * 1024) if megabytes > 0 else None


def size_error(size: int) -> UnsupportedSurveyError | None:
    limit = max_upload_bytes()
    if limit is None or size <= limit:
        return None
    mb = limit // (1024 * 1024)
    if _hosted():
        return UnsupportedSurveyError(
            f"This file is larger than this online copy's {mb} MB limit. "
            "Install NetSeer to open bigger captures, such as long wardrives: it has no size limit."
        )
    return UnsupportedSurveyError(f"File is larger than the {mb} MB limit set by NETSEER_MAX_UPLOAD_MB.")


def _check_size(data: bytes | int) -> None:
    error = size_error(data if isinstance(data, int) else len(data))
    if error:
        raise error


def ingest_netseer_json(data: bytes, filename: str, payload: dict | None = None) -> SurveyGraph:
    _check_size(data)
    if payload is None:
        try:
            payload = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UnsupportedSurveyError(f"Not a NetSeer JSON dump: {exc}") from exc
    if not isinstance(payload, dict):
        raise UnsupportedSurveyError("NetSeer JSON dump must be an object.")
    graph = graph_from_dict(payload)
    meta = dict(graph.meta or {})
    sources = list(meta.get("sources") or [])
    original = payload.get("original_capture")
    if original and original not in sources:
        sources.insert(0, original)
    if filename and filename not in sources:
        sources.append(filename)
    meta["sources"] = sources
    if payload.get("device_meta"):
        meta["device_meta"] = payload["device_meta"]
    graph.meta = meta
    if not graph.nodes:
        raise EmptySurveyError("No hosts, access points, or links were found in this survey.")
    return graph


def _head(source: bytes | Path) -> bytes:
    if isinstance(source, Path):
        with open(source, "rb") as f:
            return f.read(512)
    return source[:512]


def ingest_bytes(data: bytes, filename: str, builder: GraphBuilder | None = None) -> GraphBuilder:
    builder = builder or GraphBuilder()
    _ingest_one(builder, data, filename)
    return builder


def _ingest_one(builder: GraphBuilder, source: bytes | Path, filename: str, progress=None, should_stop=None) -> None:
    size = source.stat().st_size if isinstance(source, Path) else len(source)
    _check_size(size)
    head = _head(source)
    if not head:
        raise UnsupportedSurveyError("The file is empty.")
    # Text formats are sniffed on their start; JSON needs the whole (small) file.
    looks_json = head.lstrip(b"\xef\xbb\xbf \t\r\n")[:1] in (b"{", b"[") or filename.lower().endswith(".json")
    kind = sniff_format(_bytes(source) if looks_json else head, filename)
    if kind == "netseer-json":
        raise UnsupportedSurveyError("NetSeer JSON dumps must be loaded as a whole graph, not mixed into a capture.")
    parse_into(builder, source, filename, kind, progress=progress, should_stop=should_stop)


def _bytes(source: bytes | Path) -> bytes:
    return source.read_bytes() if isinstance(source, Path) else source


def ingest_sources(
    files: list[tuple[str, bytes | Path]],
    *,
    progress: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> SurveyGraph:
    """Build one graph from captures given as bytes or as files on disk.

    progress(...) gets {"file", "files", "name", "packets", "fraction", "devices"}.
    """
    if len(files) == 1:
        filename, source = files[0]
        head = _head(source)
        if head.lstrip(b"\xef\xbb\xbf \t\r\n")[:1] in (b"{", b"[") or filename.lower().endswith(".json"):
            data = _bytes(source)
            _check_size(data)
            payload = netseer_payload(data, filename)
            if payload is not None:
                return ingest_netseer_json(data, filename, payload)
    builder = GraphBuilder()
    for index, (filename, source) in enumerate(files):
        def report(packets: int, fraction: float, index=index, filename=filename) -> None:
            if progress is not None:
                progress({"file": index + 1, "files": len(files), "name": filename, "packets": packets,
                          "fraction": min(1.0, (index + fraction) / len(files)), "devices": len(builder.devices)})

        _ingest_one(builder, source, filename, report, should_stop)
        if should_stop is not None and should_stop():
            break
    graph = builder.finalize()
    if not graph.nodes:
        raise EmptySurveyError("No hosts, access points, or links were found in this survey.")
    return graph


def ingest_files(files: list[tuple[str, bytes]]) -> SurveyGraph:
    return ingest_sources(list(files))


def ingest_paths(paths: list[Path], **kwargs) -> SurveyGraph:
    return ingest_sources([(path.name, path) for path in paths], **kwargs)
