import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityRegistryTarget, configureAntigravityAuth, installAntigravityRuntime, readAntigravityAuthState } from "../src/antigravity-runtime-installer.mjs";

test("Antigravity ACP registry target matches supported platform/architecture names",()=>{
  assert.equal(antigravityRegistryTarget("win32","x64"),"windows-x86_64");
  assert.equal(antigravityRegistryTarget("win32","arm64"),"windows-aarch64");
  assert.equal(antigravityRegistryTarget("darwin","arm64"),"darwin-aarch64");
  assert.equal(antigravityRegistryTarget("linux","x64"),"linux-x86_64");
  assert.equal(antigravityRegistryTarget("freebsd","x64"),null);
});

test("managed Antigravity installation follows the curated ACP registry entry",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-antigravity-install-"));let calls=0;
  const registry={agents:[{id:"antigravity-acp",version:"fixture-1",distribution:{binary:{"windows-x86_64":{archive:"https://dl.google.com/agy-extensions/releases/windows/fixture.zip",cmd:"./agy_acp_server.exe"}}}}]};
  const fetchImpl=async()=>{
    calls++;
    if(calls===1)return {ok:true,json:async()=>registry};
    return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.close()}})};
  };
  try{
    const result=await installAntigravityRuntime({env:{TREBELL_HOME:home},platform:"win32",arch:"x64",fetchImpl,extractImpl:async(_archive,{dir})=>{await writeFile(join(dir,"agy_acp_server.exe"),"fixture");await writeFile(join(dir,"localharness_external.exe"),"helper")}});
    assert.equal(result.version,"fixture-1");await access(result.binary);
    await access(join(home,"agent-runtimes","antigravity","current","localharness_external.exe"));
    const metadata=JSON.parse(await readFile(join(home,"agent-runtimes","antigravity","current","install.json"),"utf8"));
    assert.equal(metadata.source,"acp-registry");assert.equal(metadata.target,"windows-x86_64");assert.equal(calls,2);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("Antigravity auth configuration preserves unrelated settings and never requires reading the token",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-antigravity-auth-")),env={GEMINI_HOME:join(home,"gemini")},root=join(env.GEMINI_HOME,"antigravity-acp");
  const { mkdir }=await import("node:fs/promises");
  try{
    await mkdir(root,{recursive:true});await writeFile(join(root,"settings.json"),JSON.stringify({theme:"dark",auth:{keep:"yes"}}));
    await configureAntigravityAuth("oauth-personal",{env});
    let state=await readAntigravityAuthState({env});assert.equal(state.configured,true);assert.equal(state.methodId,"oauth-personal");assert.equal(state.tokenPresent,false);
    const settings=JSON.parse(await readFile(join(root,"settings.json"),"utf8"));assert.equal(settings.theme,"dark");assert.equal(settings.auth.keep,"yes");assert.equal(settings.auth.type,"oauth-personal");
    await writeFile(join(root,"acp_token.json"),"opaque-token-fixture");state=await readAntigravityAuthState({env});assert.equal(state.tokenPresent,true);
    await assert.rejects(()=>configureAntigravityAuth("not-a-method",{env}),/Unsupported Antigravity authentication method/);
  }finally{await rm(home,{recursive:true,force:true})}
});
