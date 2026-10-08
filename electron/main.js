// NetSeer desktop shell (Electron) — Phase 1.
// Launches the existing Python backend as a managed sidecar, waits for it to answer, and shows it
// in a window. The Python app and the web UI are unchanged; this only replaces the pywebview
// window. See docs/electron-migration.md.

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

const SMOKE = process.argv.includes("--smoke-test");
const BG = "#15140f";

let sidecar = null;
let sidecarExited = false;
let shuttingDown = false;

function log(...args) {
  console.log("[netseer]", ...args);
}

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

// Dev runs the server from source (python -m netseer); a packaged build runs the frozen
// server sidecar bundled under resources/ (added in the packaging step, a later Phase-1 slice).
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
  sidecar = spawn(cmd, args, { env, stdio: "inherit" });
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  win.loadURL(`${base}/`);
  return win;
}

function failFast(message) {
  log("ERROR:", message);
  stopSidecar();
  app.exit(1);
}

async function main() {
  const port = await freePort();
  startSidecar(port);
  await waitForHealth(port);
  log("backend ready on", port);
  const win = createWindow(port);

  if (SMOKE) {
    const timer = setTimeout(() => failFast("window didn't finish loading in time"), 30000);
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      log("SMOKE OK");
      stopSidecar();
      app.exit(0);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => {
      clearTimeout(timer);
      failFast(`page failed to load: ${desc} (${code})`);
    });
  }
}

app.whenReady().then(main).catch((err) => failFast(err.message));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopSidecar);
app.on("will-quit", stopSidecar);
process.on("exit", stopSidecar);
