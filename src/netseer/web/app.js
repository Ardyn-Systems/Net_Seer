/* NetSeer preview — cytoscape map, samples, upload, export. */
const HIDDEN_SAMPLES_KEY = "netseer.hiddenSamples";
const MAPS_KEY = "netseer.maps.v2";
const UNWANTED_ID = "map:unwanted";
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

const state = {
  graph: null,
  title: "NetSeer map",
  cy: null,
  catalog: [],
  surveys: [],
  activeId: null,
  maps: [],
  activeMapId: null,
  clipboard: null,
  undo: null,
  filters: {
    l2: true,
    l3: true,
    "client-server": true,
    wireless: true,
    vlan: true,
    subnet: true,
    bridge: true,
  },
};

const el = (id) => document.getElementById(id);

function show(id, on) {
  el(id).classList.toggle("hidden", !on);
}

function setStatus(text) {
  el("status").textContent = text;
}

let storageFull = false;

// localStorage throws when full (large captures fill the ~5 MB quota fast).
// Say so once instead of silently dropping edits that would vanish on reload.
function saveLocal(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    if (!storageFull) {
      storageFull = true;
      const msg = "Browser storage is full, so map edits will not survive a reload. Delete or export maps to free space.";
      setStatus(msg);
      window.alert(msg);
    }
    return false;
  }
}

function nodeCaption(node) {
  const listens = (node.ports || []).filter((p) => p.role === "listen" || p.role === "dest");
  const displays = [];
  for (const p of listens) {
    if (p.display && !displays.includes(p.display)) displays.push(p.display);
  }
  if (displays.length) return displays.slice(0, 3).join(" · ");
  return (node.services || []).slice(0, 3).join(" · ");
}

const META_KEY = "netseer.deviceMeta.v1";

function allDeviceMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function metaStorageKey(nodeId) {
  return `${state.activeMapId || state.activeId || "map"}::${nodeId}`;
}

function getDeviceMeta(nodeId) {
  const all = allDeviceMeta();
  const primary = all[metaStorageKey(nodeId)];
  if (primary) return primary;
  const map = getMap(state.activeMapId);
  if (map?.sourceId) {
    const legacy = all[`${map.sourceId}::${nodeId}`];
    if (legacy) return legacy;
  }
  if (state.activeId && state.activeId !== state.activeMapId) {
    const legacy = all[`${state.activeId}::${nodeId}`];
    if (legacy) return legacy;
  }
  return {};
}

function setDeviceMeta(nodeId, patch) {
  const all = allDeviceMeta();
  const key = metaStorageKey(nodeId);
  const prev = all[key] || {};
  const next = { ...prev, ...patch };
  if (patch.fields && prev.fields) {
    next.fields = { ...prev.fields, ...patch.fields };
  }
  all[key] = next;
  saveLocal(META_KEY, JSON.stringify(all));
}

function clearFieldOverride(nodeId, fieldKey) {
  const all = allDeviceMeta();
  const key = metaStorageKey(nodeId);
  const prev = all[key] || {};
  const fields = { ...(prev.fields || {}) };
  delete fields[fieldKey];
  all[key] = { ...prev, fields };
  saveLocal(META_KEY, JSON.stringify(all));
}

const LIST_FIELDS = new Set([
  "mac_tx",
  "mac_rx",
  "mac_da",
  "mac_ra",
  "macs",
  "ips",
  "ssids",
  "encryption",
  "roles",
  "services",
]);
const INT_LIST_FIELDS = new Set(["vlans", "channels"]);
const FLOAT_LIST_FIELDS = new Set(["frequencies_mhz"]);
const JSON_FIELDS = new Set(["routing", "extra", "ports", "gps"]);
const MAP_STYLE_KEYS = new Set(["kind", "medium", "inferred_type"]);
const SKIP_DIALOG_KEYS = new Set(["label", "caption", "notes"]);
const READONLY_KEYS = new Set(["id"]);

function parseFieldValue(key, text) {
  const raw = String(text ?? "").trim();
  if (key.startsWith("link.")) return raw;
  if (!raw || raw === "—" || raw === "not present") {
    if (LIST_FIELDS.has(key) || INT_LIST_FIELDS.has(key) || FLOAT_LIST_FIELDS.has(key)) return [];
    if (key === "gps") return null;
    if (JSON_FIELDS.has(key)) return key === "ports" ? [] : {};
    if (key.startsWith("signal")) return null;
    return "";
  }
  if (LIST_FIELDS.has(key)) {
    return raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (INT_LIST_FIELDS.has(key)) {
    return raw.split(/[,;\n]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  }
  if (FLOAT_LIST_FIELDS.has(key)) {
    return raw.split(/[,;\n]+/).map((s) => parseFloat(s)).filter((n) => !Number.isNaN(n));
  }
  if (key.startsWith("signal") || key === "signal_dbm") {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? null : n;
  }
  if (key === "gps") {
    const m = raw.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(?:alt\s*)?(-?\d+(?:\.\d+)?))?/i);
    if (!m) return raw;
    return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), alt: m[3] != null ? parseFloat(m[3]) : null };
  }
  if (JSON_FIELDS.has(key) || key.startsWith("extra.") || key.startsWith("routing.")) {
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (key === "ports") {
      return raw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).map((display) => ({ display }));
    }
  }
  return raw;
}

function overlayNode(node) {
  if (!node) return node;
  const meta = getDeviceMeta(node.id);
  const fields = meta.fields || {};
  const extra = { ...((node.extra && typeof node.extra === "object" && !Array.isArray(node.extra) && node.extra) || {}) };
  const routing = { ...((node.routing && typeof node.routing === "object" && !Array.isArray(node.routing) && node.routing) || {}) };
  const out = { ...node, extra, routing };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("extra.")) extra[key.slice(6)] = value;
    else if (key.startsWith("routing.")) routing[key.slice(8)] = value;
    else out[key] = value;
  }
  if (out.extra && typeof out.extra === "string") {
    try {
      out.extra = JSON.parse(out.extra);
    } catch {
      out.extra = { ...extra, note: out.extra };
    }
  }
  if (!out.extra || typeof out.extra !== "object" || Array.isArray(out.extra)) out.extra = { ...extra };
  const name = (meta.name || "").trim();
  if (name) out.label = name;
  else if (out.inferred_type) out.label = out.inferred_type;
  const extraLabel = (meta.extra || "").trim();
  if (extraLabel) out.caption = extraLabel;
  const notes = (meta.notes || "").trim();
  if (notes) out.notes = notes;
  const edited = [];
  if (name) edited.push("label");
  if (extraLabel) edited.push("caption");
  if (notes) edited.push("notes");
  edited.push(...Object.keys(fields));
  if (edited.length) out.extra = { ...out.extra, user_edited_fields: [...new Set(edited)] };
  return out;
}

function inferredName(node) {
  const live = overlayNode(node);
  return live.inferred_type || live.label || "Host";
}

function displayName(node) {
  const meta = getDeviceMeta(node.id);
  const name = (meta.name || "").trim();
  return name || inferredName(node);
}

function nodeLabel(node) {
  const meta = getDeviceMeta(node.id);
  const name = displayName(node);
  const extra = (meta.extra || "").trim();
  return extra ? `${name}\n${extra}` : name;
}

function macRoleValue(addrs) {
  if (addrs && addrs.length) return addrs.join(", ");
  return "not present";
}

function graphWithUserFields() {
  const nodes = (state.graph?.nodes || []).map((n) => overlayNode(n));
  return { ...state.graph, title: state.title, nodes };
}

function refreshNodeLabel(node) {
  if (state.cy) {
    const cyNode = state.cy.getElementById(node.id);
    if (cyNode && cyNode.length) cyNode.data("label", nodeLabel(node));
  }
  if (activeDevice && activeDevice.id === node.id) {
    el("device-title").textContent = displayName(node);
  }
}

