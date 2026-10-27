// Trebell's server gives each address of a host at least a second to connect (src/connect-attempt-timeout.mjs), not Node's 250 ms:
// where IPv6 is offered but does not route, the 250 ms gave up on a slow but working IPv4 connect, and reading the ACP registry or
// downloading Antigravity failed. It is set once as the server starts, from the command line (node src/gui-server.mjs) and in the
// desktop app (desktop/main.mjs), and a longer --network-family-autoselection-attempt-timeout given to Node stays. Each server here
// runs in a Node process of its own, as it is started; the desktop app with Electron, its updater, the GUI server and the login
// shell's read replaced by fakes (as desktop-window-start.test.mjs runs it).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freePort, isolatedEnv } from "../scripts/perf/lib/server.mjs";
import { CONNECT_ATTEMPT_TIMEOUT_MS, extendConnectAttemptTimeout } from "../src/connect-attempt-timeout.mjs";

const SERVER=fileURLToPath(new URL("../src/gui-server.mjs",import.meta.url)),DESKTOP=fileURLToPath(new URL("../desktop/main.mjs",import.meta.url));
const LONGER="--network-family-autoselection-attempt-timeout=5000";

// Preloaded into the GUI server: once it says it runs, it prints how long Node gives each address to connect.
const SERVER_PROBE=String.raw`
import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
const log=console.log.bind(console);
console.log=(...args)=>{log(...args);if(String(args[0]).startsWith("Trebell Code GUI running at"))log("ATTEMPT "+getDefaultAutoSelectFamilyAttemptTimeout())};
`;
// desktop/main.mjs's Electron, updater, GUI server and login shell: the GUI server, as the app starts it, prints how long Node gives
// each address to connect and ends the process.
const DESKTOP_HOOKS=String.raw`
import { registerHooks } from "node:module";
const fakes=JSON.parse(process.env.TREBELL_DESKTOP_FAKES);
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==="electron")return {url:fakes.electron,format:"module",shortCircuit:true};
  if(specifier==="electron-updater")return {url:fakes.updater,format:"commonjs",shortCircuit:true};
  const resolved=nextResolve(specifier,context);
  if(resolved.url.endsWith("/src/gui-server.mjs"))return {url:fakes.gui,format:"module",shortCircuit:true};
  if(resolved.url.endsWith("/src/login-shell-environment.mjs"))return {url:fakes.loginShell,format:"module",shortCircuit:true};
  return resolved;
}});
`;
const ELECTRON=String.raw`
import { EventEmitter } from "node:events";
class App extends EventEmitter{
  isPackaged=false;paths={home:process.env.TREBELL_HOME,userData:process.env.TREBELL_HOME};
  setPath(name,value){this.paths[name]=value}getPath(name){return this.paths[name]||process.env.TREBELL_HOME}getVersion(){return "0.0.0-test"}
  requestSingleInstanceLock(){return true}setAppUserModelId(){}getLoginItemSettings(){return {openAtLogin:false}}setLoginItemSettings(){}quit(){}
  whenReady(){return new Promise(resolve=>setImmediate(resolve))}
}
export const app=new App();
export class BrowserWindow extends EventEmitter{
  static getAllWindows(){return []}
  constructor(){super();const contents=new EventEmitter();Object.assign(contents,{session:{setDisplayMediaRequestHandler(){}},setWindowOpenHandler(){},send(){},isDestroyed:()=>false,getZoomFactor:()=>1,setZoomFactor(){},getURL:()=>""});this.webContents=contents}
  removeMenu(){}isDestroyed(){return false}isMinimized(){return false}isMaximized(){return false}isVisible(){return false}isFocused(){return false}
  show(){}hide(){}focus(){}restore(){}minimize(){}maximize(){}unmaximize(){}close(){}async loadURL(){}
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
`;
const UPDATER="module.exports={autoUpdater:{on(){},checkForUpdates:async()=>null}};\n";
const GUI_SERVER=String.raw`
import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
export async function createGuiServer(){process.stdout.write("ATTEMPT "+getDefaultAutoSelectFamilyAttemptTimeout()+"\n",()=>process.exit(0));return new Promise(()=>{})}
`;
const LOGIN_SHELL="export async function hydrateLoginShellEnvironment(){return {}}\n";

