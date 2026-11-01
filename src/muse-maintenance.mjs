import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { shownCommand } from "./harness-install-plan.mjs";

// How Muse Code is kept up to date. Meta publishes Muse Code on two channels and names each channel's newest release in a small
// JSON manifest. Muse Code itself has no update command: Meta's launcher (install.sh's ~/.local/bin/muse script, or on Windows the
// muse.cmd install.ps1 writes, which runs the .muse-launcher.ps1 beside it) installs the newest release of its channel, and when
// its update is on, synchronous and due, it does that before it answers --version. Trebell runs Muse Code with that update off
// (MUSE_NO_AUTO_UPDATE=1), so Settings' Update is the one way it updates under Trebell, and only through Meta's launcher: a Muse
// Code started any other way is updated the way the person installed it.

// Meta's channels, stable first: a profile that names none runs on the stable one.
export const PUBLISHED_MUSE_CHANNELS=Object.freeze(["muse-stable","muse-canary"]);
const MANIFESTS="https://api.meta.ai/muse-code/channels/";
// The channel a profile's Muse Code runs on: its MUSE_CHANNEL, trimmed, else the stable channel.
export function museChannel(env){
  const named=env?.MUSE_CHANNEL?String(env.MUSE_CHANNEL).trim():"";
  return named||PUBLISHED_MUSE_CHANNELS[0];
}
// The address of a channel's manifest, which names the channel's newest release.
export const museChannelUrl=channel=>MANIFESTS+channel;

// Muse Code names a build X.Y.Z-R<revision>, at times with .<build> after the revision (1.4.13-R6996.1); a version may also be a
// plain X.Y.Z. A reading of one is {numbers, end}: its numbers in the order written (X, Y, Z, then the revision and the build
// when read) and the index in the text where the reading stops.
const isDigit=code=>code>=48&&code<=57;
// An ASCII letter, digit or underscore: what a version may not touch on either side.
const isWordPart=code=>isDigit(code)||(code>=65&&code<=90)||(code>=97&&code<=122)||code===95;
// count runs of digits joined by single dots, from text[start] on, or null when they are not there. A run is always read whole.
function dottedNumbers(text,start,count){
  const numbers=[];let at=start;
  while(numbers.length<count){
    if(numbers.length){if(text[at]!==".")return null;at+=1}
    const first=at;
    while(isDigit(text.charCodeAt(at)))at+=1;
    if(at===first)return null;
    numbers.push(Number(text.slice(first,at)));
  }
  return {numbers,end:at};
}
// Every reading of a version that starts at text[start], longest first: X.Y.Z-R<revision>.<build>, X.Y.Z-R<revision>, then X.Y.Z
// (always the last). None when no X.Y.Z starts there.
function versionReadings(text,start){
  const core=dottedNumbers(text,start,3);if(!core)return [];
  const readings=[core];
  if(text.startsWith("-R",core.end))for(const count of [1,2]){
    const tail=dottedNumbers(text,core.end+2,count);
    if(tail)readings.unshift({numbers:[...core.numbers,...tail.numbers],end:tail.end});
  }
  return readings;
}
const hasRevision=reading=>reading.numbers.length>3;
// The reading that takes the whole of text, or null; with revised, only one that has a revision.
function wholeVersion(text,{revised=false}={}){
  const reading=versionReadings(text,0).find(candidate=>candidate.end===text.length);
  return reading&&(hasRevision(reading)||!revised)?reading:null;
}
// The version a program's output names, as written there: the first X.Y.Z-R<revision>[.<build>] that stands alone in it, else the
// first plain X.Y.Z that does, else null. Standing alone, a version has no letter, digit or underscore just before or just after
// it, and a build that does not stand alone is left off ("1.4.13-R6996.1x" names 1.4.13-R6996). Muse Code 1.4.13 answers
// --version with "Muse Code 1.4.13 (1.4.13-R6996.1)", which names 1.4.13-R6996.1.
export function museVersionIn(text){
  const output=String(text??"");let plain=null;
  for(let start=0;start<output.length;start+=1){
    if(!isDigit(output.charCodeAt(start))||isWordPart(output.charCodeAt(start-1)))continue;
    for(const reading of versionReadings(output,start)){
      if(isWordPart(output.charCodeAt(reading.end)))continue;
      if(hasRevision(reading))return output.slice(start,reading.end);
      plain??=output.slice(start,reading.end);
    }
  }
  return plain;
}
// The X.Y.Z a version starts with, as written ("1.4.13" of 1.4.13-R6996.1), or null for text that is no version.
export function museVersionCore(version){
  const text=String(version??""),readings=versionReadings(text,0);
  return readings.some(reading=>reading.end===text.length)?text.slice(0,readings.at(-1).end):null;
}
// The release a channel's manifest names: its version when that is exactly X.Y.Z-R<revision>[.<build>], else null.
export function museChannelRelease(manifest){
  const version=manifest?.version;
  return typeof version==="string"&&wholeVersion(version,{revised:true})?version:null;
}
// Two Muse Code versions in order (below 0: a is older). X, Y and Z compare as numbers; when both have a revision, the revision
// and then the build follow (no build counts as 0), and when either has none, the same X.Y.Z is the same version. Text that is no
// Muse Code version, on either side, orders as equal.
export function museVersionOrder(a,b){
  const numbersOf=value=>wholeVersion((value?String(value):"").trim())?.numbers;
  const left=numbersOf(a),right=numbersOf(b);if(!left||!right)return 0;
  const positions=Math.min(left.length,right.length)>3?5:3;
  for(let index=0;index<positions;index+=1){
    const mine=left[index]??0,theirs=right[index]??0;
    if(mine!==theirs)return mine<theirs?-1:1;
  }
  return 0;
}

