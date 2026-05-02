const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("proxyApp", {
  getStatus: () => ipcRenderer.invoke("proxy:status"),
  toggle: (enabled) => ipcRenderer.invoke("proxy:toggle", enabled),
  testChat: () => ipcRenderer.invoke("proxy:testChat"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  copy: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
