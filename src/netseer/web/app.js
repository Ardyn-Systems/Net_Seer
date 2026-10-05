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
  redo: [],
  filters: Object.fromEntries(LAYERS.map((l) => [l.kind, true])),
  groupBySubnet: true,
  selection: [],
  inspectedLink: null,
  nodeIndex: new Map(),
  graphVersion: 0,
  propsCache: new Map(),
  suppressSelect: false,
  server: { hosted: false, maxUploadMb: 50, version: "", mode: "server", platform: "", package: "source", repo: "ardyn-systems/NetSeer", updater: false },
  // Settings that aren't layer filters. tourOffered: the first-run "Take the tour" message was shown.
  prefs: { zoomSpeed: "normal", hoverFade: true, apSsid: true, autoUpdate: false, tourOffered: false, sidebarWidth: null },
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
  const target = [entry.activeMapId, ...ids].find((id) => ids.includes(id) && getMap(id)) || (getMap(state.activeMapId) ? state.activeMapId : state.maps[0]?.id);
  showMap(target, { fit: target !== state.activeMapId });
}

function undoLast() {
  const entry = state.undo.pop();
  if (!entry) {
    syncUndoUi();
    toast("Nothing to undo.", { timeout: 1800 });
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
  state.undo.push(captureMaps(entry.label, entry.maps.map(([id]) => id)));
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  applyMapsSnapshot(entry);
  syncUndoUi();
  toast(`Redid ${entry.label}.`, { undo: true, timeout: 4000 });
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
    if (!state.prefs.hoverFade || n.isParent() || cy.nodes(":grabbed").length) return;
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
        <input type="text" id="insp-caption" value="${escapeHtml(meta.extra || "")}" placeholder="${escapeHtml(autoCaption(overlayNode(raw)) ? `${autoCaption(overlayNode(raw))} (from the SSID)` : "Lobby, rack A1, 2nd floor")}" autocomplete="off" />
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
    row.dataset.id = map.id;
    // Unwanted stays at the bottom: it can't be dragged, but you can still drag devices' maps onto others.
    if (map.kind !== "unwanted") row.dataset.dragType = "map";
    row.dataset.dropType = "map";
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
      openMenu(e.currentTarget, mapMenuItems(map), { align: "right" });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenuAt(e.clientX, e.clientY, [{ label: "Open", onSelect: () => showMap(map.id) }, "sep", ...mapMenuItems(map)]);
    });
    list.appendChild(row);
  }
}

function mapMenuItems(map) {
  const items = [{ label: "Rename…", onSelect: () => renameMap(map.id) }];
  if (map.kind === "unwanted") {
    items.push({ label: "Save to files and empty…", disabled: !mapNodeCount(map), onSelect: () => emptyUnwanted() });
  } else {
    items.push({ label: "Merge into…", disabled: mergeTargets(map.id).length === 0, onSelect: () => mergeMapDialog(map.id) });
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
      maxUploadMb: Number(info.max_upload_mb) || 50,
      version: String(info.version || ""),
      mode: info.mode || (info.hosted ? "hosted" : "server"),
      platform: info.platform || "",
      package: info.package || "source",
      repo: info.repo || state.server.repo,
      updater: Boolean(info.updater),
    };
  } catch {
    /* keep defaults */
  }
  const hosted = state.server.hosted;
  show("hosted-note", hosted);
  show("empty-hosted", hosted);
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
    row.dataset.id = item.id;
    row.dataset.dragType = "survey";
    row.dataset.dropType = "survey";
    const sub = item.kind === "upload" ? "Your capture" : item.summary;
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
  if (file.size > state.server.maxUploadMb * 1024 * 1024) {
    fail(new Error(`${file.name} is larger than this server's ${state.server.maxUploadMb} MB limit.`));
    return;
  }
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
    unhideSurvey(id);
    applyGraph(graph, file.name, id);
    // Their own capture is worth keeping; Firefox asks here, other browsers decide quietly.
    requestPersistentStorage();
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
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    syncReportDialog();
    if (el("report-create").disabled) return;
    const opts = readReportForm();
    const { node_ids, link_kinds, ...remember } = opts;
    writeLocal(REPORT_PREFS_KEY, { ...remember, match_layers: Boolean(link_kinds) });
    el("report-dialog").close();
    toast("Creating your report…", { timeout: 2500 });
    exportKind("report.pdf", { report: opts });
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
  if (typeof prefs.groupBySubnet === "boolean") state.groupBySubnet = prefs.groupBySubnet;
  if (prefs.tab) setTab(prefs.tab);
  if (WHEEL_ZOOM_PER_PIXEL[prefs.zoomSpeed]) state.prefs.zoomSpeed = prefs.zoomSpeed;
  for (const k of ["hoverFade", "apSsid", "autoUpdate", "tourOffered"]) if (typeof prefs[k] === "boolean") state.prefs[k] = prefs[k];
  if (Number.isFinite(prefs.sidebarWidth)) setSidebarWidth(prefs.sidebarWidth, { save: false });
}

