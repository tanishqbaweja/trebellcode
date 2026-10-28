import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

// electron-updater fails a check or a download with its own text: a net:: code, or an HttpError whose message is the status line, the
// request and the response's headers, often inside a longer message with its stack. It says so through its error event, then rejects.
const fromUpdater=createRequire(createRequire(import.meta.url).resolve("electron-updater"));
const { createHttpError, newError }=fromUpdater("builder-util-runtime");
const githubNotFound=()=>createHttpError({statusCode:404,statusMessage:"",headers:{server:"GitHub.com","content-type":"text/plain; charset=utf-8","x-github-request-id":"E3A1:2B3C:4D5E6F"}},"method: GET url: https://github.com/tanishqbaweja/trebellcode/releases.atom\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n");

test("desktop updater says why a check or a download failed in the app's own words instead of electron-updater's text, and leaves no stale progress",async()=>{
  const updater=new FakeUpdater(),states=[],controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,onState:state=>states.push(state)});controller.configure();
  const failing=error=>async()=>{updater.emit("checking-for-update");updater.emit("error",error);throw error};
  const checks=[];
  for(const error of [
    new Error("net::ERR_INTERNET_DISCONNECTED"),
    githubNotFound(),
    newError(`Cannot find latest.yml in the latest release artifacts (https://github.com/tanishqbaweja/trebellcode/releases/download/v2.0.0/latest.yml): ${githubNotFound().stack}`,"ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"),
    newError(`Unable to find latest version on GitHub (https://github.com/tanishqbaweja/trebellcode/releases/latest), please ensure a production release exists: ${new Error("net::ERR_NAME_NOT_RESOLVED").stack}`,"ERR_UPDATER_LATEST_VERSION_NOT_FOUND"),
  ]){
    updater.checkForUpdates=failing(error);
    const rejected=await controller.check().then(()=>"checked",failure=>failure.message);
    checks.push({rejected,shown:controller.getState().error,status:controller.getState().status});
  }
  const offline="Could not check for updates: there is no connection to the release server.",notFound="Could not check for updates: the release server answered 404 Not Found.";
  assert.deepEqual(checks,[offline,notFound,notFound,offline].map(said=>({rejected:said,shown:said,status:"error"})));
  const downloads=[];
  for(const error of [new Error("net::ERR_CONNECTION_RESET"),new Error('Cannot download "https://github.com/tanishqbaweja/trebellcode/releases/download/v2.0.0/Trebell-Code-Setup-2.0.0.exe", status 404: Not Found')]){
    updater.emit("update-available",{version:"2.0.0"});
    updater.downloadUpdate=async()=>{updater.emit("download-progress",{percent:42,transferred:420,total:1000});updater.emit("error",error);throw error};
    const rejected=await controller.download().then(()=>"downloaded",failure=>failure.message);
    downloads.push({rejected,shown:controller.getState().error,status:controller.getState().status});
  }
  assert.deepEqual(downloads,["Could not download the update: there is no connection to the release server.","Could not download the update: the release server answered 404 Not Found."].map(said=>({rejected:said,shown:said,status:"error"})));
  assert.deepEqual(states.filter(state=>/net::|HttpError|Headers|https?:/.test(state.error||"")).map(state=>state.error),[],"no state shows electron-updater's own text");
});

test("desktop updater keeps a downloaded update retryable when pre-install cleanup fails",async()=>{
  const updater=new FakeUpdater(),controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,beforeInstall:async()=>{throw new Error("cleanup failed")}});controller.configure();updater.emit("update-downloaded",{version:"2.0.0"});
  await assert.rejects(()=>controller.install(),/cleanup failed/);assert.equal(controller.getState().status,"downloaded");assert.equal(controller.getState().error,"cleanup failed");assert.equal(updater.installCalls.length,0);
});

test("desktop updater recovers a downloaded update when installer launch fails",async()=>{
  const updater=new FakeUpdater();updater.installError=new Error("installer launch failed");let recovered=null;
  const controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,scheduleInstall:fn=>fn(),onInstallLaunchFailure:error=>{recovered=error.message}});controller.configure();updater.emit("update-downloaded",{version:"2.0.0"});
  const result=await controller.install();assert.equal(result.ok,true);assert.equal(recovered,"installer launch failed");assert.equal(controller.getState().status,"downloaded");assert.equal(controller.getState().error,"Could not install the update: the installer did not start.");assert.deepEqual(updater.installCalls,[[false,true]]);
});

