# NetSeer — Electron shell (Phase 1)

An Electron desktop shell for NetSeer. It launches the existing Python backend as a **managed
sidecar**, waits for `/api/health`, and opens a window pointed at it. The Python app and the web UI
are unchanged — this only replaces the pywebview window. See
[../docs/electron-migration.md](../docs/electron-migration.md) for the full plan.

## What Phase 1 does

- Picks a free loopback port and starts the backend (`python -m netseer` in dev; a frozen
  `netseer-server` under `resources/` when packaged — the packaging slice comes next).
- Health-checks the backend, then shows it in a 1440×900 window (min 900×600, dark background,
  `NETSEER_MODE=desktop`).
- Opens external links in the user's browser.
- Kills the sidecar when the app quits, and quits if the backend dies.
- Security: `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, a minimal preload.

Not yet (later Phase-1 / later phases): the frozen server sidecar + `electron-builder` packaging and
signing, the frameless title bar and native menus/tray, deep links, and auto-update.

## Run it (from source)

You need the NetSeer Python package importable (`pip install -e ..` from a source checkout) and
Node.js installed.

```bash
cd electron
npm install
npm start          # launches the window against `python -m netseer`
```

Set `NETSEER_PYTHON` if your interpreter isn't `python`/`python3`, or `NETSEER_SIDECAR` to point at a
prebuilt server binary.

## Smoke test (headless)

```bash
npm run smoke      # starts the backend, loads the page, prints "SMOKE OK", exits 0
```

CI runs this under `xvfb` on Linux (see `.github/workflows/electron.yml`).
