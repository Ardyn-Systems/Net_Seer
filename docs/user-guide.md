# NetSeer user guide

**Turn traffic into terrain.** NetSeer turns packet captures and wireless surveys into a network map you can explore, annotate, and export. This guide walks through it with screenshots from the bundled campus sample.

For installing, see the [README](../README.md#get-netseer). For a terse reference of every control, see the [How to](netseer-how-to.md).

## Contents

1. [A tour of the screen](#a-tour-of-the-screen)
2. [Open your captures](#open-your-captures)
3. [Read the map](#read-the-map)
4. [Inspect a device](#inspect-a-device)
5. [Inspect a link](#inspect-a-link)
6. [Find a device](#find-a-device)
7. [Select, copy, and move devices](#select-copy-and-move-devices)
8. [Work with several maps](#work-with-several-maps)
9. [Show and hide layers](#show-and-hide-layers)
10. [Export diagrams and files](#export-diagrams-and-files)
11. [Create a PDF report](#create-a-pdf-report)
12. [Change the theme](#change-the-theme)
13. [Keyboard shortcuts](#keyboard-shortcuts)
14. [Where your work is saved](#where-your-work-is-saved)
15. [Troubleshooting](#troubleshooting)

## A tour of the screen

![The NetSeer window with six numbered areas: map title, sidebar, search, map, details panel, and zoom controls](images/screen-tour.png)

1. **Map title.** The map you're looking at. Click it to rename the map. **Open survey**, **Export**, the theme picker, and the shortcuts list sit to its right.
2. **Sidebar.** Three tabs: **Maps** (every map you have open), **Surveys** (captures and samples), and **Layers** (what the map shows).
3. **Find a device.** Search by name, IP, MAC, SSID, or notes.
4. **The map.** Devices, the subnets they belong to, and the links between them. A toolbar appears at the bottom when you select something.
5. **Details.** Everything NetSeer found about the selected device or link.
6. **Zoom.** Tidy layout, zoom out, zoom level, zoom in, and fit to screen.

## Open your captures

Click **Open survey**, or drag capture files anywhere onto the NetSeer window. Each capture becomes its own map.

![Surveys tab with a drop zone and the bundled campus samples](images/surveys-tab.png)

| Source | Files |
| --- | --- |
| Wireshark / tshark | `.pcap`, `.pcapng` |
| tcpdump | `.pcap` |
| Kismet | `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |
| NetSeer | `Unwanted-*.json` dumps |

Captures can be up to 50 MB, and NetSeer reads up to 80,000 packets from each. If something in a capture couldn't be read, a message says so, and the count of warnings appears at the bottom-left of the map.

The **Surveys** tab lists your captures and the bundled samples. Click one to open it. The **×** removes it from the list; its map stays under **Maps**. **Restore bundled samples** brings back any samples you removed.

## Read the map

![The campus sample: subnets drawn as boxes, access points with their wireless clients, and VLANs at the bottom](images/overview.png)

- **Boxes are subnets.** Each device sits inside the subnet it was seen in (for example `10.10.10.0/24`). Turn this off with **Group by subnet** in **Layers**.
- **Shapes and colours show the device type.** Access points are hexagons; routers and gateways have cut corners; servers, hosts, and wireless clients are rounded boxes in their own colours. VLANs are tag shapes. The legend is at the bottom of the **Layers** tab.
- **Lines are links.** Solid lines are wired neighbours, dashed lines are IP traffic, arrows run from a client to the service it used, and dotted pink lines with diamonds are bridges. Labels such as `http tcp/80` name the service.
- **Access points sit with their clients**, so you can see who is on which Wi-Fi network.
- **Hover a device** to fade everything that isn't connected to it.

Move around with the mouse: drag the background to pan and scroll to zoom (about 10% per notch). **Fit to screen** (or press `F`) frames everything.

**Drag** any device, or a whole subnet box, to rearrange the map. NetSeer remembers positions for each map. **Tidy layout** (the grid button by the zoom controls) puts everything back; you can undo it.

## Inspect a device

Click a device to see what NetSeer found.

![Details for a router renamed "Core router", with a caption, addresses, services, routing, and a note](images/device-details.png)

- **Name on map** and **Caption under the name** change how the device appears on the map. Here the router is renamed "Core router" with the caption "Server room, rack A". **Use auto name** goes back to the name NetSeer inferred.
- **Identity** shows IP and MAC addresses (with their TX/RX/DA/RA roles when the frames show them), the manufacturer from the MAC prefix, and VLANs.
- **Radio** (for wireless devices) shows SSIDs, channel, frequency, signal range, security, and GPS.
- **Services** and **Routing** show what it serves and what NetSeer learned from OSPF, DHCP, and DNS.
- **Notes** keeps anything you want to remember: asset tags, site notes, contacts.
- **Click any value** to copy it.

The buttons below copy a text summary of the device, export it, move it to another map, set it aside, or delete it from this map.

### Edit any field

Open **All extracted fields** for every value the parser found. Change any of them: the field is marked **Edited**, and **Reset** (shown when you hover the field) puts the captured value back. Your edits are used everywhere: on the map, in search, and in exports.

![All extracted fields for the router, each in an editable box](images/all-fields.png)

## Inspect a link

Click a line to see what it represents: the two ends, how many frames were seen, VLANs, and the services involved. For web traffic NetSeer also shows the HTTP host name it saw.

![Details for an HTTP link from a host to a server, with the HTTP host intranet.hq.local](images/link-details.png)

## Find a device

Press `/` or click **Find a device**, then type part of a name, IP, MAC, SSID, maker, or note. Use the arrow keys and Enter, or click a result, to select the device and centre the map on it.

![Searching "HQ" lists access points and wireless clients on the HQ-Secure and HQ-Guest networks](images/search.png)

## Select, copy, and move devices

Shift-click (or Ctrl-click) to select several devices, or hold Shift and drag a box around them. The toolbar at the bottom and the details panel both offer **Copy**, **Cut**, **Move to**, **Set aside**, and **Delete**.

![Three access points selected, with the selection toolbar and a count in the details panel](images/multi-select.png)

Right-click a device for the same actions:

![Right-click menu with Copy, Cut, Paste, Set aside in Unwanted, and Delete](images/context-menu.png)

**Move to** sends devices straight to another map, or to a new one:

![Move to menu listing Unwanted and New map](images/move-menu.png)

To copy instead, choose **Copy**, open the other map, and **Paste** (the button at the top of the map, or Ctrl+V). Names, captions, notes, and edits go with the devices. Links come along when both ends are copied.

**An access point brings its network.** Copying, cutting, or moving an access point also takes its associated wireless clients and any access points bridged to it. A wireless client on its own moves alone.

**Undo** (the arrow at the top of the map, the **Undo** button in the message, or Ctrl+Z) reverses the last 30 changes.

## Work with several maps

The **Maps** tab lists every map. Click one to switch. The **⋯** menu on a map renames it, merges it into another map, or deletes it.

![Maps tab with the campus survey's menu open: Rename, Merge into, and Delete map](images/maps-tab.png)

- **New blank map** starts an empty map to paste devices into, for example to draw just one site or one problem.
- **Merge into…** copies all of this map's devices into another map. The original map stays as it is.
- **Unwanted** is a holding area for devices you set aside. Its **Save to files and empty** option writes them to JSON files (one per original capture) and clears it. Drop one of those files back onto NetSeer to reload it.

![A blank map called "Lab bench" with a prompt to paste devices or open a survey](images/blank-map.png)

## Show and hide layers

The **Layers** tab controls what's drawn.

![Layers tab: Group by subnet switch, link layer checkboxes, and the device legend](images/layers-tab.png)

- **Group by subnet** draws subnets as boxes. Turn it off to show subnets as separate nodes with membership links instead.
- **Links** switches each kind of link on or off: wired, IP traffic, ports and services, wireless, VLAN membership, subnet membership, and bridges. Devices always stay visible.
- **Devices** is the legend for shapes and colours.

Your layer choices are remembered.

## Export diagrams and files

![Export menu: draw.io diagram, Visio drawing, Visio XML, and Report](images/export-menu.png)

- **draw.io diagram** (`.drawio`), **Visio drawing** (`.vsdx`), and **Visio XML** (`.vdx`) use the layout you see on screen, including positions you dragged. Subnets become containers: in draw.io, moving a subnet box moves its devices.
- **Report…** makes a PDF of the map (see below).
- For a single device, use **Export** in its details panel: PDF, spreadsheet (CSV), XML, or plain text.

Your names, captions, notes, and field edits are included in every export.

## Create a PDF report

**Export → Report…** lets you choose what the PDF contains, so you can make a one-page summary or a full audit.

![Report dialog with presets, sections, device types, detail options, and a page estimate](images/report-dialog.png)

- **Presets**: **Overview** (summary and device list), **Standard** (adds a block per device and a links table), or **Everything** (every field, including empty ones).
- **Sections**: summary, device inventory, device details, links table.
- **Devices**: all devices or only the ones you selected, and which types to include.
- **Details for each device**: identity, radio, services and ports, routing, connections, your notes, and raw parser extras. **Show empty fields** lists fields with no value too.
- **Match the map's Layers** leaves out link types you've hidden.

The footer estimates the number of pages before you create the PDF, and NetSeer remembers your choices for next time.

![Two report pages: a summary with counts and the device inventory, and the device details for the core router](images/report-pages.png)

## Change the theme

Click the palette button in the top bar.

![Theme menu with Terrain, Midnight, Daylight, and Blueprint](images/theme-menu.png)

![The same map in the Terrain, Midnight, Daylight, and Blueprint themes](images/themes.png)

**Terrain** is the default. **Daylight** works best for screenshots, projectors, and printing. Themes change the app only; exported files keep their own colours.

## Keyboard shortcuts

Press `?` or click the **?** button to see them in NetSeer.

![Keyboard shortcuts dialog](images/shortcuts.png)

| Key | Action |
| --- | --- |
| `/` | Find a device |
| Ctrl/Cmd + C, X, V | Copy, cut, paste devices |
| Ctrl/Cmd + Z | Undo |
| Delete or Backspace | Delete the selected devices |
| Shift + click, Shift + drag | Add to the selection, box-select |
| `F` | Fit the map to the screen |
| Esc | Close menus and clear the selection |

## Where your work is saved

NetSeer never changes your capture files. Maps, names, notes, edits, and positions are saved automatically on your computer:

| | Windows | Linux |
| --- | --- | --- |
| Saved maps (desktop app) | `%LOCALAPPDATA%\NetSeer\webview` | `~/.local/share/NetSeer/browser` |
| Unwanted files | `Documents\NetSeer\Unwanted` | `~/Documents/NetSeer/Unwanted` |
| Log | `%LOCALAPPDATA%\NetSeer\netseer.log` | `~/.local/share/NetSeer/netseer.log` |

If you run NetSeer from source and use your normal browser, maps are saved in that browser for `http://127.0.0.1:47331`. Clearing that site's data removes them.

## Troubleshooting

**Windows says "Windows protected your PC".** The builds aren't code-signed yet. Choose **More info** → **Run anyway**.

**"NetSeer is already open."** Only one copy runs at a time. Look for its window on the taskbar.

**My maps are missing.** Maps are saved per address and per browser. If another program was using port 47331, NetSeer picked the next free port and its maps are kept separately; the log says which port it used. On Linux, maps saved in the app window and maps saved in your normal browser are separate too.

**NetSeer opened in my web browser instead of a window.** On Windows, install [Microsoft Edge WebView2](https://go.microsoft.com/fwlink/p/?LinkId=2124703). On Linux, install Chrome, Chromium, Edge, Brave, or Vivaldi for a separate app window. In the browser, NetSeer quits by itself a couple of minutes after you close its tab.

**A capture won't open.** Check that it's one of the [supported formats](#open-your-captures) and under 50 MB. Files that parse but contain no devices say "No hosts, access points, or links were found".

**Something else looks wrong.** The log (see the table above) has the details. Run `NetSeer --smoke-test` (or `NetSeer.exe --smoke-test`) to check the installation; exit code 0 means it's working.

---

The screenshots in this guide come from `docs/screenshots.py`, which drives NetSeer with Playwright. To refresh them after changing the interface, see the instructions at the top of that file.
