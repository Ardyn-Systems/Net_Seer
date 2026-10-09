"""USB link for companion apps: point a plugged-in phone's 127.0.0.1:47331 at this NetSeer.

WaveTop's "USB cable" route talks to http://127.0.0.1:47331 on the phone. `adb reverse` tunnels that
port over the cable to the port NetSeer is actually listening on here, so no Wi-Fi or IP address is
involved. This watcher sets the tunnel up for every phone adb can see — which means only phones whose
owner turned on USB debugging and allowed this computer — and sets it up again after a re-plug.

It does nothing when adb isn't installed, when the user turns "Connect phones over USB" off in
Settings → Integrations, or on the public hosted copy.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading

log = logging.getLogger("netseer.usb")

# The address companion apps use on the phone side of the cable (NetSeer's documented port).
PHONE_PORT = 47331
POLL_SECONDS = 3.0

_state_lock = threading.Lock()
_state: dict = {"adb": None, "running": False, "devices": []}
_watcher: "UsbWatcher | None" = None


def find_adb() -> str | None:
    """NETSEER_ADB, then adb on PATH, then the usual Android SDK locations."""
    explicit = os.environ.get("NETSEER_ADB")
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    on_path = shutil.which("adb")
    if on_path:
        return on_path
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe"),
        os.path.join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
        os.path.join(home, "Android", "Sdk", "platform-tools", "adb"),
        os.path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    ]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def parse_devices(output: str) -> list[dict]:
    """Ready devices from `adb devices -l`: [{"serial": ..., "model": ...}]. Unauthorised ones are skipped."""
    devices = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2 or parts[1] != "device":
            continue
        model = next((p.split(":", 1)[1] for p in parts[2:] if p.startswith("model:")), parts[0])
        devices.append({"serial": parts[0], "model": model.replace("_", " ")})
    return devices


def status() -> dict:
    """For Settings → Integrations: is adb there, and which phones are linked right now."""
    with _state_lock:
        return {"adb_found": _state["adb"] is not None, "running": _state["running"], "devices": list(_state["devices"])}


class UsbWatcher(threading.Thread):
    def __init__(self, adb: str, server_port: int) -> None:
        super().__init__(name="netseer-usb", daemon=True)
        self.adb = adb
        self.server_port = server_port
        self._linked: dict[str, str] = {}  # serial -> model
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.adb, *args],
            capture_output=True,
            text=True,
            timeout=10,
            # No console window flashing up on Windows every poll.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def poll_once(self) -> None:
        from netseer import integration

        if not integration.usb_enabled():
            self._unlink_all()
            self._publish()
            return
        try:
            ready = {d["serial"]: d["model"] for d in parse_devices(self._run("devices", "-l").stdout)}
        except (OSError, subprocess.SubprocessError) as exc:
            log.debug("adb devices failed: %s", exc)
            return
        for serial, model in ready.items():
            if serial in self._linked:
                continue
            res = self._run("-s", serial, "reverse", f"tcp:{PHONE_PORT}", f"tcp:{self.server_port}")
            if res.returncode == 0:
                self._linked[serial] = model
                log.info("USB link to %s (%s): phone port %s -> NetSeer port %s", model, serial, PHONE_PORT, self.server_port)
            else:
                log.warning("adb reverse failed for %s: %s", serial, (res.stderr or res.stdout).strip())
        # A re-plugged phone loses its tunnel; forget it so it's linked again when it comes back.
        for serial in list(self._linked):
            if serial not in ready:
                self._linked.pop(serial, None)
        self._publish()

    def _unlink_all(self) -> None:
        for serial in list(self._linked):
            try:
                self._run("-s", serial, "reverse", "--remove", f"tcp:{PHONE_PORT}")
            except (OSError, subprocess.SubprocessError):
                pass
            self._linked.pop(serial, None)

    def _publish(self) -> None:
        with _state_lock:
            _state["devices"] = [{"serial": s, "model": m} for s, m in sorted(self._linked.items())]

    def run(self) -> None:
        while not self._stop.is_set():
            self.poll_once()
            self._stop.wait(POLL_SECONDS)


def start(server_port: int) -> None:
    """Start watching for phones (once per process). Quietly does nothing without adb."""
    global _watcher
    if _watcher is not None:
        return
    adb = find_adb()
    with _state_lock:
        _state["adb"] = adb
        _state["running"] = adb is not None
    if adb is None:
        log.info("adb not found: USB links for companion apps are off (network pairing still works)")
        return
    _watcher = UsbWatcher(adb, server_port)
    _watcher.start()
    log.info("Watching for phones over USB with %s", adb)
