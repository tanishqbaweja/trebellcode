import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const packageRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const electronPath=createRequire(import.meta.url)("electron");

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
async function freePort(){const server=createServer();const port=await listen(server);await new Promise(resolve=>server.close(resolve));return port}
async function waitForExit(child,timeoutMs=3000){
  if(child.exitCode!=null)return;
  await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,timeoutMs))]);
}
async function closeElectronApp(app){
  if(!app)return;
  const child=app.process(),closing=app.close().catch(()=>{});await Promise.race([closing,new Promise(resolve=>setTimeout(resolve,3000))]);
  if(child.exitCode==null){
    if(process.platform==="win32")spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
    else child.kill("SIGKILL");
    await waitForExit(child);
  }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// What locator says once it has stopped changing, as a person reads it: a message the shell sends can be followed at once by another.
async function settledText(locator){
  let last="";for(let same=0,i=0;same<3&&i<80;i++){await sleep(250);const now=(await locator.innerText({timeout:1000}).catch(()=>"")).replace(/\s+/g," ").trim();same=now&&now===last?same+1:0;last=now}
  return last;
}

// One hidden launch checks the desktop shell's guards and its notification, file-manager, second-launch and quit paths, each as
// its own subtest. Nothing is shown: show and focus are stubbed where a path would call them, and the tray's Quit is reached
// without a tray icon.
test("the desktop shell keeps its window and bridge to the app, and its notification, file-manager, second-launch and quit paths do what they say",{timeout:180_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-shell-guards-"));
  const fixture=createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><title>Elsewhere</title><main>elsewhere</main>")});
  const fixturePort=await listen(fixture),guiPort=await freePort(),appPort=await freePort();let app=null;
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const elsewhere=`http://127.0.0.1:${fixturePort}/`;
  try{
    app=await electron.launch({args:[packageRoot],env});
    const window=await app.firstWindow();await window.waitForLoadState("domcontentloaded");
    const origin=new URL(window.url()).origin;
    assert.equal(origin,`http://127.0.0.1:${guiPort}`,"the window shows the app");
    const stubMainWindow=source=>app.evaluate(({BrowserWindow},{origin,source})=>{
      const main=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin));
      new Function("main",source)(main);
    },{origin,source});

    // (First, because Playwright waits on a navigation the window refused before its next click.)
    await t.test("a new window opens only a web or mail link, in the default browser",async()=>{
      await app.evaluate(({shell})=>{globalThis.__opened=[];shell.openExternal=async url=>{globalThis.__opened.push(url)}});
      await window.evaluate(()=>{const button=document.createElement("button");button.id="guard-open";button.textContent="open";button.style.cssText="position:fixed;left:0;top:0;z-index:2147483647";button.onclick=()=>window.open(button.dataset.url,"_blank");document.body.append(button)});
      for(const url of ["file:///C:/Windows/System32/calc.exe","ms-msdt:/id PCWDiagnostic",elsewhere+"web-link"]){
        await window.evaluate(url=>{document.getElementById("guard-open").dataset.url=url},url);
        await window.click("#guard-open");await sleep(300);
      }
      await window.evaluate(()=>document.getElementById("guard-open")?.remove());
      assert.deepEqual(await app.evaluate(()=>globalThis.__opened),[elsewhere+"web-link"]);
    });

    await t.test("the window refuses to leave the app, so its bridge stays with the app",async()=>{
      try{
        for(const target of [elsewhere,"file:///C:/Windows/win.ini"]){
          await window.evaluate(url=>{location.href=url},target).catch(()=>{});
          await sleep(1200);
          assert.equal(new URL(window.url()).origin,origin,`still the app after a navigation to ${target}`);
        }
      }finally{if(new URL(window.url()).origin!==origin)await window.goto(origin+"/")}
    });

    await t.test("the bridge answers the app's own page and refuses another page that carries the preload",async()=>{
      assert.ok(await window.evaluate(()=>window.trebellDesktop.zoom.get()),"the app's own page is answered");
      const foreign=await app.evaluate(async({BrowserWindow},{preload,url})=>{
        const other=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
        try{
          await other.loadURL(url);
          return await other.webContents.executeJavaScript("window.trebellDesktop.zoom.get().then(()=>'answered',error=>'refused: '+error.message)");
        }finally{other.destroy()}
      },{preload:join(packageRoot,"desktop","preload.cjs"),url:elsewhere+"with-preload"});
      assert.match(foreign,/^refused: .*only available to Trebell Code itself/,foreign);
    });

    await t.test("no notification while the app window is in front, one when it is not",async()=>{
      await app.evaluate(({Notification})=>{globalThis.__shown=0;Notification.isSupported=()=>true;Notification.prototype.show=function(){globalThis.__shown++}});
      await stubMainWindow("globalThis.__focused=true;main.isVisible=()=>true;main.isFocused=()=>globalThis.__focused;");
      await window.evaluate(()=>window.trebellDesktop.notify({title:"Trebell Code finished",body:"focused"}));await sleep(500);
      assert.equal(await app.evaluate(()=>globalThis.__shown),0,"none while the window is focused");
      await app.evaluate(()=>{globalThis.__focused=false});
      await window.evaluate(()=>window.trebellDesktop.notify({title:"Trebell Code finished",body:"in the background"}));await sleep(500);
      assert.equal(await app.evaluate(()=>globalThis.__shown),1,"one when it is not");
    });

    await t.test("Open in File Explorer reports a folder that did not open",async()=>{
      await app.evaluate(({shell})=>{shell.openPath=async()=>"Access is denied."});
      const opened=await window.evaluate(path=>window.trebellDesktop.openIn.open(path,"file-manager").then(()=>"ok",error=>"refused: "+error.message),home);
      assert.equal(opened,"refused: Could not open the folder: Access is denied.","the shell's own words, without Electron's \"Error invoking remote method\" before them");
    });

    await t.test("a second launch shows the window, also one hidden in the tray",async()=>{
      await stubMainWindow("globalThis.__windowCalls=[];main.isMinimized=()=>false;main.show=()=>globalThis.__windowCalls.push('show');main.focus=()=>globalThis.__windowCalls.push('focus');");
      const second=spawn(electronPath,[packageRoot],{env,windowsHide:true,stdio:"ignore"});
      await waitForExit(second,30_000);
      assert.notEqual(second.exitCode,null,"the second launch exits");
      for(let i=0;i<20&&!(await app.evaluate(()=>globalThis.__windowCalls.length));i++)await sleep(250);
      assert.deepEqual(await app.evaluate(()=>globalThis.__windowCalls),["show","focus"]);
    });

    // The preview's zoom keys are the window's: the shell zooms the window with them, unless the page says its preview is open,
    // when they go to the page (which zooms the preview). The page's own shortcut handling is held off here (the keys are recorded
    // and stopped before it), so only the shell's part is measured.
    await t.test("Ctrl+= and Ctrl+0 zoom the window, and go to the page while it says its preview is open",async()=>{
      // Each key goes in through the window's input, as a key pressed there does (a key event made up in the page never reaches the shell).
      const press=code=>app.evaluate(({BrowserWindow},{origin,code})=>{const main=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin));for(const type of ["keyDown","keyUp"])main.webContents.sendInputEvent({type,keyCode:code,modifiers:["control"]})},{origin,code});
      const zoom=async()=>Math.round(await app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin)).webContents.getZoomFactor(),origin)*100);
      await window.evaluate(()=>{window.__zoomKeys=[];window.addEventListener("keydown",event=>{if(event.ctrlKey&&["=","0"].includes(event.key)){window.__zoomKeys.push(event.key);event.stopImmediatePropagation()}},true)});
      await window.evaluate(()=>window.trebellDesktop.zoom.reset());
      await window.evaluate(()=>window.trebellDesktop.zoom.previewKeys(false));await sleep(200);
      await press("=");await sleep(300);
      assert.equal(await zoom(),110,"Ctrl+= zooms the window in");
      await press("0");await sleep(300);
      assert.equal(await zoom(),100,"Ctrl+0 resets it");
      assert.deepEqual(await window.evaluate(()=>window.__zoomKeys),[],"the shell keeps the keys from the page");
      await window.evaluate(()=>window.trebellDesktop.zoom.previewKeys(true));await sleep(200);
      await press("=");await press("0");await sleep(300);
      assert.equal(await zoom(),100,"the window keeps its zoom while the preview is open");
      assert.deepEqual(await window.evaluate(()=>window.__zoomKeys),["=","0"],"the page gets the keys");
      await window.evaluate(()=>window.trebellDesktop.zoom.previewKeys(false));await sleep(200);
      await press("=");await sleep(300);
      assert.equal(await zoom(),110,"closed again, the shell zooms the window");
      await window.evaluate(()=>window.trebellDesktop.zoom.reset());
    });

    // The page's Maximize turns into Restore while the window is maximised, however it got there: the page's button, or the system (a
    // double click on the title bar, Win+Up, a snap), which only the window's own maximize and unmaximize tell. Both are stubbed, so
    // the hidden window is not shown.
    await t.test("the window tells the page when it is maximised and when it is restored",async()=>{
      await stubMainWindow("globalThis.__maximized=false;main.isMaximized=()=>globalThis.__maximized;main.maximize=()=>{globalThis.__maximized=true;main.emit('maximize')};main.unmaximize=()=>{globalThis.__maximized=false;main.emit('unmaximize')};");
      await window.evaluate(()=>{window.__maximizedSaid=[];window.trebellDesktop.onMaximized(value=>window.__maximizedSaid.push(value))});
      assert.equal(await window.evaluate(()=>window.trebellDesktop.maximized()),false,"not maximised at first");
      await window.evaluate(()=>window.trebellDesktop.maximize());await sleep(300);
      assert.equal(await window.evaluate(()=>window.trebellDesktop.maximized()),true,"maximised by the page's Maximize");
      await stubMainWindow("main.unmaximize();");await sleep(300);
      assert.equal(await window.evaluate(()=>window.trebellDesktop.maximized()),false,"restored by the system");
      assert.deepEqual(await window.evaluate(()=>window.__maximizedSaid),[true,false],"the page is told of both");
    });

    // Last: it runs the shutdown cleanup. Both quits are recorded instead of performed, and each before-quit listener gets a
    // stand-in event. The cleanup gets up to a minute: on a busy machine stopping the server's processes takes longer than 15 s.
    // A terminal is open in the drawer, which the cleanup used to wait on for good, so the app stayed running, hidden and without its
    // tray icon: the mock server has no terminals, so the drawer's socket is an upgrade nobody answers, which holds the GUI server's
    // close as the real drawer's socket did.
    await t.test("the tray's Quit runs the shutdown cleanup and then quits, also with a terminal open in the drawer",async()=>{
      await window.evaluate(()=>{window.__drawerSocket=new WebSocket(location.origin.replace(/^http/,"ws")+"/api/terminal/ws?session=mock-terminal")});
      await sleep(1000);
      const quit=await app.evaluate(async({app})=>{
        const item=globalThis.__trebellTrayMenuTemplate().find(entry=>entry.label==="Quit Trebell Code");
        const realQuit=app.quit;let quits=0;app.quit=()=>{quits++};
        try{
          item.click();
          const event={held:false,preventDefault(){this.held=true}};
          for(const listener of app.listeners("before-quit"))try{listener(event)}catch{}
          for(let i=0;i<240&&quits<2;i++)await new Promise(resolve=>setTimeout(resolve,250));
          return {held:event.held,quits};
        }finally{app.quit=realQuit}
      });
      assert.deepEqual(quit,{held:true,quits:2},"before-quit held the quit for the cleanup, which then quit");
    });
  }finally{
    await closeElectronApp(app);
    fixture.closeAllConnections?.();await new Promise(resolve=>fixture.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Loaded with -r before the shell, it keeps a start that runs the shell's own show path off the screen: each window's show, and the
// calls that would bring one up, are recorded instead of done, with the window's first paint (ready-to-show), its load's end
// (did-finish-load) and the zoom it shows at. The dialogs, links, notifications and shortcuts a start could reach answer without the desktop.
const KEEP_OFF_SCREEN=`"use strict";
const {app,dialog,shell,Notification,globalShortcut}=require("electron");
const calls=globalThis.__startCalls=[];
app.on("browser-window-created",(_event,win)=>{
  for(const name of ["show","showInactive","focus","minimize","maximize","restore","moveTop","flashFrame","setAlwaysOnTop","setFullScreen"])win[name]=()=>{calls.push(name==="show"?"show at "+Math.round(win.webContents.getZoomFactor()*100)+"%":name)};
  win.once("ready-to-show",()=>calls.push("ready-to-show"));
  win.webContents.once("did-finish-load",()=>calls.push("did-finish-load"));
});
dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});dialog.showErrorBox=()=>{};
shell.openExternal=async()=>{};shell.openPath=async()=>"";Notification.prototype.show=function(){};globalShortcut.register=()=>false;
`;

// The shell shows its window on the window's first paint (ready-to-show), which often comes before the page's load ends: the GUI server
// runs in the shell's own busy main process. A handler set up only after the awaited load missed it, so a plain start never showed its
// window (14 of 15 starts in lane H). Here the page paints at once and its load waits on an image held until that paint has come.
test("a plain start shows the window once it has painted, at its saved zoom, also when it paints before its load ends",{timeout:120_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-start-show-"));
  let release=()=>{};const released=new Promise(resolve=>{release=resolve});
  const images=createServer(async(_req,res)=>{await released;res.writeHead(200,{"content-type":"image/svg+xml"});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')});
  const imagePort=await listen(images),guiPort=await freePort(),appPort=await freePort();let app=null;
  const dist=join(home,"ui-dist"),stub=join(home,"keep-off-screen.cjs");
  await mkdir(dist,{recursive:true});await mkdir(join(home,"desktop"),{recursive:true});
  await writeFile(join(dist,"index.html"),`<!doctype html><title>Trebell Code</title><main>${"The first screen paints while an image is still loading. ".repeat(8)}</main><img src="http://127.0.0.1:${imagePort}/held.svg" alt="">`);
  await writeFile(join(home,"desktop","desktop-prefs.json"),JSON.stringify({zoomFactor:1.2}));
  await writeFile(stub,KEEP_OFF_SCREEN);
  // A start as the installed app's: no --background, Background off (a fresh home makes no tray), and the shell's own show path.
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"0",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const calls=()=>app.evaluate(()=>globalThis.__startCalls.slice());
    for(let i=0;i<240&&!(await calls()).includes("ready-to-show");i++)await sleep(250);
    assert.deepEqual((await calls()).filter(call=>call==="ready-to-show"||call==="did-finish-load"),["ready-to-show"],"the window has painted and its load has not ended");
    release();
    for(let i=0;i<120&&!(await calls()).includes("did-finish-load");i++)await sleep(250);
    for(let i=0;i<8&&!(await calls()).some(call=>call.startsWith("show"));i++)await sleep(250);
    assert.deepEqual((await calls()).filter(call=>call!=="did-finish-load"),["ready-to-show","show at 120%"],"the window shows once it has painted, at its saved zoom");
  }finally{
    release();await closeElectronApp(app);
    images.closeAllConnections?.();await new Promise(resolve=>images.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Loaded after KEEP_OFF_SCREEN: the GUI server's close and the quit that goes through (will-quit) are written, in the order they come,
// to TREBELL_TEST_QUIT_LOG, which a test reads once the app has quit.
const QUIT_LOG=`
const {appendFileSync}=require("node:fs");const http=require("node:http");
const note=text=>{try{appendFileSync(process.env.TREBELL_TEST_QUIT_LOG,text+"\\n")}catch{}};
const serverClose=http.Server.prototype.close;
http.Server.prototype.close=function(...args){if(this.address()?.port===Number(process.env.TREBELL_GUI_PORT)){note("GUI server close");this.once("close",()=>note("GUI server closed"))}return serverClose.apply(this,args)};
app.on("will-quit",()=>note("will-quit"));
`;

// The window shows once it has painted, which can be before its load ends, so a person can close it then: with Background off (the
// default) its × or Alt+F4 quits the app. Electron rejects the load of a window that is gone, and the start's failure path took that
// for a failed start and quit again, which went through at once while the shutdown cleanup was still closing the GUI server and the
// terminals, Codex app-servers and event journal with it. Here the page's load waits on a held image, and an upgrade nobody answers
// holds the GUI server's close for its 1 s cut.
test("a window closed before its load ends quits the app once the shutdown cleanup has closed the GUI server",{timeout:120_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-close-loading-"));
  let release=()=>{};const released=new Promise(resolve=>{release=resolve});
  const images=createServer(async(_req,res)=>{await released;res.writeHead(200,{"content-type":"image/svg+xml"});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')});
  const imagePort=await listen(images),guiPort=await freePort(),appPort=await freePort();let app=null,held=null;
  const dist=join(home,"ui-dist"),stub=join(home,"keep-off-screen.cjs"),quitLog=join(home,"quit.log");
  await mkdir(dist,{recursive:true});
  await writeFile(join(dist,"index.html"),`<!doctype html><title>Trebell Code</title><main>${"The window shows while an image is still loading. ".repeat(8)}</main><img src="http://127.0.0.1:${imagePort}/held.svg" alt="">`);
  await writeFile(stub,KEEP_OFF_SCREEN+QUIT_LOG);
  // A start as the installed app's: no --background, Background off (a fresh home makes no tray), and the shell's own show path.
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"0",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_TEST_QUIT_LOG:quitLog,TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const calls=()=>app.evaluate(()=>globalThis.__startCalls.slice());
    for(let i=0;i<240&&!(await calls()).some(call=>call.startsWith("show"));i++)await sleep(250);
    assert.deepEqual((await calls()).filter(call=>call.startsWith("show")||call==="did-finish-load"),["show at 100%"],"the window shows and its load has not ended");
    held=connect(guiPort,"127.0.0.1");held.on("error",()=>{});await new Promise(resolve=>held.once("connect",resolve));
    held.write(`GET /api/no-such/ws HTTP/1.1\r\nHost: 127.0.0.1:${guiPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await sleep(500);
    // The window's ×, as the page's own button sends it.
    const child=app.process(),exited=new Promise(resolve=>{if(child.exitCode!=null)return resolve(true);const timer=setTimeout(()=>resolve(false),60_000);child.once("exit",()=>{clearTimeout(timer);resolve(true)})});
    const window=await app.firstWindow();await window.evaluate(()=>window.trebellDesktop.close()).catch(()=>{});
    assert.equal(await exited,true,"the window's Close quits the app");app=null;
    const said=(await readFile(quitLog,"utf8").catch(()=>"")).split("\n").filter(Boolean);
    assert.deepEqual(said,["GUI server close","GUI server closed","will-quit"],"the app quits once the GUI server has closed");
  }finally{
    release();held?.destroy();await closeElectronApp(app);
    images.closeAllConnections?.();await new Promise(resolve=>images.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Loaded after KEEP_OFF_SCREEN, it makes the shell a packaged build with a scripted release feed: a check finds 9.9.9 and Download
// update gets it, with nothing fetched. A check given a feed's address (feed.failsAt) is electron-updater's own, against that feed:
// it fails as the library does, through its error event and the call's rejection, with the library's own text. Restart & install then
// runs electron-updater's own quitAndInstall, which finds no installer on disk and starts nothing: it says so through its error event
// and returns without throwing, as for an installer it cannot launch.
const packagedUpdate=root=>`
Object.defineProperty(app,"isPackaged",{get:()=>true,configurable:true});
app.getLoginItemSettings=()=>({openAtLogin:false,executableWillLaunchAtLogin:false,launchItems:[]});app.setLoginItemSettings=()=>{};
const {autoUpdater}=require(require.resolve("electron-updater",{paths:[${JSON.stringify(root)}]}));
const feed=globalThis.__updateFeed={checks:0,failsAt:null};
const libraryCheck=autoUpdater.checkForUpdates;
autoUpdater.checkForUpdates=async()=>{
  feed.checks++;
  if(feed.failsAt){autoUpdater.setFeedURL({provider:"generic",url:feed.failsAt});feed.failsAt=null;return libraryCheck.call(autoUpdater)}
  autoUpdater.emit("checking-for-update");
  autoUpdater.emit("update-available",{version:"9.9.9"});return {updateInfo:{version:"9.9.9"}};
};
autoUpdater.downloadUpdate=async()=>{autoUpdater.emit("download-progress",{percent:50,transferred:50,total:100});autoUpdater.emit("update-downloaded",{version:"9.9.9"});return []};
`;

// Restart & install closes the GUI server for the installer. An installer electron-updater could not start was said only through its
// error event, so the shell never brought the server back: the window kept a dead page, the bridge refused every call and the window's
// Close did nothing (lane H, p108). Settings > General > Updates is used as a person does, on the built UI.
test("a Restart & install whose installer does not start brings the app back, says so and offers it again, and the window still closes",{timeout:240_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const dist=resolve(process.env.TREBELL_UI_DIST||join(packageRoot,"ui","dist"));
  if(!existsSync(join(dist,"index.html")))return t.skip("The built UI is needed: npm run ui:build, or TREBELL_UI_DIST.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-update-install-"));
  const guiPort=await freePort(),appPort=await freePort(),stub=join(home,"packaged-update.cjs");let app=null;
  // Release feeds that fail: one where nothing answers, as offline, and one that answers 404 with headers, as GitHub does.
  const noFeed=`http://127.0.0.1:${await freePort()}/`;
  const missingFeed=createServer((_req,res)=>{res.writeHead(404,{"content-type":"text/plain; charset=utf-8","x-github-request-id":"E3A1:2B3C:4D5E6F"});res.end("Not Found")});
  const missingFeedUrl=`http://127.0.0.1:${await listen(missingFeed)}/`;
  await writeFile(stub,KEEP_OFF_SCREEN+packagedUpdate(packageRoot));
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    // The shell's own first load of the app ends before the page is loaded again with the settings below.
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    // Set up already, so the page opens on the app instead of its first-run questions.
    await fetch(origin+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({onboardingComplete:true,panelAnimationMs:0})});
    await window.reload();
    // The check the shell makes 4 s after its start finds 9.9.9 (waited for, so it does not come again during the download).
    for(let i=0;i<120&&!(await app.evaluate(()=>globalThis.__updateFeed.checks));i++)await sleep(250);
    const card=window.locator(".update-settings");
    const openUpdates=async()=>{await window.getByRole("button",{name:/^Settings/}).first().click();await window.getByRole("button",{name:/^General/}).first().click();await card.scrollIntoViewIfNeeded()};
    await openUpdates();
    // A check that fails says why as the app's other errors do, in words, instead of electron-updater's net:: code, or its HttpError's
    // status line with the request and the response's headers. Then the next check finds 9.9.9 again.
    const said=[],failure=card.locator(".provider-status-error");
    for(const failsAt of [noFeed,missingFeedUrl]){
      const before=said.at(-1)||"";
      await app.evaluate((_electron,url)=>{globalThis.__updateFeed.failsAt=url},failsAt);
      await card.getByRole("button",{name:"Check now"}).click();
      // The last check's failure stays until this check starts.
      for(let i=0;i<80&&[before,""].includes((await failure.innerText({timeout:1000}).catch(()=>"")).trim());i++)await sleep(250);
      said.push(await settledText(failure));
    }
    assert.deepEqual(said,["Could not check for updates: there is no connection to the release server.","Could not check for updates: the release server answered 404 Not Found."],"the reason, in words");
    await card.getByRole("button",{name:"Check now"}).click();
    await card.getByRole("button",{name:"Download update"}).click();
    await card.getByRole("button",{name:"Restart & install"}).click();
    const reloaded=window.waitForEvent("load",{timeout:60_000}).then(()=>true,()=>false);
    await window.getByRole("dialog").getByRole("button",{name:"Restart and install"}).click();
    if(!await reloaded)assert.fail("the window shows the app again after the installer did not start, instead of a page whose server is gone, whose Updates card says: "+(await card.innerText({timeout:2000}).catch(()=>"")).replace(/\s+/g," "));
    assert.equal((await fetch(origin+"/api/health")).ok,true,"the GUI server answers again");
    await openUpdates();
    await card.getByText("Could not install the update: the installer did not start.").waitFor();
    assert.match((await card.innerText()).replace(/\s+/g," "),/Status: Ready to install/);
    assert.equal(await card.getByRole("button",{name:"Restart & install"}).isVisible(),true,"Restart & install is offered again");
    await window.getByRole("button",{name:/^Projects/}).first().click();
    await window.getByLabel("Search projects").waitFor();
    // The window's Close quits the app, as it does when no update was tried.
    const child=app.process(),exited=new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),60_000);child.once("exit",()=>{clearTimeout(timer);resolve(true)})});
    await window.locator(".window-close").click().catch(()=>{});
    assert.equal(await exited,true,"the window's Close quits the app");app=null;
  }finally{
    await closeElectronApp(app);
    missingFeed.closeAllConnections?.();await new Promise(resolve=>missingFeed.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Loaded after KEEP_OFF_SCREEN: each file or folder picker the shell opens takes the next plan, the paths picked or the reason it
// could not open.
const PICKER_PLAN=`
const pickerPlans=globalThis.__pickerPlans=[];
dialog.showOpenDialog=async()=>{const plan=pickerPlans.shift()||{paths:[]};if(plan.fails)throw new Error(plan.fails);return {canceled:!plan.paths.length,filePaths:plan.paths}};
`;

// What the shell could not do reads as the app's other errors do: the app's or the shell's own sentence with the reason, without
// Electron's "Error invoking remote method '<channel>': Error:" before it and without raw ENOENT or JSON parser text (lane H, p109-p114).
test("a desktop action that fails says why in the app's own words, without Electron's wrapper or raw system text",{timeout:240_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const dist=resolve(process.env.TREBELL_UI_DIST||join(packageRoot,"ui","dist"));
  if(!existsSync(join(dist,"index.html")))return t.skip("The built UI is needed: npm run ui:build, or TREBELL_UI_DIST.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-errors-"));
  const guiPort=await freePort(),appPort=await freePort(),stub=join(home,"picker-plan.cjs"),cookies=join(home,"cookies-bad.json");let app=null;
  await writeFile(stub,KEEP_OFF_SCREEN+PICKER_PLAN);await writeFile(cookies,"{ this is not json");
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    await fetch(origin+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({onboardingComplete:true,panelAnimationMs:0})});
    await window.reload();
    const plan=value=>app.evaluate((_electron,value)=>{globalThis.__pickerPlans.push(value)},value);
    const said={};
    // Attach files, when the file picker cannot open.
    await window.getByRole("button",{name:/^New task/}).first().click();
    await plan({fails:"The file picker could not open."});
    await window.getByRole("button",{name:"Attach files"}).first().click();
    said.attach=await settledText(window.getByTestId("app-action-error"));
    // The palette's Open workspace folder, when the folder picker cannot open: the palette stays open with the reason.
    await window.keyboard.press("Control+K");await window.getByTestId("command-palette").waitFor();
    await window.keyboard.type("Open workspace folder");
    await plan({fails:"The folder picker could not open."});
    await window.keyboard.press("Enter");
    said.palette=await settledText(window.locator(".command-palette-error"));
    await window.keyboard.press("Escape");
    // Import cookie JSON in the Browser panel, with a file that is not JSON: the panel's error line says why.
    await window.getByRole("button",{name:"Browser",exact:true}).first().click();
    await plan({paths:[cookies]});
    await window.locator(".agent-browser-toolbar button").filter({hasText:"Import cookie JSON"}).click();
    said.cookies=await settledText(window.getByRole("alert").filter({hasText:"Cookie import failed"}));
    // A SnapShot whose files are gone by the time the app reads it, as the shell says a capture is ready.
    await window.getByRole("button",{name:/^New task/}).first().click();
    await app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin)).webContents.send("snapshot:captured",{id:"snapshot-0-gone"}),origin);
    const activity=window.getByTestId("activity-card").last();await activity.waitFor();
    if(await activity.getAttribute("data-state")==="closed")await activity.locator(".activity-card-head").click();
    said.snapshot=await settledText(activity.locator(".tool-event.kind-error summary strong").last());
    assert.deepEqual(said,{
      attach:"Could not attach files: The file picker could not open.",
      palette:"The folder picker could not open.",
      cookies:"Cookie import failed: cookies-bad.json is not valid JSON.",
      snapshot:"Could not attach the SnapShot: The capture is no longer on disk.",
    });
  }finally{
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Loaded after KEEP_OFF_SCREEN: the foreground window a SnapShot reads (the shell's PowerShell read of it) and the window sources it is
// matched to are scripted, so nothing on the screen is read or captured. A read waits while globalThis.__snapshotPlan.held holds, as a
// slow one does, and with noSource set no window source is found for it. The shortcut handlers are kept by their keys to be pressed
// (shortcut is the last one), keys in taken are refused as another app's, and the notifications shown are counted and kept. A
// shortcut Electron cannot read (no key after its modifiers, or a key it does not know) throws as Electron 38's register does:
// "TypeError: Error processing argument at index 0, conversion failure from CommandOrControl+Shift+" (checked in the shell's
// Electron, UI fix lane r6x).
const SNAPSHOT_PLAN=`
const childProcess=require("node:child_process"),{desktopCapturer,nativeImage}=require("electron");
const snapshotPlan=globalThis.__snapshotPlan={reads:0,held:null,noSource:false,shortcut:null,shortcuts:new Map(),taken:new Set(),notified:0,said:[]};
const modifiers=new Set(["command","cmd","control","ctrl","commandorcontrol","cmdorctrl","alt","option","altgr","shift","super","meta"]);
const keyNames=/^(?:[!-~]|f(?:[1-9]|1[0-9]|2[0-4])|plus|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/i;
const readable=accelerator=>{const parts=String(accelerator).split("+"),key=parts.pop();return parts.every(part=>modifiers.has(part.toLowerCase()))&&keyNames.test(key)&&!modifiers.has(key.toLowerCase())};
const execFile=childProcess.execFile;
childProcess.execFile=function(file,args,options,done){
  if(!Array.isArray(args)||!Buffer.from(String(args.at(-1)),"base64").toString("utf16le").includes("TrebellActiveWindow"))return execFile.apply(this,arguments);
  snapshotPlan.reads++;
  const info={handle:1,title:"Notes - Notepad",processId:4242,process:"notepad",bounds:{x:40,y:40,width:640,height:480},accessibility:null};
  Promise.resolve(snapshotPlan.held).then(()=>done(null,Buffer.from(JSON.stringify(info)).toString("base64"),""));
};
require("node:module").syncBuiltinESMExports();
desktopCapturer.getSources=async()=>snapshotPlan.noSource?[]:[{name:"Notes - Notepad",thumbnail:nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")}];
globalShortcut.register=(accelerator,handler)=>{if(!readable(accelerator))throw new TypeError("Error processing argument at index 0, conversion failure from "+accelerator);if(snapshotPlan.taken.has(accelerator))return false;snapshotPlan.shortcuts.set(accelerator,handler);snapshotPlan.shortcut=handler;return true};
globalShortcut.unregister=accelerator=>{snapshotPlan.shortcuts.delete(accelerator)};
Notification.isSupported=()=>true;Notification.prototype.show=function(){snapshotPlan.notified++;snapshotPlan.said.push(this.title+": "+this.body)};
`;

// One SnapShot at a time. The shell took every capture it was asked for as a new one, so Capture now pressed again, or the shortcut,
// while a SnapShot was being taken read and took the window again (lane G, GR5-1). The page is the app's origin without the app, so
// the captures stay on disk to be counted.
test("the shell takes one SnapShot at a time: a capture asked for while one is being taken is refused, and the shortcut then takes nothing and says nothing",{timeout:120_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-snapshot-once-"));
  const guiPort=await freePort(),appPort=await freePort(),dist=join(home,"ui-dist"),stub=join(home,"snapshot-plan.cjs");let app=null;
  await mkdir(dist,{recursive:true});await writeFile(join(dist,"index.html"),"<!doctype html><title>Trebell Code</title><main>SnapShots</main>");
  await writeFile(stub,KEEP_OFF_SCREEN+SNAPSHOT_PLAN);
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    const plan=()=>app.evaluate(()=>({reads:globalThis.__snapshotPlan.reads,notified:globalThis.__snapshotPlan.notified}));
    // Each capture the page asks for, kept with what it answered; the SnapShots on disk; the shortcut, pressed.
    const capture=()=>window.evaluate(()=>{(window.__captures||=[]).push(window.trebellDesktop.snapshots.capture().then(meta=>"took "+meta.title,error=>"refused: "+error.message))});
    const answered=()=>window.evaluate(()=>Promise.all(window.__captures));
    const pending=async()=>(await window.evaluate(()=>window.trebellDesktop.snapshots.pending())).length;
    const press=()=>app.evaluate(()=>{globalThis.__snapshotPlan.shortcut()});
    await window.evaluate(()=>window.trebellDesktop.snapshots.configure({enabled:true}));
    // Capture now pressed twice, and the shortcut once, while the first SnapShot's window read is held.
    await app.evaluate(()=>{const plan=globalThis.__snapshotPlan;plan.held=new Promise(resolve=>{plan.free=resolve})});
    await capture();
    for(let i=0;i<50&&!(await plan()).reads;i++)await sleep(100);
    await capture();await press();await sleep(800);
    const during=await plan();
    await app.evaluate(()=>{const plan=globalThis.__snapshotPlan;plan.held=null;plan.free()});
    assert.deepEqual({answers:await answered(),...during,pending:await pending()},{answers:["took Notes - Notepad","refused: A SnapShot is already being taken."],reads:1,notified:0,pending:1},"one SnapShot is taken; the second press is refused, and the shortcut reads nothing and shows no notification");
    // Once it is taken, a press of Capture now and of the shortcut each take one again.
    await capture();assert.equal((await answered()).at(-1),"took Notes - Notepad");
    await press();for(let i=0;i<50&&await pending()<3;i++)await sleep(100);
    assert.deepEqual({...await plan(),pending:await pending()},{reads:3,notified:0,pending:3},"a press of its own takes a SnapShot");
  }finally{
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// A change to a shortcut another app holds is refused and the shortcut before it kept, registered again. The kept one dropped what its
// SnapShot could not do, so a press whose capture failed said nothing at all, while the shortcut Enable registered says why in a
// notification (lane H, p114). A change to a shortcut Electron cannot read (the field left as CommandOrControl+Shift+ while its key is
// retyped, or a key name it does not know) is refused the same way: Electron's register threw instead of answering false, which
// skipped the shortcut's restore, so the shortcut Settings showed as kept was registered no more and its presses did nothing at all
// (UI fix review, round 6). Settings > Desktop > SnapShots is used as a person does, on the built UI; a press of the shortcut in
// another app is the handler the shell registered for its keys, called as the system calls it.
test("a SnapShot that fails from the shortcut kept after a change to one another app holds, or to one that is not a shortcut, says why in a notification, as from the shortcut Enable registered",{timeout:180_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const dist=resolve(process.env.TREBELL_UI_DIST||join(packageRoot,"ui","dist"));
  if(!existsSync(join(dist,"index.html")))return t.skip("The built UI is needed: npm run ui:build, or TREBELL_UI_DIST.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-snapshot-kept-"));
  const guiPort=await freePort(),appPort=await freePort(),stub=join(home,"snapshot-plan.cjs");let app=null;
  await writeFile(stub,KEEP_OFF_SCREEN+SNAPSHOT_PLAN);
  // Settings > Desktop lists the browser profiles to import: APPDATA and LOCALAPPDATA are the test's, so none of this machine's are read.
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),APPDATA:join(home,"appdata"),LOCALAPPDATA:join(home,"localappdata"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    await fetch(origin+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({onboardingComplete:true,panelAnimationMs:0})});
    await window.reload();
    const plan=()=>app.evaluate(()=>{const plan=globalThis.__snapshotPlan;return {reads:plan.reads,said:plan.said.slice(),registered:[...plan.shortcuts.keys()]}});
    const press=keys=>app.evaluate((_electron,keys)=>{const handler=globalThis.__snapshotPlan.shortcuts.get(keys);if(handler)handler();return Boolean(handler)},keys);
    // The plan read until done holds, for up to tries tenths of a second. Each read waits its tenth first: an evaluate that lands while
    // the shell is still taking a SnapShot can lose its answer to a garbage collection ("Resulting promise was garbage collected").
    const planWhen=async(done,tries)=>{let now;for(let i=0;i<tries;i++){await sleep(100);now=await plan();if(done(now))break}return now};
    // A press of the shortcut: the windows it read, and the notifications shown up to 3 s after its read.
    const pressed=async keys=>{
      const before=await plan();
      if(!await press(keys))return "not registered, the shortcuts are "+before.registered.join(", ");
      await planWhen(now=>now.reads>before.reads,100);
      const after=await planWhen(now=>now.said.length>before.said.length,30);
      return {reads:after.reads-before.reads,said:after.said.slice(before.said.length)};
    };
    await window.getByRole("button",{name:/^Settings/}).first().click();
    await window.getByRole("button",{name:/^Desktop/}).first().click();
    const card=window.locator(".snapshot-settings");await card.scrollIntoViewIfNeeded();
    const field=card.getByRole("textbox",{name:"Shortcut"});
    // What the card says once its save has answered, the shortcut in its field, and the shortcuts the shell holds.
    const shows=async()=>({card:await settledText(card.locator(".provider-note, .provider-status-error").last()),field:await field.inputValue(),registered:(await plan()).registered});
    // The shortcut typed in, as a person does: the field's text selected and typed over.
    const type=async keys=>{await field.click();await window.keyboard.press("Control+A");await window.keyboard.type(keys)};
    const shown={},said={};
    await card.getByRole("checkbox",{name:"Enable global SnapShot shortcut"}).click();
    shown.enabled=await shows();
    await app.evaluate(()=>{const plan=globalThis.__snapshotPlan;plan.noSource=true;plan.taken.add("CommandOrControl+Shift+8")});
    said.enabled=await pressed("CommandOrControl+Shift+S");
    // CommandOrControl+Shift+8, another app's, saved as the field is left, with the mouse (a click on the card's heading) and with the
    // keyboard (Tab).
    await type("CommandOrControl+Shift+8");await card.getByRole("heading",{name:"SnapShots"}).click();
    shown.keptAfterClick=await shows();said.keptAfterClick=await pressed("CommandOrControl+Shift+S");
    await type("CommandOrControl+Shift+8");await window.keyboard.press("Tab");
    shown.keptAfterTab=await shows();said.keptAfterTab=await pressed("CommandOrControl+Shift+S");
    // The kept shortcut pressed again while its SnapShot is being taken (its key repeating) takes nothing more and says nothing more.
    await app.evaluate(()=>{const plan=globalThis.__snapshotPlan;plan.held=new Promise(resolve=>{plan.free=resolve})});
    const before=await plan();
    await press("CommandOrControl+Shift+S");await planWhen(now=>now.reads>before.reads,50);
    await press("CommandOrControl+Shift+S");await sleep(800);
    const during=await plan();
    await app.evaluate(()=>{const plan=globalThis.__snapshotPlan;plan.held=null;plan.free()});
    const after=await planWhen(now=>now.said.length>during.said.length,30);
    said.keptPressedTwice={reads:after.reads-before.reads,whileTaken:during.said.slice(before.said.length),said:after.said.slice(before.said.length)};
    // The field left reading CommandOrControl+Shift+, its key erased to type another, with the keyboard (Tab), and reading PrintScr, a
    // key name Electron does not know (PrintScreen), with the mouse.
    await field.click();await window.keyboard.press("End");await window.keyboard.press("Backspace");
    assert.equal(await field.inputValue(),"CommandOrControl+Shift+","the field reads its modifiers alone");
    await window.keyboard.press("Tab");
    shown.notShortcutAfterTab=await shows();said.notShortcutAfterTab=await pressed("CommandOrControl+Shift+S");
    await type("PrintScr");await card.getByRole("heading",{name:"SnapShots"}).click();
    shown.notShortcutAfterClick=await shows();said.notShortcutAfterClick=await pressed("CommandOrControl+Shift+S");
    // A change that is taken registers the new shortcut, which says why as well.
    await type("CommandOrControl+Shift+9");await window.keyboard.press("Tab");
    shown.accepted=await shows();said.accepted=await pressed("CommandOrControl+Shift+9");
    const refused={card:"Shortcut CommandOrControl+Shift+8 is already reserved by another application.",field:"CommandOrControl+Shift+S",registered:["CommandOrControl+Shift+S"]};
    const notShortcut=keys=>({card:`Shortcut ${keys} is not a valid shortcut. A shortcut is modifiers and one key, such as CommandOrControl+Shift+S.`,field:"CommandOrControl+Shift+S",registered:["CommandOrControl+Shift+S"]});
    const failed={reads:1,said:["Trebell SnapShot: Could not match the active window (Notes - Notepad) to a capturable source."]};
    // What the card showed after each change, and what each press of the shortcut did then.
    assert.deepEqual({shown,said},{
      shown:{
        enabled:{card:"SnapShots ready.",field:"CommandOrControl+Shift+S",registered:["CommandOrControl+Shift+S"]},keptAfterClick:refused,keptAfterTab:refused,
        notShortcutAfterTab:notShortcut("CommandOrControl+Shift+"),notShortcutAfterClick:notShortcut("PrintScr"),
        accepted:{card:"SnapShots ready.",field:"CommandOrControl+Shift+9",registered:["CommandOrControl+Shift+9"]},
      },
      said:{enabled:failed,keptAfterClick:failed,keptAfterTab:failed,keptPressedTwice:{...failed,whileTaken:[]},notShortcutAfterTab:failed,notShortcutAfterClick:failed,accepted:failed},
    },"what the card showed after each change, and what each press of the shortcut did: "+JSON.stringify({shown,said}));
  }finally{
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// The toast of a chat action that failed shows just above the composer, centred on the composer where it shows, all of it in the window.
// It is placed from the composer's box, which the desktop app's Chromium takes before transforms: a composer centred by translateX(-50%)
// had the toast centred on its right edge, so at 1280 wide the toast ran off the window with its text cut (lane H, p109).
test("a failed chat action's toast shows above the composer, centred on it and inside the window, at 1280 wide and narrower, zoomed and beside the right panel",{timeout:240_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const dist=resolve(process.env.TREBELL_UI_DIST||join(packageRoot,"ui","dist"));
  if(!existsSync(join(dist,"index.html")))return t.skip("The built UI is needed: npm run ui:build, or TREBELL_UI_DIST.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-toast-"));
  const guiPort=await freePort(),appPort=await freePort(),stub=join(home,"picker-plan.cjs"),notes=join(home,"notes-a.txt");let app=null;
  await writeFile(stub,KEEP_OFF_SCREEN+PICKER_PLAN);await writeFile(notes,"Notes to attach\n");
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    await fetch(origin+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({onboardingComplete:true,panelAnimationMs:0})});
    await window.reload();
    const plan=value=>app.evaluate((_electron,value)=>{globalThis.__pickerPlans.push(value)},value);
    // The window's size and zoom as a person sets them: its edge, and Ctrl+= and Ctrl+0 through the window's input.
    const resize=(width,height)=>app.evaluate(({BrowserWindow},{origin,width,height})=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin)).setContentSize(width,height),{origin,width,height});
    const press=code=>app.evaluate(({BrowserWindow},{origin,code})=>{const main=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin));for(const type of ["keyDown","keyUp"])main.webContents.sendInputEvent({type,keyCode:code,modifiers:["control"]})},{origin,code});
    const attach=window.getByRole("button",{name:"Attach files"}).first(),toast=window.getByTestId("app-action-error");
    // Attach files when the file picker cannot open, and where the toast shows once its text has settled.
    const failedAttach=async()=>{
      await plan({fails:"The file picker could not open."});await attach.click();
      assert.equal(await settledText(toast),"Could not attach files: The file picker could not open.");
      return window.evaluate(()=>{
        const box=selector=>document.querySelector(selector)?.getBoundingClientRect()||null;
        const shown=box("[data-testid=app-action-error]"),composer=box(".chat-workspace .composer-wrap"),chip=box(".chat-workspace .attachment-shelf>span");
        return {left:Math.round(shown.left),right:Math.round(shown.right),window:innerWidth,offCentre:Math.round(Math.abs(shown.left+shown.width/2-(composer.left+composer.width/2))),above:shown.bottom<=Math.min(composer.top,chip?chip.top:Infinity)};
      });
    };
    const seen={};
    await window.getByRole("button",{name:/^New task/}).first().click();
    await resize(1280,800);seen.window1280=await failedAttach();
    // With a file on the shelf above the composer, the toast goes above the shelf.
    await plan({paths:[notes]});await attach.click();await window.locator(".attachment-shelf>span").filter({hasText:"notes-a.txt"}).waitFor();
    seen.shelf1280=await failedAttach();
    await resize(1180,720);seen.window1180=await failedAttach();
    // Zoomed to 150% the 1280 window lays out the app's narrow widths.
    await resize(1280,800);for(let i=0;i<5;i++)await press("=");
    seen.zoom150=await failedAttach();
    await press("0");
    await window.getByTestId("right-panel-toggle").first().click();await window.getByTestId("right-panel").waitFor();
    seen.rightPanel1280=await failedAttach();
    const fits=({left,right,window,offCentre,above})=>({inWindow:left>=0&&right<=window,centred:offCentre<=1,above});
    const ok={inWindow:true,centred:true,above:true};
    assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([name,at])=>[name,fits(at)])),{window1280:ok,shelf1280:ok,window1180:ok,zoom150:ok,rightPanel1280:ok},"where the toast showed: "+JSON.stringify(seen));
  }finally{
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// Zoomed in, the New task welcome no longer fits the conversation's box: it shows from its top, its picture and title below the
// header, and scrolls only for the rest. The box keeps a view that follows the newest message at its end when it is resized, and
// it kept the welcome, which has no newest message, at its end too: from 150% its picture and title were under the header (lane H, p113).
test("the New task welcome shows from its top, below the header, when the window is zoomed in and when it opens zoomed",{timeout:180_000},async t=>{
  if(process.platform!=="win32")return t.skip("The desktop shell checks target the Windows desktop build.");
  const dist=resolve(process.env.TREBELL_UI_DIST||join(packageRoot,"ui","dist"));
  if(!existsSync(join(dist,"index.html")))return t.skip("The built UI is needed: npm run ui:build, or TREBELL_UI_DIST.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-welcome-zoom-"));
  const guiPort=await freePort(),appPort=await freePort(),stub=join(home,"keep-off-screen.cjs");let app=null;
  await writeFile(stub,KEEP_OFF_SCREEN);
  const env={...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_UI_DIST:dist,TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const origin=`http://127.0.0.1:${guiPort}`;
  try{
    app=await electron.launch({args:["-r",stub,packageRoot],env});
    const window=await app.firstWindow();for(let i=0;i<240&&!window.url().startsWith(origin);i++)await sleep(250);await window.waitForLoadState("load");
    await fetch(origin+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({onboardingComplete:true,panelAnimationMs:0})});
    await window.reload();
    await app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin)).setContentSize(1280,800),origin);
    // Ctrl+= and Ctrl+0 through the window's input, as a person presses them, and the window's zoom they set.
    const press=code=>app.evaluate(({BrowserWindow},{origin,code})=>{const main=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin));for(const type of ["keyDown","keyUp"])main.webContents.sendInputEvent({type,keyCode:code,modifiers:["control"]})},{origin,code});
    const zoom=async()=>Math.round(await app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&item.webContents.getURL().startsWith(origin)).webContents.getZoomFactor(),origin)*100);
    // Where the welcome shows once the page has drawn two frames at the zoom: the picture's and the title's top against the header's
    // bottom, and the box's scroll against how far it can scroll.
    const welcome=async percent=>{
      for(let i=0;i<100&&await zoom()!==percent;i++)await sleep(100);
      assert.equal(await zoom(),percent,"the window's zoom");
      await window.locator(".welcome h1").waitFor();
      await window.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      return window.evaluate(()=>{
        const box=selector=>document.querySelector(selector).getBoundingClientRect(),scroller=document.querySelector(".chat-workspace .conversation-scroll");
        return {header:Math.round(box(".chat-workspace .workspace-header").bottom),picture:Math.round(box(".welcome .welcome-mark").top),title:Math.round(box(".welcome h1").top),scrollTop:Math.round(scroller.scrollTop),scrollRoom:scroller.scrollHeight-scroller.clientHeight};
      });
    };
    const seen={};
    await window.getByRole("button",{name:/^New task/}).first().click();
    for(let i=0;i<5;i++)await press("=");
    seen.zoomed150=await welcome(150);
    // Opened again at 150%: Settings, then New task.
    await window.getByRole("button",{name:"Settings",exact:true}).click();await window.getByRole("heading",{name:"Settings"}).waitFor();
    await window.getByRole("button",{name:/^New task/}).first().click();
    seen.opened150=await welcome(150);
    // Opened again at 150% after a conversation that was scrolled to its end: a long message and its reply, then New task.
    const composer=window.getByTestId("composer");
    await composer.click();await composer.fill(Array.from({length:30},(_,i)=>`Line ${i+1} of a long message.`).join("\n"));await window.keyboard.press("Enter");
    await window.getByText("Mock direct reply: Line 1 of a long message.").first().waitFor();
    await window.getByRole("button",{name:/^New task/}).first().click();
    seen.afterConversation150=await welcome(150);
    for(let i=0;i<2;i++)await press("=");
    seen.zoomed170=await welcome(170);
    await press("0");
    const shows=({header,picture,title,scrollTop,scrollRoom})=>({belowHeader:picture>=header&&title>=header,fromTop:scrollTop===0,scrollsForTheRest:scrollRoom>0});
    const ok={belowHeader:true,fromTop:true,scrollsForTheRest:true};
    assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([name,at])=>[name,shows(at)])),{zoomed150:ok,opened150:ok,afterConversation150:ok,zoomed170:ok},"where the welcome showed: "+JSON.stringify(seen));
  }finally{
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
