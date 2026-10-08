import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

// npm installs Windows CLIs as .cmd shims. Node refuses to spawn .cmd/.bat files without a shell
// (CVE-2024-27980) and throws EINVAL, so SDKs that spawn a configured executable directly cannot use a
// shim. Most current CLI packages ship a native executable behind the shim; return that executable so
// the runtime is launched directly. Script targets (cli.js) are returned only when the caller can run
// them itself (allowScripts), because spawning a script file directly fails the same way.
const SHIM_TARGET=/"%~?dp0%?\\([^"%]+)"/gi;

export function windowsCommandShimTarget(command,{platform=process.platform,allowScripts=false,read=path=>readFileSync(path,"utf8"),exists=existsSync}={}){
  const value=String(command||"").trim();
  if(platform!=="win32"||!/\.(?:cmd|bat)$/i.test(value)||!win32.isAbsolute(value))return null;
  let text="";
  try{text=read(value)}catch{return null}
  const base=win32.dirname(value);
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