function savePrefs() {
  writeLocal(PREFS_KEY, { filters: state.filters, groupBySubnet: state.groupBySubnet, tab: document.querySelector(".tab.active")?.dataset.tab, ...state.prefs });
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

/* ---------- Settings ---------- */

const UPDATES_KEY = "netseer.updates.v1";
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_NAMES = { windows: "Windows", linux: "Linux", macos: "macOS" };

const repoUrl = (path = "") => `https://github.com/${state.server.repo}${path}`;

function setGroupBySubnet(on) {
  state.groupBySubnet = on;
  el("group-toggle").checked = on;
  el("settings-group").checked = on;
  savePrefs();
  renderLayerList();
  renderMap({ fit: true });
}

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
}

function renderSettings() {
  renderThemeGrid();
  document.querySelectorAll('input[name="zoom-speed"]').forEach((r) => (r.checked = r.value === state.prefs.zoomSpeed));
  el("settings-group").checked = state.groupBySubnet;
  el("settings-hover").checked = state.prefs.hoverFade;
  el("settings-ssid").checked = state.prefs.apSsid;
  el("updates-auto").checked = state.prefs.autoUpdate;
  const version = state.server.version || "unknown";
  document.querySelectorAll(".app-version").forEach((n) => (n.textContent = version));
  el("about-mode").textContent = runningAs();
  el("updates-build").textContent = runningAs();
  const links = {
    repo: repoUrl(),
    guide: repoUrl("/blob/main/docs/user-guide.md"),
    issue: repoUrl(`/issues/new?body=${encodeURIComponent(`\n\n---\nNetSeer ${version}, ${runningAs()}`)}`),
  };
  document.querySelectorAll("#settings-dialog [data-link]").forEach((a) => (a.href = links[a.dataset.link]));
}

