from __future__ import annotations

import io
from typing import Any

from scapy.all import (  # type: ignore[import-untyped]
    ARP,
    BOOTP,
    DHCP,
    DNS,
    IP,
    LLC,
    STP,
    TCP,
    UDP,
    Dot1Q,
    Ether,
    IPv6,
    RadioTap,
    Raw,
    conf,
)
from scapy.utils import PcapReader  # type: ignore[import-untyped]

from netseer.graph import GraphBuilder
from netseer.services import infer_service_from_payload, service_for_port
from scapy.layers.dot11 import (  # type: ignore[import-untyped]
    Dot11,
    Dot11AssoReq,
    Dot11AssoResp,
    Dot11Beacon,
    Dot11Elt,
    Dot11ProbeReq,
    Dot11ProbeResp,
)

conf.verb = 0

MAX_PACKETS = 80_000


def _elt_info(elt: Any) -> bytes:
    info = getattr(elt, "info", b"")
    if isinstance(info, bytes):
        return info
    if isinstance(info, str):
        return info.encode("utf-8", errors="replace")
    return b""


def _walk_elements(pkt: Any) -> dict[int, list[bytes]]:
    found: dict[int, list[bytes]] = {}
    elt = pkt.getlayer(Dot11Elt)
    while elt is not None:
        ident = int(getattr(elt, "ID", -1))
        found.setdefault(ident, []).append(_elt_info(elt))
        nxt = elt.payload if hasattr(elt, "payload") else None
        elt = nxt if isinstance(nxt, Dot11Elt) else nxt.getlayer(Dot11Elt) if nxt is not None else None
    return found


def _decode_ssid(elements: dict[int, list[bytes]]) -> str | None:
    blobs = elements.get(0) or []
    if not blobs:
        return None
    raw_ssid = blobs[0]
    if not raw_ssid:
        return None
    text = raw_ssid.decode("utf-8", errors="replace").strip("\x00").strip()
    return text or None


def _channel_from_elements(elements: dict[int, list[bytes]], freq: float | None) -> int | None:
    ds = elements.get(3)
    if ds and ds[0]:
        return ds[0][0]
    if freq:
        f = int(freq)
        if f == 2484:
            return 14
        if 2412 <= f <= 2472:
            return (f - 2407) // 5
        if 5000 <= f <= 5900:
            return (f - 5000) // 5
        if 5955 <= f <= 7115:
            return (f - 5955) // 5 + 1
    return None


RSN_OUI = b"\x00\x0f\xac"
WPA_OUI = b"\x00\x50\xf2"
# AKM suite types (IEEE 802.11-2020 table 9-151), grouped by how we label them.
AKM_ENTERPRISE_192 = {11, 12, 13}
AKM_ENTERPRISE = {1, 3, 5, 14, 15, 16, 17}
AKM_SAE = {8, 9, 24, 25}
AKM_OWE = {18}
AKM_PSK = {2, 4, 6, 19, 20}


def _akm_types(body: bytes, oui: bytes) -> set[int] | None:
    """AKM suite types from an RSN/WPA body (after any vendor header), or None if truncated."""
    try:
        pos = 2 + 4  # version, group cipher
        count = int.from_bytes(body[pos : pos + 2], "little")
        pos += 2 + 4 * count  # pairwise ciphers
        count = int.from_bytes(body[pos : pos + 2], "little")
        pos += 2
        suites = [body[pos + 4 * i : pos + 4 * i + 4] for i in range(count)]
    except (IndexError, ValueError):
        return None
    if not suites or any(len(s) != 4 for s in suites):
        return None
    return {s[3] for s in suites if s[:3] == oui}


