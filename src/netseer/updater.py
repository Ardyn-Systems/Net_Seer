"""In-app updates for the desktop builds: download a release, check it, install it, reopen.

Only the desktop app does this (installer, portable, or AppImage builds); a source install
or a server never downloads or runs anything.

1. start(tag) asks GitHub for that release, picks the file that matches this install, and
   downloads it in the background, hashing as it goes.
2. The SHA-256 must match the digest GitHub publishes for the file (or the release's
   SHA256SUMS file); otherwise the download is deleted.
3. install() hands off to a small helper process that waits for NetSeer to exit, puts the
   new version in place, and starts it again; then NetSeer closes its window.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from netseer import __version__
from netseer.brand import PRODUCT_NAME

log = logging.getLogger("netseer.updater")

REPO = "ardyn-systems/NetSeer"
API_RELEASE = "https://api.github.com/repos/{repo}/releases/tags/{tag}"
USER_AGENT = f"{PRODUCT_NAME}/{__version__} (in-app update)"
TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
CHUNK = 256 * 1024
MAX_DOWNLOAD = 400 * 1024 * 1024
QUIT_DELAY = 1.5  # seconds: lets the page get its answer before the window closes
QUIT_WATCHDOG = 20.0  # seconds: exit anyway if the window doesn't close


class UpdateError(Exception):
    """A problem worth showing to the person updating."""


# ---------- What this copy can do ----------


def platform_name() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    return "linux" if sys.platform.startswith("linux") else sys.platform


def package() -> str:
    return os.environ.get("NETSEER_PACKAGE") or "source"


def unsupported_reason() -> str | None:
    """Why this copy can't update itself, or None when it can."""
    if os.environ.get("NETSEER_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}:
        return "The online copy updates itself."
    if os.environ.get("NETSEER_MODE") != "desktop":
        return "Only the desktop app updates itself."
    pkg = package()
    if pkg not in {"installer", "portable", "appimage"}:
        return "NetSeer was installed from source; update it with uv or pip."
    if pkg == "installer" and platform_name() != "windows":
        return "The installer is for Windows."
    if pkg == "appimage" and not os.environ.get("APPIMAGE"):
        return "Couldn't find the AppImage file."
    if pkg != "appimage" and not getattr(sys, "frozen", False):
        return "Only the downloaded app updates itself."
    return None


ASSET_PATTERNS = {
    ("windows", "installer"): re.compile(r"^NetSeer-Setup-[\d.]+\.exe$", re.I),
    ("windows", "portable"): re.compile(r"^NetSeer-[\d.]+-windows-x64-portable\.zip$", re.I),
    ("linux", "portable"): re.compile(r"^NetSeer-[\d.]+-linux-x86_64\.tar\.gz$", re.I),
    ("linux", "appimage"): re.compile(r"^NetSeer-[\d.]+-x86_64\.AppImage$", re.I),
}


def pick_asset(assets: list[dict], platform: str, pkg: str) -> dict | None:
    pattern = ASSET_PATTERNS.get((platform, pkg))
    if pattern is None:
        return None
    return next((a for a in assets if pattern.match(str(a.get("name", "")))), None)


def check_download_url(url: str) -> None:
    """Release files only come from this repo's releases on github.com."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "github.com" or not parts.path.startswith(f"/{REPO}/releases/download/"):
        raise UpdateError("That download isn't from NetSeer's releases on GitHub, so NetSeer won't use it.")


def parse_sha256sums(text: str) -> dict[str, str]:
    """`sha256sum` / Get-FileHash style lines: '<hex>  <name>' (a leading * marks binary mode)."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
        if m:
            out[m.group(2)] = m.group(1).lower()
    return out


# ---------- Talking to GitHub ----------


def _open(url: str, timeout: float = 30.0):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json, */*"})
    return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 (https URLs checked by callers)


def fetch_json(url: str) -> dict:
    try:
        with _open(url, timeout=20) as res:
            return json.loads(res.read(2 * 1024 * 1024).decode("utf-8"))
    except UpdateError:
        raise
    except Exception as exc:
        log.warning("GitHub request failed: %s", exc)
        raise UpdateError("Couldn't reach GitHub. Check your internet connection and try again.") from exc


def fetch_text(url: str, limit: int = 64 * 1024) -> str:
    check_download_url(url)
    try:
        with _open(url, timeout=20) as res:
            return res.read(limit).decode("utf-8", "replace")
    except Exception as exc:
        raise UpdateError("Couldn't download the release's checksums from GitHub.") from exc


def expected_sha256(release: dict, asset: dict) -> str:
    digest = str(asset.get("digest") or "")
    if digest.lower().startswith("sha256:") and re.fullmatch(r"[0-9a-fA-F]{64}", digest[7:]):
        return digest[7:].lower()
    for other in release.get("assets", []):
        if re.fullmatch(r"SHA256SUMS(-[a-z]+)?\.txt", str(other.get("name", ""))):
            sums = parse_sha256sums(fetch_text(other["browser_download_url"]))
            if asset["name"] in sums:
                return sums[asset["name"]]
    raise UpdateError("GitHub has no checksum for this download, so NetSeer won't install it by itself. Download it from the release page instead.")


# ---------- Progress, shared with the page ----------

_lock = threading.Lock()
STATE: dict = {}
_cancel = threading.Event()
QUIT = threading.Event()
_quit_hooks: list[Callable[[], None]] = []


def _reset() -> None:
    STATE.clear()
    STATE.update(status="idle", tag=None, version=None, asset=None, total=0, done=0, error=None, path=None, staged=None)


_reset()


def status() -> dict:
    with _lock:
        out = {k: v for k, v in STATE.items() if k not in {"path", "staged"}}
    out["supported"] = unsupported_reason() is None
    out["reason"] = unsupported_reason()
    out["package"] = package()
    return out


def _set(**changes) -> None:
    with _lock:
        STATE.update(changes)


def _fail(message: str) -> None:
    log.warning("Update failed: %s", message)
    _set(status="error", error=message)


# ---------- Where the new version goes ----------


def data_dir() -> Path:
    from netseer.desktop import data_dir as desktop_data_dir

    return desktop_data_dir()


def updates_dir() -> Path:
    path = data_dir() / "updates"
    path.mkdir(parents=True, exist_ok=True)
    return path


def install_root() -> Path:
    """The folder holding NetSeer's executable (portable and installed builds)."""
    return Path(sys.executable).resolve().parent


def _writable(folder: Path) -> bool:
    try:
        probe = folder / f".netseer-write-test-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except OSError:
        return False


def download_target(asset_name: str) -> Path:
    pkg = package()
    if pkg == "appimage":
        appimage = Path(os.environ["APPIMAGE"])
        if not _writable(appimage.parent):
            raise UpdateError(f"NetSeer can't write to {appimage.parent}, where its AppImage is. Move the AppImage to a folder you own, or download the update yourself.")
        return appimage.parent / f".{asset_name}.part"
    if pkg == "portable" and not _writable(install_root().parent):
        raise UpdateError(f"NetSeer can't write to {install_root().parent}, next to its folder. Move NetSeer to a folder you own, or download the update yourself.")
    folder = updates_dir()
    for old in folder.iterdir():  # one update at a time; clear leftovers
        if old.is_file():
            old.unlink(missing_ok=True)
        else:
            shutil.rmtree(old, ignore_errors=True)
    return folder / asset_name


# ---------- Download ----------


def start(tag: str) -> dict:
    reason = unsupported_reason()
    if reason:
        raise UpdateError(reason)
    if not TAG_RE.match(tag or ""):
        raise UpdateError("That isn't a NetSeer version.")
    with _lock:
        if STATE["status"] in {"checking", "downloading", "verifying", "installing"}:
            raise UpdateError("An update is already in progress.")
    _reset()
    _cancel.clear()
    _set(status="checking", tag=tag, version=tag[1:])
    threading.Thread(target=_run_download, args=(tag,), name="netseer-update", daemon=True).start()
    return status()


def cancel() -> dict:
    _cancel.set()
    with _lock:
        busy = STATE["status"] in {"checking", "downloading", "verifying"}
        staged = STATE.get("staged") or STATE.get("path")
    if not busy:
        _cleanup(staged)
        _reset()
    return status()


def _cleanup(path: str | None) -> None:
    if not path:
        return
    p = Path(path)
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    else:
        p.unlink(missing_ok=True)


def _run_download(tag: str) -> None:
    try:
        release = fetch_json(API_RELEASE.format(repo=REPO, tag=urllib.parse.quote(tag)))
        if release.get("draft") or release.get("tag_name") != tag:
            raise UpdateError("GitHub doesn't have that version.")
        asset = pick_asset(release.get("assets", []), platform_name(), package())
        if not asset:
            raise UpdateError("That version has no download for this kind of install.")
        check_download_url(asset["browser_download_url"])
        sha = expected_sha256(release, asset)
        target = download_target(asset["name"])
        _set(status="downloading", asset=asset["name"], total=int(asset.get("size") or 0), done=0)
        download(asset["browser_download_url"], target, sha)
        _set(status="verifying")
        staged = stage(target, tag)
        _set(status="ready", path=str(target), staged=str(staged))
        log.info("Update %s downloaded and checked: %s", tag, target)
    except UpdateError as exc:
        _fail(str(exc))
    except Exception as exc:  # pragma: no cover - unexpected; keep the details in the log
        log.exception("Update download failed")
        _fail(f"The update couldn't be downloaded ({exc}).")


def download(url: str, target: Path, sha256: str) -> None:
    """Stream to target, hashing as we go. A mismatch (or a cancel) leaves nothing behind."""
    partial = target.with_name(target.name + ".tmp")
    digest = hashlib.sha256()
    done = 0
    try:
        with _open(url, timeout=60) as res, open(partial, "wb") as out:
            while True:
                if _cancel.is_set():
                    raise UpdateError("Download cancelled.")
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                done += len(chunk)
                if done > MAX_DOWNLOAD:
                    raise UpdateError("The download is far bigger than expected, so NetSeer stopped it.")
                digest.update(chunk)
                out.write(chunk)
                _set(done=done)
        if digest.hexdigest() != sha256:
            raise UpdateError("The download didn't match GitHub's checksum, so NetSeer deleted it. Nothing was installed.")
        os.replace(partial, target)
    except UpdateError:
        partial.unlink(missing_ok=True)
        raise
    except Exception as exc:
        partial.unlink(missing_ok=True)
        raise UpdateError("The download stopped partway. Check your connection and try again.") from exc


# ---------- Unpack (portable builds) ----------


def _inside(base: Path, name: str) -> bool:
    dest = (base / name).resolve()
    return dest == base or base in dest.parents


def safe_extract(archive: Path, dest: Path) -> None:
    """Unpack a zip or tar.gz, refusing paths that would land outside dest."""
    dest = dest.resolve()
    if archive.name.lower().endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for name in zf.namelist():
                if not _inside(dest, name):
                    raise UpdateError("The download contains unsafe file paths, so NetSeer won't unpack it.")
            zf.extractall(dest)
    else:
        with tarfile.open(archive, "r:gz") as tf:
            for member in tf.getmembers():
                ok = _inside(dest, member.name) and (member.isfile() or member.isdir() or member.issym() or member.islnk())
                if member.issym():  # PyInstaller bundles have relative library links
                    ok = ok and not os.path.isabs(member.linkname) and _inside(dest, os.path.join(os.path.dirname(member.name), member.linkname))
                elif member.islnk():
                    ok = ok and _inside(dest, member.linkname)
                if not ok:
                    raise UpdateError("The download contains unsafe file paths, so NetSeer won't unpack it.")
            try:
                tf.extractall(dest, filter="data")
            except TypeError:  # Python < 3.12
                tf.extractall(dest)  # noqa: S202 (members checked above)


def exe_name() -> str:
    return f"{PRODUCT_NAME}.exe" if platform_name() == "windows" else PRODUCT_NAME


def stage(downloaded: Path, tag: str) -> Path:
    """Get the download ready to swap in. Returns what install() will put in place."""
    pkg = package()
    if pkg == "appimage":
        downloaded.chmod(0o755)
        return downloaded
    if pkg == "portable":
        staging = install_root().parent / f".netseer-update-{tag}"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        try:
            safe_extract(downloaded, staging)
            if not (staging / PRODUCT_NAME / exe_name()).is_file():
                raise UpdateError("The download doesn't look like NetSeer, so NetSeer won't use it.")
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        finally:
            downloaded.unlink(missing_ok=True)
        return staging
    return downloaded  # installer: run as is


# ---------- Install ----------


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def windows_install_script(pid: int, plan: dict) -> str:
    """PowerShell run by the helper: wait for NetSeer to exit, then install and reopen."""
    lines = [
        "$ErrorActionPreference = 'Stop'",
        f"Wait-Process -Id {int(pid)} -ErrorAction SilentlyContinue",
        "Start-Sleep -Milliseconds 700",
    ]
    if plan["kind"] == "installer":
        args = ", ".join(_ps_quote(a) for a in plan["args"])
        lines.append(f"Start-Process -FilePath {_ps_quote(plan['setup'])} -ArgumentList @({args})")
    else:  # portable: swap folders, keep the old one as <folder>.previous
        cur, prev, new = _ps_quote(plan["current"]), _ps_quote(plan["previous"]), _ps_quote(plan["new"])
        staging, exe = _ps_quote(plan["staging"]), _ps_quote(exe_name())
        lines += [
            "try {",
            f"  if (Test-Path -LiteralPath {prev}) {{ Remove-Item -LiteralPath {prev} -Recurse -Force }}",
            f"  Move-Item -LiteralPath {cur} -Destination {prev}",
            f"  Move-Item -LiteralPath {new} -Destination {cur}",
            f"  Remove-Item -LiteralPath {staging} -Recurse -Force -ErrorAction SilentlyContinue",
            f"  Start-Process -FilePath (Join-Path {cur} {exe})",
            "} catch {",
            f"  if (Test-Path -LiteralPath (Join-Path {new} {exe})) {{ Start-Process -FilePath (Join-Path {new} {exe}) }}",
            f"  elseif (Test-Path -LiteralPath (Join-Path {cur} {exe})) {{ Start-Process -FilePath (Join-Path {cur} {exe}) }}",
            "}",
        ]
    return "\n".join(lines)


POSIX_PORTABLE_SCRIPT = r"""
pid="$1"; cur="$2"; prev="$3"; new="$4"; staging="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
if rm -rf "$prev" && mv "$cur" "$prev" && mv "$new" "$cur"; then
  rm -rf "$staging"; exec "$cur/NetSeer"
elif [ -x "$new/NetSeer" ]; then exec "$new/NetSeer"
else exec "$cur/NetSeer"; fi
"""

POSIX_RELAUNCH_SCRIPT = r"""
pid="$1"; target="$2"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
sleep 0.5
exec "$target"
"""


def installer_args(log_path: Path) -> list[str]:
    # Upgrade the same way it was installed: per user (no admin prompt) or for all users.
    local = os.environ.get("LOCALAPPDATA")
    per_user = bool(local) and Path(local).resolve() in install_root().parents
    return [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/RELAUNCH=1",
        "/CURRENTUSER" if per_user else "/ALLUSERS",
        f'/LOG="{log_path}"',  # Start-Process joins arguments with spaces, so quote paths
    ]


def install_plan() -> dict:
    with _lock:
        if STATE["status"] != "ready":
            raise UpdateError("There's no checked download ready to install.")
        path, staged, tag = STATE["path"], STATE["staged"], STATE["tag"]
    pkg = package()
    if pkg == "installer":
        return {"kind": "installer", "setup": path, "args": installer_args(data_dir() / "update-install.log"), "tag": tag}
    if pkg == "appimage":
        return {"kind": "appimage", "new": staged, "target": os.environ["APPIMAGE"], "tag": tag}
    current = install_root()
    return {
        "kind": "portable",
        "current": str(current),
        "previous": str(current.with_name(current.name + ".previous")),
        "new": str(Path(staged) / PRODUCT_NAME),
        "staging": staged,
        "tag": tag,
    }


def _child_env() -> dict[str, str]:
    from netseer.desktop import child_env

    env = child_env()
    for name in ("APPDIR", "APPIMAGE", "ARGV0", "OWD", "NETSEER_MODE", "NETSEER_PACKAGE", "_MEIPASS2"):
        env.pop(name, None)
    return env


def spawn_helper(cmd: list[str]) -> None:
    """Start a process that outlives NetSeer."""
    if sys.platform == "win32":
        flags = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            subprocess.Popen(cmd, creationflags=flags | 0x01000000, close_fds=True, env=_child_env())  # + CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            subprocess.Popen(cmd, creationflags=flags, close_fds=True, env=_child_env())
    else:
        subprocess.Popen(cmd, start_new_session=True, close_fds=True, env=_child_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def powershell() -> str:
    root = os.environ.get("SystemRoot", r"C:\Windows")
    path = Path(root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    return str(path) if path.is_file() else "powershell.exe"


def helper_command(plan: dict, pid: int) -> list[str]:
    if sys.platform == "win32":
        script = windows_install_script(pid, plan)
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        return [powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded]
    if plan["kind"] == "portable":
        return ["/bin/sh", "-c", POSIX_PORTABLE_SCRIPT, "netseer-update", str(pid), plan["current"], plan["previous"], plan["new"], plan["staging"]]
    return ["/bin/sh", "-c", POSIX_RELAUNCH_SCRIPT, "netseer-update", str(pid), plan["target"]]


def install(spawn: Callable[[list[str]], None] = spawn_helper, quit_after: float | None = QUIT_DELAY) -> dict:
    """Hand off to the helper, then close NetSeer so it can finish."""
    reason = unsupported_reason()
    if reason:
        raise UpdateError(reason)
    plan = install_plan()
    if plan["kind"] == "appimage":
        # The running AppImage keeps its own copy open, so the file can be swapped now.
        os.replace(plan["new"], plan["target"])
    cmd = helper_command(plan, os.getpid())
    try:
        spawn(cmd)
    except OSError as exc:
        raise UpdateError(f"Couldn't start the installer ({exc}).") from exc
    log.info("Installing %s (%s); NetSeer will close and reopen", plan["tag"], plan["kind"])
    _set(status="installing")
    if quit_after is not None:
        threading.Timer(quit_after, request_quit).start()
    return status()


# ---------- Closing NetSeer ----------


def on_quit(hook: Callable[[], None]) -> None:
    """The desktop launcher registers how to close its window."""
    _quit_hooks.append(hook)


def request_quit() -> None:
    QUIT.set()
    for hook in list(_quit_hooks):
        try:
            hook()
        except Exception:  # pragma: no cover
            log.exception("Closing the window failed")

    def force() -> None:
        time.sleep(QUIT_WATCHDOG)
        log.warning("NetSeer didn't close by itself; exiting so the update can finish")
        logging.shutdown()
        os._exit(0)

    threading.Thread(target=force, daemon=True).start()
