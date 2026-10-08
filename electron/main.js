// NetSeer desktop shell (Electron).
// Launches the existing Python backend as a managed sidecar, shows it in a frameless window with a
// custom title bar, and adds the native desktop touches: a tray, an application menu, and a
// netseer:// deep link. The Python app and the web UI are unchanged. See docs/electron-migration.md.

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const SMOKE = process.argv.includes("--smoke-test");
const BG = "#15140f";
const REPO = "ardyn-systems/NetSeer";
const GUIDE_URL = `https://github.com/${REPO}/blob/main/docs/user-guide.md`;
const ISSUES_URL = `https://github.com/${REPO}/issues/new`;

let sidecar = null;
let sidecarExited = false;
let shuttingDown = false;
let mainWindow = null;
let tray = null;
let pendingDeepLink = null;

function log(...args) {
  console.log("[netseer]", ...args);
}

// Only one NetSeer at a time: a second launch (e.g. from a netseer:// link) focuses this one.
const gotLock = app.requestSingleInstanceLock();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icons", "netseer.png")
    : path.join(__dirname, "..", "packaging", "linux", "netseer.png");
}

// Dev runs the server from source (python -m netseer); a packaged build runs the frozen sidecar.
function sidecarCommand(port) {
  const args = ["--host", "127.0.0.1", "--port", String(port)];
  const explicit = process.env.NETSEER_SIDECAR;
  if (explicit) return { cmd: explicit, args };
  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "netseer-server.exe" : "netseer-server";
    return { cmd: path.join(process.resourcesPath, "netseer", exe), args };
  }
  const py = process.env.NETSEER_PYTHON || (process.platform === "win32" ? "python" : "python3");
  return { cmd: py, args: ["-m", "netseer", ...args] };
}

function startSidecar(port) {
  const { cmd, args } = sidecarCommand(port);
  log("starting backend:", cmd, args.join(" "));
  const env = { ...process.env, NETSEER_MODE: "desktop", NETSEER_PACKAGE: "electron", NETSEER_BOUND_HOST: "127.0.0.1" };
  // windowsHide + piped stdio: the Python sidecar is a console program, so without this it pops up
  // a terminal window on Windows — and closing that terminal would kill the backend and take NetSeer
  // down with it. We hide it and forward its output to our own streams (shown in dev, nowhere in the
  // packaged GUI app).
  sidecar = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  sidecar.stdout?.on("data", (d) => process.stdout.write(d));
  sidecar.stderr?.on("data", (d) => process.stderr.write(d));
  sidecar.on("exit", (code) => {
    sidecarExited = true;
    if (shuttingDown) return; // we killed it on purpose
    log("backend exited unexpectedly:", code);
    failFast(`backend exited with code ${code}`);
  });
  sidecar.on("error", (err) => failFast(`couldn't start backend: ${err.message}`));
}

function stopSidecar() {
  shuttingDown = true;
  if (sidecar && !sidecarExited) {
    try {
      sidecar.kill();
    } catch {
      /* already gone */
    }
  }
}

function waitForHealth(port, { tries = 120, delay = 250 } = {}) {
  const url = `http://127.0.0.1:${port}/api/health`;
  return new Promise((resolve, reject) => {
    let left = tries;
    const attempt = () => {
      if (sidecarExited) return reject(new Error("backend stopped before it was ready"));
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = () => {
      if (--left <= 0) return reject(new Error("backend didn't answer in time"));
      setTimeout(attempt, delay);
    };
    attempt();
  });
}

function createWindow(port) {
  const base = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: BG,
    show: !SMOKE,
    autoHideMenuBar: true,
    frame: false, // the app draws its own title bar (see the web UI's window controls)
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  // Links to other sites open in the user's browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(base)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Keep the custom title bar's maximize/restore button in step with the real window state.
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  win.on("closed", () => {
    mainWindow = null;
  });
  // A deep link that arrived before the page was ready is delivered once it loads.
  win.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      win.webContents.send("deeplink", pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  win.loadURL(`${base}/`);
  return win;
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  if (SMOKE) return; // the smoke run never shows UI
  try {
    let image = nativeImage.createFromPath(iconPath());
    if (process.platform === "win32" && !image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip("NetSeer");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show NetSeer", click: showMainWindow },
        { label: "Hide to tray", click: () => mainWindow && mainWindow.hide() },
        { type: "separator" },
        { label: "Quit NetSeer", click: () => app.quit() },
      ])
    );
    tray.on("click", () => (mainWindow && mainWindow.isVisible() ? mainWindow.hide() : showMainWindow()));
  } catch (err) {
    log("tray unavailable:", err.message); // e.g. no tray daemon (headless/CI)
  }
}

