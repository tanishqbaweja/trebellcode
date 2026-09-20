import { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu, nativeImage, desktopCapturer, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

let windowRef=null;
let gui=null;
let quitting=false;
let agentBrowser=null;
let tray=null;
let backgroundEnabled=false;

const MIN_ZOOM_FACTOR=0.7;
const MAX_ZOOM_FACTOR=2.5;
const ZOOM_STEP=0.1;

function clampZoomFactor(value){
  const numeric=Number(value);
  if(!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_ZOOM_FACTOR,Math.max(MIN_ZOOM_FACTOR,Math.round(numeric*100)/100));
}

function setMainZoomFactor(value,{persist=true}={}){
  const factor=clampZoomFactor(value);
  if(windowRef&&!windowRef.isDestroyed()) windowRef.webContents.setZoomFactor(factor);
  if(persist) saveDesktopPrefs({...loadDesktopPrefs(),zoomFactor:factor});
  return factor;
}

function installMainZoomControls(win){
  const wc=win.webContents;
  wc.on("before-mouse-event",(event,mouse)=>{
    if(mouse.type!=="mouseWheel") return;
    const modifiers=new Set((mouse.modifiers||[]).map(value=>String(value).toLowerCase()));
    if(!modifiers.has("control")&&!modifiers.has("ctrl")&&!modifiers.has("meta")&&!modifiers.has("command")&&!modifiers.has("cmd")) return;
    const deltaY=Number(mouse.deltaY||0);
    const wheelTicksY=Number(mouse.wheelTicksY||0);
    const direction=deltaY!==0 ? Math.sign(deltaY) : -Math.sign(wheelTicksY);
    if(direction===0) return;
    event.preventDefault();
    setMainZoomFactor(wc.getZoomFactor()+(direction<0?ZOOM_STEP:-ZOOM_STEP));
  });
  wc.on("before-input-event",(event,input)=>{
    if(input.type!=="keyDown"||(!input.control&&!input.meta)) return;
    const key=String(input.key||"").toLowerCase();
    if(key==="0"){
      event.preventDefault();
      setMainZoomFactor(1);
    }else if(key==="+"||key==="="){
      event.preventDefault();
      setMainZoomFactor(wc.getZoomFactor()+ZOOM_STEP);
    }else if(key==="-"){
      event.preventDefault();
      setMainZoomFactor(wc.getZoomFactor()-ZOOM_STEP);
    }
  });
}

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
const BACKGROUND_LOGIN_ARGS=["--background"];

function backgroundLoginSettings(){
  if(!app.isPackaged)return {openAtLogin:false,executableWillLaunchAtLogin:false,launchItems:[]};
  return app.getLoginItemSettings({args:BACKGROUND_LOGIN_ARGS});
}

function setBackgroundEnabled(value){
  backgroundEnabled=Boolean(value);
  saveDesktopPrefs({...loadDesktopPrefs(),backgroundEnabled});
  if(app.isPackaged)app.setLoginItemSettings({
    openAtLogin:backgroundEnabled,
    args:BACKGROUND_LOGIN_ARGS,
    enabled:backgroundEnabled,
  });
  if(backgroundEnabled)ensureTray();
  else if(tray){tray.destroy();tray=null}
  return backgroundEnabled;
}

function normalizeBrowserUrl(value){
  const raw=String(value||"").trim();
  if(!raw)throw new Error("URL is required");
  return /^https?:\/\//i.test(raw)?raw:"http://"+raw;
}

function normalizeSameSite(value){
  const clean=String(value||"").trim().toLowerCase().replace(/[ -]+/g,"_");
  if(clean==="strict")return "strict";
  if(clean==="lax")return "lax";
  if(clean==="none"||clean==="no_restriction")return "no_restriction";
  return "unspecified";
}

function normalizeImportedCookie(raw={}){
  const name=String(raw.name||"").trim();
  if(!name)throw new Error("Cookie name is required");
  const domain=String(raw.domain||"").trim().replace(/^\./,"");
  const pathValue=String(raw.path||"/");
  const source=String(raw.url||"").trim()||(domain?((raw.secure?"https":"http")+"://"+domain+(pathValue.startsWith("/")?pathValue:"/"+pathValue)):"");
  if(!source)throw new Error("Cookie needs a url or domain");
  const url=normalizeBrowserUrl(source);
  if(!/^https?:\/\//i.test(url))throw new Error("Only HTTP(S) cookies can be imported");
  const cookie={url,name,value:String(raw.value??"")};
  if(raw.domain)cookie.domain=String(raw.domain);
  if(raw.path)cookie.path=pathValue;
  if(raw.secure!=null)cookie.secure=Boolean(raw.secure);
  if(raw.httpOnly!=null)cookie.httpOnly=Boolean(raw.httpOnly);
  if(raw.sameSite!=null)cookie.sameSite=normalizeSameSite(raw.sameSite);
  const expiration=Number(raw.expirationDate??raw.expires??raw.expiration);
  if(Number.isFinite(expiration)&&expiration>0)cookie.expirationDate=expiration>1e12?expiration/1000:expiration;
  return cookie;
}

async function importBrowserCookies(payload={}){
  let cookies=Array.isArray(payload?.cookies)?payload.cookies:null;
  let source="provided";
  if(!cookies){
    const picked=await dialog.showOpenDialog(windowRef,{title:"Import cookies into Trebell Agent Browser",properties:["openFile"],filters:[{name:"Cookie JSON",extensions:["json"]},{name:"All files",extensions:["*"]}]});
    if(picked.canceled||!picked.filePaths[0])return {ok:false,canceled:true,imported:0,failed:0,errors:[]};
    const parsed=JSON.parse(readFileSync(picked.filePaths[0],"utf8"));
    cookies=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.cookies)?parsed.cookies:null);
    source="file";
  }
  if(!Array.isArray(cookies))throw new Error("Cookie JSON must be an array or an object with a cookies array.");
  const browser=await ensureAgentBrowser();
  let imported=0;
  const errors=[];
  for(const raw of cookies.slice(0,5000)){
    try{await browser.webContents.session.cookies.set(normalizeImportedCookie(raw));imported++}
    catch(error){errors.push(String(error?.message||error))}
  }
  return {ok:true,canceled:false,source,imported,failed:errors.length,errors:errors.slice(0,10)};
}