function edgeLabel(link) {
  const displays = [];
  for (const p of link.ports || []) {
    if (p.display && !displays.includes(p.display)) displays.push(p.display);
  }
  if (displays.length) return displays.slice(0, 2).join(", ");
  if (link.services && link.services.length) return link.services.slice(0, 2).join(", ");
  return link.label || link.kind;
}

function colorFor(node) {
  if (node.kind === "ap" || node.medium === "wireless") return "#fbbf24";
  if (node.kind === "gateway") return "#c4b5fd";
  if (node.kind === "server") return "#38bdf8";
  if (node.kind === "vlan") return "#a78bfa";
  if (node.kind === "subnet") return "#94a3b8";
  return "#5eead4";
}

function edgeColor(link) {
  if (link.kind === "bridge") return "#f472b6";
  if (link.kind === "wireless") return "#fbbf24";
  if (link.kind === "client-server") return "#38bdf8";
  if (link.kind === "l3") return "#86efac";
  if (link.kind === "vlan") return "#c4b5fd";
  if (link.kind === "subnet") return "#64748b";
  return "#5eead4";
}

function toElements(graph) {
  const nodes = graph.nodes.map((raw) => {
    const n = overlayNode(raw);
    return {
      data: {
        id: n.id,
        label: nodeLabel(n),
        kind: n.kind,
        medium: n.medium,
        color: colorFor(n),
        raw: n,
      },
    };
  });
  const edges = graph.links
    .filter((l) => state.filters[l.kind] !== false)
    .map((l) => ({
      data: {
        id: l.id,
        source: l.source,
        target: l.target,
        label: l.kind === "bridge" ? l.label || "Attachment" : edgeLabel(l),
        kind: l.kind,
        color: edgeColor(l),
        dashed: l.kind === "wireless" || l.kind === "l3" || l.kind === "vlan" || l.kind === "subnet" || l.kind === "bridge",
        raw: l,
      },
    }));
  return nodes.concat(edges);
}

function renderMap() {
  const container = el("map");
  if (state.cy) {
    state.cy.destroy();
    state.cy = null;
  }
  if (!state.graph) return;
  state.cy = cytoscape({
    container,
    elements: toElements(state.graph),
    minZoom: ZOOM_MIN,
    maxZoom: ZOOM_MAX,
    wheelSensitivity: 0.35,
    userZoomingEnabled: true,
    userPanningEnabled: true,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 140,
          "font-size": 11,
          color: "#e8eef8",
          "text-valign": "center",
          "background-color": "#0f172a",
          "border-width": 2,
          "border-color": "data(color)",
          width: 92,
          height: 42,
          shape: "roundrectangle",
        },
      },
      {
        selector: 'node[kind = "ap"]',
        style: { shape: "hexagon", width: 88, height: 56 },
      },
      {
        selector: 'node[kind = "subnet"], node[kind = "vlan"]',
        style: { "border-style": "dashed", opacity: 0.9 },
      },
      {
        selector: "edge",
        style: {
          label: "data(label)",
          "font-size": 8,
          color: "#cbd5e1",
          "text-rotation": "autorotate",
          "curve-style": "bezier",
          width: 2,
          "line-color": "data(color)",
          "target-arrow-color": "data(color)",
          "target-arrow-shape": "none",
          "line-style": "solid",
        },
      },
      {
        selector: "edge[dashed]",
        style: { "line-style": "dashed" },
      },
      {
        selector: 'edge[kind = "bridge"]',
        style: {
          width: 3.2,
          "line-style": "dashed",
          "line-dash-pattern": [2, 8],
          "source-arrow-shape": "diamond",
          "target-arrow-shape": "diamond",
          "source-arrow-color": "data(color)",
          "target-arrow-color": "data(color)",
        },
      },
      {
        selector: 'edge[kind = "client-server"]',
        style: { "target-arrow-shape": "triangle", width: 2.5 },
      },
      {
        selector: "node:selected",
        style: { "border-width": 4, "overlay-padding": 4, "overlay-opacity": 0.08, "overlay-color": "#5eead4" },
      },
    ],
    layout: { name: "cose", animate: false, padding: 24, nodeOverlap: 16, gravity: 0.4 },
    autoungrabify: true,
    boxSelectionEnabled: true,
    selectionType: "additive",
  });
  state.cy.on("tap", "node", (evt) => {
    if (!evt.originalEvent || !evt.originalEvent.shiftKey) {
      state.cy.$("node:selected").unselect();
      evt.target.select();
    }
    const node = evt.target.data("raw");
    inspect("node", node);
    if (!evt.originalEvent || !evt.originalEvent.shiftKey) openDeviceDialog(node);
  });
  state.cy.on("tap", "edge", (evt) => inspect("link", evt.target.data("raw")));
  state.cy.on("tap", (evt) => {
    if (evt.target === state.cy) {
      inspect(null, null);
      if (!evt.originalEvent || !evt.originalEvent.shiftKey) state.cy.$(":selected").unselect();
    }
  });
  state.cy.on("cxttap", (evt) => {
    evt.preventDefault();
    if (evt.target !== state.cy && evt.target.isNode && evt.target.isNode()) {
      evt.target.select();
      inspect("node", evt.target.data("raw"));
    }
    showCtxMenu(evt.originalEvent);
  });
  state.cy.on("zoom", syncZoomUi);
  syncZoomUi();
}

