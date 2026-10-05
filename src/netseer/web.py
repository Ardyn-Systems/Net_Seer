from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from netseer import __version__, updater
from netseer.brand import DEFAULT_MAP_TITLE, MOTTO, PRODUCT_NAME
from netseer.compare import compare_graphs
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
from netseer.exporters.reports import ReportOptions, device_properties
from netseer.ingest import ingest_files, ingest_sources, max_upload_bytes, size_error
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


def hosted_mode() -> bool:
    """NETSEER_HOSTED=1 for a public server: no writing files to the server's disk."""
    return os.environ.get("NETSEER_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}


def max_body_bytes() -> int | None:
    # Request bodies above this are refused before parsing (upload limit plus multipart overhead).
    limit = max_upload_bytes()
    return None if limit is None else limit + 1024 * 1024


REPO = updater.REPO


def run_mode() -> str:
    """How this copy runs: "hosted" (public server), "desktop" (app window), or "server" (netseer CLI)."""
    if hosted_mode():
        return "hosted"
    return "desktop" if os.environ.get("NETSEER_MODE") == "desktop" else "server"


def platform_name() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux" if sys.platform.startswith("linux") else sys.platform


MAX_UNWANTED_GROUPS = 200
MAX_UNWANTED_FILES = 1000

app = FastAPI(title=PRODUCT_NAME, version=__version__, description=MOTTO)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    length = request.headers.get("content-length")
    limit = max_body_bytes()
    if length is not None and limit is not None:
        try:
            too_big = int(length) > limit
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
        if too_big:
            error = size_error(int(length))
            return JSONResponse({"detail": str(error) if error else "Request is too large."}, status_code=413)
    return await call_next(request)


def _http_error(exc: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


# Last time an open NetSeer page checked in (time.monotonic()), and when it said goodbye.
# The desktop launcher's browser fallback uses this to quit once the tab is closed.
PRESENCE: dict[str, float | None] = {"last": None, "bye": None}


@app.post("/api/heartbeat", status_code=204)
def heartbeat(bye: bool = False) -> Response:
    PRESENCE["bye" if bye else "last"] = time.monotonic()
    return Response(status_code=204)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "name": PRODUCT_NAME,
        "motto": MOTTO,
        "version": __version__,
        "hosted": hosted_mode(),
        # None: no limit (installed copies stream captures of any size from disk).
        "max_upload_mb": None if max_upload_bytes() is None else max_upload_bytes() // (1024 * 1024),
        "mode": run_mode(),
        "platform": platform_name(),
        "frozen": bool(getattr(sys, "frozen", False)),
        # installer / portable / appimage for desktop builds, "source" otherwise.
        "package": os.environ.get("NETSEER_PACKAGE") or "source",
        "repo": REPO,
        # The desktop app can download and install releases itself (Settings → Updates).
        "updater": updater.unsupported_reason() is None,
    }


# In-app updates. These download and run programs, so they answer only the desktop app's
# own page: the custom header makes other web pages fail CORS preflight, and the Host
# check stops a DNS-rebinding site from posing as 127.0.0.1.
UPDATE_HEADER = "x-netseer-update"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


def _guard_update(request: Request) -> None:
    reason = updater.unsupported_reason()
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    origin = request.headers.get("origin")
    if request.headers.get(UPDATE_HEADER) != "1" or host not in LOCAL_HOSTS:
        raise HTTPException(status_code=403, detail="Updates can only be started from NetSeer's own window.")
    if origin and origin.rstrip("/") != f"http://{request.headers.get('host')}":
        raise HTTPException(status_code=403, detail="Updates can only be started from NetSeer's own window.")


@app.get("/api/update/status")
def update_status(request: Request) -> dict:
    if updater.unsupported_reason() is None:
        _guard_update(request)
    return updater.status()


@app.post("/api/update/start")
def update_start(request: Request, body: dict) -> dict:
    _guard_update(request)
    try:
        return updater.start(str(body.get("tag", "")))
    except updater.UpdateError as exc:
        raise _http_error(exc, 409) from exc


@app.post("/api/update/cancel")
def update_cancel(request: Request) -> dict:
    _guard_update(request)
    return updater.cancel()


@app.post("/api/update/install")
def update_install(request: Request) -> dict:
    _guard_update(request)
    try:
        return updater.install()
    except updater.UpdateError as exc:
        raise _http_error(exc, 409) from exc


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


log = logging.getLogger("netseer.web")


def _upload_folder(name: str) -> tuple[Path, Path]:
    folder = Path(tempfile.mkdtemp(prefix="netseer-upload-"))
    # Keep the extension: it helps tell formats apart (.kismet, .netxml, .csv).
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).name)[:120].strip("._") or "upload"
    return folder, folder / safe


