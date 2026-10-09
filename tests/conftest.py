"""Shared test setup."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _accept_testclient_host(monkeypatch):
    """FastAPI's TestClient addresses requests to "testserver"; let the host check accept it.

    Real copies only answer loopback and this machine's own addresses (see request_guard in web.py).
    """
    monkeypatch.setenv("NETSEER_ALLOWED_HOSTS", "testserver")
    # Tests never shell out to adb.
    monkeypatch.setenv("NETSEER_NO_USB", "1")
