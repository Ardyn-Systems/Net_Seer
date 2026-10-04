/* NetSeer preview — maps, surveys, layout, inspector, and exports. */
"use strict";

const UNWANTED_ID = "map:unwanted";
const ZOOM_MIN = 0.12;
const ZOOM_MAX = 4;
const UNDO_LIMIT = 30;
const THEME_KEY = "netseer.theme";
const PREFS_KEY = "netseer.prefs.v1";
const HIDDEN_SAMPLES_KEY = "netseer.hiddenSamples";
const LEGACY_MAPS_KEY = "netseer.maps.v2";
const LEGACY_META_KEY = "netseer.deviceMeta.v1";
const NARROW = window.matchMedia("(max-width: 1180px)");

const THEMES = [
  { id: "terrain", name: "Terrain", note: "Warm topographic", swatch: ["#15140f", "#e0a84a", "#9cc27a", "#7fb6c9"] },
  { id: "midnight", name: "Midnight", note: "Low-glare navy", swatch: ["#0b1220", "#2dd4bf", "#fbbf24", "#38bdf8"] },
  { id: "daylight", name: "Daylight", note: "Light, good for printing", swatch: ["#f4f5f7", "#2563eb", "#0d9488", "#d97706"] },
  { id: "blueprint", name: "Blueprint", note: "Engineering grid", swatch: ["#0f2a4a", "#ffffff", "#ffd479", "#8fd3ff"] },
];

const LAYERS = [
  { kind: "l2", name: "Wired (L2)", color: "--edge-l2", line: "solid" },
  { kind: "l3", name: "IP traffic (L3)", color: "--edge-l3", line: "dashed" },
  { kind: "client-server", name: "Ports and services", color: "--edge-service", line: "solid" },
  { kind: "wireless", name: "Wireless", color: "--edge-wireless", line: "dashed" },
  { kind: "vlan", name: "VLAN membership", color: "--edge-vlan", line: "dashed" },
  { kind: "subnet", name: "Subnet membership", color: "--edge-subnet", line: "dashed" },
  { kind: "bridge", name: "Bridges and attachments", color: "--edge-bridge", line: "dotted" },
];

const state = {
  graph: null,
  title: "NetSeer map",
  cy: null,
  catalog: [],
  surveys: [],
  maps: [],
  activeMapId: null,
  clipboard: null,
  undo: [],
  filters: Object.fromEntries(LAYERS.map((l) => [l.kind, true])),
  groupBySubnet: true,
  selection: [],
  inspectedLink: null,
  nodeIndex: new Map(),
  graphVersion: 0,
  propsCache: new Map(),
  suppressSelect: false,
};

/* ---------- Small helpers ---------- */

const el = (id) => document.getElementById(id);
const show = (id, on) => el(id)?.classList.toggle("hidden", !on);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const cloneData = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeFileStem(name) {
  return String(name || "netseer").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "netseer";
}

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* Preferences are a convenience; losing them is harmless. */
  }
}

/* ---------- Toast ---------- */

function toast(msg, { undo = false, error = false, timeout } = {}) {
  const box = el("toast");
  el("toast-msg").textContent = msg;
  el("toast-undo").classList.toggle("hidden", !(undo && state.undo.length));
  box.classList.toggle("error", error);
  box.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add("hidden"), timeout ?? (error ? 8000 : 4500));
}

function fail(err) {
  show("loading", false);
  updateEmptyState();
  toast(err?.message || String(err), { error: true });
}

async function parseResponse(res) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload.detail || payload.error || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

async function copyText(text, label = "Copied") {
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
  toast(label, { timeout: 1600 });
}

/* ---------- Theme ---------- */

function currentTheme() {
  const id = document.documentElement.dataset.theme;
  return THEMES.some((t) => t.id === id) ? id : "terrain";
}

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    canvas: v("--canvas"),
    nodeFill: v("--node-fill"),
    nodeText: v("--node-text"),
    edgeText: v("--edge-text"),
    muted: v("--muted"),
    host: v("--node-host"),
    server: v("--node-server"),
    gateway: v("--node-gateway"),
    ap: v("--node-ap"),
    wireless: v("--node-wireless"),
    subnet: v("--node-subnet"),
    vlan: v("--node-vlan"),
    groupFill: v("--group-fill"),
    l2: v("--edge-l2"),
    l3: v("--edge-l3"),
    service: v("--edge-service"),
    wirelessEdge: v("--edge-wireless"),
    vlanEdge: v("--edge-vlan"),
    subnetEdge: v("--edge-subnet"),
    bridge: v("--edge-bridge"),
    select: v("--select"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  writeLocal(THEME_KEY, theme.id);
  if (state.cy) state.cy.style(cyStyle(themeColors()));
}

function openThemeMenu(anchor) {
  const active = currentTheme();
  openMenu(
    anchor,
    [
      { heading: "Theme" },
      ...THEMES.map((t) => ({
        theme: t,
        checked: t.id === active,
        onSelect: () => {
          applyTheme(t.id);
          toast(`${t.name} theme`, { timeout: 1500 });
        },
      })),
    ],
    { align: "right" }
  );
}

/* ---------- Floating menus ---------- */

let openMenuState = null;

function closeMenu() {
  if (!openMenuState) return;
  openMenuState.menu.remove();
  openMenuState.anchor?.setAttribute("aria-expanded", "false");
  const anchor = openMenuState.anchor;
  openMenuState = null;
  return anchor;
}

