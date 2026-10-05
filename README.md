<p align="center">
  <img src="src/netseer/web/logo.svg" alt="NetSeer logo" width="128" />
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
| Kismet | `.kismet` (its native log), `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |
| NetSeer | `Unwanted-*.json` dumps (reload devices you set aside) |

**Kismet logs (`.kismet`)** are read directly; there's no need to convert them first. NetSeer decodes the packets Kismet logged, then adds Kismet's own summary of each device: SSIDs (including networks that hide their name), channels, encryption, maker, signal, location when Kismet had GPS, the networks clients probed for, and which clients joined which access points. Bluetooth and other non-Wi-Fi devices in the log are left out.

Installed copies open captures of any size, such as long wardrives, reading them straight from disk with a progress bar. The [online copy](https://netseer.onrender.com) takes captures up to 20 MB. Bundled campus samples let you try it without any files of your own.

From the frames and survey rows, NetSeer extracts:

- **Addresses:** MAC and IP addresses, with TX / RX / DA / RA roles from the frames (never guessed)
- **Manufacturers:** from the bundled IEEE MA-L / MA-M / MA-S / CID registry; locally administered and unregistered prefixes are labeled as such
- **Networks:** subnets, VLANs (802.1Q), default gateways and DHCP options, OSPF routers, STP bridges
- **Wireless:** SSIDs, BSSIDs, channels, frequencies, security (WPA2/WPA3 Personal and Enterprise, OWE, WEP, open), signal range, GPS
- **Services:** TCP/UDP listening ports and named services, also recognized from the traffic itself (DNS queries, HTTP `Host`, SSH banners, TLS handshakes)
- **Device types:** router, server, access point, host, wireless client, inferred from that evidence

## What you get

- **A map that lays itself out**, eight ways: **by subnet** (the default: subnets are boxes, access points sit with their clients), **by connection**, **by location** (survey GPS), **by channel**, **by network name** (SSID), **top-down hierarchy**, **by signal strength**, or **by maker**. Drag anything to rearrange; positions are saved for each arrangement. **Tidy layout** resets them.
- **Details for every device.** Click one to see what NetSeer found, rename it, add a caption and notes, copy any value, or edit any field. Edits are marked and can be reset.
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
- **Four themes:** Terrain (default), Midnight, Daylight (good for printing), and Blueprint.
- **Settings** (the cog): scroll-zoom speed, back up and restore all your maps, one-click updates (or roll back to an earlier release) in the desktop app, a one-minute guided tour, and an About page.

The [user guide](docs/user-guide.md) walks through all of it with screenshots; the [How to](docs/netseer-how-to.md) lists every control and keyboard shortcut.

## Where your data lives

NetSeer never changes your capture files. Maps, names, notes, and positions are saved in the window's (or browser's) storage for NetSeer's address, `http://127.0.0.1:47331`.

| What | Windows | Linux |
| --- | --- | --- |
| Saved maps (desktop app) | `%LOCALAPPDATA%\NetSeer\webview` | `~/.local/share/NetSeer/browser` (snap browsers: `~/snap/<browser>/common/NetSeer`) |
| Log, for bug reports | `%LOCALAPPDATA%\NetSeer\netseer.log` | `~/.local/share/NetSeer/netseer.log` |
| Unwanted dumps | `Documents\NetSeer\Unwanted` | `~/Documents/NetSeer/Unwanted` |

Running from source and using your normal browser, maps live in that browser's site data for `127.0.0.1:47331`, and Unwanted dumps go to `Unwanted/` in the project (or `NETSEER_UNWANTED_DIR`).

## How much you can store

Every version of NetSeer saves maps the same way: in the **IndexedDB** storage of the window or browser showing it. A saved map holds devices, links, names, notes, and positions, not the packets. The campus sample takes about 76 KB, and even a long wardrive with thousands of access points makes a map of a few MB to a few tens of MB. The storage limits below are far more than that.

| | Windows app | Linux app | Online copy |
| --- | --- | --- | --- |
| Saved by | Edge WebView2 (Chromium) | Chrome, Chromium, Edge, Brave, or Vivaldi in its own profile | Your browser |
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
git tag v0.4.5 && git push origin v0.4.5
```

Keep the tag in step with `version` in `pyproject.toml` and `__version__` in `src/netseer/__init__.py`.

**Windows**, with Python 3.12 ([`windows.yml`](.github/workflows/windows.yml)):

```powershell
python -m pip install . "pywebview>=5.3" "pyinstaller>=6.10"
pyinstaller packaging/windows/netseer.spec --noconfirm --clean
dist\NetSeer\NetSeer.exe --smoke-test
iscc /DAppVersion=0.4.5 packaging\windows\netseer.iss   # installer; needs Inno Setup 6
```

Code signing switches on once the Azure Artifact Signing secrets exist; see [packaging/windows/SIGNING.md](packaging/windows/SIGNING.md).

**Linux**, with Python 3.12 ([`linux.yml`](.github/workflows/linux.yml)):

```bash
python -m pip install . "pyinstaller>=6.10"
pyinstaller packaging/linux/netseer.spec --noconfirm --clean
dist/NetSeer/NetSeer --smoke-test
bash packaging/linux/build-appimage.sh 0.4.5   # AppImage and .tar.gz in dist/
```

## Update and uninstall

- **Windows:** run the newer `NetSeer-Setup` over the old one; it keeps your maps. Uninstall from **Settings → Apps**.
- **AppImage:** replace the file (run `--install` again if you added it to the menu). To remove it, run `--uninstall`, then delete the file.
- **From source:** `uv tool upgrade netseer` (or `git pull` in a clone, then `uv sync`). Remove with `uv tool uninstall netseer`.

**From 0.4.0, the desktop app updates itself.** Open **Settings** → **Updates** → **Check for updates**, then click **Update** (or **Roll back** on an older version):

1. A short wizard shows what's new and can back up your maps first.
2. NetSeer downloads the right file for your install from GitHub and checks its SHA-256 against the checksum GitHub publishes. A file that doesn't match is deleted.
3. **Restart and update:** NetSeer closes, installs the new version, and reopens. The Windows installer runs silently; a portable copy keeps the version you had in a `.previous` folder; an AppImage is replaced in place.

Turn on **Check when NetSeer opens** to be told about new releases (at most once a day). The only requests NetSeer makes for this are to `api.github.com` and to the release download on `github.com`. Updates are only allowed from the desktop app's own window, so another website can't start one.

Your saved maps stay in the folders listed under [Where your data lives](#where-your-data-lives) until you delete them. To copy them to another computer or browser, use **Settings** → **Your data** → **Back up all maps**, then **Restore a backup** on the other one.

---

NetSeer bundles [Cytoscape.js](https://js.cytoscape.org/) (MIT license, see `src/netseer/web/vendor/cytoscape-LICENSE.txt`).
