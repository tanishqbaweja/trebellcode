import { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu, nativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

let windowRef=null;
let gui=null;
let quitting=false;
let agentBrowser=null;
let tray=null;
let backgroundEnabled=false;

function nativeCodexPath(){
  if(!app.isPackaged) return null;
  const root=join(process.resourcesPath,"app.asar.unpacked","node_modules","@openai");
  const packageName=process.arch==="arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple=process.arch==="arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const vendor=join(root,packageName,"vendor",triple);
  const candidates=[
    join(vendor,"bin","codex.exe"),
    join(vendor,"codex","codex.exe"),
  ];
  return candidates.find(existsSync) || candidates[0];
}

function bundledBridgePath(){
  if(!app.isPackaged) return null;
  return join(process.resourcesPath,"app.asar.unpacked","vendor","freebuff2api","dist","index.mjs");
}

function configureBundledRuntime(){
  if(!app.isPackaged) return;
  const codex=nativeCodexPath();
  const bridge=bundledBridgePath();
  if(!existsSync(codex)) throw new Error(`Bundled Codex harness is missing: ${codex}`);
  if(!existsSync(bridge)) throw new Error(`Bundled Freebuff bridge is missing: ${bridge}`);
  process.env.TREBELL_CODEX_BIN=codex;
  process.env.TREBELL_FREEBUFF_ENTRYPOINT=bridge;
  process.env.TREBELL_ELECTRON_AS_NODE="1";
}



function desktopPrefsPath(){return join(app.getPath("userData"),"desktop-prefs.json")}
function loadDesktopPrefs(){
  try{return JSON.parse(readFileSync(desktopPrefsPath(),"utf8"))}catch{return{}}
}
function saveDesktopPrefs(prefs){
  try{writeFileSync(desktopPrefsPath(),JSON.stringify(prefs,null,2),"utf8")}catch{}
}
function trayIcon(){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="8" width="32" height="32" fill="#17111f"/><path d="M8 9h16v4h-6v11h-4V13H8z" fill="#a66cff"/></svg>';
  const image=nativeImage.createFromDataURL("data:image/svg+xml;base64,"+Buffer.from(svg).toString("base64"));
  return image.resize({width:16,height:16});
}
function ensureTray(){
  if(tray)return tray;
  tray=new Tray(trayIcon());
  tray.setToolTip("Trebell Code");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:"Show Trebell Code",click:()=>{windowRef?.show();windowRef?.focus()}},
    {label:"Open Agent Browser",click:()=>ensureAgentBrowser({show:true})},
    {type:"separator"},
    {label:"Quit Trebell Code",click:()=>{quitting=true;app.quit()}},
  ]));
  tray.on("double-click",()=>{windowRef?.show();windowRef?.focus()});
  return tray;
}
function setBackgroundEnabled(value){
  backgroundEnabled=Boolean(value);
  saveDesktopPrefs({...loadDesktopPrefs(),backgroundEnabled});
  if(app.isPackaged)app.setLoginItemSettings({openAtLogin:backgroundEnabled,args:backgroundEnabled?["--background"]:[]});
  if(backgroundEnabled)ensureTray();
  else if(tray){tray.destroy();tray=null}
  return backgroundEnabled;
}

function normalizeBrowserUrl(value){
  const raw=String(value||"").trim();
  if(!raw)throw new Error("URL is required");
  return /^https?:\/\//i.test(raw)?raw:"http://"+raw;
}

async function ensureAgentBrowser({show=false}={}){
  if(agentBrowser&&!agentBrowser.isDestroyed()){
    if(show){agentBrowser.show();agentBrowser.focus();}
    return agentBrowser;
  }
  agentBrowser=new BrowserWindow({
    width:1280,height:860,show,title:"Trebell Agent Browser",
    backgroundColor:"#0a0d14",autoHideMenuBar:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true},
  });
  agentBrowser.removeMenu();
  agentBrowser.webContents.setWindowOpenHandler(({url})=>{
    agentBrowser.loadURL(url).catch(()=>{});
    return {action:"deny"};
  });
  agentBrowser.on("closed",()=>{agentBrowser=null;});
  return agentBrowser;
}

async function browserSnapshot(){
  const browser=await ensureAgentBrowser();
  const script='(() => {'+
    'const visible=(el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";};'+
    'const nodes=[...document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]")].filter(visible).slice(0,220);'+
    'const elements=nodes.map((el,index)=>{const ref="e"+(index+1);el.setAttribute("data-trebell-ref",ref);return {ref,tag:el.tagName.toLowerCase(),type:el.getAttribute("type"),role:el.getAttribute("role"),text:(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.value||"").trim().slice(0,300),href:el.href||null,name:el.getAttribute("name"),disabled:Boolean(el.disabled)};});'+
    'return {url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,24000),elements};'+
  '})()';
  return await browser.webContents.executeJavaScript(script,true);
}

async function browserClick(ref){
  const browser=await ensureAgentBrowser();
  const script='(() => {const ref='+JSON.stringify(String(ref||""))+';const el=[...document.querySelectorAll("[data-trebell-ref]")].find(x=>x.getAttribute("data-trebell-ref")===ref);if(!el)return {ok:false,error:"element_not_found"};el.scrollIntoView({block:"center",inline:"center"});el.focus?.();el.click();return {ok:true,url:location.href};})()';
  return await browser.webContents.executeJavaScript(script,true);
}

