"""Port and service names inferred from well-known ports and frame metadata."""

from __future__ import annotations

from typing import Any

WELL_KNOWN_PORTS: dict[tuple[str, int], str] = {}
_PORT_TO_SERVICE: dict[int, str] = {
    20: "ftp-data",
    21: "ftp",
    22: "ssh",
    23: "telnet",
    25: "smtp",
    53: "dns",
    67: "dhcp",
    68: "dhcp",
    69: "tftp",
    80: "http",
    88: "kerberos",
    110: "pop3",
    111: "rpcbind",
    123: "ntp",
    135: "msrpc",
    137: "netbios",
    138: "netbios",
    139: "smb",
    143: "imap",
    161: "snmp",
    162: "snmp-trap",
    179: "bgp",
    389: "ldap",
    443: "https",
    445: "smb",
    465: "smtps",
    500: "ike",
    514: "syslog",
    520: "rip",
    587: "smtp",
    636: "ldaps",
    853: "dot",
    993: "imaps",
    995: "pop3s",
    1433: "mssql",
    1521: "oracle",
    1883: "mqtt",
    1900: "ssdp",
    2049: "nfs",
    3306: "mysql",
    3389: "rdp",
    5060: "sip",
    5353: "mdns",
    5355: "llmnr",
    5432: "postgres",
    5672: "amqp",
    5900: "vnc",
    6379: "redis",
    8080: "http",
    8443: "https",
    9090: "http",
}

for _port, _name in _PORT_TO_SERVICE.items():
    WELL_KNOWN_PORTS[("tcp", _port)] = _name
    WELL_KNOWN_PORTS[("udp", _port)] = _name

# DHCP is UDP-only in practice; keep both for lookup convenience.
WELL_KNOWN_SERVER_PORTS = dict(_PORT_TO_SERVICE)

# Ports that are well-known but identify the client side of a conversation.
CLIENT_SIDE_PORTS = {68}


def service_for_port(port: int | None, proto: str | None = None) -> str | None:
    if port is None:
        return None
    if proto:
        named = WELL_KNOWN_PORTS.get((proto.lower(), int(port)))
        if named:
            return named
    return WELL_KNOWN_SERVER_PORTS.get(int(port))


def format_port(proto: str | None, port: int | None, service: str | None = None) -> str:
    proto_s = (proto or "ip").lower()
    if port is None:
        return service or proto_s
    base = f"{proto_s}/{int(port)}"
    if service and service not in base:
        return f"{service} {base}"
    return base


def node_service_caption(node) -> str:
    """Compact ports/services line for map labels and exports."""
    listens = [
        p
        for p in (getattr(node, "ports", None) or [])
        if p.get("role") in {"listen", "dest"} and p.get("display")
    ]
    if listens:
        seen: list[str] = []
        for item in listens:
            text = str(item["display"])
            if text not in seen:
                seen.append(text)
        return " · ".join(seen[:4])
    services = getattr(node, "services", None) or []
    return " · ".join(str(s) for s in services[:4])


def infer_service_from_payload(payload: bytes, sport: int | None, dport: int | None) -> tuple[str | None, dict[str, Any]]:
    """Named application from payload bytes when dissectors already ran."""
    meta: dict[str, Any] = {}
    if not payload:
        return None, meta
    head = payload[:480]
    if head.startswith((b"GET ", b"POST ", b"HEAD ", b"PUT ", b"DELETE ", b"PATCH ", b"HTTP/1.", b"HTTP/2")):
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"host:"):
                meta["http_host"] = line.split(b":", 1)[1].strip().decode("utf-8", errors="replace")
                break
        return "http", meta
    if head.startswith(b"SSH-"):
        ident = head.split(b"\r\n", 1)[0].decode("utf-8", errors="replace")
        meta["ssh_ident"] = ident
        return "ssh", meta
    # TLS record: content_type=0x16 handshake, version 3.x
    if len(head) >= 3 and head[0] == 0x16 and head[1] == 0x03:
        if dport == 443 or sport == 443 or dport == 8443 or sport == 8443:
            return "https", meta
        return "tls", meta
    return None, meta
