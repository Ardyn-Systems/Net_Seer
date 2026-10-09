"""Request checks (host + same-origin), the pairing wrong-code limit, and the USB link."""

from __future__ import annotations

import subprocess

from fastapi.testclient import TestClient

from netseer import usb


def _client(monkeypatch, tmp_path, base_url="http://localhost"):
    monkeypatch.setenv("NETSEER_INTEGRATION_DIR", str(tmp_path / "integration"))
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    import netseer.web as webmod

    return webmod, TestClient(webmod.app, base_url=base_url)


# --- Host check -----------------------------------------------------------------------------


def test_requests_for_another_host_are_refused(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    assert client.get("/api/health").status_code == 200
    res = client.get("/api/health", headers={"host": "attacker.example:47331"})
    assert res.status_code == 403
    assert res.json()["detail"] == "Unknown host."


def test_loopback_names_are_accepted(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    for host in ("127.0.0.1:47331", "localhost:47331", "[::1]:47331", "127.0.0.1"):
        assert client.get("/api/health", headers={"host": host}).status_code == 200, host


def test_hosted_copy_skips_the_host_check(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert client.get("/api/health", headers={"host": "netseer.onrender.com"}).status_code == 200


def test_host_names_parse(monkeypatch):
    import netseer.web as webmod

    assert webmod._host_name("127.0.0.1:47331") == "127.0.0.1"
    assert webmod._host_name("[::1]:47331") == "[::1]"
    assert webmod._host_name("LocalHost") == "localhost"


# --- Same-origin check for changes -----------------------------------------------------------


def test_changes_from_another_site_are_refused(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    res = client.post("/api/heartbeat", headers={"origin": "https://attacker.example"})
    assert res.status_code == 403
    assert client.post("/api/heartbeat", headers={"origin": "null"}).status_code == 403


def test_changes_from_netseers_own_page_and_from_apps_are_accepted(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    # NetSeer's page: same scheme-less host:port as the request.
    assert client.post("/api/heartbeat", headers={"origin": "http://localhost"}).status_code == 204
    # Companion apps and tools send no Origin at all.
    assert client.post("/api/heartbeat").status_code == 204


def test_reads_from_another_site_are_not_blocked_by_the_origin_rule(monkeypatch, tmp_path):
    # GETs don't change anything; the browser's same-origin policy already hides their responses.
    _, client = _client(monkeypatch, tmp_path)
    assert client.get("/api/health", headers={"origin": "https://attacker.example"}).status_code == 200


# --- Pairing wrong-code limit ----------------------------------------------------------------


def _start(client):
    res = client.post("/api/v1/pair/start", headers={"x-netseer-window": "1"})
    assert res.status_code == 200, res.text
    return res.json()["code"]


def test_too_many_wrong_codes_cancel_the_live_code(monkeypatch, tmp_path):
    from netseer import integration

    _, client = _client(monkeypatch, tmp_path)
    code = _start(client)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(integration.MAX_PAIRING_FAILURES):
        assert client.post("/api/v1/pair", json={"code": wrong, "device_name": "x"}).status_code == 400
    res = client.post("/api/v1/pair", json={"code": code, "device_name": "WaveTop"})
    assert res.status_code == 400, "the real code is cancelled after too many wrong guesses"
    assert "Start a new one" in res.json()["detail"]
    # A fresh code works.
    fresh = _start(client)
    assert client.post("/api/v1/pair", json={"code": fresh, "device_name": "WaveTop"}).status_code == 200


def test_a_few_typos_still_pair(monkeypatch, tmp_path):
    from netseer import integration

    _, client = _client(monkeypatch, tmp_path)
    code = _start(client)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(integration.MAX_PAIRING_FAILURES - 1):
        client.post("/api/v1/pair", json={"code": wrong, "device_name": "x"})
    assert client.post("/api/v1/pair", json={"code": code, "device_name": "WaveTop"}).status_code == 200


# --- USB link (adb reverse) -----------------------------------------------------------------


ADB_DEVICES = (
    "List of devices attached\n"
    "5C091JEA321596         device product:stallion model:Pixel_10a device:stallion transport_id:3\n"
    "emulator-5554          device product:sdk_gphone model:sdk_gphone_x86_64 device:emu transport_id:2\n"
    "R58N0000000            unauthorized usb:1-1 transport_id:4\n"
)


def test_parse_devices_skips_unauthorised_phones():
    assert usb.parse_devices(ADB_DEVICES) == [
        {"serial": "5C091JEA321596", "model": "Pixel 10a"},
        {"serial": "emulator-5554", "model": "sdk gphone x86 64"},
    ]


class FakeAdb:
    def __init__(self, devices_output):
        self.devices_output = devices_output
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        out = self.devices_output if args[:1] == ("devices",) else ""
        return subprocess.CompletedProcess(args, 0, stdout=out, stderr="")


def test_watcher_links_each_phone_once_to_the_server_port(monkeypatch, tmp_path):
    monkeypatch.setenv("NETSEER_INTEGRATION_DIR", str(tmp_path / "integration"))
    watcher = usb.UsbWatcher("adb", server_port=51234)
    fake = FakeAdb(ADB_DEVICES)
    monkeypatch.setattr(watcher, "_run", fake)
    watcher.poll_once()
    watcher.poll_once()
    reverses = [c for c in fake.calls if "reverse" in c]
    assert reverses == [
        ("-s", "5C091JEA321596", "reverse", "tcp:47331", "tcp:51234"),
        ("-s", "emulator-5554", "reverse", "tcp:47331", "tcp:51234"),
    ], "each phone is linked once, phone port 47331 -> NetSeer's actual port"
    # Unplugged, then plugged back in: linked again.
    fake.devices_output = "List of devices attached\n"
    watcher.poll_once()
    fake.devices_output = ADB_DEVICES
    watcher.poll_once()
    assert len([c for c in fake.calls if "reverse" in c]) == 4


def test_watcher_does_nothing_when_turned_off(monkeypatch, tmp_path):
    from netseer import integration

    monkeypatch.setenv("NETSEER_INTEGRATION_DIR", str(tmp_path / "integration"))
    integration.set_usb_enabled(False)
    watcher = usb.UsbWatcher("adb", server_port=51234)
    fake = FakeAdb(ADB_DEVICES)
    monkeypatch.setattr(watcher, "_run", fake)
    watcher.poll_once()
    assert not [c for c in fake.calls if "reverse" in c and "--remove" not in c]


def test_network_endpoint_reports_and_toggles_usb(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    headers = {"x-netseer-window": "1"}
    state = client.get("/api/v1/network", headers=headers).json()
    assert state["usb_enabled"] is True
    assert set(state["usb"]) >= {"adb_found", "devices"}
    off = client.post("/api/v1/network", headers=headers, json={"usb_enabled": False}).json()
    assert off["usb_enabled"] is False
    assert off["enabled"] is False, "changing USB leaves network sharing alone"
