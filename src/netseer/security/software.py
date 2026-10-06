"""Product and version from the banners devices send about themselves.

Each product maps to the CPE vendor:product names NVD files vulnerabilities under (some have
two, such as nginx). Only banners that name a version are matched against known
vulnerabilities; the rest are still listed, as what the device runs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Product:
    name: str  # what people call it
    cpes: tuple[str, ...]  # vendor:product keys in NVD


# Keyed by how the product names itself in a banner (lower case).
PRODUCTS: dict[str, Product] = {
    "openssh": Product("OpenSSH", ("openbsd:openssh",)),
    "dropbear": Product("Dropbear SSH", ("dropbear_ssh_project:dropbear_ssh",)),
    "libssh": Product("libssh", ("libssh:libssh",)),
    "apache": Product("Apache HTTP Server", ("apache:http_server",)),
    "nginx": Product("nginx", ("f5:nginx", "nginx:nginx")),
    "microsoft-iis": Product("Microsoft IIS", ("microsoft:internet_information_services",)),
    "lighttpd": Product("lighttpd", ("lighttpd:lighttpd",)),
    "openssl": Product("OpenSSL", ("openssl:openssl",)),
    "php": Product("PHP", ("php:php",)),
    "jetty": Product("Eclipse Jetty", ("eclipse:jetty",)),
    "rompager": Product("RomPager", ("allegrosoft:rompager",)),
    "boa": Product("Boa web server", ("boa:boa",)),
    "mini_httpd": Product("mini_httpd", ("acme:mini_httpd",)),
    "werkzeug": Product("Werkzeug", ("palletsprojects:werkzeug",)),
    "python": Product("Python", ("python:python",)),
}

ALL_CPES = tuple(dict.fromkeys(c for p in PRODUCTS.values() for c in p.cpes))


@dataclass
class Software:
    key: str  # PRODUCTS key, or "" when NetSeer doesn't know the product
    name: str
    version: str | None
    raw: str
    source: str
    cpes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def label(self) -> str:
        return f"{self.name} {self.version}" if self.version else self.name


_VERSION = r"(\d+(?:\.\d+)*[a-z]?\d*(?:p\d+)?)"
# "Name/1.2.3" tokens in HTTP headers, and "Jetty(9.4.43...)" style.
_TOKEN = re.compile(r"([A-Za-z][A-Za-z0-9_.\-]*)[/(]\s*" + _VERSION, re.I)


def parse_banner(raw: str, source: str) -> list[Software]:
    """Every product a banner names, with its version when it gives one."""
    text = (raw or "").strip()
    found: list[Software] = []
    if text.upper().startswith("SSH-"):
        # SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13, SSH-2.0-dropbear_2020.81, SSH-2.0-libssh_0.9.6
        soft = text.split("-", 2)[2] if text.count("-") >= 2 else ""
        m = re.match(r"([A-Za-z][A-Za-z0-9.]*?)[_\-]" + _VERSION, soft)
        name = (m.group(1) if m else soft.split()[0] if soft else "").lower()
        version = m.group(2) if m else None
        product = PRODUCTS.get(name)
        if product:
            found.append(Software(name, product.name, version, text, source, product.cpes))
        elif soft:
            found.append(Software("", soft.split()[0], None, text, source))
        return found
    for m in _TOKEN.finditer(text):
        name, version = m.group(1).lower(), m.group(2)
        product = PRODUCTS.get(name)
        if product:
            found.append(Software(name, product.name, version, text, source, product.cpes))
    if not found and text:
        # A product NetSeer can't match, or one that hides its version ("nginx", "GoAhead-Webs").
        word = text.split()[0].split("/")[0]
        product = PRODUCTS.get(word.lower())
        found.append(Software(word.lower() if product else "", product.name if product else word, None, text, source, product.cpes if product else ()))
    return found


def device_software(node: dict) -> list[Software]:
    out: list[Software] = []
    seen: set[tuple[str, str | None]] = set()
    for entry in (node.get("extra") or {}).get("software") or []:
        for soft in parse_banner(str(entry.get("raw") or ""), str(entry.get("source") or "banner")):
            key = (soft.key or soft.name, soft.version)
            if key not in seen:
                seen.add(key)
                out.append(soft)
    return out


def version_key(version: str) -> tuple:
    """Comparable form of a version string: 9.6p1 > 9.6 > 9.5p2; 1.0.2k > 1.0.2."""
    parts = re.findall(r"\d+|[a-z]+", str(version).lower())
    # Numbers sort after letters at the same position, so 1.0.0 > 1.0.beta.
    return tuple((1, int(p)) if p.isdigit() else (0, p) for p in parts)
