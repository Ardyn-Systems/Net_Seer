"""Rasterize the brand SVGs into every icon the app and installers use.

    python packaging/brand/render.py      (needs pymupdf and pillow)
"""
from pathlib import Path

import pymupdf
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WEB = ROOT / "src" / "netseer" / "web"


def render(svg: Path, size: int) -> Image.Image:
    doc = pymupdf.open(stream=svg.read_bytes(), filetype="svg")
    page = doc[0]
    zoom = size / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=True)
    return Image.frombytes("RGBA", (pix.width, pix.height), pix.samples)


def icon(size: int) -> Image.Image:
    # Under 48 px the full artwork turns to mush; use the simplified mark.
    return render(HERE / ("netseer-logo-small.svg" if size <= 32 else "netseer-logo.svg"), size)


def main() -> None:
    (WEB / "logo.svg").write_bytes((HERE / "netseer-logo.svg").read_bytes())
    (WEB / "logo-small.svg").write_bytes((HERE / "netseer-logo-small.svg").read_bytes())
    icon(512).save(WEB / "logo.png", optimize=True)
    icon(192).save(WEB / "logo-192.png", optimize=True)
    icon(64).save(WEB / "favicon.png", optimize=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = {s: icon(s) for s in sizes}
    # Pillow writes each requested size from the largest frame unless given them all.
    frames[256].save(WEB / "favicon.ico", sizes=[(s, s) for s in (16, 32, 48)], append_images=[frames[s] for s in (16, 32, 48)])
    frames[256].save(ROOT / "packaging" / "windows" / "netseer.ico", sizes=[(s, s) for s in sizes], append_images=[frames[s] for s in sizes])
    linux = ROOT / "packaging" / "linux"
    linux.mkdir(exist_ok=True)
    icon(256).save(linux / "netseer.png", optimize=True)
    (linux / "netseer.svg").write_bytes((HERE / "netseer-logo.svg").read_bytes())
    print("Wrote web, Windows, and Linux icons")


if __name__ == "__main__":
    main()
