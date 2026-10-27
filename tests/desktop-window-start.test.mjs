// The desktop app's main window starts once, however often it is asked for while it is on its way. On macOS a click on the Dock icon
// (or reopening the app from Finder) asks for a window whenever none is open (app "activate"), and the first one takes a while to
// come: the login shell's PATH is read (up to 2 s, login-shell-environment.mjs) and the GUI server starts before it is made. A second
// window made then would load the app hidden behind the first (ready-to-show shows the window last made), keep a whole renderer
// running, and leave BrowserWindow.getAllWindows() never empty again, so later Dock clicks would open nothing.
// desktop/main.mjs runs here in a Node process of its own, with Electron, electron-updater, the GUI server and the login shell's read
// replaced by fakes of this test's (module hooks): no Electron, server or shell is started.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAIN=fileURLToPath(new URL("../desktop/main.mjs",import.meta.url));

// Hooks that resolve "electron" and "electron-updater" to the fakes, and the GUI server and login-shell modules main.mjs imports.
const HOOKS=String.raw`
import { registerHooks } from "node:module";
const fakes=JSON.parse(process.env.TREBELL_DESKTOP_FAKES);
globalThis.__desktopFake={home:process.env.TREBELL_HOME,created:[],guiServers:0};
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==="electron")return {url:fakes.electron,format:"module",shortCircuit:true};
  if(specifier==="electron-updater")return {url:fakes.updater,format:"commonjs",shortCircuit:true};
  const resolved=nextResolve(specifier,context);
  if(resolved.url.endsWith("/src/gui-server.mjs"))return {url:fakes.gui,format:"module",shortCircuit:true};
  if(resolved.url.endsWith("/src/login-shell-environment.mjs"))return {url:fakes.loginShell,format:"module",shortCircuit:true};
  return resolved;
}});
`;
// Electron as far as main.mjs's start and its window go. Once the app is ready it plays the person's part: a Dock click while the
// first window is still on its way, then, once the start has settled, closing the window and clicking the Dock icon again. It prints
// what was made: the windows (and whether each was shown) and the GUI servers started.
const ELECTRON=String.raw`
import { EventEmitter } from "node:events";
const fake=globalThis.__desktopFake,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),live=[];let windows=0;
class App extends EventEmitter{
  isPackaged=false;paths={home:fake.home,userData:fake.home};
  setPath(name,value){this.paths[name]=value}getPath(name){return this.paths[name]||fake.home}getVersion(){return "0.0.0-test"}
  requestSingleInstanceLock(){return true}setAppUserModelId(){}getLoginItemSettings(){return {openAtLogin:false}}setLoginItemSettings(){}quit(){}
  whenReady(){return new Promise(resolve=>setImmediate(resolve)).then(()=>{void person()})}
}
export const app=new App();
export class BrowserWindow extends EventEmitter{
  static getAllWindows(){return [...live]}
  constructor(){
    super();this.id=++windows;this.shown=false;this.destroyed=false;this.url=null;live.push(this);fake.created.push(this);
    const contents=new EventEmitter();
    Object.assign(contents,{session:{setDisplayMediaRequestHandler(){}},setWindowOpenHandler(){},send(){},isDestroyed:()=>this.destroyed,getZoomFactor:()=>1,setZoomFactor(){},getURL:()=>this.url||""});
    this.webContents=contents;
  }
  removeMenu(){}isDestroyed(){return this.destroyed}isMinimized(){return false}isMaximized(){return false}isVisible(){return this.shown}isFocused(){return false}
  show(){this.shown=true}hide(){this.shown=false}focus(){}restore(){}minimize(){}maximize(){}unmaximize(){}
  async loadURL(url){this.url=url;setImmediate(()=>{this.webContents.emit("did-navigate");this.emit("ready-to-show")})}
  close(){
    const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};this.emit("close",event);if(event.defaultPrevented)return;
    this.destroyed=true;live.splice(live.indexOf(this),1);this.emit("closed");
  }
}
export const ipcMain={handle(){},on(){}};
export const shell={openExternal:async()=>{}};
export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]})};
export class Notification{static isSupported(){return false}}
export class Tray extends EventEmitter{setToolTip(){}setContextMenu(){}destroy(){}}
export const Menu={buildFromTemplate:template=>template};
export const nativeImage={createFromDataURL:()=>({isEmpty:()=>false,resize(){return this}})};
export const desktopCapturer={getSources:async()=>[]};
export const screen={getPrimaryDisplay:()=>({workAreaSize:{width:1600,height:1000},scaleFactor:1})};
export const clipboard={readText:()=>"",writeText(){}};
export const globalShortcut={register:()=>true,unregister(){}};
const made=()=>({windows:fake.created.length,shown:fake.created.map(item=>item.shown),guiServers:fake.guiServers});
const settled=async()=>{for(let waited=0;waited<10_000;waited+=50){if(fake.created.length&&fake.created.every(item=>item.url))break;await delay(50)}await delay(400)};
async function person(){
  await delay(Number(process.env.TREBELL_FAKE_ACTIVATE_MS));app.emit("activate");
  await settled();const start=made();
  for(const item of [...live])item.close();app.emit("activate");
  await settled();const reopened=made();
  process.stdout.write("RESULT "+JSON.stringify({start,reopened})+"\n");process.exit(0);
}
`;
const UPDATER="module.exports={autoUpdater:{on(){},checkForUpdates:async()=>null}};\n";
const GUI_SERVER=String.raw`
export async function createGuiServer(){globalThis.__desktopFake.guiServers++;await new Promise(resolve=>setTimeout(resolve,50));return {url:"http://127.0.0.1:9/",close:async()=>{}}}
`;
// The login shell's read, which takes TREBELL_FAKE_LOGIN_SHELL_MS, as a slow profile's does.
const LOGIN_SHELL=String.raw`
export async function hydrateLoginShellEnvironment(){await new Promise(resolve=>setTimeout(resolve,Number(process.env.TREBELL_FAKE_LOGIN_SHELL_MS)));return {}}
`;