function chips(values) {
  if (!values || !values.length) return "";
  return `<div class="chips">${values.map((v) => `<span class="chip">${escapeHtml(String(v))}</span>`).join("")}</div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inspect(kind, obj) {
  const empty = el("inspector-empty");
  const body = el("inspector-body");
  if (!obj) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");
  if (kind === "node") {
    obj = overlayNode(obj);
    const portList = (obj.ports || []).map((p) => p.display || `${p.proto}/${p.port}`).filter(Boolean);
    let gps = "—";
    if (obj.gps && obj.gps.lat != null && obj.gps.lon != null) {
      gps = `${Number(obj.gps.lat).toFixed(5)}, ${Number(obj.gps.lon).toFixed(5)}`;
    }
    const edited = (obj.extra && obj.extra.user_edited_fields) || [];
    body.innerHTML = `
      <h2>${escapeHtml(displayName(obj))}</h2>
      <dl class="kv">
        <dt>Type</dt><dd>${escapeHtml(inferredName(obj))}</dd>
        <dt>Kind</dt><dd>${escapeHtml(obj.kind)} · ${escapeHtml(obj.medium)}</dd>
        <dt>Roles</dt><dd>${escapeHtml((obj.roles || []).join(", ") || "—")}</dd>
        <dt>TX MAC</dt><dd>${escapeHtml(macRoleValue(obj.mac_tx))}</dd>
        <dt>RX MAC</dt><dd>${escapeHtml(macRoleValue(obj.mac_rx))}</dd>
        <dt>DA MAC</dt><dd>${escapeHtml(macRoleValue(obj.mac_da))}</dd>
        <dt>RA MAC</dt><dd>${escapeHtml(macRoleValue(obj.mac_ra))}</dd>
        ${!(obj.mac_tx || []).length && !(obj.mac_rx || []).length && !(obj.mac_da || []).length && !(obj.mac_ra || []).length && (obj.macs || []).length ? `<dt>MAC</dt><dd>${escapeHtml(obj.macs.join(", "))}</dd>` : ""}
        <dt>IPs</dt><dd>${escapeHtml((obj.ips || []).join(", ") || "—")}</dd>
        <dt>OUI manufacturer</dt><dd>${escapeHtml(obj.vendor || "—")}</dd>
        <dt>SSID</dt><dd>${escapeHtml((obj.ssids || []).join(", ") || "—")}</dd>
        <dt>Channel</dt><dd>${escapeHtml((obj.channels || []).join(", ") || "—")}</dd>
        <dt>Freq</dt><dd>${escapeHtml((obj.frequencies_mhz || []).map((f) => f + " MHz").join(", ") || "—")}</dd>
        <dt>Signal</dt><dd>${obj.signal_dbm == null ? "—" : escapeHtml(obj.signal_dbm + " dBm")}</dd>
        <dt>Encrypt</dt><dd>${escapeHtml((obj.encryption || []).join(", ") || "—")}</dd>
        <dt>VLANs</dt><dd>${escapeHtml((obj.vlans || []).join(", ") || "—")}</dd>
        <dt>GPS</dt><dd>${escapeHtml(gps)}</dd>
        ${edited.length ? `<dt>Edits</dt><dd>User-edited: ${escapeHtml(edited.join(", "))}</dd>` : ""}
      </dl>
      <h2>Ports &amp; services</h2>
      ${chips(obj.services)}
      ${chips(portList)}
      ${obj.routing && Object.keys(obj.routing).length ? `<pre>${escapeHtml(JSON.stringify(obj.routing, null, 2))}</pre>` : ""}
    `;
  } else {
    const portList = (obj.ports || []).map((p) => {
      const bits = [p.display || ""];
      if (p.sport != null && p.dport != null) bits.push(`src ${p.sport} → dst ${p.dport}`);
      return bits.filter(Boolean).join(" · ");
    });
    const extra = obj.extra || {};
    body.innerHTML = `
      <h2>${escapeHtml(obj.label || obj.kind)}</h2>
      <dl class="kv">
        <dt>Kind</dt><dd>${escapeHtml(obj.kind)} · ${escapeHtml(obj.medium)}</dd>
        ${obj.kind === "bridge" ? `<dt>Link type</dt><dd>${escapeHtml(extra.bridge_kind || obj.label || "attachment")}</dd>` : ""}
        ${extra.vias && extra.vias.length ? `<dt>Via</dt><dd>${escapeHtml(extra.vias.join(", "))}</dd>` : ""}
        ${extra.networks && extra.networks.length ? `<dt>Networks</dt><dd>${escapeHtml(extra.networks.join(" · "))}</dd>` : ""}
        <dt>From</dt><dd>${escapeHtml(obj.source)}</dd>
        <dt>To</dt><dd>${escapeHtml(obj.target)}</dd>
        <dt>VLANs</dt><dd>${escapeHtml((obj.vlans || []).join(", ") || "—")}</dd>
      </dl>
      <h2>Ports &amp; services</h2>
      ${chips(obj.services)}
      ${chips(portList)}
    `;
  }
}

function setBusy(on) {
  show("loading", on);
  show("empty", !on && !state.graph);
  show("error", false);
}

async function parseResponse(res) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload.detail || payload.error || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

function emptyGraph(title) {
  return {
    nodes: [],
    links: [],
    meta: { sources: [], packet_count: 0, node_count: 0, link_count: 0, warnings: [] },
    title: title || "Blank map",
  };
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function getMap(id) {
  return state.maps.find((m) => m.id === id);
}

function ensureUnwanted() {
  if (!getMap(UNWANTED_ID)) {
    state.maps.unshift({
      id: UNWANTED_ID,
      name: "Unwanted",
      kind: "unwanted",
      sourceId: null,
      edited: false,
      graph: emptyGraph("Unwanted"),
    });
  }
}

function mapNodeCount(map) {
  return (map?.graph?.nodes || []).length;
}

function markMapEdited(mapId) {
  const map = getMap(mapId || state.activeMapId);
  if (map) map.edited = true;
}

function syncActiveMapGraph() {
  const map = getMap(state.activeMapId);
  if (map && state.graph) map.graph = cloneData(state.graph);
}

function persistMaps() {
  syncActiveMapGraph();
  saveLocal(MAPS_KEY, JSON.stringify({ maps: state.maps, activeMapId: state.activeMapId, clipboard: state.clipboard }));
}

function restoreMaps() {
  try {
    const raw = JSON.parse(localStorage.getItem(MAPS_KEY) || "null");
    if (!raw || !Array.isArray(raw.maps) || !raw.maps.length) return false;
    state.maps = raw.maps;
    state.activeMapId = raw.activeMapId || raw.maps[0].id;
    state.clipboard = raw.clipboard || null;
    ensureUnwanted();
    return true;
  } catch {
    return false;
  }
}

function upsertMap(partial) {
  ensureUnwanted();
  const existing = getMap(partial.id);
  if (existing) {
    const edited = existing.edited;
    const captures = existing.captures;
    Object.assign(existing, partial);
    if (partial.graph) existing.graph = cloneData(partial.graph);
    if (!("edited" in partial)) existing.edited = edited;
    if (!("captures" in partial)) existing.captures = captures;
    return existing;
  }
  const map = {
    id: partial.id,
    name: partial.name || "Map",
    kind: partial.kind || "blank",
    sourceId: partial.sourceId || null,
    captures: Array.isArray(partial.captures) ? [...partial.captures] : [],
    edited: Boolean(partial.edited),
    graph: cloneData(partial.graph || emptyGraph(partial.name)),
  };
  if (map.kind === "unwanted") state.maps.unshift(map);
  else state.maps.push(map);
  return map;
}

function showMap(mapId) {
  const map = getMap(mapId);
  if (!map) return;
  if (state.activeMapId && state.activeMapId !== map.id) {
    const prev = getMap(state.activeMapId);
    if (prev && state.graph) prev.graph = cloneData(state.graph);
  }
  state.activeMapId = map.id;
  closeDeviceDialog();
  inspect(null, null);
  paintGraph(cloneData(map.graph), map.name, map.id);
  persistMaps();
}

function renderMapList() {
  const list = el("map-list");
  if (!list) return;
  list.innerHTML = "";
  const ordered = [...state.maps].sort((a, b) => {
    if (a.kind === "unwanted") return -1;
    if (b.kind === "unwanted") return 1;
    return 0;
  });
  for (const map of ordered) {
    const row = document.createElement("li");
    row.className = `map-item${map.kind === "unwanted" ? " unwanted" : ""}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-load";
    if (map.id === state.activeMapId) btn.classList.add("active");
    const n = mapNodeCount(map);
    const kindLabel = map.kind === "unwanted" ? "Holding map" : map.kind === "blank" ? "Blank map" : "Survey map";
    btn.innerHTML = `${escapeHtml(map.name)}<small>${escapeHtml(kindLabel)} · ${n} devices</small>`;
    btn.addEventListener("click", () => showMap(map.id));
    const tools = document.createElement("div");
    tools.className = "map-tools";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "btn ghost map-tool";
    rename.textContent = "Rename";
    rename.setAttribute("aria-label", `Rename ${map.name}`);
    rename.addEventListener("click", (evt) => {
      evt.stopPropagation();
      renameMap(map.id);
    });
    tools.append(rename);
    if (map.kind === "unwanted") {
      const emptyBtn = document.createElement("button");
      emptyBtn.type = "button";
      emptyBtn.className = "btn ghost map-tool";
      emptyBtn.textContent = "Empty";
      emptyBtn.setAttribute("aria-label", "Empty Unwanted");
      emptyBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        emptyUnwanted();
      });
      tools.append(emptyBtn);
    } else {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn ghost map-tool danger";
      del.textContent = "Delete";
      del.setAttribute("aria-label", `Delete ${map.name}`);
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        deleteMap(map.id);
      });
      tools.append(del);
    }
    row.append(btn, tools);
    list.appendChild(row);
  }
  fillMergeSelect();
}