function buildMenu(items) {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.style.position = "fixed";
  for (const item of items) {
    if (item === "sep") {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    if (item.heading) {
      const head = document.createElement("div");
      head.className = "menu-label";
      head.textContent = item.heading;
      menu.appendChild(head);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", item.checked != null ? "menuitemradio" : "menuitem");
    if (item.danger) btn.classList.add("danger");
    if (item.disabled) btn.disabled = true;
    if (item.theme) {
      btn.classList.add("theme-option");
      btn.setAttribute("aria-checked", String(Boolean(item.checked)));
      btn.innerHTML = `<span class="theme-swatch">${item.theme.swatch.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
        <span class="theme-name">${escapeHtml(item.theme.name)}<small>${escapeHtml(item.theme.note)}</small></span>
        <svg class="icon check"><path d="m5 12 5 5 9-10"/></svg>`;
    } else {
      btn.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}${
        item.kbd ? `<kbd>${escapeHtml(item.kbd)}</kbd>` : ""
      }`;
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      item.onSelect?.();
    });
    menu.appendChild(btn);
  }
  menu.addEventListener("keydown", (e) => {
    const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    }
  });
  return menu;
}

function placeMenu(menu, x, y, { alignRight = false, anchorTop = null } = {}) {
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = alignRight ? x - w : x;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = y;
  if (top + h > window.innerHeight - 8) top = anchorTop != null ? anchorTop - h - 6 : window.innerHeight - h - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function openMenu(anchor, items, { align = "left" } = {}) {
  const reopening = openMenuState?.anchor === anchor;
  closeMenu();
  if (reopening) return;
  const menu = buildMenu(items);
  const r = anchor.getBoundingClientRect();
  placeMenu(menu, align === "right" ? r.right : r.left, r.bottom + 6, { alignRight: align === "right", anchorTop: r.top });
  anchor.setAttribute("aria-expanded", "true");
  openMenuState = { menu, anchor };
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function openMenuAt(x, y, items) {
  closeMenu();
  const menu = buildMenu(items);
  placeMenu(menu, x, y);
  openMenuState = { menu, anchor: null };
}

/* ---------- Dialogs ---------- */

function openDialog({ title, body = "", input = null, select = null, okLabel = "OK", danger = false, validate = null }) {
  const dialog = el("dialog");
  const field = el("dialog-field");
  const error = el("dialog-error");
  el("dialog-title").textContent = title;
  el("dialog-body").textContent = body;
  field.innerHTML = "";
  error.classList.add("hidden");
  let control = null;
  if (input) {
    control = document.createElement("input");
    control.type = "text";
    control.value = input.value || "";
    control.placeholder = input.placeholder || "";
    control.setAttribute("aria-label", input.label || title);
  } else if (select) {
    control = document.createElement("select");
    control.setAttribute("aria-label", select.label || title);
    for (const opt of select.options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      control.appendChild(o);
    }
  }
  if (control) {
    control.addEventListener("input", () => error.classList.add("hidden"));
    field.appendChild(control);
  }
  const ok = el("dialog-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger-fill", danger);
  return new Promise((resolve) => {
    const finish = (value) => {
      el("dialog-form").removeEventListener("submit", onSubmit);
      el("dialog-cancel").removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const value = control ? control.value : true;
      const problem = validate?.(value);
      if (problem) {
        error.textContent = problem;
        error.classList.remove("hidden");
        control?.focus();
        return;
      }
      finish(value);
    };
    const onCancel = (e) => {
      e?.preventDefault();
      finish(null);
    };
    el("dialog-form").addEventListener("submit", onSubmit);
    el("dialog-cancel").addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    if (control) {
      control.focus();
      control.select?.();
    } else ok.focus();
  });
}

/* ---------- Storage (IndexedDB) ---------- */
// Maps can be tens of MB, far past localStorage's ~5 MB. Only maps that changed are
// written, batched a moment after the last edit.

const store = { db: null, available: true, warned: false, dirtyMaps: new Set(), deletedMaps: new Set(), meta: false, session: false, timer: null };
let metaCache = {};

function openDb() {
  if (store.db) return Promise.resolve(store.db);
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const req = indexedDB.open("netseer", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("maps")) db.createObjectStore("maps", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => {
      store.db = req.result;
      resolve(store.db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Storage is blocked by another NetSeer tab"));
  });
}

async function idbTx(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const out = fn(tx);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage write aborted"));
  });
}

function storageWarning(err) {
  if (store.warned) return;
  store.warned = true;
  console.warn("NetSeer storage:", err);
  toast("Your browser won't let NetSeer save maps, so changes will be lost when you close this tab.", { error: true, timeout: 10000 });
}

function markMapDirty(id) {
  if (!id) return;
  store.dirtyMaps.add(id);
  scheduleSave();
}
function markMetaDirty() {
  store.meta = true;
  scheduleSave();
}
function markSessionDirty() {
  store.session = true;
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(store.timer);
  store.timer = setTimeout(flushSave, 300);
}

function serializeMap(map) {
  return {
    id: map.id,
    name: map.name,
    kind: map.kind,
    sourceId: map.sourceId || null,
    captures: map.captures || [],
    edited: Boolean(map.edited),
    graph: map.graph,
    positions: map.positions || {},
  };
}

async function flushSave() {
  clearTimeout(store.timer);
  if (!store.available) return;
  const dirty = [...store.dirtyMaps];
  const deleted = [...store.deletedMaps];
  const meta = store.meta;
  const session = store.session;
  if (!dirty.length && !deleted.length && !meta && !session) return;
  store.dirtyMaps.clear();
  store.deletedMaps.clear();
  store.meta = false;
  store.session = false;
  try {
    await idbTx(["maps", "kv"], "readwrite", (tx) => {
      const maps = tx.objectStore("maps");
      for (const id of dirty) {
        const map = getMap(id);
        if (map) maps.put(serializeMap(map));
      }
      for (const id of deleted) if (!getMap(id)) maps.delete(id);
      const kv = tx.objectStore("kv");
      if (meta) kv.put(metaCache, "deviceMeta");
      if (session || dirty.length || deleted.length) {
        kv.put({ activeMapId: state.activeMapId, clipboard: state.clipboard, order: state.maps.map((m) => m.id) }, "session");
      }
    });
  } catch (err) {
    dirty.forEach((id) => store.dirtyMaps.add(id));
    deleted.forEach((id) => store.deletedMaps.add(id));
    store.meta ||= meta;
    store.session ||= session;
    storageWarning(err);
  }
}

async function loadStore() {
  let maps = [];
  let meta = null;
  let session = null;
  try {
    const reqs = await idbTx(["maps", "kv"], "readonly", (tx) => [
      tx.objectStore("maps").getAll(),
      tx.objectStore("kv").get("deviceMeta"),
      tx.objectStore("kv").get("session"),
    ]);
    [maps, meta, session] = reqs.map((r) => r.result);
  } catch (err) {
    store.available = false;
    storageWarning(err);
  }
  if (!maps?.length) {
    // One-time move from the old localStorage format.
    const legacy = readLocal(LEGACY_MAPS_KEY, null);
    if (legacy && Array.isArray(legacy.maps) && legacy.maps.length) {
      maps = legacy.maps;
      session = { activeMapId: legacy.activeMapId, clipboard: legacy.clipboard, order: legacy.maps.map((m) => m.id) };
      meta = readLocal(LEGACY_META_KEY, {});
      state.maps = maps.map(normalizeMap);
      metaCache = meta && typeof meta === "object" ? meta : {};
      state.maps.forEach((m) => store.dirtyMaps.add(m.id));
      store.meta = true;
      store.session = true;
      state.activeMapId = session.activeMapId;
      state.clipboard = session.clipboard || null;
      await flushSave();
      if (store.available && !store.dirtyMaps.size) {
        try {
          localStorage.removeItem(LEGACY_MAPS_KEY);
          localStorage.removeItem(LEGACY_META_KEY);
        } catch {
          /* ignore */
        }
      }
      return;
    }
  }
  const order = session?.order || [];
  state.maps = (maps || []).map(normalizeMap).sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  metaCache = meta && typeof meta === "object" ? meta : {};
  state.activeMapId = session?.activeMapId || null;
  state.clipboard = session?.clipboard || null;
}

function normalizeMap(m) {
  return {
    id: m.id,
    name: m.name || "Map",
    kind: m.kind || "blank",
    sourceId: m.sourceId || null,
    captures: Array.isArray(m.captures) ? m.captures : [],
    edited: Boolean(m.edited),
    graph: m.graph && Array.isArray(m.graph.nodes) ? m.graph : emptyGraph(m.name),
    positions: m.positions && typeof m.positions === "object" ? m.positions : {},
  };
}

/* ---------- Device metadata (names, captions, notes, field edits) ---------- */

const EMPTY_META = Object.freeze({});
const metaKey = (mapId, nodeId) => `${mapId}::${nodeId}`;

function getDeviceMeta(nodeId, mapId = state.activeMapId) {
  const direct = metaCache[metaKey(mapId, nodeId)];
  if (direct) return direct;
  const map = getMap(mapId);
  if (map?.sourceId) return metaCache[metaKey(map.sourceId, nodeId)] || EMPTY_META;
  return EMPTY_META;
}

function setDeviceMeta(nodeId, patch, mapId = state.activeMapId) {
  const key = metaKey(mapId, nodeId);
  const prev = metaCache[key] || {};
  const next = { ...prev, ...patch };
  if (patch.fields && prev.fields) next.fields = { ...prev.fields, ...patch.fields };
  metaCache[key] = next;
  markMetaDirty();
}

function clearFieldOverride(nodeId, fieldKey) {
  const key = metaKey(state.activeMapId, nodeId);
  const prev = metaCache[key] || {};
  const fields = { ...(prev.fields || {}) };
  delete fields[fieldKey];
  metaCache[key] = { ...prev, fields };
  markMetaDirty();
}

function transferMeta(fromMap, toMap, fromId, toId) {
  const src = metaCache[metaKey(fromMap, fromId)];
  if (!src) return;
  metaCache[metaKey(toMap, toId)] = cloneData(src);
  markMetaDirty();
}

function dropMeta(mapId, nodeId) {
  if (metaCache[metaKey(mapId, nodeId)]) {
    delete metaCache[metaKey(mapId, nodeId)];
    markMetaDirty();
  }
}

function metaSnapshot(mapIds) {
  const prefixes = mapIds.map((id) => `${id}::`);
  const out = {};
  for (const [k, v] of Object.entries(metaCache)) if (prefixes.some((p) => k.startsWith(p))) out[k] = cloneData(v);
  return out;
}

function restoreMetaSnapshot(mapIds, snapshot) {
  const prefixes = mapIds.map((id) => `${id}::`);
  for (const k of Object.keys(metaCache)) if (prefixes.some((p) => k.startsWith(p))) delete metaCache[k];
  Object.assign(metaCache, cloneData(snapshot));
  markMetaDirty();
}

/* ---------- Field parsing and overlays ---------- */

const LIST_FIELDS = new Set(["mac_tx", "mac_rx", "mac_da", "mac_ra", "macs", "ips", "ssids", "encryption", "roles", "services"]);
const INT_LIST_FIELDS = new Set(["vlans", "channels"]);
const FLOAT_LIST_FIELDS = new Set(["frequencies_mhz"]);
const JSON_FIELDS = new Set(["routing", "extra", "ports", "gps"]);
const MAP_STYLE_KEYS = new Set(["kind", "medium", "inferred_type", "roles"]);
const SKIP_FIELD_KEYS = new Set(["label", "caption", "notes"]);
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
  if (LIST_FIELDS.has(key)) return raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (INT_LIST_FIELDS.has(key)) return raw.split(/[,;\n]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  if (FLOAT_LIST_FIELDS.has(key)) return raw.split(/[,;\n]+/).map((s) => parseFloat(s)).filter((n) => !Number.isNaN(n));
  if (key.startsWith("signal")) {
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
    if (key === "ports") return raw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).map((display) => ({ display }));
  }
  return raw;
}

function stringifyEdit(key, value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "object") return JSON.stringify(value, null, 2);
    return value.join(", ");
  }
  if (typeof value === "object") {
    if ("lat" in value && "lon" in value) return value.alt != null ? `${value.lat}, ${value.lon}, alt ${value.alt}` : `${value.lat}, ${value.lon}`;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

function overlayNode(node) {
  if (!node) return node;
  const meta = getDeviceMeta(node.id);
  const fields = meta.fields || {};
  const extra = { ...(isPlainObject(node.extra) ? node.extra : {}) };
  const routing = { ...(isPlainObject(node.routing) ? node.routing : {}) };
  const out = { ...node, extra, routing };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("extra.")) extra[key.slice(6)] = value;
    else if (key.startsWith("routing.")) routing[key.slice(8)] = value;
    else out[key] = value;
  }
  if (typeof out.extra === "string") {
    try {
      out.extra = JSON.parse(out.extra);
    } catch {
      out.extra = { ...extra, note: out.extra };
    }
  }
  if (!isPlainObject(out.extra)) out.extra = { ...extra };
  const name = (meta.name || "").trim();
  if (name) out.label = name;
  else if (out.inferred_type) out.label = out.inferred_type;
  const caption = (meta.extra || "").trim();
  if (caption) out.caption = caption;
  const notes = (meta.notes || "").trim();
  if (notes) out.notes = notes;
  const edited = [];
  if (name) edited.push("label");
  if (caption) edited.push("caption");
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
  const name = (getDeviceMeta(node.id).name || "").trim();
  return name || inferredName(node);
}

function nodeLabel(node) {
  const caption = (getDeviceMeta(node.id).extra || "").trim();
  const name = displayName(node);
  return caption ? `${name}\n${caption}` : name;
}

function nodeRole(n) {
  const roles = n.roles || [];
  const type = String(n.inferred_type || "").toLowerCase();
  if (n.kind === "subnet") return "subnet";
  if (n.kind === "vlan") return "vlan";
  if (n.kind === "ap" || roles.includes("ap") || type === "access point") return "ap";
  if (n.kind === "gateway" || type === "router" || type === "gateway") return "gateway";
  if (n.kind === "server" || type === "server") return "server";
  if (roles.includes("station") || type === "wireless client" || n.medium === "wireless") return "wireless";
  return "host";
}

function edgeLabel(link) {
  if (link.kind === "bridge") return link.label || "Attachment";
  const displays = [];
  for (const p of link.ports || []) if (p.display && !displays.includes(p.display)) displays.push(p.display);
  if (displays.length) return displays.slice(0, 2).join(", ") + (displays.length > 2 ? ` +${displays.length - 2}` : "");
  if (link.services?.length) return link.services.slice(0, 2).join(", ");
  if (link.kind === "subnet" || link.kind === "vlan" || link.kind === "l2") return "";
  return link.label || "";
}

/* ---------- Maps and graphs ---------- */

function emptyGraph(title) {
  return { nodes: [], links: [], meta: { sources: [], packet_count: 0, node_count: 0, link_count: 0, warnings: [] }, title: title || "Blank map" };
}

const getMap = (id) => state.maps.find((m) => m.id === id);
const mapNodeCount = (map) => (map?.graph?.nodes || []).filter((n) => n.kind !== "subnet" && n.kind !== "vlan").length;

function ensureUnwanted() {
  if (getMap(UNWANTED_ID)) return;
  state.maps.push({ id: UNWANTED_ID, name: "Unwanted", kind: "unwanted", sourceId: null, captures: [], edited: false, graph: emptyGraph("Unwanted"), positions: {} });
  markMapDirty(UNWANTED_ID);
}

function markMapEdited(mapId = state.activeMapId) {
  const map = getMap(mapId);
  if (!map) return;
  map.edited = true;
  markMapDirty(mapId);
}

function indexGraph() {
  state.nodeIndex = new Map((state.graph?.nodes || []).map((n) => [n.id, n]));
  state.graphVersion += 1;
  state.propsCache.clear();
}

function nodeById(id, graph = state.graph) {
  if (graph === state.graph) return state.nodeIndex.get(id);
  return (graph?.nodes || []).find((n) => n.id === id);
}

function uniqueId(base, used) {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}~${i}`)) i += 1;
  return `${base}~${i}`;
}

function upsertMap(partial) {
  ensureUnwanted();
  const existing = getMap(partial.id);
  if (existing) {
    for (const key of ["name", "kind", "sourceId"]) if (key in partial) existing[key] = partial[key];
    if (partial.captures) existing.captures = [...partial.captures];
    if (partial.graph) {
      existing.graph = cloneData(partial.graph);
      existing.positions = {};
    }
    markMapDirty(existing.id);
    return existing;
  }
  const map = normalizeMap({ ...partial, graph: cloneData(partial.graph || emptyGraph(partial.name)) });
  const unwantedIdx = state.maps.findIndex((m) => m.id === UNWANTED_ID);
  if (unwantedIdx >= 0) state.maps.splice(unwantedIdx, 0, map);
  else state.maps.push(map);
  markMapDirty(map.id);
  return map;
}

/* ---------- Undo ---------- */
// Each entry holds only the maps an action touched, not the whole session.

function snapshotUndo(label, mapIds) {
  const ids = [...new Set(mapIds.filter(Boolean))];
  state.undo.push({
    label,
    activeMapId: state.activeMapId,
    order: state.maps.map((m) => m.id),
    maps: ids.map((id) => [id, getMap(id) ? cloneData(serializeMap(getMap(id))) : null]),
    meta: metaSnapshot(ids),
    clipboard: cloneData(state.clipboard),
  });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  syncUndoUi();
}

function undoLast() {
  const entry = state.undo.pop();
  syncUndoUi();
  if (!entry) {
    toast("Nothing to undo.", { timeout: 1800 });
    return;
  }
  const ids = entry.maps.map(([id]) => id);
  for (const [id, snap] of entry.maps) {
    const existing = getMap(id);
    if (snap) {
      if (existing) Object.assign(existing, normalizeMap(snap));
      else state.maps.push(normalizeMap(snap));
    } else if (existing) {
      state.maps = state.maps.filter((m) => m.id !== id);
      store.deletedMaps.add(id);
    }
    markMapDirty(id);
  }
  state.maps.sort((a, b) => {
    const ia = entry.order.indexOf(a.id);
    const ib = entry.order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  restoreMetaSnapshot(ids, entry.meta);
  state.clipboard = entry.clipboard;
  markSessionDirty();
  const target = getMap(entry.activeMapId) ? entry.activeMapId : state.maps[0]?.id;
  showMap(target, { fit: target !== state.activeMapId });
  toast(`Undid ${entry.label}.`, { timeout: 2500 });
}

function syncUndoUi() {
  const btn = el("btn-undo");
  const last = state.undo[state.undo.length - 1];
  btn.disabled = !last;
  btn.title = last ? `Undo ${last.label} (Ctrl+Z)` : "Nothing to undo";
}

/* ---------- Layout ---------- */
// Deterministic: subnets become boxes, access points sit in the middle of their
// clients, and groups are packed in rows instead of one long line.

const CELL_W = 150;
const CELL_H = 92;
const CLUSTER_GAP = 70;

function typeRank(n) {
  const role = nodeRole(n);
  return { gateway: 0, server: 1, ap: 2, host: 3, wireless: 4, vlan: 5, subnet: 6 }[role] ?? 3;
}

function subnetOrder(a, b) {
  const av6 = String(a.label).includes(":");
  const bv6 = String(b.label).includes(":");
  if (av6 !== bv6) return av6 ? 1 : -1;
  return String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
}

function packRows(blocks, maxWidth, gap) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > maxWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    b.x = x;
    b.y = y;
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
    width = Math.max(width, x - gap);
  }
  return { w: width, h: y + rowH };
}

function apBlock(apId, clients) {
  const k = clients.length;
  if (k <= 3) {
    // A few clients read best in a row under their access point.
    const w = k * CELL_W;
    const items = [[apId, w / 2, CELL_H / 2]];
    clients.forEach((id, i) => items.push([id, i * CELL_W + CELL_W / 2, CELL_H * 1.6]));
    return { items, w, h: CELL_H * 2.1 };
  }
  if (k <= 12) {
    const r = Math.max(110, (k * 118) / (2 * Math.PI));
    const cx = r + CELL_W / 2;
    const cy = r + CELL_H / 2;
    const items = [[apId, cx, cy]];
    clients.forEach((id, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / k;
      items.push([id, cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    });
    return { items, w: 2 * r + CELL_W, h: 2 * r + CELL_H };
  }
  const cols = Math.ceil(Math.sqrt(k));
  const rows = Math.ceil(k / cols);
  const items = [[apId, (cols * CELL_W) / 2, CELL_H / 2]];
  clients.forEach((id, i) => items.push([id, (i % cols) * CELL_W + CELL_W / 2, CELL_H * 1.5 + Math.floor(i / cols) * CELL_H + CELL_H / 2]));
  return { items, w: cols * CELL_W, h: CELL_H * 1.5 + rows * CELL_H };
}

function computeLayout(graph, grouped) {
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const subnets = nodes.filter((n) => n.kind === "subnet").sort(subnetOrder);
  const subnetIds = new Set(subnets.map((s) => s.id));
  const subnetRank = new Map(subnets.map((s, i) => [s.id, i]));
  const isDevice = (n) => n && n.kind !== "subnet" && n.kind !== "vlan";
  const parents = new Map();

  if (grouped) {
    const choose = (dev, sub) => {
      const cur = parents.get(dev);
      if (cur === undefined || subnetRank.get(sub) < subnetRank.get(cur)) parents.set(dev, sub);
    };
    for (const l of links) {
      if (l.kind !== "subnet") continue;
      if (subnetIds.has(l.target) && isDevice(byId.get(l.source))) choose(l.source, l.target);
      else if (subnetIds.has(l.source) && isDevice(byId.get(l.target))) choose(l.target, l.source);
    }
    for (const s of subnets) for (const m of s.extra?.members || []) if (isDevice(byId.get(m)) && !parents.has(m)) choose(m, s.id);
  }

  const isAp = (n) => nodeRole(overlayNode(n)) === "ap";
  const apClients = new Map();
  const clientOf = new Map();
  for (const l of links) {
    if (l.kind !== "wireless") continue;
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!isDevice(a) || !isDevice(b)) continue;
    let ap = null;
    let cl = null;
    if (isAp(a) && !isAp(b)) [ap, cl] = [a, b];
    else if (isAp(b) && !isAp(a)) [ap, cl] = [b, a];
    if (!ap || clientOf.has(cl.id)) continue;
    clientOf.set(cl.id, ap.id);
    if (!apClients.has(ap.id)) apClients.set(ap.id, []);
    apClients.get(ap.id).push(cl.id);
  }
  if (grouped) for (const [c, ap] of clientOf) if (!parents.has(c) && parents.has(ap)) parents.set(c, parents.get(ap));

  const clusters = new Map();
  const add = (key, id) => {
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(id);
  };
  const parentIds = new Set(parents.values());
  for (const n of nodes) {
    if (parentIds.has(n.id)) continue;
    if (parents.has(n.id)) add(parents.get(n.id), n.id);
    else if (!isDevice(n)) add("~networks", n.id);
    else if (isAp(n)) add(`~ap:${n.id}`, n.id);
    else if (clientOf.has(n.id) && !parents.has(clientOf.get(n.id))) add(`~ap:${clientOf.get(n.id)}`, n.id);
    else add("~loose", n.id);
  }

  const label = (id) => String(byId.get(id)?.inferred_type || byId.get(id)?.label || id);
  const packed = [];
  for (const [key, members] of clusters) {
    const inCluster = new Set(members);
    const sorted = [...members].sort((a, b) => typeRank(byId.get(a)) - typeRank(byId.get(b)) || label(a).localeCompare(label(b)) || a.localeCompare(b));
    const used = new Set();
    const blocks = [];
    for (const id of sorted) {
      if (used.has(id)) continue;
      used.add(id);
      const kids = isAp(byId.get(id)) ? (apClients.get(id) || []).filter((c) => inCluster.has(c) && !used.has(c)) : [];
      kids.forEach((c) => used.add(c));
      blocks.push(kids.length ? apBlock(id, kids) : { items: [[id, CELL_W / 2, CELL_H / 2]], w: CELL_W, h: CELL_H });
    }
    const area = blocks.reduce((s, b) => s + b.w * b.h, 0);
    const maxW = Math.max(CELL_W * 3, ...blocks.map((b) => b.w), Math.sqrt(area) * 1.35);
    const size = packRows(blocks, maxW, 0);
    const order = parents.size && subnetRank.has(key) ? subnetRank.get(key) : key === "~loose" ? 1e6 : key === "~networks" ? 2e6 : 5e5;
    packed.push({ key, blocks, w: size.w, h: size.h, order });
  }
  packed.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  // Match the window's shape so the fitted map isn't a thin strip.
  const box = el("map").getBoundingClientRect();
  const aspect = box.width > 0 && box.height > 0 ? Math.min(3, Math.max(0.8, box.width / box.height)) : 1.5;
  const total = packed.reduce((s, c) => s + (c.w + CLUSTER_GAP) * (c.h + CLUSTER_GAP), 0);
  packRows(packed, Math.max(...packed.map((c) => c.w), Math.sqrt(total * aspect)), CLUSTER_GAP);

  const positions = new Map();
  for (const c of packed) for (const b of c.blocks) for (const [id, dx, dy] of b.items) positions.set(id, { x: c.x + b.x + dx, y: c.y + b.y + dy });
  return { positions, parents };
}

/* ---------- Map rendering ---------- */

function cyStyle(c) {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-wrap": "wrap",
        "text-max-width": 124,
        "font-size": 11,
        "font-family": c.font,
        color: c.nodeText,
        "text-valign": "center",
        "text-halign": "center",
        "background-color": c.nodeFill,
        "border-width": 2,
        "border-color": c.host,
        width: 116,
        height: 44,
        shape: "round-rectangle",
        "min-zoomed-font-size": 6,
        "transition-property": "opacity",
        "transition-duration": "120ms",
      },
    },
    { selector: 'node[role = "ap"]', style: { shape: "hexagon", width: 112, height: 56, "border-color": c.ap, "border-width": 2.5 } },
    { selector: 'node[role = "gateway"]', style: { "border-color": c.gateway, "border-width": 3, shape: "cut-rectangle" } },
    { selector: 'node[role = "server"]', style: { "border-color": c.server } },
    { selector: 'node[role = "wireless"]', style: { "border-color": c.wireless, shape: "round-rectangle" } },
    { selector: 'node[role = "vlan"]', style: { "border-color": c.vlan, "border-style": "dashed", shape: "tag" } },
    { selector: 'node[role = "subnet"]', style: { "border-color": c.subnet, "border-style": "dashed" } },
    {
      selector: ":parent",
      style: {
        "background-color": c.groupFill,
        "background-opacity": 0.07,
        "border-width": 1.5,
        "border-style": "dashed",
        "border-color": c.subnet,
        shape: "round-rectangle",
        padding: 26,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -8,
        "font-size": 13,
        "font-weight": 600,
        color: c.muted,
        "min-zoomed-font-size": 5,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.6,
        "curve-style": "bezier",
        "line-color": c.l2,
        "target-arrow-shape": "none",
        "arrow-scale": 0.9,
        label: "data(label)",
        "font-size": 9,
        "font-family": c.font,
        color: c.edgeText,
        "text-rotation": "autorotate",
        "text-background-color": c.canvas,
        "text-background-opacity": 0.85,
        "text-background-padding": 2,
        "min-zoomed-font-size": 8,
        opacity: 0.9,
        "transition-property": "opacity",
        "transition-duration": "120ms",
      },
    },
    { selector: 'edge[kind = "l3"]', style: { "line-color": c.l3, "line-style": "dashed", "line-dash-pattern": [6, 4] } },
    { selector: 'edge[kind = "client-server"]', style: { "line-color": c.service, "target-arrow-shape": "triangle", "target-arrow-color": c.service, width: 2 } },
    { selector: 'edge[kind = "wireless"]', style: { "line-color": c.wirelessEdge, "line-style": "dashed", "line-dash-pattern": [3, 4] } },
    { selector: 'edge[kind = "vlan"]', style: { "line-color": c.vlanEdge, "line-style": "dashed", width: 1.2 } },
    { selector: 'edge[kind = "subnet"]', style: { "line-color": c.subnetEdge, "line-style": "dashed", width: 1 } },
    {
      selector: 'edge[kind = "bridge"]',
      style: {
        "line-color": c.bridge,
        width: 3,
        "line-style": "dashed",
        "line-dash-pattern": [2, 7],
        "source-arrow-shape": "diamond",
        "target-arrow-shape": "diamond",
        "source-arrow-color": c.bridge,
        "target-arrow-color": c.bridge,
      },
    },
    { selector: "node:selected", style: { "border-color": c.select, "border-width": 3.5, "underlay-color": c.select, "underlay-opacity": 0.22, "underlay-padding": 6 } },
    { selector: ":parent:selected", style: { "border-color": c.select, "background-opacity": 0.12 } },
    { selector: "edge:selected", style: { width: 3, "line-color": c.select, "target-arrow-color": c.select, "source-arrow-color": c.select, opacity: 1 } },
    { selector: ".faded", style: { opacity: 0.16 } },
  ];
}

