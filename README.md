<p align="center">
  <img src="src/netseer/web/logo-192.png" alt="NetSeer logo" width="168" />
</p>

# NetSeer

**Turn traffic into terrain.**

NetSeer turns Layer 2 / Layer 3 network surveys into an interactive map, then export **draw.io** and **Visio**.

This is a web preview (not a compiled binary). It runs on Debian-family Linux and ships with synthetic campus captures so you can try it without uploading files.

## What it reads

| Source | Extensions |
| --- | --- |
| Wireshark / tshark | `.pcap`, `.pcapng` |
| tcpdump | `.pcap` |
| Kismet | `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |

## What the map shows

When the frames or survey rows include them:

- MAC and IP addresses
- **OUI manufacturer** from the IEEE MA-L / MA-M / MA-S / CID registries (locally administered and unregistered prefixes are labeled as such)
- VLANs, subnet membership, default gateway / DHCP options, OSPF
- Wireless SSIDs, BSSID, channel, frequency, encryption, signal, GPS
- **TCP/UDP ports and named services** on nodes and on client→server edges (HTTP, HTTPS/TLS, SSH, DNS, DHCP, NTP, SNMP, OSPF, and other well-known ports). Names also come from protocol metadata in the frames (DNS queries, HTTP `Host`, SSH ident, TLS handshake).

Click a device to see everything NetSeer found in the **Details** panel: rename it, add notes, copy values, edit any field, or download it (PDF, CSV, XML, plain text). Subnets are drawn as boxes around their devices, access points sit with their clients, and you can drag things around. **Find a device** searches names, IPs, MACs, and SSIDs.

Wired L2, L3, wireless, VLAN, and service edges can be toggled independently. Four themes: **Terrain** (default), **Midnight**, **Daylight**, and **Blueprint**.

## Exports (same attributes as the preview)

- **draw.io** — `.drawio` mxfile XML, with subnets as containers
- **Visio** — `.vsdx` (Open XML) and `.vdx` (Visio 2003 XML)
- **Device details** — PDF, CSV, XML, and `.txt` from the Details panel
- **Map report** — PDF of every device and link

Diagrams use the layout you see on screen, including dragged positions. Node labels include identity plus listen ports/services. Edge labels include `service proto/port` (for example `http tcp/80`).

A longer Debian/Ubuntu walkthrough (clone, install, update, uninstall) is in [docs/netseer-install-and-use.md](docs/netseer-install-and-use.md). A function-by-function How to is in [docs/netseer-how-to.md](docs/netseer-how-to.md).

## Clone

The repo is public. No GitHub login is required.

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip curl
git clone https://github.com/ardyn-systems/NetSeer.git
cd NetSeer
```

## Run on Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m netseer.generate_samples   # recreates bundled survey files
netseer --port 47331
```

With [uv](https://docs.astral.sh/uv/):

```bash
uv sync --group dev
uv run python -m netseer.generate_samples
uv run netseer --port 47331
```

Open [http://127.0.0.1:47331](http://127.0.0.1:47331). The campus combined sample loads automatically. Map nodes show a short inferred type (Access point, Router, Server, …); rename them and add a caption or notes in the **Details** panel. **Open survey** (or drop files anywhere) to map your own captures, toggle link types under **Layers**, inspect TX/RX/DA/RA, then **Export**.

The CLI and the Python package are both `netseer`. Bundled files live in `src/netseer/data/`. The OUI table is compiled from IEEE CSVs:

```bash
curl -L -o /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
curl -L -o /tmp/mam.csv https://standards-oui.ieee.org/oui28/mam.csv
curl -L -o /tmp/oui36.csv https://standards-oui.ieee.org/oui36/oui36.csv
curl -L -o /tmp/cid.csv https://standards-oui.ieee.org/cid/cid.csv
uv run python -m netseer.compile_oui /tmp/oui.csv /tmp/mam.csv /tmp/oui36.csv /tmp/cid.csv
```

## Windows app

Download from [Releases](https://github.com/ardyn-systems/NetSeer/releases):

- **NetSeer-Setup-&lt;version&gt;.exe** installs NetSeer for your user (no admin prompt), adds a Start menu shortcut, and registers an uninstaller under **Settings → Apps**.
- **NetSeer-&lt;version&gt;-windows-x64-portable.zip** runs without installing: unzip anywhere and open `NetSeer.exe`.

NetSeer opens in its own window using Microsoft Edge WebView2, which ships with Windows 10 and 11. If WebView2 is missing, it opens in your default browser instead. Everything stays on your PC: the server listens on `127.0.0.1` only.

| What | Where |
| --- | --- |
| Saved maps and settings | `%LOCALAPPDATA%\NetSeer\webview` |
| Log (for bug reports) | `%LOCALAPPDATA%\NetSeer\netseer.log` |
| Unwanted dumps | `Documents\NetSeer\Unwanted` |

`NetSeer.exe --browser` opens in the browser on purpose, and `NetSeer.exe --smoke-test` checks the installation (exit code 0 means OK).

### Build it yourself

GitHub Actions builds both files on every `v*` tag (`.github/workflows/windows.yml`) and attaches them to the release. It code-signs them once the signing secrets are set up ([packaging/windows/SIGNING.md](packaging/windows/SIGNING.md)); until then Windows SmartScreen warns on first run (**More info** → **Run anyway**). Locally, on Windows with Python 3.12:

```powershell
python -m pip install . "pywebview>=5.3" "pyinstaller>=6.10"
pyinstaller packaging/windows/netseer.spec --noconfirm --clean
dist\NetSeer\NetSeer.exe --smoke-test
iscc /DAppVersion=0.1.0 packaging\windows\netseer.iss   # needs Inno Setup 6
```

To run the desktop window from source instead: `pip install ".[desktop]"`, then `netseer-desktop`.

## Tests

```bash
uv run pytest
```

## Update

```bash
cd NetSeer
git pull origin main
uv sync --group dev          # or: pip install -e ".[dev]"
uv run netseer --host 127.0.0.1 --port 47331
```

Stop the old process first (`Ctrl+C`). Hard-refresh the browser.

## Uninstall

Stop `netseer`, then delete the clone (`rm -rf /path/to/NetSeer`). That removes source and the virtualenv. Do not apt-remove `python3` / `git` unless you want them gone system-wide. Optional: clear this origin's site data in the browser to remove saved maps (IndexedDB `netseer`) and preferences (`netseer.*` in Local Storage).
