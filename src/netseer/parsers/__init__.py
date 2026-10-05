from __future__ import annotations

from pathlib import Path
from typing import Callable

from netseer.graph import GraphBuilder
from netseer.parsers.airodump import parse_airodump_csv
from netseer.parsers.kismet import parse_kismet_csv, parse_kismet_netxml
from netseer.parsers.kismetdb import parse_kismetdb
from netseer.parsers.pcap import parse_pcap

# progress(packets, fraction of this file read 0..1)
Progress = Callable[[int, float], None]


def parse_into(
    builder: GraphBuilder,
    source: bytes | Path,
    filename: str,
    kind: str,
    *,
    progress: Progress | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> None:
    """Parse one capture, from bytes or from a file on disk (big captures stream from disk)."""
    builder.note_source(filename)
    size = source.stat().st_size if isinstance(source, Path) else len(source)
    if kind in {"pcap", "pcapng"}:
        def report(packets: int, done: int) -> None:
            if progress is not None:
                progress(packets, done / size if size else 0.0)

        if isinstance(source, Path):
            with open(source, "rb", buffering=1024 * 1024) as stream:
                parse_pcap(builder, stream, filename, progress=report, should_stop=should_stop)
        else:
            parse_pcap(builder, source, filename, progress=report, should_stop=should_stop)
    elif kind == "kismetdb":
        parse_kismetdb(builder, source, filename, progress=progress, should_stop=should_stop)
    elif kind == "kismet-netxml":
        parse_kismet_netxml(builder, source, filename)
    elif kind == "kismet-csv":
        parse_kismet_csv(builder, _bytes(source), filename)
    elif kind == "airodump-csv":
        parse_airodump_csv(builder, _bytes(source), filename)
    else:
        raise ValueError(f"Unknown parser kind: {kind}")


def _bytes(source: bytes | Path) -> bytes:
    return source.read_bytes() if isinstance(source, Path) else source
