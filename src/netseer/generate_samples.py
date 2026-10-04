"""Generate synthetic but realistic survey files next to this package."""

from __future__ import annotations

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
)
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


def write_all(dest: Path | None = None) -> Path:
    dest = dest or DATA
    dest.mkdir(parents=True, exist_ok=True)
    wrpcap(str(dest / "office-lan.pcap"), office_lan_packets())
    wrpcap(str(dest / "empty-capture.pcap"), [])
    wifi = dest / "wifi-campus.pcapng"
    with PcapNgWriter(str(wifi)) as writer:
        for pkt in wifi_packets():
            writer.write(pkt)
    (dest / "kismet-walk.netxml").write_text(kismet_netxml(), encoding="utf-8")
    (dest / "kismet-aps.csv").write_text(kismet_csv(), encoding="utf-8")
    (dest / "airodump-ng.csv").write_text(airodump_csv(), encoding="utf-8")
    return dest


if __name__ == "__main__":
    path = write_all()
    print(f"Wrote samples to {path}")