def _encryption_from_elements(elements: dict[int, list[bytes]], cap) -> str | None:
    privacy = False
    try:
        privacy = bool(cap and (int(cap) & 0x10))
    except (TypeError, ValueError):
        privacy = "privacy" in str(cap).lower()
    rsn = elements.get(48)
    vendors = elements.get(221) or []
    wpa_ie = next((v for v in vendors if v.startswith(WPA_OUI + b"\x01")), None)
    wpa_akms = _akm_types(wpa_ie[4:], WPA_OUI) if wpa_ie is not None else None
    if rsn:
        akms = _akm_types(rsn[0], RSN_OUI)
        if akms is None:
            return "WPA2"
        if akms & AKM_ENTERPRISE_192:
            return "WPA3-802.1X-192"
        if akms & AKM_ENTERPRISE:
            return "WPA2-802.1X"
        if akms & AKM_SAE:
            return "WPA3-SAE"
        if akms & AKM_OWE:
            return "OWE"
        if akms & AKM_PSK:
            return "WPA/WPA2-PSK" if wpa_ie is not None else "WPA2-PSK"
        return "WPA2"
    if wpa_ie is not None:
        return "WPA-802.1X" if wpa_akms and 1 in wpa_akms else "WPA-PSK"
    if privacy:
        return "WEP"
    return "Open"


def _radiotap_rf(pkt: Any) -> tuple[float | None, float | None]:
    signal = None
    freq = None
    if pkt.haslayer(RadioTap):
        rt = pkt[RadioTap]
        signal = getattr(rt, "dBm_AntSignal", None)
        freq = getattr(rt, "ChannelFrequency", None)
        if freq is None:
            freq = getattr(rt, "ChannelFreq", None)
    try:
        signal = float(signal) if signal is not None else None
    except (TypeError, ValueError):
        signal = None
    try:
        freq = float(freq) if freq is not None else None
    except (TypeError, ValueError):
        freq = None
    return signal, freq


def _fc_bits(dot11: Any) -> tuple[bool, bool]:
    try:
        flags = int(getattr(dot11, "FCfield", 0))
    except (TypeError, ValueError):
        flags = 0
    return bool(flags & 0x1), bool(flags & 0x2)


def _dot11_addrs(dot11: Any) -> tuple[str | None, str | None, str | None]:
    to_ds, from_ds = _fc_bits(dot11)
    addr1 = getattr(dot11, "addr1", None)
    addr2 = getattr(dot11, "addr2", None)
    addr3 = getattr(dot11, "addr3", None)
    if to_ds and from_ds:
        return addr2, addr1, addr1
    if to_ds and not from_ds:
        bssid, sta = addr1, addr2
    elif from_ds and not to_ds:
        bssid, sta = addr2, addr1
    else:
        # No-DS: management frames sent by the AP (addr2 == BSSID), such as probe
        # and association responses, are addressed to the station in addr1.
        bssid = addr3
        sta = addr1 if addr2 and addr3 and str(addr2).lower() == str(addr3).lower() else addr2
    return bssid, sta, addr1


def _dot11_address_roles(dot11: Any) -> dict[str, str | None]:
    """Map 802.11 address fields to TX/TA, RX, DA, and RA. Omit anything not in the frame."""
    to_ds, from_ds = _fc_bits(dot11)
    addr1 = getattr(dot11, "addr1", None)
    addr2 = getattr(dot11, "addr2", None)
    addr3 = getattr(dot11, "addr3", None)
    if to_ds and from_ds:
        return {"tx": addr2, "rx": addr1, "da": addr3, "ra": addr1}
    da = addr3 if to_ds else addr1
    return {
        "tx": addr2,
        "rx": addr1,
        "da": da,
        "ra": addr1,
    }


def _iter_vlans(pkt: Any) -> list[int]:
    vlans: list[int] = []
    layer = pkt
    while layer is not None:
        if isinstance(layer, Dot1Q):
            vlans.append(int(layer.vlan))
        layer = layer.payload if hasattr(layer, "payload") else None
        if layer is None or layer is layer.payload:
            break
    return vlans


def _dhcp_options(pkt: Any) -> dict[str, Any]:
    if not pkt.haslayer(DHCP):
        return {}
    out: dict[str, Any] = {}
    for item in pkt[DHCP].options:
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        key, value = item[0], item[1]
        if key == "subnet_mask":
            out["subnet_mask"] = str(value)
        elif key == "router":
            out["default_gateway"] = str(value) if not isinstance(value, list) else [str(v) for v in value]
        elif key == "name_server":
            out["dns_servers"] = str(value) if not isinstance(value, list) else [str(v) for v in value]
        elif key == "server_id":
            out["dhcp_server"] = str(value)
        elif key == "domain":
            out["dns_domain"] = str(value)
    return out