function toElements(graph) {
  const { positions, parents } = computeLayout(graph, state.groupBySubnet);
  const saved = getMap(state.activeMapId)?.positions || {};
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const nodes = graph.nodes.map((raw) => {
    const n = overlayNode(raw);
    const data = { id: n.id, label: nodeLabel(raw), kind: n.kind, role: nodeRole(n) };
    if (parents.has(n.id)) data.parent = parents.get(n.id);
    return { data, position: { ...(saved[n.id] || positions.get(n.id) || { x: 0, y: 0 }) } };
  });
  const edges = graph.links
    .filter((l) => state.filters[l.kind] !== false && !(state.groupBySubnet && l.kind === "subnet"))
    .filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target))
    .map((l) => ({ data: { id: l.id, source: l.source, target: l.target, label: edgeLabel(l), kind: l.kind } }));
  return nodes.concat(edges);
}

function renderMap({ fit = true } = {}) {
  const viewport = !fit && state.cy ? { zoom: state.cy.zoom(), pan: { ...state.cy.pan() } } : null;
  if (state.cy) {
    state.cy.destroy();
    state.cy = null;
  }
  if (!state.graph?.nodes?.length) {
    syncZoomUi();
    return;
  }
  state.cy = cytoscape({
    container: el("map"),
    elements: toElements(state.graph),
    style: cyStyle(themeColors()),
    layout: { name: "preset", fit: false },
    minZoom: ZOOM_MIN,
    maxZoom: ZOOM_MAX,
    boxSelectionEnabled: true,
    selectionType: "additive",
  });
  const cy = state.cy;
  if (viewport) {
    cy.zoom(viewport.zoom);
    cy.pan(viewport.pan);
  } else if (cy.width() && cy.height()) fitMap(false);
  else state.pendingFit = true;

  state.suppressSelect = true;
  const keep = state.selection.filter((id) => cy.getElementById(id).length);
  keep.forEach((id) => cy.getElementById(id).select());
  state.selection = keep;
  state.suppressSelect = false;

  cy.on("tap", "node, edge", (evt) => {
    const multi = evt.originalEvent && (evt.originalEvent.shiftKey || evt.originalEvent.ctrlKey || evt.originalEvent.metaKey);
    if (!multi) cy.elements(":selected").not(evt.target).unselect();
    if (evt.target.isEdge()) {
      state.inspectedLink = evt.target.id();
      evt.target.select();
      renderInspector();
    } else state.inspectedLink = null;
  });
  cy.on("tap", (evt) => {
    if (evt.target !== cy) return;
    state.inspectedLink = null;
    cy.elements(":selected").unselect();
    renderInspector();
  });
  cy.on("select unselect", "node", () => {
    if (state.suppressSelect) return;
    cancelAnimationFrame(renderMap.selRaf);
    renderMap.selRaf = requestAnimationFrame(syncSelectionFromCy);
  });
  cy.on("cxttap", (evt) => {
    const t = evt.target;
    if (t !== cy && t.isNode()) {
      if (!t.selected()) {
        cy.elements(":selected").unselect();
        t.select();
      }
    }
    const e = evt.originalEvent;
    if (e) showContextMenu(e.clientX, e.clientY, t !== cy && t.isNode());
  });
  cy.on("mouseover", "node", (evt) => {
    const n = evt.target;
    if (n.isParent() || cy.nodes(":grabbed").length) return;
    const keepEls = n.closedNeighborhood().union(n.ancestors());
    cy.elements().not(keepEls).not(":parent").addClass("faded");
  });
  cy.on("mouseout", "node", () => cy.elements(".faded").removeClass("faded"));
  cy.on("grab", "node", () => cy.elements(".faded").removeClass("faded"));
  cy.on("dragfree", "node", (evt) => {
    const map = getMap(state.activeMapId);
    if (!map) return;
    map.positions = map.positions || {};
    const moved = evt.target.isParent() ? evt.target.descendants() : evt.target;
    moved.forEach((n) => {
      if (!n.isParent()) map.positions[n.id()] = { ...n.position() };
    });
    markMapDirty(map.id);
  });
  cy.on("zoom", syncZoomUi);
  syncZoomUi();
}