function fillMergeSelect() {
  const sel = el("merge-into");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Merge into…</option>';
  const active = getMap(state.activeMapId);
  const mergeAllowed = active && active.kind !== "unwanted";
  for (const map of state.maps) {
    if (map.kind === "unwanted") continue;
    if (map.id === state.activeMapId) continue;
    const opt = document.createElement("option");
    opt.value = map.id;
    opt.textContent = map.name;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  sel.disabled = !mergeAllowed || sel.options.length < 2;
  const mergeBtn = el("btn-merge");
  if (mergeBtn) mergeBtn.disabled = sel.disabled || !sel.value;
}

function renameMap(mapId) {
  const map = getMap(mapId);
  if (!map) return;
  const next = window.prompt("Map name", map.name);
  if (next == null) return;
  const name = next.trim();
  if (!name) {
    setEditToast("Map name cannot be empty.");
    return;
  }
  map.name = name;
  if (map.id === state.activeMapId) {
    state.title = name;
    if (state.graph) state.graph.title = name;
  }
  persistMaps();
  renderMapList();
  fillMoveToSelect();
  if (map.id === state.activeMapId) setStatus(`${name} · ${mapNodeCount(map)} nodes · ${(map.graph?.links || []).length} links`);
  setEditToast(`Renamed map to ${name}.`);
}

function deleteMap(mapId) {
  const map = getMap(mapId);
  if (!map) return;
  if (map.kind === "unwanted" || map.id === UNWANTED_ID) {
    setEditToast("Unwanted is the holding map and cannot be deleted. Empty it instead.");
    return;
  }
  if (!window.confirm(`Delete map “${map.name}”? Devices on it are not written to Unwanted/.`)) return;
  snapshotUndo("delete-map");
  state.maps = state.maps.filter((m) => m.id !== mapId);
  if (state.activeMapId === mapId) {
    const next = state.maps.find((m) => m.kind !== "unwanted") || getMap(UNWANTED_ID);
    if (next) showMap(next.id);
    else {
      ensureUnwanted();
      showMap(UNWANTED_ID);
    }
  } else {
    persistMaps();
    renderMapList();
    fillMoveToSelect();
  }
  setEditToast(`Deleted ${map.name}.`);
}

function mergeMaps(sourceId, destId) {
  const source = getMap(sourceId);
  const dest = getMap(destId);
  if (!source || !dest) return;
  if (source.kind === "unwanted" || dest.kind === "unwanted" || source.id === UNWANTED_ID || dest.id === UNWANTED_ID) {
    setEditToast("Unwanted cannot be a merge source or target.");
    return;
  }
  if (source.id === dest.id) {
    setEditToast("Pick a different map to merge into.");
    return;
  }
  snapshotUndo("merge");
  if (state.activeMapId === source.id && state.graph) source.graph = cloneData(state.graph);
  if (state.activeMapId === dest.id && state.graph) dest.graph = cloneData(state.graph);
  dest.graph = dest.graph || emptyGraph(dest.name);
  source.graph = source.graph || emptyGraph(source.name);
  const used = new Set((dest.graph.nodes || []).map((n) => n.id));
  const idMap = {};
  dest.graph.nodes = dest.graph.nodes || [];
  dest.graph.links = dest.graph.links || [];
  for (const node of source.graph.nodes || []) {
    const nextId = uniqueId(node.id, used);
    idMap[node.id] = nextId;
    used.add(nextId);
    const copy = stampOriginCapture(cloneData(node), source);
    copy.id = nextId;
    dest.graph.nodes.push(copy);
    transferMeta(source.id, dest.id, node.id, nextId);
  }
  const usedLinks = new Set((dest.graph.links || []).map((l) => l.id));
  for (const link of source.graph.links || []) {
    const src = idMap[link.source];
    const tgt = idMap[link.target];
    if (!src || !tgt) continue;
    const copy = cloneData(link);
    copy.source = src;
    copy.target = tgt;
    copy.id = uniqueId(link.id || `${src}-${tgt}`, usedLinks);
    usedLinks.add(copy.id);
    dest.graph.links.push(copy);
  }
  dest.edited = true;
  persistMaps();
  showMap(dest.id);
  setEditToast(`Merged ${source.name} into ${dest.name}.`);
}

function mergeActiveIntoSelected() {
  const destId = el("merge-into")?.value;
  if (!destId) {
    setEditToast("Choose a map to merge into.");
    return;
  }
  mergeMaps(state.activeMapId, destId);
}

async function emptyUnwanted() {
  ensureUnwanted();
  const map = getMap(UNWANTED_ID);
  if (!map) return;
  if (state.activeMapId === UNWANTED_ID && state.graph) map.graph = cloneData(state.graph);
  const graph = map.graph || emptyGraph("Unwanted");
  if (!(graph.nodes || []).length) {
    setEditToast("Unwanted is already empty.");
    return;
  }
  if (!window.confirm("Empty Unwanted? Devices are written to Unwanted/ in the NetSeer project, then cleared from this map.")) return;
  snapshotUndo("empty-unwanted");
  const groups = {};
  for (const node of graph.nodes || []) {
    const key = originCaptureForNode(node, map);
    if (!groups[key]) groups[key] = { capture: key, nodes: [], links: [], device_meta: {} };
    groups[key].nodes.push(stampOriginCapture(state.activeMapId === UNWANTED_ID ? overlayNode(node) : cloneData(node), map));
    groups[key].device_meta[node.id] = cloneData(allDeviceMeta()[`${UNWANTED_ID}::${node.id}`] || {});
  }
  for (const group of Object.values(groups)) {
    const ids = new Set(group.nodes.map((n) => n.id));
    group.links = (graph.links || []).filter((l) => ids.has(l.source) && ids.has(l.target));
  }
  try {
    const payload = await parseResponse(
      await fetch("/api/unwanted/dump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: Object.values(groups) }),
      })
    );
    const ids = (graph.nodes || []).map((n) => n.id);
    removeNodesFromGraph(graph, ids);
    for (const id of ids) dropMeta(UNWANTED_ID, id);
    map.graph = graph;
    map.edited = true;
    if (state.activeMapId === UNWANTED_ID) {
      paintGraph(cloneData(graph), map.name, map.id);
    }
    persistMaps();
    renderMapList();
    fillMoveToSelect();
    const names = (payload.files || []).join(", ");
    setEditToast(`Wrote ${names || "Unwanted dump"} and emptied Unwanted.`);
  } catch (err) {
    fail(err);
  }
}