def _prefix_from_mask(mask: str | None) -> int | None:
    if not mask:
        return None
    try:
        return ip_network_prefix(mask)
    except Exception:
        return None


def ip_network_prefix(mask: str) -> int:
    parts = [int(p) for p in mask.split(".")]
    bits = "".join(f"{p:08b}" for p in parts)
    return bits.count("1")


def _try_ospf(builder: GraphBuilder, pkt: Any, src_id: str | None) -> None:
    if not src_id:
        return
    # OSPF is IP proto 89; hello type 1 starts after IP header
    if pkt.haslayer(IP) and pkt[IP].proto == 89:
        builder.add_role(src_id, "gateway")
        payload = bytes(pkt[IP].payload)
        router_id = None
        area = None
        if len(payload) >= 16:
            router_id = ".".join(str(b) for b in payload[4:8])
            area = ".".join(str(b) for b in payload[8:12])
        builder.observe_routing(
            src_id,
            routing_protocol="OSPF",
            ospf_router_id=router_id,
            ospf_area=area,
        )
        builder.observe_service(src_id, "ospf")


def _infer_packet_service(pkt: Any, sport: int | None, dport: int | None) -> tuple[str | None, dict[str, Any]]:
    meta: dict[str, Any] = {}
    if pkt.haslayer(DHCP):
        return "dhcp", meta
    if pkt.haslayer(DNS):
        try:
            dns = pkt[DNS]
            if getattr(dns, "qd", None):
                qd = dns.qd[0] if isinstance(dns.qd, list) else dns.qd
                qname = getattr(qd, "qname", None)
                if qname:
                    if isinstance(qname, bytes):
                        qname = qname.decode("utf-8", errors="replace")
                    meta["dns_query"] = str(qname).rstrip(".")
        except Exception:
            pass
        if dport == 5353 or sport == 5353:
            return "mdns", meta
        return "dns", meta
    payload = b""
    if pkt.haslayer(Raw):
        payload = bytes(pkt[Raw].load)
    named, extra = infer_service_from_payload(payload, sport, dport)
    meta.update(extra)
    if named:
        return named, meta
    if pkt.haslayer(IP) and pkt[IP].proto == 89:
        return "ospf", meta
    return service_for_port(dport) or service_for_port(sport), meta


def parse_pcap(builder: GraphBuilder, data: bytes, filename: str) -> None:
    stream = io.BytesIO(data)
    try:
        reader = PcapReader(stream)
    except Exception as exc:
        raise ValueError(f"Could not open capture {filename}: {exc}") from exc
    try:
        feed_packets(builder, reader, filename)
    finally:
        try:
            reader.close()
        except Exception:
            pass


def feed_packets(builder: GraphBuilder, packets: Any, filename: str) -> None:
    """Run decoded packets (from a pcap, or a Kismet log's packet table) into the builder."""
    seen = 0
    failed = 0
    for pkt in packets:
        # Cap per capture, not per builder, so combined surveys read every file.
        if seen >= MAX_PACKETS:
            builder.warnings.append(f"{filename}: stopped after {MAX_PACKETS} packets.")
            break
        seen += 1
        builder.packet_count += 1
        try:
            _handle_packet(builder, pkt)
        except Exception:
            failed += 1
    if failed:
        builder.warnings.append(f"{filename}: skipped {failed} packets that could not be decoded.")


