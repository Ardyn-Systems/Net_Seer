"""Generate synthetic but realistic survey files next to this package."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path

from scapy.all import (  # type: ignore[import-untyped]
    ARP,
    BOOTP,
    DHCP,
    DNS,
    DNSQR,
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
    wrpcap,
)
from scapy.layers.dot11 import (  # type: ignore[import-untyped]
    Dot11,
    Dot11AssoReq,
    Dot11Beacon,
    Dot11Elt,
    Dot11ProbeReq,
)
from scapy.layers.eap import EAPOL  # type: ignore[import-untyped]
from scapy.layers.l2 import SNAP  # type: ignore[import-untyped]
from scapy.utils import PcapNgWriter, mac2str  # type: ignore[import-untyped]

from netseer.brand import USER_AGENT

DATA = Path(__file__).resolve().parent / "data"

GW = "00:1a:2f:aa:00:01"
ALICE = "3c:22:fb:10:00:01"
BOB = "00:1b:21:10:00:02"
DNS_MAC = "00:25:90:20:00:0a"
WEB = "00:25:90:20:00:50"
PRINTER = "00:17:c8:30:00:01"
AP_SECURE = "00:15:6d:c0:00:01"
AP_GUEST = "00:15:6d:c0:00:02"
AP_IOT = "00:15:6d:c0:00:03"
PHONE = "a4:c3:f0:50:00:11"
LAPTOP = "f0:18:98:50:00:22"

RSN_PSK = bytes.fromhex("0100000fac040100000fac040100000fac020000")
RSN_8021X = bytes.fromhex("0100000fac040100000fac040100000fac010000")


def _http_get(host: str, path: str = "/") -> bytes:
    return f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {USER_AGENT}\r\n\r\n".encode()


def _tls_client_hello() -> bytes:
    return b"\x16\x03\x01\x00\x20\x01\x00\x00\x1c\x03\x03" + (b"\x11" * 21)


def _beacon(bssid: str, ssid: str, channel: int, freq: int, signal: int, rsn: bytes | None) -> RadioTap:
    cap = "ESS+privacy" if rsn else "ESS"
    elts = (
        Dot11Elt(ID="SSID", info=ssid.encode())
        / Dot11Elt(ID="Rates", info=b"\x82\x84\x8b\x96")
        / Dot11Elt(ID="DSset", info=bytes([channel]))
    )
    if rsn:
        elts = elts / Dot11Elt(ID="RSNinfo", info=rsn)
    return (
        RadioTap(dBm_AntSignal=signal, ChannelFrequency=freq)
        / Dot11(type=0, subtype=8, addr1="ff:ff:ff:ff:ff:ff", addr2=bssid, addr3=bssid)
        / Dot11Beacon(cap=cap)
        / elts
    )


def office_lan_packets() -> list:
    pkts = []
    pkts.append(Ether(src=ALICE, dst="ff:ff:ff:ff:ff:ff") / ARP(op=1, hwsrc=ALICE, psrc="10.10.10.42", pdst="10.10.10.1"))
    pkts.append(Ether(src=GW, dst=ALICE) / ARP(op=2, hwsrc=GW, psrc="10.10.10.1", hwdst=ALICE, pdst="10.10.10.42"))
    pkts.append(Ether(src=DNS_MAC, dst=GW) / ARP(op=2, hwsrc=DNS_MAC, psrc="10.10.20.10", hwdst=GW, pdst="10.10.20.1"))
    pkts.append(Ether(src=WEB, dst=GW) / ARP(op=2, hwsrc=WEB, psrc="10.10.20.80", hwdst=GW, pdst="10.10.20.1"))
    pkts.append(Ether(src=BOB, dst=GW) / ARP(op=2, hwsrc=BOB, psrc="10.10.10.55", hwdst=GW, pdst="10.10.10.1"))
    pkts.append(Ether(src=PRINTER, dst=GW) / ARP(op=2, hwsrc=PRINTER, psrc="10.10.10.200", hwdst=GW, pdst="10.10.10.1"))
    pkts.append(Ether(src=GW, dst=BOB) / ARP(op=2, hwsrc=GW, psrc="10.10.20.1", hwdst=BOB, pdst="10.10.10.55"))
    pkts.append(
        Ether(src=DNS_MAC, dst=ALICE)
        / IP(src="10.10.20.10", dst="10.10.10.42")
        / UDP(sport=67, dport=68)
        / BOOTP(op=2, yiaddr="10.10.10.42", siaddr="10.10.20.10", chaddr=mac2str(ALICE))
        / DHCP(
            options=[
                ("message-type", "ack"),
                ("server_id", "10.10.20.10"),
                ("subnet_mask", "255.255.255.0"),
                ("router", "10.10.10.1"),
                ("name_server", "10.10.20.10"),
                ("domain", "hq.local"),
                "end",
            ]
        )
    )
    pkts.append(
        Ether(src=ALICE, dst=GW)
        / Dot1Q(vlan=10)
        / IP(src="10.10.10.42", dst="10.10.20.10")
        / UDP(sport=53001, dport=53)
        / DNS(rd=1, qd=DNSQR(qname="intranet.hq.local"))
    )
    pkts.append(
        Ether(src=DNS_MAC, dst=GW)
        / Dot1Q(vlan=20)
        / IP(src="10.10.20.10", dst="10.10.10.42")
        / UDP(sport=53, dport=53001)
        / DNS(qr=1, aa=1, qd=DNSQR(qname="intranet.hq.local"))
    )
    pkts.append(
        Ether(src=ALICE, dst=GW)
        / Dot1Q(vlan=10)
        / IP(src="10.10.10.42", dst="10.10.20.80")
        / TCP(sport=49152, dport=80, flags="PA")
        / Raw(load=_http_get("intranet.hq.local", "/status"))
    )
    pkts.append(
        Ether(src=WEB, dst=GW)
        / Dot1Q(vlan=20)
        / IP(src="10.10.20.80", dst="10.10.10.42")
        / TCP(sport=80, dport=49152, flags="PA")
        / Raw(load=b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok")
    )
    pkts.append(
        Ether(src=BOB, dst=GW)
        / Dot1Q(vlan=10)
        / IP(src="10.10.10.55", dst="10.10.20.80")
        / TCP(sport=50001, dport=443, flags="PA")
        / Raw(load=_tls_client_hello())
    )
    pkts.append(
        Ether(src=ALICE, dst=GW)
        / Dot1Q(vlan=10)
        / IP(src="10.10.10.42", dst="10.10.20.10")
        / TCP(sport=51022, dport=22, flags="PA")
        / Raw(load=b"SSH-2.0-OpenSSH_9.6\r\n")
    )
    pkts.append(
        Ether(src=BOB, dst=GW)
        / IP(src="10.10.10.55", dst="10.10.20.10")
        / UDP(sport=52000, dport=123)
        / Raw(load=b"\x1b" + b"\x00" * 47)
    )
    pkts.append(
        Ether(src=PRINTER, dst=GW)
        / Dot1Q(vlan=10)
        / IP(src="10.10.10.200", dst="10.10.10.1")
        / UDP(sport=161, dport=161)
        / Raw(load=b"\x30\x00")
    )
    pkts.append(
        Ether(src=ALICE, dst=GW)
        / IPv6(src="2001:db8:10::42", dst="2001:db8:10::1")
        / TCP(sport=40022, dport=22, flags="S")
    )
    # OSPF hello (proto 89) from the gateway.
    ospf = bytes.fromhex("0201002c0a0a0a0100000000000000000000000000000000ffffffffffffffff0a0a0a0100000000")
    pkts.append(Ether(src=GW, dst="01:00:5e:00:00:05") / IP(src="10.10.10.1", dst="224.0.0.5", proto=89) / Raw(load=ospf))
    # 802.1D STP BPDU from the gateway that spans VLAN 10 and VLAN 20.
    pkts.append(
        Ether(src=GW, dst="01:80:c2:00:00:00")
        / LLC(dsap=0x42, ssap=0x42, ctrl=3)
        / STP(rootid=1, bridgeid=1, portid=0x8001)
    )
    return pkts


def wifi_packets() -> list:
    pkts = [
        _beacon(AP_SECURE, "HQ-Secure", 36, 5180, -38, RSN_8021X),
        _beacon(AP_GUEST, "HQ-Guest", 6, 2437, -51, RSN_PSK),
        _beacon(AP_IOT, "sensors", 11, 2462, -70, RSN_PSK),
        RadioTap(dBm_AntSignal=-44, ChannelFrequency=5180)
        / Dot11(type=0, subtype=0, addr1=AP_SECURE, addr2=PHONE, addr3=AP_SECURE)
        / Dot11AssoReq()
        / Dot11Elt(ID="SSID", info=b"HQ-Secure"),
        RadioTap(dBm_AntSignal=-48, ChannelFrequency=2437)
        / Dot11(type=0, subtype=0, addr1=AP_GUEST, addr2=LAPTOP, addr3=AP_GUEST)
        / Dot11AssoReq()
        / Dot11Elt(ID="SSID", info=b"HQ-Guest"),
        RadioTap(dBm_AntSignal=-46, ChannelFrequency=5180)
        / Dot11(type=2, subtype=0, FCfield=1, addr1=AP_SECURE, addr2=PHONE, addr3=WEB)
        / IP(src="10.30.0.44", dst="10.10.20.80")
        / TCP(sport=49321, dport=80, flags="PA")
        / Raw(load=_http_get("intranet.hq.local", "/wifi")),
        RadioTap(dBm_AntSignal=-40, ChannelFrequency=5180)
        / Dot11(
            type=2,
            subtype=0,
            FCfield=3,
            addr1=AP_GUEST,
            addr2=AP_SECURE,
            addr3=PHONE,
            addr4=LAPTOP,
        )
        / Raw(load=b"wds-bridge"),
    ]
    return pkts


# A branch office surveyed twice, a week apart, for comparing captures.
BR_STAFF = "00:3a:9a:b0:00:01"
BR_GUEST = "00:3a:9a:b0:00:02"
BR_CAMS = "00:3a:9a:b0:00:03"
BR_ROGUE = "02:0c:29:66:6e:01"  # a soft AP broadcasting the staff network's name
BR_LAPTOP = "f0:18:98:60:00:01"
BR_PHONE = "a4:c3:f0:60:00:02"
BR_CAM_DOOR = "00:40:8c:60:00:03"
BR_CAM_YARD = "00:40:8c:60:00:04"
BR_PRINTER = "00:17:c8:60:00:05"
BR_TABLET = "dc:a9:04:60:00:06"
BR_RANDOM_A = "da:a1:19:3c:5e:71"  # a phone's randomized MAC...
BR_RANDOM_B = "6e:4f:02:9b:d3:28"  # ...and the one it rotated to


def _assoc(sta: str, ap: str, ssid: str, freq: int, signal: int) -> RadioTap:
    return (
        RadioTap(dBm_AntSignal=signal, ChannelFrequency=freq)
        / Dot11(type=0, subtype=0, addr1=ap, addr2=sta, addr3=ap)
        / Dot11AssoReq()
        / Dot11Elt(ID="SSID", info=ssid.encode())
    )


def _probe(sta: str, ssid: str, freq: int, signal: int) -> RadioTap:
    return (
        RadioTap(dBm_AntSignal=signal, ChannelFrequency=freq)
        / Dot11(type=0, subtype=4, addr1="ff:ff:ff:ff:ff:ff", addr2=sta, addr3="ff:ff:ff:ff:ff:ff")
        / Dot11ProbeReq()
        / Dot11Elt(ID="SSID", info=ssid.encode())
    )


def branch_baseline_packets() -> list:
    return [
        _beacon(BR_STAFF, "Branch-Staff", 36, 5180, -41, RSN_8021X),
        _beacon(BR_GUEST, "Branch-Guest", 6, 2437, -52, RSN_PSK),
        _beacon(BR_CAMS, "Branch-Cams", 11, 2462, -63, RSN_PSK),
        _assoc(BR_LAPTOP, BR_STAFF, "Branch-Staff", 5180, -47),
        _assoc(BR_PRINTER, BR_STAFF, "Branch-Staff", 5180, -58),
        _assoc(BR_PHONE, BR_GUEST, "Branch-Guest", 2437, -55),
        _assoc(BR_CAM_DOOR, BR_CAMS, "Branch-Cams", 2462, -66),
        _assoc(BR_CAM_YARD, BR_CAMS, "Branch-Cams", 2462, -71),
        _probe(BR_RANDOM_A, "Pixel-7-Hotspot", 2437, -60),
        _assoc(BR_RANDOM_A, BR_GUEST, "Branch-Guest", 2437, -59),
    ]


def branch_later_packets() -> list:
    """The same branch a week later: something of every kind has changed."""
    return [
        _beacon(BR_STAFF, "Branch-Staff", 36, 5180, -42, RSN_8021X),
        _beacon(BR_GUEST, "Branch-Guest", 6, 2437, -50, RSN_PSK),
        _beacon(BR_CAMS, "Branch-Cams", 11, 2462, -64, RSN_PSK),
        _beacon(BR_ROGUE, "Branch-Staff", 1, 2412, -49, None),  # open, same name: rogue
        _assoc(BR_LAPTOP, BR_GUEST, "Branch-Guest", 2437, -48),  # moved staff -> guest
        _assoc(BR_PHONE, BR_GUEST, "Branch-Guest", 2437, -54),  # unchanged
        _assoc(BR_CAM_DOOR, BR_CAMS, "Branch-Cams", 2462, -65),  # unchanged
        _probe(BR_CAM_YARD, "Branch-Cams", 2462, -74),  # still here, no longer joined
        _assoc(BR_TABLET, BR_STAFF, "Branch-Staff", 5180, -45),  # new
        _probe(BR_RANDOM_B, "Pixel-7-Hotspot", 2437, -61),  # the phone, new random MAC
        _assoc(BR_RANDOM_B, BR_GUEST, "Branch-Guest", 2437, -58),
        # The printer isn't heard at all.
    ]


# A small office with the usual problems, for trying Security.
LAB_GW = "00:1b:2f:70:00:01"  # router: Telnet, an old web admin, TLS 1.0
LAB_FILES = "00:25:90:70:00:10"  # file server: OpenSSH 7.4, FTP, SMB
LAB_WEB = "00:25:90:70:00:20"  # intranet: Apache 2.4.49, OpenSSL 1.0.2k, PHP 7.4.3
LAB_CAM = "00:40:8c:70:00:30"  # IP camera: RomPager 4.07, Telnet
LAB_PRINTER = "00:17:c8:70:00:40"  # printer: SNMP
LAB_NEW = "00:25:90:70:00:50"  # a well-kept server, for contrast
LAB_IOT = "b0:4e:26:70:00:60"  # a smart relay running a server NetSeer doesn't know yet
LAB_PC = "f0:18:98:70:01:00"
RSN_SAE = bytes.fromhex("0100000fac040100000fac040100000fac080000")
WPS_IE = bytes.fromhex("0050f204104a000110104400010210470010") + bytes(16)

_LAB_IPS = {LAB_GW: "10.20.0.1", LAB_FILES: "10.20.0.10", LAB_WEB: "10.20.0.20", LAB_CAM: "10.20.0.30", LAB_PRINTER: "10.20.0.40", LAB_NEW: "10.20.0.50", LAB_IOT: "10.20.0.60", LAB_PC: "10.20.0.100"}


def _lab_reply(mac: str, sport: int, payload: bytes, proto=TCP) -> Ether:
    """A packet from a lab device back to the PC."""
    layer = proto(sport=sport, dport=51000 + sport % 1000) if proto is UDP else TCP(sport=sport, dport=51000 + sport % 1000, flags="PA")
    return Ether(src=mac, dst=LAB_PC) / IP(src=_LAB_IPS[mac], dst=_LAB_IPS[LAB_PC]) / layer / Raw(load=payload)


def _lab_ask(mac: str, dport: int, payload: bytes, proto=TCP) -> Ether:
    layer = proto(sport=51000 + dport % 1000, dport=dport) if proto is UDP else TCP(sport=51000 + dport % 1000, dport=dport, flags="PA")
    return Ether(src=LAB_PC, dst=mac) / IP(src=_LAB_IPS[LAB_PC], dst=_LAB_IPS[mac]) / layer / Raw(load=payload)


def _server_hello(version: int, tls13: bool = False) -> bytes:
    ext = b"\x00\x2b\x00\x02\x03\x04" if tls13 else b""
    body = b"\x02" + b"\x00\x00\x46" + version.to_bytes(2, "big") + bytes(32) + b"\x00" + b"\x13\x01" + b"\x00" + len(ext).to_bytes(2, "big") + ext
    return b"\x16\x03\x03" + len(body).to_bytes(2, "big") + body


def security_lab_packets() -> list:
    pkts = [Ether(src=mac, dst="ff:ff:ff:ff:ff:ff") / ARP(op=2, hwsrc=mac, psrc=ip, pdst=ip) for mac, ip in _LAB_IPS.items()]
    http = lambda server: b"HTTP/1.1 200 OK\r\nServer: " + server + b"\r\nContent-Type: text/html\r\n\r\n<html></html>"  # noqa: E731
    pkts += [
        # Router
        _lab_ask(LAB_GW, 80, _http_get("192.168.0.1", "/login.cgi")),
        _lab_reply(LAB_GW, 80, http(b"lighttpd/1.4.35")),
        _lab_ask(LAB_GW, 23, b"\xff\xfd\x18\xff\xfd\x20"),
        _lab_reply(LAB_GW, 23, b"\xff\xfb\x01\r\nlogin: "),
        _lab_reply(LAB_GW, 443, _server_hello(0x0301)),
        # File server
        _lab_reply(LAB_FILES, 22, b"SSH-2.0-OpenSSH_7.4\r\n"),
        _lab_ask(LAB_FILES, 21, b"USER backup\r\n"),
        _lab_reply(LAB_FILES, 21, b"220 (vsFTPd 3.0.2)\r\n"),
        _lab_ask(LAB_FILES, 445, b"\x00\x00\x00\x54\xfeSMB"),
        # Intranet web server
        _lab_ask(LAB_WEB, 80, _http_get("intranet.lab.local")),
        _lab_reply(LAB_WEB, 80, b"HTTP/1.1 200 OK\r\nServer: Apache/2.4.49 (Unix) OpenSSL/1.0.2k\r\nX-Powered-By: PHP/7.4.3\r\n\r\n<html></html>"),
        # Camera
        _lab_ask(LAB_CAM, 80, _http_get("10.20.0.30", "/")),
        _lab_reply(LAB_CAM, 80, http(b"RomPager/4.07 UPnP/1.0")),
        _lab_reply(LAB_CAM, 23, b"\xff\xfb\x01(none) login: "),
        # Printer
        _lab_ask(LAB_PRINTER, 161, b"\x30\x26\x02\x01\x01\x04\x06public", UDP),
        _lab_reply(LAB_PRINTER, 161, b"\x30\x30\x02\x01\x01\x04\x06public", UDP),
        # A well-kept server: current OpenSSH, TLS 1.3
        _lab_reply(LAB_NEW, 22, b"SSH-2.0-OpenSSH_10.5\r\n"),
        _lab_reply(LAB_NEW, 443, _server_hello(0x0303, tls13=True)),
        # A service NetSeer doesn't recognize out of the box: a rebuild can look it up.
        _lab_ask(LAB_IOT, 80, _http_get("10.20.0.60", "/")),
        _lab_reply(LAB_IOT, 80, http(b"GoAhead-Webs/2.5.0")),
    ]
    return pkts


LAB_STAFF_AP = "00:1b:2f:70:10:03"
LAB_STAFF_STA = "a4:c3:f0:70:20:01"
# key_info for each message of a WPA2 4-way handshake (version 2, pairwise key).
_KEY_INFO = {1: 0x008A, 2: 0x010A, 3: 0x13CA, 4: 0x030A}


def _eapol(msg: int, freq: int = 2462) -> RadioTap:
    from_ap = msg in (1, 3)
    bssid, sta = LAB_STAFF_AP, LAB_STAFF_STA
    dot11 = Dot11(type=2, subtype=0, FCfield=2 if from_ap else 1,
                  addr1=sta if from_ap else bssid, addr2=bssid if from_ap else sta, addr3=bssid)
    nonce = bytes(32) if msg in (2, 4) else bytes([msg]) + bytes(31)
    body = bytes([2]) + _KEY_INFO[msg].to_bytes(2, "big") + (16).to_bytes(2, "big") + msg.to_bytes(8, "big") + nonce + bytes(16) + bytes(8) + bytes(8) + bytes(16) + (0).to_bytes(2, "big")
    return RadioTap(dBm_AntSignal=-52, ChannelFrequency=freq) / dot11 / LLC() / SNAP(code=0x888E) / EAPOL(version=2, type=3) / Raw(load=body)


def security_lab_wifi_packets() -> list:
    old = _beacon("00:1b:2f:70:10:02", "OldCam-AP", 1, 2412, -58, None) / Dot11Elt(ID=221, info=WPS_IE)
    old[Dot11Beacon].cap = "ESS+privacy"  # privacy bit with no WPA/RSN: WEP
    return [
        _beacon("00:1b:2f:70:10:01", "Lab-Guest", 6, 2437, -47, None),
        old,
        _beacon(LAB_STAFF_AP, "Lab-Staff", 11, 2462, -52, RSN_PSK) / Dot11Elt(ID=221, info=WPS_IE),
        _beacon("00:1b:2f:70:10:04", "Lab-Secure", 36, 5180, -44, RSN_SAE),
        # A laptop joining Lab-Staff, with the full 4-way handshake captured.
        _assoc(LAB_STAFF_STA, LAB_STAFF_AP, "Lab-Staff", 2462, -55),
        *(_eapol(m) for m in (1, 2, 3, 4)),
    ]


def kismet_netxml() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE detection-run SYSTEM "http://kismetwireless.net/kismet-3.1.0.dtd">
<detection-run kismet-version="2023.07.R1" start-time="Sun Sep 20 16:02:11 2026">
  <wireless-network number="1" type="infrastructure" wep="false" cloaked="false">
    <SSID>
      <type>Beacon</type>
      <max-rate>54.00</max-rate>
      <encryption>WPA+AES-CCM</encryption>
      <encryption>WPA+802.1X</encryption>
      <essid cloaked="false">HQ-Secure</essid>
    </SSID>
    <BSSID>00:15:6D:C0:00:01</BSSID>
    <manuf>Ubiquiti</manuf>
    <channel>36</channel>
    <freqmhz>5180</freqmhz>
    <carrier>IEEE 802.11n</carrier>
    <snr-info>
      <last_signal_dbm>-38</last_signal_dbm>
      <min_signal_dbm>-62</min_signal_dbm>
      <max_signal_dbm>-32</max_signal_dbm>
    </snr-info>
    <gps-info>
      <min-lat>37.77480</min-lat>
      <min-lon>-122.41960</min-lon>
      <max-lat>37.77510</max-lat>
      <max-lon>-122.41910</max-lon>
      <peak-lat>37.77495</peak-lat>
      <peak-lon>-122.41940</peak-lon>
      <avg-lat>37.77492</avg-lat>
      <avg-lon>-122.41935</avg-lon>
      <avg-alt>13.1</avg-alt>
    </gps-info>
    <wireless-client number="1" type="established">
      <client-mac>A4:C3:F0:50:00:11</client-mac>
      <client-manuf>Samsung</client-manuf>
      <snr-info><last_signal_dbm>-44</last_signal_dbm></snr-info>
      <gps-info>
        <avg-lat>37.77490</avg-lat>
        <avg-lon>-122.41930</avg-lon>
        <avg-alt>13.0</avg-alt>
      </gps-info>
    </wireless-client>
  </wireless-network>
  <wireless-network number="2" type="infrastructure" wep="false" cloaked="false">
    <SSID>
      <type>Beacon</type>
      <encryption>WPA+PSK</encryption>
      <encryption>WPA+AES-CCM</encryption>
      <essid cloaked="false">HQ-Guest</essid>
    </SSID>
    <BSSID>00:15:6D:C0:00:02</BSSID>
    <manuf>Ubiquiti</manuf>
    <channel>6</channel>
    <freqmhz>2437</freqmhz>
    <snr-info>
      <last_signal_dbm>-51</last_signal_dbm>
      <min_signal_dbm>-70</min_signal_dbm>
      <max_signal_dbm>-47</max_signal_dbm>
    </snr-info>
    <gps-info>
      <avg-lat>37.77488</avg-lat>
      <avg-lon>-122.41950</avg-lon>
      <avg-alt>12.4</avg-alt>
    </gps-info>
    <wireless-client number="1" type="established">
      <client-mac>F0:18:98:50:00:22</client-mac>
      <client-manuf>Apple</client-manuf>
      <snr-info><last_signal_dbm>-48</last_signal_dbm></snr-info>
    </wireless-client>
  </wireless-network>
  <wireless-network number="3" type="infrastructure" wep="false" cloaked="false">
    <SSID>
      <type>Beacon</type>
      <encryption>WPA+PSK</encryption>
      <essid cloaked="false">sensors</essid>
    </SSID>
    <BSSID>00:15:6D:C0:00:03</BSSID>
    <manuf>Ubiquiti</manuf>
    <channel>11</channel>
    <freqmhz>2462</freqmhz>
    <snr-info>
      <last_signal_dbm>-70</last_signal_dbm>
    </snr-info>
    <gps-info>
      <avg-lat>37.77502</avg-lat>
      <avg-lon>-122.41922</avg-lon>
    </gps-info>
  </wireless-network>
</detection-run>
"""