function fillMoveToSelect() {
  const sel = el("device-move-to");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Choose map…</option>';
  for (const map of state.maps) {
    if (map.id === state.activeMapId) continue;
    const opt = document.createElement("option");
    opt.value = map.id;
    opt.textContent = map.name;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
}

function createBlankMap() {
  const n = state.maps.filter((m) => m.kind === "blank").length + 1;
  const map = upsertMap({
    id: `map:blank-${Date.now()}`,
    name: n === 1 ? "Blank map" : `Blank map ${n}`,
    kind: "blank",
    graph: emptyGraph("Blank map"),
  });
  showMap(map.id);
  setEditToast("Started a blank map. Paste devices or load a survey.");
}

function selectedIds() {
  if (state.cy) {
    const ids = state.cy.$("node:selected").map((n) => n.id());
    if (ids.length) return ids;
  }
  if (activeDevice) return [activeDevice.id];
  return [];
}

function snapshotUndo(label) {
  syncActiveMapGraph();
  state.undo = {
    label,
    maps: cloneData(state.maps),
    meta: cloneData(allDeviceMeta()),
    activeMapId: state.activeMapId,
    graph: cloneData(state.graph),
    title: state.title,
  };
  const undoBtn = el("btn-undo");
  if (undoBtn) undoBtn.disabled = false;
}

function undoLast() {
  if (!state.undo) return;
  const u = state.undo;
  state.undo = null;
  const undoBtn = el("btn-undo");
  if (undoBtn) undoBtn.disabled = true;
  state.maps = u.maps;
  saveLocal(META_KEY, JSON.stringify(u.meta || {}));
  state.activeMapId = u.activeMapId;
  closeDeviceDialog();
  paintGraph(u.graph, u.title, u.activeMapId);
  persistMaps();
  setEditToast("Undid last map edit.");
}

function setEditToast(msg) {
  const box = el("edit-toast");
  const text = el("edit-toast-msg");
  if (!box || !text) {
    setStatus(msg);
    return;
  }
  text.textContent = msg;
  el("edit-toast-undo")?.classList.toggle("hidden", !state.undo);
  box.classList.remove("hidden");
  clearTimeout(setEditToast.timer);
  setEditToast.timer = setTimeout(() => box.classList.add("hidden"), 5000);
}

function transferMeta(fromMap, toMap, fromId, toId) {
  const all = allDeviceMeta();
  const src = all[`${fromMap}::${fromId}`];
  if (!src) return;
  all[`${toMap}::${toId}`] = cloneData(src);
  saveLocal(META_KEY, JSON.stringify(all));
}

function dropMeta(mapId, nodeId) {
  const all = allDeviceMeta();
  delete all[`${mapId}::${nodeId}`];
  saveLocal(META_KEY, JSON.stringify(all));
}

function uniqueId(base, used) {
  if (!used.has(base)) return base;
  let i = 2;
  let next = `${base}~${i}`;
  while (used.has(next)) {
    i += 1;
    next = `${base}~${i}`;
  }
  return next;
}

function nodeById(id, graph = state.graph) {
  return (graph?.nodes || []).find((n) => n.id === id);
}

function nodeLooksLikeAp(node) {
  if (!node) return false;
  const n = overlayNode(node);
  const roles = n.roles || [];
  if (n.kind === "ap" || roles.includes("ap")) return true;
  const inferred = String(n.inferred_type || n.label || "").toLowerCase();
  return inferred === "access point";
}

function nodeLooksLikeWirelessClient(node) {
  if (!node || nodeLooksLikeAp(node)) return false;
  const n = overlayNode(node);
  const roles = n.roles || [];
  if (roles.includes("station")) return true;
  const inferred = String(n.inferred_type || n.label || "").toLowerCase();
  if (inferred === "wireless client") return true;
  return n.medium === "wireless" && !["vlan", "subnet"].includes(n.kind);
}

function wirelessAssocPeer(link, apId) {
  if (!link || link.kind !== "wireless") return null;
  const extra = link.extra || {};
  if (extra.associated === false) return null;
  if (link.source === apId) return link.target;
  if (link.target === apId) return link.source;
  return null;
}

function bridgeApPeer(link, apId, graph) {
  if (!link || link.kind !== "bridge") return null;
  let other = null;
  if (link.source === apId) other = link.target;
  else if (link.target === apId) other = link.source;
  else return null;
  return nodeLooksLikeAp(nodeById(other, graph)) ? other : null;
}

function expandSelectionForApNetwork(ids) {
  const graph = state.graph;
  if (!graph || !ids?.length) return [...(ids || [])];
  const out = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...out]) {
      if (!nodeLooksLikeAp(nodeById(id, graph))) continue;
      for (const link of graph.links || []) {
        const client = wirelessAssocPeer(link, id);
        if (client && nodeLooksLikeWirelessClient(nodeById(client, graph)) && !out.has(client)) {
          out.add(client);
          changed = true;
        }
        const ap = bridgeApPeer(link, id, graph);
        if (ap && !out.has(ap)) {
          out.add(ap);
          changed = true;
        }
      }
    }
  }
  return [...out];
}

function describeDevicePack(originalIds, expandedIds, verb) {
  const n = expandedIds.length;
  const orig = new Set(originalIds);
  const extras = expandedIds.filter((id) => !orig.has(id));
  const base = `${verb} ${n} device${n === 1 ? "" : "s"}`;
  if (!extras.length) return base;
  const aps = extras.filter((id) => nodeLooksLikeAp(nodeById(id))).length;
  const clients = extras.length - aps;
  const bits = [];
  if (clients) bits.push(`${clients} associated client${clients === 1 ? "" : "s"}`);
  if (aps) bits.push(`${aps} bridged AP${aps === 1 ? "" : "s"}`);
  return `${base} (AP and ${bits.join(" and ")})`;
}

function mapCaptures(map) {
  if (!map) return [];
  if (Array.isArray(map.captures) && map.captures.length) return map.captures;
  return map.graph?.meta?.sources || [];
}

function originCaptureForNode(node, map) {
  const extra = (node && node.extra) || {};
  if (extra.origin_capture) return extra.origin_capture;
  const captures = mapCaptures(map);
  if (captures.length === 1) return captures[0];
  const sourceId = map?.sourceId || "";
  if (String(sourceId).startsWith("upload:")) return sourceId.slice(7);
  if (sourceId) return String(sourceId).replace(/^map:/, "");
  if (captures[0]) return captures[0];
  return "unknown";
}

function stampOriginCapture(node, map) {
  const copy = cloneData(node);
  copy.extra = { ...(copy.extra && typeof copy.extra === "object" ? copy.extra : {}), origin_capture: originCaptureForNode(copy, map) };
  return copy;
}

function packSelection(ids, mode, originalIds) {
  const idSet = new Set(ids);
  const map = getMap(state.activeMapId);
  const nodes = (state.graph.nodes || [])
    .filter((n) => idSet.has(n.id))
    .map((n) => stampOriginCapture(overlayNode(n), map));
  const links = (state.graph.links || []).filter((l) => idSet.has(l.source) && idSet.has(l.target));
  const meta = {};
  for (const id of ids) meta[id] = cloneData(getDeviceMeta(id));
  const orig = new Set(originalIds || ids);
  const extra = ids.filter((id) => !orig.has(id)).length;
  return { mode, fromMap: state.activeMapId, nodes, links, meta, bundledClients: extra };
}

function removeNodesFromGraph(graph, ids) {
  const drop = new Set(ids);
  graph.nodes = (graph.nodes || []).filter((n) => !drop.has(n.id));
  graph.links = (graph.links || []).filter((l) => !drop.has(l.source) && !drop.has(l.target));
}

function copySelected() {
  const ids = selectedIds();
  if (!ids.length) {
    setEditToast("Select a device first.");
    return;
  }
  const expanded = expandSelectionForApNetwork(ids);
  state.clipboard = packSelection(expanded, "copy", ids);
  persistMaps();
  setEditToast(`${describeDevicePack(ids, expanded, "Copied")}. Switch maps, then Paste.`);
}

function cutSelected() {
  const ids = selectedIds();
  if (!ids.length) {
    setEditToast("Select a device first.");
    return;
  }
  const expanded = expandSelectionForApNetwork(ids);
  snapshotUndo("cut");
  state.clipboard = packSelection(expanded, "cut", ids);
  removeNodesFromGraph(state.graph, expanded);
  for (const id of expanded) dropMeta(state.activeMapId, id);
  markMapEdited();
  persistMaps();
  closeDeviceDialog();
  paintGraph(state.graph, state.title, state.activeMapId);
  setEditToast(`${describeDevicePack(ids, expanded, "Cut")}. Paste onto another map.`);
}

function pasteClipboard() {
  const clip = state.clipboard;
  if (!clip || !clip.nodes?.length) {
    setEditToast("Clipboard is empty.");
    return;
  }
  snapshotUndo("paste");
  if (!state.graph) state.graph = emptyGraph(state.title);
  const used = new Set((state.graph.nodes || []).map((n) => n.id));
  const idMap = {};
  for (const node of clip.nodes) {
    const nextId = uniqueId(node.id, used);
    idMap[node.id] = nextId;
    used.add(nextId);
    const copy = cloneData(node);
    copy.id = nextId;
    state.graph.nodes.push(copy);
    const meta = clip.meta?.[node.id];
    if (meta) {
      const all = allDeviceMeta();
      all[`${state.activeMapId}::${nextId}`] = cloneData(meta);
      saveLocal(META_KEY, JSON.stringify(all));
    }
  }
  const usedLinks = new Set((state.graph.links || []).map((l) => l.id));
  for (const link of clip.links || []) {
    const source = idMap[link.source];
    const target = idMap[link.target];
    if (!source || !target) continue;
    const copy = cloneData(link);
    copy.source = source;
    copy.target = target;
    copy.id = uniqueId(link.id, usedLinks);
    usedLinks.add(copy.id);
    state.graph.links.push(copy);
  }
  markMapEdited();
  persistMaps();
  paintGraph(state.graph, state.title, state.activeMapId);
  const destName = getMap(state.activeMapId)?.name || "this map";
  const n = clip.nodes.length;
  const extra = clip.bundledClients || 0;
  const msg = extra
    ? `Pasted ${n} devices onto ${destName} (AP network with clients and/or bridged APs).`
    : `Pasted ${n} device${n === 1 ? "" : "s"} onto ${destName}.`;
  setEditToast(msg);
}

