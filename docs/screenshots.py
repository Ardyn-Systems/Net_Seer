"""Capture the screenshots in docs/user-guide.md by driving NetSeer with Playwright.

    uv sync --group docs
    uv run playwright install chromium        # or pass --channel msedge / chrome to use an installed browser
    uv run python docs/screenshots.py

Starts NetSeer on a spare port with a fresh browser profile (so the bundled campus
sample loads), walks through the app, and writes PNGs to docs/images/.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "docs" / "images"
VIEWPORT = {"width": 1440, "height": 900}

from playwright.sync_api import Page, sync_playwright  # noqa: E402

# Settings → Updates asks GitHub for releases; answer with a fixed example list instead.
EXAMPLE_NOTES = """An example release, for the user guide's pictures.

## What's new

- **Faster maps:** large captures open about twice as fast.
- **Find a device** also searches open ports.
- Fixes: subnet boxes no longer overlap on narrow windows.
"""
EXAMPLE_RELEASES = [
    {"tag_name": tag, "name": f"NetSeer {tag[1:]}", "draft": False, "prerelease": False, "published_at": date, "body": EXAMPLE_NOTES,
     "html_url": f"https://github.com/ardyn-systems/NetSeer/releases/tag/{tag}",
     "assets": [{"name": f"NetSeer-Setup-{tag[1:]}.exe", "browser_download_url": f"https://github.com/ardyn-systems/NetSeer/releases/download/{tag}/NetSeer-Setup-{tag[1:]}.exe", "size": size}]}
    for tag, date, size in (("v0.5.0", "2026-12-01T12:00:00Z", 27_400_000), ("v0.4.0", "2026-10-05T12:00:00Z", 26_900_000), ("v0.3.1", "2026-10-05T02:00:00Z", 26_367_868))
]


def fake_updater(context) -> None:
    """Show the desktop app's update wizard without downloading or installing anything."""
    calls = {"started": False, "polls": 0}

    def health(route):
        resp = route.fetch()
        data = resp.json()
        data["updater"] = True
        route.fulfill(response=resp, body=json.dumps(data))

    def update(route):
        name = route.request.url.rsplit("/", 1)[-1]
        if name == "start":
            calls.update(started=True, polls=0)
        if name == "status" and calls["started"]:
            calls["polls"] += 1
        state = "idle" if not calls["started"] else "downloading" if calls["polls"] < 2 else "ready"
        body = {"status": state, "tag": "v0.5.0", "done": 9_000_000, "total": 27_400_000}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    context.route("**/api/health", health)
    context.route("**/api/update/*", update)

CALLOUT_CSS = """
.ns-callout { position: fixed; z-index: 9999; width: 30px; height: 30px; border-radius: 50%;
  background: #e0a84a; color: #2a1d05; font: 700 15px/30px system-ui, sans-serif; text-align: center;
  box-shadow: 0 0 0 3px #15140f, 0 4px 14px rgba(0,0,0,.5); pointer-events: none; }
.ns-ring { position: fixed; z-index: 9998; border: 2px solid #e0a84a; border-radius: 12px; pointer-events: none; }
"""