// The map can be created while its pane has no size (hidden tab, narrow layout
// toggling). Re-measure whenever the container changes, and fit once it is real.
const mapResize = new ResizeObserver(() => {
  const cy = state.cy;
  if (!cy) return;
  cy.resize();
  if (state.pendingFit && cy.width() && cy.height()) {
    state.pendingFit = false;
    fitMap(false);
  }
});

function fitMap(animate = true) {
  const cy = state.cy;
  if (!cy) return;
  const done = () => {
    if (cy.zoom() > 1.25) {
      cy.zoom(1.25);
      cy.center();
    }
    syncZoomUi();
  };
  if (animate) cy.animate({ fit: { eles: cy.elements(), padding: 60 } }, { duration: 220, complete: done });
  else {
    cy.fit(undefined, 60);
    done();
  }
}

function syncSelectionFromCy() {
  if (!state.cy) return;
  state.selection = state.cy.nodes(":selected").map((n) => n.id());
  if (state.selection.length) state.inspectedLink = null;
  syncSelectionUi();
  renderInspector();
}

function selectNodes(ids, { center = false } = {}) {
  const cy = state.cy;
  if (!cy) return;
  state.suppressSelect = true;
  cy.elements(":selected").unselect();
  const els = cy.collection(ids.map((id) => cy.getElementById(id)).filter((e) => e.length));
  els.select();
  state.suppressSelect = false;
  if (center && els.length) cy.animate({ center: { eles: els }, zoom: Math.max(cy.zoom(), 1) }, { duration: 260 });
  syncSelectionFromCy();
}

function syncZoomUi() {
  const pct = state.cy ? Math.round(state.cy.zoom() * 100) : 100;
  el("zoom-pct").textContent = `${pct}%`;
  ["zoom-in", "zoom-out", "zoom-fit", "btn-relayout"].forEach((id) => (el(id).disabled = !state.cy));
}

function zoomBy(factor) {
  const cy = state.cy;
  if (!cy) return;
  const level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cy.zoom() * factor));
  cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 140 });
}

function refreshNodeLabel(node) {
  const cyNode = state.cy?.getElementById(node.id);
  if (cyNode?.length) cyNode.data("label", nodeLabel(node));
}

/* ---------- Painting the active map ---------- */

function showMap(mapId, { fit = true } = {}) {
  const map = getMap(mapId);
  if (!map) return;
  if (map.id !== state.activeMapId) {
    state.selection = [];
    state.inspectedLink = null;
  }
  state.activeMapId = map.id;
  state.graph = map.graph;
  state.title = map.name;
  markSessionDirty();
  refreshAll({ fit });
}

function refreshAll({ fit = false } = {}) {
  closeMenu();
  indexGraph();
  updateHeader();
  updateEmptyState();
  renderMap({ fit });
  syncSelectionUi();
  renderInspector();
  renderMapList();
  renderSurveyList();
  syncPasteUi();
  syncUndoUi();
}

function updateHeader() {
  const map = getMap(state.activeMapId);
  el("map-title-name").textContent = map?.name || "NetSeer";
  el("map-title-kind").textContent = map ? mapKindLabel(map) : "";
  document.title = map ? `${map.name} · NetSeer` : "NetSeer — Turn traffic into terrain.";
  const g = state.graph;
  const devices = mapNodeCount(map);
  const links = g?.links?.length || 0;
  const services = new Set();
  for (const n of g?.nodes || []) (n.services || []).forEach((s) => services.add(s));
  const warnings = g?.meta?.warnings?.length ? ` · ${plural(g.meta.warnings.length, "warning")}` : "";
  el("status").textContent = devices ? `${plural(devices, "device")} · ${plural(links, "link")} · ${plural(services.size, "service")}${warnings}` : "Empty map";
  if (g?.meta?.warnings?.length) el("status").title = g.meta.warnings.join("\n");
  else el("status").removeAttribute("title");
  el("btn-export").disabled = !g?.nodes?.length;
}

function mapKindLabel(map) {
  return map.kind === "unwanted" ? "Holding area" : map.kind === "blank" ? "Blank map" : "Survey";
}

function updateEmptyState() {
  const map = getMap(state.activeMapId);
  const empty = !state.graph?.nodes?.length;
  const loading = !el("loading").classList.contains("hidden");
  show("empty", empty && !loading);
  if (!empty) return;
  const firstRun = !state.maps.some((m) => m.kind !== "unwanted" && m.graph?.nodes?.length);
  if (map?.kind === "unwanted") {
    el("empty-title").textContent = "Nothing set aside";
    el("empty-body").textContent = "Devices you set aside from other maps land here. Select devices and choose Set aside, then empty Unwanted to save them as files.";
  } else if (map?.kind === "blank") {
    el("empty-title").textContent = "This map is blank";
    el("empty-body").textContent = "Copy devices from another map and paste them here, or open a survey to start a new map.";
  } else if (firstRun) {
    el("empty-title").textContent = "Map your network";
    el("empty-body").textContent = "Drop a Wireshark, tcpdump, Kismet, or airodump capture anywhere on this page, or explore the bundled campus survey.";
  } else {
    el("empty-title").textContent = "No devices on this map";
    el("empty-body").textContent = "Open another survey, or paste devices from a different map.";
  }
  el("empty-sample").classList.toggle("hidden", map?.kind === "unwanted" || !state.catalog.length);
}

/* ---------- Inspector ---------- */

function factRow(name, value, { mono = false } = {}) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "";
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return `<dt>${escapeHtml(name)}</dt><dd class="copyable${mono ? " mono" : ""}" data-copy="${escapeHtml(text)}" title="Click to copy">${escapeHtml(text)}</dd>`;
}

function chips(values) {
  if (!values?.length) return "";
  return `<div class="chips">${values.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join("")}</div>`;
}

function roleColorVar(role) {
  return { ap: "--node-ap", gateway: "--node-gateway", server: "--node-server", wireless: "--node-wireless", vlan: "--node-vlan", subnet: "--node-subnet" }[role] || "--node-host";
}

function renderInspector() {
  const body = el("inspector-body");
  const empty = el("inspector-empty");
  const link = state.inspectedLink ? (state.graph?.links || []).find((l) => l.id === state.inspectedLink) : null;
  let html = "";
  if (link) html = linkPanel(link);
  else if (state.selection.length === 1 && nodeById(state.selection[0])) html = devicePanel(nodeById(state.selection[0]));
  else if (state.selection.length > 1) html = multiPanel(state.selection);
  const has = Boolean(html);
  empty.classList.toggle("hidden", has);
  body.classList.toggle("hidden", !has);
  el("inspector").classList.toggle("open", has && NARROW.matches);
  body.innerHTML = has
    ? `<button type="button" class="icon-btn insp-close" aria-label="Close details"><svg class="icon"><use href="#i-x"/></svg></button>${html}`
    : "";
  if (!has) return;
  body.querySelector(".insp-close").addEventListener("click", () => {
    state.inspectedLink = null;
    state.cy?.elements(":selected").unselect();
    el("inspector").classList.remove("open");
  });
  body.querySelectorAll("[data-copy]").forEach((dd) => dd.addEventListener("click", () => copyText(dd.dataset.copy)));
  if (link) return;
  if (state.selection.length === 1) bindDevicePanel(nodeById(state.selection[0]));
  body.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", (e) => runAction(btn.dataset.act, e.currentTarget)));
}

