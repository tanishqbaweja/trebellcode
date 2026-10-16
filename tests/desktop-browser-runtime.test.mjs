import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const packageRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));

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

test("desktop isolated browser reports bounded runtime failures and responsive viewport evidence",{timeout:60_000},async()=>{
  if(process.platform!=="win32")return test.skip("Desktop browser runtime fixture currently targets the Windows desktop build.");
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-browser-runtime-"));
  const fixture=createServer((req,res)=>{
    if(req.url==="/missing"){res.writeHead(404,{"content-type":"text/plain"});res.end("missing");return}
    if(req.url==="/clean"){res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><title>Clean fixture</title><main>clean</main>");return}
    if(req.url==="/one"){res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><title>History one</title><main>one</main>");return}
    if(req.url==="/two"){res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><title>History two</title><main>two</main>");return}
    res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><title>Runtime fixture</title><script>console.error('PRIVATE_FIXTURE_ERROR');fetch('/missing').catch(()=>{});</script><button id='ok'>fixture</button>");
  });
  const fixturePort=await listen(fixture),guiPort=await freePort(),appPort=await freePort();let app=null;
  try{
    app=await electron.launch({args:[packageRoot],env:{...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""}});
    const window=await app.firstWindow();await window.waitForLoadState("domcontentloaded");
    const initial=await window.evaluate(async url=>{await window.trebellDesktop.browser.navigate(url);await new Promise(resolve=>setTimeout(resolve,250));return window.trebellDesktop.browser.runtime()},`http://127.0.0.1:${fixturePort}/`);
    assert.ok(initial.consoleErrors.length>=1,JSON.stringify(initial));assert.ok(initial.networkFailures.some(item=>Number(item.statusCode)===404),JSON.stringify(initial));
    const evidence=await window.evaluate(async()=>{
      await window.trebellDesktop.browser.setViewport(390,844);const mobile=await window.trebellDesktop.browser.screenshot();
      await window.trebellDesktop.browser.setViewport(1280,800);const desktop=await window.trebellDesktop.browser.screenshot();
      const runtime=await window.trebellDesktop.browser.runtime();return {mobile:{width:mobile.width,height:mobile.height},desktop:{width:desktop.width,height:desktop.height},runtime};
    });
    assert.deepEqual(evidence.mobile,{width:390,height:844});assert.deepEqual(evidence.desktop,{width:1280,height:800});
    assert.deepEqual(evidence.runtime.viewports.map(item=>[item.width,item.height]),[[390,844],[1280,800]]);assert.ok(evidence.runtime.consoleErrors.length>=1);assert.ok(evidence.runtime.networkFailures.length>=1);
    const reset=await window.evaluate(async url=>{await window.trebellDesktop.browser.navigate(url);await new Promise(resolve=>setTimeout(resolve,120));return window.trebellDesktop.browser.runtime()},`http://127.0.0.1:${fixturePort}/clean`);
    assert.equal(reset.consoleErrors.length,0);assert.equal(reset.networkFailures.length,0);assert.equal(reset.viewports.length,0);
    const history=await window.evaluate(async({one,two})=>{
      await window.trebellDesktop.browser.navigate(one);await window.trebellDesktop.browser.navigate(two);
      const atTwo=await window.trebellDesktop.browser.state(),back=await window.trebellDesktop.browser.back(),forward=await window.trebellDesktop.browser.forward(),reloaded=await window.trebellDesktop.browser.reload();
      return {atTwo,back,forward,reloaded};
    },{one:`http://127.0.0.1:${fixturePort}/one`,two:`http://127.0.0.1:${fixturePort}/two`});
    assert.match(history.atTwo.url,/\/two$/);assert.equal(history.atTwo.canGoBack,true);
    assert.match(history.back.url,/\/one$/);assert.equal(history.back.canGoForward,true);
    assert.match(history.forward.url,/\/two$/);assert.equal(history.reloaded.url,history.forward.url);assert.equal(history.reloaded.title,"History two");
    for(let iteration=0;iteration<12;iteration++){
      await window.evaluate(async url=>{
        await Promise.allSettled([
          window.trebellDesktop.browser.navigate(url),
          window.trebellDesktop.browser.state(),
          window.trebellDesktop.browser.close(),
        ]);
      },`http://127.0.0.1:${fixturePort}/one?close-race=${iteration}`);
      const reopened=await window.evaluate(async url=>{await window.trebellDesktop.browser.navigate(url);return window.trebellDesktop.browser.state()},`http://127.0.0.1:${fixturePort}/clean?reopen=${iteration}`);
      assert.equal(reopened.open,true);assert.match(reopened.url,/\/clean\?reopen=/);
    }
  }finally{
    await closeElectronApp(app);
    fixture.closeAllConnections?.();await new Promise(resolve=>fixture.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A hidden start of the desktop app beside a fixture server of pages (path: html). done closes both.
async function startDesktop(pages){
  const home=await mkdtemp(join(tmpdir(),"trebell-desktop-agent-browser-"));let app=null;
  const fixture=createServer((req,res)=>{const body=pages[req.url];res.writeHead(body?200:404,{"content-type":"text/html"});res.end(body||"missing")});
  const fixturePort=await listen(fixture),guiPort=await freePort(),appPort=await freePort();
  const done=async()=>{await closeElectronApp(app);fixture.closeAllConnections?.();await new Promise(resolve=>fixture.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
  try{
    app=await electron.launch({args:[packageRoot],env:{...process.env,TREBELL_HOME:home,TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_MOCK:"1",TREBELL_GUI_PORT:String(guiPort),TREBELL_APP_SERVER_PORT:String(appPort),TREBELL_E2E_OFFLINE:"1",TREBELL_E2E_ALLOW_NETWORK:"0",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""}});
    const window=await app.firstWindow();await window.waitForLoadState("domcontentloaded");
    return {app,window,site:`http://127.0.0.1:${fixturePort}`,gui:`http://127.0.0.1:${guiPort}`,done};
  }catch(error){await done();throw error}
}

// What Attach screenshot gives the model of the agent browser, the page as its window shows it: the colour of an empty corner, and the
// darkest drawn pixel of the page's heading (null before the window has painted).
async function agentScreenshotPixels({app,window,gui}){
  const shot=await window.evaluate(()=>window.trebellDesktop.browser.screenshot());
  return app.evaluate(async({BrowserWindow,nativeImage},{gui,dataUrl})=>{
    const agent=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&!item.webContents.getURL().startsWith(gui));
    const heading=JSON.parse(await agent.webContents.executeJavaScript("JSON.stringify(document.querySelector('h1').getBoundingClientRect())"));
    const image=nativeImage.createFromDataURL(dataUrl);if(image.isEmpty())return null;
    const {width,height}=image.getSize(),bitmap=image.toBitmap(),scale=width/agent.getContentSize()[0];
    // The bitmap is BGRA; a pixel not drawn yet is transparent.
    const rgba=(x,y)=>{const at=(Math.round(y)*width+Math.round(x))*4;return [bitmap[at+2],bitmap[at+1],bitmap[at],bitmap[at+3]]};
    let ink=[255,255,255];
    for(let y=Math.ceil(heading.top*scale);y<Math.floor(heading.bottom*scale);y++)for(let x=Math.ceil(heading.left*scale);x<Math.floor(heading.right*scale);x++){const pixel=rgba(x,y);if(pixel[3]===255&&pixel[0]+pixel[1]+pixel[2]<ink[0]+ink[1]+ink[2])ink=pixel.slice(0,3)}
    return {corner:rgba(width-12,height-12).slice(0,3),ink};
  },{gui,dataUrl:shot.dataUrl});
}
const lightness=([red,green,blue])=>red+green+blue;

// A page that sets no background shows on white in the agent browser, as in a browser and in the Browser panel's preview, so its black
// text and blue links can be read in the window and in the screenshot the model gets.
test("the agent browser draws a page that sets no background on white, in its window and in Attach screenshot",{timeout:60_000},async()=>{
  if(process.platform!=="win32")return test.skip("Desktop browser runtime fixture currently targets the Windows desktop build.");
  const desktop=await startDesktop({"/":"<!doctype html><title>Plain page</title><h1>Plain page</h1><a href='/'>next page</a> <button>Make an error</button> <input placeholder='Type here'>"});
  try{
    // Open agent browser on the page, then Attach screenshot, as the Browser panel's buttons do, until the heading shows in it.
    await desktop.window.evaluate(url=>window.trebellDesktop.browser.navigate(url),desktop.site+"/");
    let pixels=await agentScreenshotPixels(desktop);
    for(const end=Date.now()+10_000;(!pixels||lightness(pixels.ink)>=200)&&Date.now()<end;pixels=await agentScreenshotPixels(desktop))await sleep(150);
    assert.ok(pixels,"the agent browser's window has painted");
    assert.deepEqual(pixels.corner,[255,255,255],`the page shows on white, not on rgb(${pixels.corner})`);
    assert.ok(lightness(pixels.ink)<200,`its heading is drawn in black on it, not in rgb(${pixels.ink})`);
  }finally{await desktop.done()}
});

// A page's popup loads in place in the agent browser, as the agent works on one page at a time, when it is a web page. A popup of
// another kind (javascript:, about:blank, data:) is refused, as Chromium refuses a file: popup itself, so the agent's page stays.
const POPUP_START="<!doctype html><title>Popup start</title><style>button,a{display:block;margin:12px;font-size:16px}</style>"+
  "<button id='script' onclick=\"window.open('javascript:document.title=&quot;script ran&quot;');document.body.dataset.opened=this.id\">window.open javascript</button>"+
  "<button id='blank' onclick=\"window.open();document.body.dataset.opened=this.id\">window.open blank</button>"+
  "<button id='data' onclick=\"window.open('data:text/html,<h1>made-up page</h1>');document.body.dataset.opened=this.id\">window.open data</button>"+
  "<a id='web' href='/next' target='_blank'>next page</a>";
test("a page's popup that is not a web page leaves the agent browser on its page, and a web page's popup opens in it",{timeout:90_000},async()=>{
  if(process.platform!=="win32")return test.skip("Desktop browser runtime fixture currently targets the Windows desktop build.");
  const desktop=await startDesktop({"/":POPUP_START,"/next":"<!doctype html><title>Popup next</title><h1>next page</h1>"});
  try{
    const {app,window,site,gui}=desktop,start=site+"/";
    // The agent window's page (its address, title, whether it loads and the last button clicked on it) and how many windows there are.
    const agent=()=>app.evaluate(async({BrowserWindow},gui)=>{
      const windows=BrowserWindow.getAllWindows().filter(item=>!item.isDestroyed()),contents=windows.find(item=>!item.webContents.getURL().startsWith(gui)).webContents;
      const opened=await Promise.race([contents.executeJavaScript("document.body?.dataset.opened||''"),new Promise(resolve=>setTimeout(()=>resolve("?"),1000))]).catch(()=>"?");
      return {url:contents.getURL(),title:contents.getTitle(),loading:contents.isLoading(),opened,windows:windows.length};
    },gui);
    const until=async ok=>{let state;for(const end=Date.now()+5000;;await sleep(100)){state=await agent();if(ok(state)||Date.now()>end)return state}};
    // A left click at an element's middle through the agent window's own input, as a person clicking in the shown window.
    const click=selector=>app.evaluate(async({BrowserWindow},{gui,selector})=>{
      const contents=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed()&&!item.webContents.getURL().startsWith(gui)).webContents;
      const rect=JSON.parse(await contents.executeJavaScript(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
      const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
      contents.sendInputEvent({type:"mouseMove",x,y});
      for(const type of ["mouseDown","mouseUp"])contents.sendInputEvent({type,x,y,button:"left",clickCount:1});
    },{gui,selector});
    // Open agent browser on the page, as the Browser panel's button does, and click each popup button there.
    const outcomes={};
    for(const id of ["script","blank","data"]){
      await window.evaluate(url=>window.trebellDesktop.browser.navigate(url),start);
      await click("#"+id);
      const {url,title,opened,windows}=await until(state=>(state.opened===id||state.url!==start)&&!state.loading);
      outcomes[id]={url,title,opened,windows};
    }
    const stayed=opened=>({url:start,title:"Popup start",opened,windows:2});
    assert.deepEqual(outcomes,{script:stayed("script"),blank:stayed("blank"),data:stayed("data")},"each popup is refused and the page stays");
    // A link to a web page with a new-window target opens in the agent's window, and the Browser panel follows it there.
    await window.evaluate(url=>window.trebellDesktop.browser.navigate(url),start);
    await click("#web");
    const next=await until(state=>state.url===site+"/next"&&!state.loading);
    assert.deepEqual({url:next.url,title:next.title,windows:next.windows},{url:site+"/next",title:"Popup next",windows:2});
    assert.equal((await window.evaluate(()=>window.trebellDesktop.browser.state())).url,site+"/next");
  }finally{await desktop.done()}
});