function renderThemeGrid() {
  const grid = el("settings-themes");
  const active = currentTheme();
  grid.innerHTML = "";
  for (const t of THEMES) {
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
  if (state.server.updater) return "Click Update, or Roll back on an older version. NetSeer downloads it, checks it against GitHub's checksum, and installs it for you, then reopens.";
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
  show("updates-local", !hosted);
  show("updates-hosted", hosted);
  show("updates-check", !hosted);
  if (hosted) {
    setUpdateStatus("This online copy is always the newest version.", "good");
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

function renderReleaseList(releases) {
  const list = el("release-list");
  list.innerHTML = "";
  for (const r of releases.slice(0, 12)) {
    const cmp = compareVersions(r.tag, state.server.version);
    const li = document.createElement("li");
    li.classList.toggle("current", cmp === 0);
    const tag = cmp === 0 ? '<span class="release-tag">Current</span>' : cmp > 0 ? '<span class="release-tag newer">Newer</span>' : "";
    const date = Date.parse(r.date) ? new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
    const asset = assetFor(r);
    const verb = cmp > 0 ? "Update" : cmp < 0 ? "Roll back" : "Reinstall";
    let actions = `<a class="btn small ghost" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Release notes</a>`;
    if (asset && state.server.updater) actions += `<button class="btn small${cmp > 0 ? " primary" : ""}" type="button" data-update="${escapeHtml(r.tag)}">${verb}</button>`;
    else if (asset) actions += `<a class="btn small${cmp > 0 ? " primary" : ""}" href="${escapeHtml(asset.url)}" target="_blank" rel="noopener" title="${escapeHtml(asset.name)}, ${formatSize(asset.size)}">${verb}</a>`;
    else if (state.server.package === "source") actions += `<button class="btn small${cmp > 0 ? " primary" : ""}" type="button" data-copy="${escapeHtml(r.tag)}">Copy ${verb.toLowerCase()} command</button>`;
    li.innerHTML = `<span><span class="release-name">${escapeHtml(r.name)}</span>${tag}<span class="release-meta">${escapeHtml(date)}${asset ? ` · ${escapeHtml(asset.name)}` : ""}</span></span>
      <span class="release-actions">${actions}</span>`;
    list.appendChild(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="hint">No releases yet.</li>';
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
  const open = () => (state.server.updater ? openUpdateWizard(newer) : openSettings("updates"));
  toast(`${newer.name} is available.`, { action: { label: state.server.updater ? "Update now" : "See what's new", onClick: open }, timeout: 10000 });
}

function bindSettings() {
  const dialog = el("settings-dialog");
  el("settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // backdrop
  });
  dialog.querySelectorAll(".settings-nav [data-pane]").forEach((b) => b.addEventListener("click", () => showSettingsPane(b.dataset.pane)));
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
  el("settings-group").addEventListener("change", (e) => setGroupBySubnet(e.target.checked));
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
    const upd = e.target.closest("[data-update]");
    if (upd) openUpdateWizard(readUpdateCache()?.releases.find((r) => r.tag === upd.dataset.update));
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

/* ---------- Update wizard (desktop app) ---------- */
// The desktop app downloads, checks, and installs releases itself (see netseer/updater.py).

const LAST_VERSION_KEY = "netseer.lastVersion";
const wizard = { release: null, timer: null };

async function updateApi(path, body) {
  const res = await fetch(`/api/update/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-NetSeer-Update": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(res);
}

// Release notes are Markdown; this covers what NetSeer's notes use.
function renderNotes(md) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = false;
  let table = null;
  const close = () => {
    if (list) out.push("</ul>");
    if (table) out.push(`<table>${table.join("")}</table>`);
    list = false;
    table = null;
  };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*[-*] (.*)$/);
    if (/^\|.*\|$/.test(line.trim())) {
      if (list) close();
      table ||= [];
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
      const cells = line.trim().slice(1, -1).split("|").map((c) => `<td>${inline(c.trim())}</td>`);
      table.push(`<tr>${cells.join("")}</tr>`);
    } else if (item) {
      if (table) close();
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(item[1])}</li>`);
    } else {
      close();
      const heading = line.match(/^#{1,4} (.*)$/);
      if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join("");
}

// The wizard does the downloading, so the notes' Downloads table is just noise there.
function withoutSection(md, heading) {
  const out = [];
  let skipping = false;
  for (const line of String(md || "").split(/\r?\n/)) {
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) skipping = h[2].trim().toLowerCase() === heading.toLowerCase();
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function showUpdateStep(name) {
  document.querySelectorAll("#update-dialog .upd-step").forEach((s) => s.classList.toggle("hidden", s.dataset.step !== name));
}

function openUpdateWizard(release) {
  if (!release) return;
  wizard.release = release;
  const cmp = compareVersions(release.tag, state.server.version);
  const asset = assetFor(release);
  el("upd-title").textContent = cmp > 0 ? `Update to ${release.name}` : cmp < 0 ? `Go back to ${release.name}` : `Reinstall ${release.name}`;
  el("upd-sub").textContent = `You have ${state.server.version}.${asset ? ` The download is ${formatSize(asset.size)}.` : ""}`;
  el("upd-notes").innerHTML = renderNotes(withoutSection(release.body, "Downloads")) || '<p class="hint">No release notes.</p>';
  show("upd-old-warning", compareVersions(release.tag, "0.4.0") < 0);
  el("upd-manual").href = release.url;
  el("upd-download").textContent = cmp > 0 ? "Download update" : cmp < 0 ? "Download this version" : "Download again";
  el("settings-dialog").close();
  closeMenu();
  showUpdateStep("intro");
  const dialog = el("update-dialog");
  if (!dialog.open) dialog.showModal();
  // Pick up a download that's already running or finished (say, after closing this).
  updateApi("status")
    .then((s) => {
      if (s.tag === release.tag && ["checking", "downloading", "verifying", "ready"].includes(s.status)) followUpdate(s);
    })
    .catch(() => {});
}

async function startUpdateDownload() {
  const release = wizard.release;
  if (!release) return;
  if (el("upd-backup").checked) await backupAll();
  showUpdateStep("progress");
  setUpdateProgress({ status: "checking", done: 0, total: 0 });
  try {
    followUpdate(await updateApi("start", { tag: release.tag }));
  } catch (err) {
    showUpdateError(err.message);
  }
}

function setUpdateProgress(s) {
  const pct = s.total ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;
  el("upd-bar").style.width = `${s.status === "verifying" ? 100 : pct}%`;
  el("upd-bar").parentElement.setAttribute("aria-valuenow", String(pct));
  el("upd-progress-text").textContent =
    s.status === "checking" ? "Asking GitHub for the download…"
    : s.status === "verifying" ? "Checking the download…"
    : s.total ? `Downloading: ${formatSize(s.done)} of ${formatSize(s.total)}`
    : "Downloading…";
}

function followUpdate(s) {
  clearTimeout(wizard.timer);
  if (s.status === "error") return showUpdateError(s.error);
  if (s.status === "ready") return showUpdateReady();
  if (s.status === "idle") return showUpdateStep("intro");
  showUpdateStep("progress");
  setUpdateProgress(s);
  wizard.timer = setTimeout(async () => {
    if (!el("update-dialog").open) return;
    try {
      followUpdate(await updateApi("status"));
    } catch (err) {
      showUpdateError(err.message);
    }
  }, 400);
}

function showUpdateReady() {
  const name = wizard.release?.name || "the new version";
  const pkg = state.server.package;
  el("upd-ready-text").textContent =
    pkg === "installer" ? `NetSeer will close, install ${name}, and reopen by itself. If NetSeer is installed for all users, Windows will ask for permission first.`
    : pkg === "appimage" ? `NetSeer will close and reopen as ${name}. The AppImage file is replaced where it is.`
    : `NetSeer will close, put ${name} in its folder, and reopen. The version you have now is kept next to it in a folder ending in “.previous”, until the next update.`;
  showUpdateStep("ready");
  el("upd-install").focus();
}

function showUpdateError(message) {
  clearTimeout(wizard.timer);
  el("upd-error").textContent = message || "Something went wrong.";
  showUpdateStep("error");
}

async function installUpdate() {
  el("upd-install").disabled = true;
  try {
    await flushSave();
    await updateApi("install", {});
    showUpdateStep("installing");
    // Browser windows can't always be closed by the app; say what to do if this one stays.
    setTimeout(() => {
      el("upd-installing-text").textContent = "NetSeer has closed to finish the update and will reopen in its own window. You can close this one.";
    }, 8000);
  } catch (err) {
    showUpdateError(err.message);
  } finally {
    el("upd-install").disabled = false;
  }
}

async function cancelUpdate() {
  clearTimeout(wizard.timer);
  try {
    await updateApi("cancel", {});
  } catch {
    /* nothing to cancel */
  }
  el("update-dialog").close();
}

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

function bindUpdateWizard() {
  const dialog = el("update-dialog");
  el("upd-download").addEventListener("click", () => startUpdateDownload().catch((err) => showUpdateError(err.message)));
  el("upd-install").addEventListener("click", installUpdate);
  dialog.querySelectorAll("[data-upd]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.upd;
      if (act === "cancel") cancelUpdate();
      else if (act === "retry") openUpdateWizard(wizard.release);
      else dialog.close();
    })
  );
  // Esc while downloading cancels the download, rather than leaving it running unseen.
  dialog.addEventListener("cancel", (e) => {
    const step = dialog.querySelector(".upd-step:not(.hidden)")?.dataset.step;
    if (step === "installing") e.preventDefault();
    else if (step === "progress" || step === "ready") {
      e.preventDefault();
      cancelUpdate();
    }
  });
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
  // Over a tab: switch to it after a moment, so a survey can be dropped on a map.
  const tab = under?.closest?.(".tab");
  if (tab !== drag.tab) {
    clearTimeout(drag.tabTimer);
    drag.tab = tab;
    if (tab && !tab.classList.contains("active")) drag.tabTimer = setTimeout(() => setTab(tab.dataset.tab), 350);
  }
  if (tab) tab.classList.add("drop-hover");
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
  { target: "#btn-open", title: "Open a survey", text: "Open .pcap, .pcapng, .cap, .kismet, .netxml, or .csv files, or drop them anywhere on the window. Each capture becomes its own map." },
  { target: "#sidebar .tabs", title: "Maps, Surveys, and Layers", text: "Maps lists everything you've made. Surveys holds the captures you've opened. Layers picks which kinds of links are drawn." },
  {
    target: "#sidebar",
    title: "Organize the sidebar",
    text: "Right-click a map or survey to rename, merge, remove, or delete it. Drag rows to reorder them, or drop one onto a map to merge it. Drag the sidebar's edge to make it wider.",
  },
  { target: "#map", title: "The map", text: "Drag devices to rearrange them and scroll to zoom. Access points show their Wi-Fi network (SSID) under their name. Hover a device to see what it connects to." },
  { target: ".search", title: "Find a device", text: "Search by name, IP, MAC, SSID, maker, or notes. Press / to jump here from anywhere. The arrows beside it undo and redo changes to your maps." },
  {
    target: "#inspector",
    title: "Details",
    text: "Select a device to see everything NetSeer found: addresses, radio, services, and routing. You can rename it and add notes here.",
    before: selectTourDevice,
  },
  { target: "#btn-export", title: "Export", text: "Save the map as a draw.io or Visio diagram, or create a PDF report with just the parts you need." },
  { target: "#btn-theme", title: "Themes", text: "Choose from four looks. Daylight works best for printing and projectors." },
  { target: "#btn-settings", title: "Settings and help", text: "Back up your maps, check for updates, go back to an older version, and replay this tour from here." },
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
      { label: "Report…", hint: "PDF", onSelect: openReportDialog },
    ])
  );
  el("btn-theme").addEventListener("click", (e) => openThemeMenu(e.currentTarget));
  el("btn-settings").addEventListener("click", () => openSettings());
  el("map-title").addEventListener("click", () => state.activeMapId && renameMap(state.activeMapId));
  el("btn-sidebar").addEventListener("click", () => el("sidebar").classList.toggle("open"));
  el("btn-new-map").addEventListener("click", createBlankMap);
  el("btn-restore-samples").addEventListener("click", restoreBundledSamples);
  el("btn-show-all").addEventListener("click", () => setAllLayers(true));
  el("btn-show-none").addEventListener("click", () => setAllLayers(false));
  el("group-toggle").addEventListener("change", (e) => setGroupBySubnet(e.target.checked));
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      setTab(t.dataset.tab);
      savePrefs();
    })
  );

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

async function init() {
  startHeartbeat();
  mapResize.observe(el("map"));
  // Capture phase on the stage, so this runs before Cytoscape's listener on the map.
  el("stage").addEventListener("wheel", onMapWheel, { capture: true, passive: false });
  bindUi();
  bindReportDialog();
  bindSettings();
  bindUpdateWizard();
  bindSidebarResize();
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
  state.surveys = sortSurveys([...restoredUploads.filter((s) => !hidden.has(s.id)), ...state.catalog.filter((s) => !hidden.has(s.id)).map(sampleToSurvey)]);
  await openStartingMap();
  const updated = noteVersionChange();
  // The app window is Chromium (WebView2) or a Chromium app-mode window: no prompt there.
  if (state.server.mode === "desktop") requestPersistentStorage();
  if (!updated) offerTour();
  autoCheckUpdates();
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
  const first = state.surveys.find((s) => s.id === "campus-all") || state.surveys[0];
  if (first) await selectSurvey(first.id);
  else showMap(UNWANTED_ID);
}

init().catch((err) => fail(err));
