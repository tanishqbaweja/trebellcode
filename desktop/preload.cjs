const { contextBridge, ipcRenderer } = require("electron");

// A call the shell could not do rejects with the shell's own words, as the app shows its other errors: Electron puts
// "Error invoking remote method '<channel>': Error: " before them, which the app would show as it is.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(error => {
  throw new Error(String(error?.message || error).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ""));
});

contextBridge.exposeInMainWorld("trebellDesktop", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  platform: process.platform,
  pickDirectory: () => invoke("workspace:pickDirectory"),
  pickFiles: () => invoke("workspace:pickFiles"),
  openIn: {
    list: () => invoke("workspace:editors"),
    open: (path,editorId) => invoke("workspace:openIn", {path,editorId}),
  },
  notify: (payload) => ipcRenderer.send("desktop:notify", payload),
  captureScreen: () => invoke("desktop:screenshot"),
  captureWindow: () => invoke("desktop:window:screenshot"),
  computer: {
    screenshot: () => invoke("computer:screenshot"),
    move: (x,y) => invoke("computer:move", {x,y}),
    click: (payload) => invoke("computer:click", payload),
    scroll: (delta) => invoke("computer:scroll", {delta}),
    type: (text) => invoke("computer:type", {text}),
    key: (key) => invoke("computer:key", {key}),
  },
  zoom: {
    get: () => invoke("desktop:zoom:get"),
    set: (factor) => invoke("desktop:zoom:set", factor),
    reset: () => invoke("desktop:zoom:reset"),
    previewKeys: (open) => ipcRenderer.send("desktop:zoom:preview-keys", Boolean(open)),
  },
  background: {
    get: () => invoke("desktop:background:get"),
    set: (enabled) => invoke("desktop:background:set", enabled),
  },
  updates: {
    get: () => invoke("desktop:update:get"),
    check: () => invoke("desktop:update:check"),
    download: () => invoke("desktop:update:download"),
    install: () => invoke("desktop:update:install"),
    onState: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("desktop:update:state",listener);
      return () => ipcRenderer.removeListener("desktop:update:state",listener);
    },
  },
  snapshots: {
    get: () => invoke("snapshot:get"),
    configure: (config) => invoke("snapshot:configure", config),
    pending: () => invoke("snapshot:pending"),
    read: (id) => invoke("snapshot:read", id),
    ack: (id) => invoke("snapshot:ack", id),
    capture: () => invoke("snapshot:capture"),
    onCaptured: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("snapshot:captured",listener);
      return () => ipcRenderer.removeListener("snapshot:captured",listener);
    },
  },
  browser: {
    navigate: (url) => invoke("browser:navigate", url),
    show: () => invoke("browser:show"),
    state: () => invoke("browser:state"),
    back: () => invoke("browser:history", "back"),
    forward: () => invoke("browser:history", "forward"),
    reload: () => invoke("browser:history", "reload"),
    setViewport: (width,height) => invoke("browser:viewport", {width,height}),
    armRecording: () => invoke("browser:recording:arm"),
    onState: (handler) => {
      const listener=(_event,payload)=>handler(payload);
      ipcRenderer.on("browser:state",listener);
      return () => ipcRenderer.removeListener("browser:state",listener);
    },
    snapshot: () => invoke("browser:snapshot"),
    click: (ref) => invoke("browser:click", ref),
    type: (ref,text) => invoke("browser:type", {ref,text}),
    screenshot: () => invoke("browser:screenshot"),
    runtime: () => invoke("browser:runtime"),
    importCookies: (payload) => invoke("browser:importCookies", payload),
    importSources: () => invoke("browser:importSources"),
    importProfile: (sourceId,profileId) => invoke("browser:importProfile", {sourceId,profileId}),
    close: () => invoke("browser:close"),
  },
});
