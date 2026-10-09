/* NetSeer preview — maps, surveys, layout, inspector, and exports. */
"use strict";

const UNWANTED_ID = "map:unwanted";
const ZOOM_MIN = 0.02; // far enough out to fit a long wardrive
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
  { id: "retrowave", name: "Retrowave", note: "Soft synthwave", swatch: ["#1d1830", "#e089c4", "#7fe0d0", "#f0c879"] },
];

const LAYERS = [
  { kind: "l2", name: "Wired (L2)", color: "--edge-l2", line: "solid" },
  { kind: "l3", name: "IP traffic (L3)", color: "--edge-l3", line: "dashed" },
  { kind: "client-server", name: "Ports and services", color: "--edge-service", line: "solid" },
  { kind: "wireless", name: "Wireless", color: "--edge-wireless", line: "dashed" },
  { kind: "vlan", name: "VLAN membership", color: "--edge-vlan", line: "dashed" },
  { kind: "subnet", name: "Subnet membership", color: "--edge-subnet", line: "dashed" },
  { kind: "bridge", name: "Bridges and attachments", color: "--edge-bridge", line: "dotted" },
  { kind: "manual", name: "Added by you", color: "--edge-manual", line: "dashdot" },
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
  redo: [],
  filters: Object.fromEntries(LAYERS.map((l) => [l.kind, true])),
  selection: [],
  inspectedLink: null,
  nodeIndex: new Map(),
  graphVersion: 0,
  propsCache: new Map(),
  suppressSelect: false,
  server: { hosted: false, maxUploadMb: 0, version: "", mode: "server", platform: "", package: "source", repo: "ardyn-systems/NetSeer", updater: false },
  // Settings that aren't layer filters. tourOffered: the first-run "Take the tour" message was shown.
  prefs: { layout: "ssid", layoutPicked: false, timeZone: "", clock: "auto", zoomSpeed: "normal", hoverFade: false, apSsid: true, autoUpdate: false, tourOffered: false, sidebarWidth: null, securityShade: false },
};

/* ---------- Small helpers ---------- */

const el = (id) => document.getElementById(id);
const show = (id, on) => el(id)?.classList.toggle("hidden", !on);
const plural = (n, word, many = `${word}s`) => `${Number(n).toLocaleString()} ${n === 1 ? word : many}`;
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

// action: { label, onClick } adds a button that runs onClick and closes the message.
function toast(msg, { undo = false, error = false, timeout, action = null } = {}) {
  const box = el("toast");
  el("toast-msg").textContent = msg;
  el("toast-undo").classList.toggle("hidden", !(undo && state.undo.length));
  const actionBtn = el("toast-action");
  actionBtn.classList.toggle("hidden", !action);
  actionBtn.textContent = action?.label || "";
  toast.action = action?.onClick || null;
  box.classList.toggle("error", error);
  box.classList.remove("hidden");
  // As a popover the message sits in the top layer, above any open dialog. Re-showing
  // it puts it above a dialog opened since.
  if (box.showPopover) {
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
  }
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hideToast, timeout ?? (error ? 8000 : 4500));
}

