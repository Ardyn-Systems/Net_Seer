"""Rasterize the brand icon into every size the app and installers use.

    python packaging/brand/render.py      (needs pillow)

The master is ``netseer-logo.png`` — the icon mark (eye over a peak, the ridgeline a traffic
graph) with a transparent background, so it floats on any surface. ``logo.svg`` and
``logo-small.svg`` are thin SVG wrappers that embed a PNG, so references that expect an SVG keep
working and scale crisply.
"""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WEB = ROOT / "src" / "netseer" / "web"
MASTER = Image.open(HERE / "netseer-logo.png").convert("RGBA")


def icon(size: int) -> Image.Image:
    return MASTER.resize((size, size), Image.LANCZOS)


def svg_wrapper(size: int) -> bytes:
    buf = BytesIO()
    icon(size).save(buf, format="PNG", optimize=True)
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
        f'<title>NetSeer</title>'
        f'<image width="{size}" height="{size}" href="data:image/png;base64,{data}"/>'
        f"</svg>\n"
    ).encode("utf-8")


def main() -> None:
    (WEB / "logo.svg").write_bytes(svg_wrapper(256))
    (WEB / "logo-small.svg").write_bytes(svg_wrapper(64))
    icon(512).save(WEB / "logo.png", optimize=True)
    icon(192).save(WEB / "logo-192.png", optimize=True)
    icon(64).save(WEB / "favicon.png", optimize=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = {s: icon(s) for s in sizes}
    # Pillow writes each requested size from the largest frame unless given them all.
    frames[256].save(WEB / "favicon.ico", sizes=[(s, s) for s in (16, 32, 48)], append_images=[frames[s] for s in (16, 32, 48)])
    win = ROOT / "packaging" / "windows"
    win.mkdir(exist_ok=True)
    frames[256].save(win / "netseer.ico", sizes=[(s, s) for s in sizes], append_images=[frames[s] for s in sizes])
    linux = ROOT / "packaging" / "linux"
    linux.mkdir(exist_ok=True)
    icon(256).save(linux / "netseer.png", optimize=True)
    (linux / "netseer.svg").write_bytes(svg_wrapper(256))
    print("Wrote web, Windows, and Linux icons")


if __name__ == "__main__":
    main()
