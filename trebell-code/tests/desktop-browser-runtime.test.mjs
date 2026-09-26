import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const packageRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
async function freePort(){const server=createServer();const port=await listen(server);await new Promise(resolve=>server.close(resolve));return port}

test("desktop isolated browser reports bounded runtime failures and responsive viewport evidence",{timeout:30_000},async()=>{
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
  }finally{
    if(app){
      const child=app.process(),closing=app.close().catch(()=>{});await Promise.race([closing,new Promise(resolve=>setTimeout(resolve,3000))]);
      if(child.exitCode==null&&!child.killed)child.kill();await Promise.race([closing,new Promise(resolve=>setTimeout(resolve,3000))]);
    }
    fixture.closeAllConnections?.();await new Promise(resolve=>fixture.close(()=>resolve()));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
