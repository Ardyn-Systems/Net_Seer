<p align="center">
  <img src="docs/images/netseer-logo.png" alt="NetSeer" width="460" />
</p>

<h1 align="center">NetSeer</h1>

<p align="center"><strong>Turn traffic into terrain.</strong></p>

NetSeer turns packet captures and wireless surveys into an interactive network map. Drop in a Wireshark, tcpdump, Kismet, or airodump-ng capture and it lays out the devices, subnets, VLANs, access points, and services it finds, with the evidence behind each one. Then rename, annotate, rearrange, and export the result to **draw.io**, **Visio**, or a **PDF report**.

**Try it now at [netseer.onrender.com](https://netseer.onrender.com)**, no install needed. Or get the desktop app for Windows or Linux.

NetSeer reads capture files you give it; it doesn't sniff live traffic. The desktop app and source installs run entirely on your machine. They only go online to GitHub, and only for updates: to read the public release list when you check, and to download a release when you choose to install it.

## Contents

- [Get NetSeer](#get-netseer) (or [try it online](#try-it-online))
- [What it reads](#what-it-reads)
- [What you get](#what-you-get)
- [Where your data lives](#where-your-data-lives)
- [How much you can store](#how-much-you-can-store)
- [Command-line options](#command-line-options)
- [Develop](#develop)
- [Build the desktop app](#build-the-desktop-app)
- [Update and uninstall](#update-and-uninstall)

Guides: **[User guide](docs/user-guide.md)** (a walkthrough with screenshots) · [How to](docs/netseer-how-to.md) (every control, briefly) · [Install and use on Debian/Ubuntu](docs/netseer-install-and-use.md) (step-by-step) · [Architecture](docs/architecture.md) (how the pieces fit, with diagrams).

## Get NetSeer

| You're on | Get | How it opens |
| --- | --- | --- |
| Windows 10 or 11 | **`NetSeer-Setup-<version>.exe`** (or the portable `.zip`) | Its own window |
| Linux desktop | **`NetSeer-<version>-<arch>.AppImage`** (or the `.tar.gz`) | Its own window (see below) |
| Linux server, Kali, Raspberry Pi | Install from source with `uv` or `pipx` | A browser, locally or over SSH |
| macOS | From source | A browser |
| Anywhere, nothing to install | **[netseer.onrender.com](https://netseer.onrender.com)** | Your browser |

Download the Windows and Linux builds from [Releases](https://github.com/ardyn-systems/NetSeer/releases).

The desktop app is built on **Electron**: a frameless window with a custom title bar, a system tray, and an **automatic self-updater**. The backend is the same NetSeer that runs online and from source.

### Try it online

**[https://netseer.onrender.com](https://netseer.onrender.com)** runs the latest NetSeer from this repo's `main` branch. It updates automatically whenever `main` changes.

- **First load can be slow.** It's on a free plan, so after 15 minutes without visitors it sleeps, and the next visit takes about 50 seconds to wake it.
- **Files are processed, not kept.** Captures you open are sent to the server only to draw the map. Your maps, names, and notes stay in your browser.
- **Public mode limits:** captures up to 20 MB, and **Save to files and empty** downloads files to your computer instead of saving them on the server.
- **Sensitive captures:** for captures from your own network, use the desktop app or a source install, which keep everything on your machine.

### Host your own copy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ardyn-systems/NetSeer)

Put your own public copy online for free on Render, the same way the one above runs. See [docs/hosting.md](docs/hosting.md) for sign-up, deployment, limits, and privacy.

### Windows

Run **NetSeer-Setup-&lt;version&gt;.exe** — a per-user install (no admin prompt) that opens in its own frameless window, adds a system tray icon, and updates itself. Or unzip the portable **NetSeer-&lt;version&gt;-x64.zip** and run `NetSeer.exe`.

Until the builds are code-signed ([how to set that up](packaging/windows/SIGNING.md)), Windows SmartScreen shows "Windows protected your PC" the first time: choose **More info** → **Run anyway**.

### Linux desktop (AppImage)

The AppImage opens in its own native window and updates itself:

```bash
chmod +x NetSeer-*.AppImage
./NetSeer-*.AppImage
```

It is built on Ubuntu 22.04 and runs on that or newer (Debian 12, Fedora 36+, and similar); everything it needs is bundled.

AppImages need **FUSE** to run. Many current distros don't ship the older `libfuse2` they expect, so if you see a `dlopen(): error loading libfuse.so.2` or "AppImages require FUSE to run" message, either install `libfuse2` (`sudo apt install libfuse2` on Debian/Ubuntu) or run it without FUSE:

```bash
./NetSeer-*.AppImage --appimage-extract-and-run
```

To skip AppImages entirely, the **`.tar.gz`** has the same app with no FUSE dependency: unpack it and run `NetSeer/netseer`.

### Linux server, Kali, or Raspberry Pi (from source)

Python 3.12 or newer. With [uv](https://docs.astral.sh/uv/):

```bash
uv tool install git+https://github.com/ardyn-systems/NetSeer.git
netseer
```

Or with pipx: `pipx install git+https://github.com/ardyn-systems/NetSeer.git`.

Then open <http://127.0.0.1:47331>. To use NetSeer on a remote sensor from your laptop, keep it bound to localhost and tunnel over SSH:

```bash
ssh -L 47331:127.0.0.1:47331 you@sensor   # then browse to http://127.0.0.1:47331 on your laptop
```

`netseer --host 0.0.0.0` exposes it to your LAN instead, but the API has no login and can write files into `Unwanted/`, so only do that on a network you trust.

## What it reads

| Source | Files |
| --- | --- |
| Wireshark / tshark | `.pcap`, `.pcapng` |
| tcpdump | `.pcap` |
| Kismet | `.kismet` (its native log), `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |
| NetSeer | `Unwanted-*.json` dumps (reload devices you set aside) |

**Kismet logs (`.kismet`)** are read directly; there's no need to convert them first. NetSeer decodes the packets Kismet logged, then adds Kismet's own summary of each device: SSIDs (including networks that hide their name), channels, encryption, maker, signal, location when Kismet had GPS, the networks clients probed for, and which clients joined which access points. Bluetooth and other non-Wi-Fi devices in the log are left out.

Installed copies open captures of any size, such as long wardrives, reading them straight from disk with a progress bar. The [online copy](https://netseer.onrender.com) takes captures up to 20 MB. NetSeer starts empty. To try it without any files of your own, open **Settings → Help**: sample captures open with one click, including a branch office surveyed twice a week apart, for trying **Compare surveys**.

From the frames and survey rows, NetSeer extracts:

- **Addresses:** MAC and IP addresses, with TX / RX / DA / RA roles from the frames (never guessed)
- **Manufacturers:** from the bundled IEEE MA-L / MA-M / MA-S / CID registry; locally administered and unregistered prefixes are labeled as such
- **Networks:** subnets, VLANs (802.1Q), default gateways and DHCP options, OSPF routers, STP bridges
- **Wireless:** SSIDs, BSSIDs, channels, frequencies, security (WPA2/WPA3 Personal and Enterprise, OWE, WEP, open), signal range, GPS
- **Services:** TCP/UDP listening ports and named services, also recognized from the traffic itself (DNS queries, HTTP `Host`, SSH banners, TLS handshakes)
- **Device types:** router, server, access point, host, wireless client, inferred from that evidence

## What you get

- **A map that lays itself out**, eight ways: **by network name** (the default: a box per SSID with its access points and their clients), **by subnet**, **by connection**, **by location** (survey GPS), **by channel**, **top-down hierarchy**, **by signal strength**, or **by maker**. Drag anything to rearrange; positions are saved for each arrangement. **Tidy layout** resets them.
- **Details for every device.** Click one to see what NetSeer found, rename it, add a caption and notes, copy any value, or edit any field. Edits are marked and can be reset.
- **Security findings for every device.** NetSeer checks what the capture shows — open or WEP Wi-Fi, WPS, Telnet, FTP, SNMP, old TLS, and more — and matches software versions it sees in banners (OpenSSH, Apache, nginx, …) against known vulnerabilities. Each vulnerability shows its severity and its EPSS score: the estimated chance it is exploited in the wild in the next 30 days, with CISA "known exploited" flagged. If a WPA four-way handshake was captured, that's noted on the devices too, and you can export it (as a pcap or a hashcat file) to test your own network's password offline. The data comes bundled, so it works offline; **Settings → Vulnerability Database → Update database** refreshes it from NVD, FIRST, and CISA, and also looks up any products it saw in your own captures that it didn't already recognize.
- **Compare surveys for changes.** Pick a baseline and one or more later surveys, each with its own time window (a morning baseline against an afternoon survey, say), and NetSeer maps what changed: devices that left a network or disappeared are shaded red, ones that joined or are new green, and other changes blue, such as moving networks, a randomized MAC that rotated, or a possible rogue access point.
- **Several maps at once.** Each capture becomes a map. Copy, cut, paste, and move devices between maps (an access point brings its clients), merge maps, and set devices aside in **Unwanted**. Undo and Redo go 30 steps either way, and only ever change your maps.
- **An organized sidebar.** Drag maps and surveys to reorder them, or drop one onto a map to merge it. Right-click for rename, merge, remove, and delete. Drag the sidebar's edge to make it wider.
- **Access points labelled with their SSID**, so Wi-Fi networks are easy to pick out at a glance.
- **Find a device** by name, IP, MAC, SSID, or notes (press `/`).
- **Layers** to show or hide wired, IP, service, wireless, VLAN, subnet, and bridge links.
- **Add what the capture didn't show, or take away what you don't need.** Connect devices or put them in a subnet or VLAN from outside information (a port label, a diagram), with a note on where it came from; these stay marked as added by you, on the map and in every export. **Disconnect** removes links between two devices without moving or deleting anything.
- **A timeline** under the map: pick a time window with two handles and see only the devices heard then, or make a new map of just that window. Times show in your time zone, or any you choose.
- **Search that finds everything**: every match for a name, SSID, address, or maker, with what matched and **Select all**. Every drag can be undone.
- **Exports:**
  - **draw.io** and **Visio** (`.vsdx`, `.vdx`), laid out like the map on screen, with subnets as containers
  - a **PDF report** where you choose the sections, device types, and fields; it estimates the page count before you make it
  - per-device **PDF, CSV, XML, or text**
- **Five themes:** Terrain (the default, over a topographic map), Midnight, Daylight (good for printing), Blueprint, and Retrowave (soft synthwave).
- **Settings** (the cog): scroll-zoom speed, integrations, back up and restore all your maps, the vulnerability database, updates (the desktop app updates itself; everywhere else links to the latest release), a one-minute guided tour, and an About page.

The [user guide](docs/user-guide.md) walks through all of it with screenshots; the [How to](docs/netseer-how-to.md) lists every control and keyboard shortcut.

## Where your data lives

NetSeer never changes your capture files. Maps, names, notes, and positions are saved in the window's (or browser's) storage for NetSeer's address, `http://127.0.0.1:47331`.

| What | Windows | Linux |
| --- | --- | --- |
| Saved maps (desktop app) | `%APPDATA%\NetSeer` (Electron app data) | `~/.config/NetSeer` (Electron app data) |
| Security database + pairing tokens | `%LOCALAPPDATA%\NetSeer` | `~/.local/share/NetSeer` |
| Unwanted dumps | `Documents\NetSeer\Unwanted` | `~/Documents/NetSeer/Unwanted` |

The desktop app stores maps in its own Electron window (keyed to `127.0.0.1:47331`); start it with `ELECTRON_ENABLE_LOGGING=1` to see the backend's log on the console for bug reports. Running from source and using your normal browser, maps live in that browser's site data for `127.0.0.1:47331`, and Unwanted dumps go to `Unwanted/` in the project (or `NETSEER_UNWANTED_DIR`).

## How much you can store

Every version of NetSeer saves maps the same way: in the **IndexedDB** storage of the window or browser showing it. A saved map holds devices, links, names, notes, and positions, not the packets. The campus sample takes about 76 KB, and even a long wardrive with thousands of access points makes a map of a few MB to a few tens of MB. The storage limits below are far more than that.

| | Windows app | Linux app | Online copy |
| --- | --- | --- | --- |
| Saved by | Electron (bundled Chromium) | Electron (bundled Chromium) | Your browser |
| Room for saved maps | Up to about 60% of the disk | Up to about 60% of the disk | Chrome and Edge: up to about 60% of the disk. Firefox: about 10% of the disk, at most 10 GB, until storage is protected. Safari: large, but see below. |
| Largest capture | No limit | No limit | 20 MB per file |
| Packets read per capture | All of them | All of them | All of them |

These are the browsers' own rules and vary a little by version. A copy you run yourself can set a capture limit with `NETSEER_MAX_UPLOAD_MB` (and `NETSEER_MAX_PACKETS`), but by default there is none.

**Big captures and wardrives.** Installed copies stream a capture from disk instead of loading it into memory, and skip decoding frames that repeat what NetSeer already knows (the same beacon, the same encrypted conversation). That keeps the map exactly the same: frame counts and signal ranges still include every frame. A 220 MB wardrive with 2 million frames opens in about 20 seconds using around 50 MB of memory. While a big file reads, NetSeer shows how far it's got, with packet and device counts. **Stop and show map** draws what's been read so far; **Cancel** discards it.

**Keeping maps from being cleared.** Browsers can delete a site's storage on their own when the disk is nearly full. To stop that, NetSeer asks the browser to mark its storage as *persistent*:
- the desktop app asks when it starts
- the browser versions ask after you open your first capture (Firefox shows a prompt; Chrome and Edge decide quietly, usually yes once you've bookmarked or often used the site)
- you can ask again from **Settings** → **Your data** → **Protect my maps**, which also shows whether storage is protected

**Back up anyway.** **Settings** → **Your data** → **Back up all maps** saves everything to one JSON file that no browser will clear, and **Restore a backup** loads it on any computer or browser.

### How the online copy stores your work

The online copy at [netseer.onrender.com](https://netseer.onrender.com) works like the desktop app, with the server and the browser on different machines:

1. When you open a capture, your browser sends the file over HTTPS to the server.
2. The server reads it in memory, sends back the map (devices and links), and discards the file. Nothing is written to the server's disk, and there are no accounts.
3. Your browser saves the map in its own IndexedDB for `netseer.onrender.com`. Names, notes, edits, positions, and preferences are saved there too and never leave your browser.

So your maps are tied to **that browser on that device**. Other visitors can't see them, and you won't see them from another computer, another browser, or a private window. Clearing the site's data in your browser deletes them. **Safari** may also delete a website's saved data after about 7 days without a visit, so back up often if you use it there. Packet captures can contain sensitive information: for real captures from your own network, run NetSeer on your own computer. See [docs/hosting.md](docs/hosting.md) for how the online copy is set up.

## Command-line options

**`netseer`** runs the server for use in a browser:

| Option | Meaning |
| --- | --- |
| `--host HOST` | Address to listen on (default `127.0.0.1`, this machine only) |
| `--port PORT` | Port (default `$PORT` if set, else `47331`) |

**`NetSeer.exe` or the AppImage** runs the desktop app (Electron). It starts the `netseer` backend on `127.0.0.1` for you, opens its own window, and takes one flag:

| Option | Meaning |
| --- | --- |
| `--smoke-test` | Start the backend, load the UI, and exit (`0` means OK) |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `NETSEER_UNWANTED_DIR` | Where Unwanted dumps are written |
| `NETSEER_HOSTED=1` | Public mode for an internet-facing server: visitors can't write files to the server; Unwanted downloads to the browser instead |
| `NETSEER_MAX_UPLOAD_MB` | Largest capture accepted (default 50) |
| `PORT` | Default port, as set by hosting platforms |
| `ELECTRON_ENABLE_LOGGING=1` | Desktop app: print the backend's log to the console |

## Develop

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
cd NetSeer
uv sync --group dev        # Python 3.12+
uv run netseer             # http://127.0.0.1:47331
uv run pytest
```

Without uv: `python3 -m venv .venv && . .venv/bin/activate && pip install -e . pytest httpx`. For the desktop window from source, run the backend (`uv run netseer`) and, in `electron/`, `npm install && NETSEER_PYTHON=python3 npm start` to open the Electron shell against it.

| Path | What's there |
| --- | --- |
| `src/netseer/parsers/` | pcap/pcapng (scapy), Kismet, and airodump readers |
| `src/netseer/graph.py` | Turns observations into devices, links, subnets, and VLANs |
| `src/netseer/exporters/` | draw.io, Visio, PDF reports, device exports |
| `src/netseer/web.py`, `web/` | The API and the browser app (no build step) |
| `electron/` | The Electron desktop shell (window, tray, menu, self-updater) |
| `src/netseer/data/` | Bundled samples and the IEEE OUI table |
| `packaging/electron/` | PyInstaller spec that freezes the backend as the Electron sidecar |
| `packaging/` | Logo sources and Windows/Linux icons |

Recreate the bundled samples with `uv run python -m netseer.generate_samples`. Rebuild the manufacturer table from the IEEE registries:

```bash
curl -L -o /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
curl -L -o /tmp/mam.csv https://standards-oui.ieee.org/oui28/mam.csv
curl -L -o /tmp/oui36.csv https://standards-oui.ieee.org/oui36/oui36.csv
curl -L -o /tmp/cid.csv https://standards-oui.ieee.org/cid/cid.csv
uv run python -m netseer.compile_oui /tmp/oui.csv /tmp/mam.csv /tmp/oui36.csv /tmp/cid.csv
```

The user guide's screenshots come from `docs/screenshots.py`, which drives NetSeer with Playwright: `uv sync --group docs`, `uv run playwright install chromium`, then `uv run python docs/screenshots.py`.

The logo lives in `packaging/brand/` as SVG. After editing it, regenerate every icon with `python packaging/brand/render.py` (needs `pymupdf` and `pillow`).

## Build the desktop app

GitHub Actions ([`electron.yml`](.github/workflows/electron.yml)) builds both platforms. It freezes the Python backend into a sidecar with **PyInstaller**, then packages the **Electron** shell around it with **electron-builder**. On every pull request it smoke-tests the build and uploads the files as workflow artifacts. Pushing a version tag also attaches them to a GitHub release:

```bash
git tag v0.7.3 && git push origin v0.7.3
```

Keep the tag in step with `version` in `pyproject.toml`, `__version__` in `src/netseer/__init__.py`, and `version` in `electron/package.json`.

To build locally, with Python 3.12 and Node 20:

```bash
python -m pip install . "pyinstaller>=6.10"
pyinstaller packaging/electron/netseer-server.spec --noconfirm --clean   # freezes dist/netseer-server
cd electron && npm install
npx electron-builder            # installer + portable zip (Windows), AppImage + tar.gz (Linux)
```

Windows code signing switches on once the signing secrets exist; see [packaging/windows/SIGNING.md](packaging/windows/SIGNING.md). More detail on the shell is in [electron/README.md](electron/README.md) and [docs/electron-migration.md](docs/electron-migration.md).

## Update and uninstall

**The desktop app updates itself** through electron-updater. Open **Settings** → **Updates**: leave **Update NetSeer automatically** on and it downloads new releases in the background and asks to restart; turn it off and use **Check for updates** when you want one. Updates come only from this repo's GitHub releases (`api.github.com` and `github.com`), checked against the release's signed `latest.yml` / `latest-linux.yml`.

- **Windows:** the self-updater installs over the old version and keeps your maps. Or run a newer `NetSeer-Setup` yourself. Uninstall from **Settings → Apps**.
- **AppImage:** the self-updater replaces the file in place. To remove it, just delete the file.
- **From source:** `uv tool upgrade netseer` (or `git pull` in a clone, then `uv sync`). Remove with `uv tool uninstall netseer`.

Your saved maps stay in the folders listed under [Where your data lives](#where-your-data-lives) until you delete them. To copy them to another computer or browser, use **Settings** → **Your data** → **Back up all maps**, then **Restore a backup** on the other one.

---

NetSeer bundles [Cytoscape.js](https://js.cytoscape.org/) (MIT license, see `src/netseer/web/vendor/cytoscape-LICENSE.txt`).