def kismet_csv() -> str:
    return """BSSID,NetType,ESSID,Channel,Encryption,MaxRate,BestSignal,GPSBestLat,GPSBestLon,GPSBestAlt,FirstTime,LastTime
00:15:6D:C0:00:01,infrastructure,HQ-Secure,36,WPA2-802.1X,54,-32,37.77495,-122.41940,13.0,2026-09-20 16:02:11,2026-09-20 16:18:02
00:15:6D:C0:00:02,infrastructure,HQ-Guest,6,WPA2-PSK,54,-47,37.77488,-122.41950,12.4,2026-09-20 16:02:14,2026-09-20 16:18:02
00:15:6D:C0:00:03,infrastructure,sensors,11,WPA2-PSK,54,-70,37.77502,-122.41922,12.1,2026-09-20 16:05:01,2026-09-20 16:17:40
"""


def airodump_csv() -> str:
    return """BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key
00:15:6D:C0:00:01, 2026-09-20 16:02:11, 2026-09-20 16:18:02, 36, 54, WPA2, CCMP, MGT, -38, 412, 18, 0.0.0.0, 9, HQ-Secure,
00:15:6D:C0:00:02, 2026-09-20 16:02:14, 2026-09-20 16:18:02, 6, 54, WPA2, CCMP, PSK, -51, 288, 4, 10.30.0.1, 8, HQ-Guest,
00:15:6D:C0:00:03, 2026-09-20 16:05:01, 2026-09-20 16:17:40, 11, 54, WPA2, CCMP, PSK, -70, 90, 0, 0.0.0.0, 7, sensors,

Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probed ESSIDs
A4:C3:F0:50:00:11, 2026-09-20 16:03:01, 2026-09-20 16:17:55, -44, 120, 00:15:6D:C0:00:01, HQ-Secure
F0:18:98:50:00:22, 2026-09-20 16:04:12, 2026-09-20 16:17:40, -48, 86, 00:15:6D:C0:00:02, HQ-Guest,HQ-Secure
8C:85:90:50:00:33, 2026-09-20 16:08:00, 2026-09-20 16:08:40, -81, 6, (not associated), HQ-Guest
"""


