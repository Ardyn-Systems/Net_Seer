from __future__ import annotations

import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from netseer.brand import DEFAULT_MAP_TITLE, MOTTO, PRODUCT_NAME
from netseer.detect import EmptySurveyError, UnsupportedSurveyError
from netseer.exporters import (
    device_csv,
    device_pdf,
    device_plain_text,
    device_xml,
    export_drawio,
    export_vdx,
    export_vsdx,
    map_report_pdf,
    safe_filename,
)
from netseer.exporters.reports import device_properties
from netseer.ingest import MAX_UPLOAD_BYTES, ingest_files
from netseer.samples import SAMPLES, files_for_sample
from netseer.serialize import graph_from_dict

WEB_DIR = Path(__file__).resolve().parent / "web"
ROOT_DIR = Path(__file__).resolve().parents[2]


def _unwanted_dir() -> Path:
    """NETSEER_UNWANTED_DIR, else Unwanted/ in a source checkout, else ./Unwanted."""
    override = os.environ.get("NETSEER_UNWANTED_DIR")
    if override:
        return Path(override).expanduser()
    if (ROOT_DIR / "pyproject.toml").is_file():
        return ROOT_DIR / "Unwanted"
    return Path.cwd() / "Unwanted"


UNWANTED_DIR = _unwanted_dir()
# Request bodies above this are refused before parsing (uploads are multipart overhead + 50 MB).
MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
MAX_UNWANTED_GROUPS = 200
MAX_UNWANTED_FILES = 1000

app = FastAPI(title=PRODUCT_NAME, version="0.1.0", description=MOTTO)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    length = request.headers.get("content-length")
    if length is not None:
        try:
            too_big = int(length) > MAX_BODY_BYTES
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
        if too_big:
            return JSONResponse({"detail": "Request is larger than the 50 MB preview limit."}, status_code=413)
    return await call_next(request)


def _http_error(exc: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "name": PRODUCT_NAME, "motto": MOTTO}


@app.get("/api/samples")
def list_samples() -> list[dict]:
    return SAMPLES


@app.get("/api/samples/{sample_id}/graph")
def sample_graph(sample_id: str):
    try:
        files = files_for_sample(sample_id)
        graph = ingest_files(files)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown sample '{sample_id}'.") from None
    except EmptySurveyError as exc:
        raise _http_error(exc, 422) from exc
    except (UnsupportedSurveyError, ValueError, OSError) as exc:
        raise _http_error(exc) from exc
    return graph.to_dict()


@app.post("/api/parse")
async def parse_upload(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    name = file.filename or "upload"
    try:
        # Parsing is CPU-bound; keep it off the event loop so other requests still answer.
        graph = await run_in_threadpool(ingest_files, [(name, data)])
    except EmptySurveyError as exc:
        raise _http_error(exc, 422) from exc
    except (UnsupportedSurveyError, ValueError, OSError) as exc:
        raise _http_error(exc) from exc
    return graph.to_dict()


def _layout_hints(body: dict) -> dict:
    """On-screen positions and subnet containers from the map, so exports match what you see."""
    positions = body.get("positions")
    parents = body.get("parents")
    return {
        "positions": positions if isinstance(positions, dict) else None,
        "parents": parents if isinstance(parents, dict) else None,
    }


def _graph_from_body(body: dict):
    if "nodes" not in body:
        raise HTTPException(status_code=400, detail="Export body must include a graph with nodes and links.")
    try:
        graph = graph_from_dict(body)
    except UnsupportedSurveyError as exc:
        raise _http_error(exc) from exc
    return graph, str(body.get("title") or DEFAULT_MAP_TITLE)


@app.post("/api/export/drawio")
def export_drawio_api(body: dict):
    graph, title = _graph_from_body(body)
    xml = export_drawio(graph, title=title, **_layout_hints(body))
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": 'attachment; filename="netseer-map.drawio"'},
    )


@app.post("/api/export/vdx")
def export_vdx_api(body: dict):
    graph, title = _graph_from_body(body)
    xml = export_vdx(graph, title=title, **_layout_hints(body))
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": 'attachment; filename="netseer-map.vdx"'},
    )


@app.post("/api/export/vsdx")
def export_vsdx_api(body: dict):
    graph, title = _graph_from_body(body)
    blob = export_vsdx(graph, title=title, **_layout_hints(body))
    return Response(
        content=blob,
        media_type="application/vnd.visio",
        headers={"Content-Disposition": 'attachment; filename="netseer-map.vsdx"'},
    )