def start_server() -> tuple[str, subprocess.Popen]:
    """Run NetSeer in its own process, like a user would."""
    from netseer.desktop import free_ephemeral_port, wait_ready

    port = free_ephemeral_port()
    env = dict(
        os.environ,
        PYTHONPATH=str(ROOT / "src"),
        NETSEER_UNWANTED_DIR=tempfile.mkdtemp(prefix="netseer-docs-"),
        # Show Settings → Updates as the Windows installer sees it.
        NETSEER_MODE="desktop",
        NETSEER_PACKAGE="installer",
    )
    server = subprocess.Popen(
        [sys.executable, "-m", "netseer", "--port", str(port)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready(port)
    except Exception:
        server.kill()
        raise
    return f"http://127.0.0.1:{port}/", server


class Shots:
    def __init__(self, page: Page) -> None:
        self.page = page
        self.taken: list[str] = []

    def save(self, name: str, *, selectors: list[str] | None = None, pad: int = 16, full: bool = False) -> None:
        """Screenshot the viewport, or just the area around the given elements."""
        path = OUT / f"{name}.png"
        clip = None
        if selectors and not full:
            boxes = [b for s in selectors if (b := self.page.locator(s).first.bounding_box())]
            if boxes:
                # Whole pixels keep crops crisp.
                x1 = max(0, math.floor(min(b["x"] for b in boxes) - pad))
                y1 = max(0, math.floor(min(b["y"] for b in boxes) - pad))
                x2 = min(VIEWPORT["width"], math.ceil(max(b["x"] + b["width"] for b in boxes) + pad))
                y2 = min(VIEWPORT["height"], math.ceil(max(b["y"] + b["height"] for b in boxes) + pad))
                clip = {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}
        self.page.wait_for_timeout(250)  # let transitions settle
        self.page.screenshot(path=str(path), clip=clip, timeout=15000)
        self.taken.append(path.name)
        print(f"  {path.relative_to(ROOT)}")

    def reset(self) -> None:
        """Close menus and dialogs and clear the selection."""
        self.page.evaluate(
            """() => {
              closeMenu();
              document.querySelectorAll('dialog[open]').forEach(d => d.close());
              el('search').value = ''; el('search-results').classList.add('hidden');
              state.inspectedLink = null;
              state.cy && state.cy.elements(':selected').unselect();
              renderInspector();
            }"""
        )
        self.page.mouse.move(5, 5)
        # Block body: returning a Cytoscape collection makes Playwright serialize the whole graph library.
        self.page.evaluate("() => { state.cy && state.cy.elements('.faded').removeClass('faded'); }")
        self.page.wait_for_timeout(200)


def node_where(page: Page, predicate: str) -> str:
    return page.evaluate(f"() => state.graph.nodes.find(n => {{ const r = nodeRole(overlayNode(n)); return {predicate}; }}).id")


def node_screen_pos(page: Page, node_id: str) -> tuple[float, float]:
    return tuple(
        page.evaluate(
            """(id) => { const n = state.cy.getElementById(id); const p = n.renderedPosition();
                        const b = el('map').getBoundingClientRect(); return [b.left + p.x, b.top + p.y]; }""",
            node_id,
        )
    )


def callouts(page: Page, items: list[tuple[str, str]]) -> None:
    """Number parts of the screen: (selector, corner) pairs, corner in tl/tr/bl/br/c."""
    page.add_style_tag(content=CALLOUT_CSS)
    page.evaluate(
        """(items) => items.forEach(([sel, corner], i) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            const ring = document.createElement('div'); ring.className = 'ns-ring';
            Object.assign(ring.style, { left: r.left + 2 + 'px', top: r.top + 2 + 'px', width: r.width - 4 + 'px', height: r.height - 4 + 'px' });
            const dot = document.createElement('div'); dot.className = 'ns-callout'; dot.textContent = i + 1;
            // "out" puts the badge just right of the element, vertically centred.
            const x = corner === 'out' ? r.right + 8 : corner.includes('r') ? r.right - 40 : corner === 'c' ? r.left + r.width / 2 - 15 : r.left + 10;
            const y = corner === 'out' ? r.top + r.height / 2 - 15 : corner.includes('b') ? r.bottom - 40 : corner === 'c' ? r.top + r.height / 2 - 15 : r.top + 10;
            Object.assign(dot.style, { left: x + 'px', top: y + 'px' });
            document.body.append(ring, dot);
        })""",
        items,
    )


def clear_callouts(page: Page) -> None:
    page.evaluate("() => document.querySelectorAll('.ns-callout, .ns-ring').forEach(e => e.remove())")


def capture(url: str, channel: str | None) -> list[str]:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=channel) if channel else p.chromium.launch()
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1, color_scheme="dark", accept_downloads=True)
        # Skip the first-visit "Take the tour" message, and keep the docs offline.
        context.add_init_script("if (!localStorage.getItem('netseer.prefs.v1')) localStorage.setItem('netseer.prefs.v1', '{\"tourOffered\":true}')")
        context.route("https://api.github.com/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(EXAMPLE_RELEASES)))
        fake_updater(context)
        page = context.new_page()
        page.goto(url)
        page.wait_for_function("() => typeof state !== 'undefined' && state.cy && state.cy.nodes().length > 5")
        page.wait_for_timeout(800)
        shots = Shots(page)

        # 1. First look and a tour of the screen.
        shots.save("overview", full=True)
        server_id = node_where(page, "r === 'server'")
        page.evaluate("(id) => selectNodes([id])", server_id)
        callouts(page, [("#map-title", "out"), (".sidebar", "bl"), (".search", "out"), ("#map", "tr"), ("#inspector", "tr"), ("#zoom-bar", "tl")])
        shots.save("screen-tour", full=True)
        clear_callouts(page)
        shots.reset()

        # 2. Device details, renamed with a caption.
        router = node_where(page, "r === 'gateway'")
        page.evaluate("(id) => selectNodes([id])", router)
        page.fill("#insp-name-input", "Core router")
        page.fill("#insp-caption", "Server room, rack A")
        page.fill("#insp-notes", "Replaced fans in March. Check the UPS before rebooting.")
        page.wait_for_timeout(300)
        shots.save("device-details", full=True)
        page.evaluate("() => { const d = el('all-fields'); d.open = true; d.dispatchEvent(new Event('toggle')); }")
        page.wait_for_selector("#device-fields .field-row")
        page.evaluate("() => el('all-fields').scrollIntoView({ block: 'start' })")
        shots.save("all-fields", selectors=["#inspector"], pad=0)
        shots.reset()

        # 3. A link.
        link = page.evaluate(
            "() => (state.graph.links.find(l => l.kind === 'client-server' && (l.services || []).includes('http'))"
            " || state.graph.links.find(l => l.kind === 'client-server')).id"
        )
        page.evaluate("(id) => { state.inspectedLink = id; state.cy.getElementById(id).select(); renderInspector(); }", link)
        shots.save("link-details", selectors=["#inspector-body"], pad=0)
        shots.reset()

        # 4. Find a device.
        page.click("#search")
        page.keyboard.type("HQ")
        page.wait_for_selector("#search-results li[role=option]")
        shots.save("search", selectors=[".search", "#search-results"], pad=20)
        shots.reset()

        # 5. Select several devices; toolbar, details, right-click, move menu.
        aps = page.evaluate("() => state.graph.nodes.filter(n => nodeRole(overlayNode(n)) === 'ap').map(n => n.id)")
        page.evaluate("(ids) => selectNodes(ids)", aps)
        shots.save("multi-select", full=True)
        x, y = node_screen_pos(page, aps[0])
        page.mouse.click(x, y, button="right")
        page.wait_for_selector("body > .menu")
        shots.save("context-menu", selectors=["body > .menu"], pad=60)
        page.keyboard.press("Escape")
        page.click("#selection-bar [data-sel=move]")
        page.wait_for_selector("body > .menu")
        shots.save("move-menu", selectors=["body > .menu", "#selection-bar"], pad=20)
        shots.reset()

        # 6. Sidebar tabs.
        page.hover(".list-row.active")
        page.click(".list-row.active .row-menu-btn")
        page.wait_for_selector("body > .menu")
        shots.save("maps-tab", selectors=[".tabs", ".tab-panel:not(.hidden)", "body > .menu"], pad=12)
        shots.reset()
        page.click(".tab[data-tab=surveys]")
        shots.save("surveys-tab", selectors=[".tabs", ".tab-panel:not(.hidden)"], pad=12)
        row = page.locator('#survey-list .list-row[data-id="office-lan"]')
        box = row.bounding_box()
        page.mouse.click(box["x"] + 60, box["y"] + box["height"] / 2, button="right")
        page.wait_for_selector("body > .menu")
        shots.save("survey-menu", selectors=[".tabs", ".tab-panel:not(.hidden)", "body > .menu"], pad=12)
        shots.reset()
        page.click(".tab[data-tab=layers]")
        shots.save("layers-tab", selectors=[".tabs", ".tab-panel:not(.hidden)"], pad=12)
        page.click(".tab[data-tab=maps]")

        # 7. Exports and the report dialog.
        page.click("#btn-export")
        page.wait_for_selector("body > .menu")
        shots.save("export-menu", selectors=["#btn-export", "body > .menu"], pad=20)
        page.click("body > .menu button:has-text('Report')")
        page.wait_for_selector("#report-dialog[open]")
        shots.save("report-dialog", selectors=["#report-dialog"], pad=0)
        report = page.evaluate(
            """async () => {
                const res = await fetch('/api/export/report.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...graphWithUserFields(), report: readReportForm() }) });
                return Array.from(new Uint8Array(await res.arrayBuffer()));
            }"""
        )
        save_report_pages(bytes(report))
        shots.reset()

        # 8. Themes.
        page.click("#btn-theme")
        page.wait_for_selector("body > .menu")
        shots.save("theme-menu", selectors=["#btn-theme", "body > .menu"], pad=20)
        shots.reset()
        frames = []
        for theme in ("terrain", "midnight", "daylight", "blueprint"):
            page.evaluate("(t) => applyTheme(t)", theme)
            page.wait_for_timeout(400)
            frames.append(page.screenshot())
        page.evaluate("() => applyTheme('terrain')")
        save_theme_grid(frames)

        # 9. Settings, the tour, and shortcuts.
        page.click("#btn-settings")
        page.wait_for_selector("#settings-dialog[open]")
        page.mouse.move(5, 5)
        shots.save("settings-general", selectors=["#settings-dialog"], pad=0)
        page.click('.settings-nav [data-pane="data"]')
        shots.save("settings-data", selectors=["#settings-dialog"], pad=0)
        page.click('.settings-nav [data-pane="updates"]')
        page.click("#updates-check")
        page.wait_for_selector("#release-list .release-name")
        page.mouse.move(5, 5)
        shots.save("settings-updates", selectors=["#settings-dialog"], pad=0)
        page.click('#release-list [data-update="v0.5.0"]')
        page.wait_for_selector("#update-dialog[open]")
        page.mouse.move(5, 5)
        shots.save("update-wizard", selectors=["#update-dialog"], pad=0)
        page.uncheck("#upd-backup")
        page.click("#upd-download")
        page.wait_for_selector('#update-dialog .upd-step[data-step="ready"]:not(.hidden)')
        page.mouse.move(5, 5)
        shots.save("update-ready", selectors=["#update-dialog"], pad=0)
        page.evaluate("() => el('update-dialog').close()")
        page.click("#btn-settings")
        page.wait_for_selector("#settings-dialog[open]")
        page.evaluate("() => { localStorage.removeItem('netseer.updates.v1'); showUpdateBadges(null); }")
        page.click('.settings-nav [data-pane="help"]')
        shots.save("settings-help", selectors=["#settings-dialog"], pad=0)
        page.click('.settings-nav [data-pane="about"]')
        shots.save("settings-about", selectors=["#settings-dialog"], pad=0)
        page.click('.settings-nav [data-pane="help"]')
        page.click("#help-tour")
        for _ in range(6):
            page.keyboard.press("ArrowRight")
        page.wait_for_timeout(400)
        shots.save("tour", full=True)
        page.keyboard.press("Escape")
        page.evaluate("() => el('help-dialog').showModal()")
        shots.save("shortcuts", selectors=["#help-dialog"], pad=0)
        shots.reset()
        page.evaluate("() => { const m = upsertMap({ id: 'map:blank-docs', name: 'Lab bench', kind: 'blank', graph: emptyGraph('Lab bench') }); showMap(m.id); }")
        shots.save("blank-map", full=True)

        browser.close()
        return shots.taken


def save_report_pages(pdf: bytes) -> None:
    """Pages 1 and 3 of a real report, side by side."""
    try:
        import pymupdf
        from PIL import Image
    except ImportError:
        print("  (skipping report-pages.png: install pymupdf)")
        return
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    pages = []
    for i in (0, min(2, doc.page_count - 1)):
        pix = doc[i].get_pixmap(dpi=72)
        pages.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
    gap = 24
    sheet = Image.new("RGB", (sum(p.width for p in pages) + gap * (len(pages) + 1), pages[0].height + gap * 2), "#2a261c")
    x = gap
    for p in pages:
        sheet.paste(p, (x, gap))
        x += p.width + gap
    sheet.save(OUT / "report-pages.png", optimize=True)
    print(f"  {(OUT / 'report-pages.png').relative_to(ROOT)}")


def save_theme_grid(frames: list[bytes]) -> None:
    from PIL import Image, ImageDraw, ImageFont

    names = ["Terrain", "Midnight", "Daylight", "Blueprint"]
    w, h = VIEWPORT["width"] // 2, VIEWPORT["height"] // 2
    gap = 12
    grid = Image.new("RGB", (w * 2 + gap * 3, h * 2 + gap * 3), "#15140f")
    draw = ImageDraw.Draw(grid)
    font = ImageFont.load_default(size=20)
    for i, raw in enumerate(frames):
        img = Image.open(io.BytesIO(raw)).convert("RGB").resize((w, h), Image.LANCZOS)
        x, y = gap + (i % 2) * (w + gap), gap + (i // 2) * (h + gap)
        grid.paste(img, (x, y))
        draw.rounded_rectangle((x + 12, y + h - 48, x + 142, y + h - 12), radius=8, fill="#15140f", outline="#e0a84a")
        draw.text((x + 26, y + h - 42), names[i], fill="#efe8d8", font=font)
    grid.save(OUT / "themes.png", optimize=True)
    print(f"  {(OUT / 'themes.png').relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--channel", help="Use an installed browser instead of Playwright's Chromium: msedge, chrome")
    args = parser.parse_args()
    url, server = start_server()
    print(f"NetSeer at {url}; writing to {OUT.relative_to(ROOT)}")
    try:
        taken = capture(url, args.channel)
    finally:
        server.terminate()
        server.wait(10)
    print(f"Done: {len(taken) + 2} images")
    return 0


if __name__ == "__main__":
    sys.exit(main())