function devicePanel(raw) {
  const n = overlayNode(raw);
  const meta = getDeviceMeta(raw.id);
  const role = nodeRole(n);
  const edited = (n.extra?.user_edited_fields || []).length > 0;
  const badges = [...new Set([...(n.roles || [])])].map((r) => `<span class="badge">${escapeHtml(r)}</span>`).join("");
  const signal =
    n.signal_dbm == null
      ? ""
      : `${n.signal_dbm} dBm${n.signal_min_dbm != null && n.signal_max_dbm != null && n.signal_min_dbm !== n.signal_max_dbm ? ` (${n.signal_min_dbm} to ${n.signal_max_dbm})` : ""}`;
  const gps = n.gps && n.gps.lat != null ? `${Number(n.gps.lat).toFixed(5)}, ${Number(n.gps.lon).toFixed(5)}` : "";
  const hasRoleMacs = ["mac_tx", "mac_rx", "mac_da", "mac_ra"].some((k) => (n[k] || []).length);
  const members = n.kind === "subnet" || n.kind === "vlan" ? (n.extra?.members || []).length : null;
  const ports = (n.ports || []).filter((p) => p.display && (p.role === "listen" || p.role === "dest")).map((p) => p.display);
  const routing = Object.entries(n.routing || {}).map(([k, v]) => factRow(k.replace(/_/g, " "), typeof v === "object" ? stringifyEdit(k, v) : v)).join("");
  return `
    <div class="insp-head">
      <span class="insp-icon${role === "ap" ? " hex" : ""}" style="--c: var(${roleColorVar(role)})"></span>
      <div class="insp-title">
        <h2 id="insp-name">${escapeHtml(displayName(raw))}</h2>
        <p>${escapeHtml(inferredName(raw))} · ${escapeHtml(n.medium || "wired")}${n.vendor ? ` · ${escapeHtml(String(n.vendor).split(",")[0])}` : ""}</p>
        <div class="badges">${badges}${edited ? '<span class="badge accent">Edited</span>' : ""}</div>
      </div>
    </div>
    <div class="insp-section">
      <label class="field-label"><span class="with-action">Name on map${
        (meta.name || "").trim() ? '<button type="button" class="link-btn" id="name-reset">Use auto name</button>' : ""
      }</span>
        <input type="text" id="insp-name-input" value="${escapeHtml(meta.name || "")}" placeholder="${escapeHtml(inferredName(raw))}" autocomplete="off" />
      </label>
      <label class="field-label">Caption under the name
        <input type="text" id="insp-caption" value="${escapeHtml(meta.extra || "")}" placeholder="Lobby, rack A1, 2nd floor" autocomplete="off" />
      </label>
    </div>
    <div class="insp-section">
      <h3>Identity</h3>
      <dl class="facts">
        ${factRow("IP", n.ips, { mono: true })}
        ${hasRoleMacs ? "" : factRow("MAC", n.macs, { mono: true })}
        ${factRow("TX MAC", n.mac_tx, { mono: true })}
        ${factRow("RX MAC", n.mac_rx, { mono: true })}
        ${factRow("DA MAC", n.mac_da, { mono: true })}
        ${factRow("RA MAC", n.mac_ra, { mono: true })}
        ${factRow("Maker", n.vendor)}
        ${factRow("VLANs", n.vlans)}
        ${members != null ? factRow("Members", plural(members, "device")) : ""}
      </dl>
    </div>
    ${
      n.ssids?.length || n.channels?.length || signal || n.encryption?.length || gps
        ? `<div class="insp-section"><h3>Radio</h3><dl class="facts">
        ${factRow("SSID", n.ssids)}
        ${factRow("Channel", n.channels)}
        ${factRow("Frequency", (n.frequencies_mhz || []).map((f) => `${f} MHz`))}
        ${factRow("Signal", signal)}
        ${factRow("Security", n.encryption)}
        ${factRow("GPS", gps, { mono: true })}
      </dl></div>`
        : ""
    }
    ${n.services?.length || ports.length ? `<div class="insp-section"><h3>Services</h3>${chips([...new Set([...ports, ...(n.services || []).filter((s) => !ports.some((p) => p.startsWith(s)))])])}</div>` : ""}
    ${routing ? `<div class="insp-section"><h3>Routing</h3><dl class="facts">${routing}</dl></div>` : ""}
    <div class="insp-section">
      <label class="field-label">Notes
        <textarea id="insp-notes" rows="3" placeholder="Inventory tag, site notes, anything worth keeping">${escapeHtml(meta.notes || "")}</textarea>
      </label>
    </div>
    <div class="insp-section insp-actions">
      <button type="button" class="btn small" data-act="copy-details">Copy details</button>
      <button type="button" class="btn small" data-act="device-export" aria-haspopup="menu">Export<svg class="icon chev"><use href="#i-chevron"/></svg></button>
      <button type="button" class="btn small" data-act="move" aria-haspopup="menu">Move to<svg class="icon chev"><use href="#i-chevron"/></svg></button>
      <button type="button" class="btn small" data-act="unwanted">Set aside</button>
      <button type="button" class="btn small danger" data-act="delete">Delete</button>
    </div>
    <details class="all-fields" id="all-fields">
      <summary>All extracted fields<svg class="icon"><use href="#i-chevron"/></svg></summary>
      <div id="device-fields"><p class="hint">Loading…</p></div>
    </details>`;
}

function bindDevicePanel(raw) {
  const nameInput = el("insp-name-input");
  nameInput.addEventListener("input", () => {
    setDeviceMeta(raw.id, { name: nameInput.value });
    el("insp-name").textContent = displayName(raw);
    refreshNodeLabel(raw);
  });
  el("name-reset")?.addEventListener("click", () => {
    setDeviceMeta(raw.id, { name: "" });
    refreshNodeLabel(raw);
    renderInspector();
  });
  el("insp-caption").addEventListener("input", (e) => {
    setDeviceMeta(raw.id, { extra: e.target.value });
    refreshNodeLabel(raw);
  });
  el("insp-notes").addEventListener("input", (e) => setDeviceMeta(raw.id, { notes: e.target.value }));
  const details = el("all-fields");
  details.addEventListener("toggle", () => {
    if (details.open) loadDeviceFields(raw);
  });
}

async function loadDeviceFields(raw) {
  const target = el("device-fields");
  const key = `${state.activeMapId}|${raw.id}|${state.graphVersion}`;
  let rows = state.propsCache.get(key);
  if (!rows) {
    try {
      const payload = await parseResponse(
        await fetch("/api/device/properties", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...state.graph, title: state.title, node_id: raw.id }),
        })
      );
      rows = payload.properties;
      state.propsCache.set(key, rows);
    } catch (err) {
      target.innerHTML = `<p class="field-error">${escapeHtml(err.message || String(err))}</p>`;
      return;
    }
  }
  if (state.selection[0] !== raw.id || !el("device-fields")) return;
  renderDeviceFields(rows, raw);
}

function renderDeviceFields(rows, raw) {
  const target = el("device-fields");
  target.innerHTML = "";
  for (const row of rows) {
    if (SKIP_FIELD_KEYS.has(row.key)) continue;
    const fields = getDeviceMeta(raw.id).fields || {};
    const edited = Object.prototype.hasOwnProperty.call(fields, row.key);
    const readonly = READONLY_KEYS.has(row.key) || String(row.key).startsWith("link.");
    const capture = row.value || "";
    const current = edited ? stringifyEdit(row.key, fields[row.key]) : capture;
    const wrap = document.createElement("div");
    wrap.className = `field-row${edited ? " edited" : ""}`;
    wrap.innerHTML = `<div class="field-head"><span class="name">${escapeHtml(row.name)}</span><span class="origin-tag${edited ? " edited" : ""}">${
      readonly ? "" : edited ? "Edited" : ""
    }</span><span class="field-tools"><button type="button" class="btn ghost" data-f="copy">Copy</button>${
      readonly ? "" : `<button type="button" class="btn ghost" data-f="reset"${edited ? "" : " hidden"}>Reset</button>`
    }</span></div>`;
    let control;
    if (readonly) {
      control = document.createElement("dd");
      control.textContent = current || "—";
    } else {
      const multiline = JSON_FIELDS.has(row.key) || current.length > 64 || /^(extra|routing)\./.test(row.key) || current.includes("\n");
      control = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) control.type = "text";
      else control.rows = Math.min(8, Math.max(2, current.split("\n").length));
      control.value = current === "—" ? "" : current;
      control.placeholder = "Not in capture";
      control.setAttribute("aria-label", row.name);
      control.addEventListener("input", () => {
        setDeviceMeta(raw.id, { fields: { [row.key]: parseFieldValue(row.key, control.value) } });
        wrap.classList.add("edited");
        wrap.querySelector(".origin-tag").textContent = "Edited";
        wrap.querySelector(".origin-tag").classList.add("edited");
        wrap.querySelector('[data-f="reset"]')?.removeAttribute("hidden");
        afterFieldEdit(raw, row.key);
      });
    }
    wrap.appendChild(control);
    wrap.querySelector('[data-f="copy"]').addEventListener("click", () => copyText(control.value ?? control.textContent ?? ""));
    wrap.querySelector('[data-f="reset"]')?.addEventListener("click", (e) => {
      clearFieldOverride(raw.id, row.key);
      control.value = capture === "—" ? "" : capture;
      wrap.classList.remove("edited");
      wrap.querySelector(".origin-tag").textContent = "";
      e.currentTarget.setAttribute("hidden", "");
      afterFieldEdit(raw, row.key);
    });
    target.appendChild(wrap);
  }
}

function afterFieldEdit(raw, key) {
  refreshNodeLabel(raw);
  el("insp-name").textContent = displayName(raw);
  if (MAP_STYLE_KEYS.has(key) && state.cy) {
    const cyNode = state.cy.getElementById(raw.id);
    if (cyNode.length) cyNode.data("role", nodeRole(overlayNode(raw)));
  }
}

function nodeName(id) {
  const n = nodeById(id);
  return n ? displayName(n) : id;
}

function linkPanel(link) {
  const extra = link.extra || {};
  const ports = (link.ports || []).map((p) => (p.sport != null && p.dport != null ? `${p.display} (${p.sport} → ${p.dport})` : p.display)).filter(Boolean);
  const kindName = LAYERS.find((l) => l.kind === link.kind)?.name || link.kind;
  return `
    <div class="insp-head">
      <span class="insp-icon" style="--c: var(${LAYERS.find((l) => l.kind === link.kind)?.color || "--edge-l2"}); border-radius: 50%"></span>
      <div class="insp-title">
        <h2>${escapeHtml(edgeLabel(link) || kindName)}</h2>
        <p>${escapeHtml(kindName)} · ${escapeHtml(link.medium || "wired")}</p>
      </div>
    </div>
    <div class="insp-section"><dl class="facts">
      ${factRow(link.kind === "client-server" ? "Client" : "From", nodeName(link.source))}
      ${factRow(link.kind === "client-server" ? "Server" : "To", nodeName(link.target))}
      ${factRow("Frames", extra.count)}
      ${factRow("VLANs", link.vlans)}
      ${link.kind === "bridge" ? factRow("Bridge type", extra.bridge_kind) : ""}
      ${factRow("Via", (extra.vias || []).map(nodeName))}
      ${factRow("Networks", extra.networks)}
      ${link.kind === "wireless" ? factRow("Associated", extra.associated === false ? "No (probe only)" : "Yes") : ""}
      ${factRow("SSID", extra.ssid)}
      ${factRow("HTTP host", extra.http_host)}
      ${factRow("DNS query", extra.dns_query)}
    </dl></div>
    ${ports.length || link.services?.length ? `<div class="insp-section"><h3>Services</h3>${chips(ports.length ? ports : link.services)}</div>` : ""}`;
}

