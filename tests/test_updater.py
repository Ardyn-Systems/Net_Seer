from __future__ import annotations

import base64
import hashlib
import io
import json
import sys
import tarfile
import time
import zipfile
from pathlib import Path

import pytest

from netseer import updater

REPO_DL = "https://github.com/ardyn-systems/NetSeer/releases/download"


def release(tag: str, payload: bytes, name: str, digest: bool = True) -> dict:
    asset = {"name": name, "size": len(payload), "browser_download_url": f"{REPO_DL}/{tag}/{name}"}
    if digest:
        asset["digest"] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return {"tag_name": tag, "draft": False, "assets": [asset]}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """A frozen Windows installer build whose data folder is tmp_path."""
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    monkeypatch.setenv("NETSEER_MODE", "desktop")
    monkeypatch.setenv("NETSEER_PACKAGE", "installer")
    monkeypatch.setattr(updater, "platform_name", lambda: "windows")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater, "data_dir", lambda: tmp_path)
    updater._reset()
    yield tmp_path
    updater._reset()


def serve(monkeypatch, files: dict[str, bytes]) -> list[str]:
    calls = []

    def fake_open(url, timeout=30.0):
        calls.append(url)
        if url not in files:
            raise OSError(f"no such URL {url}")
        return FakeResponse(files[url])

    monkeypatch.setattr(updater, "_open", fake_open)
    return calls


def serve_release(monkeypatch, rel: dict, payload: bytes) -> None:
    api = updater.API_RELEASE.format(repo=updater.REPO, tag=rel["tag_name"])
    serve(monkeypatch, {api: json.dumps(rel).encode(), rel["assets"][0]["browser_download_url"]: payload})


