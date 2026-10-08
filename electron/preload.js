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