// A folder of the test's own, removed once the process started in it has stopped (Windows keeps a running process's folder busy).
async function runFolder(t,processes){
  const root=await mkdtemp(join(tmpdir(),"trebell-connect-attempt-"));
  t.after(async()=>{for(const child of processes)await stopTree(child);await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  return root;
}
async function stopTree(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once("exit",resolve));
  if(process.platform==="win32")await new Promise(resolve=>{const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",resolve);killer.once("error",resolve)});
  else child.kill("SIGTERM");
  await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,10_000))]);
}
// The "ATTEMPT <ms>" line the started process prints, within a minute.
function attemptLine(child,what){
  return new Promise((resolve,reject)=>{
    let stdout="",stderr="";
    const timer=setTimeout(()=>reject(new Error(`${what} printed no connect attempt timeout within 60 s\n${stdout}\n${stderr.slice(-4000)}`)),60_000);
    child.stdout.on("data",chunk=>{stdout+=chunk;const found=/^ATTEMPT (\d+)\s*$/m.exec(stdout);if(found){clearTimeout(timer);resolve(Number(found[1]))}});
    child.stderr.on("data",chunk=>{stderr+=chunk});
    child.once("exit",code=>{clearTimeout(timer);const found=/^ATTEMPT (\d+)\s*$/m.exec(stdout);if(found)resolve(Number(found[1]));else reject(new Error(`${what} exited with code ${code} before it printed its connect attempt timeout\n${stdout}\n${stderr.slice(-4000)}`))});
  });
}

// The GUI server as `node src/gui-server.mjs` starts it (mock, offline, in a home of its own), with nodeArgs given to Node.
async function guiServerAttempt(t,nodeArgs=[]){
  const processes=[],root=await runFolder(t,processes),probe=join(root,"probe.mjs");await writeFile(probe,SERVER_PROBE,"utf8");
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const env=isolatedEnv({home:join(root,"home"),runDir:root,extra:{TREBELL_GUI_MOCK:"1",TREBELL_E2E_OFFLINE:"1"}});delete env.OPENAI_API_KEY;
  const server=spawn(process.execPath,[...nodeArgs,"--import",pathToFileURL(probe).href,SERVER,"--port",String(port),"--app-port",String(appPort)],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  processes.push(server);
  return attemptLine(server,"node src/gui-server.mjs");
}
// The desktop app's main process as Electron starts it, with nodeArgs given to Node.
async function desktopAttempt(t,nodeArgs=[]){
  const processes=[],root=await runFolder(t,processes),file=async(name,text)=>{const path=join(root,name);await writeFile(path,text,"utf8");return pathToFileURL(path).href};
  const fakes={electron:await file("electron.mjs",ELECTRON),updater:await file("electron-updater.cjs",UPDATER),gui:await file("gui-server.mjs",GUI_SERVER),loginShell:await file("login-shell.mjs",LOGIN_SHELL)};
  const hooks=await file("hooks.mjs",DESKTOP_HOOKS);
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:root,TMP:root,TMPDIR:root,HOME:root,USERPROFILE:root,TREBELL_HOME:root,TREBELL_DESKTOP_FAKES:JSON.stringify(fakes)};
  const desktop=spawn(process.execPath,[...nodeArgs,"--import",hooks,DESKTOP],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  processes.push(desktop);
  return attemptLine(desktop,"desktop/main.mjs");
}

test("Node's 250 ms per address becomes a second, and a longer wait stays",()=>{
  assert.equal(CONNECT_ATTEMPT_TIMEOUT_MS,1000);
  const before=getDefaultAutoSelectFamilyAttemptTimeout();
  try{
    setDefaultAutoSelectFamilyAttemptTimeout(250);extendConnectAttemptTimeout();
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(),1000,"250 ms becomes a second");
    setDefaultAutoSelectFamilyAttemptTimeout(5000);extendConnectAttemptTimeout();
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(),5000,"a longer wait stays");
  }finally{setDefaultAutoSelectFamilyAttemptTimeout(before)}
});

test("the GUI server started from the command line gives each address at least a second to connect",{timeout:120_000},async t=>{
  assert.equal(await guiServerAttempt(t),1000);
});

test("the GUI server started with a longer --network-family-autoselection-attempt-timeout keeps it",{timeout:120_000},async t=>{
  assert.equal(await guiServerAttempt(t,[LONGER]),5000);
});

test("the desktop app gives each address at least a second to connect by the time it starts its GUI server",{timeout:120_000},async t=>{
  assert.equal(await desktopAttempt(t),1000);
});

test("the desktop app started with a longer --network-family-autoselection-attempt-timeout keeps it",{timeout:120_000},async t=>{
  assert.equal(await desktopAttempt(t,[LONGER]),5000);
});