function multiPanel(ids) {
  const counts = {};
  for (const id of ids) {
    const n = nodeById(id);
    if (!n) continue;
    const t = inferredName(n);
    counts[t] = (counts[t] || 0) + 1;
  }
  return `
    <div class="insp-head"><div class="insp-title"><h2>${plural(ids.length, "device")} selected</h2>
      <p>Shift-click to add or remove devices.</p></div></div>
    <div class="insp-section"><dl class="facts">${Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `<dt>${escapeHtml(t)}</dt><dd>${c}</dd>`)
      .join("")}</dl></div>
    <div class="insp-section insp-actions">
      <button type="button" class="btn small" data-act="copy">Copy</button>
      <button type="button" class="btn small" data-act="cut">Cut</button>
      <button type="button" class="btn small" data-act="move" aria-haspopup="menu">Move to<svg class="icon chev"><use href="#i-chevron"/></svg></button>
      <button type="button" class="btn small" data-act="unwanted">Set aside</button>
      <button type="button" class="btn small danger" data-act="delete">Delete</button>
    </div>`;
}

function runAction(act, anchor) {
  if (act === "copy") copySelected();
  else if (act === "cut") cutSelected();
  else if (act === "paste") pasteClipboard();
  else if (act === "delete") deleteSelected();
  else if (act === "unwanted") moveSelectedTo(UNWANTED_ID);
  else if (act === "move") openMoveMenu(anchor);
  else if (act === "copy-details") copyDeviceDetails();
  else if (act === "device-export") {
    openMenu(anchor, [
      { label: "PDF", hint: ".pdf", onSelect: () => exportDevice("pdf") },
      { label: "Spreadsheet", hint: ".csv", onSelect: () => exportDevice("csv") },
      { label: "XML", hint: ".xml", onSelect: () => exportDevice("xml") },
      { label: "Plain text", hint: ".txt", onSelect: () => exportDevice("txt") },
    ]);
  }
}

function openMoveMenu(anchor) {
  const targets = state.maps.filter((m) => m.id !== state.activeMapId).sort((a, b) => (a.kind === "unwanted") - (b.kind === "unwanted"));
  const items = targets.length
    ? targets.map((m) => ({ label: m.name, hint: m.kind === "unwanted" ? "Holding area" : plural(mapNodeCount(m), "device"), onSelect: () => moveSelectedTo(m.id) }))
    : [{ label: "No other maps yet", disabled: true }];
  items.push("sep", { label: "New map…", onSelect: () => moveToNewMap() });
  openMenu(anchor, items);
}

async function moveToNewMap() {
  const name = await openDialog({ title: "Move to a new map", input: { value: "", placeholder: "Lab network", label: "Map name" }, okLabel: "Create and move", validate: (v) => (v.trim() ? null : "Enter a map name.") });
  if (!name) return;
  const map = upsertMap({ id: `map:blank-${Date.now()}`, name: name.trim(), kind: "blank", graph: emptyGraph(name.trim()) });
  moveSelectedTo(map.id);
}

/* ---------- Selection UI ---------- */

function syncSelectionUi() {
  const n = state.selection.length;
  show("selection-bar", n > 0);
  el("selection-count").textContent = `${n} selected`;
}

function syncPasteUi() {
  const n = state.clipboard?.nodes?.length || 0;
  show("btn-paste", n > 0);
  el("paste-label").textContent = n ? `Paste ${plural(n, "device")}` : "Paste";
}

function showContextMenu(x, y, onNode) {
  const hasClip = Boolean(state.clipboard?.nodes?.length);
  const items = onNode
    ? [
        { label: "Copy", kbd: "Ctrl C", onSelect: copySelected },
        { label: "Cut", kbd: "Ctrl X", onSelect: cutSelected },
        { label: "Paste", kbd: "Ctrl V", disabled: !hasClip, onSelect: pasteClipboard },
        "sep",
        { label: "Set aside in Unwanted", onSelect: () => moveSelectedTo(UNWANTED_ID) },
        { label: "Delete", kbd: "Del", danger: true, onSelect: deleteSelected },
      ]
    : [
        { label: hasClip ? `Paste ${plural(state.clipboard.nodes.length, "device")}` : "Paste", kbd: "Ctrl V", disabled: !hasClip, onSelect: pasteClipboard },
        "sep",
        { label: "Fit to screen", kbd: "F", onSelect: () => fitMap() },
        { label: "Tidy layout", onSelect: tidyLayout },
      ];
  openMenuAt(x, y, items);
}

/* ---------- Edit operations ---------- */

function selectedIds() {
  return state.selection.filter((id) => nodeById(id));
}

function nodeLooksLikeAp(node) {
  return Boolean(node) && nodeRole(overlayNode(node)) === "ap";
}

function nodeLooksLikeWirelessClient(node) {
  if (!node || nodeLooksLikeAp(node)) return false;
  const n = overlayNode(node);
  if ((n.roles || []).includes("station")) return true;
  if (String(n.inferred_type || "").toLowerCase() === "wireless client") return true;
  return n.medium === "wireless" && !["vlan", "subnet"].includes(n.kind);
}

function expandSelectionForApNetwork(ids) {
  const graph = state.graph;
  if (!graph || !ids?.length) return [...(ids || [])];
  const out = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift();
    if (!nodeLooksLikeAp(nodeById(id))) continue;
    for (const link of graph.links || []) {
      const other = link.source === id ? link.target : link.target === id ? link.source : null;
      if (!other || out.has(other)) continue;
      const peer = nodeById(other);
      const associatedClient = link.kind === "wireless" && (link.extra || {}).associated !== false && nodeLooksLikeWirelessClient(peer);
      const bridgedAp = link.kind === "bridge" && nodeLooksLikeAp(peer);
      if (associatedClient || bridgedAp) {
        out.add(other);
        queue.push(other);
      }
    }
  }
  return [...out];
}

function describePack(originalIds, expandedIds, verb) {
  const base = `${verb} ${plural(expandedIds.length, "device")}`;
  const orig = new Set(originalIds);
  const extras = expandedIds.filter((id) => !orig.has(id));
  if (!extras.length) return base;
  const aps = extras.filter((id) => nodeLooksLikeAp(nodeById(id))).length;
  const clients = extras.length - aps;
  const bits = [];
  if (clients) bits.push(plural(clients, "associated client"));
  if (aps) bits.push(plural(aps, "bridged AP"));
  return `${base}, including ${bits.join(" and ")}`;
}

function originCaptureForNode(node, map) {
  const extra = node?.extra || {};
  if (extra.origin_capture) return extra.origin_capture;
  const captures = map?.captures?.length ? map.captures : map?.graph?.meta?.sources || [];
  if (captures.length === 1) return captures[0];
  const sourceId = String(map?.sourceId || "");
  if (sourceId.startsWith("upload:")) return sourceId.slice(7);
  if (sourceId) return sourceId.replace(/^map:/, "");
  return captures[0] || "unknown";
}

function stampOriginCapture(node, map) {
  const copy = cloneData(node);
  copy.extra = { ...(isPlainObject(copy.extra) ? copy.extra : {}), origin_capture: originCaptureForNode(copy, map) };
  return copy;
}

function packSelection(ids, mode, originalIds) {
  const idSet = new Set(ids);
  const map = getMap(state.activeMapId);
  const nodes = state.graph.nodes.filter((n) => idSet.has(n.id)).map((n) => stampOriginCapture(overlayNode(n), map));
  const links = state.graph.links.filter((l) => idSet.has(l.source) && idSet.has(l.target)).map(cloneData);
  const meta = {};
  for (const id of ids) meta[id] = cloneData(getDeviceMeta(id));
  const orig = new Set(originalIds || ids);
  return { mode, fromMap: state.activeMapId, nodes, links, meta, bundledClients: ids.filter((id) => !orig.has(id)).length };
}

function removeNodes(map, ids) {
  const drop = new Set(ids);
  map.graph.nodes = map.graph.nodes.filter((n) => !drop.has(n.id));
  map.graph.links = map.graph.links.filter((l) => !drop.has(l.source) && !drop.has(l.target));
  for (const id of ids) {
    if (map.positions) delete map.positions[id];
    dropMeta(map.id, id);
  }
  if (map.id === state.activeMapId) state.graph = map.graph;
}

function insertPack(map, pack) {
  const used = new Set(map.graph.nodes.map((n) => n.id));
  const idMap = {};
  for (const node of pack.nodes) {
    const nextId = uniqueId(node.id, used);
    idMap[node.id] = nextId;
    used.add(nextId);
    map.graph.nodes.push({ ...cloneData(node), id: nextId });
    const meta = pack.meta?.[node.id];
    if (meta && Object.keys(meta).length) {
      metaCache[metaKey(map.id, nextId)] = cloneData(meta);
      markMetaDirty();
    }
  }
  const usedLinks = new Set(map.graph.links.map((l) => l.id));
  for (const link of pack.links || []) {
    const source = idMap[link.source];
    const target = idMap[link.target];
    if (!source || !target) continue;
    const id = uniqueId(link.id, usedLinks);
    usedLinks.add(id);
    map.graph.links.push({ ...cloneData(link), id, source, target });
  }
  return Object.values(idMap);
}

function requireSelection() {
  const ids = selectedIds();
  if (!ids.length) toast("Select a device first.", { timeout: 2000 });
  return ids;
}

function copySelected() {
  const ids = requireSelection();
  if (!ids.length) return;
  const expanded = expandSelectionForApNetwork(ids);
  state.clipboard = packSelection(expanded, "copy", ids);
  markSessionDirty();
  syncPasteUi();
  toast(`${describePack(ids, expanded, "Copied")}. Open another map and paste.`);
}

function cutSelected() {
  const ids = requireSelection();
  if (!ids.length) return;
  const expanded = expandSelectionForApNetwork(ids);
  snapshotUndo("cut", [state.activeMapId]);
  state.clipboard = packSelection(expanded, "cut", ids);
  const map = getMap(state.activeMapId);
  removeNodes(map, expanded);
  state.selection = [];
  markMapEdited();
  markSessionDirty();
  refreshAll();
  toast(`${describePack(ids, expanded, "Cut")}. Paste onto another map.`, { undo: true });
}

function pasteClipboard() {
  const clip = state.clipboard;
  if (!clip?.nodes?.length) {
    toast("Nothing to paste. Copy or cut devices first.", { timeout: 2500 });
    return;
  }
  const map = getMap(state.activeMapId);
  if (!map) return;
  snapshotUndo("paste", [map.id]);
  const added = insertPack(map, clip);
  state.selection = added;
  markMapEdited();
  refreshAll();
  toast(`Pasted ${plural(clip.nodes.length, "device")} onto ${map.name}.`, { undo: true });
}

function deleteSelected() {
  const ids = requireSelection();
  if (!ids.length) return;
  snapshotUndo("delete", [state.activeMapId]);
  removeNodes(getMap(state.activeMapId), ids);
  state.selection = [];
  markMapEdited();
  refreshAll();
  toast(`Deleted ${plural(ids.length, "device")}.`, { undo: true });
}

function moveSelectedTo(mapId) {
  const ids = requireSelection();
  if (!ids.length) return;
  if (mapId === UNWANTED_ID) ensureUnwanted();
  const dest = getMap(mapId);
  if (!dest || mapId === state.activeMapId) {
    toast("Those devices are already on this map.", { timeout: 2500 });
    return;
  }
  snapshotUndo("move", [state.activeMapId, dest.id]);
  const expanded = expandSelectionForApNetwork(ids);
  const pack = packSelection(expanded, "move", ids);
  removeNodes(getMap(state.activeMapId), expanded);
  insertPack(dest, pack);
  state.selection = [];
  markMapEdited();
  markMapEdited(dest.id);
  refreshAll();
  toast(`${describePack(ids, expanded, "Moved")} to ${dest.name}.`, { undo: true });
}

/* ---------- Map list ---------- */

