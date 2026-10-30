// Muse Code's releases and updates as Trebell reads them (muse-maintenance.mjs): the release a channel manifest names, invalid
// manifests and unreadable channels included; Muse Code's versions in order with
// their -R revisions; Meta's launcher told from anything else on Windows (muse.cmd beside .muse-launcher.ps1) and elsewhere (the
// launcher script), from files of the test's own; and the environment and command of the launcher's own synchronous update.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareMuseVersions, isMuseLauncher, latestMuseRelease, museChannel, museChannelRelease, museUpdateEnvironment, museUpdateRefusal, museUpdateText } from "../src/muse-maintenance.mjs";
import { META_MUSE_CMD, FAKE_META_LAUNCHER } from "./fixtures/muse/fake-muse-launcher.mjs";

test("a channel manifest names its release only in Meta's X.Y.Z-R<revision> form, and the channel is MUSE_CHANNEL or muse-stable",()=>{
  // https://api.meta.ai/muse-code/channels/muse-stable on 2026-10-26.
  assert.equal(museChannelRelease({channel:"muse-stable",version:"1.4.13-R6996.1",manifest_url:"https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.13-R6996.1&file=manifest.json",urgency:"none",notification_text:"",state:"public",min_version:null}),"1.4.13-R6996.1");
  assert.equal(museChannelRelease({version:"1.1.1-R10"}),"1.1.1-R10");
  for(const invalid of [{version:12},{version:"1.1.1"},{version:" 1.4.13-R6996.1"},{version:"1.4.13-R6996.1-beta"},{},null,"1.4.13-R6996.1",[]])assert.equal(museChannelRelease(invalid),null,JSON.stringify(invalid));
  assert.equal(museChannel({}),"muse-stable");assert.equal(museChannel({MUSE_CHANNEL:"  "}),"muse-stable");assert.equal(museChannel({MUSE_CHANNEL:"muse-canary"}),"muse-canary");
});

test("the newest release is read from the channel's manifest within 4 seconds, and an unavailable channel, an invalid manifest or one Meta does not publish has none",async()=>{
  const asked=[],answer=new Map([
    ["https://api.meta.ai/muse-code/channels/muse-stable",()=>Response.json({channel:"muse-stable",version:"1.4.13-R6996.1"})],
    ["https://api.meta.ai/muse-code/channels/muse-canary",()=>Response.json({channel:"muse-canary",version:"1.4.15-R7102.2"})],
  ]);
  const fetchImpl=async(url,options)=>{asked.push([String(url),options?.signal instanceof AbortSignal]);return answer.get(String(url))?.()||new Response("missing",{status:404})};
  assert.equal(await latestMuseRelease(fetchImpl,"muse-stable"),"1.4.13-R6996.1");
  assert.equal(await latestMuseRelease(fetchImpl,"muse-canary"),"1.4.15-R7102.2");
  assert.equal(await latestMuseRelease(fetchImpl,"muse-nightly"),null,"a channel Meta does not publish is not asked for");
  assert.deepEqual(asked,[["https://api.meta.ai/muse-code/channels/muse-stable",true],["https://api.meta.ai/muse-code/channels/muse-canary",true]]);
  for(const response of [Response.json({version:12}),Response.json({version:"1.1.1"}),new Response("unavailable",{status:503}),new Response("<html>",{status:200,headers:{"content-type":"text/html"}})])
    assert.equal(await latestMuseRelease(async()=>response,"muse-stable"),null);
  assert.equal(await latestMuseRelease(async()=>{throw new TypeError("fetch failed")},"muse-stable"),null);
  // A channel that does not answer in time has none: the request is given up when the time is out, 4 seconds unless said.
  const timeout=AbortSignal.timeout,limits=[];AbortSignal.timeout=ms=>{limits.push(ms);return timeout.call(AbortSignal,ms)};
  try{await latestMuseRelease(fetchImpl,"muse-stable")}finally{AbortSignal.timeout=timeout}
  assert.deepEqual(limits,[4000]);
  const hanging=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason)));
  const started=Date.now();assert.equal(await latestMuseRelease(hanging,"muse-stable",{timeoutMs:50}),null);assert.ok(Date.now()-started<2000);
});

test("Muse Code's versions are in order by X.Y.Z, then by the -R revision and its build, and a version without one equals each revision of it",()=>{
  assert.ok(compareMuseVersions("1.1.1-R9.1","1.1.1-R10.1")<0,"revisions are numbers");
  assert.ok(compareMuseVersions("1.1.1-R2514.1","1.1.1-R2514.2")<0);
  assert.ok(compareMuseVersions("1.2.0-R1.1","1.1.1-R2514.2")>0);
  assert.equal(compareMuseVersions("1.4.3","1.4.3-R5018.1"),0);
  assert.ok(compareMuseVersions("1.4.2","1.4.3-R5018.1")<0);
  assert.equal(compareMuseVersions("1.4.13-R6996.1","1.4.13-R6996.1"),0);
  assert.ok(compareMuseVersions("1.4.13-R6996.1","1.4.14-R7010.1")<0);
  assert.ok(compareMuseVersions("1.4.13-R6996","1.4.13-R6996.1")<0);
  assert.ok(compareMuseVersions("1.10.0-R1.1","1.9.9-R9999.9")>0,"each part is a number");
  assert.equal(compareMuseVersions("Muse Code","1.4.13-R6996.1"),0);
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
  const large=await file(join(root,"large","muse.cmd"),META_MUSE_CMD);await file(join(root,"large",".muse-launcher.ps1"),FAKE_META_LAUNCHER+"#".repeat(130*1024));
  for(const path of [alone,other,wrapper,large,join(root,"missing","muse.cmd")])assert.equal(isMuseLauncher(path,{platform:"win32"}),false,path);
  // Elsewhere: install.sh's ~/.local/bin/muse is the launcher script itself, a small script naming its user agent and MUSE_SYNC_UPDATE.
  const script=await file(join(root,"home",".local","bin","muse"),'#!/usr/bin/env bash\nset -euo pipefail\nuser_agent="muse-code/launcher-4"\nif [[ "${MUSE_SYNC_UPDATE:-0}" == 1 ]]; then update_binary; fi\nexec "$binary" "$@"\n');
  assert.equal(isMuseLauncher(script,{platform:"linux"}),true);
  assert.equal(isMuseLauncher(script,{platform:"darwin"}),true);
  const standalone=await file(join(root,"opt","muse"),"\u007fELF standalone binary");
  const half=await file(join(root,"half","muse"),'#!/bin/sh\n# muse-code/launcher-4\nexec muse-bin "$@"\n');
  for(const path of [standalone,half,join(root,"missing","muse"),""])assert.equal(isMuseLauncher(path,{platform:"linux"}),false,path);
  assert.equal(isMuseLauncher(meta,{platform:"linux"}),false,"muse.cmd is no launcher script on Linux");
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
