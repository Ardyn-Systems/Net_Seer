"""NetSeer desktop app: runs the local server and shows it in its own window.

Windows: Microsoft Edge WebView2 (built into Windows 10 and 11).
Linux: pywebview's WebKitGTK window when available (source installs), otherwise an
installed Chrome/Chromium/Edge/Brave/Vivaldi in app mode, otherwise the default browser.
In the browser fallback, NetSeer quits on its own a little after the last tab closes.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import subprocess
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
# Chromium-family browsers with an --app mode, in order of preference.
APP_MODE_BROWSERS = (
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge-stable",
    "microsoft-edge",
    "brave-browser",
    "vivaldi-stable",
    "vivaldi",
)
# Browser fallback: quit when the page hasn't checked in for this long. Background
# tabs may only run timers once a minute, so leave room for that.
PAGE_IDLE_SECONDS = 150.0
PAGE_FIRST_VISIT_SECONDS = 300.0
PAGE_BYE_GRACE_SECONDS = 10.0
IS_LINUX = sys.platform.startswith("linux")

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
    elif shutil.which("xdg-user-dir"):
        try:
            out = subprocess.run(["xdg-user-dir", "DOCUMENTS"], capture_output=True, text=True, timeout=3, env=child_env()).stdout.strip()
            if out and Path(out) != Path.home():
                return Path(out)
        except (OSError, subprocess.SubprocessError):
            pass
    return Path.home() / "Documents"


def child_env() -> dict[str, str]:
    """Environment for launching other programs (browsers, dialogs).

    A frozen Linux build points LD_LIBRARY_PATH at its bundled libraries; passing that on
    makes the system browser load the wrong libssl/libstdc++ and crash. PyInstaller keeps
    the original value in LD_LIBRARY_PATH_ORIG.
    """
    env = dict(os.environ)
    if getattr(sys, "frozen", False) and IS_LINUX:
        original = env.pop("LD_LIBRARY_PATH_ORIG", None)
        if original:
            env["LD_LIBRARY_PATH"] = original
        else:
            env.pop("LD_LIBRARY_PATH", None)
    return env


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
    """Native message box (Windows, or zenity/kdialog on Linux); console otherwise. True for OK/Yes."""
    if sys.platform == "win32":
        import ctypes

        flags = 0x40 | (0x1 if ask else 0x0)  # MB_ICONINFORMATION | (MB_OKCANCEL)
        return ctypes.windll.user32.MessageBoxW(None, text, title, flags) == 1
    if IS_LINUX and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        for tool, args in (
            ("zenity", ["--question" if ask else "--info", "--no-wrap", f"--title={title}", f"--text={text}"]),
            ("kdialog", ["--yesno" if ask else "--msgbox", text, "--title", title]),
        ):
            if shutil.which(tool):
                try:
                    return subprocess.run([tool, *args], env=child_env(), check=False).returncode == 0
                except OSError:
                    continue
    print(f"{title}: {text}")
    return True


class SingleInstance:
    """Stops a second launch fighting over the port.

    Windows: a named mutex, which the installer also checks (AppMutex) before upgrading.
    Linux: an exclusive lock on a file in the data folder, released when the process ends.
    """

    def __init__(self) -> None:
        self.handle = None
        self.lock_file = None
        self.already_running = False
        if sys.platform == "win32":
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.CreateMutexW.restype = ctypes.c_void_p
            self.handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
            self.already_running = kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
        elif IS_LINUX:
            import fcntl

            self.lock_file = open(data_dir() / "netseer.lock", "w")
            try:
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                self.already_running = True

    def release(self) -> None:
        if self.handle:
            import ctypes

            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
            self.handle = None
        if self.lock_file is not None:
            self.lock_file.close()
            self.lock_file = None


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
        from netseer import integration

        # Expose on the LAN only when the user opted in (Settings → Integrations); the LAN guard in
        # web.py still limits non-local clients to the token-gated integration API.
        host = "0.0.0.0" if integration.lan_enabled() else "127.0.0.1"
        os.environ["NETSEER_BOUND_HOST"] = host
        # log_config=None: uvicorn's default config writes to a console the .exe doesn't have.
        config = uvicorn.Config(app, host=host, port=port, log_config=None, access_log=False, log_level="info")
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
    """pywebview window (WebView2 on Windows, WebKitGTK on Linux). Blocks until it closes; raises if unavailable."""
    import webview

    from netseer import updater

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
    # An in-app update closes the window so the new version can be put in place.
    updater.on_quit(lambda: [w.destroy() for w in list(webview.windows)])
    storage = data_dir() / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    webview.start(private_mode=False, storage_path=str(storage))


def find_app_mode_browser() -> str | None:
    for name in APP_MODE_BROWSERS:
        path = shutil.which(name)
        if path:
            return path
    return None


def app_mode_profile(browser: str) -> Path:
    """A dedicated profile, so the window is its own process and maps persist in one place.

    Snap browsers can't write to hidden folders like ~/.local, so use their own common dir.
    """
    resolved = os.path.realpath(browser)
    if browser.startswith("/snap/") or resolved.startswith("/snap/"):
        path = Path.home() / "snap" / Path(browser).name / "common" / PRODUCT_NAME
    else:
        path = data_dir() / "browser"
    path.mkdir(parents=True, exist_ok=True)
    return path


def wait_for_page_close(first_visit: float = PAGE_FIRST_VISIT_SECONDS, idle: float = PAGE_IDLE_SECONDS) -> None:
    """Block until the NetSeer page stops checking in (POST /api/heartbeat)."""
    from netseer import updater, web

    started = time.monotonic()
    while True:
        time.sleep(2)
        if updater.QUIT.is_set():
            log.info("Closing for an update")
            return
        now = time.monotonic()
        last, bye = web.PRESENCE["last"], web.PRESENCE["bye"]
        if last is None:
            if now - started > first_visit:
                log.info("No NetSeer page opened within %.0f s; quitting", first_visit)
                return
            continue
        if bye is not None and bye >= last and now - bye > PAGE_BYE_GRACE_SECONDS:
            log.info("NetSeer page closed; quitting")
            return
        if now - last > idle:
            log.info("No NetSeer page for %.0f s; quitting", idle)
            return


def open_app_mode(url: str) -> bool:
    """Open a Chromium-family browser in app mode and block until its window closes."""
    browser = find_app_mode_browser()
    if not browser:
        return False
    profile = app_mode_profile(browser)
    cmd = [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        f"--class={PRODUCT_NAME}",
        "--window-size=1440,900",
    ]
    log.info("Opening app window with %s", browser)
    started = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, env=child_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        log.exception("Couldn't start %s", browser)
        return False
    from netseer import updater

    updater.on_quit(proc.terminate)
    proc.wait()
    if updater.QUIT.is_set():
        return True
    # A quick exit means the window was handed to an already-running browser
    # (or the browser bailed); fall back to watching the page itself.
    if time.monotonic() - started < 5:
        wait_for_page_close()
    return True


def run_in_browser(url: str, *, can_watch_page: bool) -> None:
    previous = dict(os.environ)
    os.environ.clear()
    os.environ.update(child_env())  # webbrowser spawns xdg-open etc. with os.environ
    try:
        webbrowser.open(url)
    finally:
        os.environ.clear()
        os.environ.update(previous)
    if sys.platform == "win32":
        message_box(
            "NetSeer is open in your web browser.\n\n"
            "For its own window, install Microsoft Edge WebView2:\n"
            f"{WEBVIEW2_URL}\n\nClick OK to quit NetSeer.",
        )
    elif can_watch_page:
        log.info("Opened %s in the default browser; NetSeer quits after the tab closes", url)
        print(f"NetSeer is open at {url}. It quits a couple of minutes after you close the tab (or press Ctrl+C).")
        wait_for_page_close()


def show(url: str, *, browser_only: bool, can_watch_page: bool) -> None:
    if not browser_only:
        try:
            open_window(url)
            return
        except Exception as exc:  # ImportError, missing WebView2/WebKitGTK, no display...
            log.info("pywebview window unavailable (%s)", exc)
        if IS_LINUX and open_app_mode(url):
            return
    run_in_browser(url, can_watch_page=can_watch_page)


def desktop_entry(exec_path: str, icon: str) -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={PRODUCT_NAME}\n"
        "GenericName=Network survey map\n"
        "Comment=Turn traffic into terrain. Map pcap, Kismet, and airodump surveys.\n"
        f'Exec="{exec_path}"\n'
        f"Icon={icon}\n"
        "Terminal=false\n"
        "Categories=Network;Utility;\n"
        "Keywords=pcap;wireshark;kismet;wifi;network;map;\n"
        f"StartupWMClass={PRODUCT_NAME}\n"
    )


def install_desktop_entry(uninstall: bool = False) -> int:
    """Add (or remove) NetSeer in the Linux app menu for this user."""
    if not IS_LINUX:
        print("--install is for Linux. On Windows, use NetSeer-Setup.exe.")
        return 1
    share = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    entry = share / "applications" / "netseer.desktop"
    icon = share / "icons" / "hicolor" / "256x256" / "apps" / "netseer.png"
    if uninstall:
        for path in (entry, icon):
            path.unlink(missing_ok=True)
        print("Removed NetSeer from the app menu.")
        return 0
    # Inside an AppImage, $APPIMAGE is the .AppImage file itself (stable across runs).
    exec_path = os.environ.get("APPIMAGE") or (sys.executable if getattr(sys, "frozen", False) else shutil.which("netseer-desktop") or sys.executable)
    bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "netseer" / "web" / "logo-192.png"
    if not bundled.exists():
        bundled = Path(__file__).resolve().parent / "web" / "logo-192.png"
    entry.parent.mkdir(parents=True, exist_ok=True)
    icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(bundled, icon)
    entry.write_text(desktop_entry(exec_path, "netseer"), encoding="utf-8")
    entry.chmod(0o755)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(entry.parent)], env=child_env(), check=False)
    print(f"Added NetSeer to the app menu ({entry}).")
    return 0


def smoke_test() -> int:
    """Start the server on a spare port and exercise the bundle: UI files, samples, parsers, exports."""
    # A bundle missing modules makes scapy log "ERROR: Loading module ..." and carry on;
    # count those so a half-packaged scapy fails the check instead of hiding in the log.
    scapy_errors: list[str] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.levelno >= logging.ERROR:
                scapy_errors.append(record.getMessage())

    collector = _Collect()
    logging.getLogger("scapy").addHandler(collector)
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
        checks.append(("logo", b"<svg" in get("/static/logo.svg"), ""))
        graph = json.loads(get("/api/samples/campus-all/graph"))
        checks.append(("parse samples", len(graph.get("nodes", [])) > 5, f"{len(graph.get('nodes', []))} nodes"))
        checks.append(("draw.io", b"<mxfile" in post("/api/export/drawio", graph), ""))
        checks.append(("visio", post("/api/export/vsdx", graph)[:2] == b"PK", ""))
        checks.append(("pdf report", post("/api/export/report.pdf", graph)[:4] == b"%PDF", ""))
        checks.append(("heartbeat", post("/api/heartbeat", {}) is not None, ""))
        # Kismet logs are SQLite databases; the bundle needs the sqlite3 module and its DLL/.so.
        import sqlite3

        con = sqlite3.connect(":memory:")
        checks.append(("sqlite (Kismet logs)", con.execute("select sqlite_version()").fetchone()[0] != "", sqlite3.sqlite_version))
        con.close()
        checks.append(("scapy layers", not scapy_errors, "; ".join(scapy_errors[:3])))
    except Exception as exc:  # report everything; this is a diagnostic
        log.exception("Smoke test failed")
        checks.append(("exception", False, repr(exc)))
    finally:
        server.stop()
        logging.getLogger("scapy").removeHandler(collector)
    for name, ok, note in checks:
        line = f"{'PASS' if ok else 'FAIL'} {name} {note}".rstrip()
        log.info(line)
        print(line)
    ok = all(passed for _, passed, _ in checks)
    log.info("Smoke test %s", "passed" if ok else "failed")
    return 0 if ok else 1


def package_type() -> str:
    """installer, portable, or appimage for frozen builds; source when run from Python."""
    if os.environ.get("APPIMAGE"):
        return "appimage"
    if not getattr(sys, "frozen", False):
        return "source"
    if sys.platform == "win32":
        # Inno Setup leaves its uninstaller next to the exe; the portable zip has none.
        return "installer" if any(Path(sys.executable).parent.glob("unins*.exe")) else "portable"
    return "portable"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="NetSeer", description=f"{PRODUCT_NAME} desktop app")
    parser.add_argument("--port", type=int, help=f"Port for the local server (default {DEFAULT_PORT})")
    parser.add_argument("--browser", action="store_true", help="Open in the default web browser instead of a window")
    parser.add_argument("--smoke-test", action="store_true", help="Check the installation and exit (0 = OK)")
    parser.add_argument("--install", action="store_true", help="Linux: add NetSeer to your app menu")
    parser.add_argument("--uninstall", action="store_true", help="Linux: remove NetSeer from your app menu")
    parser.add_argument("--debug", action="store_true", help="Verbose logging")
    parser.add_argument("--version", action="version", version=f"{PRODUCT_NAME} {__version__}")
    args = parser.parse_args(argv)

    if args.install or args.uninstall:
        return install_desktop_entry(uninstall=args.uninstall)

    log_path = setup_logging(args.debug)
    log.info("NetSeer %s starting (%s, Python %s, %s)", __version__, "frozen" if getattr(sys, "frozen", False) else "source", sys.version.split()[0], sys.platform)
    # Program Files and AppImages aren't writable, so Unwanted dumps go to Documents/NetSeer/Unwanted.
    os.environ.setdefault("NETSEER_UNWANTED_DIR", str(documents_dir() / PRODUCT_NAME / "Unwanted"))
    # Tells the page it is the desktop app, and which download it came from (for Settings → Updates).
    os.environ["NETSEER_MODE"] = "desktop"
    os.environ.setdefault("NETSEER_PACKAGE", package_type())

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
        # The version in the address means a new version always loads its own page: the
        # window can't show a copy it cached before an update.
        url = f"http://127.0.0.1:{port}/?v={__version__}"
        log.info("Serving %s", url)
        # Watching the page only works for our own server; a reused one lives in another process.
        show(url, browser_only=args.browser, can_watch_page=server is not None)
        return 0
    except KeyboardInterrupt:
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
