const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("proxyApp", {
  getStatus: () => ipcRenderer.invoke("proxy:status"),
  toggle: (enabled) => ipcRenderer.invoke("proxy:toggle", enabled),
  testChat: () => ipcRenderer.invoke("proxy:testChat"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  onStatusUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("proxy:status-updated", listener);
    return () => ipcRenderer.removeListener("proxy:status-updated", listener);
  },
  cancelUpdateDownload: () => ipcRenderer.invoke("proxy:update-cancel"),
  restartForUpdate: () => ipcRenderer.invoke("proxy:update-restart"),
  closeUpdateWindow: () => ipcRenderer.invoke("proxy:update-close-window"),
  runUpdateAction: (action) => ipcRenderer.invoke("proxy:update-run-action", action),
  onUpdateWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("proxy:update-state", listener);
    return () => ipcRenderer.removeListener("proxy:update-state", listener);
  },
  copy: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
