# NetSeer — How to

**Turn traffic into terrain.**

What each control does, and how to use it. For clone, install, update, and uninstall on Debian/Ubuntu, see [[netseer-install-and-use]].

NetSeer is a **local** browser preview (`http://127.0.0.1:47331` by default). It is not a compiled binary. Open it with `netseer`.

Maps, field edits, notes, and the clipboard live in **this browser’s** `localStorage`. They are not written back into the original pcap.

---

## Load and remove surveys

Left panel, **Load a survey**.

1. Click a bundled campus sample, **or** drop / pick `.pcap`, `.pcapng`, `.cap`, `.netxml`, `.csv`, or a NetSeer **Unwanted JSON** dump.
2. Uploads join the same list (tagged as uploaded captures).
3. **Remove** hides a bundled sample or drops an upload from the list. It does not delete files on disk.
4. **Restore bundled samples** appears if you hid them.

On a narrow screen, **Samples** in the header opens the left panel.

Empty, loading, and parse-error overlays cover the map when there is nothing to draw, a parse is in flight, or a file failed.

---

## Maps

Left **Maps** list is every map in this session. Click a row to switch. The active map is what you edit and export. Switching does **not** empty a survey.

| Kind | How it appears | Delete? | Rename? |
| --- | --- | --- | --- |
| Unwanted | Holding / quarantine map | No — use **Empty** | Yes |
| Survey map | After you load a sample or upload | Yes | Yes |
| Blank map | **New blank map** (header or Maps panel) | Yes | Yes |

**Rename** on a map row. **Delete** on survey and blank rows (confirm). Deleting a map does not write it to `Unwanted/`.

**Merge this map into** (dropdown + **Merge**): copies the **active** map’s devices, edges, edits, and notes onto the destination. ID collisions get a suffix (`~2`). **Unwanted cannot be a merge source or a merge target.**

**New blank map** starts empty. No campus sample required. Paste onto it, or leave it as a sketch.

---

## Unwanted holding map

Move devices you do not want on the working drawing here (**Move to Unwanted**, or cut/paste). Fields and notes go with them.

**Empty** (on the Unwanted row):

1. Confirms.
2. Writes one readable JSON dump per original capture into the project folder **`Unwanted/`**.
3. Names: `Unwanted-office-lan.json` from `office-lan.pcap`. No capture name → `Unwanted-unknown.json`. If the file already exists, NetSeer adds `-2`, `-3`, …
4. Clears the Unwanted map.

These dumps are a **graph sidecar** (nodes, links, notes), not a reconstructed pcap. Drop the JSON onto **Load a survey** to reload it as a map.

---

## Select, cut, copy, paste, move, delete

**Select** a device: click. Shift-click adds. Shift-drag boxes.

| Action | How |
| --- | --- |
| Cut | Cut button, right-click, device window, or Ctrl+X / Cmd+X |
| Copy | Copy button, right-click, device window, or Ctrl+C / Cmd+C |
| Paste | Switch to the destination map, then Paste or Ctrl+V / Cmd+V |
| Move | Cut then paste, **Move to Unwanted**, or **Move to** another map in the device window |
| Delete from the map | Delete / Backspace, Delete button, right-click, or **Delete from map** |
| Undo | Undo or Ctrl+Z / Cmd+Z (last cut, paste, move, delete, merge, or empty) |

Edges travel with a selection only when **both** endpoints are in that selection.

---

## Access point copy vs client copy

**Access point** (copy, cut, Move to Unwanted, Move to another map):

- The AP
- Associated **wireless clients** and the wireless edges between them
- **Other APs** on **bridge** links to that AP (WDS / STP / attachment) and those bridge edges
- Those bridged APs’ associated clients as well

**Wireless client:** copy/cut/move that station only. It does not pull the AP.

---

## Type labels, notes, and editable fields

Map nodes show a **short type**, not a dump of MAC/IP/OUI: Access point, Wireless client, Router, Switch, Server, Gateway, Host. VLAN and subnet objects keep their network names (`VLAN 10`, `10.10.10.0/24`, …).

Click a device:

- **Map name** and **On-map extra** (second line). **Use auto name** restores the inferred type.
- Every extracted field is editable. **Capture** vs **Edited**. **Reset** on a row goes back to the parse.
- **Your notes** at the bottom.
- `id` stays read-only.

---

## Field Copy vs Copy all

In the device window, each row’s **Copy** copies **only the text-box value** — not the field name, not the Capture/Edited badge.

**Copy all** is still a structured dump of the device (same as the plain-text export).

Downloads: **PDF / CSV / XML / Plain text**. Notes and edits go with those files when present.

---

## TX / RX / DA / RA and OUI

**TX / RX / DA / RA** are filled from frames only. Missing roles say `not present` — they are not guessed.

- Wired: TX = Ethernet src; DA and RX = dst; RA omitted.
- 802.11 follows ToDS/FromDS.

**OUI manufacturer** comes from the bundled IEEE MA-L / MA-M / MA-S / CID table. Locally administered and unregistered prefixes are labeled as such.

---

## Layers and zoom

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

Bottom-right **Zoom** slider (20–400%) stays in sync with wheel zoom. **Fit** frames the graph.

---

## Bridges

Pink diamond-dashed **bridge / attachment** lines appear only when the capture has evidence: a device MAC on more than one VLAN (or two same-version subnets), an 802.1D STP BPDU, or 802.11 four-address WDS. NetSeer does not invent bridges.

Click a bridge edge in the inspector for kind `bridge`, mechanism (STP / WDS / attachment), and via device.

Campus combined sample: two access points are joined by a **WDS** bridge. Copying one AP also takes the other AP (and their clients).

---

## Exports

Need a map with at least one device (toolbar buttons disable on empty).

| Button | File |
| --- | --- |
| Export draw.io | `netseer-map.drawio` |
| Export Visio .vsdx | `netseer-map.vsdx` |
| Export Visio XML | `netseer-map.vdx` |
| Report PDF | whole-map PDF (devices + links) |

Device-window downloads are per node. Map-name, extra, notes, and field edits are included in the graph posted to the server.

---

## Branding

Header: NetSeer logo, **NetSeer**, motto **Turn traffic into terrain.** Report PDFs carry the same chrome.

---

## Update and uninstall

Stay on [[netseer-install-and-use]]: `git pull origin main`, `uv sync --group dev`, restart `netseer`. To uninstall, stop the process and delete the clone / venv.

Public clone (no PAT):

```bash
git clone https://github.com/ardyn-systems/NetSeer.git
```