function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length) {
    setEditToast("Select a device first.");
    return;
  }
  snapshotUndo("delete");
  removeNodesFromGraph(state.graph, ids);
  for (const id of ids) dropMeta(state.activeMapId, id);
  markMapEdited();
  persistMaps();
  closeDeviceDialog();
  paintGraph(state.graph, state.title, state.activeMapId);
  setEditToast(`Deleted ${ids.length} device${ids.length === 1 ? "" : "s"}. Undo if that was a mistake.`);
}

function moveSelectedTo(mapId) {
  const ids = selectedIds();
  if (!ids.length) {
    setEditToast("Select a device first.");
    return;
  }
  if (!mapId || mapId === state.activeMapId) {
    setEditToast("That device is already on this map.");
    return;
  }
  const dest = getMap(mapId);
  if (!dest) return;
  snapshotUndo("move");
  const expanded = expandSelectionForApNetwork(ids);
  const pack = packSelection(expanded, "move", ids);
  removeNodesFromGraph(state.graph, expanded);
  for (const id of expanded) dropMeta(state.activeMapId, id);
  dest.graph = dest.graph || emptyGraph(dest.name);
  const used = new Set((dest.graph.nodes || []).map((n) => n.id));
  const idMap = {};
  for (const node of pack.nodes) {
    const nextId = uniqueId(node.id, used);
    idMap[node.id] = nextId;
    used.add(nextId);
    const copy = cloneData(node);
    copy.id = nextId;
    dest.graph.nodes.push(copy);
    const meta = pack.meta?.[node.id];
    if (meta) {
      const all = allDeviceMeta();
      all[`${dest.id}::${nextId}`] = cloneData(meta);
      saveLocal(META_KEY, JSON.stringify(all));
    }
  }
  const usedLinks = new Set((dest.graph.links || []).map((l) => l.id));
  for (const link of pack.links || []) {
    const source = idMap[link.source];
    const target = idMap[link.target];
    if (!source || !target) continue;
    const copy = cloneData(link);
    copy.source = source;
    copy.target = target;
    copy.id = uniqueId(link.id, usedLinks);
    usedLinks.add(copy.id);
    dest.graph.links.push(copy);
  }
  markMapEdited();
  markMapEdited(dest.id);
  persistMaps();
  closeDeviceDialog();
  paintGraph(state.graph, state.title, state.activeMapId);
  setEditToast(`${describeDevicePack(ids, expanded, "Moved")} to ${dest.name}.`);
}

function moveSelectedToUnwanted() {
  ensureUnwanted();
  moveSelectedTo(UNWANTED_ID);
}

function hideCtxMenu() {
  el("ctx-menu")?.classList.add("hidden");
}

