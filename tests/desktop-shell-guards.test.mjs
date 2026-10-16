import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Loaded after KEEP_OFF_SCREEN, it makes the shell a packaged build with a scripted release feed: a check finds 9.9.9 and Download
// update gets it, with nothing fetched; a check given a reason (feed.fails) fails with it, as electron-updater's does, through the error
// event and the call's rejection. Restart & install then runs electron-updater's own quitAndInstall, which finds no installer on disk
// and starts nothing: it says so through its error event and returns without throwing, as for an installer it cannot launch.
const packagedUpdate=root=>`
Object.defineProperty(app,"isPackaged",{get:()=>true,configurable:true});
app.getLoginItemSettings=()=>({openAtLogin:false,executableWillLaunchAtLogin:false,launchItems:[]});app.setLoginItemSettings=()=>{};
const {autoUpdater}=require(require.resolve("electron-updater",{paths:[${JSON.stringify(root)}]}));
const feed=globalThis.__updateFeed={checks:0,fails:null};
autoUpdater.checkForUpdates=async()=>{
  feed.checks++;autoUpdater.emit("checking-for-update");
  if(feed.fails){const error=new Error(feed.fails);feed.fails=null;autoUpdater.emit("error",error);throw error}
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
    // A check that fails says why as the app's other errors do, then the next check finds 9.9.9 again.
    await app.evaluate(()=>{globalThis.__updateFeed.fails="The release feed could not be read."});
    await card.getByRole("button",{name:"Check now"}).click();
    assert.equal(await settledText(card.locator(".provider-status-error")),"The release feed could not be read.","the reason, without Electron's \"Error invoking remote method\" before it");
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
    await closeElectronApp(app);await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
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
    // Import cookie JSON in the Browser panel, with a file that is not JSON.
    await window.getByRole("button",{name:"Browser",exact:true}).first().click();
    await plan({paths:[cookies]});
    await window.locator(".agent-browser-toolbar button").filter({hasText:"Import cookie JSON"}).click();
    said.cookies=await settledText(window.getByTestId("browser-cookie-status"));
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
