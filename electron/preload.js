// Minimal, locked-down bridge. The page talks to the backend over HTTP/WebSocket as it always
// has; this exposes only a little inert info today. Window controls (frameless title bar) land in
// Phase 2 and will be added here behind contextBridge, never by enabling nodeIntegration.

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("netseerShell", {
  kind: "electron",
  platform: process.platform,
});