async def _save_stream(chunks, path: Path) -> int:
    """Write an upload to disk as it arrives, refusing it once it passes the size limit."""
    limit = max_upload_bytes()
    total = 0
    with open(path, "wb") as out:
        async for chunk in chunks:
            total += len(chunk)
            if limit is not None and total > limit:
                raise HTTPException(status_code=413, detail=str(size_error(total)))
            out.write(chunk)
    if not total:
        raise HTTPException(status_code=400, detail="The file is empty.")
    return total


async def _upload_chunks(file: UploadFile):
    while chunk := await file.read(1024 * 1024):
        yield chunk


def _parse_error(exc: Exception) -> HTTPException:
    if isinstance(exc, EmptySurveyError):
        return _http_error(exc, 422)
    return _http_error(exc)


@app.post("/api/parse")
async def parse_upload(file: UploadFile = File(...)):
    """Parse one capture in a single request (small files; the page uses /api/parse/jobs)."""
    name = file.filename or "upload"
    folder, path = _upload_folder(name)
    try:
        await _save_stream(_upload_chunks(file), path)
        # Parsing is CPU-bound; keep it off the event loop so other requests still answer.
        graph = await run_in_threadpool(ingest_sources, [(name, path)])
    except (EmptySurveyError, UnsupportedSurveyError, ValueError, OSError) as exc:
        raise _parse_error(exc) from exc
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return graph.to_dict()


# ---------- Reading jobs: big captures, with progress, stop, and cancel ----------
# POST the raw file to /api/parse/jobs?name=<file name>; poll GET /api/parse/jobs/<id>;
# when it's done, GET .../result. POST .../stop keeps what's been read so far as the map;
# DELETE cancels and discards it.

PARSE_JOBS: dict[str, dict] = {}
_jobs_lock = threading.Lock()
JOB_KEEP_SECONDS = 15 * 60
HOSTED_MAX_RUNNING_JOBS = 2


def _forget_old_jobs() -> None:
    now = time.monotonic()
    with _jobs_lock:
        for job_id, job in list(PARSE_JOBS.items()):
            if job["state"] != "running" and now - (job.get("finished") or now) > JOB_KEEP_SECONDS:
                PARSE_JOBS.pop(job_id, None)


def _run_job(job: dict) -> None:
    def progress(info: dict) -> None:
        job["progress"] = info

    try:
        graph = ingest_sources([(job["name"], job["path"])], progress=progress, should_stop=job["stop"].is_set)
        if not job["discard"]:
            job["result"] = graph.to_dict()
        job["state"] = "done"
    except (EmptySurveyError, UnsupportedSurveyError, ValueError, OSError) as exc:
        job.update(state="error", error=str(exc), status=422 if isinstance(exc, EmptySurveyError) else 400)
    except Exception as exc:  # pragma: no cover - keep the details in the log
        log.exception("Reading %s failed", job["name"])
        job.update(state="error", error=f"NetSeer couldn't read {job['name']} ({exc}).", status=500)
    finally:
        shutil.rmtree(job["folder"], ignore_errors=True)
        job["finished"] = time.monotonic()
        if job["discard"]:
            with _jobs_lock:
                PARSE_JOBS.pop(job["id"], None)