function hideToast() {
  const box = el("toast");
  box.classList.add("hidden");
  if (box.hidePopover && box.matches(":popover-open")) box.hidePopover();
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

// The Matrix theme is listed once someone has found it (see the logo terminal).
const themeList = () => [...THEMES, ...SECRET_THEMES.filter((t) => secretUnlocked(t.id) || currentTheme() === t.id)];

function currentTheme() {
  const id = document.documentElement.dataset.theme;
  return THEMES.some((t) => t.id === id) || secretTheme(id) ? id : "terrain";
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
    bluetooth: v("--node-bluetooth"),
    cell: v("--node-cell"),
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
    manual: v("--edge-manual"),
    select: v("--select"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

function applyTheme(id) {
  const theme = [...THEMES, ...SECRET_THEMES].find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  writeLocal(THEME_KEY, theme.id);
  if (state.cy) state.cy.style(cyStyle(themeColors()));
  syncThemeBackdrop();
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
    btn.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}${
      item.kbd ? `<kbd>${escapeHtml(item.kbd)}</kbd>` : ""
    }`;
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
    positionsMode: map.positionsMode || "subnet",
    layoutPositions: map.layoutPositions || {},
    hideUnchanged: Boolean(map.hideUnchanged),
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
    positionsMode: typeof m.positionsMode === "string" ? m.positionsMode : "subnet",
    layoutPositions: isPlainObject(m.layoutPositions) ? m.layoutPositions : {},
    hideUnchanged: Boolean(m.hideUnchanged),
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
  if (patch.fields) state.metaVersion = (state.metaVersion || 0) + 1;
  markMetaDirty();
}

function clearFieldOverride(nodeId, fieldKey) {
  state.metaVersion = (state.metaVersion || 0) + 1;
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
  else if (!out.caption) {
    const auto = autoCaption(out); // exports label access points the same way as the map
    if (auto) out.caption = auto;
  }
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
  const caption = (getDeviceMeta(node.id).extra || "").trim() || autoCaption(overlayNode(node));
  const name = displayName(node);
  return caption ? `${name}\n${caption}` : name;
}

// Access points show the network they broadcast under their name, so they're quick to
// tell apart: "HQ-Secure", or "HQ-Secure +2" for several, or "Hidden SSID" when a
// survey (such as a Kismet log) says the network name is hidden. A caption you type wins.
function autoCaption(node) {
  if (!state.prefs.apSsid || !node || nodeRole(node) !== "ap") return "";
  const ssids = (Array.isArray(node.ssids) ? node.ssids : []).map((s) => String(s ?? "").replace(/\0/g, "").trim()).filter(Boolean);
  if (!ssids.length) return node.extra?.hidden_ssid ? "Hidden SSID" : "";
  return ssids.length > 1 ? `${ssids[0]} +${ssids.length - 1}` : ssids[0];
}

function nodeRole(n) {
  const roles = n.roles || [];
  const type = String(n.inferred_type || "").toLowerCase();
  if (n.kind === "subnet") return "subnet";
  if (n.kind === "vlan") return "vlan";
  if (n.kind === "ap" || roles.includes("ap") || type === "access point") return "ap";
  if (n.kind === "gateway" || type === "router" || type === "gateway") return "gateway";
  if (n.kind === "server" || type === "server") return "server";
  if (n.kind === "bluetooth") return "bluetooth";
  if (n.kind === "cell") return "cell";
  if (roles.includes("station") || type === "wireless client" || n.medium === "wireless") return "wireless";
  return "host";
}

function edgeLabel(link) {
  if (isManualLink(link)) return `${MANUAL_MARK} ${link.label || MANUAL_KIND_NAMES[link.kind] || ""}`.trim();
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

/* ---------- Undo and redo ---------- */
// Each entry holds only the maps an action touched, not the whole session. Undo and redo
// change map contents only (devices, links, names, notes, positions): never the
// clipboard, the Surveys list, or the order you've put the Maps list in.

function captureMaps(label, ids) {
  return {
    label,
    activeMapId: state.activeMapId,
    order: state.maps.map((m) => m.id),
    maps: ids.map((id) => [id, getMap(id) ? cloneData(serializeMap(getMap(id))) : null]),
    meta: metaSnapshot(ids),
  };
}

function snapshotUndo(label, mapIds) {
  const ids = [...new Set(mapIds.filter(Boolean))];
  state.undo.push(captureMaps(label, ids));
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = []; // a new change starts a new branch of history
  syncUndoUi();
}

// Put the touched maps back the way an entry recorded them.
function applyMapsSnapshot(entry) {
  const ids = entry.maps.map(([id]) => id);
  for (const [id, snap] of entry.maps) {
    const existing = getMap(id);
    if (snap) {
      if (existing) Object.assign(existing, normalizeMap(snap));
      else {
        // A map coming back goes where it was, before the next map that still exists.
        const later = entry.order.slice(entry.order.indexOf(id) + 1).find((other) => getMap(other));
        const at = later ? state.maps.findIndex((m) => m.id === later) : state.maps.findIndex((m) => m.kind === "unwanted");
        state.maps.splice(at < 0 ? state.maps.length : at, 0, normalizeMap(snap));
      }
    } else if (existing) {
      state.maps = state.maps.filter((m) => m.id !== id);
      store.deletedMaps.add(id);
    }
    markMapDirty(id);
  }
  restoreMetaSnapshot(ids, entry.meta);
  markSessionDirty();
  // Show the map that changed: the one you were on if it's among them, else the first.
  // If the map you were on went away (say, undoing a new map), go back to where you were before.
  const target =
    [entry.activeMapId, ...ids].find((id) => ids.includes(id) && getMap(id)) ||
    (getMap(state.activeMapId) ? state.activeMapId : getMap(entry.activeMapId) ? entry.activeMapId : state.maps[0]?.id);
  showMap(target, { fit: target !== state.activeMapId });
}

function undoLast() {
  const entry = state.undo.pop();
  if (!entry) {
    syncUndoUi();
    toast("Nothing to undo.", { timeout: 1800 });
    return;
  }
  if (entry.type === "positions") {
    applyPositions(entry, "before");
    state.redo.push(entry);
    syncUndoUi();
    toast(`Undid ${entry.label}.`, { timeout: 2500, action: { label: "Redo", onClick: redoLast } });
    return;
  }
  state.redo.push(captureMaps(entry.label, entry.maps.map(([id]) => id)));
  if (state.redo.length > UNDO_LIMIT) state.redo.shift();
  applyMapsSnapshot(entry);
  syncUndoUi();
  toast(`Undid ${entry.label}.`, { timeout: 4000, action: { label: "Redo", onClick: redoLast } });
}

function redoLast() {
  const entry = state.redo.pop();
  if (!entry) {
    syncUndoUi();
    toast("Nothing to redo.", { timeout: 1800 });
    return;
  }
  if (entry.type === "positions") {
    applyPositions(entry, "after");
    state.undo.push(entry);
    syncUndoUi();
    toast(`Redid ${entry.label}.`, { undo: true, timeout: 2500 });
    return;
  }
  state.undo.push(captureMaps(entry.label, entry.maps.map(([id]) => id)));
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  applyMapsSnapshot(entry);
  syncUndoUi();
  toast(`Redid ${entry.label}.`, { undo: true, timeout: 4000 });
}

/* Drags: one undo step per drag, holding just where the moved devices were and went. */

const dragUndo = { before: null, mapId: null, timer: 0, freeTimer: 0 };

function noteDragStart(target) {
  const map = getMap(state.activeMapId);
  if (!map) return;
  if (!dragUndo.before || dragUndo.mapId !== map.id) {
    dragUndo.before = new Map();
    dragUndo.mapId = map.id;
  }
  const nodes = target.isParent() ? target.descendants() : target;
  nodes.forEach((n) => {
    if (n.isParent() || dragUndo.before.has(n.id())) return;
    const saved = map.positions?.[n.id()];
    dragUndo.before.set(n.id(), { pos: { ...n.position() }, saved: saved ? { ...saved } : null });
  });
}

function commitDrag() {
  dragUndo.timer = 0;
  const before = dragUndo.before;
  const map = getMap(dragUndo.mapId);
  dragUndo.before = null;
  if (!before || !map || !state.cy) return;
  const moves = [];
  for (const [id, b] of before) {
    const node = state.cy.getElementById(id);
    if (!node.length) continue;
    const after = { ...node.position() };
    if (Math.abs(after.x - b.pos.x) < 0.5 && Math.abs(after.y - b.pos.y) < 0.5) continue;
    moves.push({ id, before: b.pos, after, savedBefore: b.saved, savedAfter: { ...after } });
  }
  if (!moves.length) return;
  const label = moves.length === 1 ? `move ${displayName(nodeById(moves[0].id)) || "device"}` : `move ${moves.length} devices`;
  state.undo.push({ type: "positions", label, mapId: map.id, moves });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
  syncUndoUi();
}

// Put dragged devices back ("before") or where they were dropped ("after").
function applyPositions(entry, which) {
  const map = getMap(entry.mapId);
  if (!map) return;
  map.positions = map.positions || {};
  for (const m of entry.moves) {
    const saved = which === "before" ? m.savedBefore : m.savedAfter;
    if (saved) map.positions[m.id] = { ...saved };
    else delete map.positions[m.id];
  }
  markMapDirty(map.id);
  if (state.activeMapId !== map.id) {
    showMap(map.id, { fit: true });
    return;
  }
  for (const m of entry.moves) state.cy?.getElementById(m.id).position({ ...m[which] });
}

function syncUndoUi() {
  const undo = el("btn-undo");
  const redo = el("btn-redo");
  const last = state.undo[state.undo.length - 1];
  const next = state.redo[state.redo.length - 1];
  undo.disabled = !last;
  undo.title = last ? `Undo ${last.label} (Ctrl+Z)` : "Nothing to undo";
  redo.disabled = !next;
  redo.title = next ? `Redo ${next.label} (Ctrl+Y)` : "Nothing to redo";
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
    // Room for each client along the ring, so neighbours clear each other at the sides too.
    const r = Math.max(130, (k * 150) / (2 * Math.PI));
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

/* ---------- Time: display settings ---------- */
// Captures record exact moments (UTC). Settings → General → Time chooses how they're shown.

const timeFormats = new Map();

function timeZoneSetting() {
  return state.prefs.timeZone || undefined; // undefined: this computer's zone
}

function formatTime(ts, { date = false, seconds = true } = {}) {
  if (ts == null || !Number.isFinite(ts)) return "";
  const key = `${state.prefs.timeZone}|${state.prefs.clock}|${date}|${seconds}`;
  if (!timeFormats.has(key)) {
    const opts = { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) };
    if (date) Object.assign(opts, { year: "numeric", month: "short", day: "numeric" });
    if (state.prefs.clock === "12") opts.hour12 = true;
    else if (state.prefs.clock === "24") opts.hourCycle = "h23";
    try {
      timeFormats.set(key, new Intl.DateTimeFormat(undefined, { ...opts, timeZone: timeZoneSetting() }));
    } catch {
      timeFormats.set(key, new Intl.DateTimeFormat(undefined, opts)); // an unknown zone: fall back to local
    }
  }
  return timeFormats.get(key).format(new Date(ts * 1000));
}

function timeZoneLabel() {
  const zone = state.prefs.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    const name = zone.replace(/_/g, " ");
    return part && part.value !== zone ? `${name} (${part.value})` : name;
  } catch {
    return zone;
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h} h${m ? ` ${m} min` : ""}`;
}

function fillTimeSettings() {
  const select = el("settings-tz");
  if (!select.options.length) {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let zones = [];
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = [here, "UTC"];
    }
    select.innerHTML =
      `<option value="">This computer (${escapeHtml(here.replace(/_/g, " "))})</option><option value="UTC">UTC</option>` +
      zones.filter((z) => z !== "UTC").map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z.replace(/_/g, " "))}</option>`).join("");
  }
  select.value = state.prefs.timeZone || "";
  document.querySelectorAll('input[name="clock"]').forEach((r) => (r.checked = r.value === (state.prefs.clock || "auto")));
  el("settings-time-sample").textContent = `Now: ${formatTime(Date.now() / 1000, { date: true })} · ${timeZoneLabel()}`;
}

function onTimeSettingsChanged() {
  timeFormats.clear();
  savePrefs();
  fillTimeSettings();
  renderTimeline();
  renderInspector();
}

/* ---------- Timeline ---------- */
// Devices and links remember when they were heard ([[start, end], ...] in Unix seconds).
// The timeline under the map picks a window; devices and links not heard in it are hidden,
// and nothing moves. Devices without times (NetXML, CSV, devices you add) always show.

const TL_STEPS = 1000;
const TL_BARS = 160;
const TL_MIN_SECONDS = 5;
const timeline = { cacheVersion: -1, data: null, raf: 0 };

const hasSeen = (item) => Array.isArray(item?.seen) && item.seen.length > 0;
const seenIn = (item, [a, b]) => item.seen.some(([s, e]) => s <= b && e >= a);

function timeData() {
  if (timeline.cacheVersion === state.graphVersion) return timeline.data;
  timeline.cacheVersion = state.graphVersion;
  const nodes = (state.graph?.nodes || []).filter((n) => isDeviceNode(n));
  let start = Infinity;
  let end = -Infinity;
  for (const item of [...nodes, ...(state.graph?.links || [])]) {
    for (const [s, e] of item.seen || []) {
      if (s < start) start = s;
      if (e > end) end = e;
    }
  }
  // A capture only seconds long has no window worth choosing.
  if (!Number.isFinite(start) || end - start < TL_MIN_SECONDS) {
    timeline.data = null;
    return null;
  }
  // How many devices were active in each slice of the capture, for the chart.
  const bars = new Array(TL_BARS).fill(0);
  const span = end - start;
  for (const n of nodes) {
    const hit = new Set();
    for (const [s, e] of n.seen || []) {
      const i0 = Math.max(0, Math.floor(((s - start) / span) * TL_BARS));
      const i1 = Math.min(TL_BARS - 1, Math.floor(((e - start) / span) * TL_BARS));
      for (let i = i0; i <= i1; i += 1) hit.add(i);
    }
    hit.forEach((i) => (bars[i] += 1));
  }
  const timed = nodes.filter(hasSeen).length;
  timeline.data = { start, end, bars, timed, untimed: nodes.length - timed };
  return timeline.data;
}

function currentWindow() {
  const map = getMap(state.activeMapId);
  return map?.timeWindow || null;
}

function sliderToTime(v, data) {
  return data.start + ((data.end - data.start) * v) / TL_STEPS;
}

// Shows or hides devices and links for the time window. Called after every render.
function applyTimeWindow() {
  const cy = state.cy;
  const win = currentWindow();
  if (!cy) return;
  cy.batch(() => {
    cy.elements(".time-out").removeClass("time-out");
    if (!win) return;
    cy.nodes().forEach((n) => {
      if (n.isParent()) return;
      const raw = state.nodeIndex.get(n.id());
      if (raw && isDeviceNode(raw) && hasSeen(raw) && !seenIn(raw, win)) n.addClass("time-out");
    });
    for (const l of state.graph?.links || []) {
      if (hasSeen(l) && !seenIn(l, win)) cy.getElementById(l.id).addClass("time-out");
    }
    // A subnet box with nothing left in it goes too.
    cy.nodes(":parent").forEach((p) => {
      if (p.children().not(".time-out").length === 0) p.addClass("time-out");
    });
  });
}

function devicesInWindow() {
  const win = currentWindow();
  const devices = (state.graph?.nodes || []).filter((n) => isDeviceNode(n));
  if (!win) return { shown: devices.length, total: devices.length };
  return { shown: devices.filter((n) => !hasSeen(n) || seenIn(n, win)).length, total: devices.length };
}

function renderTimeline() {
  const data = timeData();
  const map = getMap(state.activeMapId);
  document.querySelectorAll(".tl-only").forEach((n) => n.classList.toggle("hidden", !data));
  const open = Boolean(data) && map?.timelineOpen !== false;
  show("timeline", open);
  el("tl-toggle").setAttribute("aria-pressed", String(open));
  el("stage").classList.toggle("has-timeline", open);
  if (!open) return;
  el("stage").style.setProperty("--tl-h", `${el("timeline").offsetHeight + 8}px`);
  const win = currentWindow();
  const from = win ? Math.round(((win[0] - data.start) / (data.end - data.start)) * TL_STEPS) : 0;
  const to = win ? Math.round(((win[1] - data.start) / (data.end - data.start)) * TL_STEPS) : TL_STEPS;
  el("tl-from").value = String(from);
  el("tl-to").value = String(to);
  const sameDay = formatTime(data.start, { date: true }).split(",")[0] === formatTime(data.end, { date: true }).split(",")[0];
  el("tl-start").textContent = formatTime(data.start, { date: true });
  el("tl-end").textContent = sameDay ? formatTime(data.end) : formatTime(data.end, { date: true });
  el("tl-note").textContent = `${timeZoneLabel()}${data.untimed ? ` · ${plural(data.untimed, "device")} without times always shown` : ""}`;
  const a = win ? win[0] : data.start;
  const b = win ? win[1] : data.end;
  el("tl-window").textContent = win ? `${formatTime(a)} – ${formatTime(b)} (${formatDuration(b - a)})` : `Whole capture (${formatDuration(data.end - data.start)})`;
  const { shown, total } = devicesInWindow();
  el("tl-count").textContent = win ? `${shown.toLocaleString()} of ${plural(total, "device")}` : plural(total, "device");
  el("tl-reset").disabled = !win;
  show("tl-newmap", Boolean(win));
  const sel = el("tl-sel");
  sel.style.left = `${(from / TL_STEPS) * 100}%`;
  sel.style.width = `${((to - from) / TL_STEPS) * 100}%`;
  drawTimelineChart(data);
}

function drawTimelineChart(data) {
  const canvas = el("tl-chart");
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...data.bars);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue("--accent").trim() || "#e0a84a";
  ctx.globalAlpha = 0.55;
  const bw = w / data.bars.length;
  data.bars.forEach((v, i) => {
    if (!v) return;
    const bh = Math.max(2, (v / max) * (h - 6));
    ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  });
}

function setTimeWindowFromSliders(moved) {
  const data = timeData();
  const map = getMap(state.activeMapId);
  if (!data || !map) return;
  let from = Number(el("tl-from").value);
  let to = Number(el("tl-to").value);
  if (from > to) {
    // The handles can't cross: the one being dragged stops at the other.
    if (moved === "from") from = to;
    else to = from;
    el("tl-from").value = String(from);
    el("tl-to").value = String(to);
  }
  map.timeWindow = from <= 0 && to >= TL_STEPS ? null : [sliderToTime(from, data), sliderToTime(to, data)];
  cancelAnimationFrame(timeline.raf);
  timeline.raf = requestAnimationFrame(() => {
    applyTimeWindow();
    renderTimeline();
    updateStatusTime();
  });
}

function resetTimeWindow() {
  const map = getMap(state.activeMapId);
  if (map) map.timeWindow = null;
  applyTimeWindow();
  renderTimeline();
  updateStatusTime();
}

function updateStatusTime() {
  const win = currentWindow();
  const status = el("status");
  status.querySelector(".status-time")?.remove();
  if (!win) return;
  const { shown, total } = devicesInWindow();
  const tag = document.createElement("span");
  tag.className = "status-time";
  tag.textContent = ` · ${shown.toLocaleString()} in time window`;
  status.appendChild(tag);
}

function seenFacts(item) {
  if (!hasSeen(item)) return "";
  const first = item.seen[0][0];
  const last = item.seen[item.seen.length - 1][1];
  const active = item.seen.reduce((s, [a, b]) => s + (b - a), 0);
  const periods = item.seen.length > 1 ? ` in ${item.seen.length} periods` : "";
  return `${factRow("First seen", formatTime(first, { date: true }))}${factRow("Last seen", formatTime(last, { date: true }))}${factRow("Active", `${formatDuration(active)}${periods}`)}`;
}

// A separate map with only what was heard in the window: devices and links active in it
// (plus anything without times, such as devices you added), their activity trimmed to the
// window, with names, notes, and edits carried over. It lays out fresh.
function mapFromTimeWindow() {
  const win = currentWindow();
  const src = getMap(state.activeMapId);
  if (!win || !src || !state.graph) return;
  const [a, b] = win;
  const { nodes, links } = sliceGraph(state.graph, win);
  const devices = nodes.filter((n) => isDeviceNode(n));
  if (!devices.length) {
    toast("Nothing was heard in this window, so there's nothing to put on a new map.", { timeout: 3500 });
    return;
  }
  const name = `${src.name} · ${formatTime(a, { seconds: true })}–${formatTime(b, { seconds: true })}`;
  const id = `map:window-${Date.now().toString(36)}`;
  const label = `${formatTime(a, { date: true })} – ${formatTime(b, { date: true })} (${timeZoneLabel()})`;
  snapshotUndo("new map from time window", [id]);
  upsertMap({
    id,
    name,
    kind: "window",
    sourceId: null,
    captures: src.captures || [],
    graph: { ...state.graph, title: name, nodes, links, meta: { ...(state.graph.meta || {}), time_start: a, time_end: b, time_window: label, from_map: src.name } },
  });
  // Names, captions, notes, and field edits come too.
  for (const n of nodes) {
    const meta = getDeviceMeta(n.id);
    if (meta && Object.keys(meta).length) metaCache[metaKey(id, n.id)] = cloneData(meta);
  }
  markMetaDirty();
  markSessionDirty();
  showMap(id);
  toast(`Made “${name}” with ${plural(devices.length, "device")} from the time window.`, { undo: true, timeout: 5000 });
}

/* ---------- Compare surveys ---------- */

// A baseline survey and one or more later ones (whole, or a window of their timeline) make a
// map of what changed: red left or disappeared, green joined or new, blue anything else.
const CHANGE_COLORS = { gone: "#e5484d", detached: "#e5484d", new: "#30a46c", attached: "#30a46c", changed: "#3e8ef7" };
const CHANGE_GROUPS = [
  { key: "left", name: "Left or no longer seen", statuses: ["detached", "gone"], color: CHANGE_COLORS.gone, mark: "−" },
  { key: "joined", name: "Joined or new", statuses: ["attached", "new"], color: CHANGE_COLORS.new, mark: "+" },
  { key: "changed", name: "Other changes", statuses: ["changed"], color: CHANGE_COLORS.changed, mark: "Δ" },
];
const COMPARE_STEPS = 1000;
const compare = { cache: new Map() };

const isComparison = (map) => map?.kind === "compare";
const vis = (node, on) => node?.classList.toggle("hidden", !on);
const changeOf = (item) => item?.extra?.change || null;

// Just what was heard in a time window: the same cut "New map from this window" makes.
function sliceGraph(graph, win) {
  if (!win) return graph;
  const [a, b] = win;
  const clip = (item) => {
    const copy = cloneData(item);
    if (hasSeen(copy)) copy.seen = copy.seen.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => s <= e);
    return copy;
  };
  const devices = graph.nodes.filter((n) => isDeviceNode(n) && (!hasSeen(n) || seenIn(n, win)));
  const kept = new Set(devices.map((n) => n.id));
  const nets = graph.nodes.filter((n) => !isDeviceNode(n));
  const linkOk = (l) => (!hasSeen(l) || seenIn(l, win)) && (kept.has(l.source) || kept.has(l.target));
  // A subnet or VLAN stays if any of its devices does.
  const keptNets = nets.filter((n) => (n.extra?.members || []).some((m) => kept.has(m)) || graph.links.some((l) => linkOk(l) && (l.source === n.id || l.target === n.id)));
  keptNets.forEach((n) => kept.add(n.id));
  const nodes = [...devices, ...keptNets].map(clip);
  for (const n of nodes) if (Array.isArray(n.extra?.members)) n.extra.members = n.extra.members.filter((m) => kept.has(m));
  const links = graph.links.filter((l) => linkOk(l) && kept.has(l.source) && kept.has(l.target)).map(clip);
  return { ...graph, nodes, links, meta: { ...(graph.meta || {}), time_start: a, time_end: b } };
}

function graphSpan(graph) {
  let start = Infinity;
  let end = -Infinity;
  for (const item of [...(graph?.nodes || []).filter(isDeviceNode), ...(graph?.links || [])]) {
    for (const [s, e] of item.seen || []) {
      if (s < start) start = s;
      if (e > end) end = e;
    }
  }
  return Number.isFinite(start) && end - start >= TL_MIN_SECONDS ? { start, end } : null;
}

// Whether a map or survey has a timeline. Formats that never record times are known before
// a survey is opened; anything opened is checked (once per graph).
const UNTIMED_KINDS = new Set(["kismet-netxml", "kismet-csv", "airodump-csv"]);
const spanCache = new WeakMap();
function hasTimeline(graph) {
  if (!graph) return null;
  if (!spanCache.has(graph)) spanCache.set(graph, Boolean(graphSpan(graph)));
  return spanCache.get(graph);
}
function surveyHasTimeline(item) {
  const own = getMap(`map:${item.id}`);
  if (own && mapNodeCount(own)) return hasTimeline(own.graph);
  if (item.graph) return hasTimeline(item.graph);
  return UNTIMED_KINDS.has(item.format) ? false : null; // null: unknown until it's opened
}
const NO_TIMELINE = "no timeline";

function compareChoices() {
  const maps = state.maps.filter((m) => m.kind !== "unwanted" && !isComparison(m) && mapNodeCount(m) > 0);
  const opened = new Set(maps.map((m) => m.id));
  const surveys = state.surveys.filter((s) => !opened.has(`map:${s.id}`) && s.id !== "empty-capture");
  return [
    ...maps.map((m) => ({ value: `m|${m.id}`, label: `${m.name} · ${plural(mapNodeCount(m), "device")}${hasTimeline(m.graph) ? "" : ` · ${NO_TIMELINE}`}` })),
    ...surveys.map((s) => ({ value: `s|${s.id}`, label: `${s.name} (not opened yet)${surveyHasTimeline(s) === false ? ` · ${NO_TIMELINE}` : ""}` })),
  ];
}

async function compareSource(value) {
  if (compare.cache.has(value)) return compare.cache.get(value);
  const [type, id] = [value.slice(0, 1), value.slice(2)];
  let src = null;
  if (type === "m") {
    const map = getMap(id);
    if (map) src = { name: map.name, graph: map.graph, mapId: map.id, window: map.timeWindow || null };
  } else {
    const item = state.surveys.find((s) => s.id === id);
    if (item) {
      const loaded = await surveySource(item);
      src = { name: item.name, graph: loaded.graph, mapId: getMap(loaded.id) ? loaded.id : null, window: null };
    }
  }
  if (src) {
    src.span = graphSpan(src.graph);
    compare.cache.set(value, src);
  }
  return src;
}

function compareRow(role, preset = {}) {
  const row = document.createElement("fieldset");
  row.className = "compare-row";
  row.dataset.role = role;
  const options = compareChoices()
    .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
    .join("");
  row.innerHTML = `
    <legend>${role === "baseline" ? "Baseline" : "Compare with"}</legend>
    <div class="compare-pick">
      <select class="compare-source" aria-label="${role === "baseline" ? "Baseline survey" : "Later survey"}">
        <option value="">Choose a survey or map…</option>${options}
      </select>
      ${role === "later" ? '<button type="button" class="icon-btn compare-remove" aria-label="Remove this survey" title="Remove"><svg class="icon"><use href="#i-x" /></svg></button>' : ""}
    </div>
    <div class="compare-time hidden">
      <div class="compare-time-head"><span class="compare-time-title">This capture's time window</span><button type="button" class="link-btn compare-whole">Whole capture</button></div>
      <canvas class="compare-chart" aria-hidden="true"></canvas>
      <div class="compare-ends"><span class="compare-start"></span><span class="compare-end"></span></div>
      <p class="compare-time-label"></p>
      <label class="compare-slider"><span>From</span><input type="range" class="compare-from" min="0" max="${COMPARE_STEPS}" step="1" value="0" /></label>
      <label class="compare-slider"><span>To</span><input type="range" class="compare-to" min="0" max="${COMPARE_STEPS}" step="1" value="${COMPARE_STEPS}" /></label>
    </div>
    <p class="hint compare-note hidden"></p>`;
  const select = row.querySelector(".compare-source");
  const from = row.querySelector(".compare-from");
  const to = row.querySelector(".compare-to");
  const at = (v, span) => span.start + ((span.end - span.start) * Number(v)) / COMPARE_STEPS;
  const step = (t, span) => Math.round(((t - span.start) / (span.end - span.start)) * COMPARE_STEPS);
  const syncLabel = () => {
    const span = row._src?.span;
    if (!span) return;
    const whole = Number(from.value) <= 0 && Number(to.value) >= COMPARE_STEPS;
    row._win = whole ? null : [at(from.value, span), at(to.value, span)];
    const [a, b] = row._win || [span.start, span.end];
    row.querySelector(".compare-time-label").textContent = `${whole ? "All of it: " : "Compares "}${formatTime(a, { date: true })} – ${formatTime(b, { date: true })} (${formatDuration(b - a)})`;
    row.querySelector(".compare-whole").classList.toggle("hidden", whole);
    drawCompareChart(row, Number(from.value) / COMPARE_STEPS, Number(to.value) / COMPARE_STEPS);
  };
  const load = async (win) => {
    row._src = null;
    row._win = null;
    vis(row.querySelector(".compare-time"), false);
    const note = row.querySelector(".compare-note");
    vis(note, false);
    if (!select.value) return;
    try {
      row._src = await compareSource(select.value);
    } catch (err) {
      fail(err);
      return;
    }
    const span = row._src?.span;
    if (!span) {
      note.textContent = "No timeline: this survey doesn't record when devices were heard (NetXML and CSV surveys don't), so all of it is compared.";
      vis(note, true);
      return;
    }
    const w = win === undefined ? row._src.window : win;
    row._bars = activityBars(row._src.graph, span, 72);
    row.querySelector(".compare-start").textContent = formatTime(span.start, { date: true });
    row.querySelector(".compare-end").textContent = formatTime(span.end, { date: true });
    from.value = String(w ? Math.max(0, step(w[0], span)) : 0);
    to.value = String(w ? Math.min(COMPARE_STEPS, step(w[1], span)) : COMPARE_STEPS);
    vis(row.querySelector(".compare-time"), true);
    syncLabel();
  };
  select.addEventListener("change", () => {
    el("compare-error").classList.add("hidden");
    load();
  });
  for (const [input, other, low] of [[from, to, true], [to, from, false]]) {
    input.addEventListener("input", () => {
      // The handles can't cross.
      if (low ? Number(input.value) > Number(other.value) : Number(input.value) < Number(other.value)) input.value = other.value;
      syncLabel();
    });
  }
  row.querySelector(".compare-whole").addEventListener("click", () => {
    from.value = "0";
    to.value = String(COMPARE_STEPS);
    syncLabel();
  });
  row.querySelector(".compare-remove")?.addEventListener("click", () => {
    row.remove();
    syncCompareRows();
  });
  if (preset.value && [...select.options].some((o) => o.value === preset.value)) {
    select.value = preset.value;
    load(preset.window);
  }
  return row;
}

// How many devices were heard in each slice of a capture, like the timeline's chart.
function activityBars(graph, span, count) {
  const bars = new Array(count).fill(0);
  const width = span.end - span.start;
  for (const n of (graph?.nodes || []).filter(isDeviceNode)) {
    const hit = new Set();
    for (const [s, e] of n.seen || []) {
      const i0 = Math.max(0, Math.floor(((s - span.start) / width) * count));
      const i1 = Math.min(count - 1, Math.floor(((e - span.start) / width) * count));
      for (let i = i0; i <= i1; i += 1) hit.add(i);
    }
    hit.forEach((i) => (bars[i] += 1));
  }
  return bars;
}

function drawCompareChart(row, from, to) {
  const canvas = row.querySelector(".compare-chart");
  const bars = row._bars || [];
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h || !bars.length) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#e0a84a";
  // The chosen window, then the bars: bright inside it, faint outside.
  ctx.fillStyle = css.getPropertyValue("--accent-soft").trim() || "rgba(224,168,74,0.14)";
  ctx.fillRect(from * w, 0, Math.max(2, (to - from) * w), h);
  const max = Math.max(1, ...bars);
  const bw = w / bars.length;
  bars.forEach((v, i) => {
    if (!v) return;
    const mid = (i + 0.5) / bars.length;
    ctx.globalAlpha = mid >= from && mid <= to ? 0.85 : 0.22;
    ctx.fillStyle = accent;
    const bh = Math.max(2, (v / max) * (h - 4));
    ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.fillRect(Math.min(w - 2, from * w), 0, 2, h);
  ctx.fillRect(Math.max(0, to * w - 2), 0, 2, h);
}

function syncCompareRows() {
  const laters = el("compare-rows").querySelectorAll('.compare-row[data-role="later"]');
  laters.forEach((r) => vis(r.querySelector(".compare-remove"), laters.length > 1));
  el("compare-add").disabled = laters.length >= 5;
}

function openCompareDialog({ baseline = null, later = null } = {}) {
  if (compareChoices().length < 1) {
    toast("Open a survey first, then compare it with another.", { timeout: 3000 });
    return;
  }
  compare.cache.clear();
  const rows = el("compare-rows");
  rows.innerHTML = "";
  rows.appendChild(compareRow("baseline", baseline || {}));
  rows.appendChild(compareRow("later", later || {}));
  el("compare-error").classList.add("hidden");
  syncCompareRows();
  el("compare-dialog").showModal();
  rows.querySelector(".compare-source").focus();
}

function compareSourceFor(kind, id) {
  return kind === "map" ? { value: `m|${id}`, window: getMap(id)?.timeWindow || null } : getMap(`map:${id}`) && mapNodeCount(getMap(`map:${id}`)) ? { value: `m|map:${id}` } : { value: `s|${id}` };
}

function windowLabel(src, win) {
  return win ? `${src.name} (${formatTime(win[0])}–${formatTime(win[1])})` : src.name;
}

async function runCompare() {
  const rows = [...el("compare-rows").querySelectorAll(".compare-row")];
  const [base, ...laters] = rows;
  const error = (msg) => {
    el("compare-error").textContent = msg;
    el("compare-error").classList.remove("hidden");
  };
  if (!base._src) return error("Choose a baseline.");
  const picked = laters.filter((r) => r._src);
  if (!picked.length) return error("Choose a survey to compare with the baseline.");
  const same = picked.find((r) => r.querySelector(".compare-source").value === base.querySelector(".compare-source").value && JSON.stringify(r._win) === JSON.stringify(base._win));
  if (same) return error("That's the baseline itself. Pick another survey, or a different time window.");
  el("compare-dialog").close();
  const baseGraph = sliceGraph(base._src.graph, base._win);
  const baseName = windowLabel(base._src, base._win);
  const made = [];
  setBusy(true, "Comparing…");
  try {
    for (const row of picked) {
      const laterName = windowLabel(row._src, row._win);
      const result = await parseResponse(
        await fetch("/api/compare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseline: baseGraph, later: sliceGraph(row._src.graph, row._win), baseline_name: baseName, later_name: laterName }),
        })
      );
      made.push({ result, name: `Changes: ${baseName} → ${laterName}`, baseMap: base._src.mapId, laterMap: row._src.mapId });
    }
  } catch (err) {
    setBusy(false);
    fail(err);
    return;
  }
  setBusy(false);
  const stamp = Date.now().toString(36);
  const ids = made.map((_, i) => `map:compare-${stamp}-${i}`);
  snapshotUndo("compare surveys", ids);
  made.forEach(({ result, name, baseMap, laterMap }, i) => {
    upsertMap({ id: ids[i], name, kind: "compare", sourceId: null, captures: [], graph: { ...result, title: name } });
    // Names, captions, and notes you gave devices come along: from the later survey, or the
    // baseline for devices only it has.
    for (const n of result.nodes) {
      const prev = changeOf(n)?.previous_id;
      const has = (m) => m && Object.keys(m).length > 0;
      const later = laterMap ? getDeviceMeta(n.id, laterMap) : null;
      const meta = has(later) ? later : baseMap ? getDeviceMeta(prev || n.id, baseMap) : null;
      if (has(meta)) metaCache[metaKey(ids[i], n.id)] = cloneData(meta);
    }
  });
  markMetaDirty();
  markSessionDirty();
  showMap(ids[0]);
  openLayersPanel();
  const counts = made[0].result.meta.comparison.devices;
  const total = counts.gone + counts.detached + counts.new + counts.attached + counts.changed;
  toast(
    made.length > 1
      ? `Made ${made.length} comparison maps. Showing the first: ${plural(total, "change")}.`
      : total
        ? `Found ${plural(total, "change")}: ${counts.gone + counts.detached} left, ${counts.new + counts.attached} joined, ${counts.changed} other.`
        : "No changes found: every device is where it was.",
    { undo: true, timeout: 6000 }
  );
}

function bindCompareDialog() {
  const dialog = el("compare-dialog");
  el("compare-cancel").addEventListener("click", () => dialog.close());
  el("compare-add").addEventListener("click", () => {
    el("compare-rows").appendChild(compareRow("later"));
    syncCompareRows();
  });
  el("compare-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runCompare();
  });
  el("btn-compare").addEventListener("click", () => openCompareDialog());
  el("tl-compare").addEventListener("click", () => {
    const map = getMap(state.activeMapId);
    if (map) openCompareDialog({ later: { value: `m|${map.id}`, window: map.timeWindow || null } });
  });
  el("change-unchanged").addEventListener("change", (e) => {
    const map = getMap(state.activeMapId);
    if (!map) return;
    map.hideUnchanged = !e.target.checked;
    markMapDirty(map.id);
    renderMap({ fit: true });
  });
}

// The short line under a changed device's name, so the map reads without the colours too.
function changeTag(change) {
  if (!change || change.status === "same") return "";
  const reasons = (change.reasons || []).filter((r) => !/^New since|^Not seen in|^Same device as/.test(r));
  const first = String(reasons[0] || "").replace(/Wi-Fi /g, "");
  const short = (text) => (text.length > 30 ? `${text.slice(0, 29)}…` : text);
  if (change.status === "gone") return "− No longer seen";
  if (change.status === "new") return "+ New device";
  if (change.status === "attached") return `+ ${short(first || "Joined")}`;
  if (change.status === "detached") return `− ${short(first || "Left")}`;
  if (/^MAC changed/.test(first)) return "Δ MAC changed";
  if (/^Possible rogue/.test(first)) return "Δ Possible rogue AP";
  if (/^Moved from .+ to /.test(first)) return `Δ ${short(`Moved to ${first.split(" to ").pop()}`)}`;
  if (/^Roamed/.test(first)) return "Δ Roamed";
  return `Δ ${short(first.includes(" from ") ? first.split(" from ")[0] : first.split(":")[0])}`;
}

function changeSection(item, { link = false } = {}) {
  const change = changeOf(item);
  if (!change || !isComparison(getMap(state.activeMapId))) return "";
  if (link) {
    const text = { removed: "Gone since the baseline", added: "New since the baseline", same: "In both surveys" }[change.status] || "";
    return text ? `<div class="insp-section"><h3>Changes</h3><p class="change-line" style="--c: ${change.status === "removed" ? CHANGE_COLORS.gone : change.status === "added" ? CHANGE_COLORS.new : "var(--muted)"}">${escapeHtml(text)}</p></div>` : "";
  }
  const group = CHANGE_GROUPS.find((g) => g.statuses.includes(change.status));
  const reasons = change.reasons?.length ? change.reasons : ["Nothing NetSeer can see changed."];
  return `<div class="insp-section"><h3>Changes</h3><ul class="change-list" style="--c: ${group ? group.color : "var(--muted)"}">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>`;
}

function renderChangeLegend() {
  const map = getMap(state.activeMapId);
  const box = el("change-legend");
  vis(box, isComparison(map));
  if (!isComparison(map)) return;
  const comp = map.graph?.meta?.comparison || {};
  const counts = comp.devices || {};
  el("change-from").textContent = `${comp.baseline || "Baseline"} → ${comp.later || "later survey"}`;
  el("change-counts").innerHTML = [
    ...CHANGE_GROUPS.map((g) => `<li><i class="change-swatch" style="--c: ${g.color}"></i><span>${escapeHtml(g.name)}</span><b>${g.statuses.reduce((s, k) => s + (counts[k] || 0), 0).toLocaleString()}</b></li>`),
    `<li><i class="change-swatch same"></i><span>Unchanged</span><b>${(counts.same || 0).toLocaleString()}</b></li>`,
    `<li><i class="change-line-sample removed"></i><span>Link gone</span><b>${(comp.links?.removed || 0).toLocaleString()}</b></li>`,
    `<li><i class="change-line-sample added"></i><span>Link new</span><b>${(comp.links?.added || 0).toLocaleString()}</b></li>`,
  ].join("");
  el("change-unchanged").checked = !map.hideUnchanged;
}

function bindTimeline() {
  el("tl-from").addEventListener("input", () => setTimeWindowFromSliders("from"));
  el("tl-to").addEventListener("input", () => setTimeWindowFromSliders("to"));
  el("tl-reset").addEventListener("click", resetTimeWindow);
  el("tl-newmap").addEventListener("click", mapFromTimeWindow);
  const toggle = (open) => {
    const map = getMap(state.activeMapId);
    if (!map) return;
    map.timelineOpen = open;
    if (!open) map.timeWindow = null; // hiding the timeline shows everything again
    applyTimeWindow();
    renderTimeline();
    updateStatusTime();
  };
  el("tl-close").addEventListener("click", () => toggle(false));
  el("tl-toggle").addEventListener("click", () => toggle(el("tl-toggle").getAttribute("aria-pressed") !== "true"));
  el("settings-tz").addEventListener("change", (e) => {
    state.prefs.timeZone = e.target.value;
    onTimeSettingsChanged();
  });
  document.querySelectorAll('input[name="clock"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.prefs.clock = r.value;
      onTimeSettingsChanged();
    })
  );
  window.addEventListener("resize", () => {
    if (!el("timeline").classList.contains("hidden")) renderTimeline();
  });
}

/* ---------- Layout: by connection ---------- */
// Devices that are linked sit together. Each group of linked devices is a cluster, biggest
// first; inside it the busiest device (a gateway, switch, or access point) is in the middle
// and what it connects to is arranged in rings around it, each branch in its own slice, so
// lines stay short and rarely cross. Unconnected devices follow in a grid, then the subnet
// and VLAN labels. Deterministic, like the subnet layout: the same map lays out the same way.

const CONNECTION_KINDS = new Set(["l2", "l3", "client-server", "wireless", "bridge", "manual"]);
// Which link to follow first when two devices could be reached several ways.
const KIND_PRIORITY = { wireless: 0, l2: 1, bridge: 2, manual: 3, "client-server": 4, l3: 5 };
const RING_STEP = 210;
const NODE_ARC = 150; // room each device needs along a ring
const FAN_LIMIT = 12; // more leaves than this under one device: stagger them on two rings
const FAN_OFFSET = 150; // the second ring's distance outside the first

function connectionLayout(graph) {
  const nodes = graph.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isDevice = (n) => n && n.kind !== "subnet" && n.kind !== "vlan";
  const label = (id) => String(byId.get(id)?.inferred_type || byId.get(id)?.label || id);
  const order = (a, b) => typeRank(byId.get(a)) - typeRank(byId.get(b)) || label(a).localeCompare(label(b)) || a.localeCompare(b);

  const adj = new Map();
  for (const l of graph.links || []) {
    if (!CONNECTION_KINDS.has(l.kind) || l.source === l.target) continue;
    if (!isDevice(byId.get(l.source)) || !isDevice(byId.get(l.target))) continue;
    for (const [a, b] of [[l.source, l.target], [l.target, l.source]]) {
      if (!adj.has(a)) adj.set(a, new Map());
      const prev = adj.get(a).get(b);
      const pr = KIND_PRIORITY[l.kind] ?? 9;
      if (prev === undefined || pr < prev) adj.get(a).set(b, pr);
    }
  }

  // Connected groups.
  const seen = new Set();
  const components = [];
  for (const n of [...nodes].sort((a, b) => order(a.id, b.id))) {
    if (!isDevice(n) || seen.has(n.id) || !adj.has(n.id)) continue;
    const members = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      members.push(id);
      for (const nb of adj.get(id)?.keys() || []) if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
    }
    components.push(members);
  }

  const blocks = components.map((members) => radialBlock(members, adj, byId, order));
  blocks.sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

  // Unconnected devices, then subnet and VLAN labels, as grids.
  const grid = (ids, key) => {
    if (!ids.length) return null;
    const sorted = [...ids].sort(order);
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length * 1.6)));
    const items = sorted.map((id, i) => [id, (i % cols) * CELL_W + CELL_W / 2, Math.floor(i / cols) * CELL_H + CELL_H / 2]);
    return { key, items, w: Math.min(cols, sorted.length) * CELL_W, h: Math.ceil(sorted.length / cols) * CELL_H, size: 0 };
  };
  const loose = grid(nodes.filter((n) => isDevice(n) && !seen.has(n.id)).map((n) => n.id), "~loose");
  const nets = grid(nodes.filter((n) => !isDevice(n)).map((n) => n.id), "~networks");
  const all = [...blocks, loose, nets].filter(Boolean);

  const box = el("map").getBoundingClientRect();
  const aspect = box.width > 0 && box.height > 0 ? Math.min(3, Math.max(0.8, box.width / box.height)) : 1.5;
  const total = all.reduce((s, c) => s + (c.w + CLUSTER_GAP) * (c.h + CLUSTER_GAP), 0);
  packRows(all, Math.max(...all.map((c) => c.w), Math.sqrt(total * aspect)), CLUSTER_GAP);
  const positions = new Map();
  for (const c of all) for (const [id, dx, dy] of c.items) positions.set(id, { x: c.x + dx, y: c.y + dy });
  return { positions, parents: new Map() };
}

function radialBlock(members, adj, byId, order) {
  // The middle: most connections, then gateways before servers before access points.
  const degree = (id) => adj.get(id)?.size || 0;
  const root = [...members].sort((a, b) => degree(b) - degree(a) || order(a, b))[0];
  // Spanning tree, breadth first, following the strongest kind of link first.
  const children = new Map(members.map((id) => [id, []]));
  const depth = new Map([[root, 0]]);
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi += 1) {
    const id = queue[qi];
    const next = [...(adj.get(id) || [])].filter(([nb]) => !depth.has(nb)).sort((x, y) => x[1] - y[1] || order(x[0], y[0]));
    for (const [nb] of next) {
      if (depth.has(nb)) continue;
      depth.set(nb, depth.get(id) + 1);
      children.get(id).push(nb);
      queue.push(nb);
    }
  }
  // Each branch gets a slice of the circle in proportion to how many devices it ends in.
  const leaves = new Map();
  const countLeaves = (id) => {
    const kids = children.get(id);
    const n = kids.length ? kids.reduce((s, k) => s + countLeaves(k), 0) : 1;
    leaves.set(id, n);
    return n;
  };
  countLeaves(root);
  // Each ring is big enough that its narrowest slice still has room for a device. Leaves
  // fanned out on two staggered rings need about half the room.
  const fanParents = new Set([...children].filter(([, kids]) => kids.filter((k) => !children.get(k).length).length > FAN_LIMIT).map(([id]) => id));
  const parentOf = new Map();
  for (const [id, kids] of children) for (const k of kids) parentOf.set(k, id);
  const need = new Map();
  for (const [id, d] of depth) {
    if (d === 0) continue;
    const slice = (2 * Math.PI * leaves.get(id)) / leaves.get(root);
    const fanned = !children.get(id).length && fanParents.has(parentOf.get(id));
    need.set(d, Math.max(need.get(d) || 0, (NODE_ARC / slice) * (fanned ? 0.55 : 1)));
  }
  const radius = [0];
  for (let d = 1; need.has(d); d += 1) radius[d] = Math.max(radius[d - 1] + RING_STEP, need.get(d));
  const pos = new Map([[root, [0, 0]]]);
  const place = (id, start, end) => {
    const kids = children.get(id);
    if (!kids.length) return;
    const fan = fanParents.has(id);
    let a = start;
    kids.forEach((k, i) => {
      const span = ((end - start) * leaves.get(k)) / leaves.get(id);
      const mid = a + span / 2;
      // Lots of leaves under one device: alternate two rings so they don't crowd.
      // The second ring sits a device's width further out, so neighbours clear each other
      // at the sides of the circle as well as at the top and bottom.
      const r = radius[depth.get(k)] + (fan && !children.get(k).length && i % 2 ? FAN_OFFSET : 0);
      pos.set(k, [r * Math.cos(mid), r * Math.sin(mid)]);
      place(k, a, a + span);
      a += span;
    });
  };
  // Around a full circle the first and last devices meet. With an odd number staggered on
  // two rings they'd land side by side on the same ring, so leave one slice empty there.
  const oddFan = fanParents.has(root) && children.get(root).length % 2 === 1;
  place(root, -Math.PI / 2, (3 * Math.PI) / 2 - (oddFan ? (2 * Math.PI) / (leaves.get(root) + 1) : 0));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pos.values()) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const items = [...pos].map(([id, [x, y]]) => [id, x - minX + CELL_W / 2, y - minY + CELL_H / 2]);
  return { key: root, items, w: maxX - minX + CELL_W, h: maxY - minY + CELL_H, size: members.length };
}

const DEFAULT_LAYOUT = "ssid";
const layoutMode = () => (LAYOUTS[state.prefs.layout] ? state.prefs.layout : DEFAULT_LAYOUT);

// Each arrangement keeps its own dragged positions, so switching never scrambles either.
function usePositionsFor(map, mode) {
  if (!map) return;
  const current = map.positionsMode || "subnet";
  if (current === mode) return;
  map.layoutPositions = { ...(map.layoutPositions || {}), [current]: map.positions || {} };
  map.positions = map.layoutPositions[mode] || {};
  map.positionsMode = mode;
  markMapDirty(map.id);
}

function setLayoutMode(mode) {
  if (layoutMode() === mode) return;
  state.prefs.layout = mode;
  state.prefs.layoutPicked = true;
  savePrefs();
  syncLayoutUi();
  renderLayerList();
  renderMap({ fit: true });
}

function syncLayoutUi() {
  const mode = layoutMode();
  const select = el("layout-select");
  if (!select.options.length) select.innerHTML = Object.entries(LAYOUTS).map(([k, l]) => `<option value="${k}">${escapeHtml(l.name)}${k === DEFAULT_LAYOUT ? " (default)" : ""}</option>`).join("");
  select.value = mode;
  el("layout-hint").textContent = LAYOUTS[mode].hint;
}

/* ---------- More arrangements ---------- */
// Each returns { positions, parents, groups, annotations }: groups are labelled boxes drawn
// around their devices (made up for the view, not part of the map); annotations are
// labels placed on the map (ring names, a scale). Both are left out of exports and saving.

const LAYOUTS = {
  ssid: { name: "By network name", hint: "Access points grouped by the network (SSID) they broadcast, each with its clients." },
  subnet: { name: "By subnet", hint: "Devices sit in their subnet's box; access points with their clients." },
  connection: { name: "By connection", hint: "Linked devices sit together, busiest in the middle. Unconnected devices follow in a grid." },
  location: { name: "By location (GPS)", hint: "Devices placed where they were heard, from survey GPS. Ones without a location are grouped separately." },
  channel: { name: "By channel", hint: "A group per Wi-Fi channel, by band. Clients join their access point's channel; wired devices come last." },
  hierarchy: { name: "Top-down hierarchy", hint: "Gateways at the top, then what connects to them, level by level." },
  signal: { name: "By signal strength", hint: "Rings by how strongly each device was heard: strongest in the middle." },
  maker: { name: "By maker", hint: "A group per manufacturer, largest first." },
};

function layoutContext(graph) {
  const nodes = graph.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isAp = (n) => n && nodeRole(overlayNode(n)) === "ap";
  const label = (id) => String(byId.get(id)?.inferred_type || byId.get(id)?.label || id);
  const order = (a, b) => typeRank(byId.get(a)) - typeRank(byId.get(b)) || label(a).localeCompare(label(b)) || a.localeCompare(b);
  // Each wireless client's access point.
  const apOf = new Map();
  for (const l of graph.links || []) {
    if (l.kind !== "wireless") continue;
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!isDeviceNode(a) || !isDeviceNode(b)) continue;
    if (isAp(a) && !isAp(b) && !apOf.has(b.id)) apOf.set(b.id, a.id);
    else if (isAp(b) && !isAp(a) && !apOf.has(a.id)) apOf.set(a.id, b.id);
  }
  return { nodes, byId, isAp, order, apOf, devices: nodes.filter(isDeviceNode), networks: nodes.filter((n) => !isDeviceNode(n)) };
}

function gridBlock(ids, ctx, cols) {
  const sorted = [...ids].sort(ctx.order);
  const c = Math.max(1, cols || Math.ceil(Math.sqrt(sorted.length * 1.6)));
  return {
    items: sorted.map((id, i) => [id, (i % c) * CELL_W + CELL_W / 2, Math.floor(i / c) * CELL_H + CELL_H / 2]),
    w: Math.min(c, Math.max(1, sorted.length)) * CELL_W,
    h: Math.max(1, Math.ceil(sorted.length / c)) * CELL_H,
  };
}

// Access points with their clients beside them (as in the subnet arrangement), the rest in a grid.
function clusterBlock(ids, ctx) {
  const inGroup = new Set(ids);
  const used = new Set();
  const blocks = [];
  for (const id of [...ids].sort(ctx.order)) {
    if (used.has(id)) continue;
    used.add(id);
    const kids = ctx.isAp(ctx.byId.get(id)) ? [...ids].filter((c) => ctx.apOf.get(c) === id && !used.has(c)).sort(ctx.order) : [];
    kids.forEach((c) => used.add(c));
    blocks.push(kids.length ? apBlock(id, kids) : { items: [[id, CELL_W / 2, CELL_H / 2]], w: CELL_W, h: CELL_H });
  }
  const area = blocks.reduce((s, b) => s + b.w * b.h, 0);
  const size = packRows(blocks, Math.max(CELL_W * 3, ...blocks.map((b) => b.w), Math.sqrt(area) * 1.35), 0);
  const items = blocks.flatMap((b) => b.items.map(([id, dx, dy]) => [id, b.x + dx, b.y + dy]));
  return { items, w: size.w, h: size.h };
}

function mergeBlock(block, into) {
  for (const [id, x, y] of block.items) into.positions.set(id, { x, y });
}

// Packs labelled groups (and loose blocks) to the window's shape.
function packGroups(mode, groups, loose = []) {
  const out = { positions: new Map(), parents: new Map(), groups: [], annotations: [] };
  const blocks = [];
  for (const g of groups) {
    if (!g.ids.length) continue;
    const block = g.layout === "grid" ? gridBlock(g.ids, g.ctx) : clusterBlock(g.ids, g.ctx);
    const id = `grp:${mode}:${g.key}`;
    out.groups.push({ id, label: g.label });
    g.ids.forEach((d) => out.parents.set(d, id));
    // Leave room for the title above the box (20px bold, wrapped at 300px), so long ones don't collide.
    const titleW = Math.min(300, Math.max(...String(g.label).split("\n").map((line) => line.length)) * 11.5);
    if (titleW > block.w) {
      const pad = (titleW - block.w) / 2;
      block.items = block.items.map(([d, x, y]) => [d, x + pad, y]);
      block.w = titleW;
    }
    blocks.push({ ...block, key: g.key });
  }
  blocks.push(...loose.filter((b) => b && b.items.length));
  const box = el("map").getBoundingClientRect();
  const aspect = box.width > 0 && box.height > 0 ? Math.min(3, Math.max(0.8, box.width / box.height)) : 1.5;
  const total = blocks.reduce((s, b) => s + (b.w + CLUSTER_GAP) * (b.h + CLUSTER_GAP), 0);
  packRows(blocks, Math.max(...blocks.map((b) => b.w), Math.sqrt(total * aspect)), CLUSTER_GAP + 30);
  for (const b of blocks) for (const [id, dx, dy] of b.items) out.positions.set(id, { x: b.x + dx, y: b.y + dy });
  return out;
}

function networksGroup(ctx, mode) {
  return { key: "~networks", label: "Subnets and VLANs", ids: ctx.networks.map((n) => n.id), layout: "grid", ctx, mode };
}

/* By channel */

function channelOf(n) {
  const ch = (n.channels || []).find((c) => Number.isFinite(Number(c)));
  const f = (n.frequencies_mhz || []).find((x) => Number.isFinite(Number(x)));
  if (ch != null) return { ch: Number(ch), freq: f };
  if (f == null) return null;
  if (f >= 5925) return { ch: Math.round((f - 5950) / 5), freq: f };
  if (f >= 5000) return { ch: Math.round((f - 5000) / 5), freq: f };
  if (f === 2484) return { ch: 14, freq: f };
  return { ch: Math.round((f - 2407) / 5), freq: f };
}

function bandOf({ ch, freq }) {
  if (freq >= 5925) return "6 GHz";
  if (freq ? freq < 3000 : ch <= 14) return "2.4 GHz";
  return "5 GHz";
}

function channelLayout(graph) {
  const ctx = layoutContext(graph);
  const groups = new Map();
  const none = [];
  for (const n of ctx.devices) {
    const own = channelOf(n);
    const ap = ctx.apOf.get(n.id);
    const info = own || (ap ? channelOf(ctx.byId.get(ap)) : null);
    if (!info || !(info.ch > 0)) {
      none.push(n.id);
      continue;
    }
    const band = bandOf(info);
    const key = `${band}|${info.ch}`;
    if (!groups.has(key)) groups.set(key, { key, band, ch: info.ch, ids: [] });
    groups.get(key).ids.push(n.id);
  }
  const bandRank = { "2.4 GHz": 0, "5 GHz": 1, "6 GHz": 2 };
  const list = [...groups.values()].sort((a, b) => bandRank[a.band] - bandRank[b.band] || a.ch - b.ch);
  return packGroups("channel", [
    ...list.map((g) => ({ key: g.key, label: `Channel ${g.ch} · ${g.band} (${g.ids.length})`, ids: g.ids, ctx })),
    { key: "~none", label: `No Wi-Fi channel (${none.length})`, ids: none, layout: "grid", ctx },
    networksGroup(ctx),
  ]);
}

/* By network name */

function ssidLayout(graph) {
  const ctx = layoutContext(graph);
  const groups = new Map();
  const add = (key, label, id) => {
    if (!groups.has(key)) groups.set(key, { key, label, ids: [] });
    groups.get(key).ids.push(id);
  };
  const apGroup = (ap) => {
    const ssid = (ap.ssids || []).find((s) => String(s || "").trim());
    if (ssid) return [`s:${ssid}`, ssid];
    return ap.extra?.hidden_ssid ? ["~hidden", "Hidden networks"] : ["~unnamed", "Networks with no name heard"];
  };
  const notWifi = [];
  for (const n of ctx.devices) {
    if (ctx.isAp(n)) add(...apGroup(n), n.id);
    else if (ctx.apOf.has(n.id)) add(...apGroup(ctx.byId.get(ctx.apOf.get(n.id))), n.id);
    else {
      const ssid = (n.ssids || []).find((s) => String(s || "").trim());
      if (ssid && n.medium === "wireless") add(`s:${ssid}`, ssid, n.id);
      else notWifi.push(n.id);
    }
  }
  const named = [...groups.values()].filter((g) => !g.key.startsWith("~")).sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label));
  const other = [...groups.values()].filter((g) => g.key.startsWith("~"));
  const count = (g) => {
    const aps = g.ids.filter((id) => ctx.isAp(ctx.byId.get(id))).length;
    return `${g.label}\n${plural(aps, "access point")}${g.ids.length > aps ? `, ${plural(g.ids.length - aps, "client")}` : ""}`;
  };
  return packGroups("ssid", [
    ...[...named, ...other].map((g) => ({ ...g, label: count(g), ctx })),
    { key: "~notwifi", label: `Not on Wi-Fi (${notWifi.length})`, ids: notWifi, layout: "grid", ctx },
    networksGroup(ctx),
  ]);
}

/* By maker */

function makerLayout(graph) {
  const ctx = layoutContext(graph);
  const groups = new Map();
  for (const n of ctx.devices) {
    const v = String(n.vendor || "").trim();
    const name = !v ? "Unknown maker" : /locally administered|random/i.test(v) ? "Randomized MAC (no maker)" : v;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(n.id);
  }
  const special = new Set(["Unknown maker", "Randomized MAC (no maker)"]);
  const list = [...groups].sort(([a, x], [b, y]) => (special.has(a) - special.has(b)) || y.length - x.length || a.localeCompare(b));
  return packGroups("maker", [...list.map(([name, ids]) => ({ key: name, label: `${name} (${ids.length})`, ids, layout: "grid", ctx })), networksGroup(ctx)]);
}

/* By signal strength */

const SIGNAL_RINGS = [
  { min: -50, label: "Stronger than −50 dBm" },
  { min: -60, label: "−50 to −60 dBm" },
  { min: -70, label: "−60 to −70 dBm" },
  { min: -80, label: "−70 to −80 dBm" },
  { min: -Infinity, label: "Weaker than −80 dBm" },
];

function signalLayout(graph) {
  const ctx = layoutContext(graph);
  const rings = SIGNAL_RINGS.map(() => []);
  const none = [];
  for (const n of ctx.devices) {
    const s = Number(n.signal_max_dbm ?? n.signal_dbm);
    if (n.signal_dbm == null || !Number.isFinite(s)) none.push(n.id);
    else rings[SIGNAL_RINGS.findIndex((r) => s >= r.min)].push(n.id);
  }
  const strength = (id) => Number(ctx.byId.get(id).signal_max_dbm ?? ctx.byId.get(id).signal_dbm);
  const out = { positions: new Map(), parents: new Map(), groups: [], annotations: [] };
  // Each band fills outward in rings spaced wider than a device; the first ring of each band
  // keeps an empty slot at the top for its label.
  let r = 0;
  rings.forEach((ids, i) => {
    if (!ids.length) return;
    let rest = [...ids].sort((a, b) => strength(b) - strength(a) || ctx.order(a, b));
    r += RING_STEP;
    let first = true;
    while (rest.length) {
      const capacity = Math.max(6, Math.floor((2 * Math.PI * r) / NODE_ARC));
      const take = rest.slice(0, capacity - (first ? 1 : 0));
      const slots = take.length + (first ? 1 : 0);
      take.forEach((id, k) => {
        const a = -Math.PI / 2 + ((k + (first ? 1 : 0)) * 2 * Math.PI) / slots;
        out.positions.set(id, { x: r * Math.cos(a), y: r * Math.sin(a) });
      });
      // A faint outline for the ring the devices sit on (the label covers it at the top).
      out.annotations.push({ id: `ann:ring:${Math.round(r)}`, ring: 2 * r, x: 0, y: 0 });
      if (first) out.annotations.push({ id: `ann:signal:${i}`, label: `${SIGNAL_RINGS[i].label} (${ids.length})`, x: 0, y: -r });
      rest = rest.slice(take.length);
      first = false;
      if (rest.length) r += 130;
    }
  });
  if (none.length || ctx.networks.length) {
    // Devices with no signal reading, and the networks, to the right of the rings.
    const side = packGroups("signal", [{ key: "~none", label: `No signal reading (${none.length})`, ids: none, layout: "grid", ctx }, networksGroup(ctx)]);
    const xs = [...side.positions.values()].map((p) => p.x);
    const ys = [...side.positions.values()].map((p) => p.y);
    const dx = (r || 0) + 260 - Math.min(...xs);
    const dy = -r - Math.min(...ys);
    for (const [id, p] of side.positions) out.positions.set(id, { x: p.x + dx, y: p.y + dy });
    side.parents.forEach((v, k) => out.parents.set(k, v));
    out.groups.push(...side.groups);
  }
  return out;
}

/* By location (GPS) */

function locationLayout(graph) {
  const ctx = layoutContext(graph);
  const located = ctx.devices.filter((n) => Number.isFinite(n.gps?.lat) && Number.isFinite(n.gps?.lon));
  const elsewhere = ctx.devices.filter((n) => !located.includes(n)).map((n) => n.id);
  const out = { positions: new Map(), parents: new Map(), groups: [], annotations: [] };
  let right = 0;
  let top = 0;
  if (located.length) {
    const lat0 = located.reduce((s, n) => s + n.gps.lat, 0) / located.length;
    const k = 111_320; // metres per degree of latitude
    const pts = located.map((n) => ({ id: n.id, mx: (n.gps.lon - located[0].gps.lon) * k * Math.cos((lat0 * Math.PI) / 180), my: -(n.gps.lat - located[0].gps.lat) * k }));
    const spanM = Math.max(1, Math.max(...pts.map((p) => p.mx)) - Math.min(...pts.map((p) => p.mx)), Math.max(...pts.map((p) => p.my)) - Math.min(...pts.map((p) => p.my)));
    const spanPx = Math.max(1200, Math.sqrt(located.length) * CELL_W * 2.2);
    const scale = spanPx / spanM; // px per metre
    // Snap to a grid of device-sized cells; devices at the same spot spiral out to the nearest free cell.
    const taken = new Set();
    for (const p of pts.sort((a, b) => ctx.order(a.id, b.id))) {
      const cx = Math.round((p.mx * scale) / CELL_W);
      const cy = Math.round((p.my * scale) / CELL_H);
      let placed = null;
      for (let ring = 0; !placed && ring < 200; ring += 1) {
        for (let dx = -ring; dx <= ring && !placed; dx += 1) {
          for (let dy = -ring; dy <= ring && !placed; dy += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || taken.has(`${cx + dx},${cy + dy}`)) continue;
            placed = [cx + dx, cy + dy];
          }
        }
      }
      taken.add(`${placed[0]},${placed[1]}`);
      out.positions.set(p.id, { x: placed[0] * CELL_W, y: placed[1] * CELL_H });
    }
    const xs = [...out.positions.values()].map((p) => p.x);
    const ys = [...out.positions.values()].map((p) => p.y);
    right = Math.max(...xs);
    top = Math.min(...ys);
    const metres = (CELL_W * 2) / scale;
    const nice = metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km` : `${Math.max(1, Math.round(metres))} m`;
    out.annotations.push({ id: "ann:location:scale", label: `Two device widths ≈ ${nice}`, x: Math.min(...xs) + CELL_W, y: Math.max(...ys) + CELL_H * 1.2 });
  }
  if (elsewhere.length || ctx.networks.length) {
    const side = packGroups("location", [{ key: "~none", label: `No location (${elsewhere.length})`, ids: elsewhere, layout: "grid", ctx }, networksGroup(ctx)]);
    const xs = [...side.positions.values()].map((p) => p.x);
    const ys = [...side.positions.values()].map((p) => p.y);
    const dx = (located.length ? right + 320 : 0) - Math.min(...xs);
    const dy = top - Math.min(...ys);
    for (const [id, p] of side.positions) out.positions.set(id, { x: p.x + dx, y: p.y + dy });
    side.parents.forEach((v, key) => out.parents.set(key, v));
    out.groups.push(...side.groups);
  }
  return out;
}

