"""Security findings for each device on a map.

Two kinds, kept apart because they're known differently:

- Findings: what the capture itself shows, such as an open Wi-Fi network, Telnet, or TLS 1.0.
  Certain, so they carry a severity but no likelihood.
- Known vulnerabilities: CVEs for a product and version a device revealed in a banner, from the
  bundled (or downloaded) database. Each carries its CVSS severity and its EPSS score: FIRST's
  estimate of the chance it's exploited in the wild in the next 30 days.

No banner with a version means no CVE matching: NetSeer never guesses from the maker alone.
"""

from __future__ import annotations

import re
from typing import Any

from netseer.security import vulndb
from netseer.security.software import device_software
from netseer.serialize import graph_from_dict

SEVERITIES = ("critical", "high", "medium", "low")
# Distributions that fix flaws without changing the version a banner shows ("backports").
DISTRO = re.compile(r"\b(ubuntu|debian|deb\d+u\d+|raspbian|el\d|centos|red ?hat|rhel|fedora|suse|amazon|alpine|freebsd)\b", re.I)
RANK = {s: len(SEVERITIES) - i for i, s in enumerate(SEVERITIES)}


def distro_name(raw: str) -> str | None:
    """The Linux distribution a banner names, if any: its fixes may not change the version shown."""
    m = DISTRO.search(raw or "")
    if not m:
        return None
    word = m.group(1).lower().replace(" ", "")
    if word.startswith("deb") and word != "debian":
        return "Debian"
    if word.startswith("el") or word in ("rhel", "redhat"):
        return "Red Hat"
    return {"centos": "CentOS", "suse": "SUSE", "freebsd": "FreeBSD", "amazon": "Amazon Linux"}.get(word, word.title())


def _finding(fid: str, severity: str, title: str, why: str, fix: str, evidence: str = "") -> dict[str, str]:
    return {"id": fid, "severity": severity, "title": title, "why": why, "fix": fix, "evidence": evidence}


def _is_ap(node: dict[str, Any]) -> bool:
    return node.get("kind") == "ap" or "ap" in (node.get("roles") or [])


def wifi_findings(node: dict[str, Any]) -> list[dict[str, str]]:
    if not _is_ap(node):
        return []
    enc = [str(e) for e in node.get("encryption") or [] if str(e).strip()]
    text = " ".join(enc).upper()
    names = ", ".join(node.get("ssids") or []) or "this network"
    out = []
    if (node.get("extra") or {}).get("wps"):
        out.append(_finding("wifi-wps", "medium", "Wi-Fi Protected Setup (WPS) is on",
                            "WPS's PIN can be guessed in hours, and some routers give it up in seconds (Pixie Dust), handing over the Wi-Fi password.",
                            "Turn WPS off in the router's settings.", "WPS element in the beacon"))
    if not enc:
        return out
    if "WEP" in text:
        out.append(_finding("wifi-wep", "critical", "WEP encryption",
                            f"WEP on {names} can be cracked in minutes with free tools, exposing the password and all traffic.",
                            "Switch to WPA3, or WPA2 with AES (CCMP), and change the password.", f"Security: {', '.join(enc)}"))
        return out
    if all(e.strip().upper() in ("OPEN", "OPN", "NONE") for e in enc):
        out.append(_finding("wifi-open", "high", "Open Wi-Fi network",
                            f"Anyone nearby can join {names}, and traffic that isn't otherwise encrypted can be read.",
                            "Use WPA3 or WPA2 with a strong password; for a guest network, use OWE (Enhanced Open) and keep it apart from your own devices.", "Security: open"))
        return out
    wpa1_only = ("WPA-PSK" in text or "WPA-802.1X" in text or "WPA1" in text) and not any(x in text for x in ("WPA2", "WPA3", "/WPA2"))
    if wpa1_only or ("TKIP" in text and "CCMP" not in text and "AES" not in text):
        out.append(_finding("wifi-wpa1", "high", "Old WPA or TKIP encryption",
                            "The original WPA and its TKIP cipher are broken and deprecated; attackers can inject and decrypt some traffic.",
                            "Use WPA2 with AES (CCMP) only, or WPA3.", f"Security: {', '.join(enc)}"))
    elif "WPA/WPA2" in text or ("TKIP" in text and ("CCMP" in text or "AES" in text)):
        out.append(_finding("wifi-mixed", "medium", "WPA/WPA2 mixed mode",
                            "Allowing old WPA (TKIP) clients keeps a weaker cipher available on the network.",
                            "Set the network to WPA2 (AES) only, or WPA2/WPA3.", f"Security: {', '.join(enc)}"))
    if "PSK" in text and not any(x in text for x in ("SAE", "802.1X", "MGT", "EAP")):
        out.append(_finding("wifi-psk", "low", "Shared Wi-Fi password",
                            "Anyone who captures a device joining can try to guess the password offline, quickly if it's short or common.",
                            "Use a long, random passphrase (16+ characters), or WPA3-SAE, which resists offline guessing.", f"Security: {', '.join(enc)}"))
    return out


