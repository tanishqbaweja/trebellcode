import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

let windowRef=null;
let gui=null;

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
  windowRef.once("ready-to-show",()=>windowRef?.show());
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

  app.whenReady().then(createWindow).catch((error)=>{
    console.error(error);
    app.quit();
  });

  app.on("window-all-closed",()=>{
    if(process.platform!=="darwin") app.quit();
  });

  app.on("activate",()=>{
    if(BrowserWindow.getAllWindows().length===0) createWindow();
  });

  app.on("before-quit",()=>{
    gui?.close?.().catch(()=>{});
  });
}
