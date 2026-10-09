# NetSeer — install and use on Linux

**Turn traffic into terrain.**

Walkthrough for cloning NetSeer from GitHub, installing it from source on Debian/Ubuntu, and using the browser map.

**Just want to try it?** Open [netseer.onrender.com](https://netseer.onrender.com) in a browser; nothing to install.

**Just want the desktop app?** Download the AppImage from [Releases](https://github.com/ardyn-systems/NetSeer/releases), `chmod +x` it, and run it; see the [README](../README.md#linux-desktop-appimage). This guide is for running from source: servers, Kali, Raspberry Pi, or development.

## What it is

NetSeer is a **local** survey-to-map tool:

- Python package `netseer` (CLI `netseer`)
- FastAPI + uvicorn serves a small UI in your browser
- You drop Wireshark / tcpdump / Kismet / airodump-ng / WiGLE files; it draws L2/L3/RF as a map
- Export the same picture to draw.io, Visio, and PDF/CSV/XML/text

Here you run it from source on the machine that holds the captures (or copy captures in). Everything the UI needs is bundled, so it works offline.

Bundled campus samples ship in `src/netseer/data/` so you can click around without uploading anything.

**Source:** [https://github.com/ardyn-systems/NetSeer](https://github.com/ardyn-systems/NetSeer) (public). Branch: `main`.

## Requirements

- **OS:** Debian-family Linux (Debian, Ubuntu, Mint, …). Other distros work if you have Python 3.12+ and git.
- **Python:** **3.12 or newer** (`requires-python = ">=3.12"`). Ubuntu 24.04 is fine. Debian 12’s default `python3` is 3.11 — use 3.12 (or let `uv` fetch it).
```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip curl
```

- **No database, no login, no extra daemons.** Scapy reads pcap files from disk; this preview does not live-sniff.

Python deps (installed into the venv, not apt): FastAPI, uvicorn, python-multipart, scapy, reportlab.

## 1. Clone the repo

The repo is **public**. No GitHub login, PAT, or `gh` is required to clone.

On the Linux box that will run NetSeer:

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
cd NetSeer
git checkout main
git pull
```

You should see `README.md`, `pyproject.toml`, `src/`, and `docs/`. Stay on **`main`**.

Optional: `gh repo clone ardyn-systems/NetSeer` if you already use GitHub CLI, or `git clone git@github.com:ardyn-systems/NetSeer.git` if this machine has an SSH key on GitHub.

To refresh later:

```bash
cd NetSeer
git pull origin main
```

## 2. Install Python deps

Pick **uv** or **venv + pip**. Run these from the cloned `netseer` directory.

### Path A — uv (preferred)

[uv](https://docs.astral.sh/uv/) can install Python 3.12 for you.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# open a new shell, or: source $HOME/.local/bin/env

cd NetSeer
uv python install 3.12
uv sync --group dev
uv run python -m netseer.generate_samples
```

`uv sync` creates `.venv` and installs the package (CLI `netseer`) plus pytest.

### Path B — python3 venv and pip

```bash
cd NetSeer
python3 -m venv .venv
source .venv/bin/activate
python -c "import sys; assert sys.version_info >= (3, 12), sys.version"
pip install -U pip
pip install -e . pytest httpx
python -m netseer.generate_samples
```

If `python3` is 3.11, install 3.12 and call it explicitly (`python3.12 -m venv .venv`). Pip needs to fetch the `uv_build` build backend from PyPI (declared in `pyproject.toml`).

`generate_samples` rewrites the bundled `.pcap` / `.pcapng` / Kismet / airodump files under `src/netseer/data/`. Skip it if those files are already there.

## 3. Start the preview

Default bind is **127.0.0.1** (this machine only), port **47331**.

```bash
# uv
uv run netseer --host 127.0.0.1 --port 47331

# venv
source .venv/bin/activate
netseer --host 127.0.0.1 --port 47331
```

Open [http://127.0.0.1:47331](http://127.0.0.1:47331).

- `--host 127.0.0.1` (default) keeps it on this machine
- `--host 0.0.0.0` if other machines on the LAN should hit it. The API has no login and can write to `Unwanted/`, so only do this on a network you trust
- Change `--port` if 47331 is taken

The CLI name is `netseer`. Leave the process running while you use the UI.

## How to use

The full guide, area by area, is [[netseer-how-to]] / [docs/netseer-how-to.md](netseer-how-to.md). The short version:

- The campus survey opens on first visit. **Open survey** (or drop files anywhere) to map your own captures; each becomes a map.
- The left sidebar is your **Maps**: a drop box for captures at the top, then every open map (switch, rename, merge, delete, plus the **Unwanted** holding area). The **Layers** button in the toolbar opens a panel for how devices are arranged, link toggles, security shading, and the legend.
- Click a device to see everything NetSeer found in the **Details** panel: rename it, add a caption and notes, copy values, export it, or edit any extracted field.
- Select devices to get **Copy**, **Cut**, **Move to**, **Set aside**, and **Delete**. Copying an access point brings its clients and bridged APs. Ctrl+Z undoes up to 30 steps.
- **Find a device** (`/`) searches names, IPs, MACs, SSIDs, and notes.
- Subnets are drawn as boxes; drag devices to rearrange and **Tidy layout** to reset.
- **Export** gives draw.io, Visio (.vsdx / .vdx), and a full PDF report, laid out the way you see the map.
- **Settings → General → Theme** switches themes: **Terrain** (default, over a topographic map), **Midnight**, **Daylight**, **Blueprint**, **Retrowave** (soft synthwave).

Maps, edits, notes, and positions are saved in this browser (IndexedDB for this origin), not in the capture files.

## Optional: tests and OUI table

```bash
uv run pytest
# or: pytest   (inside the venv)
```

Rebuild manufacturers from IEEE CSVs:

```bash
curl -L -o /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
curl -L -o /tmp/mam.csv https://standards-oui.ieee.org/oui28/mam.csv
curl -L -o /tmp/oui36.csv https://standards-oui.ieee.org/oui36/oui36.csv
curl -L -o /tmp/cid.csv https://standards-oui.ieee.org/cid/cid.csv
uv run python -m netseer.compile_oui /tmp/oui.csv /tmp/mam.csv /tmp/oui36.csv /tmp/cid.csv
```

## Next steps on your own Linux computer

The project is public: [https://github.com/ardyn-systems/NetSeer](https://github.com/ardyn-systems/NetSeer). No PAT required.

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
cd NetSeer
uv sync --group dev
uv run netseer --host 127.0.0.1 --port 47331
```

Open http://127.0.0.1:47331. Try **New blank map**, **Set aside**, Cut / Copy / Paste, then **Export** → draw.io diagram.

Maps and field edits are saved in **this browser** (IndexedDB for this origin). They are not written back into the pcap.

## 4. Update on your Linux computer

When we push changes to GitHub `main`, refresh the clone and reinstall deps, then restart the preview. **Stop** a running `netseer` first (`Ctrl+C` in that terminal).

```bash
cd NetSeer
git checkout main
git pull origin main
```

Then one of:

```bash
# uv
uv sync --group dev
uv run netseer --host 127.0.0.1 --port 47331

# venv
source .venv/bin/activate
pip install -e . pytest httpx
netseer --host 127.0.0.1 --port 47331
```

Hard-refresh the browser (Ctrl+Shift+R) so it does not keep an old `app.js`. Saved maps stay in the browser; they are not in git. Maps from versions that used `localStorage` move over automatically on first load.

If `git pull` reports local changes you do not care about: `git restore .` then `git pull origin main`. Do not `git restore` if you edited files you want to keep.

## 5. Uninstall

NetSeer is the clone directory plus a virtualenv. It does not install a systemd service or an apt package named `netseer`.

1. Stop it: `Ctrl+C` in the terminal running `netseer`, or `pkill -f 'netseer|uvicorn'` if it was started in the background.
2. Leave the directory: `cd ~`
3. Delete the project (venv, Python deps, samples, and source):

```bash
rm -rf /path/to/NetSeer
```

That is a full uninstall of the app.

**Optional — uv** (only if you installed uv for NetSeer and do not use it for anything else):

```bash
uv cache clean
rm -rf ~/.local/bin/uv ~/.local/bin/uvx ~/.local/share/uv
```

**Optional — browser leftovers:** in the browser that opened http://127.0.0.1:47331, clear site data for that origin (DevTools → Application → Storage → **Clear site data**). That removes the `netseer` IndexedDB database and the `netseer.*` preferences in Local Storage.

**Do not** `apt remove python3 git curl` unless you want those tools gone from the whole machine. They are general Debian packages, not NetSeer-only.

## Quick reference

| Item | Value |
| --- | --- |
| Product | NetSeer |
| Motto | Turn traffic into terrain. |
| Repo | https://github.com/ardyn-systems/NetSeer (public) |
| Branch | `main` |
| Clone | `git clone https://github.com/ardyn-systems/NetSeer.git` |
| CLI | `netseer` |
| Python import | `netseer` |
| Default URL | http://127.0.0.1:47331 |
| Default bind | `127.0.0.1:47331` |
| Samples | `src/netseer/data/` |
| Update | `git pull origin main` then `uv sync --group dev` and restart `netseer` |
| Uninstall | Stop `netseer`, then `rm -rf` the clone directory |
