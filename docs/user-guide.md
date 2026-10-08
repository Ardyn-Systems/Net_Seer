# NetSeer user guide

**Turn traffic into terrain.** NetSeer turns packet captures and wireless surveys into a network map you can explore, annotate, and export. This guide walks through it with screenshots from the campus sample, one of the demo captures in **Settings → Help**.

To follow along without installing anything, open **[netseer.onrender.com](https://netseer.onrender.com)**; click **Try a demo** and open the campus sample to see the same map (the first visit can take about 50 seconds while the free server wakes up). For installing, see the [README](../README.md#get-netseer). For a terse reference of every control, see the [How to](netseer-how-to.md).

## Contents

1. [A tour of the screen](#a-tour-of-the-screen)
2. [Open your captures](#open-your-captures)
3. [Read the map](#read-the-map)
4. [Inspect a device](#inspect-a-device)
5. [Inspect a link](#inspect-a-link)
6. [Check security](#check-security)
7. [Look at a time window](#look-at-a-time-window)
8. [Find a device](#find-a-device)
9. [Select, copy, and move devices](#select-copy-and-move-devices)
10. [Work with several maps](#work-with-several-maps)
11. [Compare surveys for changes](#compare-surveys-for-changes)
12. [Add what the capture didn't show](#add-what-the-capture-didnt-show)
13. [Show and hide layers](#show-and-hide-layers)
14. [Export diagrams and files](#export-diagrams-and-files)
15. [Create a PDF report](#create-a-pdf-report)
16. [Change the theme](#change-the-theme)
17. [Settings, updates, and the tour](#settings-updates-and-the-tour)
18. [Where your work is saved](#where-your-work-is-saved)
19. [Troubleshooting](#troubleshooting)

## A tour of the screen

![The NetSeer window with six numbered areas: map title, sidebar, search, map, details panel, and zoom controls](images/screen-tour.png)

1. **Map title.** The map you're looking at. Click it to rename the map. **Open survey**, **Export**, the theme picker, and the **Settings** cog sit to its right.
2. **Sidebar.** Three tabs: **Maps** (every map you have open), **Surveys** (your captures, and any demos you've opened), and **Layers** (what the map shows).
3. **Find a device.** Search by name, IP, MAC, SSID, or notes.
4. **The map.** Devices, the subnets they belong to, and the links between them. A toolbar appears at the bottom when you select something.
5. **Details.** Everything NetSeer found about the selected device or link.
6. **Zoom.** Tidy layout, zoom out, zoom level, zoom in, and fit to screen.

## Open your captures

NetSeer starts empty. Click **Open survey**, or drag capture files anywhere onto the NetSeer window. Each capture becomes its own map.

![A fresh start: the welcome card with Open survey and Try a demo](images/welcome.png)

**Try a demo** (or **Settings** → **Help**) lists sample captures to explore without any of your own. **Open** loads one as a survey and a map; it's marked **Opened** after that. **Compare the branch office samples** opens a pair surveyed a week apart and sets up [Compare surveys](#compare-surveys-for-changes) with them.

![Settings, Help: the tour, shortcuts, and the sample captures with Open](images/settings-demo.png)

![Surveys tab with a drop zone and two opened captures](images/surveys-tab.png)

| Source | Files |
| --- | --- |
| Wireshark / tshark | `.pcap`, `.pcapng` |
| tcpdump | `.pcap` |
| Kismet | `.kismet` (its native log), `.pcap`, `.pcapng`, `.netxml`, `.csv` |
| airodump-ng | `.csv`, `.cap` |
| NetSeer | `Unwanted-*.json` dumps |

A Kismet `.kismet` log needs no converting: NetSeer reads its packets and Kismet's device list, including SSIDs, encryption, makers, the networks clients probed for, and access points that hide their network name (shown as **Hidden SSID**).

Installed copies open captures of any size, including long wardrives. A big file shows a progress bar with how much has been read and how many packets and devices so far. **Stop and show map** draws what's been read so far; **Cancel** discards it. The [online copy](https://netseer.onrender.com) takes captures up to 20 MB and says so when a file is bigger; install NetSeer for those. If something in a capture couldn't be read, a message says so, and the count of warnings appears at the bottom-left of the map.

The **Surveys** tab lists your captures, and any demo samples you've opened. Click one to open it. Right-click a survey (or use its **⋯** button) for more:

![Right-click menu on a survey: Open, Merge into, Compare with a baseline, Remove from list, and Delete survey and its map](images/survey-menu.png)

- **Merge into…** copies the survey's devices into a map you pick.
- **Compare with a baseline…** opens **Compare surveys** with this survey ready to check against an earlier one. See [Compare surveys for changes](#compare-surveys-for-changes).
- **Remove from list** hides the survey and keeps its map under **Maps**. Click **Bring back** in the message to restore it.
- **Delete survey and its map…** removes both after asking. **Undo** brings the map back; **Bring back** in the message restores the survey to the list.

Drag surveys up or down to put them in the order you like. A demo sample you remove from the list comes back when you open it again from **Settings** → **Help**.

## Read the map

![The campus sample: a box for each Wi-Fi network with its access points and clients, the wired devices in Not on Wi-Fi, and the subnets and VLANs at the bottom](images/overview.png)

- **Boxes are Wi-Fi networks.** Each network name (SSID) gets a box with its access points and their clients, titled with how many of each. Wired devices share a **Not on Wi-Fi** box, and subnets and VLANs come last. To see subnets as boxes instead, pick **By subnet** in **Layers** → **Arrange devices**.
- **Shapes and colours show the device type.** Access points are hexagons; routers and gateways have cut corners; servers, hosts, and wireless clients are rounded boxes in their own colours. VLANs are tag shapes. The legend is at the bottom of the **Layers** tab.
- **Lines are links.** Solid lines are wired neighbours, dashed lines are IP traffic, arrows run from a client to the service it used, and dotted pink lines with diamonds are bridges. Labels such as `http tcp/80` name the service.
- **Access points sit with their clients**, so you can see who is on which Wi-Fi network. Each access point shows its **SSID** (network name) under its name, such as `HQ-Secure`, or `HQ-Secure +2` when it broadcasts several. **Hidden SSID** means the survey shows the network hides its name. A caption you type replaces it, and you can turn SSIDs off in **Settings**.
- **Click a device** to select it: it gets a bright outline and glow, and its links are drawn on top. To fade everything that isn't connected to the device under the pointer, turn on **Fade unrelated devices on hover** in **Settings** (it's off by default).

Move around with the mouse: drag the background to pan and scroll to zoom (about 10% per notch). **Fit to screen** (or press `F`) frames everything.

**Drag** any device, or a whole box, to rearrange the map. NetSeer remembers positions for each map. **Tidy layout** (the grid button by the zoom controls) puts everything back; you can undo it.

## Inspect a device

Click a device to see what NetSeer found.

![Details for a router renamed "Core router", with a caption, addresses, services, routing, and a note](images/device-details.png)

- **Name on map** and **Caption under the name** change how the device appears on the map. Here the router is renamed "Core router" with the caption "Server room, rack A". **Use auto name** goes back to the name NetSeer inferred.
- **Identity** shows IP and MAC addresses (with their TX/RX/DA/RA roles when the frames show them), the manufacturer from the MAC prefix, and VLANs.
- **Radio** (for wireless devices) shows SSIDs, channel, frequency, signal range, security, and GPS.
- **Services** and **Routing** show what it serves and what NetSeer learned from OSPF, DHCP, and DNS.
- **Notes** keeps anything you want to remember: asset tags, site notes, contacts.
- **Security** lists what NetSeer found about the device's safety. See [Check security](#check-security).
- **Click any value** to copy it.

The buttons below copy a text summary of the device, export it, move it to another map, set it aside, or delete it from this map.

### Edit any field

Open **All extracted fields** for every value the parser found. Change any of them: the field is marked **Edited**, and **Reset** (shown when you hover the field) puts the captured value back. Your edits are used everywhere: on the map, in search, and in exports.

![All extracted fields for the router, each in an editable box](images/all-fields.png)

## Inspect a link

Click a line to see what it represents: the two ends, how many frames were seen, VLANs, and the services involved. For web traffic NetSeer also shows the HTTP host name it saw. **Remove this link** (in the details, or by right-clicking the line) takes it off the map without moving either device; you can undo it.

![Details for an HTTP link from a host to a server, with the HTTP host intranet.hq.local](images/link-details.png)

## Check security

Every device's details include a **Security** section. NetSeer only reports what the capture actually shows; it never scans or probes anything.

![A server's Security section: a Critical badge, a finding, and Apache with CVEs showing severity, EPSS likelihood, and a "known exploited" flag](images/security-details.png)

- **Findings** are things the capture shows directly, each with a severity (Critical, High, Medium, Low), why it matters, and how to fix it. Examples: an **open** or **WEP** Wi-Fi network, **WPS** left on, **Telnet** or **FTP**, **SNMP** with a default community, a database reachable on the network, or **TLS 1.0/1.1**. These are certain, so they carry no percentage.
- **Software it revealed** lists products and versions a device announced in a banner (an SSH greeting, an HTTP `Server` header). When the version is known, NetSeer lists the matching vulnerabilities, each with:
  - its **CVE** number (click to read it on NVD),
  - its **severity** and CVSS score,
  - its **EPSS** score — the estimated chance it is exploited in the wild in the next 30 days,
  - a **Known exploited** flag when it is on CISA's list.
  - They're ordered with the most likely to be exploited first. If a device only gives a product name with no version, NetSeer says so rather than guessing.
- **Wi-Fi handshakes** are noted when a WPA four-way handshake between a device and its access point was captured. If enough was captured on a password network, it's flagged: someone with the capture could try the Wi-Fi password offline. **Export** it for your own testing as a **pcap** (opens in Wireshark, converts to anything) or a **hashcat** `.hc22000` file. This repackages frames already in your capture — it recovers no password itself; use it only on networks you're allowed to test.
- **Shade the map by security:** in **Layers → Security**, turn on **Shade by security** to tint every device by its most serious finding (red for Critical down to blue for Low), with a count of each.

The vulnerability data is bundled with NetSeer, so this works with no internet. Keep it current under **Settings → Vulnerability Database** (see [Settings](#settings-updates-and-the-tour)) — an update also looks up any product it saw in your captures that wasn't in the data yet, so unusual services get covered over time.

To try it, open **Settings → Help** and open **Small office: security check**.

## Look at a time window

When a capture records times (pcap, pcapng, and Kismet logs do), a **timeline** sits under the map. It shows when the capture started and ended, and a chart of how many devices were active over time.

![The timeline under a map: start and end times, an activity chart, and a selected window with how many devices are in it](images/timeline.png)

- **Drag the two handles** to pick a window. Only devices and links heard during it stay on the map; the rest disappear, and nothing moves. The bar shows the window, its length, and how many devices are in it.
- **New map from this window** makes a separate map of just that time: the devices and links heard in it (and any you added), with their activity trimmed to the window and your names, captions, and notes carried over. It's named after the window, lays out fresh, and its own timeline covers only that period. The original map is unchanged; Undo removes the new one.
- **Compare…** checks this window against a baseline survey, or against another window of the same capture. See [Compare surveys for changes](#compare-surveys-for-changes).
- **Show all** goes back to the whole capture. The **×** hides the timeline (and shows everything); the **clock** button by the zoom controls brings it back.
- A device's **Details** show when it was first and last seen, and how long it was active. Links show the same.
- **Exports follow the window:** draw.io, Visio, and the PDF report include only what's on the map, and the report notes the window.
- Search still finds devices outside the window. They're marked, and picking one shows the whole capture again.

Devices that are heard again within a minute count as one stretch of activity. NetXML and CSV surveys don't record reliable times, so they have no timeline: their maps and surveys say **no timeline** in the sidebar and in **Compare surveys**, and their devices (and any you add yourself) always show.

Times are shown in **this computer's time zone** unless you choose another in **Settings** → **General** → **Time**, along with a 12- or 24-hour clock. Captures record exact moments, so changing the zone only changes how they're written.

## Find a device

Press `/` or click **Find a device**, then type part of a name, caption, SSID, IP, MAC, maker, or note. Every match is listed, best first (names, then captions and SSIDs, then addresses, then makers), and each row says what matched, such as `SSID: NETGEAR66-5G` or `maker: NETGEAR`. Use the arrow keys and Enter, or click a result, to select that device and centre the map on it. **Select all on the map** selects every match at once.

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

**Undo** (the left arrow at the top of the map, the **Undo** button in the message, or Ctrl+Z) reverses the last 30 changes. Each drag counts as one change, so Undo puts what you dragged back where it was. **Redo** (the right arrow, **Redo** in the message, or Ctrl+Y or Ctrl+Shift+Z) puts them back. Undo and Redo only change maps: devices, links, names, notes, and positions. They don't touch the clipboard, the Surveys list, the order of your maps, or settings.

## Work with several maps

The **Maps** tab lists every map. Click one to switch. Right-click a map, or use its **⋯** menu, to rename it, merge it into another map, compare it with a baseline, or delete it.

![Maps tab with the campus survey's menu open: Rename, Merge into, Compare with a baseline, and Delete map](images/maps-tab.png)

- **New blank map** starts an empty map to paste devices into, for example to draw just one site or one problem.
- **Merge into…** copies all of this map's devices into another map. The original map stays as it is.
- **Drag to organize.** Drag a map up or down the list to reorder it. Drop it **onto** another map to merge it into that map, with Undo. To merge a survey, drag it from **Surveys**, hold it over the **Maps** tab until the tab opens, then drop it on a map. Esc cancels a drag.
- **Resize the sidebar** by dragging its right edge, so long names fit. Double-click the edge to reset it. NetSeer remembers the width.
- **Unwanted** is a holding area for devices you set aside. Its **Save to files and empty** option writes them to JSON files (one per original capture) and clears it. Drop one of those files back onto NetSeer to reload it.

![A blank map called "Lab bench" with a prompt to paste devices or open a survey](images/blank-map.png)

## Compare surveys for changes

Survey a site once as a **baseline**, survey it again later, and NetSeer shows what changed. Click **Compare surveys…** in the **Maps** tab (or **Compare with a baseline…** on a map or survey, or **Compare…** on the timeline).

![Compare surveys: a baseline and a survey to compare with, each with its own activity chart and From and To sliders for its time window](images/compare-dialog.png)

1. **Baseline:** pick the earlier survey or map. Surveys you haven't opened yet are listed too.
2. **Compare with:** pick the later survey. **Add another survey** compares more than one against the same baseline; each gets its own map.
3. **Time windows:** each capture has its own, with a small chart of its activity. Drag its **From** and **To** to compare only part of it: a baseline from the morning against a survey from the afternoon, or the first hour of one walk against the last hour of another. Two windows of the same capture work too. **Whole capture** resets one.
4. Click **Compare**. A new **Comparison** map opens, and **Layers** shows what changed.

![A comparison map: a client that left its Wi-Fi network shaded red, a new client shaded green, a laptop that moved networks and a possible rogue access point shaded blue, and the unchanged devices faded](images/compare-map.png)

| Shade | Meaning |
| --- | --- |
| **Red** | Left a Wi-Fi network, access point, subnet, or VLAN it was on, or is no longer seen at all (dashed) |
| **Green** | Joined a network it wasn't on, or is new since the baseline |
| **Blue** | Something else changed: moved from one network to another, roamed to another access point, a randomized MAC that rotated, a new access point using a known network's name (a possible rogue), an access point's name, security, or channel, an address, a type, or its services |
| Faded | Nothing NetSeer can see changed |

Each changed device also says what happened under its name (**+ Joined Branch-Staff**, **− No longer seen**, **Δ MAC changed**), so the map reads without the colours too. Links that are gone are red and dashed; new links are green. Click a device to see every change in **Details**; its shade deepens to show it's selected.

- **Randomized MACs:** phones change their MAC address. When one random MAC disappears and another appears that probes the same networks, uses the same access point, or has the same address, NetSeer treats them as one device and says why.
- **Show unchanged devices** in **Layers** hides the faded ones, leaving only what changed.
- Your names, captions, and notes come along from the surveys you compared. Undo removes the new maps.

To try it, open **Settings** → **Help** and click **Compare the branch office samples**: a branch surveyed twice, a week apart, with one of every kind of change.

## Add what the capture didn't show

Sometimes you know more than the capture does: a switch port label, a network diagram, a note from IT. You can add that to the map, and it stays clearly marked as **added by you**, so it's never mistaken for something NetSeer saw.

**Connect two devices.** Right-click a device and choose **Connect to…**, then click the other device (Esc cancels). Or select two devices and click **Connect** in the toolbar. Choose how they're connected:

- **Wired**: a cable, switch port, or patch panel
- **Wi-Fi**: the client joins this access point (offered when one of the two is an access point). The client then sits with that access point on the map.
- **Other**: same network, same rack, uplink, VPN, or anything else

Add a short **label** for the map (such as `Port 14`) and a note on **where this came from**.

![Connect dialog: Wired, Wi-Fi, and Other, with a label and a note on where it came from](images/connect-dialog.png)

**Add a device to a subnet or VLAN.** Right-click it and choose **Add to subnet or VLAN…**. Pick one already on the map, or type a new one (`10.20.0.0/24`, or a VLAN number). Arranged by subnet, the device moves into that subnet's box.

**How they look.** Links you add keep their type's colour, with a dash-dot line and a ✎ pencil mark before the label. Click one to see when you added it, change its label or note, or **Remove this link**; right-click it for the same. The **Added by you** switch in **Layers** shows or hides them all.

![A link added by you, labelled "✎ Port 14", with its details: added by you, the label, the note, and Remove this link](images/manual-link.png)

**Disconnect two devices.** The opposite of connecting: right-click a device, choose **Disconnect from…**, and click the other device. Or select two connected devices and click **Disconnect**. A short list shows every link between them (wired, IP traffic, Wi-Fi, ones you added), all ticked; untick any you want to keep. Nothing is deleted except those links, and every device stays exactly where it is on the map. Undo brings the links back.

![Disconnect dialog listing the Wi-Fi link between an access point and its client, with its frame count](images/disconnect-dialog.png)

Everything you add is saved with the map, included in backups, and can be undone. Exports carry the mark too: draw.io and Visio use the dash-dot line and ✎ label, and the PDF report marks each one as "added by you" with your note.

## Show and hide layers

The **Layers** tab controls what's drawn, and how devices are arranged.

![Layers tab: the Arrange devices list, link layer checkboxes, and the device legend](images/layers-tab.png)

- **Arrange devices** picks the layout:
  - **By network name** (the default) makes a box per Wi-Fi network (SSID) with its access points and their clients. Handy for picking out every "NETGEAR" or guest network at once. Wired devices share a **Not on Wi-Fi** box.
  - **By subnet** puts each device in its subnet's box, with access points beside their clients.
  - **By connection** puts devices that are linked next to each other. Each group of linked devices is its own cluster, biggest first. The busiest device (a gateway, switch, or access point) is in the middle, with what it connects to in rings around it, so lines stay short and rarely cross. Devices with no links follow in a grid, then the subnet and VLAN labels. Subnet and VLAN membership lines aren't drawn in this view; each device's details still show its subnet and VLANs.
  - **By location (GPS)** places devices where they were heard, using the GPS in Kismet and wardrive surveys. A label shows the scale. Devices without a location are grouped in a box beside them.
  - **By channel** makes a box per Wi-Fi channel, labelled with its band. Clients sit in their access point's channel; wired devices come last.
  - **Top-down hierarchy** puts gateways at the top, then what connects to them, level by level, like an org chart.
  - **By signal strength** places devices on dashed rings by how strongly they were heard, strongest in the middle, with each band's range labelled at the top. Devices with no signal reading are grouped separately.
  - **By maker** makes a box per manufacturer (from the MAC address), largest first.

  Every arrangement except **By subnet** draws its own labelled boxes; they aren't devices, so they can't be selected and aren't exported. Subnet and VLAN membership lines are drawn only in the subnet arrangement.

  Each arrangement keeps its own dragged positions, so switching back and forth never scrambles either one.

![The campus sample arranged by connection: the router in the middle of its cluster, access points with their clients, and unconnected devices below](images/arrange-by-connection.png)

![The campus sample arranged by channel: a box per Wi-Fi channel with its access points and clients, then the wired devices](images/arrange-by-channel.png)

- **Links** switches each kind of link on or off: wired, IP traffic, ports and services, wireless, VLAN membership, bridges, and links added by you. Subnets are the boxes when arranged by subnet. Devices always stay visible.
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

Open **Settings** → **General** and pick a theme from the grid at the top.

![The same map in the Terrain, Midnight, Daylight, Blueprint, and Retrowave themes](images/themes.png)

**Terrain** is the default, with a topographic map behind your network. **Daylight** works best for screenshots, projectors, and printing. **Retrowave** is a soft synthwave look — muted plum with a faint neon grid, kept easy on the eyes. Themes change the app only; exported files keep their own colours.

## Keyboard shortcuts

Press `?`, or open **Settings** → **Help** → **Keyboard shortcuts**, to see them in NetSeer.

![Keyboard shortcuts dialog](images/shortcuts.png)

| Key | Action |
| --- | --- |
| `/` | Find a device |
| Ctrl/Cmd + C, X, V | Copy, cut, paste devices |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Y, or Ctrl/Cmd + Shift + Z | Redo |
| Delete or Backspace | Delete the selected devices |
| Shift + click, Shift + drag | Add to the selection, box-select |
| `F` | Fit the map to the screen |
| `?` | Show the shortcuts |
| Esc | Close menus, clear the selection, or cancel a drag |
| Right-click | Menus for devices, maps, and surveys |

## Settings, updates, and the tour

Click the **cog** at the right of the top bar. A dot on the cog means a newer version is out.

![Settings, General: theme, scroll-to-zoom speed, SSIDs under access points, and hover fading](images/settings-general.png)

**General.** Pick a theme, choose how far one notch of the mouse wheel zooms (**Gentle**, **Normal**, or **Quick**), and turn SSIDs under access points and hover fading on or off. **Time** sets the time zone and 12- or 24-hour clock used for capture times on the timeline and in Details.

The **sample captures** to try NetSeer with are under **Help** — see [Open your captures](#open-your-captures).

**Vulnerability Database.** Shows the vulnerability data NetSeer uses for the device **Security** findings, and when it was built. **Update database** downloads the latest from NVD, FIRST (EPSS), and CISA in a few minutes; it sends only product names, nothing about you or your maps. It also looks up products NetSeer saw in your captures but didn't recognize — when it finds one, it says so ("NetSeer saw 1 service it doesn't recognize yet…") and the button lights up. On an installed copy the button also brightens when the data is getting old, and is held back with a reason when you're offline. Without updating, the data is as current as your version of NetSeer.

![Settings, Vulnerability Database: the data in use and a highlighted Update database button](images/settings-security.png)

**Your data.** Shows how many maps and devices are saved in this browser.

![Settings, Your data: a summary, Back up all maps, Restore a backup, and Clear all data](images/settings-data.png)

**Integrations.** Pair companion apps — such as WaveTop — so they can push captures straight into NetSeer, with no file to save and open. **Pair a device** shows a one-time code to type into the app; paired devices are listed with when you added them and last used each, and a **Revoke** button removes access. Turn on **Allow devices on my network** to let a paired app on another device (like a phone running WaveTop) reach NetSeer over your Wi-Fi or LAN — it's off by default, takes effect after you restart NetSeer, and your operating system's firewall may ask you to allow it the first time. Even then, NetSeer answers only the integration API over the network, and only to paired devices; the map and the rest of the app stay on your computer. It's on installed and source copies, not the public online one.

Once paired, an app can **push a capture** — it arrives as a new survey and opens on its own, with no file to save — or **stream a live wardrive**: as the app reports access points and clients it sees, NetSeer opens a **Live wardrive** survey and builds the map in front of you, updating as you move, and tells you when the app ends the session.

![Settings, Integrations: a pairing code and the paired devices list](images/settings-integrations.png)

- **Back up all maps** downloads one `NetSeer-backup-<date>.json` file with every map, name, note, edit, position, and preference.
- **Restore a backup…** replaces what's saved here with a backup file. It asks first.
- **Clear all data…** removes everything saved here and starts fresh. It asks first. Your capture files aren't touched.
- The line above the buttons says whether your maps are **protected** from automatic cleanup. Browsers can delete a site's storage when the disk is nearly full; if yours isn't protected yet, click **Protect my maps**. See [How much you can store](../README.md#how-much-you-can-store).

Use a backup to move your maps to another computer or browser, or before trying a different version.

**Updates.** Shows your version and how NetSeer is installed. **Check for updates** asks GitHub for the list of releases. This is the only time NetSeer goes online, and nothing about you or your maps is sent.

![Settings, Updates: the installed version, a newer release with an Update button, and Earlier versions opened to a list to pick one and Roll back](images/settings-updates.png)

*The releases in this picture are an example.*

- In the **desktop app**, NetSeer updates itself. Leave **Update NetSeer automatically** on (the default) and it downloads a new release in the background, then shows an in-app window with a **Restart and update** button when it's ready — the Windows installer runs silently, the Linux AppImage is replaced in place. **Check for updates** shows the same window with the download progress as it goes. Turn auto-update off to stay on your version and check only when you want. Your maps are untouched either way.
- From **source** or online, the pane lists the releases. Each links to its **Release notes** and the download for your platform; older ones fold under **Earlier versions**. From source, the button copies a `uv tool install` command for that version instead.
- **Check when NetSeer opens** (off by default) checks at most once a day and tells you once about each new release.
- The [online copy](https://netseer.onrender.com) updates itself, so it shows no list.

**Help.** Start the tour, see the keyboard shortcuts, open this guide, or report a problem on GitHub.

![Settings, Help: Take the tour, Keyboard shortcuts, User guide, and Report a problem](images/settings-help.png)

**About.** Version, how NetSeer is running, links, and the open-source components it's built with.

![Settings, About: logo, version, how it's running, links, and the components NetSeer is built with](images/settings-about.png)

### The tour

On your first visit NetSeer offers a one-minute tour. You can start it any time from **Settings** → **Help** → **Take the tour**. It highlights each part of the screen in turn: opening surveys, the sidebar and how to organize it, the map, search, details, export, themes, and settings. Use **Next** and **Back** or the arrow keys. **Skip tour** or Esc ends it.

![The tour highlighting the details panel, with step 8 of 11 explaining what it shows](images/tour.png)

## Where your work is saved

NetSeer never changes your capture files. Maps, names, notes, edits, and positions are saved automatically on your computer:

| | Windows | Linux |
| --- | --- | --- |
| Saved maps (desktop app) | `%APPDATA%\NetSeer` | `~/.config/NetSeer` |
| Unwanted files | `Documents\NetSeer\Unwanted` | `~/Documents/NetSeer/Unwanted` |

If you run NetSeer from source and use your normal browser, maps are saved in that browser for `http://127.0.0.1:47331`. Clearing that site's data removes them.

To keep a copy, or to move your maps somewhere else, use **Settings** → **Your data** → **Back up all maps**.

## Troubleshooting

**Windows says "Windows protected your PC".** The builds aren't code-signed yet. Choose **More info** → **Run anyway**.

**"NetSeer is already open."** Only one copy runs at a time. Look for its window on the taskbar.

**My maps are missing.** Maps are saved per address and per browser. If another program was using port 47331, NetSeer picked the next free port and its maps are kept separately. Maps saved in the desktop app and maps saved in your normal browser from source are separate too.

**A capture won't open.** Check that it's one of the [supported formats](#open-your-captures). In the online copy, it must be under 20 MB; installed copies have no limit. Files that parse but contain no devices say "No hosts, access points, or links were found".

**A new version is misbehaving.** Turn off **Update NetSeer automatically** under **Settings** → **Updates** to stay put. To go back to an earlier release, download it from [GitHub Releases](https://github.com/ardyn-systems/NetSeer/releases) and install it over the current one. Back up your maps first under **Your data**.

**An update didn't finish.** Reopen NetSeer from the Start menu or app menu; it checks again on the next launch. You can always download the release from [GitHub](https://github.com/ardyn-systems/NetSeer/releases) and install it the usual way.

**Something else looks wrong.** Start the desktop app with `ELECTRON_ENABLE_LOGGING=1` to see the backend's log on the console. Run `NetSeer --smoke-test` (or `NetSeer.exe --smoke-test`) to check the installation; exit code 0 means it's working.

---

The screenshots in this guide come from `docs/screenshots.py`, which drives NetSeer with Playwright. To refresh them after changing the interface, see the instructions at the top of that file.
