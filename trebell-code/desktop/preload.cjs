const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trebellDesktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("workspace:pickDirectory"),
  pickFiles: () => ipcRenderer.invoke("workspace:pickFiles"),
});
