import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
function run(command,args,env={}){
  console.log(">>>",command,...args);
  execFileSync(command,args,{cwd:root,stdio:"inherit",env:{...process.env,...env}});
}

run("apt-get",["update"]);
run("apt-get",["install","-y","wine64","wine"]);
run("npm",["install","--no-audit","--no-fund","--include=optional"]);

const winCodex=join(root,"node_modules","@openai","codex-win32-x64");
if(!existsSync(winCodex)){
  run("npm",["install","--force","--no-save","@openai/codex-win32-x64@npm:@openai/codex@0.154.0-win32-x64"]);
}

run("npm",["run","prepare:icon"]);
run("npm",["run","bridge:build"]);
run("npm",["run","ui:build"]);
run("npx",["electron-builder","--win","nsis","--x64","--config.npmRebuild=false"]);

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
  sourceSha:process.env.TB_SOURCE_SHA||null,
},null,2));
console.log("TREBELL_WINDOWS_INSTALLER_PASS",JSON.stringify({name,bytes:bytes.length,sha256,sourceSha:process.env.TB_SOURCE_SHA||null}));
