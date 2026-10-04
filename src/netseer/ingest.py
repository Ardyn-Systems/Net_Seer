from __future__ import annotations

import json
from pathlib import Path

from netseer.detect import EmptySurveyError, UnsupportedSurveyError, sniff_format
from netseer.graph import GraphBuilder
from netseer.models import SurveyGraph
from netseer.parsers import parse_into
from netseer.serialize import graph_from_dict

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def ingest_netseer_json(data: bytes, filename: str) -> SurveyGraph:
    try:
        payload = json.loads(data.decode("utf-8"))
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


def ingest_bytes(data: bytes, filename: str, builder: GraphBuilder | None = None) -> GraphBuilder:
    if len(data) > MAX_UPLOAD_BYTES:
        raise UnsupportedSurveyError("File is larger than the 50 MB preview limit.")
    kind = sniff_format(data, filename)
    if kind == "netseer-json":
        raise UnsupportedSurveyError("NetSeer JSON dumps must be loaded as a whole graph, not mixed into a capture.")
    builder = builder or GraphBuilder()
    parse_into(builder, data, filename, kind)
    return builder


def ingest_files(files: list[tuple[str, bytes]]) -> SurveyGraph:
    if len(files) == 1:
        filename, data = files[0]
        if sniff_format(data, filename) == "netseer-json":
            return ingest_netseer_json(data, filename)
    builder = GraphBuilder()
    for filename, data in files:
        ingest_bytes(data, filename, builder)
    graph = builder.finalize()
    if not graph.nodes:
        raise EmptySurveyError("No hosts, access points, or links were found in this survey.")
    return graph


def ingest_paths(paths: list[Path]) -> SurveyGraph:
    files = [(path.name, path.read_bytes()) for path in paths]
    return ingest_files(files)