# Services a device was seen offering, and what they mean.
SERVICE_RULES: dict[str, tuple[str, str, str, str]] = {
    "telnet": ("high", "Telnet", "Telnet sends logins and everything typed in plain text, and is a favourite way in for botnets.", "Turn Telnet off and use SSH."),
    "redis": ("high", "Redis", "Redis often runs with no password, letting anyone who reaches it read data or take over the server.", "Require a password (requirepass or ACLs) and keep it off untrusted networks."),
    "ftp": ("medium", "FTP", "FTP sends usernames, passwords, and files unencrypted.", "Use SFTP or FTPS instead."),
    "tftp": ("medium", "TFTP", "TFTP has no login: anyone who can reach it can read files, often configurations and firmware, and sometimes write them.", "Turn it off when not in use, or limit who can reach it."),
    "snmp": ("medium", "SNMP v1/v2c", "SNMP's community string is a password sent in plain text, and defaults like \"public\" are widely tried.", "Use SNMPv3 with authentication and encryption, or change the community string and limit who can query it."),
    "vnc": ("medium", "VNC", "VNC is often set up with a weak or no password, and many versions don't encrypt the session.", "Require a strong password, tunnel it over SSH or a VPN, or turn it off."),
    "pop3": ("medium", "POP3 without encryption", "Mail logins and messages travel unencrypted.", "Use POP3S (port 995) or IMAPS."),
    "imap": ("medium", "IMAP without encryption", "Mail logins and messages travel unencrypted.", "Use IMAPS (port 993)."),
    "mqtt": ("medium", "MQTT without encryption", "MQTT on port 1883 is unencrypted and often has no login, so anyone can read or send device messages.", "Use MQTT over TLS (port 8883) with logins."),
    "http": ("low", "Web interface without encryption", "Passwords typed into this web page can be read by anyone on the network path.", "Use HTTPS, and turn off plain HTTP or redirect it."),
    "rdp": ("low", "Remote Desktop", "Remote Desktop is one of the most attacked services: password guessing and past flaws like BlueKeep.", "Keep it off the internet, require Network Level Authentication, and keep Windows updated."),
    "smb": ("low", "Windows file sharing (SMB)", "Old SMB versions have had wormable flaws (EternalBlue, WannaCry).", "Make sure SMBv1 is turned off and the device is up to date; don't expose SMB to the internet."),
    "mysql": ("low", "Database reachable on the network", "A database answering on the network is open to password guessing and its own flaws.", "Let only the servers that need it connect."),
    "postgres": ("low", "Database reachable on the network", "A database answering on the network is open to password guessing and its own flaws.", "Let only the servers that need it connect."),
    "mssql": ("low", "Database reachable on the network", "A database answering on the network is open to password guessing and its own flaws.", "Let only the servers that need it connect."),
    "oracle": ("low", "Database reachable on the network", "A database answering on the network is open to password guessing and its own flaws.", "Let only the servers that need it connect."),
    "ldap": ("low", "LDAP without encryption", "Directory lookups and simple logins travel unencrypted.", "Use LDAPS (port 636) or StartTLS."),
    "nfs": ("low", "NFS file sharing", "NFS shares are often exported to the whole network with little checking of who connects.", "Export shares only to the hosts that need them."),
}


def service_findings(node: dict[str, Any]) -> list[dict[str, str]]:
    offered: dict[str, list[str]] = {}
    for port in node.get("ports") or []:
        if port.get("role") in ("listen", "dest") and port.get("service"):
            offered.setdefault(str(port["service"]), []).append(str(port.get("display") or port["service"]))
    for svc in node.get("services") or []:
        offered.setdefault(str(svc).split()[0], [])
    out = []
    for svc, displays in offered.items():
        rule = SERVICE_RULES.get(svc)
        if rule:
            severity, title, why, fix = rule
            out.append(_finding(f"svc-{svc}", severity, title, why, fix, "Seen offering " + (", ".join(sorted(set(displays))) or svc)))
    return out


def tls_findings(node: dict[str, Any]) -> list[dict[str, str]]:
    versions = (node.get("extra") or {}).get("tls_versions") or []
    out = []
    if "SSL 3.0" in versions:
        out.append(_finding("tls-ssl3", "high", "SSL 3.0", "SSL 3.0 is broken (POODLE): encrypted sessions can be decrypted.", "Turn off SSL 3.0; allow TLS 1.2 and 1.3 only.", "Server chose SSL 3.0"))
    old = [v for v in versions if v in ("TLS 1.0", "TLS 1.1")]
    if old:
        out.append(_finding("tls-old", "medium", f"Outdated {' and '.join(old)}", "TLS 1.0 and 1.1 are retired, with known weaknesses; modern browsers refuse them.", "Allow TLS 1.2 and 1.3 only, and update the device if it can't.", f"Server chose {', '.join(old)}"))
    return out


