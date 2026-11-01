// Muse Code's releases and updates as Trebell reads them (muse-maintenance.mjs): Meta's channels and the release a channel manifest
// names, invalid manifests and unreadable channels included; the version a program's output names; Muse Code's versions in order
// with their -R revisions; Meta's launcher told from anything else on Windows (muse.cmd beside .muse-launcher.ps1) and elsewhere
// (the launcher script), from files of the test's own; and the environment and command of the launcher's own synchronous update.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMuseLauncher, latestMuseRelease, museChannel, museChannelRelease, museChannelUrl, museUpdateEnvironment, museUpdateRefusal, museUpdateText, museVersionCore, museVersionIn, museVersionOrder, PUBLISHED_MUSE_CHANNELS } from "../src/muse-maintenance.mjs";
import { META_MUSE_CMD, FAKE_META_LAUNCHER } from "./fixtures/muse/fake-muse-launcher.mjs";

test("a channel manifest names its release only in Meta's X.Y.Z-R<revision> form, and the channel is MUSE_CHANNEL or muse-stable",()=>{
  // https://api.meta.ai/muse-code/channels/muse-stable on 2026-10-26.
  assert.equal(museChannelRelease({channel:"muse-stable",version:"1.4.13-R6996.1",manifest_url:"https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.13-R6996.1&file=manifest.json",urgency:"none",notification_text:"",state:"public",min_version:null}),"1.4.13-R6996.1");
  assert.equal(museChannelRelease({version:"1.1.1-R10"}),"1.1.1-R10");
  for(const invalid of [{version:12},{version:"1.1.1"},{version:" 1.4.13-R6996.1"},{version:"1.4.13-R6996.1\n"},{version:"1.4.13-R6996.1-beta"},{version:"1.4.13-R"},{version:"1.4.13-r6996"},{},null,"1.4.13-R6996.1",[]])assert.equal(museChannelRelease(invalid),null,JSON.stringify(invalid));
  assert.equal(museChannel({}),"muse-stable");assert.equal(museChannel({MUSE_CHANNEL:"  "}),"muse-stable");assert.equal(museChannel({MUSE_CHANNEL:"muse-canary"}),"muse-canary");
  assert.equal(museChannel({MUSE_CHANNEL:" muse-canary\n"}),"muse-canary","read trimmed");assert.equal(museChannel(undefined),"muse-stable");
  assert.equal(museChannel({MUSE_CHANNEL:"muse-nightly"}),"muse-nightly","a channel Meta does not publish is still the one named");
  assert.deepEqual(PUBLISHED_MUSE_CHANNELS,["muse-stable","muse-canary"]);assert.ok(Object.isFrozen(PUBLISHED_MUSE_CHANNELS));
  assert.equal(museChannelUrl("muse-canary"),"https://api.meta.ai/muse-code/channels/muse-canary");
});

