const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trebellDesktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("workspace:pickDirectory"),
  pickFiles: () => ipcRenderer.invoke("workspace:pickFiles"),
  openIn: {
    list: () => ipcRenderer.invoke("workspace:editors"),
    open: (path,editorId) => ipcRenderer.invoke("workspace:openIn", {path,editorId}),
  },
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
  updates: {
    get: () => ipcRenderer.invoke("desktop:update:get"),
    check: () => ipcRenderer.invoke("desktop:update:check"),
    download: () => ipcRenderer.invoke("desktop:update:download"),
    install: () => ipcRenderer.invoke("desktop:update:install"),
    onState: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("desktop:update:state",listener);
      return () => ipcRenderer.removeListener("desktop:update:state",listener);
    },
  },
  snapshots: {
    get: () => ipcRenderer.invoke("snapshot:get"),
    configure: (config) => ipcRenderer.invoke("snapshot:configure", config),
    pending: () => ipcRenderer.invoke("snapshot:pending"),
    read: (id) => ipcRenderer.invoke("snapshot:read", id),
    ack: (id) => ipcRenderer.invoke("snapshot:ack", id),
    capture: () => ipcRenderer.invoke("snapshot:capture"),
    onCaptured: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("snapshot:captured",listener);
      return () => ipcRenderer.removeListener("snapshot:captured",listener);
    },
  },
  browser: {
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    show: () => ipcRenderer.invoke("browser:show"),
    state: () => ipcRenderer.invoke("browser:state"),
    back: () => ipcRenderer.invoke("browser:history", "back"),
    forward: () => ipcRenderer.invoke("browser:history", "forward"),
    reload: () => ipcRenderer.invoke("browser:history", "reload"),
    setViewport: (width,height) => ipcRenderer.invoke("browser:viewport", {width,height}),
    armRecording: () => ipcRenderer.invoke("browser:recording:arm"),
    onState: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("browser:state",listener);
      return () => ipcRenderer.removeListener("browser:state",listener);
    },
    snapshot: () => ipcRenderer.invoke("browser:snapshot"),
    click: (ref) => ipcRenderer.invoke("browser:click", ref),
    type: (ref,text) => ipcRenderer.invoke("browser:type", {ref,text}),
    screenshot: () => ipcRenderer.invoke("browser:screenshot"),
    importCookies: (payload) => ipcRenderer.invoke("browser:importCookies", payload),
    importSources: () => ipcRenderer.invoke("browser:importSources"),
    importProfile: (sourceId,profileId) => ipcRenderer.invoke("browser:importProfile", {sourceId,profileId}),
    close: () => ipcRenderer.invoke("browser:close"),
  },
});
