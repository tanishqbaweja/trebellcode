import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractBalance, getFreebuffOverview, normalizeModelId, priceForModel } from "../src/freebuff-product.mjs";
import { credentialsPath } from "../src/paths.mjs";

test("normalizes Freebuff provider-prefixed model ids", () => {
  assert.equal(normalizeModelId("freebuff/deepseek/deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
});

test("extracts Freebucks balance from common session shapes", () => {
  assert.equal(extractBalance({ freebucks: { balance: 42 } }), 42);
  assert.equal(extractBalance({ freebucks: 18 }), 18);
  assert.equal(extractBalance({ balance: 7 }), 7);
});

test("server pricing overrides documented fallback", () => {
  const price=priceForModel("freebuff/deepseek/deepseek-v4-flash", {
    "deepseek/deepseek-v4-flash": 12,
  }, new Date("2026-09-20T12:00:00Z"));
  assert.equal(price.current,12);
  assert.equal(price.source,"server");
});

test("documented DeepSeek off-peak fallback is 10 Freebucks between 22:00 and 06:00 UTC", () => {
  const offPeak=priceForModel("deepseek/deepseek-v4-flash", null, new Date("2026-09-20T23:00:00Z"));
  const peak=priceForModel("deepseek/deepseek-v4-flash", null, new Date("2026-09-20T12:00:00Z"));
  assert.equal(offPeak.current,10);
  assert.equal(offPeak.offPeakActive,true);
  assert.equal(peak.current,15);
  assert.equal(peak.offPeakActive,false);
});

test("Freebuff overview uses its injected fetch implementation for proxy and account requests",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-freebuff-fetch-"));
  const env={TREBELL_HOME:home};
  const path=credentialsPath(env);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,JSON.stringify({default:{authToken:"test-token",id:"user-1"}}));
  const urls=[];
  const fetchImpl=async(input)=>{
    const url=String(input instanceof URL?input.href:input?.url||input);urls.push(url);
    if(url.includes("/trebell/session-state"))return new Response(JSON.stringify({sessions:{}}),{status:200,headers:{"content-type":"application/json"}});
    if(url.endsWith("/api/v1/freebuff/session"))return new Response(JSON.stringify({freebucks:{balance:12},status:"active"}),{status:200,headers:{"content-type":"application/json"}});
    if(url.endsWith("/api/v1/freebuff/streak"))return new Response(JSON.stringify({streak:3}),{status:200,headers:{"content-type":"application/json"}});
    throw new Error("Unexpected URL: "+url);
  };
  try{
    const overview=await getFreebuffOverview({env,bridgePort:24444,apiHost:"https://freebuff.invalid",fetchImpl});
    assert.equal(overview.loggedIn,true);
    assert.equal(overview.derived.balance,12);
    assert.deepEqual(urls,[
      "http://127.0.0.1:24444/trebell/session-state",
      "https://freebuff.invalid/api/v1/freebuff/session",
      "https://freebuff.invalid/api/v1/freebuff/streak",
    ]);
  }finally{
    await rm(home,{recursive:true,force:true});
  }
});