test("the newest release is read from the channel's manifest within 3 seconds, and an unavailable channel, an invalid manifest or one Meta does not publish has none",async()=>{
  const asked=[],answer=new Map([
    ["https://api.meta.ai/muse-code/channels/muse-stable",()=>Response.json({channel:"muse-stable",version:"1.4.13-R6996.1"})],
    ["https://api.meta.ai/muse-code/channels/muse-canary",()=>Response.json({channel:"muse-canary",version:"1.4.15-R7102.2"})],
  ]);
  const fetchImpl=async(url,options)=>{asked.push([String(url),options?.signal instanceof AbortSignal,options?.headers?.accept]);return answer.get(String(url))?.()||new Response("missing",{status:404})};
  assert.equal(await latestMuseRelease(fetchImpl,"muse-stable"),"1.4.13-R6996.1");
  assert.equal(await latestMuseRelease(fetchImpl,"muse-canary"),"1.4.15-R7102.2");
  assert.equal(await latestMuseRelease(fetchImpl,"muse-nightly"),null,"a channel Meta does not publish is not asked for");
  assert.deepEqual(asked,[["https://api.meta.ai/muse-code/channels/muse-stable",true,"application/json"],["https://api.meta.ai/muse-code/channels/muse-canary",true,"application/json"]]);
  // Answers that name no release, each made afresh for its own read.
  const noRelease={
    "a number for a version":()=>Response.json({channel:"muse-stable",version:12}),
    "a plain X.Y.Z":()=>Response.json({channel:"muse-stable",version:"1.1.1"}),
    "no version at all":()=>Response.json({channel:"muse-stable"}),
    "a JSON string in place of the manifest":()=>Response.json("1.4.13-R6996.1"),
    "an error status":()=>new Response("unavailable",{status:503}),
    "an error status with a manifest":()=>Response.json({version:"1.4.13-R6996.1"},{status:500}),
    "a page that is not JSON":()=>new Response("<html>",{status:200,headers:{"content-type":"text/html"}}),
    "a failed request":()=>{throw new TypeError("fetch failed")},
  };
  for(const [answer,reply] of Object.entries(noRelease))assert.equal(await latestMuseRelease(async()=>reply(),"muse-stable"),null,answer);
  // A channel that does not answer in time has none: the request is given up when the time is out, 3 seconds unless said (re-pinned
  // from 4: Trebell's own bound, the one npm's registry gets).
  const timeout=AbortSignal.timeout,limits=[];AbortSignal.timeout=ms=>{limits.push(ms);return timeout.call(AbortSignal,ms)};
  try{await latestMuseRelease(fetchImpl,"muse-stable")}finally{AbortSignal.timeout=timeout}
  assert.deepEqual(limits,[3000]);
  const hanging=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason)));
  const started=Date.now();assert.equal(await latestMuseRelease(hanging,"muse-stable",{timeoutMs:50}),null);assert.ok(Date.now()-started<2000);
  // The time bounds the manifest's body too: one that starts but never ends names none (the stand-in ends its body when the
  // request is given up, as fetch does).
  const endless=(_url,{signal})=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"version":"1.4'));signal.addEventListener("abort",()=>controller.error(signal.reason))}}));
  const began=Date.now();assert.equal(await latestMuseRelease(endless,"muse-stable",{timeoutMs:50}),null);assert.ok(Date.now()-began<2000);
});

test("a program's output names the first X.Y.Z-R<revision>[.<build>] that stands alone in it, else the first X.Y.Z that does, as written",()=>{
  const named={
    "Muse Code 1.4.13 (1.4.13-R6996.1)\n":"1.4.13-R6996.1",
    "muse 1.4.2, then 1.4.3-R5018":"1.4.3-R5018",
    "1.4.13-R6996.1.2":"1.4.13-R6996.1",
    "1.4.13-R6996.1x":"1.4.13-R6996",
    "1.4.13-R6996.1_":"1.4.13-R6996",
    "1.4.13-R6996x":"1.4.13",
    "1.4.13-r6996":"1.4.13",
    "v1.4.13-R6996.1 or 1.4.2":"1.4.2",
    "1.2.3.4-R5":"2.3.4-R5",
    "(01.002.3)":"01.002.3",
    "\u00e91.4.2\u00e9":"1.4.2",
    "1.4":null,"1.4.x":null,"_1.4.2":null,"1.4.2_":null,"1.4.2a":null,"no version here":null,"":null,
  };
  for(const [output,version] of Object.entries(named))assert.equal(museVersionIn(output),version,JSON.stringify(output));
  assert.equal(museVersionIn(null),null);
  // The X.Y.Z of a version, as written, for the support check.
  assert.equal(museVersionCore("1.4.13-R6996.1"),"1.4.13");assert.equal(museVersionCore("1.4.6-R5018"),"1.4.6");assert.equal(museVersionCore("01.4.2"),"01.4.2");
  for(const notOne of ["Muse Code","1.4.13-R","1.4.13-R6996.1 ","",null])assert.equal(museVersionCore(notOne),null,String(notOne));
});

