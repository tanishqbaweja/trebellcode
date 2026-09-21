import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const nodeBinDir=dirname(process.execPath);
const npmBin=join(nodeBinDir,"npm");
const npxBin=join(nodeBinDir,"npx");
function run(command,args,env={}){
  console.log(">>>",command,...args);
  execFileSync(command,args,{cwd:root,stdio:"inherit",env:{...process.env,...env}});
}

const prebuiltWine=process.env.TREBELL_PREBUILT_WINE==="1";
if(!prebuiltWine){
  run("dpkg",["--add-architecture","i386"]);
  run("apt-get",["update"]);
  run("apt-get",["install","-y","wine","wine64","wine32:i386","xvfb","xauth"]);
}

run(npmBin,["install","--no-audit","--no-fund","--include=optional"]);

const winCodex=join(root,"node_modules","@openai","codex-win32-x64");
if(!existsSync(winCodex)){
  run(npmBin,["install","--force","--no-save","@openai/codex-win32-x64@npm:@openai/codex@0.154.0-win32-x64"]);
}

run(npmBin,["run","prepare:icon"]);
run(npmBin,["run","bridge:build"]);
run(npmBin,["run","ui:build"]);

const builderArgs=["electron-builder","--win","nsis","--x64","--config.npmRebuild=false"];
if(prebuiltWine){
  run(npxBin,builderArgs,{WINEARCH:"win64"});
}else{
  run("xvfb-run",["-a",npxBin,...builderArgs],{WINEARCH:"win64"});
}

const name="Trebell-Code-Setup-1.1.0.exe";
const installer=join(root,"desktop-dist",name);
if(!existsSync(installer))throw new Error("Installer was not produced: "+installer);

const bytes=readFileSync(installer);
const sha256=createHash("sha256").update(bytes).digest("hex");
const downloads=join(root,"ui","dist","downloads");
mkdirSync(downloads,{recursive:true});
copyFileSync(installer,join(downloads,name));
writeFileSync(join(downloads,"release.json"),JSON.stringify({
  name,
  version:"1.1.0",
  bytes:bytes.length,
  sha256,
  sourceSha:process.env.RAILWAY_GIT_COMMIT_SHA||process.env.TB_SOURCE_SHA||null,
},null,2));
console.log("TREBELL_WINDOWS_INSTALLER_PASS",JSON.stringify({name,bytes:bytes.length,sha256,sourceSha:process.env.RAILWAY_GIT_COMMIT_SHA||process.env.TB_SOURCE_SHA||null}));