def assess_node(node: dict[str, Any], db: dict[str, Any], handshakes: list[tuple[dict, dict | None]] | None = None) -> dict[str, Any] | None:
    handshakes = handshakes or []
    findings = wifi_findings(node) + service_findings(node) + tls_findings(node) + [f for _, f in handshakes if f]
    findings.sort(key=lambda f: -RANK[f["severity"]])
    software = []
    for soft in device_software(node):
        vulns = vulndb.vulnerabilities(soft, db)
        software.append({
            "name": soft.name,
            "version": soft.version,
            "label": soft.label,
            "source": soft.source,
            "raw": soft.raw,
            "known": bool(soft.cpes),
            "vulnerabilities": vulns,
            "distro": distro_name(soft.raw) if vulns else None,
        })
    records = [r for r, _ in handshakes]
    if not findings and not software and not records:
        return None
    worst = max([RANK[f["severity"]] for f in findings] + [vulndb.SEVERITY_RANK.get(v.get("severity") or "", 0) for s in software for v in s["vulnerabilities"]] + [0])
    top = max((v.get("epss") or 0 for s in software for v in s["vulnerabilities"]), default=0)
    return {
        "findings": findings,
        "software": software,
        "handshakes": records,
        "worst": next((s for s in SEVERITIES if RANK[s] == worst), None),
        "max_epss": top or None,
        "kev": any(v.get("kev") for s in software for v in s["vulnerabilities"]),
        "vulnerability_count": sum(len(s["vulnerabilities"]) for s in software),
    }


def _enc_text(node: dict[str, Any] | None) -> str:
    return " ".join(str(e) for e in (node or {}).get("encryption") or []).upper()


def handshake_records(node: dict[str, Any], by_mac: dict[str, dict[str, Any]]) -> list[tuple[dict, dict]]:
    """(record, finding) for each captured WPA 4-way handshake this device took part in.

    A handshake is "crackable" when enough of it was captured (message 2, plus message 1 or 3) on
    a pre-shared-key network: the Wi-Fi password can then be attempted offline. Enterprise (802.1X)
    and WPA3-SAE handshakes don't expose the password this way.
    """
    out: list[tuple[dict, dict]] = []
    table = (node.get("extra") or {}).get("handshakes") or {}
    for peer, entry in table.items():
        messages = sorted(int(m) for m in entry.get("messages") or [])
        peer_node = by_mac.get(str(peer).lower())
        enc = _enc_text(peer_node) or _enc_text(node)
        enterprise = any(x in enc for x in ("802.1X", "MGT", "EAP"))
        sae = "SAE" in enc or "WPA3" in enc
        crackable = 2 in messages and (1 in messages or 3 in messages) and not enterprise and not sae
        label = str((peer_node or {}).get("label") or "")
        generic = label.lower() in ("access point", "wireless client", "host", "server", "router", "gateway", "")
        peer_label = peer if generic or label.lower() == str(peer).lower() else label
        record = {
            "peer": peer,
            "peer_label": peer_label,
            "messages": messages,
            "complete": messages == [1, 2, 3, 4],
            "crackable": crackable,
        }
        finding = None
        if crackable:
            finding = _finding(
                "wifi-handshake", "high", "WPA handshake captured",
                f"Enough of a WPA/WPA2 handshake with {record['peer_label']} was captured to try the Wi-Fi password offline. A weak or common password could be recovered in minutes.",
                "Use a long, random Wi-Fi passphrase (16+ characters), or WPA3, which resists offline guessing.",
                f"Handshake messages {', '.join(map(str, messages))} of 4 captured",
            )
        out.append((record, finding))
    return out


def assess_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Findings for every device on the map that has any, and which vulnerability data was used."""
    data = graph_from_dict(graph).to_dict()
    db, source = vulndb.load()
    by_mac: dict[str, dict[str, Any]] = {}
    for node in data.get("nodes") or []:
        for mac in node.get("macs") or []:
            by_mac.setdefault(str(mac).lower(), node)
    nodes = {}
    for node in data.get("nodes") or []:
        if node.get("kind") in ("subnet", "vlan"):
            continue
        result = assess_node(node, db, handshake_records(node, by_mac))
        if result:
            nodes[node["id"]] = result
    return {"nodes": nodes, "database": {"source": source, **(vulndb.summary(db) or {})}}
