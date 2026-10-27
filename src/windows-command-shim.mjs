import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

// npm installs Windows CLIs as .cmd shims. Node refuses to spawn .cmd/.bat files without a shell
// (CVE-2024-27980) and throws EINVAL, so SDKs that spawn a configured executable directly cannot use a
// shim. Most current CLI packages ship a native executable behind the shim; return that executable so
// the runtime is launched directly. Script targets (cli.js) are returned only when the caller can run
// them itself (allowScripts), because spawning a script file directly fails the same way.
const SHIM_TARGET=/"%~?dp0%?\\([^"%]+)"/gi;
// npm's cmd-shim for a package's native binary, line for line (T3 npmShimExecutable), and the line that runs it: exact asks for this
// shape, so a launcher that sets anything up first (a SET, an IF, a node fallback) is left to run as it is.
const NPM_NATIVE_SHIM=["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0"];
const NPM_NATIVE_SHIM_RUN=/^"%dp0%\\([^"%]+\.exe)" +%\*$/;

export function windowsCommandShimTarget(command,{platform=process.platform,allowScripts=false,exact=false,read=path=>readFileSync(path,"utf8"),exists=existsSync}={}){
  const value=String(command||"").trim();
  if(platform!=="win32"||!/\.(?:cmd|bat)$/i.test(value)||!win32.isAbsolute(value))return null;
  let text="";
  try{text=read(value)}catch{return null}
  const base=win32.dirname(value);
  if(exact){
    const lines=String(text).split(/\r?\n/).filter(line=>line.length>0),target=lines.length===NPM_NATIVE_SHIM.length+1&&NPM_NATIVE_SHIM.every((line,index)=>lines[index]===line)?NPM_NATIVE_SHIM_RUN.exec(lines.at(-1))?.[1]:null;
    const executable=target&&/\.cmd$/i.test(value)?win32.join(base,target):null;
    return executable&&exists(executable)?executable:null;
  }
  const targets=[...text.matchAll(SHIM_TARGET)]
    .map(match=>win32.normalize(win32.join(base,match[1])))
    .filter(target=>!/\\node(?:\.exe)?$/i.test(target));
  const native=targets.filter(target=>/\.exe$/i.test(target));
  const scripts=allowScripts?targets.filter(target=>/\.(?:c|m)?js$/i.test(target)):[];
  return [...native,...scripts].find(target=>exists(target))||null;
}

export function resolveWindowsCommandShim(command,options={}){
  return windowsCommandShimTarget(command,options)||String(command||"").trim();
}
