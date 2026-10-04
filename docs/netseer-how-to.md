# NetSeer — How to

**Turn traffic into terrain.**

What each part of the screen does, and how to use it. For clone, install, update, and uninstall on Debian/Ubuntu, see [[netseer-install-and-use]].

NetSeer is a **local** browser preview (`http://127.0.0.1:47331` by default). It is not a compiled binary. Open it with `netseer`.

Maps, names, notes, field edits, dragged positions, and the clipboard are saved in **this browser** (IndexedDB for this origin). They are not written back into the original capture. Maps saved by older versions in `localStorage` move over automatically the first time you open the new version.

---

## The screen at a glance

| Area | What's there |
| --- | --- |
| Top bar | Logo, the **current map's name** (click to rename), **Open survey**, **Export**, the **theme** button, and **keyboard shortcuts** (`?`) |
| Left sidebar | Three tabs: **Maps**, **Surveys**, **Layers** |
| Map | The network drawing, with **Find a device** and **Undo** at the top, zoom controls at the bottom right, and a toolbar at the bottom whenever something is selected |
| Right panel | **Details** for whatever you selected |

Below about 1180 px wide the details panel slides in from the right when you select something (close it with **×** or Esc). Below about 760 px the sidebar hides behind the **menu** button.

---

## Themes

Click the **palette** button in the top bar and pick one:

| Theme | Feel |
| --- | --- |
| **Terrain** (default) | Warm, earthy, with faint contour lines behind the map |
| **Midnight** | Low-glare navy with a dot grid |
| **Daylight** | Light and crisp; best for screenshots, projectors, and printing |
| **Blueprint** | Engineering drawing on a blue grid |

Your choice is remembered in this browser. Themes change the app and the on-screen map only; draw.io, Visio, and PDF exports keep their own fixed colors.

---

## Open surveys

- **Open survey** (top bar), or drop files **anywhere on the page**. Accepted: `.pcap`, `.pcapng`, `.cap`, `.netxml`, `.csv`, or a NetSeer **Unwanted JSON** dump.
- Each capture becomes its own map and joins the **Surveys** tab.
- **Surveys** tab: click a row to open it. The **×** on a row removes it from the list; its map stays under **Maps**. **Restore bundled samples** brings hidden samples back.
- First visit: the bundled campus survey opens automatically. An empty map shows a welcome card with **Open survey** and **Try the campus sample**.
- Problems (unsupported file, empty capture, decode warnings) show up as a message at the top of the window.

---

## Maps

The **Maps** tab lists every map. Click a row to switch. Each row's **⋯** menu has:

| Map | Menu |
| --- | --- |
| Survey and blank maps | **Rename…**, **Merge into…**, **Delete map…** |
| Unwanted | **Rename…**, **Save to files and empty…** |

- **New blank map** asks for a name and starts an empty canvas.
- **Merge into…** copies this map's devices, links, names, and notes into the map you pick. Clashing IDs get a suffix (`~2`). This map stays as it is.
- **Delete map…** asks first, and you can undo it right after.
- Unwanted always sits at the bottom of the list and can't be deleted or merged.

---

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
| Undo | The **undo** arrow at the top of the map, **Undo** in the message, or Ctrl+Z / Cmd+Z. Up to 30 steps: cut, paste, move, delete, merge, delete map, empty Unwanted, tidy layout |

Links travel with a selection only when **both** ends are selected.

### Access points bring their clients

Copying, cutting, moving, or setting aside an **access point** also takes its associated **wireless clients**, plus **other APs bridged to it** (WDS, STP, attachment) and their clients. A **wireless client** on its own moves alone.

---

## Find a device

Press `/` or click **Find a device**. Search by name, caption, type, IP, MAC, SSID, maker, or notes. Arrow keys move through results; Enter selects and centers the device.

---

## Details panel

Select one device to see:

- **Name on map** and **Caption under the name** (shown as a second line on the map). **Use auto name** goes back to the inferred type.
- **Identity**: IPs, MACs (TX / RX / DA / RA when the frames show them), maker (IEEE OUI), VLANs.
- **Radio**: SSID, channel, frequency, signal range, security, GPS (when present).
- **Services** and **Routing** (OSPF, default gateway, DHCP, DNS).
- **Notes** for anything you want to keep.
- Actions: **Copy details**, **Export** (PDF, CSV, XML, plain text), **Move to**, **Set aside**, **Delete**.
- **All extracted fields** (collapsed): every parsed field, editable. Edited rows are marked; hover a row for **Copy** (just that value) and **Reset** (back to the capture). `id` stays read-only.

Click any value in Identity, Radio, or Routing to copy it.

Select a **link** to see its type, both ends, frame count, VLANs, ports and services, and for bridges the mechanism (STP / WDS / attachment) and the device it runs through. Select several devices to see a count by type and bulk actions.

**TX / RX / DA / RA** come from frames only and are never guessed. Wired: TX = Ethernet source, DA and RX = destination, RA omitted. 802.11 follows ToDS/FromDS.

---

## Layout

NetSeer lays the map out the same way every time:

- **Subnets are boxes** around their devices (turn this off with **Group by subnet** in **Layers**).
- **Access points** sit with their wireless clients: a row under the AP for a few clients, a ring for more, a grid for crowds.
- Routers and gateways come first in each group, then servers, access points, hosts, and wireless clients.
- Groups are packed to fit the shape of your window.

**Drag** any device (or a whole subnet box) to rearrange. Positions are saved per map. **Tidy layout** (grid button by the zoom controls, or right-click on empty space) discards dragged positions; you can undo it.

Zoom with the wheel, the **−** / **+** buttons, or **Fit to screen** (`F`). Hovering a device fades everything that isn't connected to it.

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
| Subnet membership | Device ↔ subnet (shown as boxes instead while grouping is on) |
| Bridges and attachments | STP / WDS / spanning-host links between distinct networks |

**Show all** and **Hide all** flip every link layer. Devices always stay visible. The **Devices** legend below explains the shapes and colors.

Bridges appear only with evidence: a device on more than one VLAN (or two same-version subnets), an 802.1D STP BPDU, or 802.11 four-address WDS. NetSeer doesn't invent them.

---

## Exports

**Export** in the top bar (needs at least one device):

| Item | File |
| --- | --- |
| draw.io diagram | `<map name>.drawio` |
| Visio drawing | `<map name>.vsdx` |
| Visio XML | `<map name>.vdx` |
| Full report | `<map name>-report.pdf` (every device and link) |

Diagram exports use **the positions you see on screen**, including your dragged positions, and draw **subnet boxes as containers** (in draw.io, moving the box moves its devices). Names, captions, notes, and field edits are included.

Per-device files (PDF, CSV, XML, text) come from **Export** in the details panel.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Find a device |
| Ctrl/Cmd + C, X, V | Copy, cut, paste |
| Ctrl/Cmd + Z | Undo |
| Delete / Backspace | Delete selected devices |
| `F` | Fit to screen |
| `?` | Show shortcuts |
| Esc | Close menus, clear the selection |

---

## Update and uninstall

Stay on [[netseer-install-and-use]]: `git pull origin main`, `uv sync --group dev`, restart `netseer`. To uninstall, stop the process and delete the clone / venv.

Public clone (no PAT):

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
```
