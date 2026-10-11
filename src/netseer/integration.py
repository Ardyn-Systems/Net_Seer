"""Local integration hub: let companion apps (WaveTop first) talk to a running NetSeer.

This is the auth half of the integration API (see docs/integration-api.md). A device pairs once
with a short code NetSeer shows in its own window, and gets a long-lived token it then sends on
every request. Tokens are stored hashed, so the file on disk never holds a usable secret.

The capture-push and live-view endpoints live in web.py and gate on verify_token().
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from netseer import firewall

# Carrier-grade NAT range (RFC 6598); Tailscale hands out addresses from it.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")

API_VERSION = 1
# What this build can do, advertised by GET /api/v1/info so clients can feature-detect.
CAPABILITIES = ["ingest.capture"]
SUPPORTED_FORMATS = ["pcap", "pcapng", "kismet", "netxml", "csv", "airodump"]

PAIRING_TTL_SECONDS = 5 * 60
_CODE_CHARS = "0123456789"
# Wrong codes allowed while a code is live. One more cancels every live code, so a code can't be
# found by trying them all; the user just starts a new one from NetSeer's window.
MAX_PAIRING_FAILURES = 5

_lock = threading.Lock()
# code -> expiry (time.monotonic); a code pairs exactly one device, then is spent.
_pending: dict[str, float] = {}
_failures = 0


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


SETTINGS_DEFAULTS = {"lan_enabled": False, "usb_enabled": True}


def settings() -> dict:
    try:
        data = json.loads(_settings_path().read_text("utf-8"))
    except (OSError, ValueError):
        data = {}
    return {**SETTINGS_DEFAULTS, **(data if isinstance(data, dict) else {})}


def lan_enabled() -> bool:
    """Whether the user has opted to let devices on the local network reach the integration API."""
    return bool(settings().get("lan_enabled"))


def usb_enabled() -> bool:
    """Whether NetSeer links plugged-in phones over USB (adb reverse) for companion apps. On by default."""
    return bool(settings().get("usb_enabled", True))


def set_usb_enabled(on: bool) -> dict:
    with _lock:
        data = settings()
        data["usb_enabled"] = bool(on)
        tmp = _settings_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(_settings_path())
    return data


def set_lan_enabled(on: bool) -> dict:
    with _lock:
        data = settings()
        data["lan_enabled"] = bool(on)
        tmp = _settings_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(_settings_path())
    return data


def _probe_source_ip(dest: str) -> str | None:
    """The source IPv4 the OS would use to reach dest — without sending anything. None on failure."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect((dest, 1))  # a routed-but-unanswered address; connect() just picks the route
            return probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return None


def _in_cgnat(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip) in _CGNAT
    except ValueError:
        return False


def _usable_addr(ip: str) -> bool:
    return bool(ip) and not ip.startswith("127.") and not ip.startswith("169.254.")  # no loopback/link-local


def lan_addresses() -> list[str]:
    """This machine's addresses a companion app might reach NetSeer on — remote overlay (Tailscale)
    first, then LAN. Loopback and link-local are excluded.

    A Tailscale address (100.64.0.0/10) can be missed by the hostname lookup, so we also ask the OS
    which source IP it would use to reach that range (Tailscale installs a route for it); the phone
    can only reach any of these when NetSeer is shared on the network (bound to 0.0.0.0).
    """
    remote: list[str] = []
    lan: set[str] = set()

    def add(ip: str | None) -> None:
        if not ip or not _usable_addr(ip):
            return
        if _in_cgnat(ip):
            if ip not in remote:
                remote.append(ip)  # remote overlays go first, so the phone tries them before LAN
        else:
            lan.add(ip)

    add(_probe_source_ip("100.100.100.100"))  # Tailscale CGNAT range, routed via its interface
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass
    add(_probe_source_ip("192.0.2.1"))  # TEST-NET-1: the default outbound interface
    return remote + sorted(lan)


def instance_name() -> str:
    """A friendly name for this NetSeer, so a companion app can show which one it's pairing with."""
    try:
        return socket.gethostname() or "NetSeer"
    except OSError:
        return "NetSeer"


_firewall_pending = False


def ensure_firewall_async() -> None:
    """When the user shares NetSeer on the network, make sure Windows Firewall lets the sidecar in.

    Adds a program-scoped inbound allow rule with a UAC prompt, off the request thread. A no-op unless
    we're the packaged Windows app and no rule is present yet, so it's safe to call on every toggle-on.
    """
    global _firewall_pending
    if not firewall.supported() or _firewall_pending or firewall.rule_present():
        return
    _firewall_pending = True

    def run() -> None:
        global _firewall_pending
        try:
            firewall.add_rule_elevated()
        finally:
            _firewall_pending = False

    threading.Thread(target=run, name="netseer-firewall", daemon=True).start()


def firewall_state() -> dict:
    """What Settings → Integrations needs to show about the Windows Firewall rule."""
    if not firewall.is_windows():
        return {"supported": False, "present": True, "hint": False}
    present = firewall.rule_present()
    return {
        "supported": firewall.supported(),
        "present": present,
        "pending": _firewall_pending,
        # Nudge only when sharing is on but nothing is allowing NetSeer in (declined UAC, zip build, …).
        "hint": bool(lan_enabled() and not present and not _firewall_pending),
        "command": firewall.manual_command(),
    }


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
    global _failures
    code = "".join(secrets.choice(_CODE_CHARS) for _ in range(6))
    with _lock:
        _prune_pending(now)
        _pending[code] = now + PAIRING_TTL_SECONDS
        _failures = 0
    return {"code": code, "expires_in": PAIRING_TTL_SECONDS}


def redeem_pairing(code: str, device_name: str) -> dict | None:
    """Spend a pairing code for a new device token. Returns None if the code is wrong or expired.

    After MAX_PAIRING_FAILURES wrong codes, every live code is cancelled.
    """
    global _failures
    now = time.monotonic()
    code = (code or "").strip()
    name = (device_name or "device").strip()[:80] or "device"
    with _lock:
        _prune_pending(now)
        if code not in _pending:
            if _pending:
                _failures += 1
                if _failures >= MAX_PAIRING_FAILURES:
                    _pending.clear()
            return None
        _pending.pop(code, None)
        _failures = 0
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