// electron-updater does not throw for an installer it cannot start: its install() says why through the error event, and quitAndInstall
// returns without quitting, after the shell closed its server for the install.
test("desktop updater recovers a downloaded update when electron-updater reports that its installer did not start",async()=>{
  const updater=new FakeUpdater();updater.quitAndInstall=function(silent,forceRunAfter){this.installCalls.push([silent,forceRunAfter]);this.emit("error",new Error("No update filepath provided, can't quit and install"))};
  let recovered=null;
  const controller=createUpdaterController({app:packagedApp(),autoUpdater:updater,scheduleInstall:fn=>fn(),onInstallLaunchFailure:error=>{recovered=error.message}});controller.configure();updater.emit("update-downloaded",{version:"2.0.0"});
  const result=await controller.install();assert.equal(result.ok,true);assert.equal(recovered,"No update filepath provided, can't quit and install","the shell brings the app back");
  assert.equal(controller.getState().status,"downloaded");assert.equal(controller.getState().error,"Could not install the update: the installer did not start.");
  assert.equal(updater.listenerCount("error"),1,"only the controller's own error listener stays");assert.deepEqual(updater.installCalls,[[false,true]]);
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
  assert.match(main,/desktop:window:screenshot/);assert.match(main,/capturePage\(\)/);assert.match(preload,/captureWindow:\s*\(\)\s*=>\s*invoke\("desktop:window:screenshot"\)/);
  assert.equal(pkg.dependencies?.["electron-updater"],"^6.8.9");assert.deepEqual(pkg.build?.publish?.[0],{provider:"github",owner:"tanishqbaweja",repo:"trebellcode-releases"});
  // The release goes where the updater reads (build.publish), and the source commit gets the release's tag.
  assert.match(release,/\$ReleaseRepo = "\$\(\$Publication\.owner\)\/\$\(\$Publication\.repo\)"/);assert.doesNotMatch(release,/--repo","tanishqbaweja\/trebellcode"/);assert.match(release,/@\("push","origin",\$Tag\)/);
  const dependencyInstall=release.indexOf('Invoke-Native "npm" @("install","--no-audit","--no-fund","--include=optional")'),electronCheck=release.indexOf('if (-not (Test-Path $ElectronExe))');
  assert.ok(dependencyInstall>=0&&electronCheck>dependencyInstall,"release bootstrap must install dependencies before requiring the Electron distribution");
  assert.equal((release.match(/"--publish","never"/g)||[]).length,2,"release packaging must disable electron-builder implicit GitHub publication for both unpacked and NSIS builds");
  assert.match(release,/latest\.yml required by the in-app updater/);assert.match(release,/NSIS build is missing resources\\app-update\.yml required by electron-updater/);assert.match(release,/\$LatestYml/);assert.match(release,/\$Blockmap/);assert.match(release,/function Stop-GeneratedDesktopProcesses/);assert.match(release,/function Remove-GeneratedPath/);assert.match(release,/function Reset-ReleaseOutput/);assert.match(release,/function New-IsolatedPackagingOutput/);assert.match(release,/GetTempPath/);assert.match(release,/LocalApplicationData/);assert.match(release,/MinimumFreeBytes = 8GB/);assert.match(release,/AvailableFreeSpace/);assert.match(release,/Windows packaging needs at least 8 GB free/);assert.match(release,/function Invoke-UnpackedWindowsBuild/);assert.match(release,/function Invoke-WindowsInstallerBuild/);assert.match(release,/--config\.directories\.output=\$Output"\s*\) \| Out-Host/);assert.match(release,/Unpacked Windows packaging attempt \$Attempt failed; retrying once/);assert.match(release,/Windows installer packaging attempt \$Attempt failed; retrying once/);assert.match(release,/trebell-release-unpacked-/);assert.match(release,/trebell-release-installer-/);assert.match(release,/--config\.electronDist=\$ElectronDist/);assert.match(release,/--config\.directories\.output=\$Output/);assert.match(release,/Copy-Item -LiteralPath \$BuiltInstaller -Destination \$Installer/);assert.match(release,/try \{ & taskkill\.exe \/PID \$Process\.Id \/T \/F \*> \$null \} catch \{\}/);assert.match(release,/Fresh packaged Trebell runtime did not become ready for model-driven validation after two launch attempts/);assert.match(release,/TREBELL_TEST_HIDDEN/);
  assert.match(release,/function Stop-DesktopProcessTree/);assert.match(release,/WaitForExit\(5000\)/);assert.match(release,/WaitForExit\(2000\)/);assert.match(release,/Stop-DesktopProcessTree \$DesktopProcess/);assert.match(release,/for \(\$LaunchAttempt = 1; \$LaunchAttempt -le 2 -and -not \$AgentRuntimeReady; \$LaunchAttempt\+\+\)/);assert.match(release,/retrying once with new ports/);assert.match(release,/\$GuiPort = Get-FreeTcpPort[\s\S]*\$AppPort = Get-FreeTcpPort[\s\S]*\$CdpPort = Get-FreeTcpPort[\s\S]*\$FixturePort = Get-FreeTcpPort/);
});
