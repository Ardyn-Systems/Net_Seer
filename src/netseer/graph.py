from __future__ import annotations

import ipaddress
import re
from typing import Any

from netseer.models import GpsFix, Link, Node, SurveyGraph
from netseer.oui import lookup_oui, manufacturers_for_macs, vendor_from_mac
from netseer.services import CLIENT_SIDE_PORTS, WELL_KNOWN_SERVER_PORTS, format_port, service_for_port


def normalize_mac(mac: str | None) -> str | None:
    if not mac:
        return None
    raw = re.sub(r"[^0-9a-fA-F]", "", mac)
    if len(raw) != 12:
        return None
    parts = [raw[i : i + 2].lower() for i in range(0, 12, 2)]
    if parts == ["00"] * 6 or parts == ["ff"] * 6:
        return None
    if int(parts[0], 16) & 0x01:
        return None
    return ":".join(parts)


def mac_id(mac: str) -> str:
    return f"mac:{mac}"


def ip_id(ip: str) -> str:
    return f"ip:{ip}"


def subnet_id(network: str) -> str:
    return f"subnet:{network}"


def vlan_id(vlan: int) -> str:
    return f"vlan:{vlan}"


def _merge_unique(dst: list, values: list) -> None:
    for value in values:
        if value is not None and value not in dst:
            dst.append(value)


def _port_key(entry: dict[str, Any]) -> tuple:
    return (
        str(entry.get("proto") or "ip"),
        entry.get("port"),
        entry.get("sport"),
        entry.get("dport"),
        entry.get("role"),
        entry.get("service"),
    )


