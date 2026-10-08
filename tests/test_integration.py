"""Integration API: pairing and the capture-push endpoint (docs/integration-api.md)."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from netseer.samples import files_for_sample


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("NETSEER_INTEGRATION_DIR", str(tmp_path / "integration"))
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    import netseer.web as webmod

    # base_url on a local host so the own-window guard (127.0.0.1/localhost) is satisfied.
    return webmod, TestClient(webmod.app, base_url="http://localhost")


def _client_at(monkeypatch, tmp_path, client_addr):
    monkeypatch.setenv("NETSEER_INTEGRATION_DIR", str(tmp_path / "integration"))
    monkeypatch.delenv("NETSEER_HOSTED", raising=False)
    import netseer.web as webmod

    return webmod, TestClient(webmod.app, base_url="http://localhost", client=client_addr)


def _pair(client, name="WaveTop"):
    start = client.post("/api/v1/pair/start", headers={"x-netseer-window": "1"})
    assert start.status_code == 200, start.text
    code = start.json()["code"]
    res = client.post("/api/v1/pair", json={"code": code, "device_name": name})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def test_info_advertises_capture_push(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    info = client.get("/api/v1/info").json()
    assert "ingest.capture" in info["capabilities"]
    assert "pcap" in info["formats"] and info["api"] == 1


def test_pairing_is_window_only_and_code_is_single_use(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    # A page that isn't NetSeer's own window can't mint a code.
    assert client.post("/api/v1/pair/start").status_code == 403
    # A wrong/expired code can't be redeemed.
    assert client.post("/api/v1/pair", json={"code": "000000"}).status_code == 400
    # A real code works once, then is spent.
    code = client.post("/api/v1/pair/start", headers={"x-netseer-window": "1"}).json()["code"]
    assert client.post("/api/v1/pair", json={"code": code}).status_code == 200
    assert client.post("/api/v1/pair", json={"code": code}).status_code == 400


def test_capture_push_requires_a_token(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    _, data = files_for_sample("office-lan")[0]
    r = client.post("/api/v1/ingest/capture", headers={"x-netseer-format": "pcap"}, content=data)
    assert r.status_code == 401


def test_capture_push_parses_into_a_graph(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    token = _pair(client)
    _, data = files_for_sample("office-lan")[0]
    r = client.post(
        "/api/v1/ingest/capture",
        headers={"authorization": f"Bearer {token}", "x-netseer-format": "pcap", "x-netseer-name": "Drive A"},
        content=data,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "WaveTop" and body["name"] == "Drive A.pcap"
    job_id = body["id"]
    # It becomes a normal reading job the existing pipeline finishes.
    for _ in range(100):
        status = client.get(f"/api/parse/jobs/{job_id}").json()
        if status["state"] != "running":
            break
        time.sleep(0.05)
    assert status["state"] == "done"
    result = client.get(f"/api/parse/jobs/{job_id}/result").json()
    assert result["nodes"]


def test_unsupported_format_is_rejected(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    token = _pair(client)
    r = client.post(
        "/api/v1/ingest/capture",
        headers={"authorization": f"Bearer {token}", "x-netseer-format": "docx"},
        content=b"x",
    )
    assert r.status_code == 400


def test_revoked_token_stops_working(monkeypatch, tmp_path):
    webmod, client = _client(monkeypatch, tmp_path)
    from netseer import integration

    token = _pair(client)
    devices = integration.list_devices()
    assert len(devices) == 1
    assert integration.revoke(devices[0]["id"]) is True
    _, data = files_for_sample("office-lan")[0]
    r = client.post(
        "/api/v1/ingest/capture",
        headers={"authorization": f"Bearer {token}", "x-netseer-format": "pcap"},
        content=data,
    )
    assert r.status_code == 401


def test_hosted_copy_disables_integration(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    assert client.get("/api/v1/info").status_code == 404
    assert client.post("/api/v1/pair", json={"code": "123456"}).status_code == 404


def test_devices_list_and_revoke_are_window_only(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    # Device management only answers NetSeer's own window.
    assert client.get("/api/v1/devices").status_code == 403
    _pair(client, name="Phone")
    win = {"x-netseer-window": "1"}
    devices = client.get("/api/v1/devices", headers=win).json()["devices"]
    assert len(devices) == 1 and devices[0]["name"] == "Phone"
    device_id = devices[0]["id"]
    assert client.request("DELETE", f"/api/v1/devices/{device_id}", headers=win).status_code == 204
    assert client.get("/api/v1/devices", headers=win).json()["devices"] == []
    assert client.request("DELETE", f"/api/v1/devices/{device_id}", headers=win).status_code == 404


def test_events_channel_announces_a_pushed_capture(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    token = _pair(client)
    _, data = files_for_sample("office-lan")[0]
    with client.websocket_connect("/api/v1/events") as ws:
        r = client.post(
            "/api/v1/ingest/capture",
            headers={"authorization": f"Bearer {token}", "x-netseer-format": "pcap", "x-netseer-name": "Live drive"},
            content=data,
        )
        assert r.status_code == 200, r.text
        evt = ws.receive_json()
    assert evt["type"] == "capture-received"
    assert evt["source"] == "WaveTop" and evt["name"] == "Live drive.pcap"
    assert evt["job_id"] == r.json()["id"]


def test_events_channel_closed_on_hosted_copy(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    monkeypatch.setenv("NETSEER_HOSTED", "1")
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/events") as ws:
            ws.receive_text()


def test_network_setting_is_window_only(monkeypatch, tmp_path):
    _, client = _client(monkeypatch, tmp_path)
    assert client.get("/api/v1/network").status_code == 403
    win = {"x-netseer-window": "1"}
    assert client.get("/api/v1/network", headers=win).json()["enabled"] is False
    res = client.post("/api/v1/network", json={"enabled": True}, headers=win).json()
    assert res["enabled"] is True
    from netseer import integration

    assert integration.lan_enabled() is True


def test_lan_guard_limits_non_local_clients(monkeypatch, tmp_path):
    monkeypatch.setenv("NETSEER_BOUND_HOST", "0.0.0.0")
    _, remote = _client_at(monkeypatch, tmp_path, ("192.168.1.9", 5000))
    # LAN sharing off: a non-local client is blocked everywhere.
    assert remote.get("/").status_code == 403
    assert remote.get("/api/v1/info").status_code == 403
    from netseer import integration

    integration.set_lan_enabled(True)
    # On: a non-local client reaches discovery/pairing/ingest only.
    assert remote.get("/api/v1/info").status_code == 200
    assert remote.get("/").status_code == 403  # the UI stays local-only
    assert remote.get("/api/v1/devices", headers={"x-netseer-window": "1"}).status_code == 403  # management too
    # A local client still reaches everything.
    _, local = _client_at(monkeypatch, tmp_path, ("127.0.0.1", 5000))
    assert local.get("/api/health").status_code == 200
    assert local.get("/").status_code == 200


def test_lan_guard_inactive_on_loopback_bind(monkeypatch, tmp_path):
    monkeypatch.setenv("NETSEER_BOUND_HOST", "127.0.0.1")
    _, remote = _client_at(monkeypatch, tmp_path, ("192.168.1.9", 5000))
    # Bound to loopback, the guard is a no-op (nothing remote can really connect anyway).
    assert remote.get("/api/v1/info").status_code == 200