function runMain(root,{loginShellMs,activateMs}){
  const file=(name,text)=>{const path=join(root,name);writeFileSync(path,text,"utf8");return pathToFileURL(path).href};
  const fakes={electron:file("electron.mjs",ELECTRON),updater:file("electron-updater.cjs",UPDATER),gui:file("gui-server.mjs",GUI_SERVER),loginShell:file("login-shell.mjs",LOGIN_SHELL)};
  const hooks=file("hooks.mjs",HOOKS);
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:root,TMP:root,TMPDIR:root,HOME:root,USERPROFILE:root,
    TREBELL_HOME:root,TREBELL_DESKTOP_FAKES:JSON.stringify(fakes),TREBELL_FAKE_LOGIN_SHELL_MS:String(loginShellMs),TREBELL_FAKE_ACTIVATE_MS:String(activateMs)};
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import",hooks,MAIN],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>{child.kill();reject(new Error("desktop/main.mjs did not finish within 30 s\n"+stderr))},30_000);
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.once("exit",code=>{
      clearTimeout(timer);const line=stdout.split(/\r?\n/).find(item=>item.startsWith("RESULT "));
      if(!line)return reject(new Error(`desktop/main.mjs exited with code ${code} and printed no result\n${stdout}\n${stderr}`));
      resolve(JSON.parse(line.slice("RESULT ".length)));
    });
  });
}

test("a Dock click while the desktop app's first window is still being made opens no second window, and one after it closed opens one",async t=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-desktop-start-"));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  // The login shell's read takes 600 ms, and the Dock is clicked 100 ms after the app is ready.
  const {start,reopened}=await runMain(root,{loginShellMs:600,activateMs:100});
  assert.deepEqual(start,{windows:1,shown:[true],guiServers:1},"one window, shown, on one GUI server");
  assert.deepEqual(reopened,{windows:2,shown:[true,true],guiServers:1},"the window closed, a Dock click opens a new one on the same server");
});
