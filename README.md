<p align="center">
  <img src="src/netseer/web/logo.svg" alt="NetSeer logo" width="128" />
</p>

<h1 align="center">NetSeer</h1>

<p align="center"><strong>Turn traffic into terrain.</strong></p>

NetSeer turns packet captures and wireless surveys into an interactive network map. Drop in a Wireshark, tcpdump, Kismet, or airodump-ng capture and it lays out the devices, subnets, VLANs, access points, and services it finds, with the evidence behind each one. Then rename, annotate, rearrange, and export the result to **draw.io**, **Visio**, or a **PDF report**.

**Try it now at [netseer.onrender.com](https://netseer.onrender.com)**, no install needed. Or get the desktop app for Windows or Linux.

NetSeer reads capture files you give it; it doesn't sniff live traffic. The desktop app and source installs run entirely on your machine. The only network request they make is to GitHub's public release list, and only when you check for updates in **Settings**.

## Contents

- [Get NetSeer](#get-netseer) (or [try it online](#try-it-online))
- [What it reads](#what-it-reads)
- [What you get](#what-you-get)
- [Where your data lives](#where-your-data-lives)
- [Command-line options](#command-line-options)
- [Develop](#develop)
- [Build the desktop apps](#build-the-desktop-apps)
- [Update and uninstall](#update-and-uninstall)

Guides: **[User guide](docs/user-guide.md)** (a walkthrough with screenshots) · [How to](docs/netseer-how-to.md) (every control, briefly) · [Install and use on Debian/Ubuntu](docs/netseer-install-and-use.md) (step-by-step).

## Get NetSeer

| You're on | Get | How it opens |
| --- | --- | --- |
| Windows 10 or 11 | `NetSeer-Setup-<version>.exe`, or the portable `.zip` | Its own window (Edge WebView2) |
| Linux desktop | `NetSeer-<version>-x86_64.AppImage`, or the `.tar.gz` | Its own window (see below) |
| Linux server, Kali, Raspberry Pi | Install from source with `uv` or `pipx` | A browser, locally or over SSH |
| macOS | From source | A browser |
| Anywhere, nothing to install | **[netseer.onrender.com](https://netseer.onrender.com)** | Your browser |

Download the Windows and Linux builds from [Releases](https://github.com/ardyn-systems/NetSeer/releases).

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

Run **NetSeer-Setup-&lt;version&gt;.exe**. It installs for your user only (no admin prompt), adds a Start menu shortcut, and shows up under **Settings → Apps** for uninstalling. Or unzip the **portable** build anywhere and run `NetSeer.exe`.

NetSeer opens in its own window using Microsoft Edge WebView2, which comes with Windows 10 and 11. If WebView2 is missing, it opens in your default browser instead.

Until the builds are code-signed ([how to set that up](packaging/windows/SIGNING.md)), Windows SmartScreen shows "Windows protected your PC" the first time: choose **More info** → **Run anyway**.

### Linux desktop (AppImage)

```bash
chmod +x NetSeer-*-x86_64.AppImage
./NetSeer-*-x86_64.AppImage             # run it
./NetSeer-*-x86_64.AppImage --install   # optional: add NetSeer to your app menu
```

NetSeer picks the best window it can find:

1. An installed **Chrome, Chromium, Edge, Brave, or Vivaldi** in app mode: its own window with no browser toolbar, and its own profile so your maps stay put.
2. Otherwise your **default browser**. Maps are then saved in that browser, and NetSeer quits by itself a couple of minutes after you close the tab.

The AppImage is built on Ubuntu 22.04 and runs on that or newer (Debian 12, Fedora 36+, and similar). If you'd rather not use AppImages, the `.tar.gz` has the same program: unpack it and run `NetSeer/NetSeer`.

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
| Kismet | `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |
| NetSeer | `Unwanted-*.json` dumps (reload devices you set aside) |

Captures up to 50 MB each, and up to 80,000 packets per capture. Bundled campus samples let you try it without any files of your own.

From the frames and survey rows, NetSeer extracts:

- **Addresses:** MAC and IP addresses, with TX / RX / DA / RA roles from the frames (never guessed)
- **Manufacturers:** from the bundled IEEE MA-L / MA-M / MA-S / CID registry; locally administered and unregistered prefixes are labeled as such
- **Networks:** subnets, VLANs (802.1Q), default gateways and DHCP options, OSPF routers, STP bridges
- **Wireless:** SSIDs, BSSIDs, channels, frequencies, security (WPA2/WPA3 Personal and Enterprise, OWE, WEP, open), signal range, GPS
- **Services:** TCP/UDP listening ports and named services, also recognized from the traffic itself (DNS queries, HTTP `Host`, SSH banners, TLS handshakes)
- **Device types:** router, server, access point, host, wireless client, inferred from that evidence

## What you get

- **A map that lays itself out.** Subnets are boxes around their devices, access points sit with their clients, and the layout fits your window. Drag anything to rearrange; positions are saved. **Tidy layout** resets them.
- **Details for every device.** Click one to see what NetSeer found, rename it, add a caption and notes, copy any value, or edit any field. Edits are marked and can be reset.
- **Several maps at once.** Each capture becomes a map. Copy, cut, paste, and move devices between maps (an access point brings its clients), merge maps, and set devices aside in **Unwanted**. Undo goes back 30 steps.
- **Find a device** by name, IP, MAC, SSID, or notes (press `/`).
- **Layers** to show or hide wired, IP, service, wireless, VLAN, subnet, and bridge links.
- **Exports:**
  - **draw.io** and **Visio** (`.vsdx`, `.vdx`), laid out like the map on screen, with subnets as containers
  - a **PDF report** where you choose the sections, device types, and fields; it estimates the page count before you make it
  - per-device **PDF, CSV, XML, or text**
- **Four themes:** Terrain (default), Midnight, Daylight (good for printing), and Blueprint.
- **Settings** (the cog): scroll-zoom speed, back up and restore all your maps, check for updates or roll back to an earlier release, a one-minute guided tour, and an About page.

The [user guide](docs/user-guide.md) walks through all of it with screenshots; the [How to](docs/netseer-how-to.md) lists every control and keyboard shortcut.

## Where your data lives

NetSeer never changes your capture files. Maps, names, notes, and positions are saved in the window's (or browser's) storage for NetSeer's address, `http://127.0.0.1:47331`.

| What | Windows | Linux |
| --- | --- | --- |
| Saved maps (desktop app) | `%LOCALAPPDATA%\NetSeer\webview` | `~/.local/share/NetSeer/browser` (snap browsers: `~/snap/<browser>/common/NetSeer`) |
| Log, for bug reports | `%LOCALAPPDATA%\NetSeer\netseer.log` | `~/.local/share/NetSeer/netseer.log` |
| Unwanted dumps | `Documents\NetSeer\Unwanted` | `~/Documents/NetSeer/Unwanted` |

Running from source and using your normal browser, maps live in that browser's site data for `127.0.0.1:47331`, and Unwanted dumps go to `Unwanted/` in the project (or `NETSEER_UNWANTED_DIR`).

## Command-line options

**`netseer`** runs the server for use in a browser:

| Option | Meaning |
| --- | --- |
| `--host HOST` | Address to listen on (default `127.0.0.1`, this machine only) |
| `--port PORT` | Port (default `$PORT` if set, else `47331`) |

**`NetSeer.exe`, the AppImage, or `netseer-desktop`** runs the desktop app:

| Option | Meaning |
| --- | --- |
| `--browser` | Open in the default browser instead of a window |
| `--port PORT` | Use a different port (saved maps are per port) |
| `--install`, `--uninstall` | Linux: add or remove NetSeer in your app menu |
| `--smoke-test` | Check the installation and exit (`0` means OK) |
| `--debug` | Verbose logging |
| `--version` | Print the version |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `NETSEER_UNWANTED_DIR` | Where Unwanted dumps are written |
| `NETSEER_HOSTED=1` | Public mode for an internet-facing server: visitors can't write files to the server; Unwanted downloads to the browser instead |
| `NETSEER_MAX_UPLOAD_MB` | Largest capture accepted (default 50) |
| `PORT` | Default port, as set by hosting platforms |

## Develop

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
cd NetSeer
uv sync --group dev        # Python 3.12+
uv run netseer             # http://127.0.0.1:47331
uv run pytest
```

Without uv: `python3 -m venv .venv && . .venv/bin/activate && pip install -e . pytest httpx`. For the desktop window from source, install the `desktop` extra (`pip install -e ".[desktop]"`, which needs WebKitGTK on Linux) and run `netseer-desktop`.

| Path | What's there |
| --- | --- |
| `src/netseer/parsers/` | pcap/pcapng (scapy), Kismet, and airodump readers |
| `src/netseer/graph.py` | Turns observations into devices, links, subnets, and VLANs |
| `src/netseer/exporters/` | draw.io, Visio, PDF reports, device exports |
| `src/netseer/web.py`, `web/` | The API and the browser app (no build step) |
| `src/netseer/desktop.py` | The desktop launcher for Windows and Linux |
| `src/netseer/data/` | Bundled samples and the IEEE OUI table |
| `packaging/` | Logo sources, Windows installer, Linux AppImage |

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

## Build the desktop apps

GitHub Actions builds both platforms. On every pull request it checks the build and uploads the files as workflow artifacts. Pushing a version tag also attaches them to a GitHub release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Keep the tag in step with `version` in `pyproject.toml` and `__version__` in `src/netseer/__init__.py`.

**Windows**, with Python 3.12 ([`windows.yml`](.github/workflows/windows.yml)):

```powershell
python -m pip install . "pywebview>=5.3" "pyinstaller>=6.10"
pyinstaller packaging/windows/netseer.spec --noconfirm --clean
dist\NetSeer\NetSeer.exe --smoke-test
iscc /DAppVersion=0.2.0 packaging\windows\netseer.iss   # installer; needs Inno Setup 6
```

Code signing switches on once the Azure Artifact Signing secrets exist; see [packaging/windows/SIGNING.md](packaging/windows/SIGNING.md).

**Linux**, with Python 3.12 ([`linux.yml`](.github/workflows/linux.yml)):

```bash
python -m pip install . "pyinstaller>=6.10"
pyinstaller packaging/linux/netseer.spec --noconfirm --clean
dist/NetSeer/NetSeer --smoke-test
bash packaging/linux/build-appimage.sh 0.2.0   # AppImage and .tar.gz in dist/
```

## Update and uninstall

- **Windows:** run the newer `NetSeer-Setup` over the old one; it keeps your maps. Uninstall from **Settings → Apps**.
- **AppImage:** replace the file (run `--install` again if you added it to the menu). To remove it, run `--uninstall`, then delete the file.
- **From source:** `uv tool upgrade netseer` (or `git pull` in a clone, then `uv sync`). Remove with `uv tool uninstall netseer`.

In the app, **Settings** → **Updates** lists every release with the right download for your install, so you can update, or roll back if a new version gives you trouble.

Your saved maps stay in the folders listed under [Where your data lives](#where-your-data-lives) until you delete them. To copy them to another computer or browser, use **Settings** → **Your data** → **Back up all maps**, then **Restore a backup** on the other one.

---

NetSeer bundles [Cytoscape.js](https://js.cytoscape.org/) (MIT license, see `src/netseer/web/vendor/cytoscape-LICENSE.txt`).