def _handle_packet(builder: GraphBuilder, pkt: Any) -> None:
    vlans = _iter_vlans(pkt)
    vlan = vlans[0] if vlans else None
    src_mac = dst_mac = None
    if pkt.haslayer(Ether):
        src_mac = pkt[Ether].src
        dst_mac = pkt[Ether].dst
        builder.add_l2(src_mac, dst_mac, vlan)

    if pkt.haslayer(Dot11):
        _handle_dot11(builder, pkt)

    if pkt.haslayer(ARP):
        arp = pkt[ARP]
        builder.bind_ip_mac(arp.psrc, arp.hwsrc)
        if arp.op == 2:
            builder.bind_ip_mac(arp.pdst, arp.hwdst)
        builder.add_l3(arp.psrc, arp.pdst, proto="arp", vlan=vlan)

    src_ip = dst_ip = None
    proto = None
    sport = dport = None
    if pkt.haslayer(IP):
        src_ip, dst_ip = pkt[IP].src, pkt[IP].dst
        proto = {6: "tcp", 17: "udp", 1: "icmp", 89: "ospf"}.get(int(pkt[IP].proto), f"ip-{pkt[IP].proto}")
    elif pkt.haslayer(IPv6):
        src_ip, dst_ip = pkt[IPv6].src, pkt[IPv6].dst
        proto = "ipv6"

    if pkt.haslayer(TCP):
        sport, dport = int(pkt[TCP].sport), int(pkt[TCP].dport)
        proto = "tcp"
    elif pkt.haslayer(UDP):
        sport, dport = int(pkt[UDP].sport), int(pkt[UDP].dport)
        proto = "udp"

    service, metadata = _infer_packet_service(pkt, sport, dport)

    if pkt.haslayer(Dot11) and src_ip:
        # Only the source address (SA) owns src_ip. SA is the station for
        # station-to-AP (to-DS) and ad hoc frames; for from-DS frames it is the
        # upstream router, so binding there would pin remote IPs to a client.
        _, from_ds = _fc_bits(pkt[Dot11])
        if not from_ds:
            sa = getattr(pkt[Dot11], "addr2", None)
            if sa:
                builder.bind_ip_mac(src_ip, sa)

    if src_ip or dst_ip:
        builder.add_l3(
            src_ip,
            dst_ip,
            proto=proto,
            sport=sport,
            dport=dport,
            src_mac=src_mac,
            dst_mac=dst_mac,
            vlan=vlan,
            service=service,
            metadata=metadata,
        )

    src_id = builder.ip_to_device.get(src_ip or "")
    dst_id = builder.ip_to_device.get(dst_ip or "")

    if pkt.haslayer(DHCP) and pkt.haslayer(BOOTP):
        bootp = pkt[BOOTP]
        chaddr = None
        try:
            chaddr = ":".join(f"{b:02x}" for b in bytes(bootp.chaddr)[:6])
        except Exception:
            pass
        yiaddr = getattr(bootp, "yiaddr", None)
        if yiaddr and str(yiaddr) not in {"0.0.0.0", "255.255.255.255"}:
            node = builder.bind_ip_mac(str(yiaddr), chaddr)
            opts = _dhcp_options(pkt)
            if node:
                builder.observe_routing(node, **opts)
                mask = opts.get("subnet_mask")
                prefix = _prefix_from_mask(mask if isinstance(mask, str) else None)
                if prefix and yiaddr:
                    builder.netmasks[str(yiaddr)] = prefix
            gw = opts.get("default_gateway")
            gw_ip = gw[0] if isinstance(gw, list) and gw else gw if isinstance(gw, str) else None
            if gw_ip:
                gw_id = builder.observe_ip(gw_ip)
                if gw_id:
                    builder.add_role(gw_id, "gateway")
                    builder.observe_routing(gw_id, role="default-gateway")
            dhcp_srv = opts.get("dhcp_server")
            if dhcp_srv:
                srv_id = builder.observe_ip(str(dhcp_srv))
                if srv_id:
                    builder.add_role(srv_id, "server")
                    builder.observe_routing(srv_id, services=["dhcp"])

    if pkt.haslayer(DNS):
        dns_id = src_id if sport == 53 else dst_id if dport == 53 else None
        if dns_id:
            builder.add_role(dns_id, "server")
            builder.observe_service(dns_id, "mdns" if dport == 5353 or sport == 5353 else "dns")
            builder.observe_routing(dns_id, services=["dns"])

    _try_ospf(builder, pkt, src_id)
    _try_stp(builder, pkt, src_mac)