/* Top-down hierarchy */

const LEVEL_GAP = CELL_H * 1.9;
const LEAF_WRAP = 8; // more leaves than this under one device wrap into rows

function hierarchyLayout(graph) {
  const ctx = layoutContext(graph);
  const adj = new Map();
  for (const l of graph.links || []) {
    if (!CONNECTION_KINDS.has(l.kind) || l.source === l.target) continue;
    if (!isDeviceNode(ctx.byId.get(l.source)) || !isDeviceNode(ctx.byId.get(l.target))) continue;
    for (const [a, b] of [[l.source, l.target], [l.target, l.source]]) {
      if (!adj.has(a)) adj.set(a, new Map());
      const pr = KIND_PRIORITY[l.kind] ?? 9;
      if (!adj.get(a).has(b) || pr < adj.get(a).get(b)) adj.get(a).set(b, pr);
    }
  }
  const degree = (id) => adj.get(id)?.size || 0;
  const isGateway = (id) => nodeRole(ctx.byId.get(id)) === "gateway";
  const seen = new Set();
  const trees = [];
  // Roots: gateways first (busiest first), then the busiest device of whatever's left.
  const candidates = ctx.devices.map((n) => n.id).filter((id) => adj.has(id)).sort((a, b) => isGateway(b) - isGateway(a) || degree(b) - degree(a) || ctx.order(a, b));
  for (const root of candidates) {
    if (seen.has(root)) continue;
    const children = new Map([[root, []]]);
    seen.add(root);
    const queue = [root];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const id = queue[qi];
      const next = [...(adj.get(id) || [])].filter(([nb]) => !seen.has(nb)).sort((x, y) => x[1] - y[1] || ctx.order(x[0], y[0]));
      for (const [nb] of next) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        children.get(id).push(nb);
        children.set(nb, []);
        queue.push(nb);
      }
    }
    trees.push({ root, children });
  }
  const blocks = trees.map(({ root, children }) => treeBlock(root, children));
  blocks.sort((a, b) => b.size - a.size);
  const loose = ctx.devices.map((n) => n.id).filter((id) => !seen.has(id));
  return packGroups("hierarchy", [{ key: "~loose", label: `Not connected (${loose.length})`, ids: loose, layout: "grid", ctx }, networksGroup(ctx)], blocks);
}

function treeBlock(root, children) {
  const width = new Map();
  const measure = (id) => {
    const kids = children.get(id);
    kids.forEach((k) => measure(k)); // every device needs a width, branch ends included
    const leaves = kids.filter((k) => !children.get(k).length);
    const inner = kids.filter((k) => children.get(k).length);
    const wrap = leaves.length > LEAF_WRAP;
    let w = inner.reduce((s, k) => s + width.get(k), 0) + (wrap ? 0 : leaves.length * CELL_W);
    if (wrap) w = Math.max(w, LEAF_WRAP * CELL_W);
    width.set(id, Math.max(CELL_W, w));
    return width.get(id);
  };
  measure(root);
  const items = [];
  let maxY = 0;
  const place = (id, x0, y) => {
    const w = width.get(id);
    items.push([id, x0 + w / 2, y]);
    maxY = Math.max(maxY, y);
    const kids = children.get(id);
    if (!kids.length) return;
    const leaves = kids.filter((k) => !children.get(k).length);
    const inner = kids.filter((k) => children.get(k).length);
    const wrap = leaves.length > LEAF_WRAP;
    const row = wrap ? inner : kids;
    const rowW = row.reduce((s, k) => s + (children.get(k).length ? width.get(k) : CELL_W), 0);
    let x = x0 + (w - rowW) / 2;
    for (const k of row) {
      const kw = children.get(k).length ? width.get(k) : CELL_W;
      place(k, x, y + LEVEL_GAP);
      x += kw;
    }
    if (wrap) {
      // Lots of leaves (an access point's clients): rows under the device.
      const cols = Math.min(LEAF_WRAP, leaves.length);
      const startY = y + LEVEL_GAP * (inner.length ? 2 : 1);
      const gx = x0 + (w - cols * CELL_W) / 2;
      leaves.forEach((k, i) => {
        const ky = startY + Math.floor(i / cols) * CELL_H;
        items.push([k, gx + (i % cols) * CELL_W + CELL_W / 2, ky]);
        maxY = Math.max(maxY, ky);
      });
    }
  };
  place(root, 0, CELL_H / 2);
  return { items, w: width.get(root), h: maxY + CELL_H / 2, size: children.size };
}

function arrangeLayout(graph, mode) {
  switch (mode) {
    case "connection":
      return connectionLayout(graph);
    case "location":
      return locationLayout(graph);
    case "channel":
      return channelLayout(graph);
    case "ssid":
      return ssidLayout(graph);
    case "hierarchy":
      return hierarchyLayout(graph);
    case "signal":
      return signalLayout(graph);
    case "maker":
      return makerLayout(graph);
    default:
      return computeLayout(graph);
  }
}

function computeLayout(graph) {
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const subnets = nodes.filter((n) => n.kind === "subnet").sort(subnetOrder);
  const subnetIds = new Set(subnets.map((s) => s.id));
  const subnetRank = new Map(subnets.map((s, i) => [s.id, i]));
  const isDevice = (n) => n && n.kind !== "subnet" && n.kind !== "vlan";
  const parents = new Map();

  // Each device goes in one subnet's box: one you put it in, else the first of its subnets.
  const choose = (dev, sub) => {
    const cur = parents.get(dev);
    if (cur === undefined || subnetRank.get(sub) < subnetRank.get(cur)) parents.set(dev, sub);
  };
  const yours = new Set();
  for (const l of links) {
    if (l.kind !== "subnet" || !isManualLink(l)) continue;
    if (subnetIds.has(l.target) && isDevice(byId.get(l.source))) {
      parents.set(l.source, l.target);
      yours.add(l.source);
    }
  }
  for (const l of links) {
    if (l.kind !== "subnet" || isManualLink(l)) continue;
    if (yours.has(l.source) || yours.has(l.target)) continue;
    if (subnetIds.has(l.target) && isDevice(byId.get(l.source))) choose(l.source, l.target);
    else if (subnetIds.has(l.source) && isDevice(byId.get(l.target))) choose(l.target, l.source);
  }
  for (const s of subnets) for (const m of s.extra?.members || []) if (isDevice(byId.get(m)) && !parents.has(m)) choose(m, s.id);

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
  for (const [c, ap] of clientOf) if (!parents.has(c) && parents.has(ap)) parents.set(c, parents.get(ap));

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
    { selector: 'node[role = "bluetooth"]', style: { "border-color": c.bluetooth, shape: "ellipse", width: 96 } },
    { selector: 'node[role = "cell"]', style: { "border-color": c.cell, shape: "diamond", width: 120, height: 64 } },
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
    { selector: 'edge[kind = "manual"]', style: { "line-color": c.manual } },
    // Added by you: the type's colour, a dash-dot line, and a pencil in the label.
    { selector: "edge[manual = 1]", style: { "line-style": "dashed", "line-dash-pattern": [10, 3, 2, 3], width: 2.2, opacity: 1 } },
    // Selected: a thick bright border, a strong glow, a bold label, drawn above everything else.
    {
      selector: "node:selected",
      style: {
        "border-color": c.select,
        "border-width": 5,
        "underlay-color": c.select,
        "underlay-opacity": 0.42,
        "underlay-padding": 11,
        "underlay-shape": "round-rectangle",
        "font-weight": "bold",
        "background-blacken": -0.18,
        "z-index": 30,
        "z-compound-depth": "top",
      },
    },
    { selector: "edge.sel-adj", style: { width: 2.8, opacity: 1, "z-index": 25 } },
    { selector: ":parent:selected", style: { "border-color": c.select, "background-opacity": 0.12 } },
    { selector: "edge:selected", style: { width: 3, "line-color": c.select, "target-arrow-color": c.select, "source-arrow-color": c.select, opacity: 1 } },
    { selector: ".faded", style: { opacity: 0.16 } },
    { selector: ".time-out", style: { display: "none" } },
    // Comparison maps: a see-through colour behind each changed device (its border still shows
    // its type). Selecting one deepens the colour instead of adding the usual glow.
    ...["gone", "detached", "new", "attached", "changed"].map((status) => ({
      selector: `node[change = "${status}"]`,
      style: { "background-color": CHANGE_COLORS[status], "background-opacity": 0.3, "font-weight": 700 },
    })),
    { selector: 'node[change = "gone"]', style: { "border-style": "dashed" } },
    // Layers → Security: the same see-through fill, by each device's most serious finding.
    ...["critical", "high", "medium", "low"].map((sev) => ({
      selector: `node[security = "${sev}"]`,
      style: { "background-color": SECURITY_COLORS[sev], "background-opacity": 0.3 },
    })),
    ...[["host", c.host], ["server", c.server], ["gateway", c.gateway], ["ap", c.ap], ["wireless", c.wireless], ["bluetooth", c.bluetooth], ["cell", c.cell]].map(([role, color]) => ({
      selector: `node[security][role = "${role}"]:selected`,
      style: { "background-opacity": 0.75, "background-blacken": 0, "border-color": color, "border-width": role === "gateway" ? 3 : role === "ap" ? 2.5 : 2, "underlay-opacity": 0 },
    })),
    ...[["host", c.host], ["server", c.server], ["gateway", c.gateway], ["ap", c.ap], ["wireless", c.wireless], ["bluetooth", c.bluetooth], ["cell", c.cell], ["vlan", c.vlan], ["subnet", c.subnet]].map(([role, color]) => ({
      selector: `node[change][change != "same"][role = "${role}"]:selected`,
      style: { "background-opacity": 0.75, "background-blacken": 0, "border-color": color, "border-width": role === "gateway" ? 3 : role === "ap" ? 2.5 : 2, "underlay-opacity": 0 },
    })),
    { selector: 'node[change = "same"]', style: { opacity: 0.45 } },
    { selector: 'edge[change = "same"]', style: { opacity: 0.45 } },
    { selector: 'edge[change = "removed"]', style: { "line-color": CHANGE_COLORS.gone, "target-arrow-color": CHANGE_COLORS.gone, "line-style": "dashed", width: 3, opacity: 0.95 } },
    { selector: 'edge[change = "added"]', style: { "line-color": CHANGE_COLORS.new, "target-arrow-color": CHANGE_COLORS.new, width: 3, opacity: 0.95 } },
    {
      selector: 'node[role = "egg-ripple"]',
      style: { shape: "ellipse", width: "data(size)", height: "data(size)", "background-opacity": 0, "border-width": 4, "border-color": c.select, "border-opacity": 0.9, label: "", events: "no", "z-index": 1 },
    },
    {
      selector: 'node[role = "egg-packet"]',
      style: { shape: "ellipse", width: 18, height: 18, "background-color": c.select, "border-width": 0, label: "", events: "no", "underlay-color": c.select, "underlay-opacity": 0.5, "underlay-padding": 8, "z-index": 99 },
    },
    { selector: "edge.egg-path", style: { "line-color": c.select, "target-arrow-color": c.select, width: 4, opacity: 1, "z-index": 50 } },
    { selector: "node.egg-ping", style: { "underlay-color": c.select, "underlay-opacity": 0.6, "underlay-padding": 10 } },
    { selector: 'node[role = "group"]', style: { "font-size": 20, "text-margin-y": -10, "text-max-width": 300, color: c.nodeText } },
    {
      selector: 'node[role = "ring"]',
      style: {
        shape: "ellipse",
        width: "data(size)",
        height: "data(size)",
        "background-opacity": 0,
        "border-width": 3,
        "border-style": "dashed",
        "border-color": c.muted,
        "border-opacity": 0.75,
        label: "",
        events: "no",
      },
    },
    {
      selector: 'node[role = "annotation"]',
      style: {
        shape: "round-rectangle",
        "background-opacity": 0,
        "border-width": 0,
        width: "label",
        height: 22,
        color: c.muted,
        "font-size": 22,
        "font-weight": 700,
        "text-background-color": c.canvas,
        "text-background-opacity": 0.85,
        "text-background-padding": 4,
        events: "no",
      },
    },
  ];
}

function toElements(graph) {
  const comparing = isComparison(getMap(state.activeMapId));
  if (comparing && getMap(state.activeMapId).hideUnchanged) graph = { ...graph, nodes: graph.nodes.filter((n) => changeOf(n)?.status !== "same") };
  usePositionsFor(getMap(state.activeMapId), layoutMode());
  const { positions, parents, groups = [], annotations = [] } = arrangeLayout(graph, layoutMode());
  const saved = getMap(state.activeMapId)?.positions || {};
  // Boxes and labels made for this arrangement: not devices, not saved, not exported.
  const extras = [
    ...groups.map((g) => ({ data: { id: g.id, label: g.label, kind: "group", role: "group", synthetic: 1 }, selectable: false })),
    ...annotations.map((a) => ({ data: a.ring ? { id: a.id, kind: "annotation", role: "ring", size: a.ring, synthetic: 1 } : { id: a.id, label: a.label, kind: "annotation", role: "annotation", synthetic: 1 }, position: { x: a.x, y: a.y }, selectable: false, grabbable: false })),
  ];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const nodes = graph.nodes.map((raw) => {
    const n = overlayNode(raw);
    const data = { id: n.id, label: nodeLabel(raw), kind: n.kind, role: nodeRole(n) };
    if (!comparing && state.prefs.securityShade && security.overlayKey === overlayKeyNow()) {
      const worst = security.overlay?.nodes?.[n.id]?.worst;
      if (worst) data.security = worst;
    }
    if (comparing && changeOf(raw)) {
      data.change = changeOf(raw).status;
      const tag = changeTag(changeOf(raw));
      if (tag) data.label = `${data.label}\n${tag}`;
    }
    if (parents.has(n.id)) data.parent = parents.get(n.id);
    return { data, position: { ...(saved[n.id] || positions.get(n.id) || { x: 0, y: 0 }) } };
  });
  const edges = graph.links
    .filter(linkIsShown)
    .filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target))
    .map((l) => ({ data: { id: l.id, source: l.source, target: l.target, label: edgeLabel(l), kind: l.kind, manual: isManualLink(l) ? 1 : 0, ...(comparing && changeOf(l) ? { change: changeOf(l).status } : {}) } }));
  return extras.concat(nodes, edges);
}

function renderMap({ fit = true } = {}) {
  syncGeoButton();
  geoOnGraphChange();
  const viewport = !fit && state.cy ? { zoom: state.cy.zoom(), pan: { ...state.cy.pan() } } : null;
  if (state.cy) {
    state.cy.destroy();
    state.cy = null;
  }
  // The timeline (when this map has times) takes the bottom of the stage; settle it before
  // the map measures itself and fits.
  renderTimeline();
  renderChangeLegend();
  refreshSecurityOverlay();
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
    if (connectTap(evt.target)) return;
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
    if (!e) return;
    if (t !== cy && t.isNode() && t.data("synthetic")) {
      showContextMenu(e.clientX, e.clientY, false);
      return;
    }
    if (t !== cy && t.isNode()) syncSelectionFromCy();
    if (t !== cy && t.isEdge()) {
      const link = (state.graph?.links || []).find((l) => l.id === t.id());
      if (link) {
        state.inspectedLink = link.id;
        t.select();
        renderInspector();
        const items = isManualLink(link) ? [{ label: "Edit label and note", onSelect: () => el("manual-label")?.focus() }, "sep"] : [];
        openMenuAt(e.clientX, e.clientY, [...items, { label: "Remove this link", hint: "devices stay put", danger: true, onSelect: () => removeLinks([link.id]) }]);
        return;
      }
    }
    showContextMenu(e.clientX, e.clientY, t !== cy && t.isNode());
  });
  cy.on("mouseover", "node", (evt) => {
    const n = evt.target;
    if (!state.prefs.hoverFade || n.isParent() || cy.nodes(":grabbed").length) return;
    const keepEls = n.closedNeighborhood().union(n.ancestors());
    cy.elements().not(keepEls).not(":parent").addClass("faded");
  });
  cy.on("mouseout", "node", () => cy.elements(".faded").removeClass("faded"));
  cy.on("grab", "node", (evt) => {
    cy.elements(".faded").removeClass("faded");
    noteDragStart(evt.target);
  });
  cy.on("dragfree", "node", (evt) => {
    const map = getMap(state.activeMapId);
    if (!map) return;
    map.positions = map.positions || {};
    const moved = evt.target.isParent() ? evt.target.descendants() : evt.target;
    moved.forEach((n) => {
      if (!n.isParent()) map.positions[n.id()] = { ...n.position() };
    });
    markMapDirty(map.id);
    // Several nodes dragged together each fire this; record the drag once, after the last.
    clearTimeout(dragUndo.timer);
    dragUndo.timer = setTimeout(commitDrag, 0);
  });
  cy.on("free", "node", () => {
    clearTimeout(dragUndo.freeTimer);
    dragUndo.freeTimer = setTimeout(() => {
      if (!dragUndo.timer) dragUndo.before = null; // a click without a drag
    }, 0);
  });
  cy.on("zoom", syncZoomUi);
  syncZoomUi();
  applyTimeWindow();
  renderTimeline();
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
  // The links of selected devices stand out with them.
  state.cy.edges(".sel-adj").removeClass("sel-adj");
  state.cy.nodes(":selected").connectedEdges().addClass("sel-adj");
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

// Cytoscape's own wheel zoom jumps 25-40% per mouse notch. Handle the wheel here
// instead: ~10% per notch, proportional for trackpads, centred on the cursor.
// Settings → Scroll to zoom. "normal": 100 px (one notch) -> ~10%.
const WHEEL_ZOOM_PER_PIXEL = { slow: 0.0006, normal: 0.001, fast: 0.0016 };
const PINCH_ZOOM_PER_PIXEL = 0.01; // trackpad pinch arrives as small ctrl+wheel deltas
const WHEEL_STEP_LIMIT = 0.25;

function wheelPixels(e) {
  if (e.deltaMode === 1) return e.deltaY * 33; // lines
  if (e.deltaMode === 2) return e.deltaY * 400; // pages
  return e.deltaY;
}

function onMapWheel(e) {
  const cy = state.cy;
  // Leave scrollable overlays (search results, menus) alone.
  if (!cy || !el("map").contains(e.target)) return;
  // Stop the event before Cytoscape's own handler sees it.
  e.preventDefault();
  e.stopPropagation();
  const rate = e.ctrlKey ? PINCH_ZOOM_PER_PIXEL : WHEEL_ZOOM_PER_PIXEL[state.prefs.zoomSpeed] || WHEEL_ZOOM_PER_PIXEL.normal;
  const step = Math.max(-WHEEL_STEP_LIMIT, Math.min(WHEEL_STEP_LIMIT, -wheelPixels(e) * rate));
  const level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cy.zoom() * Math.exp(step)));
  if (level === cy.zoom()) return;
  const box = el("map").getBoundingClientRect();
  cy.zoom({ level, renderedPosition: { x: e.clientX - box.left, y: e.clientY - box.top } });
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
  updateStatusTime();
  if (g?.meta?.warnings?.length) el("status").title = g.meta.warnings.join("\n");
  else el("status").removeAttribute("title");
  el("btn-export").disabled = !g?.nodes?.length;
}

function mapKindLabel(map) {
  return map.kind === "unwanted" ? "Holding area" : map.kind === "blank" ? "Blank map" : map.kind === "window" ? "Time window" : map.kind === "compare" ? "Comparison" : "Survey";
}