test("Muse Code's versions are in order by X.Y.Z, then by the -R revision and its build, and a version without one equals each revision of it",()=>{
  assert.ok(museVersionOrder("1.1.1-R9.1","1.1.1-R10.1")<0,"revisions are numbers");
  assert.ok(museVersionOrder("1.1.1-R2514.1","1.1.1-R2514.2")<0);
  assert.ok(museVersionOrder("1.2.0-R1.1","1.1.1-R2514.2")>0);
  assert.equal(museVersionOrder("1.4.3","1.4.3-R5018.1"),0);
  assert.ok(museVersionOrder("1.4.2","1.4.3-R5018.1")<0);
  assert.equal(museVersionOrder("1.4.13-R6996.1","1.4.13-R6996.1"),0);
  assert.ok(museVersionOrder("1.4.13-R6996.1","1.4.14-R7010.1")<0);
  assert.ok(museVersionOrder("1.4.13-R6996","1.4.13-R6996.1")<0);
  assert.ok(museVersionOrder("1.10.0-R1.1","1.9.9-R9999.9")>0,"each part is a number");
  assert.equal(museVersionOrder("Muse Code","1.4.13-R6996.1"),0);
  assert.ok(museVersionOrder(" 1.4.12\n","1.4.13-R6996.1")<0,"each side is read trimmed");assert.ok(museVersionOrder("1.4.14","\t1.4.13-R6996.1 ")>0);
  assert.equal(museVersionOrder("01.4.13","1.4.13-R1"),0,"leading zeros name the same number");
  assert.equal(museVersionOrder("1.4.13-R6996.0","1.4.13-R6996"),0,"no build counts as build 0");
  assert.ok(museVersionOrder("1.4.14","1.4.13-R6996.1")>0);
  for(const notOne of [null,undefined,0,12,{},"1.4","1.4.13-R","1.4.13 -R1","1.4.13-R6996.1-beta"])assert.equal(museVersionOrder(notOne,"1.4.13-R6996.1"),0,String(notOne));
});

test("Meta's launcher is told from any other Muse Code by its files: muse.cmd beside .muse-launcher.ps1 on Windows, the launcher script elsewhere",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-launcher-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const file=async(path,text)=>{await mkdir(join(path,".."),{recursive:true});await writeFile(path,text);return path};
  // Windows: Meta's muse.cmd and launcher, as install.ps1 leaves them.
  const meta=await file(join(root,"Programs","muse","muse.cmd"),META_MUSE_CMD);await file(join(root,"Programs","muse",".muse-launcher.ps1"),FAKE_META_LAUNCHER);
  await file(join(root,"Programs","muse","muse-bin-1.4.13-R6996.1.exe"),"MZ binary");
  assert.equal(isMuseLauncher(meta,{platform:"win32"}),true);
  if(process.platform==="win32")assert.equal(isMuseLauncher(join(root,"Programs","muse","MUSE.CMD"),{platform:"win32"}),true,"Windows spells file names as it likes");
  assert.equal(isMuseLauncher(join(root,"Programs","muse","muse-bin-1.4.13-R6996.1.exe"),{platform:"win32"}),false,"the binary the launcher runs cannot update itself");
  // A muse.cmd with no launcher beside it, beside a script that is not Meta's launcher, or that runs something else.
  const alone=await file(join(root,"alone","muse.cmd"),META_MUSE_CMD);
  const other=await file(join(root,"other","muse.cmd"),META_MUSE_CMD);await file(join(root,"other",".muse-launcher.ps1"),"& muse-bin.exe @args\r\n");
  const wrapper=await file(join(root,"wrapper","muse.cmd"),'@echo off\r\n"%~dp0muse-bin-1.4.13-R6996.1.exe" %*\r\n');await file(join(root,"wrapper",".muse-launcher.ps1"),FAKE_META_LAUNCHER);
  const large=await file(join(root,"large","muse.cmd"),META_MUSE_CMD);await file(join(root,"large",".muse-launcher.ps1"),FAKE_META_LAUNCHER+"#".repeat(1025*1024));
  for(const path of [alone,other,wrapper,large,join(root,"missing","muse.cmd")])assert.equal(isMuseLauncher(path,{platform:"win32"}),false,path);
  // Elsewhere: install.sh's ~/.local/bin/muse is the launcher script itself, a small script naming its user agent and MUSE_SYNC_UPDATE.
  const script=await file(join(root,"home",".local","bin","muse"),'#!/usr/bin/env bash\nset -euo pipefail\nuser_agent="muse-code/launcher-4"\nif [[ "${MUSE_SYNC_UPDATE:-0}" == 1 ]]; then update_binary; fi\nexec "$binary" "$@"\n');
  assert.equal(isMuseLauncher(script,{platform:"linux"}),true);
  assert.equal(isMuseLauncher(script,{platform:"darwin"}),true);
  const standalone=await file(join(root,"opt","muse"),"\u007fELF standalone binary");
  const half=await file(join(root,"half","muse"),'#!/bin/sh\n# muse-code/launcher-4\nexec muse-bin "$@"\n');
  const unnamed=await file(join(root,"unnamed","muse"),'#!/bin/sh\nif [ "${MUSE_SYNC_UPDATE:-0}" = 1 ]; then update_binary; fi\nexec muse-bin "$@"\n');
  for(const path of [standalone,half,unnamed,join(root,"missing","muse"),""])assert.equal(isMuseLauncher(path,{platform:"linux"}),false,path);
  assert.equal(isMuseLauncher(meta,{platform:"linux"}),false,"muse.cmd is no launcher script on Linux");
  assert.equal(isMuseLauncher(meta.replaceAll("\\","/"),{platform:"win32"}),true,"either separator names the launcher's folder");
  for(const path of [null,undefined])assert.equal(isMuseLauncher(path,{platform:"win32"}),false);
});