function renderMapList() {
  const list = el("map-list");
  list.innerHTML = "";
  // Unwanted is a holding area, so it always sits under your own maps.
  const ordered = [...state.maps.filter((m) => m.kind !== "unwanted"), ...state.maps.filter((m) => m.kind === "unwanted")];
  for (const map of ordered) {
    const row = document.createElement("li");
    row.className = `list-row${map.id === state.activeMapId ? " active" : ""}`;
    const n = mapNodeCount(map);
    row.innerHTML = `<button type="button" class="row-main"><span class="row-dot"></span><span class="row-text"><span class="row-title">${escapeHtml(map.name)}</span>
      <span class="row-sub">${escapeHtml(mapKindLabel(map))} · ${plural(n, "device")}</span></span></button>
      <button type="button" class="icon-btn row-menu-btn" aria-label="Options for ${escapeHtml(map.name)}" aria-haspopup="menu" aria-expanded="false"><svg class="icon"><use href="#i-dots"/></svg></button>`;
    row.querySelector(".row-main").addEventListener("click", () => {
      showMap(map.id);
      closeNarrowPanels();
    });
    row.querySelector(".row-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const items = [{ label: "Rename…", onSelect: () => renameMap(map.id) }];
      if (map.kind === "unwanted") {
        items.push({ label: "Save to files and empty…", disabled: !n, onSelect: () => emptyUnwanted() });
      } else {
        items.push({ label: "Merge into…", disabled: state.maps.filter((m) => m.kind !== "unwanted" && m.id !== map.id).length === 0, onSelect: () => mergeMapDialog(map.id) });
        items.push("sep", { label: "Delete map…", danger: true, onSelect: () => deleteMap(map.id) });
      }
      openMenu(e.currentTarget, items, { align: "right" });
    });
    list.appendChild(row);
  }
}

async function renameMap(mapId) {
  const map = getMap(mapId);
  if (!map) return;
  const name = await openDialog({ title: "Rename map", input: { value: map.name, label: "Map name" }, okLabel: "Rename", validate: (v) => (v.trim() ? null : "Enter a map name.") });
  if (!name) return;
  map.name = name.trim();
  if (map.graph) map.graph.title = map.name;
  if (map.id === state.activeMapId) state.title = map.name;
  markMapDirty(map.id);
  updateHeader();
  renderMapList();
}

async function deleteMap(mapId) {
  const map = getMap(mapId);
  if (!map || map.kind === "unwanted") return;
  const ok = await openDialog({ title: `Delete “${map.name}”?`, body: "The map and its edits are removed. You can undo this right after.", okLabel: "Delete map", danger: true });
  if (!ok) return;
  snapshotUndo("delete map", [mapId]);
  state.maps = state.maps.filter((m) => m.id !== mapId);
  store.deletedMaps.add(mapId);
  for (const k of Object.keys(metaCache)) if (k.startsWith(`${mapId}::`)) delete metaCache[k];
  markMetaDirty();
  markSessionDirty();
  if (state.activeMapId === mapId) showMap((state.maps.find((m) => m.kind !== "unwanted") || getMap(UNWANTED_ID)).id);
  else renderMapList();
  toast(`Deleted ${map.name}.`, { undo: true });
}

async function mergeMapDialog(sourceId) {
  const source = getMap(sourceId);
  const options = state.maps.filter((m) => m.kind !== "unwanted" && m.id !== sourceId).map((m) => ({ value: m.id, label: `${m.name} (${plural(mapNodeCount(m), "device")})` }));
  const destId = await openDialog({ title: `Merge “${source.name}” into…`, body: "Devices and links are copied into the map you choose. This map stays as it is.", select: { options, label: "Destination map" }, okLabel: "Merge" });
  if (destId) mergeMaps(sourceId, destId);
}

function mergeMaps(sourceId, destId) {
  const source = getMap(sourceId);
  const dest = getMap(destId);
  if (!source || !dest || source.id === dest.id) return;
  snapshotUndo("merge", [dest.id]);
  const pack = {
    nodes: source.graph.nodes.map((n) => stampOriginCapture(n, source)),
    links: source.graph.links,
    meta: Object.fromEntries(source.graph.nodes.map((n) => [n.id, metaCache[metaKey(source.id, n.id)] || {}])),
  };
  insertPack(dest, pack);
  dest.captures = [...new Set([...(dest.captures || []), ...(source.captures || [])])];
  markMapEdited(dest.id);
  showMap(dest.id);
  toast(`Merged ${source.name} into ${dest.name}.`, { undo: true });
}

async function emptyUnwanted() {
  ensureUnwanted();
  const map = getMap(UNWANTED_ID);
  const graph = map.graph;
  if (!graph.nodes.length) {
    toast("Unwanted is already empty.", { timeout: 2000 });
    return;
  }
  const ok = await openDialog({
    title: `Save ${plural(graph.nodes.length, "device")} and empty Unwanted?`,
    body: "NetSeer writes one JSON file per original capture into the Unwanted folder of the project. Drop a file back onto NetSeer to reload it.",
    okLabel: "Save and empty",
  });
  if (!ok) return;
  const groups = {};
  for (const node of graph.nodes) {
    const key = originCaptureForNode(node, map);
    groups[key] ||= { capture: key, nodes: [], links: [], device_meta: {} };
    groups[key].nodes.push(stampOriginCapture(node, map));
    groups[key].device_meta[node.id] = cloneData(metaCache[metaKey(UNWANTED_ID, node.id)] || {});
  }
  for (const group of Object.values(groups)) {
    const ids = new Set(group.nodes.map((n) => n.id));
    group.links = graph.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  }
  try {
    const payload = await parseResponse(
      await fetch("/api/unwanted/dump", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groups: Object.values(groups) }) })
    );
    snapshotUndo("empty Unwanted", [UNWANTED_ID]);
    removeNodes(map, graph.nodes.map((n) => n.id));
    markMapEdited(UNWANTED_ID);
    refreshAll();
    toast(`Saved ${(payload.files || []).join(", ")} and emptied Unwanted.`);
  } catch (err) {
    fail(err);
  }
}

async function createBlankMap() {
  const n = state.maps.filter((m) => m.kind === "blank").length + 1;
  const name = await openDialog({ title: "New blank map", input: { value: n === 1 ? "Blank map" : `Blank map ${n}`, label: "Map name" }, okLabel: "Create", validate: (v) => (v.trim() ? null : "Enter a map name.") });
  if (!name) return;
  const map = upsertMap({ id: `map:blank-${Date.now()}`, name: name.trim(), kind: "blank", graph: emptyGraph(name.trim()) });
  showMap(map.id);
}

/* ---------- Surveys ---------- */

function hiddenSampleIds() {
  const raw = readLocal(HIDDEN_SAMPLES_KEY, []);
  return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
}

const sampleToSurvey = (s) => ({ id: s.id, kind: "sample", name: s.name, summary: s.summary });

function renderSurveyList() {
  const list = el("survey-list");
  list.innerHTML = "";
  el("survey-empty").classList.toggle("hidden", state.surveys.length > 0);
  el("btn-restore-samples").classList.toggle("hidden", hiddenSampleIds().length === 0);
  for (const item of state.surveys) {
    const row = document.createElement("li");
    const active = `map:${item.id}` === state.activeMapId;
    row.className = `list-row${active ? " active" : ""}`;
    const sub = item.kind === "upload" ? "Your capture" : item.summary;
    row.innerHTML = `<button type="button" class="row-main" title="${escapeHtml(item.summary || "")}"><span class="row-dot"></span><span class="row-text"><span class="row-title">${escapeHtml(item.name)}</span>
      <span class="row-sub">${escapeHtml(sub)}</span></span></button>
      <button type="button" class="icon-btn row-menu-btn" aria-label="Remove ${escapeHtml(item.name)} from the list" title="Remove from list"><svg class="icon"><use href="#i-x"/></svg></button>`;
    row.querySelector(".row-main").addEventListener("click", () => {
      selectSurvey(item.id);
      closeNarrowPanels();
    });
    row.querySelector(".row-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      removeSurvey(item.id);
    });
    list.appendChild(row);
  }
}

function setBusy(on, msg = "Reading frames…") {
  el("loading-msg").textContent = msg;
  show("loading", on);
  if (on) show("empty", false);
  else updateEmptyState();
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
  setBusy(true, `Loading ${item.name}…`);
  try {
    const graph = await parseResponse(await fetch(`/api/samples/${encodeURIComponent(item.id)}/graph`));
    setBusy(false);
    applyGraph(graph, item.name, item.id);
  } catch (err) {
    setBusy(false);
    fail(err);
  }
}

function removeSurvey(id) {
  const item = state.surveys.find((s) => s.id === id);
  if (!item) return;
  state.surveys = state.surveys.filter((s) => s.id !== id);
  if (item.kind === "sample") {
    const hidden = hiddenSampleIds();
    if (!hidden.includes(id)) writeLocal(HIDDEN_SAMPLES_KEY, [...hidden, id]);
  }
  renderSurveyList();
  toast(`Removed ${item.name} from the list. Its map stays under Maps.`, { timeout: 3500 });
}

function restoreBundledSamples() {
  writeLocal(HIDDEN_SAMPLES_KEY, []);
  const uploads = state.surveys.filter((s) => s.kind === "upload");
  state.surveys = [...uploads, ...state.catalog.map(sampleToSurvey)];
  renderSurveyList();
}

function applyGraph(graph, title, surveyId) {
  const mapId = surveyId === UNWANTED_ID || String(surveyId).startsWith("map:") ? surveyId : `map:${surveyId}`;
  upsertMap({ id: mapId, name: title || "NetSeer map", kind: mapId === UNWANTED_ID ? "unwanted" : "survey", sourceId: surveyId, captures: graph?.meta?.sources || [], graph });
  for (const source of [graph?.device_meta, graph?.meta?.device_meta]) {
    if (!isPlainObject(source)) continue;
    for (const [nodeId, meta] of Object.entries(source)) metaCache[metaKey(mapId, nodeId)] = cloneData(meta);
    markMetaDirty();
  }
  showMap(mapId);
  const warnings = graph?.meta?.warnings || [];
  if (warnings.length) toast(warnings.join(" "), { timeout: 7000 });
}

async function loadFile(file) {
  setBusy(true, `Reading ${file.name}…`);
  const body = new FormData();
  body.append("file", file);
  try {
    const graph = await parseResponse(await fetch("/api/parse", { method: "POST", body }));
    setBusy(false);
    const id = `upload:${file.name}`;
    const item = { id, kind: "upload", name: file.name, summary: "Your capture", graph };
    const at = state.surveys.findIndex((s) => s.id === id);
    if (at >= 0) state.surveys.splice(at, 1, item);
    else state.surveys.unshift(item);
    applyGraph(graph, file.name, id);
  } catch (err) {
    setBusy(false);
    fail(new Error(`${file.name}: ${err.message || err}`));
  }
}

async function loadFiles(files) {
  for (const file of files) if (file) await loadFile(file);
}

/* ---------- Exports ---------- */

function layoutHints() {
  const cy = state.cy;
  if (!cy) return {};
  const positions = {};
  const parents = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    positions[n.id()] = [Math.round(p.x), Math.round(p.y)];
    const parent = n.data("parent");
    if (parent) parents[n.id()] = parent;
  });
  return { positions, parents };
}

function graphWithUserFields() {
  const nodes = (state.graph?.nodes || []).map((n) => overlayNode(n));
  return { ...state.graph, title: state.title, nodes, ...layoutHints() };
}