// ---- Auto-update (electron-updater, GitHub provider) ----
// Only the packaged app updates itself; in dev electron-updater no-ops. The portable zip and the
// source/hosted modes update the way they always have.

let updateManualCheck = false;

// A tiny persisted setting for the shell itself (the backend has its own settings). Default on.
function shellSettingsPath() {
  return path.join(app.getPath("userData"), "shell-settings.json");
}
function readShellSettings() {
  try {
    return { autoUpdate: true, ...JSON.parse(fs.readFileSync(shellSettingsPath(), "utf8")) };
  } catch {
    return { autoUpdate: true };
  }
}
function writeShellSettings(patch) {
  const next = { ...readShellSettings(), ...patch };
  try {
    fs.writeFileSync(shellSettingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    log("couldn't save shell settings:", err.message);
  }
  return next;
}

// The update UI lives in the web page (Settings → Updates and an in-app dialog), not in native OS
// dialogs. We forward electron-updater's events to the renderer; it shows the status and the
// restart button. `manual` marks a user-initiated check so the page can stay quiet about background
// ones (it only pops up on its own when a download is ready).
function sendUpdate(payload) {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) {
    wc.send("updates:status", payload);
    return true;
  }
  return false;
}

function setupUpdates() {
  if (SMOKE || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("checking-for-update", () => sendUpdate({ state: "checking", manual: updateManualCheck }));
  autoUpdater.on("update-available", (info) => sendUpdate({ state: "available", version: info?.version, manual: updateManualCheck }));
  autoUpdater.on("update-not-available", () => {
    sendUpdate({ state: "none", version: app.getVersion(), manual: updateManualCheck });
    updateManualCheck = false;
  });
  autoUpdater.on("download-progress", (p) =>
    sendUpdate({ state: "downloading", manual: updateManualCheck, percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond })
  );
  autoUpdater.on("update-downloaded", (info) => {
    // Always surface this (manual or background): the restart prompt is the one thing the user acts on.
    const shown = sendUpdate({ state: "ready", version: info?.version });
    updateManualCheck = false;
    // Fallback only if there's no window to show the in-app prompt (e.g. closed to tray and destroyed).
    if (!shown) {
      dialog
        .showMessageBox(undefined, { type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1, title: "Update ready", message: `NetSeer ${info?.version} is ready to install.`, detail: "Restart NetSeer to finish updating." })
        .then(({ response }) => response === 0 && installUpdate());
    }
  });
  autoUpdater.on("error", (err) => {
    log("update check failed:", err == null ? "unknown" : err.message);
    sendUpdate({ state: "error", manual: updateManualCheck, message: err?.message || "Something went wrong." });
    updateManualCheck = false;
  });
  // Only check on launch when the user leaves auto-update on; the Check-for-updates button always works.
  if (readShellSettings().autoUpdate) {
    autoUpdater.checkForUpdates().catch((err) => log("update check error:", err.message));
  }
}

function installUpdate() {
  shuttingDown = true;
  stopSidecar();
  // isSilent: install without the setup wizard; isForceRunAfter: relaunch when done.
  autoUpdater.quitAndInstall(true, true);
}

function checkForUpdatesNow() {
  if (!app.isPackaged) {
    sendUpdate({ state: "error", manual: true, message: "Auto-update runs in the installed app. From source, update with git/uv as usual." });
    return;
  }
  updateManualCheck = true;
  autoUpdater.checkForUpdates().catch((err) => log("manual update check error:", err.message));
}

function showAbout() {
  dialog.showMessageBox(mainWindow ?? undefined, {
    type: "info",
    title: "About NetSeer",
    message: "NetSeer",
    detail: `Turn traffic into terrain.\nVersion ${app.getVersion()}`,
  });
}

function setupMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Check for updates…", click: checkForUpdatesNow },
        { type: "separator" },
        { label: "User guide", click: () => shell.openExternal(GUIDE_URL) },
        { label: "Report a problem", click: () => shell.openExternal(ISSUES_URL) },
        { type: "separator" },
        { label: "About NetSeer", click: showAbout },
      ],
    },
  ];
  // The menu bar stays hidden on the frameless window (autoHideMenuBar), but its accelerators —
  // Reload, zoom, DevTools, and the clipboard shortcuts in text fields — work regardless.
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Deep links (netseer://) ----

function deepLinkFrom(argv) {
  return (argv || []).find((a) => typeof a === "string" && a.startsWith("netseer://")) || null;
}

function handleDeepLink(url) {
  if (!url) return;
  if (mainWindow) {
    showMainWindow();
    mainWindow.webContents.send("deeplink", url);
  } else {
    pendingDeepLink = url;
  }
}

function registerProtocol() {
  if (process.defaultApp) {
    // In dev, point the registration at this script so Windows can relaunch Electron with the URL.
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient("netseer", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("netseer");
  }
}

// Window controls for the frameless title bar the web UI draws. Scoped to the sending window.
ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("window:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) (win.isMaximized() ? win.unmaximize() : win.maximize());
});
ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle("window:is-maximized", (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());
ipcMain.on("updates:check", () => checkForUpdatesNow());
ipcMain.on("updates:install", () => installUpdate());
ipcMain.handle("updates:get-auto", () => readShellSettings().autoUpdate);
ipcMain.on("updates:set-auto", (_e, on) => {
  writeShellSettings({ autoUpdate: !!on });
  if (on && app.isPackaged) autoUpdater.checkForUpdates().catch((err) => log("update check error:", err.message));
});

function failFast(message) {
  log("ERROR:", message);
  stopSidecar();
  app.exit(1);
}

async function main() {
  registerProtocol();
  setupMenu();
  pendingDeepLink = deepLinkFrom(process.argv); // a link passed on first launch (Windows/Linux)
  const port = await freePort();
  startSidecar(port);
  await waitForHealth(port);
  log("backend ready on", port);
  const win = createWindow(port);
  setupTray();
  setupUpdates();

  if (SMOKE) {
    const timer = setTimeout(() => failFast("window didn't finish loading in time"), 30000);
    win.webContents.once("did-finish-load", async () => {
      clearTimeout(timer);
      try {
        await new Promise((r) => setTimeout(r, 300)); // let init() wire the title bar
        const r = await win.webContents.executeJavaScript(
          "({shell: window.netseerShell && window.netseerShell.kind, controls: !!document.getElementById('win-close'), dataShell: document.documentElement.dataset.shell})"
        );
        if (r.shell !== "electron" || !r.controls || r.dataShell !== "electron") {
          return failFast("title-bar bridge not wired: " + JSON.stringify(r));
        }
        log("SMOKE OK (frameless title bar wired:", JSON.stringify(r) + ")");
        stopSidecar();
        app.exit(0);
      } catch (e) {
        failFast("smoke check failed: " + e.message);
      }
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => {
      clearTimeout(timer);
      failFast(`page failed to load: ${desc} (${code})`);
    });
  }
}

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleDeepLink(deepLinkFrom(argv));
    showMainWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.whenReady().then(main).catch((err) => failFast(err.message));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopSidecar);
app.on("will-quit", stopSidecar);
process.on("exit", stopSidecar);
