# NetSeer — install and use on Linux

**Turn traffic into terrain.**

Walkthrough for cloning NetSeer from GitHub, installing it on Debian/Ubuntu, and using the browser map. One local Python web app; not a compiled binary yet.

## What it is

NetSeer is a **local** survey-to-map tool:

- Python package `netseer` (CLI `netseer`)
- FastAPI + uvicorn serves a small UI in your browser
- You drop Wireshark / tcpdump / Kismet / airodump-ng files; it draws L2/L3/RF as a map
- Export the same picture to draw.io, Visio, and PDF/CSV/XML/text

It is **not** an installer `.deb`, AppImage, or standalone binary. You run it from source on the machine that holds the captures (or copy captures in). The map UI loads Cytoscape from a CDN (`cdn.jsdelivr.net`), so the browser needs outbound HTTPS the first time you open the map.

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

You should see `README.md`, `pyproject.toml`, `src/`, `web/`, and `docs/`. Stay on **`main`**.

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
pip install -e ".[dev]"
python -m netseer.generate_samples
```

If `python3` is 3.11, install 3.12 and call it explicitly (`python3.12 -m venv .venv`). Pip needs to fetch the `uv_build` build backend from PyPI (declared in `pyproject.toml`).

`generate_samples` rewrites the bundled `.pcap` / `.pcapng` / Kismet / airodump files under `src/netseer/data/`. Skip it if those files are already there.

## 3. Start the preview

Default bind is **all interfaces**, port **47331**.

```bash
# uv
uv run netseer --host 127.0.0.1 --port 47331

