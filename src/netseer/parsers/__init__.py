from __future__ import annotations

from netseer.graph import GraphBuilder
from netseer.parsers.airodump import parse_airodump_csv
from netseer.parsers.kismet import parse_kismet_csv, parse_kismet_netxml
from netseer.parsers.pcap import parse_pcap


def parse_into(builder: GraphBuilder, data: bytes, filename: str, kind: str) -> None:
    builder.note_source(filename)
    if kind in {"pcap", "pcapng"}:
        parse_pcap(builder, data, filename)
    elif kind == "kismet-netxml":
        parse_kismet_netxml(builder, data, filename)
    elif kind == "kismet-csv":
        parse_kismet_csv(builder, data, filename)
    elif kind == "airodump-csv":
        parse_airodump_csv(builder, data, filename)
    else:
        raise ValueError(f"Unknown parser kind: {kind}")
