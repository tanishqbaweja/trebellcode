import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
      assert.match(opened,/^refused: .*Could not open the folder: Access is denied\./,opened);
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

    // Last: it runs the shutdown cleanup. Both quits are recorded instead of performed, and each before-quit listener gets a
    // stand-in event. The cleanup gets up to a minute: on a busy machine stopping the server's processes takes longer than 15 s.
    await t.test("the tray's Quit runs the shutdown cleanup and then quits",async()=>{
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
