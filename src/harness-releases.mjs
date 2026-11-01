// Which releases of a harness Trebell Code knows to work, and what it makes of the rest. Settings flags a release that is known
// not to work or that is newer than any Trebell Code can run, and the OpenCode install plan pins only a release that works.
// A harness with no entry here is not judged by its release.
import { museVersionCore, museVersionIn } from "./muse-maintenance.mjs";

// One entry: the harness's name as Settings shows it; `from`, the first release that works, as [major, minor, patch]; `upTo`,
// where there is one, the first release past what Trebell Code can run; and what a release before `from` (`older`) or at or
// past `upTo` (`newer`) counts as. A release in between counts as "supported", and a version line with no release in it as
// "unknown".
function entry(name,from,{upTo=null,older,newer=null}){
  return Object.freeze({name,from:Object.freeze(from),upTo:upTo&&Object.freeze(upTo),older,newer});
}
export const HARNESS_RELEASES=Object.freeze({
  // OpenCode's notes for 1.14.19 fix compiled binaries that failed to start (a circular session schema dependency) and its managed
  // install on Windows, and Trebell Code's own tests start at that release. Trebell Code has a client for OpenCode's 1.x server
  // and one for its 2.x server (opencode-agent-session.mjs, opencode2-agent-session.mjs), and none for a 3.x.
  opencode:entry("OpenCode",[1,14,19],{upTo:[3,0,0],older:"broken",newer:"unsupported"}),
  // Muse Code 1.4.8 is the first release whose session protocol has everything Trebell Code's Muse client sends and reads, by
  // Meta's changelog: permissionProfile on session/start (1.4.6) and on session/resume (1.4.8), and the model's narration as
  // agentMessage items (1.4.8). Trebell Code's recordings were made with 1.4.14 and its tests run 1.4.13. An older Muse Code is
  // not refused, only not known to work. Muse Code's builds are X.Y.Z-R<revision>; the revision plays no part.
  muse:entry("Muse Code",[1,4,8],{older:"unknown"}),
});
const entryFor=kind=>{const id=String(kind??"").trim().toLowerCase();return Object.hasOwn(HARNESS_RELEASES,id)?[id,HARNESS_RELEASES[id]]:[id,null]};

const TERMINAL_CODES=/\x1B\[[0-?]*[ -/]*[@-~]/g;
// The release a version line names, as [major, minor, patch]: the first X.Y.Z with no digit or dot just before it and no digit,
// dot or dash just after it, a v before it allowed ("opencode v2.0.24"). For Muse Code, the X.Y.Z of the build its line names.
function releaseNamed(kind,said){
  let text=String(said??"").replace(TERMINAL_CODES,"");
  if(kind==="muse")text=museVersionCore(museVersionIn(text)||"")||"";
  const found=/(?<![\d.])v?(\d+)\.(\d+)\.(\d+)(?![\d.-])/i.exec(text);
  return found?found.slice(1,4).map(Number):null;
}
// Negative when release a comes before release b, 0 for the same release, positive after.
const releaseOrder=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
const releaseText=release=>release.join(".");
// The releases an entry runs, in words: "1.14.19 or a later 1.x or 2.x release" when it ends at a major line, "1.4.8 or later"
// when it has no end.
function releasesThatWork({from,upTo}){
  if(!upTo)return `${releaseText(from)} or later`;
  if(upTo[1]||upTo[2])return `${releaseText(from)} or a later release before ${releaseText(upTo)}`;
  const lines=[];for(let major=from[0];major<upTo[0];major++)lines.push(`${major}.x`);
  const named=lines.length>1?`${lines.slice(0,-1).join(", ")} or ${lines.at(-1)}`:lines[0];
  return `${releaseText(from)} or a later ${named} release`;
}
function verdictSentence({name},status,version,works){
  if(status==="broken")return `${name} ${version} has a known fault that keeps it from working with Trebell Code. Install ${name} ${works}.`;
  if(status==="unsupported")return `${name} ${version} is newer than any release Trebell Code can run. Install ${name} ${works}.`;
  return null;
}
// What Trebell Code makes of the release a harness's version line names: null for a harness it does not judge by release, else
// {status: "supported" | "broken" | "unsupported" | "unknown", message: a sentence for a broken or unsupported release (else
// null), version: the X.Y.Z read (or null), tested: the releases that work, in words}.
export function harnessReleaseSupport(kind,said){
  const [id,table]=entryFor(kind);
  if(!table)return null;
  const release=releaseNamed(id,said),works=releasesThatWork(table);
  let status="unknown";
  if(release)status=releaseOrder(release,table.from)<0?table.older:table.upTo&&releaseOrder(release,table.upTo)>=0?table.newer:"supported";
  const version=release?releaseText(release):null;
  return {status,message:verdictSentence(table,status,version,works),version,tested:works};
}
// The releases of one major line that Trebell Code can run, as an npm range for npm to pick the newest of: OpenCode's 2.x gives
// ">=2.0.0 <3.0.0", its 1.x ">=1.14.19 <2.0.0". Null for a harness with no entry, or a line with no release that works.
export function supportedLineRange(kind,major){
  const [,table]=entryFor(kind);
  if(!table||!Number.isInteger(major)||major<0)return null;
  const lineStart=[major,0,0],nextLine=[major+1,0,0];
  const low=releaseOrder(lineStart,table.from)<0?table.from:lineStart,high=table.upTo&&releaseOrder(table.upTo,nextLine)<0?table.upTo:nextLine;
  return releaseOrder(low,high)<0?`>=${releaseText(low)} <${releaseText(high)}`:null;
}
