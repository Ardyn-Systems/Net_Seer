"""Download known vulnerabilities for the products NetSeer recognizes.

Three public sources, asked only for product names (never anything about your maps):

- NVD (services.nvd.nist.gov): the CVEs filed for each product, with their CVSS scores and the
  versions they affect.
- FIRST EPSS (epss.empiricalsecurity.com): each CVE's estimated chance of being exploited in the
  wild in the next 30 days. One file covers every CVE.
- CISA KEV (cisa.gov): CVEs known to have been exploited.

The same code builds the copy bundled with a release (tools/make_vulndb.py) and the one
Settings → Security → Update downloads.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from netseer.brand import USER_AGENT
from netseer.security.software import ALL_CPES

NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
NVD_CPE_URL = "https://services.nvd.nist.gov/rest/json/cpes/2.0"
EPSS_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"
KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
PAGE = 2000
SUMMARY_CHARS = 280

Progress = Callable[[str, int, int], None]


class Stopped(Exception):
    pass


def _get(url: str, *, headers: dict[str, str] | None = None, tries: int = 5, timeout: float = 90) -> bytes:
    wait = 8.0
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as exc:
            # NVD answers 403/429/503 when asked too fast; wait and ask again.
            if exc.code in (403, 429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(wait)
                wait *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(wait)
                wait *= 2
                continue
            raise
    raise RuntimeError(f"Couldn't download {url}")


def _summary(cve: dict[str, Any]) -> str:
    text = next((d.get("value", "") for d in cve.get("descriptions") or [] if d.get("lang") == "en"), "")
    text = " ".join(text.split())
    return text if len(text) <= SUMMARY_CHARS else text[: SUMMARY_CHARS - 1].rsplit(" ", 1)[0] + "…"


def _score(cve: dict[str, Any]) -> tuple[float | None, str]:
    metrics = cve.get("metrics") or {}
    for key in ("cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        items = metrics.get(key) or []
        if not items:
            continue
        primary = next((m for m in items if m.get("type") == "Primary"), items[0])
        data = primary.get("cvssData") or {}
        score = data.get("baseScore")
        severity = data.get("baseSeverity") or primary.get("baseSeverity") or ""
        return (float(score) if score is not None else None), str(severity).upper()
    return None, ""


def _matches(cve: dict[str, Any], cpe: str) -> tuple[list[list[Any]], list[str]]:
    """Version ranges and exact versions of this product that the CVE says are vulnerable."""
    prefix = f"cpe:2.3:a:{cpe}:"
    ranges: list[list[Any]] = []
    versions: list[str] = []
    for config in cve.get("configurations") or []:
        for node in config.get("nodes") or []:
            for match in node.get("cpeMatch") or []:
                crit = str(match.get("criteria") or "")
                if not match.get("vulnerable") or not crit.startswith(prefix):
                    continue
                parts = crit.split(":")
                version, update = (parts[5] if len(parts) > 5 else "*"), (parts[6] if len(parts) > 6 else "*")
                if version not in ("*", "-", ""):
                    versions.append(version + (update if update not in ("*", "-", "") else ""))
                    continue
                start_i, start_x = match.get("versionStartIncluding"), match.get("versionStartExcluding")
                end_i, end_x = match.get("versionEndIncluding"), match.get("versionEndExcluding")
                if not (start_i or start_x or end_i or end_x):
                    continue  # "every version": too vague to match on
                ranges.append([start_i or start_x or "", bool(start_i), end_i or end_x or "", bool(end_i)])
    return ranges, sorted(set(versions))


def fetch_product(cpe: str, *, api_key: str | None = None, pause: float | None = None, should_stop: Callable[[], bool] | None = None) -> list[dict[str, Any]]:
    vendor, product = cpe.split(":", 1)
    headers = {"apiKey": api_key} if api_key else {}
    pause = pause if pause is not None else (0.8 if api_key else 6.5)  # NVD: 5 requests / 30 s without a key
    entries: list[dict[str, Any]] = []
    start = 0
    while True:
        if should_stop and should_stop():
            raise Stopped
        query = urllib.parse.urlencode({"virtualMatchString": f"cpe:2.3:a:{vendor}:{product}", "resultsPerPage": PAGE, "startIndex": start})
        data = json.loads(_get(f"{NVD_URL}?{query}", headers=headers))
        for item in data.get("vulnerabilities") or []:
            cve = item.get("cve") or {}
            if str(cve.get("vulnStatus", "")).lower() == "rejected":
                continue
            ranges, versions = _matches(cve, cpe)
            if not ranges and not versions:
                continue
            cvss, severity = _score(cve)
            entries.append({
                "id": cve.get("id"),
                "summary": _summary(cve),
                "cvss": cvss,
                "severity": severity,
                "published": str(cve.get("published") or "")[:10],
                "ranges": ranges,
                "versions": versions,
            })
        start += int(data.get("resultsPerPage") or PAGE)
        time.sleep(pause)
        if start >= int(data.get("totalResults") or 0):
            return entries


def _norm(s: str) -> str:
    return "".join(c for c in str(s).lower() if c.isalnum())


def _related(token: str, product: str) -> bool:
    """Whether a banner token and an NVD product name plausibly name the same thing."""
    if len(token) < 3 or not product:
        return False
    if token in product or product in token:
        return True
    # A shared leading run handles "goahead-webs" vs "goahead_webserver", "lighttpd" vs "lighttpd".
    lcp = 0
    for a, b in zip(token, product):
        if a != b:
            break
        lcp += 1
    return lcp >= 4 and lcp / min(len(token), len(product)) >= 0.6


def resolve_cpes(name: str, *, api_key: str | None = None) -> list[str]:
    """Ask NVD what application a product name is, as up to two "vendor:product" keys.

    Only keeps candidates whose product name clearly relates to the one seen, so a vague banner
    doesn't pull in an unrelated product. Returns [] when nothing matches confidently.
    """
    headers = {"apiKey": api_key} if api_key else {}
    token = _norm(name)
    # NVD's keyword search is picky about separators: "GoAhead-Webs" finds nothing, but
    # "GoAhead Webs" or "GoAhead" does. Try a few forms, keeping only related products.
    import re

    spaced = re.sub(r"[^A-Za-z0-9]+", " ", name).strip()
    first = spaced.split(" ")[0] if spaced else name
    for query_text in dict.fromkeys([name, spaced, first]):
        if not query_text:
            continue
        query = urllib.parse.urlencode({"keywordSearch": query_text, "resultsPerPage": 80})
        try:
            data = json.loads(_get(f"{NVD_CPE_URL}?{query}", headers=headers, tries=3))
        except Exception:
            continue
        counts: dict[tuple[str, str], int] = {}
        for item in data.get("products") or []:
            parts = str((item.get("cpe") or {}).get("cpeName") or "").split(":")
            if len(parts) > 4 and parts[2] == "a":  # applications only, not OSes or hardware
                counts[(parts[3], parts[4])] = counts.get((parts[3], parts[4]), 0) + 1
        related = [vp for vp in sorted(counts, key=lambda k: -counts[k]) if _related(token, _norm(vp[1]))]
        if related:
            return [f"{v}:{p}" for v, p in related[:2]]
    return []


def fetch_epss(ids: set[str]) -> tuple[dict[str, tuple[float, float]], str]:
    raw = gzip.decompress(_get(EPSS_URL, timeout=180)).decode("utf-8", errors="replace")
    date = ""
    out: dict[str, tuple[float, float]] = {}
    lines = raw.splitlines()
    if lines and lines[0].startswith("#"):
        for part in lines[0].lstrip("#").split(","):
            if part.startswith("score_date:"):
                date = part.split(":", 1)[1][:10]
        lines = lines[1:]
    for row in csv.DictReader(io.StringIO("\n".join(lines))):
        cve = row.get("cve")
        if cve in ids:
            try:
                out[cve] = (float(row["epss"]), float(row["percentile"]))
            except (KeyError, ValueError):
                pass
    return out, date


def fetch_kev() -> tuple[set[str], str]:
    data = json.loads(_get(KEV_URL, timeout=120))
    return {v.get("cveID") for v in data.get("vulnerabilities") or [] if v.get("cveID")}, str(data.get("dateReleased") or "")[:10]


def build(
    progress: Progress | None = None,
    should_stop: Callable[[], bool] | None = None,
    cpes: tuple[str, ...] = ALL_CPES,
    extra_products: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Everything, as a database ``vulndb.write`` can save.

    ``extra_products`` is a list of ``{"token", "name"}`` for products seen in the user's captures
    that NetSeer didn't recognize; each is resolved to a CPE via NVD and looked up like the rest,
    and recorded in ``aliases`` so later assessments can match the same banner.
    """
    api_key = os.environ.get("NVD_API_KEY") or None
    extra_products = extra_products or []
    total = len(cpes) + len(extra_products) + 2
    products: dict[str, list[dict[str, Any]]] = {}
    for i, cpe in enumerate(cpes):
        if progress:
            progress(f"Known vulnerabilities for {cpe.split(':')[1].replace('_', ' ')}", i, total)
        products[cpe] = fetch_product(cpe, api_key=api_key, should_stop=should_stop)
    # Products seen in captures but not in the built-in list: resolve, then look up like the rest.
    aliases: dict[str, dict[str, Any]] = {}
    discovered: list[dict[str, Any]] = []
    for j, ep in enumerate(extra_products):
        if should_stop and should_stop():
            raise Stopped
        if progress:
            progress(f"Looking up {ep['name']} (seen in your capture)", len(cpes) + j, total)
        resolved = resolve_cpes(ep["name"], api_key=api_key)
        for cpe in resolved:
            if cpe not in products:
                products[cpe] = fetch_product(cpe, api_key=api_key, should_stop=should_stop)
        if resolved:
            aliases[ep["token"]] = {"name": ep["name"], "cpes": resolved}
        discovered.append({"token": ep["token"], "name": ep["name"], "cpes": resolved, "found": bool(resolved)})
    ids = {e["id"] for items in products.values() for e in items}
    if should_stop and should_stop():
        raise Stopped
    if progress:
        progress("Exploitation likelihood (EPSS)", len(cpes), total)
    epss, epss_date = fetch_epss(ids)
    if progress:
        progress("Known exploited vulnerabilities (CISA KEV)", len(cpes) + 1, total)
    kev, kev_date = fetch_kev()
    for items in products.values():
        for e in items:
            score = epss.get(e["id"])
            e["epss"], e["percentile"] = (round(score[0], 5), round(score[1], 5)) if score else (None, None)
            e["kev"] = e["id"] in kev
    if progress:
        progress("Done", total, total)
    db = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "epss_date": epss_date,
        "kev_date": kev_date,
        "products": products,
    }
    if aliases:
        db["aliases"] = aliases
    if discovered:
        db["discovered"] = discovered
    return db
