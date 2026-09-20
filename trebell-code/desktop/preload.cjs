const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trebellDesktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("workspace:pickDirectory"),
  pickFiles: () => ipcRenderer.invoke("workspace:pickFiles"),
  notify: (payload) => ipcRenderer.send("desktop:notify", payload),
  browser: {
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    show: () => ipcRenderer.invoke("browser:show"),
    snapshot: () => ipcRenderer.invoke("browser:snapshot"),
    click: (ref) => ipcRenderer.invoke("browser:click", ref),
    type: (ref,text) => ipcRenderer.invoke("browser:type", {ref,text}),
    screenshot: () => ipcRenderer.invoke("browser:screenshot"),
    close: () => ipcRenderer.invoke("browser:close"),
  },
});
