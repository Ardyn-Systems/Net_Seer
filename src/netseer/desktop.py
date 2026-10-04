"""NetSeer desktop app: runs the local server and shows it in a native window.

On Windows the window is Microsoft Edge WebView2 (built into Windows 10 and 11).
If WebView2 or pywebview is missing, NetSeer opens in the default browser instead.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

from netseer import __version__
from netseer.brand import PRODUCT_NAME

# Saved maps live in the window's storage, which is keyed by origin (host + port).
# Keep the port stable so maps are still there next launch.
DEFAULT_PORT = 47331
FALLBACK_PORTS = range(47332, 47341)
MUTEX_NAME = "NetSeerDesktop"  # session-local; matches AppMutex in netseer.iss
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

log = logging.getLogger("netseer.desktop")


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    path = Path(base) / PRODUCT_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def documents_dir() -> Path:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        # CSIDL_PERSONAL (5) follows OneDrive and folder redirection, unlike ~/Documents.
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
            return Path(buf.value)
    return Path.home() / "Documents"


def setup_logging(debug: bool = False) -> Path:
    path = data_dir() / "netseer.log"
    handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    # A windowed .exe has no console: give print/tracebacks somewhere to go.
    if sys.stdout is None or sys.stderr is None:
        stream = open(path.with_suffix(".out.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    return path


def message_box(text: str, title: str = PRODUCT_NAME, *, ask: bool = False) -> bool:
    """Native message box on Windows; console elsewhere. Returns True for OK/Yes."""
    if sys.platform == "win32":
        import ctypes

        flags = 0x40 | (0x1 if ask else 0x0)  # MB_ICONINFORMATION | (MB_OKCANCEL)
        return ctypes.windll.user32.MessageBoxW(None, text, title, flags) == 1
    print(f"{title}: {text}")
    return True


class SingleInstance:
    """Named mutex so a second launch says so instead of fighting over the port.

    The installer uses the same name (AppMutex) to ask you to close NetSeer before upgrading.
    """

    def __init__(self) -> None:
        self.handle = None
        self.already_running = False
        if sys.platform != "win32":
            return
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        self.handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        self.already_running = kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS

    def release(self) -> None:
        if self.handle:
            import ctypes

            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
            self.handle = None


def health(port: int, timeout: float = 1.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None


def port_state(port: int) -> str:
    """'free', 'netseer' (a NetSeer server already answers there), or 'busy'."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        if sock.connect_ex(("127.0.0.1", port)) != 0:
            return "free"
    info = health(port)
    return "netseer" if info and info.get("name") == PRODUCT_NAME else "busy"


def choose_port(requested: int | None = None) -> tuple[int, bool]:
    """Pick a port. Returns (port, reuse) where reuse means a NetSeer server is already there."""
    candidates = [requested] if requested else [DEFAULT_PORT, *FALLBACK_PORTS]
    for port in candidates:
        state = port_state(port)
        if state == "free":
            return port, False
        if state == "netseer":
            return port, True
    raise RuntimeError(f"Ports {candidates[0]}–{candidates[-1]} are all in use by other programs.")


def free_ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ServerThread(threading.Thread):
    def __init__(self, port: int) -> None:
        super().__init__(name="netseer-server", daemon=True)
        import uvicorn

        from netseer.web import app

        self.port = port
        # log_config=None: uvicorn's default config writes to a console the .exe doesn't have.
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False, log_level="info")
        self.server = uvicorn.Server(config)

    def run(self) -> None:
        self.server.run()

    def stop(self, timeout: float = 5.0) -> None:
        self.server.should_exit = True
        self.join(timeout)


