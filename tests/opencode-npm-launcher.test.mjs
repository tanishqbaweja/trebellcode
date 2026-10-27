// Windows: an OpenCode that only PATH names (nvm-windows' C:\nvm4w\nodejs, another npm prefix) runs the opencode.exe behind npm's
// launcher itself, as T3 Code does (npmShimExecutable), when the launcher is exactly npm's for a native binary. Started through
// cmd.exe, that opencode.exe escapes the kill-on-close job of the process that started it, so its `opencode serve` outlived a
// Trebell that was killed or crashed. A launcher that sets anything up first stays the one that runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

// The Windows launcher npm writes for a package's native binary.
const npmShim=target=>["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0",`"%dp0%\\${target}"   %*`,""].join("\r\n");
async function file(path,text=""){await mkdir(dirname(path),{recursive:true});await writeFile(path,text,"utf8");return path}

test("an OpenCode only PATH names runs the opencode.exe behind npm's exact launcher itself, and any other launcher as it is",{skip:process.platform!=="win32"&&"lays out a Windows npm prefix"},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-launcher-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const folder=join(root,"nvm4w","nodejs");
  const exe=await file(join(folder,"node_modules","opencode-ai","bin","opencode.exe")),shim=await file(join(folder,"opencode.cmd"),npmShim("node_modules\\opencode-ai\\bin\\opencode.exe"));
  // No OpenCode where Trebell looks first (%APPDATA%\npm): only PATH names one.
  const env={USERPROFILE:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),PATH:folder,PATHEXT:".COM;.EXE;.BAT;.CMD",TREBELL_HOME:join(root,"trebell")};
  const manager=new AgentRuntimeManager({state:{settings:()=>({})},env,platform:"win32"});
  const instance={id:"opencode-default",kind:"opencode",environment:{}};
  assert.equal(manager.executable(instance),exe,"so the server it starts ends with the process that started it");
  // A launcher that sets anything up first stays the one that runs.
  await writeFile(shim,npmShim("node_modules\\opencode-ai\\bin\\opencode.exe").replace("SETLOCAL\r\n","SETLOCAL\r\nSET OPENCODE_CONFIG=%~dp0opencode.json\r\n"),"utf8");
  assert.equal(manager.executable(instance),"opencode");
  // And another harness's launchers are not looked up.
  await file(join(folder,"claude.cmd"),npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));await file(join(folder,"node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
  assert.equal(manager.executable({id:"claude-default",kind:"claude",environment:{}}),"claude");
});