// Re-pinned note: the limit is Trebell's own 1 MiB now, above 2.1.2's 128 KiB, so every launcher 2.1.2 read is still read.
test("a launcher script is read only when it holds at most 1 MiB, and a folder is no launcher",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-script-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const head='#!/bin/sh\n# user agent muse-code/launcher-4; updates first when MUSE_SYNC_UPDATE=1\n';
  const sized=async(name,bytes)=>{const path=join(root,name);await writeFile(path,head+"#".repeat(bytes-Buffer.byteLength(head)));return path};
  assert.equal(isMuseLauncher(await sized("at-limit",1024*1024),{platform:"linux"}),true,"1 MiB is read");
  assert.equal(isMuseLauncher(await sized("over-limit",1024*1024+1),{platform:"linux"}),false,"one byte more is not");
  await mkdir(join(root,"folder"));
  assert.equal(isMuseLauncher(join(root,"folder"),{platform:"linux"}),false);
  // On Windows, muse.cmd and the launcher beside it are held to the same limit, and a folder in the launcher's place is none.
  const windows=async(name,launcher)=>{const folder=join(root,name);await mkdir(folder);await writeFile(join(folder,"muse.cmd"),META_MUSE_CMD);await launcher(join(folder,".muse-launcher.ps1"));return join(folder,"muse.cmd")};
  const exact=await windows("exact",path=>writeFile(path,Buffer.concat([Buffer.from(FAKE_META_LAUNCHER),Buffer.alloc(1024*1024,"#")]).subarray(0,1024*1024)));
  const folderLauncher=await windows("folder-launcher",path=>mkdir(path));
  assert.equal(isMuseLauncher(exact,{platform:"win32"}),true);
  assert.equal(isMuseLauncher(folderLauncher,{platform:"win32"}),false);
});

test("the launcher's own update runs its --version with its update on, synchronous and due, on the profile's channel, and says so",()=>{
  const env={PATH:"C:\\Windows",MUSE_NO_AUTO_UPDATE:"1",MUSE_CHANNEL:"muse-canary"};
  assert.deepEqual(museUpdateEnvironment(env),{PATH:"C:\\Windows",MUSE_CHANNEL:"muse-canary",MUSE_NO_AUTO_UPDATE:"0",MUSE_SYNC_UPDATE:"1",MUSE_UPDATE_INTERVAL_SECONDS:"0"});
  assert.deepEqual(env,{PATH:"C:\\Windows",MUSE_NO_AUTO_UPDATE:"1",MUSE_CHANNEL:"muse-canary"},"the profile's own environment is left as it was");
  assert.deepEqual(museUpdateEnvironment({}),{MUSE_NO_AUTO_UPDATE:"0",MUSE_SYNC_UPDATE:"1",MUSE_UPDATE_INTERVAL_SECONDS:"0"});
  assert.equal(museUpdateText("C:\\Users\\me\\AppData\\Local\\Programs\\muse\\muse.cmd",{},"win32"),"C:\\Users\\me\\AppData\\Local\\Programs\\muse\\muse.cmd --version (with MUSE_NO_AUTO_UPDATE=0, MUSE_SYNC_UPDATE=1 and MUSE_UPDATE_INTERVAL_SECONDS=0)");
  assert.equal(museUpdateText("/home/me/custom muse",{MUSE_CHANNEL:"muse-canary"},"linux"),"'/home/me/custom muse' --version (with MUSE_CHANNEL=muse-canary, MUSE_NO_AUTO_UPDATE=0, MUSE_SYNC_UPDATE=1 and MUSE_UPDATE_INTERVAL_SECONDS=0)");
  assert.equal(museUpdateRefusal("D:\\tools\\muse-bin-1.4.13-R6996.1.exe"),"Trebell Code updates Muse Code only through Meta's launcher, which Meta's installer puts in place, and D:\\tools\\muse-bin-1.4.13-R6996.1.exe is not it: update it the way you installed it. Nothing was installed.");
});
