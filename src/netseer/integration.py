"""Local integration hub: let companion apps (WaveTop first) talk to a running NetSeer.

This is the auth half of the integration API (see docs/integration-api.md). A device pairs once
with a short code NetSeer shows in its own window, and gets a long-lived token it then sends on
every request. Tokens are stored hashed, so the file on disk never holds a usable secret.

The capture-push and live-view endpoints live in web.py and gate on verify_token().
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path

API_VERSION = 1
# What this build can do, advertised by GET /api/v1/info so clients can feature-detect.
CAPABILITIES = ["ingest.capture"]
SUPPORTED_FORMATS = ["pcap", "pcapng", "kismet", "netxml", "csv", "airodump"]

PAIRING_TTL_SECONDS = 5 * 60
_CODE_CHARS = "0123456789"

_lock = threading.Lock()
# code -> expiry (time.monotonic); a code pairs exactly one device, then is spent.
_pending: dict[str, float] = {}


def integration_dir() -> Path:
    override = os.environ.get("NETSEER_INTEGRATION_DIR")
    if override:
        path = Path(override).expanduser()
    else:
        from netseer.paths import data_dir

        path = data_dir() / "integration"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _store() -> Path:
    return integration_dir() / "devices.json"


def _settings_path() -> Path:
    return integration_dir() / "settings.json"


SETTINGS_DEFAULTS = {"lan_enabled": False}


def settings() -> dict:
    try:
        data = json.loads(_settings_path().read_text("utf-8"))
    except (OSError, ValueError):
        data = {}
    return {**SETTINGS_DEFAULTS, **(data if isinstance(data, dict) else {})}


def lan_enabled() -> bool:
    """Whether the user has opted to let devices on the local network reach the integration API."""
    return bool(settings().get("lan_enabled"))


def set_lan_enabled(on: bool) -> dict:
    with _lock:
        data = settings()
        data["lan_enabled"] = bool(on)
        tmp = _settings_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(_settings_path())
    return data


def lan_addresses() -> list[str]:
    """This machine's non-loopback IPv4 addresses, for telling a companion app where to reach NetSeer."""
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    try:  # the primary outbound interface, even when the hostname doesn't resolve to it
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 1))  # TEST-NET-1: routed but never answered, so nothing is sent
        ip = probe.getsockname()[0]
        probe.close()
        if not ip.startswith("127."):
            ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass
class Device:
    id: str
    name: str
    token_hash: str
    created: float
    last_used: float | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "created": self.created,
            "last_used": self.last_used,
        }


def _load() -> list[Device]:
    try:
        raw = json.loads(_store().read_text("utf-8"))
    except (OSError, ValueError):
        return []
    out: list[Device] = []
    for row in raw if isinstance(raw, list) else []:
        try:
            out.append(Device(row["id"], row["name"], row["token_hash"], row["created"], row.get("last_used")))
        except (KeyError, TypeError):
            continue
    return out


def _save(devices: list[Device]) -> None:
    tmp = _store().with_suffix(".tmp")
    tmp.write_text(json.dumps([d.__dict__ for d in devices], indent=2), "utf-8")
    tmp.replace(_store())


def _prune_pending(now: float) -> None:
    for code, expiry in list(_pending.items()):
        if expiry <= now:
            _pending.pop(code, None)


def start_pairing() -> dict:
    """Create a one-time pairing code for NetSeer to show in its own window."""
    now = time.monotonic()
    code = "".join(secrets.choice(_CODE_CHARS) for _ in range(6))
    with _lock:
        _prune_pending(now)
        _pending[code] = now + PAIRING_TTL_SECONDS
    return {"code": code, "expires_in": PAIRING_TTL_SECONDS}


def redeem_pairing(code: str, device_name: str) -> dict | None:
    """Spend a pairing code for a new device token. Returns None if the code is wrong or expired."""
    now = time.monotonic()
    code = (code or "").strip()
    name = (device_name or "device").strip()[:80] or "device"
    with _lock:
        _prune_pending(now)
        if code not in _pending:
            return None
        _pending.pop(code, None)
        token = secrets.token_urlsafe(32)
        device = Device(id=secrets.token_hex(8), name=name, token_hash=_hash(token), created=time.time())
        devices = _load()
        devices.append(device)
        _save(devices)
    return {"token": token, "api_version": API_VERSION, "device": device.public()}


def verify_token(token: str) -> Device | None:
    """Return the device for a bearer token, or None. Updates last_used on a hit."""
    if not token:
        return None
    wanted = _hash(token.strip())
    with _lock:
        devices = _load()
        for device in devices:
            if secrets.compare_digest(device.token_hash, wanted):
                device.last_used = time.time()
                _save(devices)
                return device
    return None


def list_devices() -> list[dict]:
    return [d.public() for d in _load()]


def revoke(device_id: str) -> bool:
    with _lock:
        devices = _load()
        kept = [d for d in devices if d.id != device_id]
        if len(kept) == len(devices):
            return False
        _save(kept)
    return True


# Map the X-NetSeer-Format header to the extension the parser detects by.
FORMAT_EXTENSIONS = {
    "pcap": ".pcap",
    "pcapng": ".pcapng",
    "kismet": ".kismet",
    "netxml": ".netxml",
    "csv": ".csv",
    "airodump": ".csv",
}


def filename_for(fmt: str, name: str | None) -> str | None:
    """A filename whose extension lets the parser detect fmt, or None if fmt is unknown."""
    ext = FORMAT_EXTENSIONS.get((fmt or "").strip().lower())
    if ext is None:
        return None
    stem = (name or "").strip() or "capture"
    stem = stem[:-len(ext)] if stem.lower().endswith(ext) else stem
    return f"{stem}{ext}"