def _job_status(job: dict) -> dict:
    progress = job.get("progress") or {}
    return {
        "id": job["id"],
        "name": job["name"],
        "state": job["state"],
        "bytes": job["bytes"],
        "packets": progress.get("packets", 0),
        "fraction": progress.get("fraction", 0.0),
        "devices": progress.get("devices", 0),
        "elapsed": round((job.get("finished") or time.monotonic()) - job["started"], 1),
        "stopping": job["stop"].is_set(),
        "error": job.get("error"),
    }


def _get_job(job_id: str) -> dict:
    job = PARSE_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="That reading job isn't running any more.")
    return job


@app.post("/api/parse/jobs")
async def start_parse_job(request: Request, name: str = "upload"):
    _forget_old_jobs()
    if hosted_mode():
        running = sum(1 for j in PARSE_JOBS.values() if j["state"] == "running")
        if running >= HOSTED_MAX_RUNNING_JOBS:
            raise HTTPException(status_code=429, detail="This online copy is busy reading other captures. Try again in a minute.")
    folder, path = _upload_folder(name)
    try:
        size = await _save_stream(request.stream(), path)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    job = {
        "id": uuid.uuid4().hex, "name": Path(name).name or "upload", "path": path, "folder": folder, "bytes": size,
        "state": "running", "started": time.monotonic(), "stop": threading.Event(), "discard": False,
    }
    with _jobs_lock:
        PARSE_JOBS[job["id"]] = job
    threading.Thread(target=_run_job, args=(job,), name=f"netseer-read-{job['id'][:6]}", daemon=True).start()
    return _job_status(job)


@app.get("/api/parse/jobs/{job_id}")
def parse_job_status(job_id: str) -> dict:
    return _job_status(_get_job(job_id))


@app.post("/api/parse/jobs/{job_id}/stop")
def stop_parse_job(job_id: str) -> dict:
    job = _get_job(job_id)
    job["stop"].set()
    return _job_status(job)


@app.delete("/api/parse/jobs/{job_id}", status_code=204)
def cancel_parse_job(job_id: str) -> Response:
    job = PARSE_JOBS.get(job_id)
    if job is not None:
        job["discard"] = True
        job["stop"].set()
        if job["state"] != "running":
            with _jobs_lock:
                PARSE_JOBS.pop(job_id, None)
    return Response(status_code=204)


@app.get("/api/parse/jobs/{job_id}/result")
def parse_job_result(job_id: str):
    job = _get_job(job_id)
    if job["state"] == "running":
        raise HTTPException(status_code=409, detail="Still reading.")
    with _jobs_lock:
        PARSE_JOBS.pop(job_id, None)
    if job["state"] == "error":
        raise HTTPException(status_code=job.get("status", 400), detail=job["error"])
    return JSONResponse(job["result"])


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


@app.post("/api/compare")
def compare_api(body: dict):
    """A map of what changed between a baseline survey and a later one."""
    baseline, later = body.get("baseline"), body.get("later")
    if not isinstance(baseline, dict) or not isinstance(later, dict):
        raise HTTPException(status_code=400, detail="Send a baseline map and a later map to compare.")
    try:
        return compare_graphs(
            baseline,
            later,
            baseline_name=str(body.get("baseline_name") or "Baseline"),
            later_name=str(body.get("later_name") or "Later survey"),
        )
    except UnsupportedSurveyError as exc:
        raise _http_error(exc) from exc


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
    # Optional "report" object picks sections, device types, and field groups.
    blob = map_report_pdf(graph, title=f"{title} report", options=ReportOptions.from_dict(body.get("report")))
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
    if hosted_mode():
        # Anonymous visitors mustn't write to a public server's disk; the page downloads the files instead.
        raise HTTPException(status_code=403, detail="Saving to the server is turned off on this public site.")
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