# venv
source .venv/bin/activate
netseer --host 127.0.0.1 --port 47331
```

Open [http://127.0.0.1:47331](http://127.0.0.1:47331).

- `--host 127.0.0.1` if you only want local loopback
- `--host 0.0.0.0` if other machines on the LAN should hit it
- Change `--port` if 47331 is taken

The CLI name is `netseer`. Leave the process running while you use the UI.

## How to use

A function-by-function guide (maps, Unwanted dumps, AP copy, field Copy, exports) is [[netseer-how-to]] / [docs/netseer-how-to.md](netseer-how-to.md).

Campus survey (combined) loads on first visit into its own **map**. Empty, loading, and parse-error overlays cover the other states. Maps, device edits, and the clipboard persist in this browser (`localStorage`).

### Maps (blank, Unwanted, cut / copy / paste)

Left **Maps** list holds every map in this session:

- **Unwanted** — holding / quarantine map. It cannot be deleted. **Empty** writes devices to `Unwanted/` in the project (`Unwanted-office-lan.json`, …) then clears the map. Drop that JSON onto **Load a survey** to reload it.
- Survey maps — created when you load a sample or upload. **Rename** / **Delete** on the row.
- **New blank map** — empty canvas. Rename or delete it like any user map.

**Merge this map into** combines the active map into another (nodes, edges, notes). Unwanted cannot be a merge source or target.

Switch maps by clicking a row. Each map keeps its own devices when you switch.

**Select** a device (click; Shift-click adds; Shift-drag boxes). Then:

| Action | How |
| --- | --- |
| Cut | Cut button, right-click, device window, or Ctrl+X / Cmd+X |
| Copy | Copy button, right-click, device window, or Ctrl+C / Cmd+C |
| Paste | Switch to the destination map, then Paste or Ctrl+V / Cmd+V |
| Move | Cut, switch maps, paste — or **Move to Unwanted** / **Move to** in the device window |
| Delete | Delete / Backspace, Delete button, right-click, or **Delete from map** in the device window |
| Undo | Undo or Ctrl+Z / Cmd+Z (last cut, paste, move, delete, merge, or empty) |

Edges travel with a selection only when **both** endpoints are in that selection. Device details, edits, and notes stay with the device.

Copying an **Access point** takes associated **wireless clients**, the wireless edges, and **other APs on WDS / STP / attachment (bridge) links** to that AP (and those APs’ clients). Copying a **Wireless client** copies only that station. Cut and **Move to Unwanted** / **Move to** do the same when the selection is an AP.

### Load and remove surveys

Left panel, **Load a survey**:

1. Click a bundled sample, **or** drop / pick `.pcap`, `.pcapng`, `.cap`, `.netxml`, `.csv`.
2. Uploads join the same list (tagged as uploaded captures).
3. **Remove** hides a bundled sample or drops an upload from the list. It does not delete files on disk.
4. **Restore bundled samples** comes back if you hid them all.

On a narrow screen, **Samples** in the header opens the left panel.

### Map labels

Nodes show a **short type**, not a dump of MAC/IP/OUI:

Access point, Wireless client, Router, Switch, Server, Gateway, Host. VLAN and subnet objects keep their network names (`VLAN 10`, `10.10.10.0/24`, …).

Click a device → **Map name** and **On-map extra** (second line). **Use auto name** restores the inferred type. Edits stick in the browser (`localStorage`) for this origin.

### Zoom

Bottom-right **Zoom** slider (20–400%) stays in sync with wheel zoom. **Fit** frames the graph.

### Show layers

Left **Show** checkboxes:

| Layer | What it toggles |
| --- | --- |
| Wired L2 | Ethernet adjacency |
| L3 / IP | IP conversations |
| Ports & services | Client → server edges (http, dns, ssh, …) |
| Wireless | STA ↔ AP |
| VLANs | VLAN membership |
| Subnets | Subnet membership |
| Bridge / attachment | STP / WDS / spanning-host links between **distinct** networks |

**Show all** checks every box. **Show none** clears every box (nodes stay; those edges hide).

Pink diamond-dashed **bridge / attachment** lines appear only when the capture has evidence: a device MAC on more than one VLAN (or two same-version subnets), an 802.1D STP BPDU, or 802.11 four-address WDS. NetSeer does not invent bridges.

### Device window

Click a node. The dialog lists extracted fields.

- **Capture** vs **Edited** on each row. Type to override; **Reset** goes back to what the parser found.
- Editable: type/kind/medium, TX / RX / DA / RA MACs, other MACs, IPs, VLANs, SSIDs, channel, frequency, encryption, OUI manufacturer, ports/services, GPS, routing, extra JSON, and the rest of the property list. `id` stays read-only.
- **Your notes** at the bottom.
- Per-row **Copy** copies **only the text-box value** (not the field name or Capture/Edited badge). **Copy all** is still a structured dump. Download **PDF / CSV / XML / Plain text**. Notes and edits go with those exports when present.
- **Cut**, **Copy**, **Move to Unwanted**, **Delete from map**, and **Move to** another map sit under the export buttons.

The right **Details** inspector shows the live overlay (including `User-edited: …`). Click a **bridge** edge to see kind `bridge`, mechanism (STP / WDS / attachment), and via device.

**TX / RX / DA / RA** are only filled from frames. Wired: TX = Ethernet src, DA and RX = dst, RA omitted. 802.11 follows ToDS/FromDS. Missing roles say `not present` — they are not guessed.

**OUI manufacturer** comes from the bundled IEEE MA-L / MA-M / MA-S / CID table.

### Exports (toolbar)

Need a map loaded (buttons disable on empty).

| Button | File |
| --- | --- |
| Export draw.io | `netseer-map.drawio` |
| Export Visio .vsdx | `netseer-map.vsdx` |
| Export Visio XML | `netseer-map.vdx` |
| Report PDF | whole-map PDF (devices + links) |

Device-window downloads are per node. Map-name, extra, notes, and field edits are included in the graph posted to the server.

Edits live in **this browser’s** `localStorage` (`netseer.deviceMeta.v1`, `netseer.hiddenSamples`). They are not written back into the pcap.

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

Open http://127.0.0.1:47331. Try **New blank map**, **Move to Unwanted**, Cut / Copy / Paste, then export draw.io.

Maps and field edits live in **this browser’s** `localStorage` (`netseer.deviceMeta.v1`, `netseer.maps.v2`, `netseer.hiddenSamples`). They are not written back into the pcap.

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
pip install -e ".[dev]"
netseer --host 127.0.0.1 --port 47331
```

Hard-refresh the browser (Ctrl+Shift+R) so it does not keep an old `app.js`. Map edits in `localStorage` stay; they are not in git.

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

**Optional — browser leftovers:** in the browser that opened http://127.0.0.1:47331, clear site data for that origin, or DevTools → Application → Local Storage and remove `netseer.deviceMeta.v1`, `netseer.maps.v2`, and `netseer.hiddenSamples`.

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
| Default bind | `0.0.0.0:47331` |
| Samples | `src/netseer/data/` |
| Update | `git pull origin main` then `uv sync --group dev` and restart `netseer` |
| Uninstall | Stop `netseer`, then `rm -rf` the clone directory |