// The JSON body of a GET of url, or undefined when the request fails, answers with an error status or with something other than
// JSON, or is not done within limitMs.
async function fetchJson(fetchImpl,url,limitMs){
  try{
    const answer=await fetchImpl(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(limitMs)});
    return answer?.ok?await answer.json():undefined;
  }catch{return undefined}
}
// The newest release Meta names for a channel it publishes, or null when the channel is not Meta's (nothing is asked), or its
// manifest cannot be read in time or names none.
// timeoutMs: the 3 s npm's registry gets for the same question (harness-install-plan registryRelease).
export async function latestMuseRelease(fetchImpl,channel,{timeoutMs=3000}={}){
  if(!PUBLISHED_MUSE_CHANNELS.includes(channel))return null;
  return museChannelRelease(await fetchJson(fetchImpl,museChannelUrl(channel),timeoutMs));
}

// Meta's launcher scripts are a few KB; a file over this size is something else, such as the muse-bin binary of several hundred MB.
// Trebell's own 1 MiB: hundreds of times a launcher's size, so a launcher Meta makes longer is still read, at least as much as 2.1.2
// read (128 KiB), and still a small read and buffer beside the binary, which is never read.
const SCRIPT_LIMIT=1024*1024;
// The text of a script of at most SCRIPT_LIMIT bytes at path, read as UTF-8, or null for a larger file, a folder, or one that
// cannot be read. No more than one byte past the limit is read, whatever size the file claims.
function scriptText(path){
  let handle;
  try{
    handle=openSync(path,"r");
    if(fstatSync(handle).size>SCRIPT_LIMIT)return null;
    const bytes=Buffer.alloc(SCRIPT_LIMIT+1);let filled=0;
    while(filled<bytes.length){
      const got=readSync(handle,bytes,filled,bytes.length-filled,filled);
      if(!got)break;
      filled+=got;
    }
    return filled>SCRIPT_LIMIT?null:bytes.toString("utf8",0,filled);
  }catch{return null}
  finally{if(handle!==undefined)try{closeSync(handle)}catch{}}
}
// What makes Meta's launcher update before it answers: the update on, synchronous, and due however recently it last looked.
const SYNC_SWITCH="MUSE_SYNC_UPDATE";
const UPDATE_NOW=Object.freeze([["MUSE_NO_AUTO_UPDATE","0"],[SYNC_SWITCH,"1"],["MUSE_UPDATE_INTERVAL_SECONDS","0"]]);
// Meta's launcher script says who it is in its user agent, muse-code/launcher-<n>, and reads the switch of its synchronous update.
const LAUNCHER_AGENT="muse-code/launcher-";
const isLauncherScript=text=>typeof text==="string"&&text.includes(LAUNCHER_AGENT)&&text.includes(SYNC_SWITCH);
// On Windows the command is install.ps1's muse.cmd, which runs the launcher in its own folder (cmd's %~dp0) in Windows PowerShell.
const WINDOWS_COMMAND="muse.cmd",WINDOWS_LAUNCHER=".muse-launcher.ps1";
// path split after its last separator (\ or /, or a drive's colon): [the folder, separator included, and the file's name].
function folderAndName(path){
  const cut=Math.max(path.lastIndexOf("\\"),path.lastIndexOf("/"),path[1]===":"?1:-1)+1;
  return [path.slice(0,cut),path.slice(cut)];
}
function isWindowsLauncher(path){
  const [folder,name]=folderAndName(path);
  if(name.toLowerCase()!==WINDOWS_COMMAND)return false;
  if(!scriptText(path)?.toLowerCase().includes("%~dp0"+WINDOWS_LAUNCHER))return false;
  return isLauncherScript(scriptText(folder+WINDOWS_LAUNCHER));
}
// Whether the Muse Code at a real path is Meta's launcher, which can update it: on Windows a muse.cmd that runs the
// .muse-launcher.ps1 beside it, Meta's launcher script; elsewhere the file is Meta's launcher script. Anything else, the muse-bin
// binary the launcher runs or a wrapper of one's own, is not, and Trebell does not guess how to update it.
export function isMuseLauncher(path,{platform=process.platform}={}){
  if(!path)return false;
  return platform==="win32"?isWindowsLauncher(String(path)):isLauncherScript(scriptText(String(path)));
}

// The environment of the launcher's update: the profile's own (its MUSE_CHANNEL kept), with the update on, synchronous and due.
export function museUpdateEnvironment(env){return {...env,...Object.fromEntries(UPDATE_NOW)}}
// Items in a sentence: "a, b and c".
const inSentence=items=>items.length>1?`${items.slice(0,-1).join(", ")} and ${items.at(-1)}`:items.join("");
// The update as Settings shows it: the launcher's --version, with the channel when the profile sets one and the switches it runs with.
export function museUpdateText(launcher,env={},platform=process.platform){
  const channel=env?.MUSE_CHANNEL;
  const settings=String(channel||"").trim()?[["MUSE_CHANNEL",channel],...UPDATE_NOW]:UPDATE_NOW;
  return `${shownCommand(launcher,["--version"],platform)} (with ${inSentence(settings.map(setting=>setting.join("=")))})`;
}
// Why Trebell does not update a Muse Code that Meta's launcher does not run.
export function museUpdateRefusal(binary){
  return `Trebell Code updates Muse Code only through Meta's launcher, which Meta's installer puts in place, and ${binary} is not it: update it the way you installed it. Nothing was installed.`;
}
