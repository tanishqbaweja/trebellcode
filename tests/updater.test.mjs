import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createUpdaterController } from "../desktop/updater-controller.mjs";

const root=new URL("../",import.meta.url);

class FakeUpdater extends EventEmitter{
  constructor(){super();this.autoDownload=true;this.autoInstallOnAppQuit=true;this.allowPrerelease=true;this.checkCalls=0;this.downloadCalls=0;this.installCalls=[];this.checkError=null;this.downloadError=null;this.installError=null}
  async checkForUpdates(){this.checkCalls++;if(this.checkError)throw this.checkError}
  async downloadUpdate(){this.downloadCalls++;if(this.downloadError)throw this.downloadError;this.emit("download-progress",{percent:42,transferred:420,total:1000});this.emit("update-downloaded",{version:"2.0.0",releaseName:"Two"})}
  quitAndInstall(silent,forceRunAfter){this.installCalls.push([silent,forceRunAfter]);if(this.installError)throw this.installError}
}

function packagedApp(){return {isPackaged:true,getVersion:()=>"1.0.0"}}

test("desktop updater enforces explicit download and install with executable state transitions",async()=>{
  const updater=new FakeUpdater(),states=[];let scheduled=null,beforeInstallCalls=0;
  const controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,onState:state=>states.push(state),beforeInstall:async()=>{beforeInstallCalls++},scheduleInstall:fn=>{scheduled=fn}});
  assert.equal(controller.configure().status,"idle");assert.equal(updater.autoDownload,false);assert.equal(updater.autoInstallOnAppQuit,false);assert.equal(updater.allowPrerelease,false);
  await assert.rejects(()=>controller.download(),/No downloadable update/);await assert.rejects(()=>controller.install(),/Download the update/);
  updater.emit("checking-for-update");assert.equal(controller.getState().status,"checking");
  updater.emit("update-available",{version:"2.0.0",releaseName:"Two"});assert.equal(controller.getState().status,"available");assert.equal(controller.getState().availableVersion,"2.0.0");
  const downloaded=await controller.download();assert.equal(updater.downloadCalls,1);assert.equal(downloaded.status,"downloaded");assert.equal(downloaded.percent,100);assert.equal(states.some(state=>state.status==="downloading"&&state.percent===42),true);
  const installed=await controller.install();assert.equal(installed.ok,true);assert.equal(beforeInstallCalls,1);assert.equal(controller.getState().status,"installing");assert.equal(updater.installCalls.length,0);assert.equal(typeof scheduled,"function");
  scheduled();assert.deepEqual(updater.installCalls,[[false,true]]);
});

test("desktop updater surfaces check and download failures instead of leaving stale progress",async()=>{
  const updater=new FakeUpdater(),controller=createUpdaterController({app:packagedApp(),autoUpdater:updater});controller.configure();
  updater.checkError=new Error("check failed");await assert.rejects(()=>controller.check(),/check failed/);assert.equal(controller.getState().status,"error");assert.equal(controller.getState().error,"check failed");
  updater.checkError=null;updater.emit("update-available",{version:"2.0.0"});updater.downloadError=new Error("download failed");await assert.rejects(()=>controller.download(),/download failed/);assert.equal(controller.getState().status,"error");assert.equal(controller.getState().error,"download failed");
});

test("desktop updater keeps a downloaded update retryable when pre-install cleanup fails",async()=>{
  const updater=new FakeUpdater(),controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,beforeInstall:async()=>{throw new Error("cleanup failed")}});controller.configure();updater.emit("update-downloaded",{version:"2.0.0"});
  await assert.rejects(()=>controller.install(),/cleanup failed/);assert.equal(controller.getState().status,"downloaded");assert.equal(controller.getState().error,"cleanup failed");assert.equal(updater.installCalls.length,0);
});

test("desktop updater recovers a downloaded update when installer launch fails",async()=>{
  const updater=new FakeUpdater();updater.installError=new Error("installer launch failed");let recovered=null;
  const controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,scheduleInstall:fn=>fn(),onInstallLaunchFailure:error=>{recovered=error.message}});controller.configure();updater.emit("update-downloaded",{version:"2.0.0"});
  const result=await controller.install();assert.equal(result.ok,true);assert.equal(recovered,"installer launch failed");assert.equal(controller.getState().status,"downloaded");assert.equal(controller.getState().error,"installer launch failed");assert.deepEqual(updater.installCalls,[[false,true]]);
});

test("desktop updater reports development mode and rejects package-only actions",async()=>{
  const updater=new FakeUpdater(),controller=createUpdaterController({app:{isPackaged:false,getVersion:()=>"dev"},autoUpdater:updater});assert.equal(controller.configure().status,"development");assert.equal((await controller.check()).status,"development");assert.equal(updater.checkCalls,0);await assert.rejects(()=>controller.download(),/packaged builds/);await assert.rejects(()=>controller.install(),/packaged builds/);
});

test("packaged desktop wiring keeps explicit updater controls and release metadata",async()=>{
  const [main,controller,preload,pkg,release]=await Promise.all([
    readFile(new URL("desktop/main.mjs",root),"utf8"),
    readFile(new URL("desktop/updater-controller.mjs",root),"utf8"),
    readFile(new URL("desktop/preload.cjs",root),"utf8"),
    readFile(new URL("package.json",root),"utf8").then(JSON.parse),
    readFile(new URL("scripts/make-windows-release.ps1",root),"utf8"),
  ]);
  assert.match(main,/createUpdaterController/);assert.match(controller,/autoUpdater\.autoDownload=false/);assert.match(controller,/autoUpdater\.autoInstallOnAppQuit=false/);
  assert.match(main,/desktop:update:check/);assert.match(main,/desktop:update:download/);assert.match(main,/desktop:update:install/);assert.match(preload,/updates:\s*\{/);assert.match(preload,/desktop:update:state/);
  assert.equal(pkg.dependencies?.["electron-updater"],"^6.8.9");assert.deepEqual(pkg.build?.publish?.[0],{provider:"github",owner:"tanishqbaweja",repo:"trebellcode"});
  assert.match(release,/latest\.yml required by the in-app updater/);assert.match(release,/NSIS build is missing resources\\app-update\.yml required by electron-updater/);assert.match(release,/\$LatestYml/);assert.match(release,/\$Blockmap/);assert.match(release,/function Stop-GeneratedDesktopProcesses/);assert.match(release,/function Reset-ReleaseOutput/);assert.match(release,/Reset-ReleaseOutput[\s\S]*electron-builder","--win","nsis"/);assert.match(release,/taskkill\.exe \/PID \$DesktopProcess\.Id \/T \/F/);assert.match(release,/Fresh packaged Trebell runtime did not become ready for model-driven validation/);assert.match(release,/TREBELL_TEST_HIDDEN/);
});