function showCtxMenu(orig) {
  const menu = el("ctx-menu");
  if (!menu || !orig) return;
  menu.classList.remove("hidden");
  const x = Math.min(orig.clientX, window.innerWidth - 180);
  const y = Math.min(orig.clientY, window.innerHeight - 220);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function applyGraph(graph, title, surveyId) {
  const id = surveyId || state.activeMapId || `map:${Date.now()}`;
  const captures = graph?.meta?.sources || [];
  upsertMap({
    id: id.startsWith("map:") || id === UNWANTED_ID ? id : `map:${id}`,
    name: title || "NetSeer map",
    kind: id === UNWANTED_ID || surveyId === UNWANTED_ID ? "unwanted" : "survey",
    sourceId: surveyId || null,
    captures,
    graph,
  });
  if (graph?.device_meta && typeof graph.device_meta === "object") {
    const mapId = id.startsWith("map:") || id === UNWANTED_ID ? id : `map:${id}`;
    const all = allDeviceMeta();
    for (const [nodeId, meta] of Object.entries(graph.device_meta)) {
      all[`${mapId}::${nodeId}`] = cloneData(meta);
    }
    saveLocal(META_KEY, JSON.stringify(all));
  }
  const dumped = graph?.meta?.device_meta;
  if (dumped && typeof dumped === "object") {
    const mapId = id.startsWith("map:") || id === UNWANTED_ID ? id : `map:${id}`;
    const all = allDeviceMeta();
    for (const [nodeId, meta] of Object.entries(dumped)) {
      all[`${mapId}::${nodeId}`] = cloneData(meta);
    }
    saveLocal(META_KEY, JSON.stringify(all));
  }
  showMap(id.startsWith("map:") || id === UNWANTED_ID ? id : `map:${id}`);
}

function paintGraph(graph, title, mapId) {
  state.graph = graph && graph.nodes ? graph : emptyGraph(title);
  state.title = title || state.title || "NetSeer map";
  if (mapId) {
    state.activeMapId = mapId;
    state.activeId = mapId;
  }
  const n = state.graph.nodes?.length || 0;
  const e = state.graph.links?.length || 0;
  const services = new Set();
  for (const node of state.graph.nodes || []) (node.services || []).forEach((s) => services.add(s));
  const mapName = (getMap(state.activeMapId) || {}).name || state.title;
  setStatus(`${mapName} · ${n} nodes · ${e} links · ${services.size} services`);
  ["btn-drawio", "btn-vsdx", "btn-vdx", "btn-report"].forEach((id) => {
    el(id).disabled = n === 0;
  });
  show("empty", n === 0);
  show("loading", false);
  show("error", false);
  if (n === 0) {
    if (state.cy) {
      state.cy.destroy();
      state.cy = null;
    }
    syncZoomUi();
  } else {
    renderMap();
  }
  renderSurveyList();
  renderMapList();
  fillMoveToSelect();
}

function clearMap() {
  if (state.cy) {
    state.cy.destroy();
    state.cy = null;
  }
  state.graph = null;
  state.title = "NetSeer map";
  state.activeId = null;
  ["btn-drawio", "btn-vsdx", "btn-vdx", "btn-report"].forEach((id) => {
    el(id).disabled = true;
  });
  inspect(null, null);
  closeDeviceDialog();
  show("empty", true);
  show("loading", false);
  show("error", false);
  setStatus("No survey loaded");
  syncZoomUi();
  renderSurveyList();
}

function fail(err) {
  show("loading", false);
  show("empty", !state.graph);
  show("error", true);
  el("error-msg").textContent = err.message || String(err);
  setStatus("Parse failed");
}

function hiddenSampleIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_SAMPLES_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveHiddenSampleIds(ids) {
  saveLocal(HIDDEN_SAMPLES_KEY, JSON.stringify(ids));
}

function sampleToSurvey(sample) {
  return {
    id: sample.id,
    kind: "sample",
    name: sample.name,
    summary: sample.summary,
  };
}

function renderSurveyList() {
  const list = el("sample-list");
  list.innerHTML = "";
  const hidden = hiddenSampleIds();
  el("survey-empty").classList.toggle("hidden", state.surveys.length > 0);
  el("btn-restore-samples").classList.toggle("hidden", hidden.length === 0);
  for (const item of state.surveys) {
    const row = document.createElement("li");
    row.className = "survey-item";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "survey-load";
    if (item.id === state.activeId || `map:${item.id}` === state.activeMapId) load.classList.add("active");
    load.dataset.id = item.id;
    const kicker = item.kind === "upload" ? "Uploaded capture" : item.summary;
    load.innerHTML = `${escapeHtml(item.name)}<small>${escapeHtml(kicker)}</small>`;
    load.addEventListener("click", () => selectSurvey(item.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn survey-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.addEventListener("click", (evt) => {
      evt.stopPropagation();
      removeSurvey(item.id);
    });
    row.append(load, remove);
    list.appendChild(row);
  }
}

async function selectSurvey(id) {
  const item = state.surveys.find((s) => s.id === id);
  if (!item) return;
  const mapId = `map:${item.id}`;
  const existing = getMap(mapId);
  if (existing && (mapNodeCount(existing) > 0 || existing.edited)) {
    showMap(mapId);
    return;
  }
  if (item.kind === "upload") {
    applyGraph(item.graph, item.name, item.id);
    return;
  }
  setBusy(true);
  try {
    const graph = await parseResponse(await fetch(`/api/samples/${item.id}/graph`));
    applyGraph(graph, item.name, item.id);
  } catch (err) {
    fail(err);
  }
}

function removeSurvey(id) {
  const item = state.surveys.find((s) => s.id === id);
  if (!item) return;
  const idx = state.surveys.findIndex((s) => s.id === id);
  state.surveys = state.surveys.filter((s) => s.id !== id);
  if (item.kind === "sample") {
    const hidden = hiddenSampleIds();
    if (!hidden.includes(item.id)) {
      hidden.push(item.id);
      saveHiddenSampleIds(hidden);
    }
  }
  if (state.activeMapId !== `map:${id}` && state.activeId !== id && state.activeId !== `map:${id}`) {
    renderSurveyList();
    return;
  }
  closeDeviceDialog();
  const next = state.surveys[idx] || state.surveys[idx - 1] || state.surveys[0];
  if (next) selectSurvey(next.id);
  else showMap(UNWANTED_ID);
}

function restoreBundledSamples() {
  saveHiddenSampleIds([]);
  const present = new Set(state.surveys.map((s) => s.id));
  for (const sample of state.catalog) {
    if (!present.has(sample.id)) state.surveys.push(sampleToSurvey(sample));
  }
  const uploads = state.surveys.filter((s) => s.kind === "upload");
  const samples = state.catalog
    .map((sample) => state.surveys.find((s) => s.id === sample.id))
    .filter(Boolean);
  state.surveys = [...uploads, ...samples];
  renderSurveyList();
  if (!state.activeId && state.surveys.length) {
    const campus = state.surveys.find((s) => s.id === "campus-all") || state.surveys[0];
    selectSurvey(campus.id);
  }
}

async function loadFile(file) {
  setBusy(true);
  const body = new FormData();
  body.append("file", file);
  try {
    const graph = await parseResponse(await fetch("/api/parse", { method: "POST", body }));
    const id = `upload:${file.name}`;
    const existing = state.surveys.findIndex((s) => s.id === id);
    const item = {
      id,
      kind: "upload",
      name: file.name,
      summary: "Uploaded capture",
      graph,
    };
    if (existing >= 0) state.surveys.splice(existing, 1, item);
    else state.surveys.unshift(item);
    applyGraph(graph, file.name, id);
  } catch (err) {
    fail(err);
  }
}

async function loadFiles(files) {
  for (const file of files) {
    if (file) await loadFile(file);
  }
}

function zoomPct() {
  if (!state.cy) return 100;
  return Math.round(state.cy.zoom() * 100);
}

function syncZoomUi() {
  const slider = el("zoom-slider");
  const label = el("zoom-pct");
  const fit = el("zoom-fit");
  if (!slider || !label) return;
  const on = Boolean(state.cy);
  slider.disabled = !on;
  if (fit) fit.disabled = !on;
  const pct = Math.min(400, Math.max(20, zoomPct()));
  if (document.activeElement !== slider) slider.value = String(pct);
  label.textContent = `${zoomPct()}%`;
}

function applyZoomPct(pct) {
  if (!state.cy) return;
  const level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(pct) / 100));
  const renderedPosition = { x: state.cy.width() / 2, y: state.cy.height() / 2 };
  state.cy.zoom({ level, renderedPosition });
  syncZoomUi();
}

async function exportKind(kind, filename) {
  if (!state.graph) return;
  const res = await fetch(`/api/export/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(graphWithUserFields()),
  });
  if (!res.ok) {
    fail(new Error("Export failed"));
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let activeDevice = null;

function showToast() {
  const toast = el("copy-toast");
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 1400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast();
}

function closeDeviceDialog() {
  el("device-modal").classList.add("hidden");
  activeDevice = null;
}

function stringifyEdit(key, value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "object") return JSON.stringify(value, null, 2);
    return value.join(", ");
  }
  if (typeof value === "object") {
    if ((key === "gps" || value.lat != null) && "lat" in value && "lon" in value) {
      return value.alt != null ? `${value.lat}, ${value.lon}, alt ${value.alt}` : `${value.lat}, ${value.lon}`;
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function isFieldEdited(nodeId, key) {
  const fields = getDeviceMeta(nodeId).fields || {};
  return Object.prototype.hasOwnProperty.call(fields, key);
}

function refreshActiveInspect() {
  if (!activeDevice) return;
  const live = overlayNode(activeDevice);
  inspect("node", live);
  fillLabelEditors(activeDevice);
  refreshNodeLabel(activeDevice);
}

function renderDeviceFields(rows, node) {
  const fields = el("device-fields");
  fields.innerHTML = "";
  for (const row of rows) {
    if (SKIP_DIALOG_KEYS.has(row.key)) continue;
    const wrap = document.createElement("div");
    const edited = isFieldEdited(node.id, row.key);
    const readonly = READONLY_KEYS.has(row.key) || String(row.key).startsWith("link.");
    wrap.className = `field-row${edited ? " edited" : ""}${readonly ? " readonly" : ""}`;
    const capture = row.value || "";
    const current = edited ? stringifyEdit(row.key, getDeviceMeta(node.id).fields[row.key]) : capture;
    const head = document.createElement("div");
    head.className = "field-head";
    const dt = document.createElement("dt");
    dt.textContent = row.name;
    const tag = document.createElement("span");
    tag.className = `origin-tag${edited ? " edited" : ""}`;
    tag.textContent = readonly ? "From map" : edited ? "Edited" : "Capture";
    head.append(dt, tag);
    wrap.appendChild(head);
    let control;
    const multiline =
      JSON_FIELDS.has(row.key) ||
      (current && current.length > 72) ||
      String(row.key).startsWith("extra.") ||
      String(row.key).startsWith("routing.");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn ghost reset-one";
    reset.textContent = "Reset";
    reset.disabled = readonly || !edited;
    if (readonly) {
      control = document.createElement("dd");
      control.textContent = current || "—";
    } else {
      control = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) control.type = "text";
      control.value = current === "—" ? "" : current;
      control.setAttribute("aria-label", row.name);
      control.addEventListener("input", () => {
        const parsed = parseFieldValue(row.key, control.value);
        setDeviceMeta(node.id, { fields: { [row.key]: parsed } });
        wrap.classList.add("edited");
        tag.textContent = "Edited";
        tag.classList.add("edited");
        reset.disabled = false;
        if (row.key === "inferred_type" && !(getDeviceMeta(node.id).name || "").trim()) {
          el("device-name").value = String(control.value || inferredName(node));
          el("device-inferred").textContent = String(control.value || "Host");
        }
        refreshActiveInspect();
        if (MAP_STYLE_KEYS.has(row.key) && state.graph) renderMap();
      });
    }
    wrap.appendChild(control);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn ghost copy-one";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      const value = control.tagName === "INPUT" || control.tagName === "TEXTAREA" ? control.value : control.textContent || "";
      copyText(value);
    });
    wrap.appendChild(copy);
    reset.addEventListener("click", () => {
      if (readonly) return;
      clearFieldOverride(node.id, row.key);
      control.value = capture === "—" ? "" : capture;
      wrap.classList.remove("edited");
      tag.textContent = "Capture";
      tag.classList.remove("edited");
      reset.disabled = true;
      refreshActiveInspect();
      if (MAP_STYLE_KEYS.has(row.key) && state.graph) renderMap();
    });
    wrap.appendChild(reset);
    fields.appendChild(wrap);
  }
}

async function openDeviceDialog(node) {
  if (!state.graph || !node) return;
  activeDevice = node;
  fillLabelEditors(node);
  el("device-fields").innerHTML = "<p class='hint'>Loading extracted properties…</p>";
  el("device-modal").classList.remove("hidden");
  try {
    const payload = await parseResponse(
      await fetch("/api/device/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...state.graph, title: state.title, node_id: node.id }),
      })
    );
    activeDevice = { ...node, properties: payload.properties, text: payload.properties };
    renderDeviceFields(payload.properties, node);
    fillMoveToSelect();
  } catch (err) {
    el("device-fields").innerHTML = `<p class="hint">${escapeHtml(err.message || String(err))}</p>`;
  }
}

function fillLabelEditors(node) {
  const meta = getDeviceMeta(node.id);
  el("device-title").textContent = displayName(node);
  el("device-name").value = displayName(node);
  el("device-extra").value = meta.extra || "";
  el("device-notes").value = meta.notes || "";
  el("device-inferred").textContent = inferredName(node);
}

function saveActiveMeta(patch) {
  if (!activeDevice) return;
  setDeviceMeta(activeDevice.id, patch);
  refreshNodeLabel(activeDevice);
}

function setAllLayers(on) {
  document.querySelectorAll("[data-filter]").forEach((box) => {
    box.checked = on;
    state.filters[box.dataset.filter] = on;
  });
  if (state.graph) renderMap();
}

async function exportDevice(fmt) {
  if (!state.graph || !activeDevice) return;
  const res = await fetch(`/api/export/device/${fmt}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...graphWithUserFields(), node_id: activeDevice.id }),
  });
  if (!res.ok) {
    fail(new Error("Device export failed"));
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stem = (displayName(activeDevice) || "device").replace(/[^A-Za-z0-9._-]+/g, "-");
  a.href = url;
  a.download = `${stem}-device.${fmt}`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyAllDevice() {
  if (!state.graph || !activeDevice) return;
  const res = await fetch("/api/export/device/txt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...graphWithUserFields(), node_id: activeDevice.id }),
  });
  if (!res.ok) {
    fail(new Error("Could not copy device details"));
    return;
  }
  await copyText(await res.text());
}

