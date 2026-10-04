from __future__ import annotations

import argparse

import uvicorn

from netseer.brand import MOTTO, PRODUCT_NAME


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 47331


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="netseer",
        description=f"{PRODUCT_NAME} web preview — {MOTTO} Ingest pcap/Kismet/airodump surveys and map them.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="Bind address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Bind port (default 47331)")
    args = parser.parse_args()
    uvicorn.run("netseer.web:app", host=args.host, port=args.port, log_level="info")