# The samples' packets are spread over ten minutes from a fixed start, so the timeline
# has something to show and the files come out the same every time.
SAMPLE_START = 1_789_920_131.0  # 2026-09-20 16:02:11 UTC, the Kismet sample's start time
SAMPLE_MINUTES = 10


def _timed(pkts: list, offset: float = 0.0) -> list:
    step = SAMPLE_MINUTES * 60 / max(1, len(pkts) - 1)
    for i, pkt in enumerate(pkts):
        pkt.time = SAMPLE_START + offset + i * step
    return pkts


def wigle_wardrive() -> str:
    """A short WiGLE wardrive: a drive past a few access points, Bluetooth gadgets, and a cell tower.

    Each transmitter is heard from several points along the route with the signal rising and falling
    by distance, so the geo map shows real tracks and a signal-weighted estimated location per device.
    """
    # Access points at fixed real locations (near the Kismet sample's area).
    aps = [
        ("aa:bb:cc:00:00:01", 37.77470, -122.41980, "Blue Bottle", 6, 2437, "[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]"),
        ("aa:bb:cc:00:00:02", 37.77455, -122.41930, "CityWiFi-Free", 11, 2462, "[ESS]"),
        ("aa:bb:cc:00:00:03", 37.77500, -122.41905, "Printer_5G", 149, 5745, "[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]"),
        ("aa:bb:cc:00:00:04", 37.77520, -122.41860, "Netgear-Guest", 1, 2412, "[WPA2-PSK-CCMP][ESS]"),
        ("aa:bb:cc:00:00:05", 37.77445, -122.41875, "oldrouter", 3, 2422, "[WEP][ESS]"),
    ]
    bts = [
        ("a2:14:22:00:00:11", 37.77472, -122.41975, "Fitbit Charge", "BLE", "Misc"),
        ("b6:30:9c:00:00:22", 37.77458, -122.41928, "", "BT", "Uncategorized;10"),
    ]
    cell = ("310260_41021_118273301", 37.78100, -122.41500, "T-Mobile USA", "LTE", "310260", 1275)

    # The drive: east along the block, then curving north. One point every 20 s.
    route = []
    lat, lon, t = 37.77460, -122.42010, SAMPLE_START
    for i in range(16):
        lon += 0.00022
        if i >= 8:
            lat += 0.00016
            lon -= 0.00004
        route.append((round(lat, 6), round(lon, 6), t + i * 20.0))

    def dist_m(la, lo, la2, lo2):
        return math.hypot((lo2 - lo) * 111_320.0 * math.cos(math.radians(la)), (la2 - la) * 111_320.0)

    def rssi(d):  # stronger up close; log-distance falloff, clamped to a believable range
        return int(max(-95, min(-30, round(-40 - 22 * math.log10(max(1.0, d / 4.0))))))

    def when(ts):
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    rows = []
    for la, lo, ts in route:
        for mac, ala, alo, ssid, ch, fr, auth in aps:
            d = dist_m(la, lo, ala, alo)
            if d <= 150:
                rows.append(f"{mac},{ssid},{auth},{when(ts)},{ch},{fr},{rssi(d)},{la:.6f},{lo:.6f},12.0,5.0,,,WIFI")
        for mac, bla, blo, name, typ, cls in bts:
            d = dist_m(la, lo, bla, blo)
            if d <= 70:
                fr = "7936" if typ == "BT" else ""
                rows.append(f"{mac},{name},{cls},{when(ts)},,{fr},{rssi(d)},{la:.6f},{lo:.6f},12.0,5.0,,,{typ}")
        cid, cla, clo, carrier, radio, plmn, earfcn = cell
        rows.append(f"{cid},{carrier},{radio};{plmn},{when(ts)},{earfcn},{earfcn},{rssi(dist_m(la, lo, cla, clo))},{la:.6f},{lo:.6f},12.0,5.0,,,{radio}")

    header = (
        "WigleWifi-1.6,appRelease=NetSeer demo,model=demo,release=16,device=demo,display=demo,board=demo,brand=demo\n"
        "MAC,SSID,AuthMode,FirstSeen,Channel,Frequency,RSSI,CurrentLatitude,CurrentLongitude,AltitudeMeters,AccuracyMeters,RCOIs,MfgrId,Type\n"
    )
    return header + "\n".join(rows) + "\n"