async function init() {
  const samples = await parseResponse(await fetch("/api/samples"));
  state.catalog = samples;
  const hidden = new Set(hiddenSampleIds());
  state.surveys = samples.filter((s) => !hidden.has(s.id)).map(sampleToSurvey);
  renderSurveyList();
  syncZoomUi();

  el("file").addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) loadFiles(files);
  });
  const drop = el("dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
    })
  );
  drop.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) loadFiles(files);
  });
  el("btn-restore-samples").addEventListener("click", restoreBundledSamples);
  el("btn-show-all").addEventListener("click", () => setAllLayers(true));
  el("btn-show-none").addEventListener("click", () => setAllLayers(false));
  el("device-name").addEventListener("input", (e) => saveActiveMeta({ name: e.target.value }));
  el("device-extra").addEventListener("input", (e) => saveActiveMeta({ extra: e.target.value }));
  el("device-notes").addEventListener("input", (e) => saveActiveMeta({ notes: e.target.value }));
  el("device-reset-name").addEventListener("click", () => {
    if (!activeDevice) return;
    saveActiveMeta({ name: "" });
    el("device-name").value = inferredName(activeDevice);
    refreshNodeLabel(activeDevice);
  });
  el("zoom-slider").addEventListener("input", (e) => applyZoomPct(e.target.value));
  el("zoom-fit").addEventListener("click", () => {
    if (!state.cy) return;
    state.cy.fit(undefined, 24);
    syncZoomUi();
  });

  document.querySelectorAll("[data-filter]").forEach((box) => {
    box.addEventListener("change", () => {
      state.filters[box.dataset.filter] = box.checked;
      if (state.graph) renderMap();
    });
  });
  el("btn-drawio").addEventListener("click", () => exportKind("drawio", "netseer-map.drawio"));
  el("btn-vsdx").addEventListener("click", () => exportKind("vsdx", "netseer-map.vsdx"));
  el("btn-vdx").addEventListener("click", () => exportKind("vdx", "netseer-map.vdx"));
  el("btn-report").addEventListener("click", () => exportKind("report.pdf", "netseer-map-report.pdf"));
  el("btn-dismiss").addEventListener("click", () => show("error", false));
  el("btn-menu").addEventListener("click", () => el("sidebar").classList.toggle("open"));
  el("device-close").addEventListener("click", closeDeviceDialog);
  el("device-modal").addEventListener("click", (e) => {
    if (e.target === el("device-modal")) closeDeviceDialog();
  });
  el("copy-all").addEventListener("click", copyAllDevice);
  document.querySelectorAll("[data-device-export]").forEach((btn) => {
    btn.addEventListener("click", () => exportDevice(btn.dataset.deviceExport));
  });
  const newMap = () => createBlankMap();
  el("btn-new-map")?.addEventListener("click", newMap);
  el("btn-blank-map")?.addEventListener("click", newMap);
  el("btn-merge")?.addEventListener("click", mergeActiveIntoSelected);
  el("merge-into")?.addEventListener("change", () => {
    const btn = el("btn-merge");
    if (btn) btn.disabled = !el("merge-into")?.value;
  });
  el("btn-cut")?.addEventListener("click", cutSelected);
  el("btn-copy-sel")?.addEventListener("click", copySelected);
  el("btn-paste")?.addEventListener("click", pasteClipboard);
  el("btn-delete-sel")?.addEventListener("click", deleteSelected);
  el("btn-to-unwanted")?.addEventListener("click", moveSelectedToUnwanted);
  el("btn-undo")?.addEventListener("click", undoLast);
  el("edit-toast-undo")?.addEventListener("click", undoLast);
  el("device-cut")?.addEventListener("click", cutSelected);
  el("device-copy")?.addEventListener("click", copySelected);
  el("device-unwanted")?.addEventListener("click", moveSelectedToUnwanted);
  el("device-delete")?.addEventListener("click", deleteSelected);
  el("device-move-to")?.addEventListener("change", (e) => {
    const dest = e.target.value;
    e.target.value = "";
    if (dest) moveSelectedTo(dest);
  });
  el("ctx-menu")?.querySelectorAll("[data-ctx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.ctx;
      hideCtxMenu();
      if (act === "cut") cutSelected();
      else if (act === "copy") copySelected();
      else if (act === "paste") pasteClipboard();
      else if (act === "unwanted") moveSelectedToUnwanted();
      else if (act === "delete") deleteSelected();
    });
  });
  document.addEventListener("click", () => hideCtxMenu());
  el("map")?.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDeviceDialog();
      hideCtxMenu();
      return;
    }
    if (isTypingTarget(e.target)) return;
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelected();
    } else if (cmd && e.key.toLowerCase() === "x") {
      e.preventDefault();
      cutSelected();
    } else if (cmd && e.key.toLowerCase() === "v") {
      e.preventDefault();
      pasteClipboard();
    } else if (cmd && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoLast();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    }
  });

  ensureUnwanted();
  const restored = restoreMaps();
  renderMapList();
  const active = getMap(state.activeMapId);
  const keepRestored =
    restored &&
    active &&
    (active.kind !== "survey" || mapNodeCount(active) > 0 || active.edited);
  if (keepRestored) {
    showMap(state.activeMapId);
    return;
  }
  const first =
    state.surveys.find((s) => s.id === "campus-all") || state.surveys[0];
  if (first) await selectSurvey(first.id);
  else showMap(UNWANTED_ID);
}

init().catch((err) => fail(err));
