"""Build the known-vulnerability database bundled with NetSeer.

    python tools/make_vulndb.py         # writes src/netseer/data/vulndb.json.gz

Run before a release so the offline copy is current. Set NVD_API_KEY to go faster (NVD allows
5 requests per 30 seconds without one). Downloads from NVD, FIRST EPSS, and CISA KEV.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from netseer.security import fetch, vulndb  # noqa: E402


def main() -> int:
    began = time.time()
    db = fetch.build(progress=lambda what, done, total: print(f"[{done}/{total}] {what}", flush=True))
    vulndb.write(vulndb.BUNDLED, db)
    info = vulndb.summary(db)
    size = vulndb.BUNDLED.stat().st_size / 1024
    print(f"Wrote {vulndb.BUNDLED.name}: {info['vulnerabilities']} vulnerabilities for {info['products']} products, {size:.0f} KB, in {time.time() - began:.0f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