function updateEmptyState() {
  const map = getMap(state.activeMapId);
  const empty = !state.graph?.nodes?.length;
  const loading = !el("loading").classList.contains("hidden");
  show("empty", empty && !loading);
  if (!empty) return;
  const firstRun = !state.maps.some((m) => m.kind !== "unwanted" && m.graph?.nodes?.length);
  if (firstRun && (map?.kind === "unwanted" || map?.kind === "survey" || !map)) {
    el("empty-title").textContent = "Map your network";
    el("empty-body").textContent = "Drop a Wireshark, tcpdump, Kismet, airodump, or WiGLE capture anywhere on this page. Or try a demo with the sample captures.";
  } else if (map?.kind === "unwanted") {
    el("empty-title").textContent = "Nothing set aside";
    el("empty-body").textContent = "Devices you set aside from other maps land here. Select devices and choose Set aside, then empty Unwanted to save them as files.";
  } else if (map?.kind === "blank") {
    el("empty-title").textContent = "This map is blank";
    el("empty-body").textContent = "Copy devices from another map and paste them here, or open a survey to start a new map.";
  } else {
    el("empty-title").textContent = "No devices on this map";
    el("empty-body").textContent = "Open another survey, or paste devices from a different map.";
  }
  el("empty-sample").classList.toggle("hidden", (map?.kind === "unwanted" && !firstRun) || !state.catalog.length);
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

// Every GPS fix a device was seen at — time, coordinates, and signal — oldest first, in a
// collapsed list so it doesn't swamp the panel. Each coordinate is copyable.
const GPS_FIXES_SHOWN = 300;
function gpsFixesHtml(track) {
  const fixes = (track || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!fixes.length) return "";
  const ordered = [...fixes].sort((a, b) => (a[2] || 0) - (b[2] || 0));
  const row = (p) => {
    const when = Number.isFinite(p[2]) ? formatTime(p[2], { date: true }) : "time unknown";
    const at = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
    const sig = p[3] != null ? `${p[3]} dBm` : "";
    return `<li><span class="gps-when">${escapeHtml(when)}</span><span class="gps-line"><span class="gps-at copyable mono" data-copy="${escapeHtml(at)}" title="Click to copy">${escapeHtml(at)}</span><span class="gps-sig">${escapeHtml(sig)}</span></span></li>`;
  };
  const shown = ordered.slice(0, GPS_FIXES_SHOWN).map(row).join("");
  const more = ordered.length > GPS_FIXES_SHOWN ? `<li class="gps-more hint">…and ${(ordered.length - GPS_FIXES_SHOWN).toLocaleString()} more</li>` : "";
  const label = `${ordered.length.toLocaleString()} GPS ${ordered.length === 1 ? "fix" : "fixes"} with times`;
  return `<details class="gps-fixes"><summary>${escapeHtml(label)}</summary><ol class="gps-list">${shown}${more}</ol></details>`;
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
  if (link) {
    if (isManualLink(link)) bindManualLinkPanel(link);
    else el("link-remove")?.addEventListener("click", () => removeLinks([link.id]));
    return;
  }
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
        <input type="text" id="insp-caption" value="${escapeHtml(meta.extra || "")}" placeholder="${escapeHtml(autoCaption(overlayNode(raw)) ? `${autoCaption(overlayNode(raw))} (from the SSID)` : "Lobby, rack A1, 2nd floor")}" autocomplete="off" />
      </label>
    </div>
    ${changeSection(raw)}
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
        ${seenFacts(raw)}
        ${members != null ? factRow("Members", plural(members, "device")) : ""}
      </dl>
    </div>
    ${
      n.ssids?.length || n.channels?.length || signal || n.encryption?.length || gps || n.extra?.bt_variant || n.extra?.radio
        ? `<div class="insp-section"><h3>Radio</h3><dl class="facts">
        ${factRow("SSID", n.ssids)}
        ${factRow("Bluetooth", n.extra?.bt_variant === "BLE" ? "Bluetooth LE" : n.extra?.bt_variant === "BT" ? "Bluetooth (classic)" : null)}
        ${factRow("Device class", n.extra?.bt_class)}
        ${factRow("Cell radio", n.extra?.radio)}
        ${factRow("Network (PLMN)", n.extra?.plmn)}
        ${factRow("Cell ID", n.extra?.cell_id, { mono: true })}
        ${factRow("Channel", n.extra?.channel_arfcn ? [`ARFCN ${n.extra.channel_arfcn}`] : n.channels)}
        ${factRow("Frequency", (n.frequencies_mhz || []).map((f) => `${f} MHz`))}
        ${factRow("Signal", signal)}
        ${factRow("Security", n.encryption)}
        ${factRow("GPS", gps, { mono: true })}
      </dl></div>`
        : ""
    }
    ${
      n.track?.length || n.extra?.est_location
        ? `<div class="insp-section" id="insp-location"><h3>Location</h3><dl class="facts">
        ${factRow("Sightings", n.track?.length ? [`${n.track.length} GPS ${n.track.length === 1 ? "fix" : "fixes"}`] : null)}
        ${n.extra?.est_location ? factRow("Estimated", [`${n.extra.est_location.lat}, ${n.extra.est_location.lon}`], { mono: true }) : ""}
        ${n.extra?.est_location ? factRow("From", [`${n.extra.est_location.n} readings · spread ±${formatMetres(n.extra.est_location.radius_m)}`]) : ""}
      </dl>${n.extra?.est_location ? '<p class="hint">A signal-weighted estimate of where the transmitter is — most reliable when it was heard from several different spots.</p>' : ""}${gpsFixesHtml(n.track)}</div>`
        : ""
    }
    ${n.services?.length || ports.length ? `<div class="insp-section"><h3>Services</h3>${chips([...new Set([...ports, ...(n.services || []).filter((s) => !ports.some((p) => p.startsWith(s)))])])}</div>` : ""}
    ${routing ? `<div class="insp-section"><h3>Routing</h3><dl class="facts">${routing}</dl></div>` : ""}
    <div class="insp-section insp-security" id="insp-security"></div>
    <div class="insp-section">
      <label class="field-label">Notes
        <textarea id="insp-notes" rows="3" placeholder="Inventory tag, site notes, anything worth keeping">${escapeHtml(meta.notes || "")}</textarea>
      </label>
    </div>
    <div class="insp-section insp-actions">
      <button type="button" class="btn small" data-act="copy-details">Copy details</button>
      ${geoLocated(n) ? '<button type="button" class="btn small" data-act="geo" title="Show where this was seen on a map">Show on map</button>' : ""}
      ${isDeviceNode(raw) ? '<button type="button" class="btn small" data-act="connect" title="Connect to another device from information you have">Connect to…</button>' : ""}
      ${isDeviceNode(raw) && (state.graph?.links || []).some((l) => l.source === raw.id || l.target === raw.id) ? '<button type="button" class="btn small" data-act="disconnect" title="Remove links to another device; nothing moves">Disconnect from…</button>' : ""}
      ${isDeviceNode(raw) ? '<button type="button" class="btn small" data-act="member">Add to network…</button>' : ""}
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
  loadDeviceSecurity(raw);
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
  const kindName = isManualLink(link) ? `${MANUAL_KIND_NAMES[link.kind] || link.kind}, added by you` : LAYERS.find((l) => l.kind === link.kind)?.name || link.kind;
  return `
    <div class="insp-head">
      <span class="insp-icon" style="--c: var(${LAYERS.find((l) => l.kind === link.kind)?.color || "--edge-l2"}); border-radius: 50%"></span>
      <div class="insp-title">
        <h2>${escapeHtml(edgeLabel(link) || kindName)}</h2>
        <p>${escapeHtml(kindName)}${isManualLink(link) ? "" : ` · ${escapeHtml(link.medium || "wired")}`}</p>
      </div>
    </div>
    ${changeSection(link, { link: true })}
    <div class="insp-section"><dl class="facts">
      ${factRow(link.kind === "client-server" ? "Client" : "From", nodeName(link.source))}
      ${factRow(link.kind === "client-server" ? "Server" : "To", nodeName(link.target))}
      ${factRow("Frames", extra.count)}
      ${seenFacts(link)}
      ${factRow("VLANs", link.vlans)}
      ${link.kind === "bridge" ? factRow("Bridge type", extra.bridge_kind) : ""}
      ${factRow("Via", (extra.vias || []).map(nodeName))}
      ${factRow("Networks", extra.networks)}
      ${link.kind === "wireless" ? factRow("Associated", extra.associated === false ? "No (probe only)" : "Yes") : ""}
      ${factRow("SSID", extra.ssid)}
      ${factRow("HTTP host", extra.http_host)}
      ${factRow("DNS query", extra.dns_query)}
    </dl></div>
    ${ports.length || link.services?.length ? `<div class="insp-section"><h3>Services</h3>${chips(ports.length ? ports : link.services)}</div>` : ""}
    ${isManualLink(link) ? manualLinkPanel(link) : `<div class="insp-section insp-actions"><button type="button" class="btn small danger" id="link-remove" title="Both devices stay where they are">Remove this link</button></div>`}`;
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
      ${ids.filter((id) => isDeviceNode(nodeById(id))).length === 2 ? '<button type="button" class="btn small" data-act="connect">Connect…</button>' : ""}
      ${ids.length === 2 && linksBetween(ids[0], ids[1]).length ? '<button type="button" class="btn small" data-act="disconnect">Disconnect…</button>' : ""}
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
  else if (act === "geo") {
    const id = selectedIds()[0];
    if (id) showDeviceOnMap(id);
  } else if (act === "connect") {
    const ids = selectedIds();
    if (ids.length === 2) openConnectDialog(ids[0], ids[1]);
    else if (ids.length === 1) startConnect(ids[0]);
  } else if (act === "disconnect") {
    const ids = selectedIds();
    if (ids.length === 2) openDisconnectDialog(ids[0], ids[1]);
    else if (ids.length === 1) startDisconnect(ids[0]);
  } else if (act === "member" && selectedIds().length === 1) openMemberDialog(selectedIds()[0]);
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
  const pair = selectedIds().filter((id) => isDeviceNode(nodeById(id)));
  show("sel-connect", pair.length === 2);
  show("sel-disconnect", pair.length === 2 && linksBetween(pair[0], pair[1]).length > 0);
  el("selection-count").textContent = `${n} selected`;
}

function syncPasteUi() {
  const n = state.clipboard?.nodes?.length || 0;
  show("btn-paste", n > 0);
  el("paste-label").textContent = n ? `Paste ${plural(n, "device")}` : "Paste";
}

function connectMenuItems() {
  const ids = selectedIds().filter((id) => isDeviceNode(nodeById(id)));
  if (ids.length === 2) {
    const linked = linksBetween(ids[0], ids[1]).length > 0;
    return [
      "sep",
      { label: "Connect these two…", onSelect: () => openConnectDialog(ids[0], ids[1]) },
      { label: "Disconnect these two…", disabled: !linked, onSelect: () => openDisconnectDialog(ids[0], ids[1]) },
    ];
  }
  if (ids.length !== 1) return [];
  const hasLinks = (state.graph?.links || []).some((l) => l.source === ids[0] || l.target === ids[0]);
  return [
    "sep",
    { label: "Connect to…", hint: "click another device", onSelect: () => startConnect(ids[0]) },
    { label: "Disconnect from…", hint: "click another device", disabled: !hasLinks, onSelect: () => startDisconnect(ids[0]) },
    { label: "Add to subnet or VLAN…", onSelect: () => openMemberDialog(ids[0]) },
  ];
}

function showContextMenu(x, y, onNode) {
  const hasClip = Boolean(state.clipboard?.nodes?.length);
  const items = onNode
    ? [
        { label: "Copy", kbd: "Ctrl C", onSelect: copySelected },
        { label: "Cut", kbd: "Ctrl X", onSelect: cutSelected },
        { label: "Paste", kbd: "Ctrl V", disabled: !hasClip, onSelect: pasteClipboard },
        "sep",
        ...(selectedIds().length === 1 && geoLocated(nodeById(selectedIds()[0]) || {}) ? [{ label: "Show on map", onSelect: () => showDeviceOnMap(selectedIds()[0]) }, "sep"] : []),
        { label: "Set aside in Unwanted", onSelect: () => moveSelectedTo(UNWANTED_ID) },
        ...connectMenuItems(),
        "sep",
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

/* ---------- Links you add (from outside information) ---------- */
// A connection or network membership the capture didn't show, added by a person. It's an
// ordinary link of the right kind (so Wi-Fi clients sit with their access point and a
// device moves into its subnet box) with extra.manual = { note, added }, which marks it
// everywhere: a dash-dot line with a pencil on the map, its own layer, and in exports.

const MANUAL_MARK = "\u270e";
const MANUAL_KIND_NAMES = { l2: "Wired", wireless: "Wi-Fi", manual: "Connected", subnet: "In subnet", vlan: "In VLAN" };
const isManualLink = (l) => isPlainObject(l?.extra?.manual);
const connectState = { from: null };

function linkIsShown(l) {
  if (isManualLink(l) && state.filters.manual === false) return false;
  if (!isManualLink(l) && state.filters[l.kind] === false) return false;
  return !membershipHidden(l.kind);
}

function isDeviceNode(n) {
  return Boolean(n) && n.kind !== "subnet" && n.kind !== "vlan";
}

function startConnect(fromId) {
  const from = nodeById(fromId);
  if (!isDeviceNode(from)) return;
  closeMenu();
  connectState.from = fromId;
  connectState.mode = "connect";
  el("connect-banner-text").textContent = `Click the device to connect to ${displayName(from)}.`;
  show("connect-banner", true);
  el("stage").classList.add("connecting");
}

function cancelConnect() {
  if (!connectState.from) return false;
  connectState.from = null;
  show("connect-banner", false);
  el("stage").classList.remove("connecting");
  return true;
}

// Returns true when the tap was used to finish connecting.
function connectTap(target) {
  if (!connectState.from) return false;
  const from = connectState.from;
  if (target?.isNode?.() && !target.isParent() && target.id() !== from && isDeviceNode(nodeById(target.id()))) {
    const mode = connectState.mode;
    cancelConnect();
    if (mode === "disconnect") openDisconnectDialog(from, target.id());
    else openConnectDialog(from, target.id());
  }
  return true; // taps elsewhere while connecting do nothing; Esc or Cancel ends it
}

function openConnectDialog(aId, bId) {
  const a = nodeById(aId);
  const b = nodeById(bId);
  if (!a || !b) return;
  const dialog = el("connect-dialog");
  const aps = [a, b].filter(nodeLooksLikeAp);
  const wifiOk = aps.length === 1;
  el("connect-title").textContent = `Connect ${displayName(a)} and ${displayName(b)}`;
  const wifi = dialog.querySelector('input[value="wireless"]');
  wifi.disabled = !wifiOk;
  el("connect-wifi-row").title = wifiOk ? "" : "One of the two must be an access point";
  dialog.querySelector(`input[value="${wifiOk && nodeLooksLikeWirelessClient(aps[0] === a ? b : a) ? "wireless" : "l2"}"]`).checked = true;
  el("connect-label").value = "";
  el("connect-note").value = "";
  connectState.pair = [aId, bId];
  dialog.showModal();
  el("connect-label").focus();
}

function addManualLink(aId, bId, { kind, label = "", note = "", snapshot = true }) {
  const map = getMap(state.activeMapId);
  if (!map || !nodeById(aId) || !nodeById(bId) || aId === bId) return null;
  let [source, target] = [aId, bId];
  if (kind === "wireless" && nodeLooksLikeAp(nodeById(aId))) [source, target] = [bId, aId]; // client -> access point
  if (kind === "subnet" || kind === "vlan") [source, target] = [aId, bId]; // device -> network
  const id = `manual:${kind}:${kind === "manual" || kind === "l2" ? [source, target].sort().join("|") : `${source}|${target}`}`;
  if (snapshot) snapshotUndo(kind === "subnet" || kind === "vlan" ? "add to network" : "connect", [map.id]);
  const existing = map.graph.links.find((l) => l.id === id);
  const link = existing || { id, source, target, kind, medium: kind === "wireless" ? "wireless" : "wired", vlans: [], services: [], ports: [], extra: {} };
  link.label = label.trim();
  link.extra = { ...(link.extra || {}), manual: { note: note.trim(), added: new Date().toISOString() }, ...(kind === "wireless" ? { associated: true } : {}) };
  if (!existing) map.graph.links.push(link);
  markMapEdited(map.id);
  refreshAll();
  return link;
}

function manualLinkPanel(link) {
  const info = link.extra.manual;
  const added = Date.parse(info.added) ? new Date(info.added).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  return `
    <div class="insp-section">
      <span class="manual-badge">${MANUAL_MARK} Added by you${added ? ` · ${escapeHtml(added)}` : ""}</span>
      <label class="field-label">Label on the map
        <input type="text" id="manual-label" maxlength="60" value="${escapeHtml(link.label || "")}" placeholder="${escapeHtml(MANUAL_KIND_NAMES[link.kind] || "")}" autocomplete="off" />
      </label>
      <label class="field-label">Where this came from
        <textarea id="manual-note" rows="3" maxlength="500" placeholder="Switch port label, diagram, who told you…">${escapeHtml(info.note || "")}</textarea>
      </label>
    </div>
    <div class="insp-section insp-actions">
      <button type="button" class="btn small danger" id="manual-remove">Remove this link</button>
    </div>`;
}

function bindManualLinkPanel(link) {
  const map = getMap(state.activeMapId);
  const save = () => {
    markMapEdited(map.id);
    const edge = state.cy?.getElementById(link.id);
    if (edge?.length) edge.data("label", edgeLabel(link));
  };
  el("manual-label").addEventListener("input", (e) => {
    link.label = e.target.value.trim();
    save();
  });
  el("manual-note").addEventListener("input", (e) => {
    link.extra.manual = { ...link.extra.manual, note: e.target.value };
    save();
  });
  el("manual-remove").addEventListener("click", () => removeLinks([link.id], { label: "remove link", message: "Removed the link you added." }));
}

/* Disconnecting: remove links between two devices, leaving both where they are. */

function linksBetween(aId, bId) {
  return (state.graph?.links || []).filter((l) => (l.source === aId && l.target === bId) || (l.source === bId && l.target === aId));
}

function linkDescription(link) {
  const kind = isManualLink(link) ? `${MANUAL_KIND_NAMES[link.kind] || link.kind}, added by you` : LAYERS.find((l) => l.kind === link.kind)?.name || link.kind;
  const label = edgeLabel(link).replace(MANUAL_MARK, "").trim();
  return label && label !== kind ? `${kind}: ${label}` : kind;
}

function startDisconnect(fromId) {
  startConnect(fromId);
  connectState.mode = "disconnect";
  el("connect-banner-text").textContent = `Click the device to disconnect from ${displayName(nodeById(fromId))}.`;
}

function openDisconnectDialog(aId, bId) {
  const links = linksBetween(aId, bId);
  if (!links.length) {
    toast(`${displayName(nodeById(aId))} and ${displayName(nodeById(bId))} aren't connected on this map.`, { timeout: 3500 });
    return;
  }
  el("disconnect-title").textContent = `Disconnect ${displayName(nodeById(aId))} and ${displayName(nodeById(bId))}`;
  el("disconnect-list").innerHTML =
    `<legend>${links.length === 1 ? "This link is removed" : "Links to remove"}</legend>` +
    links
      .map((l) => `<label><input type="checkbox" name="disconnect-link" value="${escapeHtml(l.id)}" checked /> <span>${escapeHtml(linkDescription(l))}${l.extra?.count ? `<small>${Number(l.extra.count).toLocaleString()} frames</small>` : ""}</span></label>`)
      .join("");
  connectState.pair = [aId, bId];
  el("disconnect-dialog").showModal();
  el("disconnect-ok").focus();
}

// Removes links without moving anything: every device on the map keeps its current spot.
function removeLinks(linkIds, { label = "disconnect", message = "" } = {}) {
  const map = getMap(state.activeMapId);
  const ids = new Set(linkIds);
  const gone = map?.graph.links.filter((l) => ids.has(l.id)) || [];
  if (!gone.length) return;
  snapshotUndo(label, [map.id]);
  map.positions = map.positions || {};
  state.cy?.nodes().forEach((n) => {
    if (!n.isParent()) map.positions[n.id()] = { ...n.position() };
  });
  map.graph.links = map.graph.links.filter((l) => !ids.has(l.id));
  for (const link of gone) {
    for (const [end, other] of [[link.source, link.target], [link.target, link.source]]) {
      const n = map.graph.nodes.find((x) => x.id === end);
      if (!n || isDeviceNode(n)) continue;
      // Leaving a subnet means leaving its box too.
      if (Array.isArray(n.extra?.members)) n.extra.members = n.extra.members.filter((m) => m !== other);
      // A network you created that nothing belongs to any more goes too.
      if (isPlainObject(n.extra?.manual) && !map.graph.links.some((l) => l.source === end || l.target === end)) {
        map.graph.nodes = map.graph.nodes.filter((x) => x.id !== end);
      }
    }
  }
  if (map.id === state.activeMapId) state.graph = map.graph;
  if (ids.has(state.inspectedLink)) state.inspectedLink = null;
  markMapEdited(map.id);
  refreshAll();
  toast(message || (gone.length === 1 ? "Removed the link." : `Removed ${gone.length} links.`), { undo: true });
}

function bindDisconnectDialog() {
  const dialog = el("disconnect-dialog");
  el("disconnect-cancel").addEventListener("click", () => dialog.close());
  el("disconnect-list").addEventListener("change", () => {
    el("disconnect-ok").disabled = !dialog.querySelector('input[name="disconnect-link"]:checked');
  });
  el("disconnect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const chosen = [...dialog.querySelectorAll('input[name="disconnect-link"]:checked')].map((i) => i.value);
    dialog.close();
    const [a, b] = connectState.pair || [];
    removeLinks(chosen, { message: `Disconnected ${displayName(nodeById(a))} and ${displayName(nodeById(b))}.` });
  });
}

/* Subnet and VLAN membership */

function networkNodes(kind) {
  return (state.graph?.nodes || []).filter((n) => n.kind === kind).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
}

function openMemberDialog(deviceId) {
  const dev = nodeById(deviceId);
  if (!isDeviceNode(dev)) return;
  connectState.member = deviceId;
  el("member-title").textContent = `Add ${displayName(dev)} to a subnet or VLAN`;
  el("member-note").value = "";
  el("member-new").value = "";
  el("member-error").classList.add("hidden");
  el("member-dialog").querySelector('input[value="subnet"]').checked = true;
  fillMemberPick();
  el("member-dialog").showModal();
}

function fillMemberPick() {
  const kind = el("member-dialog").querySelector('input[name="member-kind"]:checked').value;
  const pick = el("member-pick");
  const nets = networkNodes(kind);
  pick.innerHTML = nets.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.label)}</option>`).join("") + `<option value="__new">New ${kind === "vlan" ? "VLAN" : "subnet"}…</option>`;
  el("member-pick-label").textContent = kind === "vlan" ? "VLAN" : "Subnet";
  el("member-new-label").textContent = kind === "vlan" ? "VLAN number (1–4094)" : "New subnet, like 10.20.0.0/24";
  el("member-new").placeholder = kind === "vlan" ? "120" : "10.20.0.0/24";
  if (!nets.length) pick.value = "__new";
  show("member-new-row", pick.value === "__new");
}

function parseNewNetwork(kind, text) {
  const value = String(text || "").trim();
  if (kind === "vlan") {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 4094 ? { id: `vlan:${n}`, label: `VLAN ${n}`, vlan: n } : null;
  }
  const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (m && m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32) return { id: `subnet:${value}`, label: value };
  if (/^[0-9a-f:]+\/\d{1,3}$/i.test(value) && value.includes(":")) return { id: `subnet:${value.toLowerCase()}`, label: value.toLowerCase() };
  return null;
}

function addToNetwork(deviceId, kind, netId, newNet, note) {
  const map = getMap(state.activeMapId);
  if (!map) return;
  snapshotUndo("add to network", [map.id]); // one step covers a new network and the link to it
  let target = netId;
  if (newNet) {
    target = newNet.id;
    if (!map.graph.nodes.some((n) => n.id === target)) {
      map.graph.nodes.push({
        id: target, kind, label: newNet.label, medium: "wired", macs: [], mac_tx: [], mac_rx: [], mac_da: [], mac_ra: [], ips: [], ssids: [],
        channels: [], frequencies_mhz: [], encryption: [], vlans: newNet.vlan ? [newNet.vlan] : [], roles: [], services: [], ports: [], routing: {},
        extra: { manual: { note: "", added: new Date().toISOString() } }, inferred_type: kind === "vlan" ? "VLAN" : "Subnet",
      });
      indexGraph();
    }
  }
  addManualLink(deviceId, target, { kind, note, snapshot: false });
  toast(`Added ${displayName(nodeById(deviceId))} to ${nodeById(target)?.label || "the network"}.`, { undo: true });
}

function bindManualDialogs() {
  const connect = el("connect-dialog");
  el("connect-cancel").addEventListener("click", () => connect.close());
  el("connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const [a, b] = connectState.pair || [];
    const kind = connect.querySelector('input[name="connect-kind"]:checked')?.value || "l2";
    connect.close();
    const link = addManualLink(a, b, { kind, label: el("connect-label").value, note: el("connect-note").value });
    if (link) toast(`Connected ${displayName(nodeById(a))} and ${displayName(nodeById(b))}.`, { undo: true });
  });
  const member = el("member-dialog");
  el("member-cancel").addEventListener("click", () => member.close());
  member.querySelectorAll('input[name="member-kind"]').forEach((r) => r.addEventListener("change", fillMemberPick));
  el("member-pick").addEventListener("change", () => show("member-new-row", el("member-pick").value === "__new"));
  el("member-new").addEventListener("input", () => el("member-error").classList.add("hidden"));
  el("member-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const kind = member.querySelector('input[name="member-kind"]:checked').value;
    const pick = el("member-pick").value;
    let newNet = null;
    if (pick === "__new") {
      newNet = parseNewNetwork(kind, el("member-new").value);
      if (!newNet) {
        el("member-error").textContent = kind === "vlan" ? "Enter a VLAN number from 1 to 4094." : "Enter a subnet like 10.20.0.0/24.";
        el("member-error").classList.remove("hidden");
        el("member-new").focus();
        return;
      }
    }
    member.close();
    addToNetwork(connectState.member, kind, pick === "__new" ? null : pick, newNet, el("member-note").value);
  });
  el("connect-banner-cancel").addEventListener("click", cancelConnect);
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
    row.dataset.id = map.id;
    // Unwanted stays at the bottom: it can't be dragged, but you can still drag devices' maps onto others.
    if (map.kind !== "unwanted") row.dataset.dragType = "map";
    row.dataset.dropType = "map";
    const n = mapNodeCount(map);
    row.innerHTML = `<button type="button" class="row-main"><span class="row-dot"></span><span class="row-text"><span class="row-title">${escapeHtml(map.name)}</span>
      <span class="row-sub">${escapeHtml(mapKindLabel(map))} · ${plural(n, "device")}${map.kind === "survey" && n && !hasTimeline(map.graph) ? ` · ${NO_TIMELINE}` : ""}</span></span></button>
      <button type="button" class="icon-btn row-menu-btn" aria-label="Options for ${escapeHtml(map.name)}" aria-haspopup="menu" aria-expanded="false"><svg class="icon"><use href="#i-dots"/></svg></button>`;
    row.querySelector(".row-main").addEventListener("click", () => {
      showMap(map.id);
      closeNarrowPanels();
    });
    row.querySelector(".row-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, mapMenuItems(map), { align: "right" });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY, [{ label: "Open", onSelect: () => showMap(map.id) }, "sep", ...mapMenuItems(map)]);
    });
    list.appendChild(row);
  }
}

const mapHasGeo = (map) => (map?.graph?.nodes || []).some((n) => isDeviceNode(n) && geoLocated(n));

// Switch to a map and open the geo map on its whole capture (from a survey's right-click menu).
function showMapOnGeo(mapId) {
  showMap(mapId);
  closeNarrowPanels();
  setGeoMode("whole");
  openGeoMap();
}

function mapMenuItems(map) {
  const items = [{ label: "Rename…", onSelect: () => renameMap(map.id) }];
  if (mapHasGeo(map)) items.push({ label: "Show on geo map", onSelect: () => showMapOnGeo(map.id) });
  if (map.kind === "unwanted") {
    items.push({ label: "Save to files and empty…", disabled: !mapNodeCount(map), onSelect: () => emptyUnwanted() });
  } else {
    items.push({ label: "Merge into…", disabled: mergeTargets(map.id).length === 0, onSelect: () => mergeMapDialog(map.id) });
    if (!isComparison(map) && mapNodeCount(map)) items.push({ label: "Compare with a baseline…", onSelect: () => openCompareDialog({ later: compareSourceFor("map", map.id) }) });
    items.push("sep", { label: "Delete map…", danger: true, onSelect: () => deleteMap(map.id) });
  }
  return items;
}

const mergeTargets = (excludeId) => state.maps.filter((m) => m.kind !== "unwanted" && m.id !== excludeId);

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

function mergeMaps(sourceOrId, destId) {
  const source = typeof sourceOrId === "string" ? getMap(sourceOrId) : sourceOrId;
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
  const hosted = state.server.hosted;
  const ok = await openDialog({
    title: `Save ${plural(graph.nodes.length, "device")} and empty Unwanted?`,
    body: hosted
      ? "NetSeer downloads one JSON file per original capture. Drop a file back onto NetSeer to reload it."
      : "NetSeer writes one JSON file per original capture into the Unwanted folder of the project. Drop a file back onto NetSeer to reload it.",
    okLabel: hosted ? "Download and empty" : "Save and empty",
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
    let files;
    if (hosted) {
      // Same file format the server writes (see web.dump_unwanted), built in the browser.
      files = Object.values(groups).map((group) => {
        const stem = (String(group.capture).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "unknown").slice(0, 60);
        const name = `Unwanted-${stem}.json`;
        downloadJson(name, {
          netseer: "unwanted-v1",
          original_capture: group.capture,
          title: `Unwanted ${stem}`,
          nodes: group.nodes,
          links: group.links,
          meta: { sources: [group.capture], node_count: group.nodes.length, link_count: group.links.length },
          device_meta: group.device_meta,
        });
        return name;
      });
    } else {
      const payload = await parseResponse(
        await fetch("/api/unwanted/dump", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groups: Object.values(groups) }) })
      );
      files = payload.files || [];
    }
    snapshotUndo("empty Unwanted", [UNWANTED_ID]);
    removeNodes(map, graph.nodes.map((n) => n.id));
    markMapEdited(UNWANTED_ID);
    refreshAll();
    toast(`${hosted ? "Downloaded" : "Saved"} ${files.join(", ")} and emptied Unwanted.`);
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

/* ---------- Server mode ---------- */
// A public deployment (NETSEER_HOSTED=1) can't write files to its disk, and may take
// smaller uploads; the page adapts.

async function loadServerInfo() {
  try {
    const info = await parseResponse(await fetch("/api/health"));
    state.server = {
      hosted: Boolean(info.hosted),
      maxUploadMb: Number(info.max_upload_mb) || 0, // 0: no limit (installed copies)
      version: String(info.version || ""),
      mode: info.mode || (info.hosted ? "hosted" : "server"),
      platform: info.platform || "",
      package: info.package || "source",
      repo: info.repo || state.server.repo,
    };
  } catch {
    /* keep defaults */
  }
  const hosted = state.server.hosted;
  show("hosted-note", hosted);
  show("empty-hosted", hosted);
  document.querySelectorAll(".hosted-limit").forEach((n) => (n.textContent = `${state.server.maxUploadMb || 20} MB`));
  document.querySelectorAll(".install-link").forEach((a) => (a.href = installUrl()));
  if (hosted) el("maps-hint").textContent = "Unwanted holds devices you set aside. Empty it to download them as JSON files you can reopen later.";
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Surveys ---------- */

function hiddenSampleIds() {
  const raw = readLocal(HIDDEN_SAMPLES_KEY, []);
  return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
}

const sampleToSurvey = (s) => ({ id: s.id, kind: "sample", format: s.kind, name: s.name, summary: s.summary });

function renderSurveyList() {
  // Surveys were merged into the Maps list; a capture opens straight as a map. The survey registry
  // (state.surveys) still backs Compare and the sample "Opened" tags, but there's no list to draw.
  const list = el("survey-list");
  if (!list) return;
  list.innerHTML = "";
  el("survey-empty").classList.toggle("hidden", state.surveys.length > 0);
  for (const item of state.surveys) {
    const row = document.createElement("li");
    const active = `map:${item.id}` === state.activeMapId;
    row.className = `list-row${active ? " active" : ""}`;
    row.dataset.id = item.id;
    row.dataset.dragType = "survey";
    row.dataset.dropType = "survey";
    const sub = `${surveyHasTimeline(item) === false && item.id !== "empty-capture" ? "No timeline · " : ""}${item.kind === "upload" ? "Your capture" : item.summary}`;
    row.innerHTML = `<button type="button" class="row-main" title="${escapeHtml(item.summary || "")}"><span class="row-dot"></span><span class="row-text"><span class="row-title">${escapeHtml(item.name)}</span>
      <span class="row-sub">${escapeHtml(sub)}</span></span></button>
      <button type="button" class="icon-btn row-menu-btn" aria-label="Options for ${escapeHtml(item.name)}" aria-haspopup="menu" aria-expanded="false"><svg class="icon"><use href="#i-dots"/></svg></button>`;
    row.querySelector(".row-main").addEventListener("click", () => {
      selectSurvey(item.id);
      closeNarrowPanels();
    });
    row.querySelector(".row-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, surveyMenuItems(item), { align: "right" });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY, surveyMenuItems(item));
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
  const at = state.surveys.indexOf(item);
  hideSurvey(item);
  renderSurveyList();
  // The list isn't a map, so this isn't in Undo; the message offers its own way back.
  toast(`Removed ${item.name} from the list. Its map stays under Maps.`, { timeout: 6000, action: { label: "Bring back", onClick: () => bringBackSurvey(item, at) } });
}

function bringBackSurvey(item, at) {
  if (state.surveys.some((s) => s.id === item.id)) return;
  state.surveys.splice(Math.min(at, state.surveys.length), 0, item);
  unhideSurvey(item.id);
  renderSurveyList();
}

// Hidden surveys stay hidden after a reload: samples and your own captures alike.
function hideSurvey(item) {
  state.surveys = state.surveys.filter((s) => s.id !== item.id);
  const hidden = hiddenSampleIds();
  if (!hidden.includes(item.id)) writeLocal(HIDDEN_SAMPLES_KEY, [...hidden, item.id]);
}

function unhideSurvey(id) {
  const hidden = hiddenSampleIds();
  if (hidden.includes(id)) writeLocal(HIDDEN_SAMPLES_KEY, hidden.filter((h) => h !== id));
}

function surveyMenuItems(item) {
  const ownMap = `map:${item.id}`;
  return [
    { label: "Open", onSelect: () => selectSurvey(item.id) },
    { label: "Merge into…", disabled: mergeTargets(ownMap).length === 0, onSelect: () => mergeSurveyDialog(item.id) },
    { label: "Compare with a baseline…", disabled: item.id === "empty-capture", onSelect: () => openCompareDialog({ later: compareSourceFor("survey", item.id) }) },
    "sep",
    { label: "Remove from list", onSelect: () => removeSurvey(item.id) },
    { label: "Delete survey and its map…", danger: true, onSelect: () => deleteSurvey(item.id) },
  ];
}

async function deleteSurvey(id) {
  const item = state.surveys.find((s) => s.id === id);
  if (!item) return;
  const mapId = `map:${item.id}`;
  const map = getMap(mapId);
  const ok = await openDialog({
    title: `Delete “${item.name}”?`,
    body: map
      ? `This removes it from Surveys and deletes its map${mapNodeCount(map) ? ` (${plural(mapNodeCount(map), "device")})` : ""} with your edits. You can undo this right after.`
      : "This removes it from Surveys. You can undo this right after.",
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  if (map) snapshotUndo("delete map", [mapId]); // Undo brings the map back; the list is separate
  hideSurvey(item);
  if (map) {
    state.maps = state.maps.filter((m) => m.id !== mapId);
    store.deletedMaps.add(mapId);
    for (const k of Object.keys(metaCache)) if (k.startsWith(`${mapId}::`)) delete metaCache[k];
    markMetaDirty();
    markSessionDirty();
  }
  if (state.activeMapId === mapId) showMap((state.maps.find((m) => m.kind !== "unwanted") || getMap(UNWANTED_ID)).id);
  else renderMapList();
  renderSurveyList();
  toast(map ? `Deleted ${item.name} and its map.` : `Removed ${item.name}.`, { undo: Boolean(map), action: { label: "Bring back", onClick: () => bringBackSurvey(item, 0) }, timeout: 6000 });
}

// A survey's own map when it has one (with your edits), otherwise its graph as loaded.
async function surveySource(item) {
  const existing = getMap(`map:${item.id}`);
  if (existing && (mapNodeCount(existing) > 0 || existing.edited)) return existing;
  let graph = item.graph;
  if (!graph) {
    setBusy(true, `Loading ${item.name}…`);
    try {
      graph = await parseResponse(await fetch(`/api/samples/${encodeURIComponent(item.id)}/graph`));
    } finally {
      setBusy(false);
    }
  }
  return { id: `map:${item.id}`, name: item.name, kind: "survey", captures: graph?.meta?.sources || [], graph };
}

async function mergeSurveyInto(surveyId, destId) {
  const item = state.surveys.find((s) => s.id === surveyId);
  if (!item || !getMap(destId)) return;
  if (destId === `map:${item.id}`) {
    toast("That's this survey's own map.", { timeout: 2500 });
    return;
  }
  try {
    mergeMaps(await surveySource(item), destId);
  } catch (err) {
    fail(err);
  }
}

async function mergeSurveyDialog(surveyId) {
  const item = state.surveys.find((s) => s.id === surveyId);
  if (!item) return;
  const options = mergeTargets(`map:${item.id}`).map((m) => ({ value: m.id, label: `${m.name} (${plural(mapNodeCount(m), "device")})` }));
  const destId = await openDialog({ title: `Merge “${item.name}” into…`, body: "Its devices and links are copied into the map you choose. The survey stays as it is.", select: { options, label: "Destination map" }, okLabel: "Merge" });
  if (destId) mergeSurveyInto(surveyId, destId);
}

/* ---------- Security ---------- */

// Findings come from what the capture shows (open Wi-Fi, Telnet, old TLS); known vulnerabilities
// come from software versions in banners, matched offline against the bundled (or downloaded)
// database. The server does the matching; this draws it.
const SECURITY_COLORS = { critical: "#d6293e", high: "#f2711c", medium: "#e0a800", low: "#4c8dff" };
const SECURITY_NAMES = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const security = { seq: 0, overlay: null, overlayKey: null, loading: false, poll: null, dbInfo: null, discoverable: [] };

const epssText = (epss) => {
  if (epss == null) return "unknown";
  const p = epss * 100;
  return p < 0.1 ? "<0.1%" : `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
};
const sevChip = (sev, text) => `<span class="sev" style="--c: ${SECURITY_COLORS[sev] || "var(--muted)"}">${escapeHtml(text || SECURITY_NAMES[sev] || sev)}</span>`;
const cvssSev = (s) => String(s || "").toLowerCase();

async function assessNodes(nodes) {
  return parseResponse(
    await fetch("/api/security/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes, links: [] }),
    })
  );
}

function databaseLine(db) {
  if (!db || db.source === "none") return "No vulnerability data is available.";
  const when = db.generated ? formatTime(Date.parse(db.generated) / 1000, { date: true }).split(",").slice(0, 2).join(",") : "";
  return `Vulnerability data from NVD, FIRST EPSS, and CISA KEV, ${db.source === "downloaded" ? "downloaded" : "bundled"} ${escapeHtml(when)}.`;
}

function cveItem(v) {
  const sev = cvssSev(v.severity);
  return `<li>
      <div class="cve-head"><a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.id)}" target="_blank" rel="noopener">${escapeHtml(v.id)}</a>
        ${sev ? sevChip(sev, `${SECURITY_NAMES[sev] || v.severity}${v.cvss != null ? ` ${Number(v.cvss).toFixed(1)}` : ""}`) : ""}
        <span class="epss" title="EPSS: FIRST's estimate of the chance this is exploited in the wild in the next 30 days">EPSS ${epssText(v.epss)}</span>
        ${v.kev ? '<span class="kev" title="On CISA\'s list of vulnerabilities known to be exploited">Known exploited</span>' : ""}</div>
      ${v.summary ? `<p>${escapeHtml(v.summary)}</p>` : ""}
    </li>`;
}

const CVE_PREVIEW = 4;

function securityHtml(result, db) {
  const head = `<h3>Security ${result?.worst ? sevChip(result.worst) : ""}</h3>`;
  if (!result) {
    return `${head}<p class="hint">No security findings. NetSeer checks Wi-Fi security, the services a device offers, TLS versions, and software versions in banners against known vulnerabilities.</p><p class="hint sec-db">${databaseLine(db)}</p>`;
  }
  const findings = result.findings.length
    ? `<ul class="sec-findings">${result.findings
        .map((f) => `<li><details><summary>${sevChip(f.severity)} ${escapeHtml(f.title)}</summary>
            <p>${escapeHtml(f.why)}</p><p><strong>Fix:</strong> ${escapeHtml(f.fix)}</p>${f.evidence ? `<p class="hint">${escapeHtml(f.evidence)}</p>` : ""}</details></li>`)
        .join("")}</ul>`
    : "";
  const software = result.software
    .map((s, i) => {
      const n = s.vulnerabilities.length;
      const status = n
        ? `${plural(n, "known vulnerability", "known vulnerabilities")}`
        : !s.version
          ? "Version not shown, so it can't be checked for known vulnerabilities"
          : !s.known
            ? "Not in NetSeer's vulnerability data"
            : "No known vulnerabilities for this version";
      const distro = s.distro ? `<p class="hint sec-note">${escapeHtml(s.distro)} often fixes vulnerabilities without changing the version number, so some of these may already be patched. Check the device's updates.</p>` : "";
      const list = n
        ? `<ol class="sec-cves" data-soft="${i}">${s.vulnerabilities.slice(0, CVE_PREVIEW).map(cveItem).join("")}</ol>${n > CVE_PREVIEW ? `<button type="button" class="link-btn" data-sec-more="${i}">Show all ${n}</button>` : ""}`
        : "";
      return `<div class="sec-soft"><div class="sec-soft-head"><strong>${escapeHtml(s.label)}</strong> <small>${escapeHtml(s.source)}</small></div>
        <p class="hint">${status}</p>${distro}${list}</div>`;
    })
    .join("");
  const handshakes = (result.handshakes || [])
    .map((h) => {
      const label = `Message${h.messages.length > 1 ? "s" : ""} ${h.messages.join(", ")} of 4`;
      const note = h.crackable
        ? "Enough was captured to try the Wi-Fi password offline."
        : h.complete
          ? "A full handshake, but this network's security doesn't expose the password this way."
          : "Only part of the handshake was captured.";
      const exportRow = h.can_export
        ? `<div class="hs-export"><span class="hint">Export:</span>
            <button type="button" class="link-btn" data-hs-export="pcap" data-hs-peer="${escapeHtml(h.peer)}">pcap</button>${
              h.can_hashcat ? ` · <button type="button" class="link-btn" data-hs-export="hc22000" data-hs-peer="${escapeHtml(h.peer)}">hashcat</button>` : ""
            }</div>`
        : "";
      return `<li><div class="hs-head">${h.crackable ? sevChip("high", "Crackable") : ""}<strong>With ${escapeHtml(h.peer_label)}</strong></div>
        <p class="hint">${escapeHtml(label)}. ${escapeHtml(note)}</p>${exportRow}</li>`;
    })
    .join("");
  const hsBlock = handshakes
    ? `<h4 class="sec-sub">Wi-Fi handshake${result.handshakes.length > 1 ? "s" : ""} captured</h4><ul class="sec-handshakes">${handshakes}</ul>`
    : "";
  return `${head}${findings}${hsBlock}${software ? `<h4 class="sec-sub">Software it revealed</h4>${software}` : ""}<p class="hint sec-db">${databaseLine(db)}</p>`;
}

// Fills the Security section of a device's details.
async function loadDeviceSecurity(raw) {
  const box = el("insp-security");
  if (!box) return;
  const seq = ++security.seq;
  const cached = security.overlay?.nodes?.[raw.id];
  if (cached !== undefined && security.overlayKey === overlayKeyNow()) {
    box.innerHTML = securityHtml(cached, security.overlay.database);
  } else {
    box.innerHTML = '<h3>Security</h3><p class="hint">Checking…</p>';
    try {
      // Assess the whole map, not just this device, so a handshake's frames (kept on the access
      // point) are visible for export. Cached under the same key the map shading uses.
      const res = await assessNodes((state.graph?.nodes || []).filter(isDeviceNode).map(overlayNode));
      if (seq !== security.seq || !el("insp-security")) return;
      security.overlay = res;
      security.overlayKey = overlayKeyNow();
      box.innerHTML = securityHtml(res.nodes[raw.id], res.database);
    } catch (err) {
      if (seq === security.seq) box.innerHTML = `<h3>Security</h3><p class="field-error">${escapeHtml(err.message || String(err))}</p>`;
      return;
    }
  }
  box.querySelectorAll("[data-sec-more]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const res = security.overlay?.nodes?.[raw.id] ? { nodes: security.overlay.nodes } : await assessNodes([overlayNode(raw)]);
      const soft = res.nodes[raw.id].software[Number(btn.dataset.secMore)];
      box.querySelector(`.sec-cves[data-soft="${btn.dataset.secMore}"]`).innerHTML = soft.vulnerabilities.map(cveItem).join("");
      btn.remove();
    })
  );
  box.querySelectorAll("[data-hs-export]").forEach((btn) => btn.addEventListener("click", () => exportHandshake(raw.id, btn.dataset.hsPeer, btn.dataset.hsExport)));
}