def wait_until(predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out; state={updater.status()}")


def test_only_the_desktop_builds_update_themselves(monkeypatch):
    monkeypatch.delenv("NETSEER_MODE", raising=False)
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    assert "desktop" in updater.unsupported_reason()
    monkeypatch.setenv("NETSEER_MODE", "desktop")
    monkeypatch.setenv("NETSEER_PACKAGE", "source")
    assert "source" in updater.unsupported_reason()
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert "online" in updater.unsupported_reason()


def test_picks_the_download_for_each_kind_of_install():
    names = [
        "NetSeer-0.4.0-linux-x86_64.tar.gz",
        "NetSeer-0.4.0-windows-x64-portable.zip",
        "NetSeer-0.4.0-x86_64.AppImage",
        "NetSeer-Setup-0.4.0.exe",
        "SHA256SUMS-windows.txt",
    ]
    assets = [{"name": n} for n in names]
    assert updater.pick_asset(assets, "windows", "installer")["name"] == "NetSeer-Setup-0.4.0.exe"
    assert updater.pick_asset(assets, "windows", "portable")["name"].endswith("portable.zip")
    assert updater.pick_asset(assets, "linux", "portable")["name"].endswith(".tar.gz")
    assert updater.pick_asset(assets, "linux", "appimage")["name"].endswith(".AppImage")
    assert updater.pick_asset(assets, "linux", "installer") is None


def test_downloads_only_from_this_repos_releases():
    updater.check_download_url(f"{REPO_DL}/v0.4.0/NetSeer-Setup-0.4.0.exe")
    for bad in (
        "http://github.com/ardyn-systems/NetSeer/releases/download/x",
        "https://evil.example/ardyn-systems/NetSeer/releases/download/x",
        "https://github.com/someone/else/releases/download/x",
    ):
        with pytest.raises(updater.UpdateError):
            updater.check_download_url(bad)


def test_checksum_from_digest_or_sha256sums(monkeypatch):
    payload = b"setup"
    rel = release("v0.4.0", payload, "NetSeer-Setup-0.4.0.exe")
    assert updater.expected_sha256(rel, rel["assets"][0]) == hashlib.sha256(payload).hexdigest()

    rel = release("v0.4.0", payload, "NetSeer-Setup-0.4.0.exe", digest=False)
    sums_url = f"{REPO_DL}/v0.4.0/SHA256SUMS-windows.txt"
    rel["assets"].append({"name": "SHA256SUMS-windows.txt", "browser_download_url": sums_url})
    serve(monkeypatch, {sums_url: f"{hashlib.sha256(payload).hexdigest()}  NetSeer-Setup-0.4.0.exe\n".encode()})
    assert updater.expected_sha256(rel, rel["assets"][0]) == hashlib.sha256(payload).hexdigest()

    rel["assets"].pop()
    with pytest.raises(updater.UpdateError, match="no checksum"):
        updater.expected_sha256(rel, rel["assets"][0])


def test_download_checks_the_file_and_gets_ready(monkeypatch, desktop):
    payload = b"MZ" + b"\0" * 1000
    rel = release("v0.4.0", payload, "NetSeer-Setup-0.4.0.exe")
    serve_release(monkeypatch, rel, payload)
    updater.start("v0.4.0")
    wait_until(lambda: updater.status()["status"] in {"ready", "error"})
    s = updater.status()
    assert s["status"] == "ready" and s["done"] == len(payload) and s["asset"] == "NetSeer-Setup-0.4.0.exe"
    assert (desktop / "updates" / "NetSeer-Setup-0.4.0.exe").read_bytes() == payload
    assert "path" not in s  # local paths stay on the server side


def test_a_tampered_download_is_deleted(monkeypatch, desktop):
    rel = release("v0.4.0", b"the real one", "NetSeer-Setup-0.4.0.exe")
    serve_release(monkeypatch, rel, b"something else")
    updater.start("v0.4.0")
    wait_until(lambda: updater.status()["status"] in {"ready", "error"})
    assert updater.status()["status"] == "error" and "checksum" in updater.status()["error"]
    assert not any((desktop / "updates").iterdir())
    with pytest.raises(updater.UpdateError):
        updater.install(spawn=lambda cmd: None, quit_after=None)


def test_rejects_bad_tags(desktop):
    for tag in ("latest", "v1", "v1.2.3; rm -rf /", "../v1.2.3"):
        with pytest.raises(updater.UpdateError):
            updater.start(tag)


def test_installer_handoff_runs_setup_silently_and_reopens(monkeypatch, desktop):
    exe_dir = desktop / "Local" / "Programs" / "NetSeer"
    exe_dir.mkdir(parents=True)
    monkeypatch.setenv("LOCALAPPDATA", str(desktop / "Local"))
    monkeypatch.setattr(sys, "executable", str(exe_dir / "NetSeer.exe"))
    monkeypatch.setattr(updater.sys, "platform", "win32")
    setup = str(desktop / "updates" / "NetSeer-Setup-0.4.0.exe")
    updater._set(status="ready", tag="v0.4.0", path=setup, staged=setup)
    spawned = []
    updater.install(spawn=spawned.append, quit_after=None)
    cmd = spawned[0]
    assert cmd[0].lower().endswith("powershell.exe") and "-EncodedCommand" in cmd
    script = base64.b64decode(cmd[-1]).decode("utf-16-le")
    assert "Wait-Process -Id" in script and "NetSeer-Setup-0.4.0.exe" in script
    for flag in ("/VERYSILENT", "/SUPPRESSMSGBOXES", "/RELAUNCH=1", "/CURRENTUSER"):
        assert flag in script
    assert updater.status()["status"] == "installing"

    # Installed for all users (Program Files): upgrade for all users too.
    monkeypatch.setattr(sys, "executable", r"C:\Program Files\NetSeer\NetSeer.exe")
    assert "/ALLUSERS" in updater.installer_args(Path("x.log"))


def test_powershell_quoting_survives_apostrophes():
    plan = {"kind": "installer", "setup": "C:\\Users\\O'Brien\\setup.exe", "args": ["/LOG=C:\\Users\\O'Brien\\x.log"]}
    script = updater.windows_install_script(42, plan)
    assert "'C:\\Users\\O''Brien\\setup.exe'" in script and "O''Brien\\x.log" in script


def test_appimage_is_swapped_in_place_and_relaunched(monkeypatch, tmp_path):
    appimage = tmp_path / "NetSeer.AppImage"
    appimage.write_bytes(b"old")
    new = tmp_path / ".NetSeer-0.4.0-x86_64.AppImage.part"
    new.write_bytes(b"new")
    monkeypatch.setenv("NETSEER_MODE", "desktop")
    monkeypatch.setenv("NETSEER_PACKAGE", "appimage")
    monkeypatch.setenv("APPIMAGE", str(appimage))
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    monkeypatch.setattr(updater, "platform_name", lambda: "linux")
    monkeypatch.setattr(updater.sys, "platform", "linux")
    updater._reset()
    updater._set(status="ready", tag="v0.4.0", path=str(new), staged=str(new))
    spawned = []
    updater.install(spawn=spawned.append, quit_after=None)
    assert appimage.read_bytes() == b"new" and not new.exists()
    assert spawned[0][:2] == ["/bin/sh", "-c"] and spawned[0][-1] == str(appimage)
    updater._reset()


def test_portable_update_unpacks_beside_the_app_and_swaps_folders(monkeypatch, tmp_path):
    app = tmp_path / "apps" / "NetSeer"
    app.mkdir(parents=True)
    monkeypatch.setenv("NETSEER_MODE", "desktop")
    monkeypatch.setenv("NETSEER_PACKAGE", "portable")
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(app / "NetSeer.exe"))
    monkeypatch.setattr(updater, "platform_name", lambda: "windows")
    monkeypatch.setattr(updater, "data_dir", lambda: tmp_path / "data")
    (tmp_path / "data").mkdir()
    zpath = tmp_path / "data" / "NetSeer-0.4.0-windows-x64-portable.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("NetSeer/NetSeer.exe", b"MZ")
        zf.writestr("NetSeer/_internal/lib.dll", b"x")
    staged = updater.stage(zpath, "v0.4.0")
    assert (staged / "NetSeer" / "NetSeer.exe").read_bytes() == b"MZ" and staged.parent == app.parent
    updater._reset()
    updater._set(status="ready", tag="v0.4.0", path=str(zpath), staged=str(staged))
    plan = updater.install_plan()
    assert plan["previous"].endswith("NetSeer.previous") and plan["new"] == str(staged / "NetSeer")
    script = updater.windows_install_script(7, plan)
    assert "Move-Item" in script and "NetSeer.previous" in script
    updater._reset()


