import { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu, nativeImage, desktopCapturer, screen, clipboard } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
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
  wc.on("zoom-changed",(event,direction)=>{
    event.preventDefault();
    const delta=direction==="in"?ZOOM_STEP:-ZOOM_STEP;
    setMainZoomFactor(wc.getZoomFactor()+delta);
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
let brandIconCache=null;
function brandIconDataUrl(){
  const root=join(import.meta.dirname,"..","branding");
  const encoded=[1,2,3,4].map(index=>readFileSync(join(root,`icon.part${index}.b64`),"utf8").trim()).join("");
  return "data:image/png;base64,"+encoded;
}
function appIcon(){
  if(brandIconCache&&!brandIconCache.isEmpty())return brandIconCache;
  const image=nativeImage.createFromDataURL(brandIconDataUrl());
  if(image.isEmpty())throw new Error("Bundled Trebell Code icon is invalid.");
  brandIconCache=image;
  return image;
}
function trayIcon(){
  return appIcon().resize({width:16,height:16});
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
    icon:appIcon(),
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
    originX:display.bounds.x,
    originY:display.bounds.y,
    scaleFactor:scale,
  };
}

function powershell(script,{timeout=10000}={}){
  if(process.platform!=="win32")return Promise.reject(new Error("Computer use is currently available on Windows only."));
  const encoded=Buffer.from(String(script),"utf16le").toString("base64");
  return new Promise((resolve,reject)=>{
    execFile("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand",encoded],{windowsHide:true,timeout},(error,stdout,stderr)=>{
      if(error){reject(new Error(String(stderr||error.message||error).trim()));return}
      resolve(String(stdout||"").trim());
    });
  });
}

function primaryComputerPoint(x,y){
  const display=screen.getPrimaryDisplay();
  const scale=Math.max(1,Number(display.scaleFactor)||1);
  const pixelWidth=Math.max(1,Math.round(display.size.width*scale));
  const pixelHeight=Math.max(1,Math.round(display.size.height*scale));
  const px=Math.min(pixelWidth-1,Math.max(0,Math.round(Number(x)||0)));
  const py=Math.min(pixelHeight-1,Math.max(0,Math.round(Number(y)||0)));
  return {
    x:Math.round(display.bounds.x+px/scale),
    y:Math.round(display.bounds.y+py/scale),
    pixelX:px,
    pixelY:py,
    scaleFactor:scale,
    displayId:String(display.id),
  };
}

const COMPUTER_INPUT_TYPE=String.raw`
using System;
using System.Runtime.InteropServices;
public static class TrebellInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
`;

async function computerMove(x,y){
  const point=primaryComputerPoint(x,y);
  await powershell(`Add-Type -TypeDefinition @'
${COMPUTER_INPUT_TYPE}
'@
[TrebellInput]::SetCursorPos(${point.x},${point.y}) | Out-Null`);
  return {ok:true,...point};
}

async function computerClick(payload={}){
  const point=primaryComputerPoint(payload.x,payload.y);
  const button=String(payload.button||"left").toLowerCase();
  const count=Math.min(3,Math.max(1,Math.round(Number(payload.count)||1)));
  const flags=button==="right"?[0x0008,0x0010]:button==="middle"?[0x0020,0x0040]:[0x0002,0x0004];
  await powershell(`Add-Type -TypeDefinition @'
${COMPUTER_INPUT_TYPE}
'@
[TrebellInput]::SetCursorPos(${point.x},${point.y}) | Out-Null
1..${count} | ForEach-Object {
  [TrebellInput]::mouse_event(${flags[0]},0,0,0,[UIntPtr]::Zero)
  [TrebellInput]::mouse_event(${flags[1]},0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
}`);
  return {ok:true,button,count,...point};
}

async function computerScroll(delta){
  const amount=Math.max(-12000,Math.min(12000,Math.round(Number(delta)||0)));
  await powershell(`Add-Type -TypeDefinition @'
${COMPUTER_INPUT_TYPE}
'@
[TrebellInput]::mouse_event(0x0800,0,0,${amount},[UIntPtr]::Zero)`);
  return {ok:true,delta:amount};
}

const SEND_KEY_MAP=Object.freeze({
  ENTER:"{ENTER}",TAB:"{TAB}",ESC:"{ESC}",ESCAPE:"{ESC}",SPACE:" ",
  UP:"{UP}",DOWN:"{DOWN}",LEFT:"{LEFT}",RIGHT:"{RIGHT}",
  HOME:"{HOME}",END:"{END}",PAGEUP:"{PGUP}",PAGEDOWN:"{PGDN}",
  BACKSPACE:"{BACKSPACE}",DELETE:"{DELETE}",
  "CTRL+A":"^a","CTRL+C":"^c","CTRL+V":"^v","CTRL+X":"^x","CTRL+Z":"^z","CTRL+Y":"^y",
  "CTRL+S":"^s","CTRL+F":"^f","CTRL+L":"^l","ALT+TAB":"%{TAB}","ALT+F4":"%{F4}",
});

async function computerKey(value){
  const key=String(value||"").trim().toUpperCase();
  const sequence=SEND_KEY_MAP[key];
  if(!sequence)throw new Error("Unsupported computer key: "+key);
  const escaped=sequence.replace(/'/g,"''");
  await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
  return {ok:true,key};
}

async function computerType(text){
  const value=String(text??"");
  const previous=clipboard.readText();
  clipboard.writeText(value);
  try{
    await computerKey("CTRL+V");
  }finally{
    setTimeout(()=>{try{if(clipboard.readText()===value)clipboard.writeText(previous)}catch{}},120);
  }
  return {ok:true,length:value.length};
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
    icon:appIcon(),
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
    const notification=new Notification({title,body,silent:Boolean(payload.silent),icon:appIcon()});
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
  ipcMain.handle("computer:screenshot",async()=>desktopScreenshot());
  ipcMain.handle("computer:move",async(_event,payload={})=>computerMove(payload.x,payload.y));
  ipcMain.handle("computer:click",async(_event,payload={})=>computerClick(payload));
  ipcMain.handle("computer:scroll",async(_event,payload={})=>computerScroll(payload.delta));
  ipcMain.handle("computer:type",async(_event,payload={})=>computerType(payload.text));
  ipcMain.handle("computer:key",async(_event,payload={})=>computerKey(payload.key));
  ipcMain.handle("desktop:zoom:get",()=>({factor:windowRef?.webContents?.getZoomFactor?.()||1}));
  ipcMain.handle("desktop:zoom:set",(_event,value)=>({factor:setMainZoomFactor(value)}));
  ipcMain.handle("desktop:zoom:reset",()=>({factor:setMainZoomFactor(1)}));
  ipcMain.handle("browser:importCookies",async(_event,payload)=>importBrowserCookies(payload));
  ipcMain.handle("browser:close",async()=>{if(agentBrowser&&!agentBrowser.isDestroyed())agentBrowser.close();agentBrowser=null;return {ok:true};});

  app.whenReady().then(async()=>{
    if(process.platform==="win32")app.setAppUserModelId("com.trebell.code");
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