async function browserType(ref,text){
  const browser=await ensureAgentBrowser();
  const script='(() => {const ref='+JSON.stringify(String(ref||""))+';const value='+JSON.stringify(String(text||""))+';const el=[...document.querySelectorAll("[data-trebell-ref]")].find(x=>x.getAttribute("data-trebell-ref")===ref);if(!el)return {ok:false,error:"element_not_found"};el.scrollIntoView({block:"center"});el.focus?.();if("value" in el)el.value=value;else el.textContent=value;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,value};})()';
  return await browser.webContents.executeJavaScript(script,true);
}

async function browserScreenshot(){
  const browser=await ensureAgentBrowser();
  const image=await browser.webContents.capturePage();
  return {dataUrl:"data:image/png;base64,"+image.toPNG().toString("base64"),url:browser.webContents.getURL(),title:browser.webContents.getTitle()};
}

async function createWindow(){
  configureBundledRuntime();
  try{ process.chdir(app.getPath("home")); }catch{}

  const port=Number(process.env.TREBELL_GUI_PORT || 3210);
  const appPort=Number(process.env.TREBELL_APP_SERVER_PORT || 23456);
  const mock=process.env.TREBELL_GUI_MOCK==="1";
  gui=await createGuiServer({port,appPort,mock,env:process.env});

  windowRef=new BrowserWindow({
    width:1600,
    height:980,
    minWidth:1180,
    minHeight:720,
    frame:false,
    show:false,
    backgroundColor:"#080a11",
    autoHideMenuBar:true,
    webPreferences:{
      preload:join(import.meta.dirname,"preload.cjs"),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
    },
  });

  windowRef.removeMenu();
  windowRef.webContents.setWindowOpenHandler(({url})=>{
    shell.openExternal(url);
    return {action:"deny"};
  });
  await windowRef.loadURL(gui.url);
  windowRef.once("ready-to-show",()=>{
    if(process.argv.includes("--background")&&backgroundEnabled){ensureTray();return}
    windowRef?.show();
  });
  windowRef.on("close",(event)=>{
    if(backgroundEnabled&&!quitting){event.preventDefault();windowRef?.hide();ensureTray()}
  });
  windowRef.on("closed",()=>{windowRef=null;});
}

const lock=app.requestSingleInstanceLock();
if(!lock){
  app.quit();
}else{
  app.on("second-instance",()=>{
    if(windowRef){
      if(windowRef.isMinimized()) windowRef.restore();
      windowRef.focus();
    }
  });

  ipcMain.on("window:minimize",()=>windowRef?.minimize());
  ipcMain.on("window:maximize",()=>{
    if(!windowRef) return;
    windowRef.isMaximized() ? windowRef.unmaximize() : windowRef.maximize();
  });
  ipcMain.on("window:close",()=>windowRef?.close());
  ipcMain.handle("desktop:background:get",()=>({enabled:backgroundEnabled,openAtLogin:app.getLoginItemSettings().openAtLogin}));
  ipcMain.handle("desktop:background:set",(_event,value)=>({enabled:setBackgroundEnabled(value)}));
  ipcMain.on("desktop:notify",(_event,payload={})=>{
    if(!Notification.isSupported()) return;
    const title=String(payload.title||"Trebell Code").slice(0,120);
    const body=String(payload.body||"").slice(0,600);
    const notification=new Notification({title,body,silent:Boolean(payload.silent)});
    notification.on("click",()=>{
      if(!windowRef) return;
      if(windowRef.isMinimized()) windowRef.restore();
      windowRef.show();
      windowRef.focus();
    });
    notification.show();
  });
  ipcMain.handle("workspace:pickDirectory",async()=>{
    const result=await dialog.showOpenDialog(windowRef,{properties:["openDirectory","createDirectory"]});
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("workspace:pickFiles",async()=>{
    const result=await dialog.showOpenDialog(windowRef,{properties:["openFile","multiSelections"]});
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("browser:navigate",async(_event,url)=>{
    const browser=await ensureAgentBrowser();
    await browser.loadURL(normalizeBrowserUrl(url));
    return {ok:true,url:browser.webContents.getURL(),title:browser.webContents.getTitle()};
  });
  ipcMain.handle("browser:show",async()=>{
    const browser=await ensureAgentBrowser({show:true});
    return {ok:true,url:browser.webContents.getURL(),title:browser.webContents.getTitle()};
  });
  ipcMain.handle("browser:snapshot",async()=>browserSnapshot());
  ipcMain.handle("browser:click",async(_event,ref)=>browserClick(ref));
  ipcMain.handle("browser:type",async(_event,payload)=>browserType(payload?.ref,payload?.text));
  ipcMain.handle("browser:screenshot",async()=>browserScreenshot());
  ipcMain.handle("browser:close",async()=>{if(agentBrowser&&!agentBrowser.isDestroyed())agentBrowser.close();agentBrowser=null;return {ok:true};});

  app.whenReady().then(async()=>{
    backgroundEnabled=Boolean(loadDesktopPrefs().backgroundEnabled);
    if(backgroundEnabled)ensureTray();
    await createWindow();
  }).catch((error)=>{
    console.error(error);
    app.quit();
  });

  app.on("window-all-closed",()=>{
    if(process.platform!=="darwin") app.quit();
  });

  app.on("activate",()=>{
    if(BrowserWindow.getAllWindows().length===0) createWindow();
  });

  app.on("before-quit",(event)=>{
    if(quitting) return;
    event.preventDefault();
    quitting=true;
    try{if(agentBrowser&&!agentBrowser.isDestroyed())agentBrowser.destroy()}catch{}
    try{tray?.destroy();tray=null}catch{}
    Promise.resolve(gui?.close?.())
      .catch(()=>{})
      .finally(()=>app.quit());
  });
}