// Download a captured handshake as a pcap or hashcat file. The whole map goes in the request so
// the server can find the frames (kept on the access point) and the network's beacon.
async function exportHandshake(nodeId, peer, format) {
  try {
    const res = await fetch("/api/security/handshake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: (state.graph?.nodes || []).map(overlayNode), node_id: nodeId, peer, format }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    const base = (displayName(nodeById(nodeId)) || "wifi").replace(/[^A-Za-z0-9._-]+/g, "_");
    await download(res, format === "hc22000" ? `${base}.hc22000` : `handshake-${base}.pcap`);
    toast(`Exported the handshake${format === "hc22000" ? " for hashcat" : ""}.`, { timeout: 2500 });
  } catch (err) {
    toast(err.message || String(err), { error: true });
  }
}

/* The map shaded by each device's worst finding (Layers → Security). */
const overlayKeyNow = () => `${state.activeMapId}|${state.graphVersion}|${state.metaVersion || 0}`;

async function refreshSecurityOverlay() {
  const map = getMap(state.activeMapId);
  renderSecurityLegend();
  if (!state.prefs.securityShade || !state.graph?.nodes?.length || isComparison(map)) {
    state.cy?.nodes("[security]").removeData("security");
    return;
  }
  const key = overlayKeyNow();
  if (security.overlayKey !== key) {
    security.loading = true;
    renderSecurityLegend();
    try {
      const res = await assessNodes(state.graph.nodes.filter(isDeviceNode).map(overlayNode));
      security.overlay = res;
      security.overlayKey = key;
    } catch (err) {
      fail(err);
      return;
    } finally {
      security.loading = false;
    }
  }
  applySecurityOverlay();
}

function applySecurityOverlay() {
  const cy = state.cy;
  if (!cy || !security.overlay || security.overlayKey !== overlayKeyNow() || !state.prefs.securityShade || isComparison(getMap(state.activeMapId))) return;
  cy.batch(() => {
    cy.nodes("[security]").removeData("security");
    for (const [id, r] of Object.entries(security.overlay.nodes)) if (r.worst) cy.getElementById(id).data("security", r.worst);
  });
  renderSecurityLegend();
}

function renderSecurityLegend() {
  const map = getMap(state.activeMapId);
  const on = Boolean(state.prefs.securityShade);
  el("security-toggle").checked = on;
  const comparing = isComparison(map);
  el("security-toggle").disabled = comparing;
  el("security-row").classList.toggle("is-disabled", comparing);
  el("security-note").textContent = comparing ? "Comparison maps use shading to show changes." : "Shade devices by their most serious finding";
  const box = el("security-counts");
  if (!on || comparing) {
    box.innerHTML = "";
    return;
  }
  if (security.loading || security.overlayKey !== overlayKeyNow()) {
    box.innerHTML = '<li class="hint">Checking…</li>';
    return;
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of Object.values(security.overlay?.nodes || {})) if (r.worst) counts[r.worst] += 1;
  const devices = (state.graph?.nodes || []).filter(isDeviceNode).length;
  const flagged = Object.values(counts).reduce((s, n) => s + n, 0);
  box.innerHTML = [
    ...Object.entries(counts).map(([sev, n]) => `<li><i class="change-swatch" style="--c: ${SECURITY_COLORS[sev]}"></i><span>${SECURITY_NAMES[sev]}</span><b>${n.toLocaleString()}</b></li>`),
    `<li><i class="change-swatch same"></i><span>Nothing found</span><b>${Math.max(0, devices - flagged).toLocaleString()}</b></li>`,
  ].join("");
}

/* Settings → Security: the vulnerability data, and updating it. */
async function renderSecurityPane() {
  let info;
  try {
    info = await parseResponse(await fetch("/api/security/database"));
  } catch (err) {
    el("vdb-status").textContent = err.message || String(err);
    return;
  }
  const use = info.in_use;
  el("vdb-inuse").textContent = !use ? "None" : info.active === "downloaded" ? "Downloaded" : "Bundled with this version";
  const date = (iso) => (iso ? formatTime(Date.parse(iso.length <= 10 ? `${iso}T12:00:00Z` : iso) / 1000, { date: true }).split(",").slice(0, 2).join(",") : "unknown");
  el("vdb-detail").textContent = use ? `${use.vulnerabilities.toLocaleString()} known vulnerabilities in ${use.products} products, updated ${date(use.generated)}` : "";
  el("vdb-facts").innerHTML = use
    ? `${factRow("Exploit likelihood (EPSS)", date(use.epss_date))}${factRow("Known exploited (CISA)", date(use.kev_date))}${info.bundled ? factRow("Bundled copy", date(info.bundled.generated)) : ""}${info.downloaded ? factRow("Downloaded copy", date(info.downloaded.generated)) : ""}`
    : "";
  show("vdb-online", info.can_refresh);
  show("vdb-hosted", !info.can_refresh);
  security.dbInfo = info;
  // Which products from the user's own captures a rebuild could newly look up.
  security.discoverable = [];
  if (info.can_refresh && navigator.onLine && info.refresh?.state !== "running") {
    try {
      security.discoverable = (await parseResponse(await fetch("/api/security/discoverable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ banners: securityBanners() }) }))).products || [];
    } catch {
      /* preview only; the rebuild still looks them up */
    }
  }
  showRefresh(info.refresh);
}

// Distinct product banners NetSeer saw across every map, to look up on a rebuild.
function securityBanners() {
  const set = new Set();
  for (const m of state.maps) for (const n of m.graph?.nodes || []) for (const s of (n.extra || {}).software || []) if (s.raw) set.add(String(s.raw));
  return [...set];
}

function renderDiscoverable() {
  const box = el("vdb-extra");
  const info = security.dbInfo;
  const running = info?.refresh?.state === "running";
  const names = (list) => list.map((d) => d.name).join(", ");
  if (running) {
    box.classList.add("hidden");
    return;
  }
  const found = (info?.discovered || []).filter((d) => d.found);
  if (security.discoverable?.length) {
    box.className = "vdb-extra warn";
    box.textContent = `NetSeer saw ${plural(security.discoverable.length, "service")} in your captures it doesn't recognize yet (${names(security.discoverable)}). Update the database to look ${security.discoverable.length > 1 ? "them" : "it"} up.`;
  } else if (found.length) {
    box.className = "vdb-extra good";
    box.textContent = `Looked up from your captures: ${names(found)}.`;
  } else {
    box.classList.add("hidden");
  }
}

// How stale the data is, in whole days (from whichever copy is in use).
function vulndbAgeDays(info) {
  const gen = info?.in_use?.generated;
  const t = gen ? Date.parse(gen.length <= 10 ? `${gen}T12:00:00Z` : gen) : NaN;
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

// The rebuild button is the call to action: bright and inviting when online (brighter still when
// the data is old), and clearly held back with a reason when offline or already current.
const VULNDB_STALE_DAYS = 14;

function syncRefreshButton() {
  const info = security.dbInfo;
  const btn = el("vdb-update");
  const cta = el("vdb-cta");
  if (!info || !info.can_refresh || info.refresh?.state === "running") {
    btn?.classList.remove("attention");
    if (cta) cta.classList.add("hidden");
    return;
  }
  const online = navigator.onLine;
  const age = vulndbAgeDays(info);
  const stale = age != null && age >= VULNDB_STALE_DAYS;
  const newServices = (security.discoverable || []).length > 0;
  btn.disabled = !online;
  // The button invites a click when there's something to gain: old data, or services to look up.
  btn.classList.toggle("attention", online && (stale || newServices));
  cta.classList.remove("hidden", "good", "warn");
  if (!online) {
    cta.textContent = "Connect to the internet, then update the database to get the latest vulnerability data.";
  } else if (stale) {
    cta.textContent = `This data is ${plural(age, "day")} old. Update the database to check devices against the latest known vulnerabilities.`;
    cta.classList.add("warn");
  } else if (age != null) {
    cta.textContent = age <= 1 ? "Your vulnerability data is up to date. Update it any time to refresh it." : `Your vulnerability data is ${plural(age, "day")} old. Update it any time to refresh it.`;
    cta.classList.add("good");
  } else {
    cta.classList.add("hidden");
  }
  renderDiscoverable();
}

function showRefresh(job) {
  const running = job?.state === "running";
  show("vdb-progress", running);
  el("vdb-update").disabled = running;
  if (running) {
    el("vdb-step").textContent = job.step || "Starting…";
    el("vdb-bar").style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 3}%`;
  }
  const status = el("vdb-status");
  status.className = "update-status";
  if (job?.state === "error") {
    status.textContent = job.error;
    status.classList.add("bad");
  } else if (job?.state === "stopped") status.textContent = "Update stopped. The data you had is still in use.";
  else if (job?.state === "done") {
    status.textContent = "Vulnerability data updated.";
    status.classList.add("good");
  } else status.textContent = "";
  clearInterval(security.poll);
  if (running) security.poll = setInterval(pollRefresh, 1200);
  syncRefreshButton();
}

async function pollRefresh() {
  try {
    const info = await parseResponse(await fetch("/api/security/database"));
    const before = el("vdb-progress").classList.contains("hidden");
    showRefresh(info.refresh);
    if (info.refresh.state !== "running" && !before) {
      // New data: forget what was matched against the old.
      security.overlayKey = null;
      renderSecurityPane();
      refreshSecurityOverlay();
      if (state.selection.length === 1 && el("insp-security")) loadDeviceSecurity(nodeById(state.selection[0]));
    }
  } catch {
    /* the next poll tries again */
  }
}

function bindSecurity() {
  el("security-toggle").addEventListener("change", (e) => {
    state.prefs.securityShade = e.target.checked;
    savePrefs();
    refreshSecurityOverlay();
  });
  el("vdb-update").addEventListener("click", async () => {
    try {
      // Send the banners we've seen so the rebuild also looks up products NetSeer doesn't know.
      showRefresh(await parseResponse(await fetch("/api/security/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ banners: securityBanners() }) })));
    } catch (err) {
      el("vdb-status").textContent = err.message || String(err);
    }
  });
  el("vdb-cancel").addEventListener("click", () => fetch("/api/security/refresh/cancel", { method: "POST" }));
  // Keep the button's invitation honest as the connection comes and goes.
  const onConnectivity = () => {
    if (el("settings-dialog").open && !el("vdb-online").classList.contains("hidden")) syncRefreshButton();
  };
  window.addEventListener("online", onConnectivity);
  window.addEventListener("offline", onConnectivity);
}

/* ---------- Demo (Settings) ---------- */

// The sample captures, opened on request: none are loaded until you pick one.
const DEMO_SKIP = new Set(["empty-capture"]);

async function openDemo(id) {
  const sample = state.catalog.find((s) => s.id === id);
  if (!sample) return;
  unhideSurvey(id);
  if (!state.surveys.some((s) => s.id === id)) state.surveys = sortSurveys([...state.surveys, sampleToSurvey(sample)]);
  renderSurveyList();
  await selectSurvey(id);
}

function renderDemo() {
  const list = el("demo-list");
  list.innerHTML = "";
  for (const s of state.catalog.filter((x) => !DEMO_SKIP.has(x.id))) {
    const opened = mapNodeCount(getMap(`map:${s.id}`)) > 0;
    const untimed = UNTIMED_KINDS.has(s.kind);
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="release-name">${escapeHtml(s.name)}</span>${opened ? '<span class="release-tag">Opened</span>' : ""}
        <span class="release-meta">${escapeHtml(s.summary)}${untimed ? " · no timeline" : ""}</span></span>
      <span class="release-actions"><button type="button" class="btn small${opened ? " ghost" : ""}" data-demo="${escapeHtml(s.id)}">${opened ? "Show" : "Open"}</button></span>`;
    list.appendChild(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="hint">No samples in this copy of NetSeer.</li>';
  show("demo-compare-row", state.catalog.some((s) => s.id === "branch-baseline") && state.catalog.some((s) => s.id === "branch-later"));
}

// Opens both branch office samples and sets up Compare surveys with them.
async function demoCompare() {
  el("settings-dialog").close();
  await openDemo("branch-baseline");
  await openDemo("branch-later");
  openCompareDialog({ baseline: { value: "m|map:branch-baseline" }, later: { value: "m|map:branch-later" } });
}

function bindDemo() {
  el("demo-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-demo]");
    if (!btn) return;
    el("settings-dialog").close();
    openDemo(btn.dataset.demo);
  });
  el("demo-compare").addEventListener("click", demoCompare);
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
  const limit = state.server.maxUploadMb;
  if (limit && file.size > limit * 1024 * 1024) {
    // Only the public online copy has a limit; installed copies read captures of any size.
    toast(`${file.name} is ${formatSize(file.size)}, more than this online copy's ${limit} MB limit. Install NetSeer to open bigger captures: it has no size limit.`, {
      error: true,
      timeout: 12000,
      action: { label: "Get NetSeer", onClick: () => window.open(installUrl(), "_blank", "noopener") },
    });
    return;
  }
  const job = { file, xhr: null, id: null, cancelled: false };
  readJob.current = job;
  setBusy(true, `Opening ${file.name}…`);
  showReadingControls(true);
  try {
    const started = await uploadForReading(job);
    job.id = started.id;
    await followReading(job);
    if (job.cancelled) return;
    const graph = await parseResponse(await fetch(`/api/parse/jobs/${encodeURIComponent(job.id)}/result`));
    setBusy(false);
    const id = `upload:${file.name}`;
    const item = { id, kind: "upload", name: file.name, summary: "Your capture", graph };
    const at = state.surveys.findIndex((s) => s.id === id);
    if (at >= 0) state.surveys.splice(at, 1, item);
    else state.surveys.unshift(item);
    unhideSurvey(id);
    applyGraph(graph, file.name, id);
    // Their own capture is worth keeping; Firefox asks here, other browsers decide quietly.
    requestPersistentStorage();
  } catch (err) {
    setBusy(false);
    if (!job.cancelled) fail(new Error(`${file.name}: ${err.message || err}`));
  } finally {
    if (readJob.current === job) readJob.current = null;
    showReadingControls(false);
    setBusy(false);
  }
}

/* ---------- Integration: live events from companion apps (e.g. WaveTop) ---------- */

let eventsSocket = null;
let eventsRetry = 0;

function connectEvents() {
  if (state.server.mode === "hosted") return; // the public copy has no integration API
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let sock;
  try {
    sock = new WebSocket(`${proto}//${location.host}/api/v1/events`);
  } catch {
    return;
  }
  eventsSocket = sock;
  sock.onopen = () => {
    eventsRetry = 0;
  };
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.type === "capture-received") receivePushedCapture(msg);
    else if (msg.type === "live-update") applyLiveUpdate(msg);
    else if (msg.type === "session-ended") endLiveSession(msg);
  };
  sock.onclose = () => {
    if (eventsSocket === sock) eventsSocket = null;
    // Reconnect with backoff; the server may just be restarting after an update.
    eventsRetry = Math.min(eventsRetry + 1, 6);
    setTimeout(connectEvents, 500 * 2 ** (eventsRetry - 1));
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      /* onclose handles the retry */
    }
  };
}

// A companion app pushed a capture: follow the reading job it started and show it as a map.
async function receivePushedCapture(msg) {
  const name = msg.name || "capture";
  const source = msg.source || "A device";
  toast(`${source} sent ${name} — reading…`, { timeout: 4000 });
  try {
    for (;;) {
      const status = await parseResponse(await fetch(`/api/parse/jobs/${encodeURIComponent(msg.job_id)}`));
      if (status.state !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const graph = await parseResponse(await fetch(`/api/parse/jobs/${encodeURIComponent(msg.job_id)}/result`));
    const id = `push:${msg.job_id}`;
    const item = { id, kind: "upload", name, summary: `Pushed by ${source}`, graph };
    const at = state.surveys.findIndex((s) => s.id === id);
    if (at >= 0) state.surveys.splice(at, 1, item);
    else state.surveys.unshift(item);
    unhideSurvey(id);
    applyGraph(graph, name, id);
    toast(`${source} sent ${name}`, { timeout: 3000 });
  } catch (err) {
    toast(`Couldn't read the capture ${source} sent: ${err.message || err}`, { error: true, timeout: 7000 });
  }
}

// A companion app is streaming a wardrive live: keep a map that updates as observations arrive.
const liveSeen = new Set();

function applyLiveUpdate(msg) {
  if (!msg.graph) return;
  const id = `live:${msg.session_id}`;
  const mapId = `map:${id}`;
  const name = `Live wardrive${msg.source ? ` · ${msg.source}` : ""}`;
  const first = !liveSeen.has(id);
  liveSeen.add(id);
  const item = { id, kind: "upload", name, summary: msg.source ? `Live from ${msg.source}` : "Live wardrive", graph: msg.graph };
  const at = state.surveys.findIndex((s) => s.id === id);
  if (at >= 0) state.surveys.splice(at, 1, item);
  else state.surveys.unshift(item);
  unhideSurvey(id);
  upsertMap({ id: mapId, name, kind: "survey", sourceId: id, captures: [], graph: msg.graph });
  if (first) {
    toast(`${msg.source || "A device"} started a live wardrive`, { timeout: 3500 });
    showMap(mapId); // switch to it so the wardrive builds in front of you
  } else if (state.activeMapId === mapId) {
    state.graph = getMap(mapId).graph;
    refreshAll({ fit: false }); // grow in place without yanking the view
  } else {
    renderSurveyList();
  }
}

function endLiveSession(msg) {
  const id = `live:${msg.session_id}`;
  if (!liveSeen.has(id)) return;
  liveSeen.delete(id);
  toast(`${msg.source || "The device"} ended the wardrive`, { timeout: 3500 });
}

/* ---------- Settings: Integrations (pairing + paired devices) ---------- */

let pairTimer = null;
const intgWhen = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

let intgNet = { enabled: false, reachable: false, addresses: [], restart_needed: false };

// These management calls only answer NetSeer's own window (see _guard_own_window in web.py).
async function intgApi(path, { method = "GET", body } = {}) {
  const headers = { "X-NetSeer-Window": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  return parseResponse(res);
}

// Where a companion app should reach this NetSeer: a network address when shared, else this computer.
function pairAddress() {
  if (intgNet.reachable && intgNet.addresses.length) {
    return `${intgNet.addresses[0]}:${location.port || (location.protocol === "https:" ? "443" : "80")}`;
  }
  return location.host;
}

function renderIntegrations() {
  clearPairingCode();
  renderNetwork();
  renderDevices();
}

async function renderNetwork() {
  try {
    intgNet = await intgApi("/network");
  } catch {
    intgNet = { enabled: false, reachable: false, addresses: [], restart_needed: false };
  }
  el("intg-lan").checked = !!intgNet.enabled;
  el("intg-address").textContent =
    intgNet.reachable && intgNet.addresses.length ? `${pairAddress()} (on your network)` : `${location.host} (on this computer)`;
  const info = el("intg-lan-info");
  if (!intgNet.enabled) {
    info.textContent = "Off — only apps on this computer can reach NetSeer.";
  } else if (intgNet.restart_needed) {
    info.innerHTML = "On — <strong>restart NetSeer</strong> so devices on your network can reach it.";
  } else if (intgNet.addresses.length) {
    info.innerHTML = `On — companion apps can reach NetSeer at <code>${escapeHtml(pairAddress())}</code>.`;
  } else {
    info.textContent = "On — but NetSeer couldn't find a network address.";
  }
}

async function setLan(enabled) {
  try {
    intgNet = await intgApi("/network", { method: "POST", body: { enabled } });
    renderNetwork();
    if (enabled && intgNet.restart_needed) toast("Restart NetSeer so devices on your network can reach it.", { timeout: 6000 });
  } catch (err) {
    toast(`Couldn't change network sharing: ${err.message || err}`, { error: true });
    renderNetwork();
  }
}

function clearPairingCode() {
  if (pairTimer) {
    clearInterval(pairTimer);
    pairTimer = null;
  }
  const box = el("intg-code");
  box.classList.add("hidden");
  box.innerHTML = "";
}

async function startPairing() {
  try {
    const { code, expires_in } = await intgApi("/pair/start", { method: "POST" });
    showPairingCode(code, expires_in || 300);
  } catch (err) {
    toast(`Couldn't start pairing: ${err.message || err}`, { error: true });
  }
}

function showPairingCode(code, seconds) {
  if (pairTimer) clearInterval(pairTimer);
  const box = el("intg-code");
  box.classList.remove("hidden");
  const digits = String(code).replace(/(\d{3})(\d{3})/, "$1 $2");
  let left = seconds;
  const paint = () => {
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    box.innerHTML = `<div class="pair-code">${escapeHtml(digits)}</div>
      <div class="hint">In WaveTop, add NetSeer at <code>${escapeHtml(pairAddress())}</code> and enter this code. It expires in ${mm}:${ss}.</div>`;
  };
  paint();
  pairTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(pairTimer);
      pairTimer = null;
      box.innerHTML = `<div class="hint">That code expired. Select <strong>Pair a device</strong> for a new one.</div>`;
      renderDevices();
      return;
    }
    paint();
  }, 1000);
}

async function renderDevices() {
  const list = el("intg-devices");
  let devices = [];
  try {
    devices = (await intgApi("/devices")).devices || [];
  } catch {
    devices = [];
  }
  show("intg-empty", devices.length === 0);
  list.innerHTML = "";
  for (const d of devices) {
    const li = document.createElement("li");
    const used = d.last_used ? `last used ${intgWhen(d.last_used)}` : "not used yet";
    const info = document.createElement("div");
    info.innerHTML = `<strong>${escapeHtml(d.name)}</strong><small>Paired ${escapeHtml(intgWhen(d.created))} · ${escapeHtml(used)}</small>`;
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.type = "button";
    btn.textContent = "Revoke";
    btn.addEventListener("click", () => revokeDevice(d.id, d.name));
    li.append(info, btn);
    list.appendChild(li);
  }
}

async function revokeDevice(id, name) {
  const ok = await openDialog({
    title: `Revoke ${name}?`,
    body: "It won't be able to push captures to NetSeer until you pair it again.",
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await intgApi(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`Revoked ${name}`, { timeout: 2500 });
    renderDevices();
  } catch (err) {
    toast(`Couldn't revoke ${name}: ${err.message || err}`, { error: true });
  }
}

/* ---------- Reading big captures: upload, progress, stop, cancel ---------- */

const readJob = { current: null };
const installUrl = () => repoUrl("/releases/latest");

function showReadingControls(on) {
  show("loading-progress", on);
  show("loading-detail", on);
  show("loading-actions", on);
  el("loading").classList.toggle("interactive", on);
  el("loading-stop").disabled = false;
  el("loading-stop").textContent = "Stop and show map";
  if (on) setReadingProgress(0, "");
}

function setReadingProgress(fraction, detail) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  el("loading-bar").style.width = `${pct}%`;
  el("loading-progress").setAttribute("aria-valuenow", String(pct));
  el("loading-detail").textContent = detail;
}

// Sends the file as the raw request body, so the server can write it straight to disk.
function uploadForReading(job) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.open("POST", `/api/parse/jobs?name=${encodeURIComponent(job.file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || job.cancelled) return;
      el("loading-msg").textContent = `Sending ${job.file.name} to NetSeer…`;
      setReadingProgress(e.loaded / e.total, `${formatSize(e.loaded)} of ${formatSize(e.total)}`);
    };
    xhr.onload = () => {
      job.xhr = null;
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* keep {} */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.detail || `The server answered ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error("The upload stopped. Is NetSeer still running?"));
    xhr.onabort = () => reject(new Error("Cancelled."));
    xhr.send(job.file);
  });
}

async function followReading(job) {
  const name = job.file.name;
  for (;;) {
    if (job.cancelled) return null;
    const status = await parseResponse(await fetch(`/api/parse/jobs/${encodeURIComponent(job.id)}`));
    if (status.state !== "running") return status;
    el("loading-msg").textContent = status.stopping ? `Finishing the map of ${name}…` : `Reading ${name}…`;
    const parts = [`${Math.round(status.fraction * 100)}%`];
    if (status.packets) parts.push(`${status.packets.toLocaleString()} packets`);
    if (status.devices) parts.push(plural(status.devices, "device"));
    parts.push(`${Math.round(status.elapsed)} s`);
    setReadingProgress(status.fraction, parts.join(" · "));
    await new Promise((r) => setTimeout(r, status.elapsed < 3 ? 150 : 400));
  }
}

async function stopReading() {
  const job = readJob.current;
  if (!job?.id) return;
  el("loading-stop").disabled = true;
  el("loading-stop").textContent = "Stopping…";
  try {
    await fetch(`/api/parse/jobs/${encodeURIComponent(job.id)}/stop`, { method: "POST" });
  } catch {
    /* the next status poll shows what happened */
  }
}

function cancelReading() {
  const job = readJob.current;
  if (!job) return;
  job.cancelled = true;
  job.xhr?.abort();
  if (job.id) fetch(`/api/parse/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" }).catch(() => {});
  showReadingControls(false);
  setBusy(false);
  toast(`Cancelled opening ${job.file.name}.`, { timeout: 2500 });
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
    if (n.data("synthetic")) return;
    const p = n.position();
    positions[n.id()] = [Math.round(p.x), Math.round(p.y)];
    const parent = n.data("parent");
    if (parent && !cy.getElementById(parent).data("synthetic")) parents[n.id()] = parent;
  });
  return { positions, parents };
}

function graphWithUserFields() {
  const win = currentWindow();
  const inWindow = (item) => !win || !hasSeen(item) || seenIn(item, win);
  let raw = state.graph?.nodes || [];
  let links = state.graph?.links || [];
  let meta = state.graph?.meta || {};
  if (win) {
    // Exports follow the time window, like the map: what you see is what you get.
    raw = raw.filter((n) => !isDeviceNode(n) || inWindow(n));
    const kept = new Set(raw.map((n) => n.id));
    links = links.filter((l) => inWindow(l) && kept.has(l.source) && kept.has(l.target));
    meta = { ...meta, time_window: `${formatTime(win[0], { date: true })} – ${formatTime(win[1], { date: true })} (${timeZoneLabel()})` };
  }
  const nodes = raw.map((n) => overlayNode(n));
  return { ...state.graph, meta, links, title: state.title, nodes, ...layoutHints() };
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

async function exportKind(kind, extra = {}) {
  if (!state.graph?.nodes?.length) return;
  const ext = { drawio: "drawio", vsdx: "vsdx", vdx: "vdx", "report.pdf": "pdf" }[kind];
  try {
    const res = await fetch(`/api/export/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...graphWithUserFields(), ...extra }),
    });
    if (!res.ok) throw new Error((await parseResponse(res).catch((e) => e)).message || "Export failed");
    await download(res, `${safeFileStem(state.title)}${kind === "report.pdf" ? "-report" : ""}.${ext}`);
    toast(`Exported ${state.title}.`, { timeout: 2000 });
  } catch (err) {
    fail(err);
  }
}

/* ---------- Report options ---------- */

const REPORT_PREFS_KEY = "netseer.report.v1";
// Core sections that the presets toggle. "geomap" is an extra, independent of presets, enabled only
// when the survey has GPS; it's read from the form but never set by a preset.
const REPORT_SECTIONS = ["summary", "inventory", "devices", "links"];
const REPORT_FIELDS = ["identity", "radio", "services", "routing", "connections", "notes", "other"];
const REPORT_CATEGORIES = [
  ["router", "Routers and gateways"],
  ["server", "Servers"],
  ["ap", "Access points"],
  ["host", "Hosts"],
  ["wireless", "Wireless clients"],
  ["network", "Subnets and VLANs"],
];
const REPORT_PRESETS = {
  overview: { sections: ["summary", "inventory"], field_groups: REPORT_FIELDS.slice(0, 6), include_empty: false },
  standard: { sections: REPORT_SECTIONS, field_groups: REPORT_FIELDS.slice(0, 6), include_empty: false },
  everything: { sections: REPORT_SECTIONS, field_groups: REPORT_FIELDS, include_empty: true },
};
const LINES_PER_PAGE = 50;

// Same buckets the server uses (reports.device_category).
function reportCategory(raw) {
  const role = nodeRole(overlayNode(raw));
  if (role === "gateway") return "router";
  if (role === "subnet" || role === "vlan") return "network";
  return role;
}

function reportForm() {
  return el("report-form");
}

function readReportForm() {
  const form = reportForm();
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const opts = {
    sections: checked("section"),
    categories: checked("category"),
    field_groups: checked("field"),
    include_empty: form.querySelector('input[name="include_empty"]').checked,
  };
  if (form.querySelector('input[name="scope"]:checked')?.value === "selected") opts.node_ids = [...state.selection];
  if (form.querySelector('input[name="match_layers"]').checked) opts.link_kinds = LAYERS.map((l) => l.kind).filter((k) => state.filters[k] !== false);
  return opts;
}

function writeReportForm(opts) {
  const form = reportForm();
  const set = (name, values) => form.querySelectorAll(`input[name="${name}"]`).forEach((i) => (i.checked = values.includes(i.value)));
  if (opts.sections) set("section", opts.sections);
  if (opts.field_groups) set("field", opts.field_groups);
  if (opts.categories) set("category", opts.categories);
  if (typeof opts.include_empty === "boolean") form.querySelector('input[name="include_empty"]').checked = opts.include_empty;
  if (typeof opts.match_layers === "boolean") form.querySelector('input[name="match_layers"]').checked = opts.match_layers;
}

function reportScope(opts) {
  const wanted = opts.node_ids ? new Set(opts.node_ids) : null;
  const nodes = (state.graph?.nodes || []).filter((n) => opts.categories.includes(reportCategory(n)) && (!wanted || wanted.has(n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  const kinds = opts.link_kinds ? new Set(opts.link_kinds) : null;
  const links = (state.graph?.links || []).filter((l) => (ids.has(l.source) || ids.has(l.target)) && (!kinds || kinds.has(l.kind)));
  return { nodes, links };
}

// Rough page count so people can see a big report coming before they make it.
function estimateReportPages(opts, nodes, links) {
  let pages = 0;
  let front = 0;
  if (opts.sections.includes("summary")) front += 24;
  if (opts.sections.includes("inventory")) front += 4 + nodes.length * 1.5;
  if (front) pages += Math.ceil(front / LINES_PER_PAGE);
  if (opts.sections.includes("devices") && opts.field_groups.length) {
    const peers = new Map();
    for (const l of links) {
      for (const [a, b] of [[l.source, l.target], [l.target, l.source]]) {
        if (!peers.has(a)) peers.set(a, new Set());
        peers.get(a).add(b);
      }
    }
    const count = (n, keys) => keys.filter((k) => (Array.isArray(n[k]) ? n[k].length : n[k] != null && n[k] !== "")).length;
    let lines = 0;
    for (const raw of nodes) {
      const n = overlayNode(raw);
      const full = opts.include_empty;
      const g = {
        identity: full ? 13 : count(n, ["caption", "ips", "macs", "mac_tx", "mac_rx", "mac_da", "mac_ra", "vendor", "vlans", "roles", "id"]),
        radio: full ? 6 : count(n, ["ssids", "channels", "frequencies_mhz", "encryption", "signal_dbm", "gps"]),
        services: full ? 2 : count(n, ["services", "ports"]),
        routing: Object.keys(n.routing || {}).length,
        connections: peers.get(n.id)?.size || 0,
        notes: full || n.notes ? 1 : 0,
        other: Object.keys(n.extra || {}).length * 1.6,
      };
      lines += 3;
      for (const key of opts.field_groups) if (g[key]) lines += g[key] + 1;
    }
    // Device blocks are kept whole, which leaves gaps at page ends.
    pages += Math.ceil((lines * 1.25) / LINES_PER_PAGE);
  }
  if (opts.sections.includes("links") && links.length) pages += Math.ceil((4 + links.length * 1.2) / LINES_PER_PAGE);
  return Math.max(1, pages);
}

function syncReportDialog() {
  const form = reportForm();
  const opts = readReportForm();
  const { nodes, links } = reportScope(opts);
  el("report-fields-set").disabled = !opts.sections.includes("devices");
  const devices = nodes.filter((n) => reportCategory(n) !== "network").length;
  el("report-estimate").textContent = `About ${plural(estimateReportPages(opts, nodes, links), "page")} · ${plural(devices, "device")} · ${plural(links.length, "link")}`;
  let problem = "";
  if (!opts.sections.length) problem = "Choose at least one section.";
  else if (!nodes.length) problem = "No devices match. Pick at least one device type, or select devices on the map.";
  else if (opts.sections.length === 1 && opts.sections[0] === "devices" && !opts.field_groups.length) problem = "Choose at least one kind of detail.";
  el("report-error").textContent = problem;
  el("report-error").classList.toggle("hidden", !problem);
  el("report-create").disabled = Boolean(problem);
  for (const [name, preset] of Object.entries(REPORT_PRESETS)) {
    const same = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
    const match = same(opts.sections, preset.sections) && same(opts.field_groups, preset.field_groups) && opts.include_empty === preset.include_empty;
    form.querySelector(`[data-preset="${name}"]`).setAttribute("aria-pressed", String(match));
  }
}

function openReportDialog() {
  if (!state.graph?.nodes?.length) return;
  const counts = {};
  for (const n of state.graph.nodes) counts[reportCategory(n)] = (counts[reportCategory(n)] || 0) + 1;
  el("report-categories").innerHTML = REPORT_CATEGORIES.map(
    ([key, label]) =>
      `<label><input type="checkbox" name="category" value="${key}" ${counts[key] ? "checked" : "disabled"} /><span>${escapeHtml(label)} <span class="count">${counts[key] || 0}</span></span></label>`
  ).join("");
  const selected = state.selection.length;
  const devices = state.graph.nodes.filter((n) => reportCategory(n) !== "network").length;
  el("scope-all-label").textContent = `All devices (${devices})`;
  el("scope-selected-label").textContent = selected ? `Selected devices (${selected})` : "Selected devices (none selected)";
  const selectedRadio = reportForm().querySelector('input[name="scope"][value="selected"]');
  selectedRadio.disabled = !selected;
  reportForm().querySelector(`input[name="scope"][value="${selected > 1 ? "selected" : "all"}"]`).checked = true;

  const saved = readLocal(REPORT_PREFS_KEY, null);
  writeReportForm({ ...REPORT_PRESETS.standard, match_layers: false, ...(isPlainObject(saved) ? saved : {}) });
  if (isPlainObject(saved) && Array.isArray(saved.categories)) {
    // Keep remembered type choices, but never re-check a type this map doesn't have.
    reportForm().querySelectorAll('input[name="category"]').forEach((i) => (i.checked = !i.disabled && saved.categories.includes(i.value)));
    if (!reportForm().querySelector('input[name="category"]:checked')) reportForm().querySelectorAll('input[name="category"]:not(:disabled)').forEach((i) => (i.checked = true));
  }
  // The geo-map option only makes sense when the survey has GPS; hide it otherwise.
  const hasGeo = geoDevices().length > 0;
  const geoBox = reportForm().querySelector('input[name="section"][value="geomap"]');
  geoBox.disabled = !hasGeo;
  if (!hasGeo) geoBox.checked = false;
  show("report-geomap-label", hasGeo);
  syncReportDialog();
  el("report-dialog").showModal();
}

function bindReportDialog() {
  const form = reportForm();
  form.addEventListener("change", syncReportDialog);
  form.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      writeReportForm(REPORT_PRESETS[btn.dataset.preset]);
      syncReportDialog();
    })
  );
  el("report-cancel").addEventListener("click", () => el("report-dialog").close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncReportDialog();
    if (el("report-create").disabled) return;
    const opts = readReportForm();
    const { node_ids, link_kinds, ...remember } = opts;
    writeLocal(REPORT_PREFS_KEY, { ...remember, match_layers: Boolean(link_kinds) });
    el("report-dialog").close();
    const wantGeo = opts.sections.includes("geomap");
    toast(wantGeo ? "Capturing the map and creating your report…" : "Creating your report…", { timeout: 2500 });
    let geoImage = null;
    if (wantGeo) {
      try {
        geoImage = await geoImageDataUrl();
      } catch {
        toast("Couldn't capture the map; the report will leave it out.", { timeout: 2500 });
      }
    }
    exportKind("report.pdf", { report: opts, ...(geoImage ? { geo_image: geoImage } : {}) });
  });
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
  if (WHEEL_ZOOM_PER_PIXEL[prefs.zoomSpeed]) state.prefs.zoomSpeed = prefs.zoomSpeed;
  // Before 0.4.8 the layout was saved whether or not anyone chose it, so only a real choice sticks.
  if (LAYOUTS[prefs.layout] && prefs.layoutPicked) {
    state.prefs.layout = prefs.layout;
    state.prefs.layoutPicked = true;
  }
  if (typeof prefs.timeZone === "string") state.prefs.timeZone = prefs.timeZone;
  if (["auto", "12", "24"].includes(prefs.clock)) state.prefs.clock = prefs.clock;
  for (const k of ["hoverFade", "apSsid", "autoUpdate", "tourOffered", "securityShade"]) if (typeof prefs[k] === "boolean") state.prefs[k] = prefs[k];
  // Version 2 turned hover fading off by default; earlier copies saved it as on without asking.
  if (!(prefs.prefsVersion >= 2)) state.prefs.hoverFade = false;
  state.prefs.prefsVersion = 2;
  if (Number.isFinite(prefs.sidebarWidth)) setSidebarWidth(prefs.sidebarWidth, { save: false });
}

function savePrefs() {
  writeLocal(PREFS_KEY, { filters: state.filters, ...state.prefs });
}

