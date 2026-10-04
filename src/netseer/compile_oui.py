"""Compile IEEE OUI/MA-M/OUI36/CID CSVs into a compact gzipped table."""

from __future__ import annotations

import argparse
import csv
import gzip
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data" / "ieee-oui.tsv.gz"


def _load_csv(path: Path) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            assignment = (row.get("Assignment") or "").strip().replace(" ", "").lower()
            name = (row.get("Organization Name") or "").strip().strip('"')
            name = " ".join(name.split())
            if assignment and name and all(c in "0123456789abcdef" for c in assignment):
                rows.append((assignment, name))
    return rows


def compile_files(paths: list[Path], dest: Path | None = None) -> Path:
    dest = dest or DATA
    dest.parent.mkdir(parents=True, exist_ok=True)
    merged: dict[str, str] = {}
    for path in paths:
        for prefix, name in _load_csv(path):
            # Longer prefixes override shorter ones for the same key; unique keys otherwise.
            merged[prefix] = name
    lines = [f"{prefix}\t{merged[prefix]}\n" for prefix in sorted(merged, key=lambda p: (len(p), p))]
    with gzip.open(dest, "wt", encoding="utf-8") as handle:
        handle.write(f"# IEEE MA-L / MA-M / MA-S / CID assignments ({len(merged)} prefixes)\n")
        handle.writelines(lines)
    return dest


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile IEEE OUI CSVs into NetSeer data.")
    parser.add_argument("csvs", nargs="+", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=DATA)
    args = parser.parse_args()
    path = compile_files(args.csvs, args.output)
    print(f"Wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