def _merge_port_records(dst: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = {_port_key(item) for item in dst}
    for item in incoming:
        if not item:
            continue
        key = _port_key(item)
        if key in seen:
            continue
        dst.append(item)
        seen.add(key)
    return dst


def _link_service_label(rec: dict[str, Any], fallback: str) -> str:
    ports = rec.get("ports") or rec.get("extra", {}).get("ports") or []
    displays = []
    for item in ports:
        text = item.get("display")
        if text and text not in displays:
            displays.append(str(text))
    if displays:
        return ", ".join(displays[:4])
    services = rec.get("services") or rec.get("extra", {}).get("services") or []
    if services:
        return ", ".join(str(s) for s in services[:5])
    return fallback


# Sightings closer together than this count as one stretch of activity.
SEEN_GAP_SECONDS = 60.0


def merge_seen(intervals: list[list[float]], gap: float = SEEN_GAP_SECONDS) -> list[list[float]]:
    """Sort [start, end] pairs and join any that overlap or are less than `gap` apart."""
    out: list[list[float]] = []
    for start, end in sorted((float(a), float(b)) for a, b in intervals if a is not None and b is not None):
        if out and start <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [[round(a, 3), round(b, 3)] for a, b in out]


def _undirected_id(kind: str, a: str, b: str) -> str:
    lo, hi = sorted((a, b))
    return f"{kind}:{lo}:{hi}"


def _merge_link_records(dst: dict[str, Any], src: dict[str, Any]) -> None:
    """Fold a duplicate link (same id after a node merge) into `dst`."""
    dst["extra"]["count"] = int(dst["extra"].get("count") or 0) + int(src["extra"].get("count") or 0)
    dst["seen"] = merge_seen((dst.get("seen") or []) + (src.get("seen") or []))
    dst["ports"] = _merge_port_records(dst.get("ports") or [], src.get("ports") or [])
    dst["extra"]["ports"] = dst["ports"]
    _merge_unique(dst["services"], src.get("services") or [])
    dst["extra"]["services"] = dst["services"]
    _merge_unique(dst["vlans"], src.get("vlans") or [])
    if src["extra"].get("vias"):
        dst["extra"].setdefault("vias", [])
        _merge_unique(dst["extra"]["vias"], src["extra"]["vias"])
    for key, value in src["extra"].items():
        dst["extra"].setdefault(key, value)
    dst["label"] = _link_service_label(dst, dst["label"] or src["label"] or dst["kind"])


def _time_span(nodes, links) -> dict[str, float]:
    starts = [iv[0] for item in (*nodes, *links) for iv in (item.seen or [])]
    ends = [iv[1] for item in (*nodes, *links) for iv in (item.seen or [])]
    return {"time_start": min(starts), "time_end": max(ends)} if starts else {}


# Higher rank wins when two records for the same device are merged.
KIND_RANK = {"host": 0, "client": 0, "server": 1, "gateway": 2, "switch": 2, "ap": 3}


MAC_ROLE_FIELDS = (("mac_tx", "TX"), ("mac_rx", "RX"), ("mac_da", "DA"), ("mac_ra", "RA"))
MAC_ROLE_KEYS = {"tx", "rx", "da", "ra"}


def mac_role_lines(node: Any, *, limit: int | None = None, empty: str | None = None) -> list[str]:
    """Labeled TX/RX/DA/RA lines; omit empty roles unless `empty` is set."""
    lines: list[str] = []
    for attr, tag in MAC_ROLE_FIELDS:
        addrs = getattr(node, attr, None) or []
        if addrs:
            shown = addrs if limit is None else addrs[:limit]
            lines.append(f"{tag} {', '.join(str(a) for a in shown)}")
        elif empty is not None:
            lines.append(f"{tag} {empty}")
    return lines


def infer_display_name(rec: dict[str, Any], l2_degree: int = 0) -> str:
    """Short device-type name from the strongest capture evidence."""
    kind = rec.get("kind") or "host"
    if kind == "subnet":
        return rec.get("label") or "Subnet"
    if kind == "vlan":
        return rec.get("label") or "VLAN"
    roles = rec.get("roles") or []
    services = rec.get("services") or []
    routing = rec.get("routing") or {}
    ports = rec.get("ports") or []
    medium = rec.get("medium") or "wired"
    if kind == "ap" or "ap" in roles:
        return "Access point"
    if "station" in roles or (medium == "wireless" and kind not in {"ap", "vlan", "subnet"}):
        return "Wireless client"
    if routing.get("routing_protocol") or routing.get("ospf_router_id") or "ospf" in services:
        return "Router"
    if l2_degree >= 4 and kind in {"host", "switch"}:
        return "Switch"
    if kind == "gateway" or "gateway" in roles or routing.get("role") == "default-gateway":
        return "Gateway"
    listen = any(isinstance(p, dict) and p.get("role") == "listen" for p in ports)
    if kind == "server" or "server" in roles or listen:
        return "Server"
    return "Host"


def device_map_label(node: Any) -> str:
    """Clean on-map name: inferred/override type, plus optional user caption."""
    name = (getattr(node, "label", None) or getattr(node, "inferred_type", None) or "Host").strip()
    caption = (getattr(node, "caption", None) or "").strip()
    if caption:
        return f"{name}\n{caption}"
    return name


class GraphBuilder:
    """Accumulate L2/L3/RF observations into a survey graph."""

    def __init__(self) -> None:
        self.devices: dict[str, dict[str, Any]] = {}
        self.ip_to_device: dict[str, str] = {}
        self.links: dict[str, dict[str, Any]] = {}
        self.subnets: dict[str, dict[str, Any]] = {}
        self.vlans: dict[int, dict[str, Any]] = {}
        self.netmasks: dict[str, int] = {}
        self._known_nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
        self.sources: list[str] = []
        self.packet_count = 0
        self.warnings: list[str] = []
        # When set, link and signal updates are noted here so repeated frames can
        # replay them without decoding again (see parsers/fastwifi.py).
        self.recorder: list | None = None
        # The current packet's time (Unix seconds), while parsers feed packets in.
        # Devices and links touched while it's set are marked active then.
        self.now: float | None = None

    def note_source(self, name: str) -> None:
        if name not in self.sources:
            self.sources.append(name)

    def _device(self, node_id: str) -> dict[str, Any]:
        rec = self.devices.get(node_id)
        if rec is None:
            rec = {
                "id": node_id,
                "kind": "host",
                "label": node_id.split(":", 1)[-1],
                "medium": "wired",
                "macs": [],
                "mac_tx": [],
                "mac_rx": [],
                "mac_da": [],
                "mac_ra": [],
                "ips": [],
                "ssids": [],
                "channels": [],
                "frequencies_mhz": [],
                "signal_dbm": None,
                "signal_min_dbm": None,
                "signal_max_dbm": None,
                "encryption": [],
                "vlans": [],
                "gps": None,
                "vendor": None,
                "roles": [],
                "services": [],
                "ports": [],
                "routing": {},
                "extra": {},
                "seen": [],
            }
            self.devices[node_id] = rec
        if self.now is not None:
            self.touch(rec)
            if self.recorder is not None:
                self.recorder.append(("dev", node_id))
        return rec

    def touch(self, rec: dict[str, Any], when: float | None = None) -> None:
        """Mark a device or link record active at `when` (default: the current packet)."""
        now = self.now if when is None else when
        if now is None:
            return
        seen = rec.setdefault("seen", [])
        if seen and seen[-1][0] - SEEN_GAP_SECONDS <= now <= seen[-1][1] + SEEN_GAP_SECONDS:
            last = seen[-1]
            if now < last[0]:
                last[0] = now
            elif now > last[1]:
                last[1] = now
        else:
            seen.append([now, now])

    def add_seen(self, node_id: str, start: float | None, end: float | None) -> None:
        """A device's active period from a survey's own records (Kismet's first/last seen)."""
        if not start or not end or start <= 0 or end < start:
            return
        self._device(node_id).setdefault("seen", []).append([float(start), float(end)])

    def add_role(self, node_id: str, role: str) -> None:
        rec = self._device(node_id)
        if role not in rec["roles"]:
            rec["roles"].append(role)
        if role == "ap":
            rec["kind"] = "ap"
            rec["medium"] = "wireless"
        elif role == "gateway" and rec["kind"] == "host":
            rec["kind"] = "gateway"
        elif role == "server" and rec["kind"] in {"host", "client"}:
            rec["kind"] = "server"
        elif role == "station":
            rec["medium"] = "wireless"

    def observe_mac(
        self,
        mac: str | None,
        *,
        wireless: bool = False,
        vendor: str | None = None,
        label: str | None = None,
        mac_roles: tuple[str, ...] | list[str] | None = None,
    ) -> str | None:
        mac = normalize_mac(mac)
        if not mac:
            return None
        node_id = mac_id(mac)
        rec = self._device(node_id)
        if mac not in rec["macs"]:
            # OUI work only on first sight; this runs for every frame.
            rec["macs"].append(mac)
            info = lookup_oui(mac)
            rec["vendor"] = manufacturers_for_macs(rec["macs"])
            rec["extra"]["oui_prefix"] = info["oui_prefix"]
            rec["extra"]["oui_assignment"] = info["oui_assignment"]
        for role in mac_roles or ():
            key = str(role).lower()
            if key in MAC_ROLE_KEYS:
                _merge_unique(rec[f"mac_{key}"], [mac])
        if wireless:
            rec["medium"] = "wireless"
        if vendor and vendor not in {vendor_from_mac(mac), ""}:
            rec["extra"]["survey_manufacturer"] = vendor
        if label and rec["label"] in {mac, node_id.split(":", 1)[-1]}:
            rec["label"] = label
        return node_id

    def observe_ip(self, ip: str | None, mac: str | None = None) -> str | None:
        if not ip:
            return None
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            return None
        if parsed.is_unspecified or parsed.is_multicast or parsed.is_reserved:
            return None
        if parsed.version == 4 and self._is_directed_broadcast(parsed):
            return None
        ip_s = str(parsed)
        node_id = None
        if mac:
            node_id = self.observe_mac(mac)
        if node_id is None:
            node_id = self.ip_to_device.get(ip_s) or ip_id(ip_s)
        rec = self._device(node_id)
        _merge_unique(rec["ips"], [ip_s])
        if rec["label"] in rec["macs"] or rec["label"].startswith("mac:") or rec["label"] == rec["id"].split(":", 1)[-1]:
            rec["label"] = ip_s
        self.ip_to_device[ip_s] = node_id
        return node_id

    def _is_directed_broadcast(self, addr: ipaddress.IPv4Address) -> bool:
        """Subnet broadcast (e.g. 10.0.0.255) is a destination, not a host."""
        if len(self._known_nets) != len(self.netmasks):
            self._known_nets = [
                ipaddress.ip_network((ip, prefix), strict=False) for ip, prefix in self.netmasks.items()
            ]
        for net in self._known_nets:
            if net.version == 4 and addr in net:
                return net.prefixlen < 31 and addr == net.broadcast_address
        # No DHCP mask covers it: match the /24 the subnet view assumes.
        return addr.packed[-1] == 0xFF

    def _merge_device(self, src_id: str, dst_id: str) -> None:
        """Fold every observation of `src_id` into `dst_id` and repoint references."""
        if src_id == dst_id:
            return
        src = self.devices.pop(src_id, None)
        if src is None:
            return
        rec = self._device(dst_id)
        for key in (
            "ips", "macs", "mac_tx", "mac_rx", "mac_da", "mac_ra", "vlans",
            "services", "ssids", "channels", "frequencies_mhz", "encryption",
        ):
            _merge_unique(rec[key], src.get(key) or [])
        for role in src.get("roles") or []:
            self.add_role(dst_id, role)
        if KIND_RANK.get(src["kind"], 0) > KIND_RANK.get(rec["kind"], 0):
            rec["kind"] = src["kind"]
        if src.get("medium") == "wireless":
            rec["medium"] = "wireless"
        rec["ports"] = _merge_port_records(rec.get("ports") or [], src.get("ports") or [])
        rec["routing"].update(src.get("routing") or {})
        for key, value in (src.get("extra") or {}).items():
            if key in ("software", "tls_versions") and isinstance(value, list) and isinstance(rec["extra"].get(key), list):
                for item in value:
                    if item not in rec["extra"][key]:
                        rec["extra"][key].append(item)
            elif key == "handshakes" and isinstance(value, dict):
                table = rec["extra"].setdefault("handshakes", {})
                for peer, entry in value.items():
                    have = table.get(peer) or {}
                    msgs = set(have.get("messages") or []) | set(entry.get("messages") or [])
                    frames = {**(entry.get("frames") or {}), **(have.get("frames") or {})}
                    table[peer] = {"messages": sorted(msgs), **({"frames": frames} if frames else {})}
            else:
                rec["extra"].setdefault(key, value)
        if rec["gps"] is None:
            rec["gps"] = src.get("gps")
        if src.get("signal_dbm") is not None:
            if rec["signal_dbm"] is None:
                rec["signal_dbm"] = src["signal_dbm"]
            lows = [v for v in (rec["signal_min_dbm"], src.get("signal_min_dbm")) if v is not None]
            highs = [v for v in (rec["signal_max_dbm"], src.get("signal_max_dbm")) if v is not None]
            rec["signal_min_dbm"] = min(lows) if lows else None
            rec["signal_max_dbm"] = max(highs) if highs else None
        if rec["macs"]:
            rec["vendor"] = manufacturers_for_macs(rec["macs"])
        rec["seen"] = merge_seen((rec.get("seen") or []) + (src.get("seen") or []))

        for key, value in list(self.ip_to_device.items()):
            if value == src_id:
                self.ip_to_device[key] = dst_id
        for group in (*self.subnets.values(), *self.vlans.values()):
            if src_id in group["members"]:
                group["members"] = list(dict.fromkeys(dst_id if m == src_id else m for m in group["members"]))
        self._rekey_links(src_id, dst_id)

    def _rekey_links(self, old: str, new: str) -> None:
        """Repoint links from `old` to `new`, recomputing ids so later traffic dedupes."""
        moved = [lid for lid, link in self.links.items() if old in (link["source"], link["target"])]
        for lid in moved:
            link = self.links.pop(lid)
            source = new if link["source"] == old else link["source"]
            target = new if link["target"] == old else link["target"]
            if source == target:
                continue
            directed = bool(link.get("directed"))
            if not directed:
                source, target = sorted((source, target))
            new_id = f"{link['kind']}:{source}:{target}" if directed else _undirected_id(link["kind"], source, target)
            link.update(id=new_id, source=source, target=target)
            vias = link["extra"].get("vias")
            if vias:
                link["extra"]["vias"] = list(dict.fromkeys(new if v == old else v for v in vias))
            if link["extra"].get("via") == old:
                link["extra"]["via"] = new
            existing = self.links.get(new_id)
            if existing is None:
                self.links[new_id] = link
            else:
                _merge_link_records(existing, link)

    def bind_ip_mac(self, ip: str | None, mac: str | None) -> str | None:
        mac_node = self.observe_mac(mac)
        ip_node = self.observe_ip(ip)
        if mac_node and ip_node and mac_node != ip_node and ip_node.startswith("ip:"):
            # The IP-only placeholder was this MAC all along. A different MAC node
            # owning the IP is a separate device (e.g. DHCP reuse), so never merge those.
            self._merge_device(ip_node, mac_node)
            node_id = mac_node
        else:
            node_id = mac_node or ip_node
        if node_id and ip:
            self.observe_ip(ip, mac)
        return node_id

    def observe_vlan(self, vlan: int | None, node_id: str | None = None) -> None:
        if vlan is None:
            return
        try:
            vlan_n = int(vlan)
        except (TypeError, ValueError):
            return
        if vlan_n <= 0 or vlan_n >= 4095:
            return
        rec = self.vlans.setdefault(vlan_n, {"id": vlan_id(vlan_n), "label": f"VLAN {vlan_n}", "members": []})
        if node_id:
            device = self._device(node_id)
            _merge_unique(device["vlans"], [vlan_n])
            _merge_unique(rec["members"], [node_id])
            self._link(
                node_id,
                rec["id"],
                kind="vlan",
                label=f"VLAN {vlan_n}",
                medium="wired",
                vlans=[vlan_n],
            )

    def observe_subnet(self, ip: str | None, prefix: int | None = None) -> str | None:
        if not ip:
            return None
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        if addr.is_link_local or addr.is_loopback or addr.is_multicast:
            return None
        if prefix is None:
            prefix = self.netmasks.get(str(addr))
        if prefix is None:
            prefix = 24 if addr.version == 4 else 64
        network = ipaddress.ip_network((addr, prefix), strict=False)
        net_s = str(network)
        rec = self.subnets.setdefault(
            net_s,
            {"id": subnet_id(net_s), "label": net_s, "members": [], "prefix": prefix},
        )
        node_id = self.ip_to_device.get(str(addr))
        if node_id:
            _merge_unique(rec["members"], [node_id])
            self._link(node_id, rec["id"], kind="subnet", label=net_s, medium="wired")
        return rec["id"]

    def observe_signal(self, node_id: str, dbm: float | None) -> None:
        if self.recorder is not None:
            self.recorder.append(("signal", node_id))
        if dbm is None:
            return
        rec = self._device(node_id)
        rec["signal_dbm"] = float(dbm)
        rec["signal_min_dbm"] = (
            float(dbm) if rec["signal_min_dbm"] is None else min(rec["signal_min_dbm"], float(dbm))
        )
        rec["signal_max_dbm"] = (
            float(dbm) if rec["signal_max_dbm"] is None else max(rec["signal_max_dbm"], float(dbm))
        )

    def observe_rf(
        self,
        node_id: str,
        *,
        ssid: str | None = None,
        channel: int | None = None,
        frequency_mhz: float | None = None,
        encryption: str | None = None,
        gps: GpsFix | None = None,
    ) -> None:
        rec = self._device(node_id)
        rec["medium"] = "wireless"
        if ssid:
            _merge_unique(rec["ssids"], [ssid])
            if rec["kind"] == "ap" or rec["label"] in rec["macs"]:
                rec["label"] = ssid
        if channel is not None:
            try:
                _merge_unique(rec["channels"], [int(channel)])
            except (TypeError, ValueError):
                pass
        if frequency_mhz is not None:
            try:
                _merge_unique(rec["frequencies_mhz"], [float(frequency_mhz)])
            except (TypeError, ValueError):
                pass
        if encryption:
            _merge_unique(rec["encryption"], [encryption])
        if gps:
            rec["gps"] = gps

    def observe_handshake(self, sta_mac: str | None, ap_mac: str | None, message: int, frame: bytes | None = None) -> None:
        """One frame of a WPA 4-way handshake (message 1-4), kept on the station and the AP.

        A captured handshake lets someone try to recover a WPA/WPA2 pre-shared key offline, so it
        is worth surfacing. Each side records which messages were seen; the raw 802.11 frames are
        kept once (on the access point) so the handshake can be exported.
        """
        sta = self.observe_mac(sta_mac, wireless=True)
        ap = self.observe_mac(ap_mac, wireless=True)
        if not sta or not ap or sta == ap:
            return
        self.add_role(ap, "ap")
        self.add_role(sta, "station")
        for owner, peer, keep_frames in ((sta, ap_mac, False), (ap, sta_mac, True)):
            key = str(peer).lower()
            table = self._device(owner)["extra"].setdefault("handshakes", {})
            entry = table.get(key) or {}
            msgs = set(entry.get("messages") or [])
            msgs.add(int(message))
            entry["messages"] = sorted(msgs)
            if keep_frames and frame:
                entry.setdefault("frames", {}).setdefault(str(int(message)), frame.hex())
            table[key] = entry

    def observe_beacon_frame(self, bssid: str | None, frame: bytes | None) -> None:
        """Keep one beacon per access point, so an exported handshake carries the network's name."""
        node = self.observe_mac(bssid, wireless=True)
        if node and frame:
            self._device(node)["extra"].setdefault("beacon", frame.hex())

    def observe_software(self, node_id: str | None, entries: list[dict[str, Any]] | None) -> None:
        """Product banners the device sent about itself (raw text and where it came from)."""
        if not node_id or not entries:
            return
        rec = self._device(node_id)
        have = rec["extra"].setdefault("software", [])
        for entry in entries:
            if entry.get("raw") and not any(h.get("raw") == entry["raw"] for h in have):
                have.append({"raw": str(entry["raw"]), "source": str(entry.get("source") or "banner")})

    def observe_tls(self, node_id: str | None, version: str | None) -> None:
        if not node_id or not version:
            return
        _merge_unique(self._device(node_id)["extra"].setdefault("tls_versions", []), [version])

    def observe_service(self, node_id: str, service: str | None) -> None:
        if not service:
            return
        rec = self._device(node_id)
        _merge_unique(rec["services"], [service])

    def observe_port(
        self,
        node_id: str,
        *,
        proto: str | None,
        port: int | None,
        role: str,
        service: str | None = None,
    ) -> None:
        if port is None:
            if service:
                self.observe_service(node_id, service)
            return
        rec = self._device(node_id)
        named = service or service_for_port(port, proto)
        if named and role == "listen":
            self.observe_service(node_id, named)
        entry = {
            "proto": (proto or "ip").lower(),
            "port": int(port),
            "role": role,
            "service": named,
            "display": format_port(proto, port, named),
        }
        rec["ports"] = _merge_port_records(rec.get("ports") or [], [entry])

    def observe_routing(self, node_id: str, **fields: Any) -> None:
        rec = self._device(node_id)
        for key, value in fields.items():
            if value in (None, "", [], {}):
                continue
            existing = rec["routing"].get(key)
            if isinstance(existing, list) and not isinstance(value, list):
                _merge_unique(existing, [value])
            elif isinstance(existing, list) and isinstance(value, list):
                _merge_unique(existing, value)
            else:
                rec["routing"][key] = value
            if key == "services":
                names = value if isinstance(value, list) else [value]
                _merge_unique(rec["services"], [str(v) for v in names if v])

    def _link(
        self,
        source: str,
        target: str,
        *,
        kind: str,
        label: str = "",
        medium: str = "wired",
        vlans: list[int] | None = None,
        directed: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if not source or not target or source == target:
            return
        link_id = f"{kind}:{source}:{target}" if directed else _undirected_id(kind, source, target)
        rec = self.links.get(link_id)
        if rec is None:
            rec = {
                "id": link_id,
                "source": source if directed else sorted((source, target))[0],
                "target": target if directed else sorted((source, target))[1],
                "kind": kind,
                "label": label,
                "medium": medium,
                "vlans": [],
                "services": [],
                "ports": [],
                "extra": {"count": 0},
                "directed": directed,
                "seen": [],
            }
            self.links[link_id] = rec
        rec["extra"]["count"] = int(rec["extra"].get("count") or 0) + 1
        self.touch(rec)
        if self.recorder is not None:
            self.recorder.append(("link", link_id))
        extra = dict(extra or {})
        incoming_ports = extra.pop("ports", None) or []
        incoming_services = extra.pop("services", None) or []
        single_service = extra.pop("service", None)
        incoming_vias = extra.pop("vias", None) or []
        single_via = extra.get("via")
        if single_via:
            incoming_vias = list(incoming_vias) + [single_via]
        if single_service:
            incoming_services = list(incoming_services) + [single_service]
        rec["ports"] = _merge_port_records(rec.get("ports") or [], incoming_ports)
        rec["extra"]["ports"] = rec["ports"]
        _merge_unique(rec["services"], incoming_services)
        rec["extra"]["services"] = rec["services"]
        if incoming_vias:
            rec["extra"].setdefault("vias", [])
            _merge_unique(rec["extra"]["vias"], incoming_vias)
        if extra:
            rec["extra"].update(extra)
        rec["label"] = _link_service_label(rec, rec["label"] or label or kind)
        _merge_unique(rec["vlans"], vlans or [])

    def add_l2(self, src_mac: str | None, dst_mac: str | None, vlan: int | None = None) -> None:
        src = self.observe_mac(src_mac, mac_roles=("tx",))
        dst = self.observe_mac(dst_mac, mac_roles=("da", "rx"))
        if src and dst:
            self._link(src, dst, kind="l2", label="L2", medium="wired", vlans=[vlan] if vlan else None)
        self.observe_vlan(vlan, src)
        self.observe_vlan(vlan, dst)

    def add_l3(
        self,
        src_ip: str | None,
        dst_ip: str | None,
        *,
        proto: str | None = None,
        sport: int | None = None,
        dport: int | None = None,
        src_mac: str | None = None,
        dst_mac: str | None = None,
        vlan: int | None = None,
        service: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        src = self.observe_ip(src_ip)
        dst = self.observe_ip(dst_ip)
        named = service or service_for_port(dport, proto) or service_for_port(sport, proto)
        dst_known = dport is not None and dport in WELL_KNOWN_SERVER_PORTS and dport not in CLIENT_SIDE_PORTS
        src_known = sport is not None and sport in WELL_KNOWN_SERVER_PORTS and sport not in CLIENT_SIDE_PORTS
        if (dport in CLIENT_SIDE_PORTS and src_known) or (src_known and not dst_known):
            server, client, listen_port, client_port = src, dst, sport, dport
        elif dst_known:
            server, client, listen_port, client_port = dst, src, dport, sport
        elif named and sport is not None and dport is not None:
            # Service named from the payload on unregistered ports: the listener
            # is almost always the lower port, the ephemeral side the higher one.
            if sport < dport:
                server, client, listen_port, client_port = src, dst, sport, dport
            else:
                server, client, listen_port, client_port = dst, src, dport, sport
        elif named:
            server, client, listen_port, client_port = dst, src, dport, sport
        else:
            # Two ephemeral ports: no evidence which side listens.
            server = client = listen_port = client_port = None

        # Key port records on the listening port only. Including the ephemeral
        # client port made every connection a new record (unbounded growth).
        port_entry = None
        if proto in {"tcp", "udp"} and listen_port is not None:
            port_entry = {
                "proto": proto,
                "port": listen_port,
                "service": named,
                "display": format_port(proto, listen_port, named),
            }

        if src and dst:
            l3_label = named or (
                f"{proto}/{listen_port}" if proto and listen_port is not None else (proto or "IP").upper()
            )
            extra: dict[str, Any] = {"proto": proto}
            if port_entry:
                extra["ports"] = [port_entry]
            if named:
                extra["services"] = [named]
            if metadata:
                extra.update(metadata)
            self._link(src, dst, kind="l3", label=l3_label, medium="wired", extra=extra)

        if server and listen_port is not None:
            self.observe_port(server, proto=proto, port=listen_port, role="listen", service=named)
        if client and client_port is not None and (
            client_port in WELL_KNOWN_SERVER_PORTS or client_port in CLIENT_SIDE_PORTS
        ):
            self.observe_port(client, proto=proto, port=client_port, role="client", service=named)
        if named and server:
            self.observe_service(server, named)

        if server and client:
            self.add_role(server, "server")
            self.add_role(client, "client")
            cs_extra: dict[str, Any] = {}
            if named:
                cs_extra["services"] = [named]
            if port_entry:
                cs_extra["ports"] = [port_entry]
            if metadata:
                cs_extra.update(metadata)
            self._link(
                client,
                server,
                kind="client-server",
                label=named or format_port(proto, listen_port, named),
                directed=True,
                extra=cs_extra,
            )

    def add_wireless_link(
        self,
        sta_mac: str | None,
        bssid: str | None,
        *,
        ssid: str | None = None,
        associated: bool = True,
    ) -> None:
        ap = self.observe_mac(bssid, wireless=True)
        sta = self.observe_mac(sta_mac, wireless=True)
        if ap:
            self.add_role(ap, "ap")
            if ssid:
                self.observe_rf(ap, ssid=ssid)
        if sta:
            self.add_role(sta, "station")
            if ssid:
                self.observe_rf(sta, ssid=ssid)
        if ap and sta:
            self._link(
                sta,
                ap,
                kind="wireless",
                label=ssid or "802.11",
                medium="wireless",
                extra={"associated": associated},
            )

    def observe_stp(self, node_id: str, **info: Any) -> None:
        rec = self._device(node_id)
        rec["extra"]["stp"] = True
        for key, value in info.items():
            if value in (None, "", [], {}):
                continue
            rec["extra"][f"stp_{key}"] = value
        self.add_role(node_id, "bridge")

    def add_wds(self, mac_a: str | None, mac_b: str | None, ssid: str | None = None) -> None:
        """802.11 four-address WDS / wireless bridge between two APs."""
        left = self.observe_mac(mac_a, wireless=True)
        right = self.observe_mac(mac_b, wireless=True)
        if not left or not right or left == right:
            return
        self.add_role(left, "ap")
        self.add_role(right, "ap")
        self.add_role(left, "bridge")
        self.add_role(right, "bridge")
        extra: dict[str, Any] = {"bridge_kind": "wds", "vias": [left, right]}
        if ssid:
            extra["ssid"] = ssid
        self.add_attachment(left, right, mechanism="wds", label="WDS", extra=extra)

    def add_attachment(
        self,
        source: str,
        target: str,
        *,
        mechanism: str,
        via: str | None = None,
        label: str | None = None,
        extra: dict[str, Any] | None = None,
        vlans: list[int] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"bridge_kind": mechanism}
        if extra:
            payload.update(extra)
        if via:
            payload.setdefault("vias", [])
            if via not in payload["vias"]:
                payload["vias"].append(via)
            payload["via"] = via
        pretty = label or {
            "wds": "WDS",
            "stp": "STP bridge",
            "repeater": "Repeater",
            "bridge-port": "Bridge",
            "spanning-host": "Attachment",
        }.get(mechanism, "Attachment")
        medium = "wireless" if mechanism == "wds" else "bridged"
        self._link(
            source,
            target,
            kind="bridge",
            label=pretty,
            medium=medium,
            vlans=vlans,
            extra=payload,
        )

    def _infer_attachments(self) -> None:
        """Join distinct networks only when a device, STP, WDS, or bridge port spans them."""
        nets_by_member: dict[str, list[str]] = {}
        for net_s, srec in self.subnets.items():
            for member in srec.get("members") or []:
                nets_by_member.setdefault(member, []).append(net_s)
        for rec in list(self.devices.values()):
            node_id = rec["id"]
            vlans = [int(v) for v in rec.get("vlans") or [] if v is not None]
            stp = bool(rec.get("extra", {}).get("stp") or rec.get("extra", {}).get("bridge_ports"))
            mechanism = "stp" if stp else "spanning-host"
            label = "STP bridge" if stp else "Attachment"
            if len(vlans) >= 2:
                self.add_role(node_id, "bridge")
                for i, left in enumerate(vlans):
                    for right in vlans[i + 1 :]:
                        self.add_attachment(
                            vlan_id(left),
                            vlan_id(right),
                            mechanism=mechanism,
                            via=node_id,
                            label=label,
                            vlans=[left, right],
                            extra={"networks": [f"VLAN {left}", f"VLAN {right}"]},
                        )
            member_nets = nets_by_member.get(node_id, [])
            v4 = [n for n in member_nets if ":" not in n]
            v6 = [n for n in member_nets if ":" in n]
            for group in (v4, v6):
                if len(group) < 2:
                    continue
                self.add_role(node_id, "bridge")
                for i, left in enumerate(group):
                    for right in group[i + 1 :]:
                        self.add_attachment(
                            subnet_id(left),
                            subnet_id(right),
                            mechanism=mechanism,
                            via=node_id,
                            label=label,
                            extra={"networks": [left, right]},
                        )
            ssids = [s for s in rec.get("ssids") or [] if s]
            if len(ssids) >= 2:
                self.add_role(node_id, "bridge")
                rec["extra"]["repeater_ssids"] = ssids

    def add_ap(
        self,
        bssid: str | None,
        *,
        ssid: str | None = None,
        channel: int | None = None,
        frequency_mhz: float | None = None,
        encryption: str | None = None,
        signal_dbm: float | None = None,
        gps: GpsFix | None = None,
        vendor: str | None = None,
    ) -> str | None:
        node_id = self.observe_mac(bssid, wireless=True, vendor=vendor, label=ssid)
        if not node_id:
            return None
        self.add_role(node_id, "ap")
        self.observe_rf(
            node_id,
            ssid=ssid,
            channel=channel,
            frequency_mhz=frequency_mhz,
            encryption=encryption,
            gps=gps,
        )
        self.observe_signal(node_id, signal_dbm)
        return node_id

    def finalize(self) -> SurveyGraph:
        l2_degree: dict[str, int] = {}
        for link in self.links.values():
            if link.get("kind") != "l2":
                continue
            l2_degree[link["source"]] = l2_degree.get(link["source"], 0) + 1
            l2_degree[link["target"]] = l2_degree.get(link["target"], 0) + 1
        for ip, node_id in list(self.ip_to_device.items()):
            prefix = self.netmasks.get(ip)
            self.observe_subnet(ip, prefix)
            rec = self.devices.get(node_id)
            if rec and rec["macs"]:
                rec["vendor"] = manufacturers_for_macs(rec["macs"])
            if rec:
                rec["inferred_type"] = infer_display_name(rec, l2_degree.get(rec["id"], 0))
                rec["label"] = rec["inferred_type"]

        self._infer_attachments()

        nodes: list[Node] = []
        for rec in self.devices.values():
            gps = rec["gps"]
            inferred = rec.get("inferred_type") or infer_display_name(rec, l2_degree.get(rec["id"], 0))
            nodes.append(
                Node(
                    id=rec["id"],
                    kind=rec["kind"],
                    label=inferred,
                    medium=rec["medium"],
                    macs=rec["macs"],
                    mac_tx=rec.get("mac_tx") or [],
                    mac_rx=rec.get("mac_rx") or [],
                    mac_da=rec.get("mac_da") or [],
                    mac_ra=rec.get("mac_ra") or [],
                    ips=rec["ips"],
                    ssids=rec["ssids"],
                    channels=rec["channels"],
                    frequencies_mhz=rec["frequencies_mhz"],
                    signal_dbm=rec["signal_dbm"],
                    signal_min_dbm=rec["signal_min_dbm"],
                    signal_max_dbm=rec["signal_max_dbm"],
                    encryption=rec["encryption"],
                    vlans=rec["vlans"],
                    gps=gps if isinstance(gps, GpsFix) else GpsFix(**gps) if gps else None,
                    vendor=rec["vendor"],
                    roles=rec["roles"],
                    services=rec["services"],
                    ports=rec["ports"],
                    routing=rec["routing"],
                    extra=rec["extra"],
                    inferred_type=inferred,
                    seen=merge_seen(rec.get("seen") or []),
                )
            )
        for net, rec in self.subnets.items():
            nodes.append(
                Node(
                    id=rec["id"],
                    kind="subnet",
                    label=rec["label"],
                    medium="wired",
                    extra={"members": rec["members"], "prefix": rec["prefix"]},
                    inferred_type=rec["label"],
                )
            )
        for vid, rec in self.vlans.items():
            nodes.append(
                Node(
                    id=rec["id"],
                    kind="vlan",
                    label=rec["label"],
                    medium="wired",
                    vlans=[vid],
                    extra={"members": rec["members"]},
                    inferred_type=rec["label"],
                )
            )

        node_ids = {n.id for n in nodes}
        links = [
            Link(
                id=rec["id"],
                source=rec["source"],
                target=rec["target"],
                kind=rec["kind"],
                label=rec["label"],
                medium=rec["medium"],
                vlans=rec["vlans"],
                services=rec.get("services") or rec["extra"].get("services") or [],
                ports=rec.get("ports") or rec["extra"].get("ports") or [],
                extra=rec["extra"],
                seen=merge_seen(rec.get("seen") or []),
            )
            for rec in self.links.values()
            if rec["source"] in node_ids and rec["target"] in node_ids
        ]
        return SurveyGraph(
            nodes=sorted(nodes, key=lambda n: n.id),
            links=sorted(links, key=lambda e: e.id),
            meta={
                "sources": self.sources,
                "packet_count": self.packet_count,
                **_time_span(nodes, links),
                "node_count": len(nodes),
                "link_count": len(links),
                "warnings": self.warnings,
            },
        )