function renderLayerList() {
  const list = el("layer-list");
  list.innerHTML = "";
  for (const layer of LAYERS.filter((l) => l.kind !== "subnet")) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const covered = membershipHidden(layer.kind);
    const why = `Hidden while arranging ${LAYOUTS[layoutMode()].name.toLowerCase()}`;
    row.innerHTML = `<input type="checkbox" ${state.filters[layer.kind] ? "checked" : ""} ${covered ? "disabled" : ""} />
      <i class="line-sample ${layer.line}" style="--c: var(${layer.color})"></i>
      <span>${escapeHtml(layer.name)}${covered ? `<small>${why}</small>` : ""}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      state.filters[layer.kind] = e.target.checked;
      savePrefs();
      renderMap({ fit: false });
    });
    list.appendChild(row);
  }
  syncLayoutUi();
}

// Membership lines tie every device to its subnet or VLAN, so they're not drawn when they'd
// only clutter: subnets as boxes while grouping, and both left out of the connection
// arrangement, which is about who talks to whom (membership stays in each device's Details).
function membershipHidden(kind) {
  if (kind === "subnet") return true; // subnets are boxes (by subnet) or in Details (everywhere else)
  if (kind === "vlan") return layoutMode() !== "subnet";
  return false;
}

function setAllLayers(on) {
  for (const l of LAYERS) state.filters[l.kind] = on;
  savePrefs();
  renderLayerList();
  renderMap({ fit: false });
}

// The Layers controls (arrangement, link filters, device key) live in a panel the toolbar's Layers
// button opens over the map, instead of a sidebar tab.
function layersPanelOpen() {
  return !el("layers-panel").classList.contains("hidden");
}

function openLayersPanel() {
  el("layers-panel").classList.remove("hidden");
  el("btn-layers").setAttribute("aria-expanded", "true");
  el("btn-layers").classList.add("active");
}

function closeLayersPanel() {
  el("layers-panel").classList.add("hidden");
  el("btn-layers").setAttribute("aria-expanded", "false");
  el("btn-layers").classList.remove("active");
}

function toggleLayersPanel() {
  layersPanelOpen() ? closeLayersPanel() : openLayersPanel();
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

// Every match, best first: the name, then a caption, SSID, address, maker, and notes.
// Each hit says which field matched, so "netgear" shows the SSID or the maker it found.
const SEARCH_FIELDS = [
  ["name", (raw) => [displayName(raw)]],
  ["caption", (raw) => [getDeviceMeta(raw.id).extra]], // yours; an SSID shown as a caption counts as SSID
  ["SSID", (raw, n) => n.ssids || []],
  ["IP", (raw, n) => n.ips || []],
  ["MAC", (raw, n) => n.macs || []],
  ["maker", (raw, n) => [n.vendor]],
  ["type", (raw, n) => [n.inferred_type]],
  ["probed", (raw, n) => n.extra?.probed_ssids || []],
  ["notes", (raw, n) => [n.notes]],
];

function searchNodes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const raw of state.graph?.nodes || []) {
    const n = overlayNode(raw);
    for (const [rank, [field, values]] of SEARCH_FIELDS.entries()) {
      const value = values(raw, n).find((v) => v != null && String(v).toLowerCase().includes(q));
      if (value == null) continue;
      const starts = String(value).toLowerCase().startsWith(q) ? 0 : 0.5;
      out.push({ raw, n, field, value: String(value), score: rank + starts });
      break;
    }
  }
  return out.sort((x, y) => x.score - y.score || displayName(x.raw).localeCompare(displayName(y.raw), undefined, { numeric: true }));
}

const SEARCH_SHOW = 200;

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
  } else {
    const head = document.createElement("li");
    head.className = "search-head";
    head.innerHTML = `<span>${plural(hits.length, "device")} match</span>${hits.length > 1 ? '<button type="button" class="link-btn">Select all on the map</button>' : ""}`;
    head.querySelector("button")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el("search").blur();
      el("search-results").classList.add("hidden");
      selectNodes(hits.map((h) => h.raw.id));
      fitMap();
      toast(`Selected ${plural(hits.length, "device")} matching “${el("search").value.trim()}”.`, { timeout: 3500 });
    });
    results.appendChild(head);
  }
  hits.slice(0, SEARCH_SHOW).forEach((hit, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (i === 0) li.classList.add("active");
    const where = hit.field === "name" ? [hit.n.ips?.[0], hit.n.macs?.[0], hit.n.ssids?.[0]].filter(Boolean).join(" · ") : `${hit.field}: ${hit.value}`;
    const outside = currentWindow() && hasSeen(hit.raw) && !seenIn(hit.raw, currentWindow());
    li.innerHTML = `<span>${escapeHtml(displayName(hit.raw))}</span><small>${escapeHtml(where || hit.n.inferred_type || "")}${outside ? " · outside the time window" : ""}</small>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSearchResult(hit.raw.id);
    });
    results.appendChild(li);
  });
  if (hits.length > SEARCH_SHOW) {
    const more = document.createElement("li");
    more.className = "menu-label";
    more.textContent = `${hits.length - SEARCH_SHOW} more. Type more to narrow it down, or use Select all.`;
    results.appendChild(more);
  }
  results.classList.remove("hidden");
  renderSearch.hits = hits.slice(0, SEARCH_SHOW);
}

function pickSearchResult(id) {
  const raw = nodeById(id);
  if (currentWindow() && raw && hasSeen(raw) && !seenIn(raw, currentWindow())) {
    resetTimeWindow(); // it isn't on the map in this window: show the whole capture
    toast(`${displayName(raw)} wasn't heard in the time window, so the timeline now shows the whole capture.`, { timeout: 5000 });
  }
  el("search").value = "";
  el("search-results").classList.add("hidden");
  el("search").blur();
  selectNodes([id], { center: true });
}

/* ---------- Narrow screens ---------- */

function closeNarrowPanels() {
  el("sidebar").classList.remove("open");
}

/* ---------- Settings ---------- */

const UPDATES_KEY = "netseer.updates.v1";
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_NAMES = { windows: "Windows", linux: "Linux", macos: "macOS" };

const repoUrl = (path = "") => `https://github.com/${state.server.repo}${path}`;

function runningAs() {
  const { mode, platform, package: pkg } = state.server;
  if (mode === "hosted") return `Online copy (${location.host})`;
  const os = PLATFORM_NAMES[platform] || platform || "this computer";
  if (mode === "desktop") {
    if (pkg === "installer") return `Desktop app for ${os}, installed`;
    if (pkg === "portable") return `Desktop app for ${os}, portable`;
    if (pkg === "appimage") return `Desktop app for ${os}, AppImage`;
    return `Desktop app for ${os}, run from source`;
  }
  return `Local server on ${os} (the netseer command)`;
}

function openSettings(pane = "general") {
  closeMenu();
  renderSettings();
  showSettingsPane(pane);
  const dialog = el("settings-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(`.settings-nav [data-pane="${pane}"]`)?.focus();
}

function showSettingsPane(name) {
  document.querySelectorAll(".settings-nav [data-pane]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pane === name)));
  document.querySelectorAll(".settings-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
  if (name === "data") refreshDataSummary();
  if (name === "updates") renderUpdates();
  if (name === "help") renderDemo(); // the sample captures now live inside Help
  if (name === "security") renderSecurityPane();
  if (name === "integrations") renderIntegrations();
}

function renderSettings() {
  renderThemeGrid();
  document.querySelectorAll('input[name="zoom-speed"]').forEach((r) => (r.checked = r.value === state.prefs.zoomSpeed));
  el("settings-hover").checked = state.prefs.hoverFade;
  el("settings-ssid").checked = state.prefs.apSsid;
  fillTimeSettings();
  el("updates-auto").checked = state.prefs.autoUpdate;
  // Companion-app integration is a desktop/source feature; the public copy doesn't offer it.
  show("nav-integrations", state.server.mode !== "hosted");
  const version = state.server.version || "unknown";
  document.querySelectorAll(".app-version").forEach((n) => (n.textContent = version));
  el("about-mode").textContent = runningAs();
  el("updates-build").textContent = runningAs();
  const links = {
    repo: repoUrl(),
    guide: repoUrl("/blob/main/docs/user-guide.md"),
    issue: repoUrl(`/issues/new?body=${encodeURIComponent(`\n\n---\nNetSeer ${version}, ${runningAs()}`)}`),
    releases: repoUrl("/releases"),
  };
  document.querySelectorAll("#settings-dialog [data-link], #eupdate-dialog [data-link]").forEach((a) => (a.href = links[a.dataset.link]));
}

function renderThemeGrid() {
  const grid = el("settings-themes");
  const active = currentTheme();
  grid.innerHTML = "";
  for (const t of themeList()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(t.id === active));
    btn.setAttribute("aria-pressed", String(t.id === active));
    btn.innerHTML = `<span class="theme-swatch">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
      <span class="theme-name">${escapeHtml(t.name)}<small>${escapeHtml(t.note)}</small></span>`;
    btn.addEventListener("click", () => {
      applyTheme(t.id);
      renderThemeGrid();
    });
    grid.appendChild(btn);
  }
}

/* ---------- Settings: your data ---------- */

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMetres(m) {
  const v = Number(m) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} km` : `${Math.max(1, Math.round(v))} m`;
}

async function refreshDataSummary() {
  const maps = state.maps.filter((m) => m.kind !== "unwanted");
  const devices = maps.reduce((n, m) => n + mapNodeCount(m), 0);
  const unwanted = mapNodeCount(getMap(UNWANTED_ID));
  let text = `${plural(maps.length, "map")} with ${plural(devices, "device")}`;
  if (unwanted) text += `, plus ${unwanted} in Unwanted`;
  text += ".";
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) text += ` About ${formatSize(est.usage)} of browser storage in use.`;
  } catch {
    /* the estimate is optional */
  }
  if (!store.available) text += " This browser isn't letting NetSeer save, so these will be lost when you close it.";
  el("data-summary").textContent = text;
  renderPersistStatus();
}

function netseerLocalKeys() {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith("netseer."));
  } catch {
    return [];
  }
}

async function backupAll() {
  await flushSave();
  const local = {};
  for (const k of netseerLocalKeys()) if (k !== UPDATES_KEY) local[k] = localStorage.getItem(k);
  const maps = state.maps.map(serializeMap);
  const now = new Date();
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  downloadJson(`NetSeer-backup-${day}.json`, {
    netseer: "backup",
    format: 1,
    version: state.server.version,
    created: new Date().toISOString(),
    maps,
    deviceMeta: metaCache,
    session: { activeMapId: state.activeMapId, order: maps.map((m) => m.id) },
    local,
  });
  toast(`Backed up ${plural(maps.filter((m) => m.kind !== "unwanted").length, "map")}.`);
}

async function restoreBackup(file) {
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    /* handled below */
  }
  if (data?.netseer !== "backup" || !Array.isArray(data.maps)) {
    toast(`${file.name} isn't a NetSeer backup. Make one with Back up all maps.`, { error: true });
    return;
  }
  const maps = data.maps.filter((m) => isPlainObject(m) && typeof m.id === "string").map(normalizeMap);
  const count = maps.filter((m) => m.kind !== "unwanted").length;
  const when = Date.parse(data.created) ? new Date(data.created).toLocaleString() : "an unknown date";
  const ok = await openDialog({
    title: "Restore this backup?",
    body: `It has ${plural(count, "map")}, saved ${when}. Restoring replaces everything saved here now, so anything made since then is lost unless you back it up first.`,
    okLabel: "Replace and restore",
    danger: true,
  });
  if (!ok) return;
  await replaceAllData({
    maps,
    deviceMeta: isPlainObject(data.deviceMeta) ? data.deviceMeta : {},
    session: { activeMapId: data.session?.activeMapId || null, clipboard: null, order: Array.isArray(data.session?.order) ? data.session.order : maps.map((m) => m.id) },
    local: isPlainObject(data.local) ? data.local : {},
  });
}

async function clearAllData() {
  const ok = await openDialog({
    title: "Clear all data?",
    body: "This removes every map, name, note, and preference saved in this browser, then starts NetSeer fresh. It can't be undone, so back up first if you might want them again.",
    okLabel: "Clear everything",
    danger: true,
  });
  if (ok) await replaceAllData({});
}

// Rewrites storage in one go, then reloads so every part of the page starts from it.
async function replaceAllData({ maps = [], deviceMeta = {}, session = null, local = {} }) {
  clearTimeout(store.timer);
  const wasAvailable = store.available;
  store.available = false; // stop the page saving its old state over the new one on the way out
  try {
    await idbTx(["maps", "kv"], "readwrite", (tx) => {
      const mapStore = tx.objectStore("maps");
      const kv = tx.objectStore("kv");
      mapStore.clear();
      kv.clear();
      for (const m of maps) mapStore.put(serializeMap(m));
      if (maps.length) {
        kv.put(deviceMeta, "deviceMeta");
        kv.put(session, "session");
      }
    });
  } catch (err) {
    store.available = wasAvailable;
    fail(err);
    return;
  }
  try {
    for (const k of netseerLocalKeys()) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(local)) if (k.startsWith("netseer.") && typeof v === "string") localStorage.setItem(k, v);
  } catch {
    /* preferences are a convenience */
  }
  location.reload();
}

/* ---------- Settings: keeping storage ---------- */
// Browsers may clear a site's storage when the disk is nearly full, unless the site's
// storage is marked persistent. Chromium grants or refuses without asking; Firefox asks.

async function storagePersisted() {
  try {
    return navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  } catch {
    return null;
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    if (requestPersistentStorage.asked) return false; // once per visit is enough
    requestPersistentStorage.asked = true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function renderPersistStatus() {
  const persisted = await storagePersisted();
  const text = el("data-persist");
  show("data-persist-btn", persisted === false);
  if (persisted === null) text.textContent = "This browser can't protect saved maps from automatic cleanup, so back them up regularly.";
  else if (persisted) text.textContent = "Protected: this browser won't delete your maps to free up disk space.";
  else text.textContent = "Not protected yet: this browser may delete your maps if the disk gets nearly full.";
}

async function protectStorage() {
  requestPersistentStorage.asked = false;
  const granted = await requestPersistentStorage();
  await renderPersistStatus();
  if (granted) toast("Your maps are protected from automatic cleanup.");
  else toast("The browser didn't allow it. Chrome and Edge decide for themselves, usually once you bookmark NetSeer or use it often. Back up regularly in the meantime.", { timeout: 9000 });
}

/* ---------- Settings: updates ---------- */
// The only request NetSeer makes to the internet, and only when asked: the public list
// of releases from GitHub.

function parseVersion(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function readUpdateCache() {
  const cache = readLocal(UPDATES_KEY, null);
  return isPlainObject(cache) && Array.isArray(cache.releases) ? cache : null;
}

const newerRelease = (cache) => {
  const latest = cache?.releases?.[0];
  return latest && state.server.version && compareVersions(latest.tag, state.server.version) > 0 ? latest : null;
};

async function fetchReleases() {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${state.server.repo}/releases?per_page=30`, { cache: "no-store" });
  } catch {
    throw new Error("Couldn't reach GitHub. Check your internet connection and try again.");
  }
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting requests from this network right now. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}). Try again later.`);
  const list = await res.json();
  const releases = (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      date: r.published_at,
      url: r.html_url,
      body: String(r.body || "").slice(0, 20000),
      assets: (r.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    }))
    .sort((a, b) => compareVersions(b.tag, a.tag));
  const cache = { ...(readUpdateCache() || {}), checkedAt: Date.now(), releases };
  writeLocal(UPDATES_KEY, cache);
  return cache;
}

function showUpdateBadges(cache) {
  const newer = Boolean(newerRelease(cache));
  show("update-dot", newer);
  show("updates-badge", newer);
  el("btn-settings").title = newer ? "Settings: an update is available" : "Settings, help, and updates";
}

function setUpdateStatus(text, kind = "") {
  const status = el("updates-status");
  status.textContent = text;
  status.className = `update-status ${kind}`;
}

// The download that matches how this copy was installed.
function assetFor(release) {
  const { platform, package: pkg } = state.server;
  const pick = (re) => release.assets.find((a) => re.test(a.name)) || null;
  if (pkg === "installer") return pick(/setup.*\.exe$/i);
  if (pkg === "appimage") return pick(/\.appimage$/i);
  if (pkg === "portable" && platform === "windows") return pick(/windows.*\.zip$/i);
  if (pkg === "portable" && platform === "linux") return pick(/linux.*\.tar\.gz$/i);
  return null;
}

const installCommand = (tag) => `uv tool install --force "git+https://github.com/${state.server.repo}.git@${tag}"`;

function updateHowText() {
  const { platform, package: pkg } = state.server;
  if (pkg === "installer") return "To switch versions, download that version's installer and run it. It replaces the version you have now.";
  if (pkg === "appimage") return "To switch versions, download that version's AppImage, make it executable, and run it instead of this one. Keep the old file if you might want to go back.";
  if (pkg === "portable") {
    const app = platform === "windows" ? "NetSeer.exe" : "NetSeer";
    return `To switch versions, download that version, unpack it to a new folder, and run ${app} from there. Keep the old folder if you might want to go back.`;
  }
  return "This copy was installed from source. To switch versions, copy that version's install command, run it in a terminal, then restart NetSeer.";
}

function renderUpdates() {
  const hosted = state.server.mode === "hosted";
  // The Electron app updates itself (electron-updater); the browser and CLI only link to releases.
  const electron = window.netseerShell?.kind === "electron";
  show("updates-electron", electron && !hosted);
  show("updates-local", !hosted && !electron);
  show("updates-hosted", hosted);
  show("updates-check", !hosted && !electron);
  if (hosted) {
    setUpdateStatus("This online copy is always the newest version.", "good");
    return;
  }
  if (electron) {
    setUpdateStatus("NetSeer updates itself automatically.", "good");
    window.netseerShell.getAutoUpdate?.()
      .then((on) => {
        el("updates-electron-auto").checked = !!on;
        setUpdateStatus(on ? "NetSeer updates itself automatically." : "Automatic updates are off — check when you want one.", on ? "good" : "");
      })
      .catch(() => {});
    const cache = readUpdateCache();
    if (cache) renderElectronVersions(cache.releases);
    return;
  }
  el("updates-how").textContent = updateHowText();
  const cache = readUpdateCache();
  if (!cache) {
    setUpdateStatus("");
    return;
  }
  const newer = newerRelease(cache);
  const checked = new Date(cache.checkedAt).toLocaleString();
  if (newer) setUpdateStatus(`${newer.name} is available. You have ${state.server.version}. (Checked ${checked}.)`, "new");
  else if (cache.releases.length) setUpdateStatus(`You have the newest version. (Checked ${checked}.)`, "good");
  else setUpdateStatus(`No releases found on GitHub. (Checked ${checked}.)`);
  renderReleaseList(cache.releases);
}

// The current version and anything newer get a card each. Older versions, wanted only to roll
// back, wait in a folded "Earlier versions" list with one picker.
const releaseUi = { olderOpen: false, picked: null };

function releaseDate(r) {
  return Date.parse(r.date) ? new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

function releaseActions(r) {
  const cmp = compareVersions(r.tag, state.server.version);
  const asset = assetFor(r);
  const verb = cmp > 0 ? "Update" : cmp < 0 ? "Roll back" : "Reinstall";
  let actions = `<a class="btn small ghost" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Release notes</a>`;
  if (asset) actions += `<a class="btn small${cmp > 0 ? " primary" : ""}" href="${escapeHtml(asset.url)}" target="_blank" rel="noopener" title="${escapeHtml(asset.name)}, ${formatSize(asset.size)}">${verb}</a>`;
  else if (state.server.package === "source") actions += `<button class="btn small${cmp > 0 ? " primary" : ""}" type="button" data-copy="${escapeHtml(r.tag)}">Copy ${verb.toLowerCase()} command</button>`;
  return actions;
}

function releaseMeta(r) {
  const asset = assetFor(r);
  return `${escapeHtml(releaseDate(r))}${asset ? ` · ${escapeHtml(asset.name)}` : ""}`;
}

function renderReleaseList(releases, { listId = "release-list", actions = releaseActions } = {}) {
  const list = el(listId);
  list.innerHTML = "";
  const all = releases.slice(0, 40);
  const older = all.filter((r) => compareVersions(r.tag, state.server.version) < 0);
  for (const r of all.filter((x) => !older.includes(x))) {
    const cmp = compareVersions(r.tag, state.server.version);
    const li = document.createElement("li");
    li.classList.toggle("current", cmp === 0);
    const tag = cmp === 0 ? '<span class="release-tag">Current</span>' : '<span class="release-tag newer">Newer</span>';
    li.innerHTML = `<span><span class="release-name">${escapeHtml(r.name)}</span>${tag}<span class="release-meta">${releaseMeta(r)}</span></span>
      <span class="release-actions">${actions(r)}</span>`;
    list.appendChild(li);
  }
  if (older.length) {
    const li = document.createElement("li");
    li.className = "release-older";
    const picked = older.find((r) => r.tag === releaseUi.picked) || older[0];
    li.innerHTML = `<details${releaseUi.olderOpen ? " open" : ""}>
        <summary><span class="release-name">Earlier versions</span><span class="release-tag">${older.length}</span><span class="release-meta">Only needed to roll back</span></summary>
        <div class="release-pick">
          <select id="release-older" aria-label="Earlier version">${older
            .map((r) => `<option value="${escapeHtml(r.tag)}"${r === picked ? " selected" : ""}>${escapeHtml(r.name)}${releaseDate(r) ? ` · ${escapeHtml(releaseDate(r))}` : ""}</option>`)
            .join("")}</select>
          <span class="release-actions" id="release-older-actions">${actions(picked)}</span>
        </div>
        <p class="release-meta" id="release-older-meta">${releaseMeta(picked)}</p>
      </details>`;
    li.querySelector("details").addEventListener("toggle", (e) => (releaseUi.olderOpen = e.currentTarget.open));
    li.querySelector("select").addEventListener("change", (e) => {
      const r = older.find((x) => x.tag === e.target.value);
      releaseUi.picked = r.tag;
      el("release-older-actions").innerHTML = actions(r);
      el("release-older-meta").innerHTML = releaseMeta(r);
    });
    list.appendChild(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="hint">No releases yet.</li>';
}

// The Electron app installs any version itself (download + checksum + run), so the version list
// gets Update / Reinstall / Roll back buttons that the shell acts on.
function electronReleaseActions(r) {
  const cmp = compareVersions(r.tag, state.server.version);
  const verb = cmp > 0 ? "Update" : cmp < 0 ? "Roll back" : "Reinstall";
  let html = `<a class="btn small ghost" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Release notes</a>`;
  if (assetFor(r)) html += `<button class="btn small${cmp > 0 ? " primary" : ""}" type="button" data-install-version="${escapeHtml(r.tag)}">${verb}</button>`;
  return html;
}

function renderElectronVersions(releases) {
  if (el("electron-release-list")) renderReleaseList(releases, { listId: "electron-release-list", actions: electronReleaseActions });
}

// Start installing a chosen version (the shell downloads, checksum-verifies, and stages it; the
// update dialog then shows progress and the Restart button runs the installer).
function startVersionInstall(tag) {
  eupdateVersionInstall = true;
  window.netseerShell?.startVersionUpdate?.(tag);
  el("eupdate-title").textContent = "Downloading update";
  show("eupdate-install", false);
  showUpdateProgress({});
  const d = el("eupdate-dialog");
  if (!d.open) d.showModal();
}

async function checkForUpdates() {
  const btn = el("updates-check");
  btn.disabled = true;
  setUpdateStatus("Checking GitHub…");
  try {
    showUpdateBadges(await fetchReleases());
    renderUpdates();
  } catch (err) {
    setUpdateStatus(err.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

// Opt-in (Settings → Updates): at most one check a day, and one message per new release.
async function autoCheckUpdates() {
  if (state.server.mode === "hosted") return;
  let cache = readUpdateCache();
  showUpdateBadges(cache);
  if (!state.prefs.autoUpdate) return;
  if (!cache || Date.now() - (cache.checkedAt || 0) > UPDATE_CHECK_EVERY_MS) {
    try {
      cache = await fetchReleases();
    } catch {
      return; // offline or rate-limited: try again next time
    }
    showUpdateBadges(cache);
  }
  const newer = newerRelease(cache);
  if (!newer || cache.notified === newer.tag) return;
  writeLocal(UPDATES_KEY, { ...cache, notified: newer.tag });
  toast(`${newer.name} is available.`, { action: { label: "See what's new", onClick: () => openSettings("updates") }, timeout: 10000 });
}

function bindSettings() {
  const dialog = el("settings-dialog");
  el("settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // backdrop
  });
  dialog.querySelectorAll(".settings-nav [data-pane]").forEach((b) => b.addEventListener("click", () => showSettingsPane(b.dataset.pane)));
  el("intg-pair").addEventListener("click", startPairing);
  el("intg-lan").addEventListener("change", (e) => setLan(e.target.checked));
  dialog.addEventListener("close", clearPairingCode);
  dialog.querySelectorAll("[data-goto]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      showSettingsPane(a.dataset.goto);
    })
  );
  document.querySelectorAll('input[name="zoom-speed"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.prefs.zoomSpeed = r.value;
      savePrefs();
    })
  );
  el("settings-ssid").addEventListener("change", (e) => {
    state.prefs.apSsid = e.target.checked;
    savePrefs();
    state.cy?.nodes().forEach((n) => {
      const raw = state.nodeIndex.get(n.id());
      if (raw) n.data("label", nodeLabel(raw));
    });
    if (state.selection.length === 1) renderInspector();
  });
  el("settings-hover").addEventListener("change", (e) => {
    state.prefs.hoverFade = e.target.checked;
    savePrefs();
    state.cy?.elements(".faded").removeClass("faded");
  });
  el("data-backup").addEventListener("click", () => backupAll().catch(fail));
  el("data-restore").addEventListener("click", () => el("data-restore-file").click());
  el("data-restore-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) restoreBackup(file).catch(fail);
  });
  el("data-clear").addEventListener("click", () => clearAllData().catch(fail));
  el("data-persist-btn").addEventListener("click", () => protectStorage().catch(fail));
  el("updates-check").addEventListener("click", checkForUpdates);
  el("updates-auto").addEventListener("change", (e) => {
    state.prefs.autoUpdate = e.target.checked;
    savePrefs();
    if (e.target.checked) checkForUpdates();
  });
  el("release-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (btn) copyText(installCommand(btn.dataset.copy), "Install command copied. Run it in a terminal, then restart NetSeer.");
  });
  el("help-tour").addEventListener("click", startTour);
  el("help-shortcuts").addEventListener("click", () => el("help-dialog").showModal());

  el("tour-next").addEventListener("click", () => (tour.i >= TOUR_STEPS.length - 1 ? endTour() : showTourStep(tour.i + 1)));
  el("tour-back").addEventListener("click", () => showTourStep(tour.i - 1));
  el("tour-skip").addEventListener("click", endTour);
  window.addEventListener("resize", () => tour.active && placeTour());
}

const LAST_VERSION_KEY = "netseer.lastVersion";

// After an update (or going back), say so once.
function noteVersionChange() {
  const version = state.server.version;
  if (!version) return;
  let last = null;
  try {
    last = localStorage.getItem(LAST_VERSION_KEY);
    localStorage.setItem(LAST_VERSION_KEY, version);
  } catch {
    return;
  }
  if (!last || last === version) return;
  const verb = compareVersions(version, last) > 0 ? "Updated" : "Switched";
  toast(`${verb} to NetSeer ${version} (from ${last}).`, { action: { label: "What's new", onClick: () => openSettings("updates") }, timeout: 9000 });
  return true;
}

/* ---------- Sidebar: resize ---------- */

const SIDEBAR_MIN = 200;
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(560, Math.round(window.innerWidth * 0.45)));

function setSidebarWidth(px, { save = true } = {}) {
  const shell = document.querySelector(".shell");
  const handle = el("sidebar-resizer");
  if (px == null) {
    shell.style.removeProperty("--sidebar-w");
    state.prefs.sidebarWidth = null;
  } else {
    const w = Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), px)));
    shell.style.setProperty("--sidebar-w", `${w}px`);
    state.prefs.sidebarWidth = w;
  }
  const now = Math.round(el("sidebar").getBoundingClientRect().width) || state.prefs.sidebarWidth || 272;
  handle.setAttribute("aria-valuenow", String(now));
  handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
  handle.setAttribute("aria-valuemax", String(sidebarMax()));
  if (save) savePrefs();
}

function bindSidebarResize() {
  const handle = el("sidebar-resizer");
  const shell = document.querySelector(".shell");
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setSidebarWidth(e.clientX - shell.getBoundingClientRect().left, { save: false });
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing");
    savePrefs();
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => setSidebarWidth(null));
  handle.addEventListener("keydown", (e) => {
    const current = el("sidebar").getBoundingClientRect().width;
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") setSidebarWidth(current - step);
    else if (e.key === "ArrowRight") setSidebarWidth(current + step);
    else if (e.key === "Home") setSidebarWidth(SIDEBAR_MIN);
    else if (e.key === "End") setSidebarWidth(sidebarMax());
    else if (e.key === "Enter") setSidebarWidth(null);
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => {
    if (state.prefs.sidebarWidth) setSidebarWidth(state.prefs.sidebarWidth, { save: false });
  });
}

/* ---------- Sidebar: drag rows ---------- */
// Pointer-based rather than HTML drag and drop, which won't drag buttons in Firefox.
// Drag a map or survey up or down to reorder it, or onto a map to merge into that map.
// Hovering over the Maps tab while dragging a survey switches to it.

const SURVEY_ORDER_KEY = "netseer.surveyOrder";
const drag = { start: null, active: false, ghost: null, row: null, target: null, zone: null, tabTimer: null, tab: null, scroll: 0, raf: 0, suppressClick: false };

function sortSurveys(list) {
  const order = readLocal(SURVEY_ORDER_KEY, []);
  if (!Array.isArray(order) || !order.length) return list;
  const rank = (s) => {
    const i = order.indexOf(s.id);
    return i < 0 ? -1 : i; // new captures stay on top
  };
  return list.map((s, i) => [s, i]).sort(([a, ia], [b, ib]) => rank(a) - rank(b) || ia - ib).map(([s]) => s);
}

function dropZone(type, id, row, y) {
  const targetType = row.dataset.dropType;
  const targetId = row.dataset.id;
  if (!targetType || targetId === id) return null;
  const r = row.getBoundingClientRect();
  const f = (y - r.top) / Math.max(1, r.height);
  if (targetType === "map") {
    const target = getMap(targetId);
    if (!target || target.kind === "unwanted") return null;
    if (type === "survey") return targetId === `map:${id}` ? null : "into";
    if (type === "map") return f < 0.28 ? "before" : f > 0.72 ? "after" : "into";
  }
  if (targetType === "survey" && type === "survey") return f < 0.5 ? "before" : "after";
  return null;
}

function clearDropMarks() {
  document.querySelectorAll(".drop-before, .drop-after, .drop-into, .drop-hover").forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-into", "drop-hover"));
}

function ghostHint() {
  if (!drag.target) return "";
  if (drag.zone === "into") return `Merge into ${getMap(drag.target.dataset.id)?.name || "this map"}`;
  return "Move here";
}

function startListDrag() {
  const { row, type, id } = drag.start;
  drag.active = true;
  drag.row = row;
  row.classList.add("dragging");
  document.body.classList.add("list-dragging");
  closeMenu();
  const name = type === "map" ? getMap(id)?.name : state.surveys.find((s) => s.id === id)?.name;
  drag.ghost = document.createElement("div");
  drag.ghost.className = "drag-ghost";
  drag.ghost.innerHTML = `${escapeHtml(name || "")}<small></small>`;
  document.body.appendChild(drag.ghost);
}

function onListDragMove(e) {
  if (!drag.start || e.pointerId !== drag.start.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < 6) return;
    startListDrag();
  }
  e.preventDefault();
  drag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
  clearDropMarks();
  drag.target = null;
  drag.zone = null;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const row = under?.closest?.("#sidebar .list-row[data-drop-type]");
  const zone = row ? dropZone(drag.start.type, drag.start.id, row, e.clientY) : null;
  if (zone) {
    drag.target = row;
    drag.zone = zone;
    row.classList.add(`drop-${zone}`);
  }
  drag.ghost.querySelector("small").textContent = ghostHint();
  // Near the top or bottom of the sidebar: scroll it.
  const box = el("sidebar").getBoundingClientRect();
  const edge = 44;
  drag.scroll = e.clientY < box.top + edge + 40 ? -1 : e.clientY > box.bottom - edge ? 1 : 0;
  if (drag.scroll && !drag.raf) drag.raf = requestAnimationFrame(autoScrollSidebar);
}

function autoScrollSidebar() {
  drag.raf = 0;
  if (!drag.active || !drag.scroll) return;
  el("sidebar").scrollTop += drag.scroll * 10;
  drag.raf = requestAnimationFrame(autoScrollSidebar);
}

function endListDrag(e, { cancel = false } = {}) {
  if (!drag.start) return;
  const wasActive = drag.active;
  const { type, id } = drag.start;
  const target = drag.target;
  const zone = drag.zone;
  clearTimeout(drag.tabTimer);
  cancelAnimationFrame(drag.raf);
  drag.ghost?.remove();
  drag.row?.classList.remove("dragging");
  document.body.classList.remove("list-dragging");
  clearDropMarks();
  Object.assign(drag, { start: null, active: false, ghost: null, row: null, target: null, zone: null, tab: null, scroll: 0, raf: 0 });
  if (!wasActive) return;
  // The click that ends a drag shouldn't also open the row.
  drag.suppressClick = true;
  setTimeout(() => (drag.suppressClick = false), 0);
  if (cancel || !target || !zone) return;
  const targetId = target.dataset.id;
  if (zone === "into") {
    if (type === "map") mergeMaps(id, targetId);
    else mergeSurveyInto(id, targetId);
  } else if (type === "map") moveMapInList(id, targetId, zone === "after");
  else moveSurveyInList(id, targetId, zone === "after");
}

function moveMapInList(id, targetId, after) {
  const moving = getMap(id);
  if (!moving || id === targetId) return;
  const rest = state.maps.filter((m) => m.id !== id);
  const at = rest.findIndex((m) => m.id === targetId);
  if (at < 0) return;
  rest.splice(at + (after ? 1 : 0), 0, moving);
  state.maps = rest;
  markSessionDirty();
  renderMapList();
}

function moveSurveyInList(id, targetId, after) {
  const moving = state.surveys.find((s) => s.id === id);
  if (!moving || id === targetId) return;
  const rest = state.surveys.filter((s) => s.id !== id);
  const at = rest.findIndex((s) => s.id === targetId);
  if (at < 0) return;
  rest.splice(at + (after ? 1 : 0), 0, moving);
  state.surveys = rest;
  writeLocal(SURVEY_ORDER_KEY, rest.map((s) => s.id));
  renderSurveyList();
}

