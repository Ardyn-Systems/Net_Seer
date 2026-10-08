# NetSeer — How to

**Turn traffic into terrain.**

What each part of the screen does, and how to use it. For a walkthrough with screenshots, see the [user guide](user-guide.md). For clone, install, update, and uninstall on Debian/Ubuntu, see [[netseer-install-and-use]].

NetSeer runs as a desktop app (Windows installer, Linux AppImage), from source with `netseer` (then open `http://127.0.0.1:47331`), or online at [netseer.onrender.com](https://netseer.onrender.com). The controls are the same everywhere.

Maps, names, notes, field edits, dragged positions, and the clipboard are saved in **this browser** (IndexedDB for this origin). They are not written back into the original capture. Maps saved by older versions in `localStorage` move over automatically the first time you open the new version.

---

## The screen at a glance

| Area | What's there |
| --- | --- |
| Top bar | Logo, the **current map's name** (click to rename), **Open survey**, **Export**, the **theme** button, and **Settings** (cog) |
| Left sidebar | Three tabs: **Maps**, **Surveys**, **Layers** |
| Map | The network drawing, with **Find a device**, **Undo**, and **Redo** at the top, zoom controls at the bottom right, and a toolbar at the bottom whenever something is selected |
| Right panel | **Details** for whatever you selected |

Below about 1180 px wide the details panel slides in from the right when you select something (close it with **×** or Esc). Below about 760 px the sidebar hides behind the **menu** button.

---

## Themes

Click the **palette** button in the top bar and pick one:

| Theme | Feel |
| --- | --- |
| **Terrain** (default) | Warm, earthy, over a topographic map: contour lines with heavier index lines and elevations |
| **Midnight** | Low-glare navy with a dot grid |
| **Daylight** | Light and crisp; best for screenshots, projectors, and printing |
| **Blueprint** | Engineering drawing on a blue grid |
| **Retrowave** | Soft synthwave: muted plum with a faint neon grid, easy on the eyes |

Your choice is remembered in this browser. Themes change the app and the on-screen map only; draw.io, Visio, and PDF exports keep their own fixed colors. **Settings** → **General** has the same choices.

---

## Settings

The **cog** in the top bar. A dot on it means a newer release is out.

| Section | What's there |
| --- | --- |
| **General** | Theme; **Scroll to zoom** speed (Gentle, Normal, Quick); **Show SSIDs under access points**; **Fade unrelated devices on hover** (off by default); **Time**: time zone (this computer, UTC, or any) and 12- or 24-hour clock |
| **Your data** | Count of saved maps and devices; whether storage is protected from automatic cleanup, with **Protect my maps** if not; **Back up all maps** (one JSON file with maps, names, notes, edits, positions, and preferences); **Restore a backup…** (replaces what's saved here; asks first); **Clear all data…** (asks first) |
| **Demo** | The sample captures, each with **Open** (or **Show** once opened); **Compare the branch office samples** opens a pair a week apart and sets up **Compare surveys** |
| **Security** | The vulnerability data for the Security findings (bundled, or downloaded), with its date; **Update database** (installed copies, highlighted when you're online) downloads the latest from NVD, FIRST EPSS, and CISA, and looks up products seen in your captures that aren't recognized yet, sending only product names |
| **Integrations** | Pair companion apps (like WaveTop) so they can push captures straight into NetSeer with no file to save. **Pair a device** shows a one-time code to enter in the app; paired devices are listed with when they were added and last used, each with **Revoke**. **Allow devices on my network** lets paired apps on your Wi-Fi/LAN reach NetSeer (off by default; takes effect after a restart, and your OS firewall may ask to allow it); over the network NetSeer answers only the token-gated integration API, never the full UI. Installed/source copies only |
| **Updates** | Version and install type; **Check for updates**; **Check when NetSeer opens** (off by default, at most once a day); the current release and any newer ones, each with **Release notes** and **Reinstall** or **Update**; older ones are folded under **Earlier versions**: pick one from the list for its **Release notes** and **Roll back**. In the desktop app these open the update wizard: release notes and an optional backup, then a download checked against GitHub's SHA-256, then **Restart and update** (NetSeer closes, installs, and reopens). From source, the button copies a `uv tool install --force` command for that version. The online copy updates itself and shows no list. |
| **Help** | **Take the tour**, **Keyboard shortcuts**, the user guide, **Report a problem** (a new GitHub issue with your version filled in) |
| **About** | Version, how NetSeer is running, links, and component licenses |

Checking for updates is the only time NetSeer goes online: it reads the public release list from `api.github.com`. Nothing about you or your maps is sent.

**The tour** is offered once on the first visit, and from **Help** → **Take the tour** any time after. Eleven steps; **Next**/**Back** or the arrow keys, and **Skip tour** or Esc to stop.

---

## Open surveys

- **Open survey** (top bar), or drop files **anywhere on the page**. Accepted: `.pcap`, `.pcapng`, `.cap`, Kismet `.kismet` logs, `.netxml`, `.csv`, or a NetSeer **Unwanted JSON** dump. A `.kismet` log gives the most detail: its packets plus Kismet's device list (SSIDs, hidden networks, encryption, makers, probed networks, client associations, GPS).
- Each capture becomes its own map and joins the **Surveys** tab.
- **Surveys** tab: click a row to open it. Right-click (or **⋯**) for **Open**, **Merge into…**, **Compare with a baseline…**, **Remove from list** (its map stays under **Maps**), and **Delete survey and its map…**. **Bring back** in the message restores a removed survey; **Undo** brings back a deleted map. Drag rows to reorder them. Demo samples appear here once opened.
- NetSeer starts empty: no maps or surveys until you open one. The welcome card has **Open survey** and **Try a demo** (opens **Settings** → **Demo**).
- Problems (unsupported file, empty capture, decode warnings) show up as a message at the top of the window.
- **Size:** installed copies open captures of any size, streaming them from disk. A big file shows progress (percent read, packets, devices); **Stop and show map** draws what's been read, **Cancel** discards it. The online copy takes up to 20 MB per file.

---

## Maps

The **Maps** tab lists every map. Click a row to switch. Right-click a row, or use its **⋯** menu:

| Map | Menu |
| --- | --- |
| Survey and blank maps | **Rename…**, **Merge into…**, **Compare with a baseline…**, **Delete map…** |
| Comparison maps | **Rename…**, **Merge into…**, **Delete map…** |
| Unwanted | **Rename…**, **Save to files and empty…** |

- **New blank map** asks for a name and starts an empty canvas.
- **Compare surveys…** maps what changed between a baseline and later surveys (see [Compare surveys](#compare-surveys)).
- **Merge into…** copies this map's devices, links, names, and notes into the map you pick. Clashing IDs get a suffix (`~2`). This map stays as it is.
- **Delete map…** asks first, and you can undo it right after.
- Unwanted always sits at the bottom of the list and can't be deleted or merged.

**Dragging in the sidebar**

| Drag | Result |
| --- | --- |
| A map up or down | Reorders the list (saved) |
| A map onto another map | Merges it into that map (Undo) |
| A survey up or down | Reorders the list (saved) |
| A survey over the **Maps** tab, then onto a map | Merges the survey into that map (Undo) |
| The sidebar's right edge | Resizes the sidebar (saved; double-click resets, or focus it and use the arrow keys) |

Esc cancels a drag. The list scrolls by itself when you drag near its top or bottom.

---

## Compare surveys

**Maps** → **Compare surveys…** (or **Compare with a baseline…** on a map or survey, or **Compare…** on the timeline).

| Field | What it does |
| --- | --- |
| **Baseline** | The earlier survey or map. Unopened surveys are listed too |
| **Compare with** | A later survey. **Add another survey** for up to five; each gets its own map |
| **From** / **To** | Each capture's own time window, over a chart of its activity: compare a morning baseline with an afternoon survey. **Whole capture** resets. Two windows of one capture work |

The result is a **Comparison** map of every device from both, with a see-through shade and a line under the name:

| Shade | Line | Means |
| --- | --- | --- |
| Red | − Left … | Still here, but no longer on a Wi-Fi network, access point, subnet, or VLAN it was on |
| Red, dashed | − No longer seen | In the baseline only |
| Green | + Joined … / + New device | Now on a network it wasn't on / in the later survey only |
| Blue | Δ … | Moved networks, roamed, randomized MAC rotated, possible rogue access point (a new BSSID using a known SSID), access point name, security, or channel changed, address, type, or services changed |
| none (faded) | | No change |

- Gone links are red and dashed; new links are green. **Details** lists every change. A selected device's shade deepens.
- A vanished random MAC and a new one are paired as one device when they probe the same networks, use the same access point, or share an address.
- **Layers** → **Changes** shows the counts and **Show unchanged devices** (off leaves only changes).
- Names, captions, and notes carry over. Undo removes the comparison maps.
- Try it: **Settings** → **Demo** → **Compare the branch office samples**.

## Unwanted (holding area)

Use **Set aside** (selection toolbar, details panel, or right-click) to move devices off a working map. Names, notes, and edits go with them.

**Save to files and empty…** on the Unwanted row:

1. Asks first.
2. Writes one readable JSON file per original capture into the project's **`Unwanted/`** folder (or `NETSEER_UNWANTED_DIR`), for example `Unwanted-office-lan.json` from `office-lan.pcap`. Existing names get `-2`, `-3`, …
3. Clears the Unwanted map.

The files hold the graph (nodes, links, notes), not a rebuilt pcap. Drop one back onto NetSeer to reload it as a map.

---

## Select and edit

**Select:** click a device. Shift-click (or Ctrl/Cmd-click) adds to the selection. Shift-drag draws a selection box. Click empty space or press Esc to clear.

When something is selected, a toolbar appears at the bottom of the map: **Copy**, **Cut**, **Move to**, **Set aside**, **Delete**. The same actions are on right-click and in the details panel.

| Action | How |
| --- | --- |
| Copy | Toolbar, right-click, or Ctrl+C / Cmd+C |
| Cut | Toolbar, right-click, or Ctrl+X / Cmd+X |
| Paste | Open the destination map, then the **Paste** button at the top of the map, right-click on empty space, or Ctrl+V / Cmd+V |
| Move | **Move to** → pick a map, or **New map…** to create one on the spot |
| Delete | Toolbar, right-click, or Delete / Backspace |
| Undo | The **undo** arrow at the top of the map, **Undo** in the message, or Ctrl+Z / Cmd+Z. Up to 30 steps: each drag, cut, paste, move, delete, merge, delete map, empty Unwanted, tidy layout, and links you add or remove |
| Redo | The **redo** arrow beside it, **Redo** in the message after an undo, or Ctrl+Y / Ctrl+Shift+Z. A new change clears what's left to redo |

Undo and Redo only change maps (devices, links, names, notes, positions), never the clipboard, the Surveys list, the order of the Maps list, or settings.

Links travel with a selection only when **both** ends are selected.

### Access points bring their clients

Copying, cutting, moving, or setting aside an **access point** also takes its associated **wireless clients**, plus **other APs bridged to it** (WDS, STP, attachment) and their clients. A **wireless client** on its own moves alone.

---

## Security

Every device's **Details** has a **Security** section (also `POST /api/security/assess`). NetSeer reports only what the capture shows; it never scans.

- **Findings** (certain, no percentage), each with severity and a fix: open/WEP Wi-Fi, WPS, Telnet, FTP, TFTP, SNMP v1/v2c, VNC, unencrypted mail/LDAP/MQTT, databases on the network, SMB, RDP, plain HTTP logins, TLS 1.0/1.1, SSL 3.0.
- **Known vulnerabilities** from software versions in banners (SSH greeting, HTTP `Server`/`X-Powered-By`). Each CVE shows CVSS severity, **EPSS** (chance of exploitation in the next 30 days), and a **Known exploited** flag from CISA KEV. No version means no match — NetSeer never guesses from the maker. A distribution banner (Ubuntu, Debian, …) is noted, since those backport fixes without changing the version.
- **Wi-Fi handshakes**: a captured WPA four-way handshake is listed on both the station and the access point, with which of messages 1–4 were seen. If enough was captured (message 2 plus 1 or 3) on a PSK network, it's flagged as crackable offline. WPA3-SAE and 802.1X handshakes are listed but not flagged. **Export** repackages the captured frames as a **pcap** or a **hashcat** `.hc22000` (`POST /api/security/handshake`), for testing your own network; no password is recovered by NetSeer.
- **Layers → Security → Shade by security** tints each device by its most serious finding, with counts.
- The data is bundled (works offline). **Settings → Security → Update database** refreshes it (highlighted when you're online, and more so when the data is old or when a capture shows a product NetSeer doesn't recognize yet). An update resolves such products against NVD and remembers them, so they match on future maps.

## Timeline

Shown under the map when a capture records times (pcap, pcapng, Kismet logs).

| Part | What it does |
| --- | --- |
| Start and end | When the capture began and ended, in the time zone from **Settings** → **General** → **Time** |
| Chart | How many devices were active in each slice of the capture |
| Two handles | Pick a window: only devices and links heard during it stay on the map; nothing moves |
| **New map from this window** | A separate map of just that time: devices and links heard in it (plus ones you added), activity trimmed to the window, names and notes carried over, fresh layout. Undoable; the original is unchanged |
| **Compare…** | Compare this window with a baseline survey or another window (see [Compare surveys](#compare-surveys)) |
| **Show all** / **×** | Whole capture again / hide the timeline (the clock button by the zoom controls reopens it) |

- Sightings within a minute of each other are one stretch of activity. Details show **First seen**, **Last seen**, and **Active**.
- Exports and the PDF report include only what's in the window; the report states the window.
- Devices without times (NetXML, CSV, ones you add) always show. Maps and surveys with no times at all say **no timeline** in the sidebar and in **Compare surveys**, where they're compared whole.

---

## Find a device

Press `/` or click **Find a device**. Search by name, caption, SSID, IP, MAC, maker, type, probed SSIDs, or notes. Every match is listed (names first, then captions and SSIDs, addresses, makers), and each row says which field matched. Arrow keys move through results; Enter selects and centers the device. **Select all on the map** selects every match.

---

## Details panel

Select one device to see:

- **Name on map** and **Caption under the name** (shown as a second line on the map). **Use auto name** goes back to the inferred type.
- **Identity**: IPs, MACs (TX / RX / DA / RA when the frames show them), maker (IEEE OUI), VLANs.
- **Radio**: SSID, channel, frequency, signal range, security, GPS (when present).
- **Security**: findings, known vulnerabilities (with EPSS), and captured Wi-Fi handshakes; see [Security](#security).
- **Services** and **Routing** (OSPF, default gateway, DHCP, DNS).
- **Notes** for anything you want to keep.
- Actions: **Copy details**, **Export** (PDF, CSV, XML, plain text), **Move to**, **Set aside**, **Delete**.
- **All extracted fields** (collapsed): every parsed field, editable. Edited rows are marked; hover a row for **Copy** (just that value) and **Reset** (back to the capture). `id` stays read-only.

Click any value in Identity, Radio, or Routing to copy it.

Select a **link** to see its type, both ends, frame count, VLANs, ports and services, and for bridges the mechanism (STP / WDS / attachment) and the device it runs through. Select several devices to see a count by type and bulk actions.

**TX / RX / DA / RA** come from frames only and are never guessed. Wired: TX = Ethernet source, DA and RX = destination, RA omitted. 802.11 follows ToDS/FromDS.

---

## Add what the capture didn't show

Links and memberships you add from outside information (a port label, a diagram, IT) are marked **added by you** everywhere.

| To | Do |
| --- | --- |
| Connect two devices | Right-click one → **Connect to…** → click the other (Esc cancels), or select two → **Connect**. Choose **Wired**, **Wi-Fi** (one end must be an access point), or **Other**; add a map label and a note |
| Put a device in a subnet or VLAN | Right-click → **Add to subnet or VLAN…**: pick one on the map, or type a new subnet (`10.20.0.0/24`) or VLAN (1–4094) |
| Edit or remove one | Click the link: change its label or note, or **Remove this link**. Right-click it for the same |
| Disconnect two devices | Right-click one → **Disconnect from…** → click the other, or select two connected devices → **Disconnect**. Untick any link to keep. Works on links from the capture too; devices stay where they are, and Undo brings the links back |
| Remove any single link | Click it → **Remove this link**, or right-click it. Devices stay put |
| Hide them | **Layers** → **Added by you** |

On the map they keep their type's colour with a dash-dot line and a ✎ before the label. A Wi-Fi link you add puts the client with its access point; a subnet you add a device to takes it into that subnet's box. Exports keep the mark (draw.io and Visio: dash-dot and ✎; PDF: "added by you" with the note). Adding and removing can be undone.

---

## Layout

NetSeer lays the map out the same way every time. **Layers** → **Arrange devices** picks one of eight arrangements:

| Arrangement | What it does |
| --- | --- |
| **By network name** (default) | A box per SSID: its access points and their clients, titled with the counts. Wired devices go in **Not on Wi-Fi** |
| **By subnet** | Subnet boxes, access points with their clients, groups packed to fit the window (details below) |
| **By connection** | Linked devices together: each connected group is a cluster, biggest first, with its busiest device in the middle and the rest in rings around it. Unconnected devices follow in a grid, then subnet and VLAN labels. Subnet and VLAN membership lines aren't drawn (they're in Details) |
| **By location (GPS)** | Devices at their GPS position from Kismet or wardrive surveys, snapped so none overlap, with a scale label. Devices without a location are boxed separately |
| **By channel** | A box per Wi-Fi channel, by band. Clients join their access point's channel; wired devices last |
| **Top-down hierarchy** | Gateways at the top, then each level of what connects to them below |
| **By signal strength** | Dashed rings by signal (stronger than −50 dBm in the middle, out to weaker than −80 dBm); no reading boxed separately |
| **By maker** | A box per manufacturer, largest first |

Arrangements other than **By subnet** draw labelled boxes of their own. They can be dragged (their devices move with them) but not selected, and they're left out of exports. Subnet and VLAN membership lines are drawn only by subnet.

Each arrangement keeps its own dragged positions.

In the subnet arrangement:

- **Subnets are boxes** around their devices.
- **Access points** sit with their wireless clients: a row under the AP for a few clients, a ring for more, a grid for crowds.
- Routers and gateways come first in each group, then servers, access points, hosts, and wireless clients.
- Groups are packed to fit the shape of your window.

**Drag** any device (or a whole box) to rearrange. Positions are saved per map. **Tidy layout** (grid button by the zoom controls, or right-click on empty space) discards dragged positions; you can undo it.

Zoom with the wheel, the **−** / **+** buttons, or **Fit to screen** (`F`). Selected devices get a bright outline, a glow, and a bold label, and their links are drawn on top. **Fade unrelated devices on hover** (Settings → General, off by default) fades everything not connected to the device under the pointer.

Access points show their SSID as a second line (`HQ-Secure`, `HQ-Secure +2` for several, or `Hidden SSID` when the survey says the name is hidden). A caption you type replaces it; **Settings** → **General** → **Show SSIDs under access points** turns it off. Diagram exports use the same labels.

---

## Layers

**Layers** tab:

| Layer | What it shows |
| --- | --- |
| Wired (L2) | Ethernet adjacency |
| IP traffic (L3) | IP conversations |
| Ports and services | Client → server arrows (http, dns, ssh, …) |
| Wireless | Station ↔ access point |
| VLAN membership | Device ↔ VLAN |
| Bridges and attachments | STP / WDS / spanning-host links between distinct networks |
| Added by you | Connections and memberships you added from outside information (dash-dot, ✎) |

**Show all** and **Hide all** flip every link layer. Devices always stay visible. Subnets have no layer of their own: arranged by subnet they're the boxes, and every device's **Details** lists its subnets. The **Devices** legend below explains the shapes and colors.

Bridges appear only with evidence: a device on more than one VLAN (or two same-version subnets), an 802.1D STP BPDU, or 802.11 four-address WDS. NetSeer doesn't invent them.

---

## Exports

**Export** in the top bar (needs at least one device):

| Item | File |
| --- | --- |
| draw.io diagram | `<map name>.drawio` |
| Visio drawing | `<map name>.vsdx` |
| Visio XML | `<map name>.vdx` |
| Report… | `<map name>-report.pdf`, with the options below |

Diagram exports use **the positions you see on screen**, including your dragged positions, and draw **subnet boxes as containers** (in draw.io, moving the box moves its devices). Names, captions, notes, and field edits are included.

Per-device files (PDF, CSV, XML, text) come from **Export** in the details panel.

### PDF report options

**Report…** opens a dialog so the PDF only holds what you need. The footer shows roughly how many pages it will be before you create it.

- **Presets:** **Overview** (summary and inventory, usually a page or two), **Standard** (adds device details and the links table), **Everything** (every field, including empty ones and raw parser extras).
- **Sections:** Summary (device, link, subnet, VLAN, and service counts, plus parser warnings), Device inventory (one row per device), Device details (a block per device), Links table.
- **Devices:** all devices, or only the ones selected on the map. Tick or untick device types (routers, servers, access points, hosts, wireless clients, subnets and VLANs).
- **Details for each device:** Identity, Radio, Services and ports, Routing, Connections (one line per neighbour), Your notes, and Other extracted data. Empty fields are left out unless you turn on **Show empty fields**.
- **Match the map's Layers:** only include link types that are switched on in **Layers**.

NetSeer remembers your choices for next time (the selection itself isn't remembered).

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Find a device |
| Ctrl/Cmd + C, X, V | Copy, cut, paste |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Y, Ctrl/Cmd + Shift + Z | Redo |
| Delete / Backspace | Delete selected devices |
| `F` | Fit to screen |
| `?` | Show shortcuts |
| Esc | Close menus, clear the selection, cancel a drag |
| Right-click | Menus for devices, maps, and surveys |

---

## Update and uninstall

**Settings** → **Updates** lists newer releases with the right download for your install; older ones to roll back to are under **Earlier versions**. Back up first under **Your data**.

Stay on [[netseer-install-and-use]]: `git pull origin main`, `uv sync --group dev`, restart `netseer`. To uninstall, stop the process and delete the clone / venv.

Public clone (no PAT):

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
```
