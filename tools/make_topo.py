"""Draw the Terrain theme's background: contour lines of made-up hills, as an SVG tile.

    python tools/make_topo.py            # writes src/netseer/web/topo.svg

The height field is built from periodic pieces, so the tile repeats without seams. Every
fifth contour is an index line (heavier, with a few elevation labels), like a survey map.
The same seed always gives the same picture.
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

TILE = 1200  # px; big enough that the repeat isn't obvious
STEP = 6  # grid spacing for tracing, px
SEED = 7
LINE = "#c99a5b"
CANVAS = "#171610"  # Terrain's --canvas, used to cut a gap behind labels
OUT = Path(__file__).resolve().parents[1] / "src" / "netseer" / "web" / "topo.svg"

rng = random.Random(SEED)
TAU = 2 * math.pi


def periodic_bump(cx: float, cy: float, sigma: float):
    """A smooth hill that wraps around the tile edges (a von Mises bump)."""
    k = 1 / (TAU * sigma / TILE) ** 2
    return lambda x, y: math.exp(k * (math.cos(TAU * (x - cx) / TILE) - 1) + k * (math.cos(TAU * (y - cy) / TILE) - 1))


hills = []
for _ in range(11):
    amp = rng.uniform(0.55, 1.35) * (1 if rng.random() > 0.25 else -0.7)
    hills.append((amp, periodic_bump(rng.uniform(0, TILE), rng.uniform(0, TILE), rng.uniform(70, 230))))
waves = [(rng.uniform(0.04, 0.11), rng.randint(1, 6), rng.randint(-6, 6), rng.uniform(0, TAU)) for _ in range(9)]


def height(x: float, y: float) -> float:
    h = sum(a * f(x, y) for a, f in hills)
    h += sum(a * math.cos(TAU * (fx * x + fy * y) / TILE + ph) for a, fx, fy, ph in waves)
    return h


N = TILE // STEP
grid = [[height(i * STEP, j * STEP) for i in range(N + 1)] for j in range(N + 1)]
lo = min(min(r) for r in grid)
hi = max(max(r) for r in grid)
LEVELS = 46
GAP = (hi - lo) / LEVELS
levels = [lo + GAP * (k + 0.5) for k in range(LEVELS)]


def trace(level: float) -> list[list[tuple[float, float]]]:
    """Marching squares, then join the pieces into polylines."""
    segs = []

    def cross(a, b, va, vb):
        t = (level - va) / (vb - va)
        return (round(a[0] + t * (b[0] - a[0]), 2), round(a[1] + t * (b[1] - a[1]), 2))

    for j in range(N):
        for i in range(N):
            corners = [(i * STEP, j * STEP), ((i + 1) * STEP, j * STEP), ((i + 1) * STEP, (j + 1) * STEP), (i * STEP, (j + 1) * STEP)]
            vals = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]
            pts = []
            for e in range(4):
                a, b = e, (e + 1) % 4
                if (vals[a] < level) != (vals[b] < level):
                    pts.append(cross(corners[a], corners[b], vals[a], vals[b]))
            if len(pts) == 2:
                segs.append((pts[0], pts[1]))
            elif len(pts) == 4:  # saddle: pair by the centre value
                centre = sum(vals) / 4
                if (centre < level) == (vals[0] < level):
                    segs += [(pts[0], pts[3]), (pts[1], pts[2])]
                else:
                    segs += [(pts[0], pts[1]), (pts[2], pts[3])]
    ends: dict[tuple[float, float], list[int]] = {}
    for n, (a, b) in enumerate(segs):
        ends.setdefault(a, []).append(n)
        ends.setdefault(b, []).append(n)
    used = [False] * len(segs)
    lines = []
    for n in range(len(segs)):
        if used[n]:
            continue
        used[n] = True
        line = list(segs[n])
        for forward in (True, False):
            while True:
                tip = line[-1] if forward else line[0]
                nxt = next((m for m in ends.get(tip, []) if not used[m]), None)
                if nxt is None:
                    break
                used[nxt] = True
                a, b = segs[nxt]
                p = b if a == tip else a
                line.append(p) if forward else line.insert(0, p)
        if len(line) > 3:
            lines.append(line)
    return lines


def simplify(line, eps=0.45):
    """Ramer-Douglas-Peucker: drop points that sit within eps px of the line through their neighbours."""
    if len(line) < 3:
        return line
    (x0, y0), (x1, y1) = line[0], line[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = math.hypot(dx, dy)
    far, at = -1.0, 0
    for k in range(1, len(line) - 1):
        px, py = line[k]
        d = abs(dy * (px - x0) - dx * (py - y0)) / norm if norm else math.hypot(px - x0, py - y0)
        if d > far:
            far, at = d, k
    if far <= eps:
        return [line[0], line[-1]]
    return simplify(line[: at + 1], eps)[:-1] + simplify(line[at:], eps)


def smooth(line):
    """One pass of Chaikin smoothing; open lines keep their ends so tiles still meet."""
    closed = line[0] == line[-1]
    pts = line[:-1] if closed else line
    out = [] if closed else [pts[0]]
    count = len(pts) if closed else len(pts) - 1
    for k in range(count):
        (x0, y0), (x1, y1) = pts[k], pts[(k + 1) % len(pts)]
        out += [(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1), (0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)]
    if closed:
        out.append(out[0])
    else:
        out[-1] = pts[-1]
    return out


def path(line) -> str:
    x, y = line[0]
    d = [f"M{x:.1f} {y:.1f}"]
    for (px, py), (qx, qy) in zip(line, line[1:]):
        d.append(f"{qx - px:.1f} {qy - py:.1f}")
    return d[0] + "l" + " ".join(d[1:])


sys.setrecursionlimit(10000)  # simplify() recurses along long lines
minor, index, labels, taken = [], [], [], []
for k, level in enumerate(levels):
    per_level = 0
    for line in trace(level):
        dense = smooth(line)
        line = smooth(simplify(line))
        (index if k % 5 == 2 else minor).append(path(line))
        # Label some index lines along the line, at most two per height, spread apart.
        if k % 5 == 2 and len(dense) > 80 and per_level < 2 and rng.random() < 0.7:
            mid = int(len(dense) * rng.uniform(0.3, 0.7))
            line = dense
            if any(math.hypot(line[mid][0] - x, line[mid][1] - y) < 260 for x, y in taken):
                continue
            (x0, y0), (x1, y1) = line[mid - 3], line[mid + 3]
            if 40 < line[mid][0] < TILE - 40 and 40 < line[mid][1] < TILE - 40:
                angle = math.degrees(math.atan2(y1 - y0, x1 - x0))
                if angle > 90:
                    angle -= 180
                elif angle < -90:
                    angle += 180
                elevation = 200 + k * 20
                taken.append(line[mid])
                per_level += 1
                labels.append(f'<text transform="translate({line[mid][0]:.0f} {line[mid][1]:.0f}) rotate({angle:.0f})">{elevation}</text>')

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{TILE}" height="{TILE}" viewBox="0 0 {TILE} {TILE}">
<g fill="none" stroke="{LINE}" stroke-linejoin="round" stroke-linecap="round">
<path stroke-opacity="0.08" stroke-width="0.9" d="{' '.join(minor)}"/>
<path stroke-opacity="0.16" stroke-width="1.4" d="{' '.join(index)}"/>
</g>
<g font-family="Segoe UI, Ubuntu, sans-serif" font-size="11" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="{LINE}" fill-opacity="0.32" stroke="{CANVAS}" stroke-width="5" paint-order="stroke">
{chr(10).join(labels)}
</g>
</svg>
"""
OUT.write_text(svg, encoding="utf-8", newline="\n")
print(f"{OUT.name}: {len(svg) / 1024:.0f} KB, {len(minor)} minor and {len(index)} index lines, {len(labels)} labels")