async function download(res, filename) {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportKind(kind) {
  if (!state.graph?.nodes?.length) return;
  const ext = { drawio: "drawio", vsdx: "vsdx", vdx: "vdx", "report.pdf": "pdf" }[kind];
  try {
    const res = await fetch(`/api/export/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(graphWithUserFields()) });
    if (!res.ok) throw new Error((await parseResponse(res).catch((e) => e)).message || "Export failed");
    await download(res, `${safeFileStem(state.title)}${kind === "report.pdf" ? "-report" : ""}.${ext}`);
    toast(`Exported ${state.title}.`, { timeout: 2000 });
  } catch (err) {
    fail(err);
  }
}

function inspectedNode() {
  return state.selection.length === 1 ? nodeById(state.selection[0]) : null;
}

async function exportDevice(fmt) {
  const node = inspectedNode();
  if (!node) return;
  try {
    const res = await fetch(`/api/export/device/${fmt}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...graphWithUserFields(), node_id: node.id }) });
    if (!res.ok) throw new Error("Device export failed");
    await download(res, `${safeFileStem(displayName(node))}-device.${fmt}`);
  } catch (err) {
    fail(err);
  }
}

async function copyDeviceDetails() {
  const node = inspectedNode();
  if (!node) return;
  try {
    const res = await fetch("/api/export/device/txt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...graphWithUserFields(), node_id: node.id }) });
    if (!res.ok) throw new Error("Could not copy device details");
    await copyText(await res.text(), "Device details copied");
  } catch (err) {
    fail(err);
  }
}

/* ---------- Layers ---------- */

function loadPrefs() {
  const prefs = readLocal(PREFS_KEY, {});
  if (isPlainObject(prefs.filters)) for (const l of LAYERS) if (typeof prefs.filters[l.kind] === "boolean") state.filters[l.kind] = prefs.filters[l.kind];
  if (typeof prefs.groupBySubnet === "boolean") state.groupBySubnet = prefs.groupBySubnet;
  if (prefs.tab) setTab(prefs.tab);
}

function savePrefs() {
  writeLocal(PREFS_KEY, { filters: state.filters, groupBySubnet: state.groupBySubnet, tab: document.querySelector(".tab.active")?.dataset.tab });
}

function renderLayerList() {
  const list = el("layer-list");
  list.innerHTML = "";
  for (const layer of LAYERS) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const covered = layer.kind === "subnet" && state.groupBySubnet;
    row.innerHTML = `<input type="checkbox" ${state.filters[layer.kind] ? "checked" : ""} ${covered ? "disabled" : ""} />
      <i class="line-sample ${layer.line}" style="--c: var(${layer.color})"></i>
      <span>${escapeHtml(layer.name)}${covered ? "<small>Shown as boxes while grouping</small>" : ""}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      state.filters[layer.kind] = e.target.checked;
      savePrefs();
      renderMap({ fit: false });
    });
    list.appendChild(row);
  }
  el("group-toggle").checked = state.groupBySubnet;
}

function setAllLayers(on) {
  for (const l of LAYERS) state.filters[l.kind] = on;
  savePrefs();
  renderLayerList();
  renderMap({ fit: false });
}

function setTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}

function tidyLayout() {
  const map = getMap(state.activeMapId);
  if (!map) return;
  const hadPositions = Object.keys(map.positions || {}).length > 0;
  if (hadPositions) snapshotUndo("tidy layout", [map.id]);
  map.positions = {};
  markMapDirty(map.id);
  renderMap({ fit: true });
  toast(hadPositions ? "Layout tidied." : "Already tidy.", { undo: hadPositions, timeout: 2500 });
}

/* ---------- Search ---------- */

function searchNodes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const raw of state.graph?.nodes || []) {
    const n = overlayNode(raw);
    const hay = [displayName(raw), n.inferred_type, n.caption, n.vendor, ...(n.ips || []), ...(n.macs || []), ...(n.ssids || []), n.notes].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(q)) {
      const name = displayName(raw).toLowerCase();
      out.push({ raw, n, score: name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2 });
    }
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 8);
}

function renderSearch() {
  const results = el("search-results");
  const hits = searchNodes(el("search").value);
  results.innerHTML = "";
  if (!el("search").value.trim()) {
    results.classList.add("hidden");
    return;
  }
  if (!hits.length) {
    results.innerHTML = '<li class="menu-label">No matching devices</li>';
  }
  hits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (i === 0) li.classList.add("active");
    const sub = [hit.n.ips?.[0], hit.n.macs?.[0], hit.n.ssids?.[0]].filter(Boolean).join(" · ");
    li.innerHTML = `<span>${escapeHtml(displayName(hit.raw))}</span><small>${escapeHtml(sub || hit.n.inferred_type || "")}</small>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSearchResult(hit.raw.id);
    });
    results.appendChild(li);
  });
  results.classList.remove("hidden");
  renderSearch.hits = hits;
}

function pickSearchResult(id) {
  el("search").value = "";
  el("search-results").classList.add("hidden");
  el("search").blur();
  selectNodes([id], { center: true });
}

/* ---------- Narrow screens ---------- */

function closeNarrowPanels() {
  el("sidebar").classList.remove("open");
}

/* ---------- Wiring ---------- */

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
}

function bindUi() {
  el("btn-open").addEventListener("click", () => el("file").click());
  el("empty-open").addEventListener("click", () => el("file").click());
  el("empty-sample").addEventListener("click", () => {
    const sample = state.catalog.find((s) => s.id === "campus-all") || state.catalog[0];
    if (!sample) return;
    if (!state.surveys.some((s) => s.id === sample.id)) state.surveys.push(sampleToSurvey(sample));
    selectSurvey(sample.id);
  });
  el("file").addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) loadFiles(files);
  });
  el("dropzone").addEventListener("click", (e) => {
    e.preventDefault();
    el("file").click();
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    show("drop-overlay", true);
    el("dropzone").classList.add("drag");
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      show("drop-overlay", false);
      el("dropzone").classList.remove("drag");
    }
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    show("drop-overlay", false);
    el("dropzone").classList.remove("drag");
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) loadFiles(files);
  });

  el("btn-export").addEventListener("click", (e) =>
    openMenu(e.currentTarget, [
      { label: "draw.io diagram", hint: ".drawio", onSelect: () => exportKind("drawio") },
      { label: "Visio drawing", hint: ".vsdx", onSelect: () => exportKind("vsdx") },
      { label: "Visio XML", hint: ".vdx", onSelect: () => exportKind("vdx") },
      "sep",
      { label: "Full report", hint: "PDF", onSelect: () => exportKind("report.pdf") },
    ])
  );
  el("btn-theme").addEventListener("click", (e) => openThemeMenu(e.currentTarget));
  el("btn-help").addEventListener("click", () => el("help-dialog").showModal());
  el("map-title").addEventListener("click", () => state.activeMapId && renameMap(state.activeMapId));
  el("btn-sidebar").addEventListener("click", () => el("sidebar").classList.toggle("open"));
  el("btn-new-map").addEventListener("click", createBlankMap);
  el("btn-restore-samples").addEventListener("click", restoreBundledSamples);
  el("btn-show-all").addEventListener("click", () => setAllLayers(true));
  el("btn-show-none").addEventListener("click", () => setAllLayers(false));
  el("group-toggle").addEventListener("change", (e) => {
    state.groupBySubnet = e.target.checked;
    savePrefs();
    renderLayerList();
    renderMap({ fit: true });
  });
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      setTab(t.dataset.tab);
      savePrefs();
    })
  );

  el("btn-undo").addEventListener("click", undoLast);
  el("toast-undo").addEventListener("click", () => {
    el("toast").classList.add("hidden");
    undoLast();
  });
  el("btn-paste").addEventListener("click", pasteClipboard);
  el("btn-relayout").addEventListener("click", tidyLayout);
  el("zoom-in").addEventListener("click", () => zoomBy(1.25));
  el("zoom-out").addEventListener("click", () => zoomBy(0.8));
  el("zoom-fit").addEventListener("click", () => fitMap());
  el("selection-bar").querySelectorAll("[data-sel]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = btn.dataset.sel;
      runAction(act === "unwanted" ? "unwanted" : act, e.currentTarget);
    })
  );

  const search = el("search");
  search.addEventListener("input", renderSearch);
  search.addEventListener("focus", renderSearch);
  search.addEventListener("blur", () => setTimeout(() => el("search-results").classList.add("hidden"), 120));
  search.addEventListener("keydown", (e) => {
    const items = [...el("search-results").querySelectorAll('li[role="option"]')];
    const i = items.findIndex((li) => li.classList.contains("active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items.forEach((li, j) => li.classList.toggle("active", j === next));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = renderSearch.hits?.[Math.max(0, i)];
      if (hit) pickSearchResult(hit.raw.id);
    } else if (e.key === "Escape") {
      search.value = "";
      search.blur();
    }
  });

  document.addEventListener("click", (e) => {
    if (openMenuState && !openMenuState.menu.contains(e.target) && e.target !== openMenuState.anchor && !openMenuState.anchor?.contains(e.target)) closeMenu();
    if (NARROW.matches && !el("sidebar").contains(e.target) && e.target.closest("#btn-sidebar") == null) closeNarrowPanels();
  });
  window.addEventListener("resize", () => closeMenu());
  el("map").addEventListener("contextmenu", (e) => e.preventDefault());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (openMenuState) {
        closeMenu()?.focus();
        return;
      }
      if (!isTypingTarget(e.target) && state.cy) {
        state.inspectedLink = null;
        state.cy.elements(":selected").unselect();
        renderInspector();
      }
      el("inspector").classList.remove("open");
      closeNarrowPanels();
      return;
    }
    if (isTypingTarget(e.target) || el("dialog").open || el("help-dialog").open) return;
    const cmd = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (cmd && key === "c") {
      e.preventDefault();
      copySelected();
    } else if (cmd && key === "x") {
      e.preventDefault();
      cutSelected();
    } else if (cmd && key === "v") {
      e.preventDefault();
      pasteClipboard();
    } else if (cmd && key === "z") {
      e.preventDefault();
      undoLast();
    } else if (!cmd && (e.key === "Delete" || e.key === "Backspace")) {
      if (!state.selection.length) return;
      e.preventDefault();
      deleteSelected();
    } else if (!cmd && e.key === "/") {
      e.preventDefault();
      el("search").focus();
    } else if (!cmd && key === "f") {
      fitMap();
    } else if (!cmd && e.key === "?") {
      el("help-dialog").showModal();
    }
  });

  NARROW.addEventListener("change", () => renderInspector());
  window.addEventListener("pagehide", () => flushSave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}

async function init() {
  mapResize.observe(el("map"));
  bindUi();
  loadPrefs();
  renderLayerList();
  syncZoomUi();
  await loadStore();
  ensureUnwanted();
  try {
    state.catalog = await parseResponse(await fetch("/api/samples"));
  } catch (err) {
    state.catalog = [];
    fail(err);
  }
  const hidden = new Set(hiddenSampleIds());
  const restoredUploads = state.maps.filter((m) => String(m.sourceId || "").startsWith("upload:")).map((m) => ({ id: m.sourceId, kind: "upload", name: m.name, summary: "Your capture", graph: m.graph }));
  state.surveys = [...restoredUploads, ...state.catalog.filter((s) => !hidden.has(s.id)).map(sampleToSurvey)];

  const active = getMap(state.activeMapId);
  if (active && (active.kind !== "survey" || mapNodeCount(active) > 0 || active.edited)) {
    showMap(active.id);
    return;
  }
  const userMap = state.maps.find((m) => m.kind !== "unwanted" && mapNodeCount(m) > 0);
  if (userMap) {
    showMap(userMap.id);
    return;
  }
  const first = state.surveys.find((s) => s.id === "campus-all") || state.surveys[0];
  if (first) await selectSurvey(first.id);
  else showMap(UNWANTED_ID);
}

init().catch((err) => fail(err));