function bindListDrag() {
  const sidebar = el("sidebar");
  sidebar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const row = e.target.closest(".list-row[data-drag-type]");
    if (!row || e.target.closest(".row-menu-btn")) return;
    drag.start = { x: e.clientX, y: e.clientY, row, type: row.dataset.dragType, id: row.dataset.id, pointerId: e.pointerId };
  });
  window.addEventListener("pointermove", onListDragMove);
  window.addEventListener("pointerup", (e) => endListDrag(e));
  window.addEventListener("pointercancel", (e) => endListDrag(e, { cancel: true }));
  window.addEventListener("blur", () => endListDrag(null, { cancel: true }));
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && drag.active) {
        e.stopPropagation();
        endListDrag(null, { cancel: true });
      }
    },
    true
  );
  sidebar.addEventListener(
    "click",
    (e) => {
      if (!drag.suppressClick) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

/* ---------- Walkthrough tour ---------- */

const TOUR_STEPS = [
  {
    title: "Welcome to NetSeer",
    text: "NetSeer turns packet captures and Wi-Fi surveys into a map of the network. This takes about a minute. Use the buttons, or the arrow keys.",
  },
  { target: "#dropzone", title: "Open a survey", text: "Drop .pcap, .pcapng, .cap, .kismet, .netxml, or .csv files here or anywhere on the window — or click to browse. Each capture opens as a map, and big ones (long wardrives) show their progress as they read." },
  {
    target: "#sidebar",
    title: "Your maps",
    text: "Every capture you open becomes a map here, keeping the capture's name. Right-click a map to rename, merge, or delete it; drag rows to reorder, or drop one onto another to merge. Compare surveys maps what changed since a baseline. Drag the sidebar's edge to make it wider.",
  },
  { target: "#btn-layers", title: "Layers", text: "Open Layers to arrange the map (by network name, subnet, connection, location, channel, and more), choose which kinds of links are drawn, shade devices by security, and see the device key." },
  { target: "#map", title: "The map", text: "Drag devices to rearrange them and scroll to zoom. Access points show their Wi-Fi network (SSID) under their name. Click a device to highlight it and its links." },
  {
    target: "#timeline",
    title: "Timeline",
    text: "When a capture records times, drag the handles to see only the devices heard in that window, or make a new map of just that time. Times use the time zone in Settings.",
  },
  { target: ".search", title: "Find a device", text: "Search by name, IP, MAC, SSID, maker, or notes. Press / to jump here from anywhere. The arrows beside it undo and redo changes to your maps." },
  {
    target: "#inspector",
    title: "Details",
    text: "Select a device to see everything NetSeer found: addresses, radio, services, routing, and a Security check with any known vulnerabilities. Rename it, add notes, or connect or disconnect it from another device using something you know (a port label, a diagram).",
    before: selectTourDevice,
  },
  { target: "#btn-export", title: "Export", text: "Save the map as a draw.io or Visio diagram, or create a PDF report with just the parts you need." },
  { target: "#btn-settings", title: "Settings and help", text: "Pick a theme, back up your maps, check for updates, go back to an older version, and replay this tour from here." },
];

const tour = { active: false, i: 0, pickedId: null };

function startTour() {
  el("settings-dialog").close();
  closeMenu();
  hideToast();
  if (!state.prefs.tourOffered) {
    state.prefs.tourOffered = true;
    savePrefs();
  }
  tour.active = true;
  tour.pickedId = null;
  show("tour", true);
  showTourStep(0);
}

function endTour() {
  tour.active = false;
  show("tour", false);
  if (tour.pickedId && state.selection.length === 1 && state.selection[0] === tour.pickedId) selectNodes([]);
  tour.pickedId = null;
  el("btn-settings").focus({ preventScroll: true });
}

// Shows the details panel filled in, using the first device on the map.
function selectTourDevice() {
  if (state.selection.length || !state.cy) return;
  const node = state.cy.nodes().filter((n) => !n.isParent() && n.data("kind") !== "subnet" && n.data("kind") !== "vlan")[0];
  if (!node) return;
  tour.pickedId = node.id();
  selectNodes([tour.pickedId]);
}

function showTourStep(i) {
  tour.i = Math.max(0, Math.min(TOUR_STEPS.length - 1, i));
  const step = TOUR_STEPS[tour.i];
  step.before?.();
  el("tour-step").textContent = `${tour.i + 1} of ${TOUR_STEPS.length}`;
  el("tour-title").textContent = step.title;
  el("tour-text").textContent = step.text;
  el("tour-back").disabled = tour.i === 0;
  el("tour-next").textContent = tour.i === TOUR_STEPS.length - 1 ? "Done" : "Next";
  placeTour();
  el("tour-next").focus({ preventScroll: true });
}

function placeTour() {
  const step = TOUR_STEPS[tour.i];
  const spot = el("tour-spot");
  const card = el("tour-card");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = 12;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const r = step.target ? document.querySelector(step.target)?.getBoundingClientRect() : null;
  const visible = r && r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
  let left = (vw - cw) / 2;
  let top = (vh - ch) / 2;
  spot.classList.toggle("none", !visible);
  if (visible) {
    const box = { left: Math.max(4, r.left - 6), top: Math.max(4, r.top - 6), right: Math.min(vw - 4, r.right + 6), bottom: Math.min(vh - 4, r.bottom + 6) };
    Object.assign(spot.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
    const midX = (box.left + box.right) / 2 - cw / 2;
    const midY = (box.top + box.bottom) / 2 - ch / 2;
    const gap = 12;
    if (box.bottom + gap + ch <= vh - m) [left, top] = [midX, box.bottom + gap];
    else if (box.top - gap - ch >= m) [left, top] = [midX, box.top - gap - ch];
    else if (box.right + gap + cw <= vw - m) [left, top] = [box.right + gap, midY];
    else if (box.left - gap - cw >= m) [left, top] = [box.left - gap - cw, midY];
    else [left, top] = [midX, box.bottom - ch - 24]; // a big target: sit inside it, near the bottom
  }
  card.style.left = `${Math.max(m, Math.min(left, vw - cw - m))}px`;
  card.style.top = `${Math.max(m, Math.min(top, vh - ch - m))}px`;
}

function onTourKey(e) {
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight") el("tour-next").click();
  else if (e.key === "ArrowLeft" && tour.i > 0) showTourStep(tour.i - 1);
  else return;
  e.preventDefault();
}

// First visit only: offer the tour once, without starting it unasked.
function offerTour() {
  if (state.prefs.tourOffered) return;
  state.prefs.tourOffered = true;
  savePrefs();
  toast("New to NetSeer? Take a one-minute tour of the screen.", { action: { label: "Take the tour", onClick: startTour }, timeout: 12000 });
}

/* ---------- Wiring ---------- */

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
}

function bindUi() {
  el("btn-open").addEventListener("click", () => el("file").click());
  el("empty-open").addEventListener("click", () => el("file").click());
  el("empty-sample").addEventListener("click", () => openSettings("help"));
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
      { label: "Report…", hint: "PDF", onSelect: openReportDialog },
    ])
  );
  el("btn-settings").addEventListener("click", () => openSettings());
  el("map-title").addEventListener("click", () => state.activeMapId && renameMap(state.activeMapId));
  el("btn-sidebar").addEventListener("click", () => el("sidebar").classList.toggle("open"));
  el("btn-new-map").addEventListener("click", createBlankMap);
  el("btn-show-all").addEventListener("click", () => setAllLayers(true));
  el("btn-show-none").addEventListener("click", () => setAllLayers(false));
  el("layout-select").addEventListener("change", (e) => setLayoutMode(e.target.value));
  el("btn-layers").addEventListener("click", toggleLayersPanel);
  el("layers-close").addEventListener("click", closeLayersPanel);
  // Dismiss the layers panel on Escape or a click outside it (but not on its own button).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layersPanelOpen()) closeLayersPanel();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!layersPanelOpen()) return;
    if (el("layers-panel").contains(e.target) || el("btn-layers").contains(e.target)) return;
    closeLayersPanel();
  });

  el("btn-undo").addEventListener("click", undoLast);
  el("btn-redo").addEventListener("click", redoLast);
  el("toast-undo").addEventListener("click", () => {
    hideToast();
    undoLast();
  });
  el("toast-action").addEventListener("click", () => {
    hideToast();
    const run = toast.action;
    toast.action = null;
    run?.();
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
  // Cytoscape misses "mouseout" when the pointer leaves the canvas quickly, which left
  // the hover highlight stuck with everything else faded.
  el("map").addEventListener("mouseleave", () => state.cy?.elements(".faded").removeClass("faded"));

  document.addEventListener("keydown", (e) => {
    if (tour.active) {
      onTourKey(e);
      return;
    }
    if (e.key === "Escape") {
      if (cancelConnect()) return;
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
    if (isTypingTarget(e.target) || document.querySelector("dialog[open]")) return;
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
    } else if ((cmd && key === "y") || (cmd && e.shiftKey && key === "z")) {
      e.preventDefault();
      redoLast();
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

// Lets the desktop app's browser fallback know a NetSeer tab is still open.
function startHeartbeat() {
  const beat = () => fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
  beat();
  setInterval(beat, 20000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });
  window.addEventListener("pagehide", () => navigator.sendBeacon?.("/api/heartbeat?bye=true"));
}

/* ---------- Easter egg: the logo terminal ---------- */

// Not a real shell: a pretend PowerShell (Windows) or terminal (everything else) that knows a
// few NetSeer-only commands. Opened by clicking the logo five times in quick succession.
// Secret themes: listed in Themes only once someone has found them in the terminal.
const SECRET_THEMES = [
  { id: "matrix", name: "Matrix", note: "You found it", swatch: ["#000000", "#00ff41", "#7dffb0", "#c8ff00"], key: "netseer.matrix" },
  { id: "darkside", name: "Dark Side", note: "Order 66 executed", swatch: ["#05060a", "#ff2a2a", "#3fa9ff", "#ffd23f"], key: "netseer.darkside" },
  { id: "neon", name: "Neon", note: "Hack the planet", swatch: ["#12002b", "#ff2fd6", "#00f0ff", "#ffe14d"], key: "netseer.neon" },
];
const secretTheme = (id) => SECRET_THEMES.find((t) => t.id === id);
const secretUnlocked = (id) => readLocal(secretTheme(id).key, false) === true;
const ARDYN_ART = String.raw`   ███╗     ██████╗  ██████╗  ██╗   ██╗ ███╗   ██╗
  █████╗    ██╔══██╗ ██╔══██╗ ╚██╗ ██╔╝ ████╗  ██║
  ██╔██╗    ██████╔╝ ██║  ██║  ╚████╔╝  ██╔██╗ ██║
 ██╔╝╚██╗   ██╔══██╗ ██║  ██║   ╚██╔╝   ██║╚██╗██║
██╔╝  ╚██╗  ██║  ██║ ██████╔╝    ██║    ██║ ╚████║
╚═╝    ╚═╝  ╚═╝  ╚═╝ ╚═════╝     ╚═╝    ╚═╝  ╚═══╝

S       Y       S       T       E       M       S

         Tools for those who look closer.`;

const egg = { clicks: [], history: [], at: 0, before: null, backdrop: null, job: null };
const eggWindows = () => /windows/i.test(navigator.userAgent);

function onLogoClick() {
  const now = Date.now();
  egg.clicks = egg.clicks.filter((t) => now - t < 2500).concat(now);
  if (egg.clicks.length >= 5) {
    egg.clicks = [];
    openEggTerminal();
  }
}

function eggPrompt() {
  return eggWindows() ? "PS C:\\Users\\netseer> " : "netseer@netseer:~$ ";
}

function openEggTerminal() {
  const term = el("egg-term");
  const win = eggWindows();
  term.classList.toggle("ps", win);
  el("egg-title").textContent = win ? "Windows PowerShell" : "netseer@netseer: ~";
  el("egg-prompt").textContent = eggPrompt();
  if (term.hidden) {
    el("egg-out").textContent = "";
    eggPrint(
      win
        ? "Windows PowerShell\nCopyright (C) NetSeer. No rights reserved, some secrets kept.\n\nType 'help' to see what this shell knows.\n"
        : "NetSeer GNU/Terrain (tty1)\n\nType 'help' to see what this shell knows.\n"
    );
  }
  term.hidden = false;
  el("egg-input").focus();
}

function closeEggTerminal() {
  eggCancel({ quiet: true });
  el("egg-term").hidden = true;
}

function eggPrint(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  el("egg-out").appendChild(line);
  el("egg-body").scrollTop = el("egg-body").scrollHeight;
}

function runEggCommand(raw) {
  const cmd = raw.trim();
  eggPrint(eggPrompt() + raw);
  if (!cmd) return;
  egg.history.push(cmd);
  egg.at = egg.history.length;
  const name = cmd.toLowerCase();
  const [verb, ...rest] = cmd.split(/\s+/);
  const arg = rest.join(" ");
  const program = verb.toLowerCase();
  // Each shell runs a script its own way: .\name in PowerShell, ./name in bash.
  const script = (s) => name === (eggWindows() ? `.\\${s}` : `./${s}`);
  if (name === "whoami") eggPrint(ARDYN_ART, "egg-art");
  else if (name === "redpill") hackTheWorld();
  else if (program === "ping") eggPing(arg);
  else if (program === (eggWindows() ? "tracert" : "traceroute")) eggTraceroute(arg);
  else if (script("wardrive")) eggWardrive();
  else if (name === "hacktheplanet") hackThePlanet();
  else if (name === "jackout") forgetTheme("neon", { nothing: "You're not jacked in.", done: "Jacked out" });
  else if (name === "unplug") forgetTheme("matrix", { nothing: "Nothing to unplug from.", done: "Unplugged" });
  else if (script("order66")) executeOrder66();
  else if (name === "rescindorder66") forgetTheme("darkside", { nothing: "There's no order to rescind.", done: "Order rescinded" });
  else if (name === "help" || name === "get-help") eggPrint(eggHelp());
  else if (name === "clear" || name === "cls") el("egg-out").textContent = "";
  else if (name === "exit") closeEggTerminal();
  else {
    const word = cmd.split(/\s+/)[0];
    eggPrint(
      eggWindows()
        ? `${word} : The term '${word}' is not recognized as the name of a cmdlet, function, script file, or operable program.`
        : `${word.replace(/\\(.)/g, "$1")}: command not found`, // bash drops a backslash before a character
      "egg-error"
    );
  }
}

// Every command, spelled the way this shell spells it.
function eggHelp() {
  const win = eggWindows();
  const run = (s) => (win ? `.\\${s}` : `./${s}`);
  const trace = win ? "tracert" : "traceroute";
  const rows = [
    ["On the map", [
      [`ping [device]`, "ping a device: the selected one, or the gateway"],
      [`${trace} [device]`, "follow a route across the map to a device"],
      [run("wardrive"), "take a drive and log the networks you pass"],
    ]],
    ["Themes", [
      ["redpill", "see the network for what it really is"],
      ["unplug", "leave the Matrix and forget it was there"],
      ["hacktheplanet", "dial in to the neon side"],
      ["jackout", "log off and forget Neon"],
      [run("order66"), "carry out the order"],
      ["rescindorder66", "stand down and forget the Dark Side"],
    ]],
    ["Everything else", [
      ["whoami", "who made this"],
      [win ? "cls, clear" : "clear", "clear the screen"],
      ["exit", "close this window"],
      ["Ctrl+C", "stop a command that's running"],
    ]],
  ];
  const width = Math.max(...rows.flatMap(([, list]) => list.map(([cmd]) => cmd.length))) + 3;
  return rows.map(([title, list]) => `${title}\n${list.map(([cmd, what]) => `  ${cmd.padEnd(width)}${what}`).join("\n")}`).join("\n\n");
}

// Plays a few lines, then switches to a secret theme and lists it in Themes.
function enterSecretTheme(id, lines, okAt, already) {
  if (currentTheme() === id) {
    eggPrint(already);
    return;
  }
  // Remember the everyday theme to go back to, even when hopping between secret ones.
  if (THEMES.some((t) => t.id === currentTheme())) egg.before = currentTheme();
  eggStartJob(id);
  lines.forEach((text, i) =>
    eggLater(() => {
      eggPrint(text, i === okAt ? `egg-ok egg-ok-${id}` : "");
      if (i === okAt) {
        writeLocal(secretTheme(id).key, true);
        applyTheme(id);
      }
      if (i === lines.length - 1) eggEndJob();
    }, 450 * (i + 1))
  );
}

function hackTheWorld() {
  enterSecretTheme("matrix", ["Bypassing the mainframe...", "Rerouting packets through the green rain...", "Access granted.", "Follow the falling code. Type 'unplug' to leave."], 2, "You're already in. Type 'unplug' to leave.");
}

function hackThePlanet() {
  enterSecretTheme("neon", ["Dialing in at 28.8k...", "Bypassing the Gibson...", "Hack the planet!", "Type 'jackout' to log off."], 2, "You're already jacked in. Type 'jackout' to log off.");
}

function executeOrder66() {
  enterSecretTheme(
    "darkside",
    ["Transmitting to every unit on the network...", "Order acknowledged.", "Switching to the dark side.", "Type 'rescindorder66' to stand down."],
    2,
    "The order has already been carried out. Type 'rescindorder66' to stand down."
  );
}

// Leaving a secret theme takes it out of Themes too; its command brings it back.
function forgetTheme(id, { nothing, done }) {
  const theme = secretTheme(id);
  const inIt = currentTheme() === id;
  if (!inIt && !secretUnlocked(id)) {
    eggPrint(nothing);
    return;
  }
  try {
    localStorage.removeItem(theme.key);
  } catch {
    /* Nothing stored, nothing to forget. */
  }
  if (inIt) {
    const back = THEMES.some((t) => t.id === egg.before) ? egg.before : "terrain";
    applyTheme(back);
    eggPrint(`${done}. Back to ${THEMES.find((t) => t.id === back).name}, and ${theme.name} is gone from Themes.`);
  } else eggPrint(`${done}. ${theme.name} is gone from Themes.`);
}

function bindEggTerminal() {
  el("brand-logo").addEventListener("click", onLogoClick);
  el("egg-close").addEventListener("click", closeEggTerminal);
  el("egg-body").addEventListener("click", () => {
    if (!window.getSelection()?.toString()) el("egg-input").focus();
  });
  el("egg-input").addEventListener("keydown", (e) => {
    const input = e.currentTarget;
    if (e.key === "Enter") {
      if (egg.job) return; // busy, like a real shell
      runEggCommand(input.value);
      input.value = "";
    } else if (e.key.toLowerCase() === "c" && e.ctrlKey && !e.shiftKey && input.selectionStart === input.selectionEnd && !window.getSelection()?.toString()) {
      e.preventDefault();
      if (!eggCancel()) {
        // Nothing running: the shell just echoes ^C and gives a fresh prompt.
        eggPrint(`${eggPrompt()}${input.value}^C`);
        input.value = "";
      }
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      egg.at = Math.max(0, Math.min(egg.history.length, egg.at + (e.key === "ArrowUp" ? -1 : 1)));
      input.value = egg.history[egg.at] || "";
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeEggTerminal();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      el("egg-out").textContent = "";
    }
  });
  // Drag the window by its title bar.
  const bar = el("egg-bar");
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const term = el("egg-term");
    const box = term.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      term.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
      term.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      term.style.transform = "none";
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
}

/* The moving backdrop behind the map for the secret themes: green rain, or a starfield. */
function syncThemeBackdrop() {
  const id = currentTheme();
  const kind = ["matrix", "darkside", "neon"].includes(id) ? id : null;
  const canvas = el("theme-backdrop");
  if (!canvas) return;
  canvas.hidden = !kind;
  if (egg.backdrop && egg.backdrop.kind !== kind) {
    cancelAnimationFrame(egg.backdrop.frame);
    egg.backdrop = null;
  }
  if (!kind || egg.backdrop) return;
  const ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fx = (egg.backdrop = { kind, frame: 0, last: 0, w: 0, h: 0, born: performance.now() });
  const painter = kind === "matrix" ? matrixRain(ctx, fx) : kind === "neon" ? synthwave(ctx, fx) : starfield(ctx, fx);
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    fx.w = canvas.clientWidth;
    fx.h = canvas.clientHeight;
    canvas.width = Math.max(1, fx.w * dpr);
    canvas.height = Math.max(1, fx.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    painter.fit();
  };
  fit();
  if (still) {
    painter.still(); // one settled frame instead of motion
    return;
  }
  const tick = (t) => {
    if (egg.backdrop !== fx) return;
    if (canvas.width !== Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))) fit();
    if (!document.hidden && t - fx.last > painter.every) {
      fx.last = t;
      painter.draw(t);
    }
    fx.frame = requestAnimationFrame(tick);
  };
  fx.frame = requestAnimationFrame(tick);
}

function matrixRain(ctx, fx) {
  const glyphs = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF";
  const size = 16;
  let drops = [];
  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, fx.w, fx.h);
    ctx.font = `${size - 2}px ui-monospace, Consolas, monospace`;
    drops.forEach((y, i) => {
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      ctx.fillStyle = Math.random() < 0.06 ? "#d6ffe0" : "#00c43a";
      ctx.fillText(ch, i * size, y * size);
      drops[i] = y * size > fx.h && Math.random() > 0.975 ? 0 : y + 1;
    });
  };
  return {
    every: 50,
    fit() {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, fx.w, fx.h);
      drops = Array.from({ length: Math.ceil(fx.w / size) }, (_, i) => drops[i] ?? (Math.random() * -fx.h) / size);
    },
    draw,
    still() {
      for (let i = 0; i < 60; i++) draw();
    },
  };
}