def wait_ready(port: int, server: ServerThread | None = None, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server is not None and not server.is_alive():
            raise RuntimeError("The NetSeer server stopped while starting. See netseer.log.")
        info = health(port, timeout=0.5)
        if info and info.get("name") == PRODUCT_NAME:
            return
        time.sleep(0.1)
    raise RuntimeError(f"The NetSeer server didn't answer on port {port} within {timeout:.0f} seconds.")


def open_window(url: str) -> None:
    """Block until the window closes. Raises if the native window can't be created."""
    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True  # exports are browser downloads
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.create_window(
        PRODUCT_NAME,
        url,
        width=1440,
        height=900,
        min_size=(900, 600),
        background_color="#15140f",
        text_select=True,
    )
    storage = data_dir() / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    webview.start(private_mode=False, storage_path=str(storage))


def run_in_browser(url: str) -> None:
    webbrowser.open(url)
    message_box(
        "NetSeer is open in your web browser.\n\n"
        "For its own window, install Microsoft Edge WebView2:\n"
        f"{WEBVIEW2_URL}\n\nClick OK to quit NetSeer.",
    )


def smoke_test() -> int:
    """Start the server on a spare port and exercise the bundle: UI files, samples, parsers, exports."""
    port = free_ephemeral_port()
    server = ServerThread(port)
    server.start()
    base = f"http://127.0.0.1:{port}"
    checks: list[tuple[str, bool, str]] = []

    def get(path: str) -> bytes:
        with urllib.request.urlopen(base + path, timeout=60) as res:
            return res.read()

    def post(path: str, body: dict) -> bytes:
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.read()

    try:
        wait_ready(port, server)
        checks.append(("index", b"NetSeer" in get("/"), ""))
        checks.append(("cytoscape", len(get("/static/vendor/cytoscape.min.js")) > 100_000, ""))
        graph = json.loads(get("/api/samples/campus-all/graph"))
        checks.append(("parse samples", len(graph.get("nodes", [])) > 5, f"{len(graph.get('nodes', []))} nodes"))
        checks.append(("draw.io", b"<mxfile" in post("/api/export/drawio", graph), ""))
        checks.append(("visio", post("/api/export/vsdx", graph)[:2] == b"PK", ""))
        checks.append(("pdf report", post("/api/export/report.pdf", graph)[:4] == b"%PDF", ""))
    except Exception as exc:  # report everything; this is a diagnostic
        log.exception("Smoke test failed")
        checks.append(("exception", False, repr(exc)))
    finally:
        server.stop()
    for name, ok, note in checks:
        line = f"{'PASS' if ok else 'FAIL'} {name} {note}".rstrip()
        log.info(line)
        print(line)
    ok = all(passed for _, passed, _ in checks)
    log.info("Smoke test %s", "passed" if ok else "failed")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="NetSeer", description=f"{PRODUCT_NAME} desktop app")
    parser.add_argument("--port", type=int, help=f"Port for the local server (default {DEFAULT_PORT})")
    parser.add_argument("--browser", action="store_true", help="Open in the default web browser instead of a window")
    parser.add_argument("--smoke-test", action="store_true", help="Check the installation and exit (0 = OK)")
    parser.add_argument("--debug", action="store_true", help="Verbose logging")
    args = parser.parse_args(argv)

    log_path = setup_logging(args.debug)
    log.info("NetSeer %s starting (%s, Python %s)", __version__, "frozen" if getattr(sys, "frozen", False) else "source", sys.version.split()[0])
    # Program Files isn't writable, so Unwanted dumps go to Documents\NetSeer\Unwanted.
    os.environ.setdefault("NETSEER_UNWANTED_DIR", str(documents_dir() / PRODUCT_NAME / "Unwanted"))

    if args.smoke_test:
        return smoke_test()

    instance = SingleInstance()
    if instance.already_running:
        message_box("NetSeer is already open. Look for its window on the taskbar.")
        return 0

    server: ServerThread | None = None
    try:
        port, reuse = choose_port(args.port)
        if port != DEFAULT_PORT and not args.port:
            log.warning("Port %s is taken; using %s. Maps saved on the usual port won't show here.", DEFAULT_PORT, port)
        if not reuse:
            server = ServerThread(port)
            server.start()
            wait_ready(port, server)
        url = f"http://127.0.0.1:{port}/"
        log.info("Serving %s", url)
        if args.browser:
            run_in_browser(url)
        else:
            try:
                open_window(url)
            except Exception:
                log.exception("Couldn't open the NetSeer window; falling back to the browser")
                run_in_browser(url)
        return 0
    except Exception as exc:
        log.exception("NetSeer failed to start")
        message_box(f"NetSeer couldn't start:\n\n{exc}\n\nDetails are in:\n{log_path}")
        return 1
    finally:
        if server is not None:
            server.stop()
        instance.release()
        log.info("NetSeer closed")


if __name__ == "__main__":
    sys.exit(main())
