// Minimal, locked-down bridge. The page talks to the backend over HTTP/WebSocket as it always
// has; this exposes only the window controls the frameless title bar needs. nodeIntegration stays
// off; nothing else from Node is reachable.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netseerShell", {
  kind: "electron",
  platform: process.platform,
  // A netseer:// link was opened; the page can route it (focus is already handled in the shell).
  onDeepLink: (callback) => ipcRenderer.on("deeplink", (_event, url) => callback(url)),
  // Ask the shell to check GitHub for a newer version now (same as the Help menu item).
  checkForUpdates: () => ipcRenderer.send("updates:check"),
  // Update progress/state from electron-updater: {state, version?, percent?, transferred?, total?, bytesPerSecond?, message?, manual?}.
  onUpdateStatus: (callback) => ipcRenderer.on("updates:status", (_event, status) => callback(status)),
  // Start downloading an available update (the manual "Install" button).
  downloadUpdate: () => ipcRenderer.send("updates:download"),
  // Restart and install a downloaded update now.
  installUpdate: () => ipcRenderer.send("updates:install"),
  // Version list: download+verify a specific release (roll back / reinstall / chosen version), then install it.
  startVersionUpdate: (tag) => ipcRenderer.send("updates:start-version", tag),
  applyVersionUpdate: () => ipcRenderer.send("updates:apply-version"),
  // The persisted "update automatically" preference.
  getAutoUpdate: () => ipcRenderer.invoke("updates:get-auto"),
  setAutoUpdate: (on) => ipcRenderer.send("updates:set-auto", on),
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizeChange: (callback) => ipcRenderer.on("window:maximized", (_event, value) => callback(value)),
  },
});