def _node_from_body(body: dict):
    graph, title = _graph_from_body(body)
    node_id = body.get("node_id")
    node = next((n for n in graph.nodes if n.id == node_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail="Unknown device on this map.")
    return graph, node, title


@app.post("/api/device/properties")
def device_properties_api(body: dict):
    graph, node, _title = _node_from_body(body)
    return {
        "id": node.id,
        "label": node.label,
        "kind": node.kind,
        "properties": device_properties(graph, node),
    }


@app.post("/api/export/device/{fmt}")
def export_device_api(fmt: str, body: dict):
    graph, node, title = _node_from_body(body)
    stem = safe_filename(node.label or node.id, "")
    if fmt == "txt":
        return Response(
            content=device_plain_text(graph, node),
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{stem}-device.txt"'},
        )
    if fmt == "csv":
        return Response(
            content=device_csv(graph, node),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{stem}-device.csv"'},
        )
    if fmt == "xml":
        return Response(
            content=device_xml(graph, node),
            media_type="application/xml",
            headers={"Content-Disposition": f'attachment; filename="{stem}-device.xml"'},
        )
    if fmt == "pdf":
        return Response(
            content=device_pdf(graph, node, title=f"{title} — {node.label}"),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{stem}-device.pdf"'},
        )
    raise HTTPException(status_code=404, detail="Use txt, csv, xml, or pdf.")


@app.post("/api/export/report.pdf")
def export_report_pdf(body: dict):
    graph, title = _graph_from_body(body)
    blob = map_report_pdf(graph, title=f"{title} report")
    name = safe_filename(title, "-report.pdf")
    return Response(
        content=blob,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def _safe_unwanted_stem(capture: str) -> str:
    raw = Path(str(capture or "unknown")).name
    stem = Path(raw).stem if raw else "unknown"
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-") or "unknown"
    return cleaned[:60]


def _unique_unwanted_path(stem: str) -> Path:
    UNWANTED_DIR.mkdir(parents=True, exist_ok=True)
    dest = UNWANTED_DIR / f"Unwanted-{stem}.json"
    i = 2
    while dest.exists():
        dest = UNWANTED_DIR / f"Unwanted-{stem}-{i}.json"
        i += 1
    return dest


@app.post("/api/unwanted/dump")
def dump_unwanted(body: dict):
    groups = body.get("groups")
    if not isinstance(groups, list) or not groups:
        raise HTTPException(status_code=400, detail="Empty Unwanted dump needs at least one device group.")
    if len(groups) > MAX_UNWANTED_GROUPS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_UNWANTED_GROUPS} capture groups per dump.")
    if UNWANTED_DIR.is_dir() and sum(1 for _ in UNWANTED_DIR.glob("Unwanted-*.json")) >= MAX_UNWANTED_FILES:
        raise HTTPException(
            status_code=507,
            detail=f"Unwanted/ already holds {MAX_UNWANTED_FILES} dumps. Move or delete some first.",
        )
    written: list[str] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        nodes = group.get("nodes") or []
        links = group.get("links") or []
        if not isinstance(nodes, list) or not isinstance(links, list) or not nodes:
            continue
        try:
            # Validate before writing so a dump always reloads.
            graph_from_dict({"nodes": nodes, "links": links})
        except UnsupportedSurveyError as exc:
            raise _http_error(exc) from exc
        capture = group.get("capture") or "unknown"
        stem = _safe_unwanted_stem(capture)
        dest = _unique_unwanted_path(stem)
        payload = {
            "netseer": "unwanted-v1",
            "original_capture": capture,
            "title": f"Unwanted {stem}",
            "nodes": nodes,
            "links": links,
            "meta": {
                "sources": [capture] if capture else ["unknown"],
                "node_count": len(nodes),
                "link_count": len(links),
            },
            "device_meta": group.get("device_meta") or {},
        }
        dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        written.append(dest.name)
    if not written:
        raise HTTPException(status_code=400, detail="No devices to write.")
    return {"ok": True, "directory": "Unwanted", "files": written}


@app.get("/")
def index():
    index_path = WEB_DIR / "index.html"
    if not index_path.exists():
        return JSONResponse({"error": "Web UI missing"}, status_code=500)
    return FileResponse(index_path)


@app.get("/favicon.ico")
def favicon():
    path = WEB_DIR / "favicon.ico"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Favicon missing")
    return FileResponse(path, media_type="image/x-icon")


if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
