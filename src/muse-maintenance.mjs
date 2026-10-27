import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { shownCommand } from "./harness-install-plan.mjs";

// Muse Code's releases and its updates, as T3 Code reads them (provider-muse maintenance.ts): Meta names the newest release of each
// channel at https://api.meta.ai/muse-code/channels/<channel>, and only Meta's launcher updates a Muse Code. It has no update
// command: run with its update on, synchronous and due (MUSE_NO_AUTO_UPDATE=0, MUSE_SYNC_UPDATE=1, MUSE_UPDATE_INTERVAL_SECONDS=0),
// it installs the newest release of the channel it runs on before it answers. Every Trebell launch turns that update off
// (MUSE_NO_AUTO_UPDATE=1), so Muse Code updates under Trebell only through this. A Muse Code run any other way is the person's to
// update.

// The channels Meta publishes, which its launcher runs on.
export const MUSE_CHANNELS=Object.freeze(["muse-stable","muse-canary"]);
const RELEASE=/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/;
// The channel a profile's Muse Code runs on: MUSE_CHANNEL, else muse-stable, as Meta's launcher reads it.
export const museChannel=env=>String(env?.MUSE_CHANNEL||"").trim()||"muse-stable";
export const museChannelUrl=channel=>`https://api.meta.ai/muse-code/channels/${channel}`;
// The release a channel's manifest names in Meta's form (X.Y.Z-R<revision>), or null for a manifest that names none (T3
// ChannelManifest).
export function museChannelRelease(manifest){const version=manifest?.version;return typeof version==="string"&&RELEASE.test(version)?version:null}
// The newest release of a channel Meta publishes (T3 latestMuseVersion: 4 s), or null when it could not be read.
export async function latestMuseRelease(fetchImpl,channel,{timeoutMs=4000}={}){
  if(!MUSE_CHANNELS.includes(channel))return null;
  try{
    const response=await fetchImpl(museChannelUrl(channel),{headers:{accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
    return response?.ok?museChannelRelease(await response.json()):null;
  }catch{return null}
}
// Two Muse Code versions in order (T3 compareMuseVersions): by X.Y.Z, then by the -R revision and its build when both have one; a
// version without a revision equals each revision of it. One that is no Muse Code version orders as equal.
export function compareMuseVersions(a,b){
  const parts=value=>/^(\d+)\.(\d+)\.(\d+)(?:-R(\d+)(?:\.(\d+))?)?$/.exec(String(value||"").trim())?.slice(1).map(part=>part==null?null:Number(part))||null;
  const [left,right]=[parts(a),parts(b)];if(!left||!right)return 0;
  const length=left[3]!=null&&right[3]!=null?5:3;
  for(let index=0;index<length;index++){const x=left[index]??0,y=right[index]??0;if(x!==y)return x<y?-1:1}
  return 0;
}

const LAUNCHER_MAX_BYTES=128*1024;
// A small script's text, or "" for a larger or unreadable file (T3 reads up to 128 KiB).
export function readLauncherScript(path){try{return statSync(path).size>LAUNCHER_MAX_BYTES?"":readFileSync(path,"utf8")}catch{return ""}}
// Meta's launcher script: it names its user agent muse-code/launcher-<n> and reads MUSE_SYNC_UPDATE (T3's test of it).
const metaLauncher=text=>text.includes("muse-code/launcher-")&&text.includes("MUSE_SYNC_UPDATE");
// Whether the Muse Code a profile runs, at its real path, is Meta's launcher, which updates it: elsewhere the launcher script itself
// (install.sh's ~/.local/bin/muse); on Windows the muse.cmd Meta's install.ps1 writes, which runs the .muse-launcher.ps1 beside it, a
// launcher that reads the same switches (T3 leaves Windows to the person). Anything else, a muse-bin-<version> binary or another
// wrapper, is not: Trebell never guesses an updater.
export function isMuseLauncher(real,{platform=process.platform,read=readLauncherScript}={}){
  const path=String(real||"");if(!path)return false;
  if(platform!=="win32")return metaLauncher(read(path));
  if(win32.basename(path).toLowerCase()!=="muse.cmd"||!read(path).toLowerCase().includes("%~dp0.muse-launcher.ps1"))return false;
  return metaLauncher(read(win32.join(win32.dirname(path),".muse-launcher.ps1")));
}
const UPDATE_SWITCHES=Object.freeze({MUSE_NO_AUTO_UPDATE:"0",MUSE_SYNC_UPDATE:"1",MUSE_UPDATE_INTERVAL_SECONDS:"0"});
// The environment Meta's launcher updates in: the profile's own (its MUSE_CHANNEL kept), with its update on, synchronous and due.
export function museUpdateEnvironment(env={}){return {...env,...UPDATE_SWITCHES}}
// The update as Settings says it: the launcher's --version, with the switches it runs with and the channel when one is set.
export function museUpdateText(launcher,env={},platform=process.platform){
  const switches=[...(String(env.MUSE_CHANNEL||"").trim()?["MUSE_CHANNEL="+env.MUSE_CHANNEL]:[]),...Object.entries(UPDATE_SWITCHES).map(([name,value])=>name+"="+value)];
  return `${shownCommand(launcher,["--version"],platform)} (with ${switches.slice(0,-1).join(", ")} and ${switches.at(-1)})`;
}
// Why an update is refused for a Muse Code that Meta's launcher does not run.
export function museUpdateRefusal(binary){
  return `Trebell Code updates Muse Code only through Meta's launcher, which Meta's installer puts in place, and ${binary} is not it: update it the way you installed it. Nothing was installed.`;
}
