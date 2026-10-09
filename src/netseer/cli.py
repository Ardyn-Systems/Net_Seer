from __future__ import annotations

import argparse
import os

import uvicorn

from netseer import integration
from netseer.brand import MOTTO, PRODUCT_NAME


# Loopback by default: the API writes files and has no auth. Use --host 0.0.0.0 to share on a LAN.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 47331


def default_port() -> int:
    # Hosting platforms (Render, Railway, Fly, Heroku-style) say which port to use in $PORT.
    try:
        return int(os.environ.get("PORT", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="netseer",
        description=f"{PRODUCT_NAME} web preview — {MOTTO} Ingest pcap/Kismet/airodump/WiGLE surveys and map them.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="Bind address (default 127.0.0.1; 0.0.0.0 exposes it to the LAN)")
    parser.add_argument("--port", type=int, default=default_port(), help="Bind port (default $PORT, else 47331)")
    args = parser.parse_args()
    host = args.host
    # Honor "Allow devices on my network" (Settings → Integrations) unless --host was given or this
    # is the public hosted copy. The LAN guard in web.py still limits non-local clients to the API.
    hosted = os.environ.get("NETSEER_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}
    if host == DEFAULT_HOST and not hosted and integration.lan_enabled():
        host = "0.0.0.0"
    os.environ["NETSEER_BOUND_HOST"] = host
    if not hosted and not os.environ.get("NETSEER_NO_USB"):
        # Plugged-in phones (USB debugging allowed) reach this NetSeer at their own 127.0.0.1:47331.
        from netseer import usb

        usb.start(args.port)
    uvicorn.run("netseer.web:app", host=host, port=args.port, log_level="info")