def test_unsafe_archives_are_refused(tmp_path):
    bad_zip = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad_zip, "w") as zf:
        zf.writestr("../escape.txt", b"x")
    with pytest.raises(updater.UpdateError, match="unsafe"):
        updater.safe_extract(bad_zip, tmp_path / "out")

    bad_tar = tmp_path / "bad.tar.gz"
    with tarfile.open(bad_tar, "w:gz") as tf:
        info = tarfile.TarInfo("NetSeer/evil")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        tf.addfile(info)
    with pytest.raises(updater.UpdateError, match="unsafe"):
        updater.safe_extract(bad_tar, tmp_path / "out2")

    good_tar = tmp_path / "good.tar.gz"
    with tarfile.open(good_tar, "w:gz") as tf:
        data = b"#!/bin/sh\n"
        info = tarfile.TarInfo("NetSeer/NetSeer")
        info.size = len(data)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo("NetSeer/_internal/libz.so")
        link.type = tarfile.SYMTYPE
        link.linkname = "libz.so.1"
        tf.addfile(link)
    updater.safe_extract(good_tar, tmp_path / "out3")
    assert (tmp_path / "out3" / "NetSeer" / "NetSeer").is_file()


def test_update_endpoints_answer_only_the_desktop_window(monkeypatch, desktop):
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    client = TestClient(webmod.app, base_url="http://127.0.0.1:47331")
    ok = {"X-NetSeer-Update": "1"}
    assert client.get("/api/health").json()["updater"] is True
    assert client.get("/api/update/status", headers=ok).json()["status"] == "idle"
    # No custom header: what a cross-site form or a fetch without preflight looks like.
    assert client.post("/api/update/start", json={"tag": "v0.4.0"}).status_code == 403
    # Another site's page, or a DNS-rebinding host name.
    assert client.post("/api/update/install", json={}, headers={**ok, "Origin": "https://evil.example"}).status_code == 403
    rebind = TestClient(webmod.app, base_url="http://evil.example:47331")
    assert rebind.post("/api/update/install", json={}, headers=ok).status_code == 403
    assert client.post("/api/update/install", json={}, headers=ok).status_code == 409  # nothing downloaded
    assert client.post("/api/update/start", json={"tag": "nope"}, headers=ok).status_code == 409

    monkeypatch.setenv("NETSEER_MODE", "server")
    assert client.get("/api/health").json()["updater"] is False
    assert client.post("/api/update/start", json={"tag": "v0.4.0"}, headers=ok).status_code == 403
