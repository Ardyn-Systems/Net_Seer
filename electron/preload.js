// Minimal, locked-down bridge. The page talks to the backend over HTTP/WebSocket as it always
// has; this exposes only the window controls the frameless title bar needs. nodeIntegration stays
// off; nothing else from Node is reachable.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netseerShell", {
  kind: "electron",
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizeChange: (callback) => ipcRenderer.on("window:maximized", (_event, value) => callback(value)),
  },
});