async function ensureAgentBrowser({show=false}={}){
  if(agentBrowser&&!agentBrowser.isDestroyed()){
    if(show){agentBrowser.show();agentBrowser.focus();}
    return agentBrowser;
  }
  agentBrowser=new BrowserWindow({
    width:1280,height:860,show,title:"Trebell Agent Browser",
    backgroundColor:"#0a0d14",autoHideMenuBar:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:"persist:trebell-agent-browser"},
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

async function desktopScreenshot(){
  const display=screen.getPrimaryDisplay();
  const scale=Math.max(1,Number(display.scaleFactor)||1);
  const width=Math.max(1,Math.round(display.size.width*scale));
  const height=Math.max(1,Math.round(display.size.height*scale));
  const sources=await desktopCapturer.getSources({types:["screen"],thumbnailSize:{width,height}});
  const source=sources.find(item=>String(item.display_id)===String(display.id))||sources[0];
  if(!source||source.thumbnail.isEmpty())throw new Error("Desktop screenshot is unavailable.");
  return {
    dataUrl:"data:image/png;base64,"+source.thumbnail.toPNG().toString("base64"),
    width:source.thumbnail.getSize().width,
    height:source.thumbnail.getSize().height,
    displayId:String(display.id),
  };
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
  installMainZoomControls(windowRef);
  windowRef.webContents.setWindowOpenHandler(({url})=>{
    shell.openExternal(url);
    return {action:"deny"};
  });
  await windowRef.loadURL(gui.url);
  setMainZoomFactor(loadDesktopPrefs().zoomFactor||1,{persist:false});
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
  ipcMain.handle("desktop:background:get",()=>({enabled:backgroundEnabled,...backgroundLoginSettings()}));
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
  ipcMain.handle("desktop:screenshot",async()=>desktopScreenshot());
  ipcMain.handle("desktop:zoom:get",()=>({factor:windowRef?.webContents?.getZoomFactor?.()||1}));
  ipcMain.handle("desktop:zoom:set",(_event,value)=>({factor:setMainZoomFactor(value)}));
  ipcMain.handle("desktop:zoom:reset",()=>({factor:setMainZoomFactor(1)}));
  ipcMain.handle("browser:importCookies",async(_event,payload)=>importBrowserCookies(payload));
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