def _try_stp(builder: GraphBuilder, pkt: Any, src_mac: str | None) -> None:
    dst = ""
    if pkt.haslayer(Ether):
        dst = str(pkt[Ether].dst or "").lower()
    is_stp = pkt.haslayer(STP)
    if not is_stp and pkt.haslayer(LLC):
        is_stp = int(getattr(pkt[LLC], "dsap", 0) or 0) == 0x42
    # IEEE 802.1D bridge group address and Cisco PVST+.
    if not is_stp and dst in {"01:80:c2:00:00:00", "01:00:0c:cc:cc:cd"}:
        is_stp = True
    if not is_stp:
        return
    node_id = builder.observe_mac(src_mac)
    if not node_id:
        return
    info: dict[str, Any] = {}
    if pkt.haslayer(STP):
        stp = pkt[STP]
        root = getattr(stp, "rootmac", None) or getattr(stp, "rootid", None)
        bridge = getattr(stp, "bridgemac", None) or getattr(stp, "bridgeid", None)
        if root:
            info["root"] = str(root)
        if bridge:
            info["bridge_id"] = str(bridge)
        port = getattr(stp, "portid", None)
        if port is not None:
            info["port_id"] = str(port)
    builder.observe_stp(node_id, **info)


def _handle_dot11(builder: GraphBuilder, pkt: Any) -> None:
    dot11 = pkt[Dot11]
    roles = _dot11_address_roles(dot11)
    # Only the transmitter (addr2) and receiver (addr1) are radios. DA/SA in addr3 are
    # hosts beyond the access point, often wired servers; don't mark them wireless.
    radios = {str(m).lower() for m in (getattr(dot11, "addr1", None), getattr(dot11, "addr2", None)) if m}
    for role, mac in roles.items():
        if mac:
            builder.observe_mac(mac, wireless=str(mac).lower() in radios, mac_roles=(role,))
    to_ds, from_ds = _fc_bits(dot11)
    if to_ds and from_ds:
        ta = getattr(dot11, "addr2", None)
        ra = getattr(dot11, "addr1", None)
        elements = _walk_elements(pkt)
        builder.add_wds(ta, ra, ssid=_decode_ssid(elements))
        return
    bssid, sta, _ = _dot11_addrs(dot11)
    signal, freq = _radiotap_rf(pkt)
    elements = _walk_elements(pkt)
    ssid = _decode_ssid(elements)
    channel = _channel_from_elements(elements, freq)
    cap = None
    if pkt.haslayer(Dot11Beacon):
        cap = pkt[Dot11Beacon].cap
    elif pkt.haslayer(Dot11ProbeResp):
        cap = pkt[Dot11ProbeResp].cap
    enc = None
    if pkt.haslayer(Dot11Beacon) or pkt.haslayer(Dot11ProbeResp):
        enc = _encryption_from_elements(elements, cap)
        builder.add_ap(
            bssid,
            ssid=ssid,
            channel=channel,
            frequency_mhz=freq,
            encryption=enc,
            signal_dbm=signal,
        )
    elif pkt.haslayer(Dot11ProbeReq):
        sta_id = builder.observe_mac(sta or getattr(dot11, "addr2", None), wireless=True)
        if sta_id:
            builder.add_role(sta_id, "station")
            builder.observe_rf(sta_id, ssid=ssid, channel=channel, frequency_mhz=freq)
            builder.observe_signal(sta_id, signal)
    elif pkt.haslayer(Dot11AssoReq) or pkt.haslayer(Dot11AssoResp):
        builder.add_wireless_link(sta, bssid, ssid=ssid, associated=True)
        if bssid:
            ap_id = builder.observe_mac(bssid, wireless=True)
            if ap_id:
                builder.observe_signal(ap_id, signal)
                builder.observe_rf(ap_id, ssid=ssid, channel=channel, frequency_mhz=freq)
    else:
        # Data / other management
        if bssid:
            builder.add_ap(bssid, ssid=ssid, channel=channel, frequency_mhz=freq, signal_dbm=signal)
        if sta and bssid and sta != bssid:
            builder.add_wireless_link(sta, bssid, ssid=ssid, associated=True)
            sta_id = builder.observe_mac(sta, wireless=True)
            if sta_id:
                builder.observe_signal(sta_id, signal)
