import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";

// Performance budgets for the server's state, its Codex relay hook and its HTTP serving, as load-independent counts (the perf plan's
// section 2).
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// B12b: a reload or a restart fetched the whole bundle again (1,577 KB on the perf home, scripts/perf/reload.mjs), because nothing
// was served with a cache header. Hashed assets are now kept for good and index.html is revalidated.
test("B12b: hashed assets are served immutable and index.html revalidates to a 304 that carries no body",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b12b-")),dist=join(home,"dist"),[port,appPort]=await Promise.all([freePort(),freePort()]);
  await mkdir(join(dist,"assets"),{recursive:true});
  await writeFile(join(dist,"index.html"),'<!doctype html><script type="module" src="/assets/index-Bf3x9Q2a.js"></script>');
  await writeFile(join(dist,"assets","index-Bf3x9Q2a.js"),"console.log('app')");await writeFile(join(dist,"trebell-code-icon.svg"),"<svg/>");
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:join(home,"home"),TREBELL_UI_DIST:dist}});
    const get=(path,headers={})=>fetch(gui.url+path,{headers});
    const asset=await get("/assets/index-Bf3x9Q2a.js");
    assert.equal(asset.status,200);assert.equal(asset.headers.get("cache-control"),"public, max-age=31536000, immutable");assert.equal(await asset.text(),"console.log('app')");
    const page=await get("/"),etag=page.headers.get("etag");
    assert.equal(page.status,200);assert.equal(page.headers.get("cache-control"),"no-cache");assert.match(etag,/^W\/"[0-9a-f]+-[0-9a-f]+"$/);assert.match(await page.text(),/index-Bf3x9Q2a\.js/);
    for(const path of ["/","/index.html","/threads/some-route"]){
      const again=await get(path,{"if-none-match":etag});
      assert.equal(again.status,304,path);assert.equal(again.headers.get("etag"),etag);assert.equal(await again.text(),"",path+" sends no body");
    }
    // A missing asset falls back to index.html, which must not be cached as if it were the asset.
    const missing=await get("/assets/gone-0000aaaa.js");
    assert.equal(missing.status,200);assert.match(missing.headers.get("content-type"),/text\/html/);assert.equal(missing.headers.get("cache-control"),"no-cache");
    // A file outside assets/ has no hash in its name, so it revalidates as index.html does.
    const icon=await get("/trebell-code-icon.svg");
    assert.equal(icon.headers.get("cache-control"),"no-cache");assert.equal(await icon.text(),"<svg/>");
    assert.equal((await get("/trebell-code-icon.svg",{"if-none-match":icon.headers.get("etag")})).status,304);
    // A new build changes index.html, and the old tag no longer matches.
    await new Promise(resolve=>setTimeout(resolve,20));
    await writeFile(join(dist,"index.html"),'<!doctype html><script type="module" src="/assets/index-Zz81kLm0.js"></script>');
    const rebuilt=await get("/",{"if-none-match":etag});
    assert.equal(rebuilt.status,200);assert.notEqual(rebuilt.headers.get("etag"),etag);assert.match(await rebuilt.text(),/index-Zz81kLm0\.js/);
  }finally{await gui?.close();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
