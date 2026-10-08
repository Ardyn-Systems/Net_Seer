# NetSeer — Electron shell

The NetSeer desktop app. It launches the Python backend as a **managed sidecar**, waits for
`/api/health`, and opens a frameless window pointed at it, with a system tray, native menu,
`netseer://` deep links, and an electron-updater self-updater. The Python app and the web UI are the
same ones that run online and from source. See
[../docs/electron-migration.md](../docs/electron-migration.md) for the design history.

## What it does

- Picks a free loopback port and starts the backend (`python -m netseer` in dev; a frozen
  `netseer-server` under `resources/` when packaged — see `packaging/electron/netseer-server.spec`).
- Health-checks the backend, then shows it in a frameless 1440×900 window (min 900×600, dark
  background, `NETSEER_MODE=desktop`) with a web-UI title bar.
- Adds a system tray, a native application menu, and `netseer://` deep links (the companion-app
  handoff).
- Updates itself with `electron-updater` (GitHub provider): a background check on launch, a
  **Check for updates** control, and a restart-to-install prompt, gated on the user's
  auto-update toggle.
- Opens external links in the user's browser.
- Kills the sidecar when the app quits, and quits if the backend dies.
- Security: `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, a minimal preload.

Packaged and signed by `.github/workflows/electron.yml` (electron-builder): a Windows installer +
portable zip, and a Linux AppImage + tar.gz. See [SIGNING.md](../packaging/windows/SIGNING.md).

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