// Stars drifting slowly towards you; the first moments after switching are a jump to light speed.
function starfield(ctx, fx) {
  const WARP_MS = 1400;
  let stars = [];
  const spawn = (far) => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: far ? 1 : 0.05 + Math.random() * 0.95, tw: Math.random() * Math.PI * 2, red: Math.random() < 0.04 });
  const sky = () => {
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, fx.w, fx.h);
    // A faint red glow low on one side, like a distant nebula.
    const g = ctx.createRadialGradient(fx.w * 0.15, fx.h * 0.95, 0, fx.w * 0.15, fx.h * 0.95, Math.max(fx.w, fx.h) * 0.7);
    g.addColorStop(0, "rgba(160, 20, 30, 0.16)");
    g.addColorStop(1, "rgba(160, 20, 30, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, fx.w, fx.h);
  };
  const project = (s) => {
    const f = Math.min(fx.w, fx.h) * 0.6;
    return [fx.w / 2 + (s.x / s.z) * f, fx.h / 2 + (s.y / s.z) * f];
  };
  const draw = (t) => {
    const age = t - fx.born;
    const warp = age < WARP_MS ? Math.sin((age / WARP_MS) * Math.PI) : 0; // up, then back down
    const speed = 0.0009 + warp * 0.05;
    sky();
    for (const s of stars) {
      const [x0, y0] = project(s);
      s.z -= speed;
      s.tw += 0.05;
      if (s.z <= 0.04) Object.assign(s, spawn(true));
      const [x1, y1] = project(s);
      if (x1 < -20 || x1 > fx.w + 20 || y1 < -20 || y1 > fx.h + 20) {
        Object.assign(s, spawn(true));
        continue;
      }
      const near = 1 - s.z;
      const alpha = Math.min(1, 0.25 + near * 0.9) * (0.75 + 0.25 * Math.sin(s.tw));
      const colour = s.red ? `rgba(255, 90, 90, ${alpha})` : `rgba(225, 235, 255, ${alpha})`;
      if (warp > 0.15) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 0.6 + near * 1.6;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else {
        ctx.fillStyle = colour;
        const r = 0.35 + near * 1.5;
        ctx.beginPath();
        ctx.arc(x1, y1, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  return {
    every: 33,
    fit() {
      const count = Math.round(Math.min(700, (fx.w * fx.h) / 2600));
      stars = Array.from({ length: count }, () => spawn(false));
      sky();
    },
    draw,
    still() {
      fx.born = -Infinity; // no warp
      draw(0);
    },
  };
}

/* ---------- Terminal toys that play on the map ---------- */

// One command runs at a time, like a real shell: the prompt hides until it ends, and Ctrl+C
// stops it.
function eggStartJob(name) {
  eggCancel({ quiet: true });
  egg.job = { name, timers: [] };
  el("egg-prompt").textContent = "";
}

function eggEndJob() {
  egg.job = null;
  el("egg-prompt").textContent = eggPrompt();
}

function eggLater(fn, ms) {
  const id = setTimeout(fn, ms);
  egg.job?.timers.push(id);
  return id;
}

// Take whatever a command put on the map back off it.
function eggCleanup() {
  if (state.cy) {
    state.cy.nodes('[role = "egg-ripple"], [role = "egg-packet"]').remove();
    state.cy.edges(".egg-path").removeClass("egg-path");
    state.cy.nodes(".egg-ping").removeClass("egg-ping");
  }
  document.querySelector(".egg-lane")?.remove();
}

function eggCancel({ quiet = false } = {}) {
  const job = egg.job;
  if (!job) return false;
  job.timers.forEach(clearTimeout);
  eggCleanup();
  // Windows ping says "Control-C"; everything else just echoes ^C.
  if (!quiet) eggPrint(eggWindows() && job.name === "ping" ? "Control-C" : "^C");
  eggEndJob();
  return true;
}

const eggDevices = () => (state.graph?.nodes || []).filter(isDeviceNode);
const eggIp = (n) => (n.ips || [])[0] || "";
const eggAddr = (n) => eggIp(n) || (n.macs || [])[0] || n.id.replace(/^\w+:/, "");
const eggMs = (base) => (base + Math.random() * base * 0.6).toFixed(3);

// A device named on the command line: its name, address, MAC, or network name.
function eggFind(query) {
  const q = query.toLowerCase();
  const devices = eggDevices();
  const exact = devices.find((n) => [displayName(n), ...(n.ips || []), ...(n.macs || [])].some((v) => String(v).toLowerCase() === q));
  return exact || devices.find((n) => [displayName(n), ...(n.ips || []), ...(n.macs || []), ...(n.ssids || [])].some((v) => String(v).toLowerCase().includes(q))) || null;
}

const eggOnMap = (n) => n && state.cy && state.cy.getElementById(n.id).length && !state.cy.getElementById(n.id).hasClass("time-out");

// Where a command starts from: the selected device, else a client, else anything.
function eggSource() {
  const picked = state.selection.map((id) => nodeById(id)).find((n) => n && isDeviceNode(n) && eggOnMap(n));
  if (picked) return picked;
  // Prefer devices with links, so a route or a reply has somewhere to go.
  const devices = eggDevices()
    .filter(eggOnMap)
    .sort((a, b) => Number(state.cy.getElementById(b.id).degree() > 0) - Number(state.cy.getElementById(a.id).degree() > 0));
  return devices.find((n) => nodeRole(n) === "wireless") || devices.find((n) => nodeRole(n) === "host") || devices[0] || null;
}

function eggDefaultTarget(from) {
  const devices = eggDevices().filter((n) => eggOnMap(n) && n.id !== from?.id);
  return devices.find((n) => nodeRole(n) === "gateway") || devices.find((n) => nodeRole(n) === "ap") || devices[0] || null;
}

function eggTempNode(id, role, pos, data = {}) {
  state.cy.getElementById(id).remove();
  return state.cy.add({ group: "nodes", data: { id, role, synthetic: 1, ...data }, position: { ...pos }, selectable: false, grabbable: false });
}

/* ping: a sonar ripple from the device for every reply. */
function eggPing(arg) {
  const win = eggWindows();
  if (!state.cy) return eggPrint("No map is open.", "egg-error");
  const target = arg ? eggFind(arg) : state.selection.length ? eggSource() : eggDefaultTarget(null);
  if (!target || !eggOnMap(target)) {
    return eggPrint(win ? `Ping request could not find host ${arg}. Please check the name and try again.` : `ping: ${arg}: Name or service not known`, "egg-error");
  }
  const name = displayName(target);
  const addr = eggAddr(target);
  eggPrint(win ? `\nPinging ${name} [${addr}] with 32 bytes of data:` : `PING ${name} (${addr}) 56(84) bytes of data.`);
  eggStartJob("ping");
  const node = state.cy.getElementById(target.id);
  const times = [];
  for (let i = 0; i < 4; i += 1) {
    eggLater(() => {
      const t = Number(eggMs(1.2));
      times.push(t);
      eggPrint(win ? `Reply from ${addr}: bytes=32 time${t < 1 ? "<1" : `=${Math.round(t)}`}ms TTL=64` : `64 bytes from ${addr}: icmp_seq=${i + 1} ttl=64 time=${t.toFixed(2)} ms`);
      eggRipple(node, i);
      if (i === 3) {
        const min = Math.min(...times);
        const max = Math.max(...times);
        const avg = times.reduce((s, x) => s + x, 0) / times.length;
        eggPrint(
          win
            ? `\nPing statistics for ${addr}:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\nApproximate round trip times in milli-seconds:\n    Minimum = ${Math.round(min)}ms, Maximum = ${Math.round(max)}ms, Average = ${Math.round(avg)}ms`
            : `\n--- ${name} ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss, time 3004ms\nrtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${((max - min) / 2).toFixed(3)} ms`
        );
        eggEndJob();
      }
    }, 900 * i + 300);
  }
}

function eggRipple(node, i) {
  if (!state.cy || !node.length || node.removed()) return;
  const ring = eggTempNode(`egg:ripple:${i}`, "egg-ripple", node.position(), { size: 40 });
  node.flashClass("egg-ping", 350);
  if (eggStill()) return setTimeout(() => ring.remove(), 600);
  ring.animate({ style: { width: 520, height: 520, "border-opacity": 0, "border-width": 1 } }, { duration: 1400, easing: "ease-out", complete: () => ring.remove() });
}

const eggStill = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// With no target named: the gateway if a route leads there, else the farthest device that can
// be reached, so the trace always has somewhere to go.
function eggReachableTarget(shown, from) {
  if (!from) return null;
  const root = state.cy.getElementById(from.id);
  const dist = shown.dijkstra({ root, directed: false });
  const reachable = eggDevices()
    .filter((n) => n.id !== from.id && eggOnMap(n))
    .map((n) => ({ n, d: dist.distanceTo(state.cy.getElementById(n.id)) }))
    .filter((x) => Number.isFinite(x.d));
  if (!reachable.length) return null;
  return (reachable.find((x) => nodeRole(x.n) === "gateway") || reachable.sort((a, b) => b.d - a.d)[0]).n;
}

/* traceroute / tracert: a packet hops along the real links, one line per hop. */
function eggTraceroute(arg) {
  const win = eggWindows();
  if (!state.cy) return eggPrint("No map is open.", "egg-error");
  const from = eggSource();
  const cy = state.cy;
  const shown = cy.elements().not(".time-out").not('[role = "group"], [role = "annotation"], [role = "ring"]');
  const to = arg ? eggFind(arg) : eggReachableTarget(shown, from);
  if (arg && !to) return eggPrint(win ? `Unable to resolve target system name ${arg}.` : `${arg}: Name or service not known\nCannot handle "host" cmdline arg \`${arg}' on position 1 (argc 1)`, "egg-error");
  if (!from || !to || !eggOnMap(to)) return eggPrint(from ? `${displayName(from)} has no links to follow on this map.` : "Nothing to trace on this map.", "egg-error");
  const result = shown.aStar({ root: cy.getElementById(from.id), goal: cy.getElementById(to.id), directed: false });
  const name = displayName(to);
  const addr = eggAddr(to);
  eggPrint(win ? `\nTracing route to ${name} [${addr}]\nover a maximum of 30 hops:\n` : `traceroute to ${name} (${addr}), 30 hops max, 60 byte packets`);
  if (!result.found) {
    eggPrint(win ? "  1     *        *        *     Request timed out.\nTrace complete." : " 1  * * *\n(no links lead there on this map)");
    return;
  }
  eggStartJob("traceroute");
  const hops = result.path.nodes().toArray().slice(1);
  const edges = result.path.edges();
  cy.animate({ fit: { eles: result.path, padding: 140 } }, { duration: eggStill() ? 0 : 500 });
  edges.addClass("egg-path");
  const packet = eggTempNode("egg:packet", "egg-packet", result.path.nodes()[0].position());
  const step = eggStill() ? 250 : 700;
  hops.forEach((hop, i) => {
    eggLater(() => {
      const raw = nodeById(hop.id());
      const ms = [eggMs(0.4 + i * 0.6), eggMs(0.4 + i * 0.6), eggMs(0.4 + i * 0.6)];
      const label = raw ? `${displayName(raw)} ${win ? `[${eggAddr(raw)}]` : `(${eggAddr(raw)})`}` : hop.id();
      eggPrint(
        win
          ? `${String(i + 1).padStart(3)}    ${ms.map((m) => (Number(m) < 1 ? "<1 ms" : `${Math.round(m)} ms`).padStart(5)).join("    ")}  ${label}`
          : `${String(i + 1).padStart(2)}  ${label}  ${ms.join(" ms  ")} ms`
      );
      if (!packet.removed()) packet.animate({ position: { ...hop.position() } }, { duration: step * 0.85, easing: "ease-in-out" });
      hop.flashClass("egg-ping", 400);
      if (i === hops.length - 1) {
        if (win) eggPrint("\nTrace complete.");
        eggEndJob();
        eggLater(() => {
          packet.remove();
          edges.removeClass("egg-path");
        }, 1800);
      }
    }, step * (i + 1));
  });
}

/* ./wardrive: a little car crosses the bottom of the map, logging networks as it goes. */
const CAR_SVG = `<svg viewBox="0 0 64 34" width="64" height="34" aria-hidden="true"><path d="M30 6 v-5" stroke="currentColor" stroke-width="1.5"/><path d="M26 3 q4 -4 8 0" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 22 l4 -9 q2 -4 7 -4 h22 q5 0 8 4 l6 9 h4 q3 0 3 3 v3 h-62 v-3 q0 -3 3 -3z" fill="currentColor"/><path d="M14 13 l3 -3 h9 v6 h-14z M30 10 h8 q3 0 5 3 l2 3 h-15z" fill="var(--canvas)" opacity="0.75"/><circle cx="16" cy="28" r="5" fill="#111"/><circle cx="16" cy="28" r="2" fill="#bbb"/><circle cx="48" cy="28" r="5" fill="#111"/><circle cx="48" cy="28" r="2" fill="#bbb"/></svg>`;
const WIFI_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.5" fill="currentColor"/></svg>`;

function eggWardrive() {
  const aps = eggDevices().filter((n) => nodeRole(n) === "ap");
  const named = [...new Set(aps.flatMap((n) => n.ssids || []).map((s) => String(s).trim()).filter(Boolean))];
  const networks = (named.length ? named : ["linksys", "NETGEAR42", "xfinitywifi", "HP-Print-3B-OfficeJet", "Guest"]).slice(0, 8);
  const channelOfSsid = (s) => aps.find((n) => (n.ssids || []).includes(s))?.channels?.[0] || [1, 6, 11, 36, 44][Math.floor(Math.random() * 5)];
  eggPrint(`Wardrive started ${formatTime(Date.now() / 1000, { date: true })}. GPS: 3D fix, 9 satellites.`);
  eggStartJob("wardrive");
  const stage = el("stage");
  const map = el("map").getBoundingClientRect();
  const box = stage.getBoundingClientRect();
  document.querySelector(".egg-lane")?.remove();
  const lane = document.createElement("div");
  lane.className = "egg-lane";
  lane.style.top = `${map.bottom - box.top - 92}px`;
  lane.innerHTML = `<div class="egg-car">${CAR_SVG}</div>`;
  stage.appendChild(lane);
  const car = lane.querySelector(".egg-car");
  const width = map.width;
  const duration = eggStill() ? 0 : 7000;
  if (duration) car.animate([{ transform: "translateX(-80px)" }, { transform: `translateX(${width + 20}px)` }], { duration, easing: "linear", fill: "forwards" });
  networks.forEach((ssid, i) => {
    const at = (i + 1) / (networks.length + 1);
    eggLater(() => {
      eggPrint(`New network: ${ssid} (ch ${channelOfSsid(ssid)}, ${-(45 + Math.round(Math.random() * 40))} dBm)`);
      if (!duration) return;
      const drop = document.createElement("div");
      drop.className = "egg-drop";
      drop.style.left = `${at * (width + 100) - 60}px`;
      drop.innerHTML = `${WIFI_SVG}<span>${escapeHtml(ssid)}</span>`;
      lane.appendChild(drop);
      drop.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(-14px)", offset: 0.2 }, { opacity: 0, transform: "translateY(-46px)" }], { duration: 2600, easing: "ease-out", fill: "forwards" });
    }, duration * at || 150 * (i + 1));
  });
  eggLater(() => {
    eggPrint(`Drive complete: ${plural(networks.length, "network")} logged.`, "egg-ok");
    eggEndJob();
    eggLater(() => lane.remove(), 2700);
  }, (duration || 150 * networks.length) + 300);
}

/* hacktheplanet's backdrop: a synthwave sunset over a moving grid. */
function synthwave(ctx, fx) {
  let offset = 0;
  const draw = () => {
    const { w, h } = fx;
    const horizon = h * 0.6;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#0d0221");
    sky.addColorStop(0.65, "#2a0845");
    sky.addColorStop(1, "#6b0f6b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);
    // The sun, banded near the bottom.
    const r = Math.min(w, h) * 0.2;
    const cx = w / 2;
    const cy = horizon - r * 0.35;
    const sun = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    sun.addColorStop(0, "#ffe14d");
    sun.addColorStop(0.55, "#ff6ad5");
    sun.addColorStop(1, "#c4247f");
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#2a0845";
    for (let i = 0; i < 6; i += 1) {
      const y = cy + r * (0.1 + i * 0.16);
      ctx.fillRect(cx - r, y, r * 2, 2 + i * 1.4);
    }
    ctx.restore();
    // The floor.
    const floor = ctx.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, "#1a0533");
    floor.addColorStop(1, "#07010f");
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.strokeStyle = "rgba(255, 47, 214, 0.55)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = -14; i <= 14; i += 1) {
      ctx.moveTo(cx + i * 6, horizon);
      ctx.lineTo(cx + i * w * 0.16, h);
    }
    for (let k = 0; k < 14; k += 1) {
      const t = ((k + offset) / 14) ** 2.2;
      const y = horizon + t * (h - horizon);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(0, 240, 255, 0.7)";
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
    offset = (offset + 0.02) % 1;
  };
  return { every: 40, fit: draw, draw, still: draw };
}

/* ---------- Geo map (GPS) ---------- */
// A real-world map of where devices were seen. Offline by default (markers on a lat/lon grid with a
// scale, nothing leaves the machine); an opt-in street basemap loads OpenStreetMap tiles online.

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const geo = {
  map: null,
  features: null, // device markers + estimate spread circles
  path: null, // operator path polyline
  focusLayer: null, // focused device's own sightings
  baseLayer: null, // the current basemap tile layer (online streets or an offline pack)
  basemap: "online", // "none" | "online" | "pack:<id>"
  packs: [], // loaded offline map packs (from /api/mappacks)
  mode: "whole", // "whole" | "added"
  added: new Set(),
  focusId: null,
  tmin: null,
  tmax: null,
  cutoff: null,
};

const geoLocated = (n) => (n.track && n.track.length) || (Number.isFinite(n.gps?.lat) && Number.isFinite(n.gps?.lon));
const geoDevices = () => (state.graph?.nodes || []).filter((n) => isDeviceNode(n) && geoLocated(n));

function syncGeoButton() {
  show("btn-geo", geoDevices().length > 0);
}

// Keep the geo map in step when the active map changes: forget devices that are gone, and redraw
// if it's open.
function geoOnGraphChange() {
  const ids = new Set((state.graph?.nodes || []).map((n) => n.id));
  for (const id of [...geo.added]) if (!ids.has(id)) geo.added.delete(id);
  if (geo.focusId && !ids.has(geo.focusId)) geo.focusId = null;
  if (geo.map && !el("geo-view").classList.contains("hidden")) renderGeo(false);
}

function geoColor(n) {
  const c = themeColors();
  return c[nodeRole(n)] || c.host;
}

// Best guess of where a device is: its estimated location if we have one, else its kept fix, else
// the mean of its sightings.
function geoPoint(n) {
  const e = n.extra?.est_location;
  if (e && Number.isFinite(e.lat) && Number.isFinite(e.lon)) return { lat: e.lat, lon: e.lon, estimated: true };
  if (Number.isFinite(n.gps?.lat) && Number.isFinite(n.gps?.lon)) return { lat: n.gps.lat, lon: n.gps.lon, estimated: false };
  if (n.track?.length) {
    const la = n.track.reduce((s, p) => s + p[0], 0) / n.track.length;
    const lo = n.track.reduce((s, p) => s + p[1], 0) / n.track.length;
    return { lat: la, lon: lo, estimated: false };
  }
  return null;
}

// Compass bearing (degrees, 0 = north) from one lat/lon to another, for the operator arrow.
function geoBearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function geoTimeRange(devs) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of devs) for (const p of n.track || []) if (Number.isFinite(p[2])) ((lo = Math.min(lo, p[2])), (hi = Math.max(hi, p[2])));
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : null;
}

function initGeoMap() {
  // Zoom sits bottom-right so it never covers the legend or the street-map note (both at the top).
  geo.map = L.map("geo-map", { zoomControl: false, attributionControl: true, preferCanvas: true });
  geo.map.setView([0, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(geo.map);
  L.control.scale({ imperial: true, metric: true }).addTo(geo.map);
  geo.features = L.layerGroup().addTo(geo.map);
  geo.path = L.layerGroup().addTo(geo.map);
  geo.focusLayer = L.layerGroup().addTo(geo.map);
}

function geoVisibleDevices() {
  let devs = geoDevices();
  if (geo.mode === "added") devs = devs.filter((n) => geo.added.has(n.id));
  if (geo.cutoff != null) {
    devs = devs.filter((n) => {
      const timed = (n.track || []).some((p) => Number.isFinite(p[2]));
      return !timed || (n.track || []).some((p) => Number.isFinite(p[2]) && p[2] <= geo.cutoff);
    });
  }
  return devs;
}

function geoPopup(n) {
  const sig = n.signal_dbm != null ? `${n.signal_dbm} dBm` : "";
  const e = n.extra?.est_location;
  const est = e ? `Estimated from ${e.n} readings (±${formatMetres(e.radius_m)}).` : "";
  const sightings = n.track?.length ? `${n.track.length} GPS ${n.track.length === 1 ? "fix" : "fixes"}` : "";
  // Identifiers, so a device can be told apart when the map is crowded.
  const ssid = (n.ssids || []).map((s) => String(s || "").trim()).filter(Boolean)[0];
  const mac = (n.macs || [])[0];
  const ip = (n.ips || [])[0];
  const ch = (n.channels || []).find((c) => Number.isFinite(Number(c)));
  const idRows = [
    ssid ? ["SSID", ssid] : null,
    mac ? ["MAC", mac] : null,
    ip ? ["IP", ip] : null,
    ch != null ? ["Channel", ch] : null,
  ].filter(Boolean);
  return `<div class="geo-pop"><strong>${escapeHtml(displayName(n))}</strong>
    <div class="geo-pop-sub">${escapeHtml([inferredName(n), sig].filter(Boolean).join(" · "))}</div>
    ${idRows.map(([k, v]) => `<div class="geo-pop-row"><span class="geo-pop-k">${escapeHtml(k)}</span> ${escapeHtml(String(v))}</div>`).join("")}
    ${sightings ? `<div class="geo-pop-row">${escapeHtml(sightings)}</div>` : ""}
    ${est ? `<div class="geo-pop-row hint">${escapeHtml(est)}</div>` : ""}
    <button type="button" class="btn small" data-geo-open="${escapeHtml(n.id)}">Open details</button></div>`;
}

function renderGeo(fit = false) {
  if (!geo.map) return;
  geo.features.clearLayers();
  geo.path.clearLayers();
  geo.focusLayer.clearLayers();
  const devs = geoVisibleDevices();
  const showEst = el("geo-estimates").checked;
  const bounds = [];
  for (const n of devs) {
    const pt = geoPoint(n);
    if (!pt) continue;
    const color = geoColor(n);
    const focused = n.id === geo.focusId;
    if (showEst && n.extra?.est_location) {
      L.circle([pt.lat, pt.lon], { radius: n.extra.est_location.radius_m || 1, color, weight: 1, opacity: 0.55, fillColor: color, fillOpacity: 0.08 }).addTo(geo.features);
    }
    // A white casing around a solid fill keeps points readable over both dark markers and
    // street tiles. Estimated positions read as hollow (thicker ring, light fill).
    const m = L.circleMarker([pt.lat, pt.lon], {
      radius: focused ? 9 : 7,
      color: "#ffffff",
      weight: 2,
      fillColor: color,
      fillOpacity: pt.estimated ? 0.45 : 0.95,
    });
    m.bindPopup(geoPopup(n));
    m.addTo(geo.features);
    bounds.push([pt.lat, pt.lon]);
    // Pulse ring to pick the focused device out of a crowd.
    if (focused) {
      L.marker([pt.lat, pt.lon], {
        interactive: false,
        icon: L.divIcon({ className: "geo-pulse-icon", html: `<span class="geo-pulse" style="--geo-pulse:${color}"></span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(geo.focusLayer);
    }
  }
  // Operator path: every sighting across visible devices, in time order, up to the cutoff.
  if (el("geo-path").checked) {
    const pts = [];
    for (const n of devs) for (const p of n.track || []) if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && (geo.cutoff == null || !Number.isFinite(p[2]) || p[2] <= geo.cutoff)) pts.push(p);
    pts.sort((a, b) => (a[2] || 0) - (b[2] || 0));
    if (pts.length > 1) {
      const line = pts.map((p) => [p[0], p[1]]);
      // Dark casing under a bright line so the route stands out on street tiles.
      L.polyline(line, { color: "#1b1b1b", weight: 5, opacity: 0.35 }).addTo(geo.path);
      L.polyline(line, { color: themeColors().select || "#3aa0ff", weight: 2.5, opacity: 0.95 }).addTo(geo.path);
      // Operator position "now": the most recent sighting up to the cutoff.
      const last = pts[pts.length - 1];
      const prev = pts.length > 1 ? pts[pts.length - 2] : null;
      const heading = prev ? geoBearing(prev[0], prev[1], last[0], last[1]) : 0;
      L.marker([last[0], last[1]], {
        interactive: true,
        zIndexOffset: 1000,
        icon: L.divIcon({ className: "geo-operator-icon", html: `<span class="geo-operator" style="transform:rotate(${heading}deg)"></span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      })
        .bindTooltip(`Operator${Number.isFinite(last[2]) ? ` · ${new Date(last[2] * 1000).toLocaleString()}` : ""}`)
        .addTo(geo.path);
    }
  }
  // Focused device: show each of its sightings as a small dot, joined in the order they were seen.
  const focus = geo.focusId && devs.find((n) => n.id === geo.focusId);
  if (focus && focus.track?.length) {
    const color = geoColor(focus);
    const seen = (focus.track || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (geo.cutoff == null || !Number.isFinite(p[2]) || p[2] <= geo.cutoff));
    const ordered = [...seen].sort((a, b) => (a[2] || 0) - (b[2] || 0));
    if (ordered.length > 1) L.polyline(ordered.map((p) => [p[0], p[1]]), { color, weight: 1.5, opacity: 0.8 }).addTo(geo.focusLayer);
    for (const p of seen) {
      L.circleMarker([p[0], p[1]], { radius: 3, color, weight: 1, fillColor: color, fillOpacity: 0.85 })
        .bindTooltip(`${p[3] != null ? `${p[3]} dBm` : "seen"}${Number.isFinite(p[2]) ? ` · ${new Date(p[2] * 1000).toLocaleString()}` : ""}`)
        .addTo(geo.focusLayer);
      bounds.push([p[0], p[1]]);
    }
  }
  el("geo-count").textContent = `${devs.length} ${devs.length === 1 ? "device" : "devices"}${geo.mode === "added" ? " added" : ""}`;
  geoLegend();
  if (fit && bounds.length) geo.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
}

function updateGeoTime() {
  if (geo.tmin == null) {
    geo.cutoff = null;
    return;
  }
  const frac = Number(el("geo-time").value) / 1000;
  geo.cutoff = geo.tmin + (geo.tmax - geo.tmin) * frac;
  el("geo-time-from").textContent = new Date(geo.tmin * 1000).toLocaleString();
  el("geo-time-to").textContent = frac >= 1 ? "all" : new Date(geo.cutoff * 1000).toLocaleString();
}

function syncGeoModeUi() {
  el("geo-mode-whole").setAttribute("aria-selected", String(geo.mode === "whole"));
  el("geo-mode-added").setAttribute("aria-selected", String(geo.mode === "added"));
  show("geo-clear", geo.mode === "added");
}

function geoLegend() {
  // Only show device types that are actually on the map, so the key stays short.
  const present = new Set(geoVisibleDevices().map((n) => nodeRole(n)));
  const items = [
    ["ap", "Access point"],
    ["wireless", "Wireless client"],
    ["bluetooth", "Bluetooth"],
    ["cell", "Cell tower"],
    ["host", "Other device"],
  ].filter(([k]) => present.has(k) || (k === "host" && present.size === 0));
  const c = themeColors();
  const route = c.select || "#3aa0ff";
  el("geo-legend").innerHTML =
    `<div class="geo-leg-group">` +
    items.map(([k, label]) => `<span class="geo-leg"><i style="background:${c[k] || c.host}"></i>${escapeHtml(label)}</span>`).join("") +
    `<span class="geo-leg"><i class="ring"></i>Estimated position (ring = margin)</span>` +
    `</div><div class="geo-leg-group">` +
    `<span class="geo-leg"><i class="line" style="background:${route}"></i>Operator route</span>` +
    `<span class="geo-leg"><i class="op"></i>Operator now</span>` +
    (geo.focusId ? `<span class="geo-leg"><i class="pulse"></i>Selected device</span>` : "") +
    `</div>`;
}

function openGeoMap(focusId = null) {
  if (typeof L === "undefined") {
    toast("The map library didn't load.");
    return;
  }
  if (!geoDevices().length) {
    toast("This survey has no GPS data to map.");
    return;
  }
  el("geo-view").classList.remove("hidden");
  if (focusId) {
    geo.focusId = focusId;
    if (geo.mode === "added") geo.added.add(focusId);
  }
  if (!geo.map) initGeoMap();
  const range = geoTimeRange(geoDevices());
  geo.tmin = range ? range[0] : null;
  geo.tmax = range ? range[1] : null;
  show("geo-timebar", !!range);
  if (range) {
    el("geo-time").value = 1000;
    updateGeoTime();
  } else {
    geo.cutoff = null;
  }
  geoLegend();
  syncGeoModeUi();
  // The container just became visible; let it lay out before Leaflet measures and fits, or the
  // first open draws nothing until the next interaction.
  loadGeoPacks();
  requestAnimationFrame(() => {
    if (!geo.map) return;
    geo.map.invalidateSize();
    setBasemap(geo.basemap);
    renderGeo(true);
  });
}

function closeGeoMap() {
  el("geo-view").classList.add("hidden");
  geo.focusId = null;
}

function setGeoMode(mode) {
  if (geo.mode === mode) return;
  geo.mode = mode;
  syncGeoModeUi();
  renderGeo(true);
}

// Basemap: the map background. "none" draws markers on a plain grid; "online" fetches OpenStreetMap
// street tiles (the one option that goes online); "pack:<id>" serves an offline .mbtiles pack from
// the backend, so roads and terrain work with nothing leaving the machine.
function setBasemap(value) {
  if (!geo.map) return;
  geo.basemap = value;
  if (geo.baseLayer) {
    geo.map.removeLayer(geo.baseLayer);
    geo.baseLayer = null;
  }
  const online = value === "online";
  show("geo-street-note", online);
  const pack = value && value.startsWith("pack:") ? geo.packs.find((p) => `pack:${p.id}` === value) : null;
  if (online) {
    // crossOrigin lets Export rasterize the tiles without tainting the canvas (OSM sends CORS headers).
    geo.baseLayer = L.tileLayer(OSM_TILES, { maxZoom: 19, crossOrigin: "anonymous", attribution: "© OpenStreetMap contributors" });
  } else if (pack) {
    const opts = { maxNativeZoom: pack.maxzoom, maxZoom: 19, minNativeZoom: pack.minzoom, crossOrigin: "anonymous", attribution: pack.attribution || "Offline map pack" };
    if (Array.isArray(pack.bounds) && pack.bounds.length === 4) {
      opts.bounds = L.latLngBounds([pack.bounds[1], pack.bounds[0]], [pack.bounds[3], pack.bounds[2]]);
    }
    geo.baseLayer = L.tileLayer(`/api/mappacks/${encodeURIComponent(pack.id)}/{z}/{x}/{y}`, opts);
  } else if (value !== "none") {
    // The chosen pack is gone (removed elsewhere); fall back to markers only.
    geo.basemap = "none";
  }
  if (geo.baseLayer) geo.baseLayer.addTo(geo.map);
  syncBasemapUi();
}

// Reflect the current basemap in the select and show Remove only for a loaded pack.
function syncBasemapUi() {
  const sel = el("geo-basemap");
  if (sel && sel.value !== geo.basemap) sel.value = geo.basemap;
  show("geo-pack-remove", String(geo.basemap).startsWith("pack:"));
}

// Rebuild the basemap <select>: Markers only, Streets (online), then each loaded offline pack.
function renderBasemapOptions() {
  const sel = el("geo-basemap");
  if (!sel) return;
  const opts = [
    `<option value="none">No basemap</option>`,
    `<option value="online">Streets — online</option>`,
    ...geo.packs.map((p) => `<option value="pack:${escapeHtml(p.id)}">${escapeHtml(p.name)} (offline)</option>`),
  ];
  sel.innerHTML = opts.join("");
  // Keep the current choice if it's still available, else fall back to online.
  if (geo.basemap.startsWith("pack:") && !geo.packs.some((p) => `pack:${p.id}` === geo.basemap)) geo.basemap = "online";
  sel.value = geo.basemap;
}

async function loadGeoPacks() {
  try {
    const res = await fetch("/api/mappacks");
    if (!res.ok) throw new Error();
    const data = await res.json();
    geo.packs = Array.isArray(data.packs) ? data.packs : [];
    show("geo-pack-add", data.can_add !== false);
  } catch {
    geo.packs = [];
  }
  renderBasemapOptions();
  syncBasemapUi();
}

async function addGeoPack(file) {
  if (!file) return;
  if (!/\.mbtiles$/i.test(file.name)) {
    toast("Choose a .mbtiles map pack.");
    return;
  }
  toast(`Loading ${file.name}…`);
  try {
    const res = await fetch(`/api/mappacks?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Couldn't load that map pack.");
    await loadGeoPacks();
    geo.basemap = `pack:${data.id}`;
    setBasemap(geo.basemap);
    toast(`Loaded “${data.name}”.`);
  } catch (e) {
    toast(e.message || "Couldn't load that map pack.");
  }
}

async function removeGeoPack(id) {
  if (!id) return;
  const pack = geo.packs.find((p) => p.id === id);
  const ok = await openDialog({ title: `Remove “${pack ? pack.name : id}”?`, body: "The offline map pack is deleted from this computer.", okLabel: "Remove", danger: true });
  if (!ok) return;
  try {
    const res = await fetch(`/api/mappacks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error();
  } catch {
    toast("Couldn't remove that map pack.");
    return;
  }
  if (geo.basemap === `pack:${id}`) geo.basemap = "online";
  await loadGeoPacks();
  setBasemap(geo.basemap);
}

/* ---------- Export the geo map (image / PDF) ---------- */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Wait until the map's overlays are drawn and the basemap tiles (if any) have loaded, so a capture
// isn't half-painted. Resolves anyway after a short cap, since online tiles can be slow.
function geoCaptureReady() {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      const c = el("geo-map");
      const tiles = c ? c.querySelectorAll("img.leaflet-tile") : [];
      const loaded = c ? c.querySelectorAll("img.leaflet-tile-loaded") : [];
      const tilesReady = geo.basemap === "none" || (tiles.length > 0 && loaded.length === tiles.length);
      if ((tilesReady && geo.features && geo.features.getLayers().length) || performance.now() - start > 8000) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

// Rasterize the map (basemap + overlays + markers) to a canvas, with the legend drawn on top. The
// zoom buttons are left out so the picture is clean for a briefing.
async function captureGeoCanvas() {
  if (typeof html2canvas === "undefined") throw new Error("The image library didn't load.");
  const bg = themeColors().canvas || "#0f1115";
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const common = { useCORS: true, scale, logging: false };
  const mapCanvas = await html2canvas(el("geo-map"), {
    ...common,
    backgroundColor: bg,
    ignoreElements: (e) => e.classList && e.classList.contains("leaflet-control-zoom"),
  });
  const legend = el("geo-legend");
  if (legend && legend.offsetParent !== null) {
    try {
      const legCanvas = await html2canvas(legend, { ...common, backgroundColor: null });
      mapCanvas.getContext("2d").drawImage(legCanvas, 12 * scale, 12 * scale);
    } catch {
      /* the legend is a nicety; skip it if it won't render */
    }
  }
  return mapCanvas;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/png"));
}

// Make sure the geo map is rendered (open it off-screen if it's closed), capture it, then restore.
// Returns the data URL, for including the map in a report.
async function geoImageDataUrl() {
  const view = el("geo-view");
  const wasOpen = !view.classList.contains("hidden");
  if (!wasOpen) {
    view.classList.add("geo-capturing");
    openGeoMap();
  }
  try {
    await geoCaptureReady();
    const canvas = await captureGeoCanvas();
    return canvas.toDataURL("image/png");
  } finally {
    if (!wasOpen) {
      closeGeoMap();
      view.classList.remove("geo-capturing");
    }
  }
}

async function exportGeoImage() {
  try {
    toast("Saving the map image…", { timeout: 1500 });
    await geoCaptureReady();
    const blob = await canvasToPngBlob(await captureGeoCanvas());
    downloadBlob(blob, `${safeFileStem(state.title)}-geo-map.png`);
    toast("Saved the map image.", { timeout: 2000 });
  } catch (err) {
    fail(err);
  }
}

async function exportGeoPdf() {
  try {
    toast("Making the map PDF…", { timeout: 2000 });
    await geoCaptureReady();
    const image = (await captureGeoCanvas()).toDataURL("image/png");
    const res = await fetch("/api/export/geo.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, title: state.title }),
    });
    if (!res.ok) throw new Error((await parseResponse(res).catch((e) => e)).message || "Export failed");
    await download(res, `${safeFileStem(state.title)}-geo-map.pdf`);
    toast("Saved the map PDF.", { timeout: 2000 });
  } catch (err) {
    fail(err);
  }
}

function bindGeoMap() {
  el("btn-geo").addEventListener("click", () => openGeoMap());
  el("geo-close").addEventListener("click", closeGeoMap);
  el("geo-back").addEventListener("click", closeGeoMap);
  el("geo-mode-whole").addEventListener("click", () => setGeoMode("whole"));
  el("geo-mode-added").addEventListener("click", () => setGeoMode("added"));
  el("geo-clear").addEventListener("click", () => {
    geo.added.clear();
    renderGeo(true);
  });
  el("geo-basemap").addEventListener("change", (e) => setBasemap(e.target.value));
  el("geo-pack-add").addEventListener("click", () => el("geo-pack-file").click());
  el("geo-pack-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    addGeoPack(file);
  });
  el("geo-pack-remove").addEventListener("click", () => {
    if (String(geo.basemap).startsWith("pack:")) removeGeoPack(geo.basemap.slice(5));
  });
  el("geo-export").addEventListener("click", (e) =>
    openMenu(e.currentTarget, [
      { label: "Save as image (PNG)", onSelect: exportGeoImage },
      { label: "Save as PDF", onSelect: exportGeoPdf },
    ], { align: "right" })
  );
  el("geo-path").addEventListener("change", () => renderGeo(false));
  el("geo-estimates").addEventListener("change", () => renderGeo(false));
  el("geo-time").addEventListener("input", () => {
    updateGeoTime();
    renderGeo(false);
  });
  el("geo-map").addEventListener("click", (e) => {
    const open = e.target.closest("[data-geo-open]");
    if (!open) return;
    closeGeoMap();
    selectNodes([open.dataset.geoOpen], { center: true });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("geo-view").classList.contains("hidden")) closeGeoMap();
  });
}

// Open the geo map focused on one device (from its details or right-click).
function showDeviceOnMap(id) {
  openGeoMap(id);
}

/* ---------- In-app update dialog (Electron) ---------- */
// True while a chosen-version install (version list) is staged, so Restart runs the downloaded
// installer instead of electron-updater's quitAndInstall.
let eupdateVersionInstall = false;
// electron-updater's progress and prompts, shown inside the app window instead of native OS dialogs.
// The shell forwards {state, version?, percent?, transferred?, total?, bytesPerSecond?, message?, manual?}.

function showUpdateProgress(s) {
  const bar = el("eupdate-bar");
  const wrap = el("eupdate-progress");
  show("eupdate-progress", true);
  if (typeof s.percent === "number" && s.total) {
    const pct = Math.max(0, Math.min(100, Math.round(s.percent)));
    wrap.classList.remove("indeterminate");
    bar.style.width = `${pct}%`;
    wrap.setAttribute("aria-valuenow", String(pct));
    const rate = s.bytesPerSecond ? ` · ${formatSize(s.bytesPerSecond)}/s` : "";
    el("eupdate-text").textContent = `Downloading: ${formatSize(s.transferred)} of ${formatSize(s.total)}${rate}`;
  } else {
    wrap.classList.add("indeterminate");
    wrap.removeAttribute("aria-valuenow");
  }
}

// What the page does with each update event. Background (non-manual) checks stay quiet and only
// pop up once a download is ready; a user-initiated check shows the whole flow.
function handleUpdateStatus(s) {
  const dialog = el("eupdate-dialog");
  const open = () => dialog.open || dialog.showModal();
  if (!s.manual && s.state !== "ready") {
    // Background check: stay quiet while it downloads; only the ready-to-restart prompt pops up.
    // The dot on the settings cog hints that something's coming.
    if (s.state === "available" || s.state === "downloading") show("update-dot", true);
    return;
  }
  show("eupdate-releases", false);
  show("eupdate-restart", false);
  show("eupdate-install", false);
  show("eupdate-progress", false);
  el("eupdate-later").textContent = "Later";
  switch (s.state) {
    case "checking":
      el("eupdate-title").textContent = "Checking for updates";
      el("eupdate-text").textContent = "Asking GitHub for the latest version…";
      el("eupdate-later").textContent = "Close";
      open();
      break;
    case "available":
      // A manual check found an update: let the user start it with the Install button.
      el("eupdate-title").textContent = "Update available";
      el("eupdate-text").textContent = `NetSeer ${s.version || "a newer version"} is available. You have ${state.server.version}.`;
      show("eupdate-install", true);
      open();
      el("eupdate-install").focus();
      break;
    case "downloading":
      el("eupdate-title").textContent = "Downloading update";
      showUpdateProgress(s);
      open();
      break;
    case "ready":
      eupdateVersionInstall = !!s.versionInstall;
      el("eupdate-title").textContent = eupdateVersionInstall ? `Ready to install ${s.version || ""}`.trim() : "Update ready";
      el("eupdate-text").textContent = `NetSeer ${s.version || "the new version"} is ready. Restart to ${eupdateVersionInstall ? "install it" : "finish updating"}; your maps are kept.`;
      el("eupdate-restart").textContent = "Restart and install";
      show("eupdate-restart", true);
      show("update-dot", true);
      open();
      el("eupdate-restart").focus();
      break;
    case "none":
      el("eupdate-title").textContent = "You're up to date";
      el("eupdate-text").textContent = `NetSeer ${s.version || state.server.version} is the latest version.`;
      el("eupdate-later").textContent = "Close";
      open();
      break;
    case "error":
      el("eupdate-title").textContent = "Couldn't check for updates";
      el("eupdate-text").textContent = s.message || "Try again later.";
      el("eupdate-releases").href = repoUrl("/releases");
      show("eupdate-releases", true);
      el("eupdate-later").textContent = "Close";
      open();
      break;
  }
}

function bindUpdateDialog() {
  const dialog = el("eupdate-dialog");
  el("eupdate-later").addEventListener("click", () => dialog.close());
  el("eupdate-install").addEventListener("click", () => {
    window.netseerShell?.downloadUpdate?.();
    el("eupdate-title").textContent = "Downloading update";
    show("eupdate-install", false);
    showUpdateProgress({}); // indeterminate until the first progress event
  });
  el("eupdate-restart").addEventListener("click", () => {
    el("eupdate-restart").disabled = true;
    el("eupdate-text").textContent = "Restarting to install…";
    if (eupdateVersionInstall) window.netseerShell?.applyVersionUpdate?.();
    else window.netseerShell?.installUpdate?.();
  });
  el("electron-release-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-install-version]");
    if (btn) startVersionInstall(btn.dataset.installVersion);
  });
}

// Frameless title bar: wire the min/max/close buttons to the Electron shell (no-op elsewhere).
function setupWindowChrome() {
  const shell = window.netseerShell;
  if (!shell || shell.kind !== "electron" || !shell.window) return;
  document.documentElement.dataset.shell = "electron";
  const w = shell.window;
  el("win-min").addEventListener("click", () => w.minimize());
  el("win-max").addEventListener("click", () => w.toggleMaximize());
  el("win-close").addEventListener("click", () => w.close());
  const sync = (max) => document.documentElement.classList.toggle("win-maximized", !!max);
  Promise.resolve(w.isMaximized()).then(sync).catch(() => {});
  w.onMaximizeChange(sync);
  // A netseer:// link brought us to the front; the shell handled focus, acknowledge it here.
  if (shell.onDeepLink) shell.onDeepLink(() => toast("NetSeer opened from a link", { timeout: 2500 }));
  // Update progress and the restart prompt show in the in-app dialog (handleUpdateStatus), not a
  // native OS dialog. Automatic updates run in the background (electron-updater).
  if (shell.onUpdateStatus) {
    bindUpdateDialog();
    shell.onUpdateStatus(handleUpdateStatus);
  }
  // Manual "Check for updates" lists the versions from GitHub; the list's buttons install, reinstall,
  // or roll back (the shell downloads + checksum-verifies + runs the installer).
  el("updates-electron-check").addEventListener("click", () => checkForUpdates());
  if (shell.setAutoUpdate) {
    el("updates-electron-auto").addEventListener("change", (e) => {
      shell.setAutoUpdate(e.target.checked);
      setUpdateStatus(e.target.checked ? "NetSeer updates itself automatically." : "Automatic updates are off — check when you want one.", e.target.checked ? "good" : "");
    });
  }
}

async function init() {
  setupWindowChrome();
  startHeartbeat();
  mapResize.observe(el("map"));
  // Capture phase on the stage, so this runs before Cytoscape's listener on the map.
  el("stage").addEventListener("wheel", onMapWheel, { capture: true, passive: false });
  bindUi();
  bindReportDialog();
  bindSettings();
  bindGeoMap();
  bindSidebarResize();
  bindManualDialogs();
  bindDisconnectDialog();
  bindTimeline();
  bindCompareDialog();
  bindDemo();
  bindSecurity();
  bindEggTerminal();
  syncThemeBackdrop();
  el("loading-stop").addEventListener("click", stopReading);
  el("loading-cancel").addEventListener("click", cancelReading);
  bindListDrag();
  loadPrefs();
  renderLayerList();
  syncZoomUi();
  await loadStore();
  ensureUnwanted();
  await loadServerInfo();
  try {
    state.catalog = await parseResponse(await fetch("/api/samples"));
  } catch (err) {
    state.catalog = [];
    fail(err);
  }
  const hidden = new Set(hiddenSampleIds());
  const restoredUploads = state.maps.filter((m) => String(m.sourceId || "").startsWith("upload:")).map((m) => ({ id: m.sourceId, kind: "upload", name: m.name, summary: "Your capture", graph: m.graph }));
  // Samples aren't loaded for you: they're in Settings → Demo, and join Surveys once opened.
  const openedSamples = state.catalog.filter((s) => !hidden.has(s.id) && mapNodeCount(getMap(`map:${s.id}`)) > 0);
  state.surveys = sortSurveys([...restoredUploads.filter((s) => !hidden.has(s.id)), ...openedSamples.map(sampleToSurvey)]);
  await openStartingMap();
  const updated = noteVersionChange();
  // The desktop app window is Electron's Chromium: persistent storage is granted without a prompt.
  if (state.server.mode === "desktop") requestPersistentStorage();
  if (!updated) offerTour();
  autoCheckUpdates();
  connectEvents(); // hear when a companion app pushes a capture
  state.ready = true;
}

async function openStartingMap() {
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
  const first = state.surveys[0];
  if (first) await selectSurvey(first.id);
  else showMap(UNWANTED_ID); // nothing yet: the welcome offers Open survey and the demo
}

init().catch((err) => fail(err));