def write_all(dest: Path | None = None) -> Path:
    dest = dest or DATA
    dest.mkdir(parents=True, exist_ok=True)
    wrpcap(str(dest / "office-lan.pcap"), _timed(office_lan_packets()))
    wrpcap(str(dest / "empty-capture.pcap"), [])
    wifi = dest / "wifi-campus.pcapng"
    with PcapNgWriter(str(wifi)) as writer:
        for pkt in _timed(wifi_packets(), offset=45.0):
            writer.write(pkt)
    for name, pkts, offset in (
        ("branch-baseline.pcapng", branch_baseline_packets(), 0.0),
        ("branch-later.pcapng", branch_later_packets(), 7 * 24 * 3600.0),  # a week later
    ):
        with PcapNgWriter(str(dest / name)) as writer:
            for pkt in _timed(pkts, offset=offset):
                writer.write(pkt)
    wrpcap(str(dest / "security-lab.pcap"), _timed(security_lab_packets()))
    with PcapNgWriter(str(dest / "security-lab-wifi.pcapng")) as writer:
        for pkt in _timed(security_lab_wifi_packets()):
            writer.write(pkt)
    (dest / "kismet-walk.netxml").write_text(kismet_netxml(), encoding="utf-8")
    (dest / "kismet-aps.csv").write_text(kismet_csv(), encoding="utf-8")
    (dest / "airodump-ng.csv").write_text(airodump_csv(), encoding="utf-8")
    (dest / "wardrive.wiglewifi.csv").write_text(wigle_wardrive(), encoding="utf-8")
    return dest


if __name__ == "__main__":
    path = write_all()
    print(f"Wrote samples to {path}")
