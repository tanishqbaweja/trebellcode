const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trebellDesktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("workspace:pickDirectory"),
  pickFiles: () => ipcRenderer.invoke("workspace:pickFiles"),
  notify: (payload) => ipcRenderer.send("desktop:notify", payload),
  captureScreen: () => ipcRenderer.invoke("desktop:screenshot"),
  computer: {
    screenshot: () => ipcRenderer.invoke("computer:screenshot"),
    move: (x,y) => ipcRenderer.invoke("computer:move", {x,y}),
    click: (payload) => ipcRenderer.invoke("computer:click", payload),
    scroll: (delta) => ipcRenderer.invoke("computer:scroll", {delta}),
    type: (text) => ipcRenderer.invoke("computer:type", {text}),
    key: (key) => ipcRenderer.invoke("computer:key", {key}),
  },
  zoom: {
    get: () => ipcRenderer.invoke("desktop:zoom:get"),
    set: (factor) => ipcRenderer.invoke("desktop:zoom:set", factor),
    reset: () => ipcRenderer.invoke("desktop:zoom:reset"),
  },
  background: {
    get: () => ipcRenderer.invoke("desktop:background:get"),
    set: (enabled) => ipcRenderer.invoke("desktop:background:set", enabled),
  },
  browser: {
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    show: () => ipcRenderer.invoke("browser:show"),
    snapshot: () => ipcRenderer.invoke("browser:snapshot"),
    click: (ref) => ipcRenderer.invoke("browser:click", ref),
    type: (ref,text) => ipcRenderer.invoke("browser:type", {ref,text}),
    screenshot: () => ipcRenderer.invoke("browser:screenshot"),
    importCookies: (payload) => ipcRenderer.invoke("browser:importCookies", payload),
    close: () => ipcRenderer.invoke("browser:close"),
  },
});
