import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { link, lstat, mkdir, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { localHomePath } from "./local-home-path.mjs";

// Where a Codex profile keeps its state. Codex keeps everything in one folder, CODEX_HOME. A profile can run in a second one, a
// shadow home, that holds a sign-in of its own (the profile's own account, or Trebell's sign-in with an API key) and reaches every
// other entry of the shared home through a link, so both homes work on the same threads and setup.
//
// Which entry goes which way comes from what Codex 0.155.1 (the version Trebell pins) puts in CODEX_HOME, read in its source at
// github.com/openai/codex, tag rust-v0.155.1; the paths below are under codex-rs/ there. Every entry not named here is linked.

// The ways a shadow home treats a name of the shared home.
const MADE_FIRST="made first";   // a folder made in the shared home before anything is linked, then linked
const OWN="own";                 // never linked: each home has its own
const LOCK="lock";               // linked, and a copy the shadow home made itself gives way to the link

const SIGN_IN_FILE="auth.json",MODEL_LIST_FILE="models_cache.json";

const HOME_ENTRY_WAYS=[
  // Threads: their rollouts, live and archived (rollout/src/lib.rs), the worktrees Codex makes for them (worktree/src/settings.rs)
  // and their shell snapshots (core/src/shell_snapshot.rs). Codex makes these in whichever home it runs in first, so the shared
  // home gets them before a shadow home could make copies of its own that would stop it later.
  ["sessions",[MADE_FIRST]],["archived_sessions",[MADE_FIRST]],["worktrees",[MADE_FIRST]],["shell_snapshots",[MADE_FIRST]],
  // Setup and caches: skills (skills/src/lib.rs), plugins (core-plugins/src/store.rs) and the connector and catalog caches
  // (connectors/src/directory_cache.rs, core-plugins/src/remote/catalog_cache.rs).
  ["skills",[MADE_FIRST]],["plugins",[MADE_FIRST]],["cache",[MADE_FIRST]],
  // Folders that hold nothing but Codex's lock files, which guard what the homes share: the MCP sign-in stores
  // (rmcp-client/src/oauth/store_lock.rs, refresh_lock.rs) and each thread's writer (rollout/src/writer_lock.rs). The thread
  // writer locks are not made first: a WSL or SSH shadow home that already has its own would stop at its next start.
  ["mcp-oauth-locks",[MADE_FIRST,LOCK]],["thread-writer-locks",[LOCK]],
  // One sign-in's: the sign-in (login/src/auth/storage.rs), the model list Codex read with it (models-manager/src/manager.rs,
  // tied to the account, plan and credentials) and the cloud config cache Codex scopes to the signed-in account
  // (cloud-config/src/cache.rs).
  [SIGN_IN_FILE,[OWN]],[MODEL_LIST_FILE,[OWN]],["cloud-config-bundle-cache.json",[OWN]],
  // One running Codex's: its log folder (core/src/config/mod.rs), its helper aliases under tmp/arg0 (arg0/src/lib.rs), and an
  // app-server daemon's pid, lock and control socket (app-server-daemon/src/lib.rs, app-server-transport/src/transport/mod.rs).
  ["log",[OWN]],["tmp",[OWN]],["app-server-daemon",[OWN]],["app-server-control",[OWN]],
  // Memory roots: Codex refuses to clear one that is a link (memories/write/src/control.rs).
  ["memories",[OWN]],["memories_v2",[OWN]],["memories_extensions",[OWN]],
  // Finder's view settings of the one folder it was written in.
  [".DS_Store",[OWN]],
];
const waysOf=new Map(HOME_ENTRY_WAYS);
const goesWay=(name,way)=>waysOf.get(name)?.includes(way)===true;

// The folders made in the shared home before a shadow home is linked to it, in this order. A WSL or SSH shadow home links the same
// ones (environment-app-server remoteCodexHomeSetup).
export const CODEX_FOLDERS_SHARED_FROM_START=Object.freeze(HOME_ENTRY_WAYS.filter(([name])=>goesWay(name,MADE_FIRST)).map(([name])=>name));

// The names each home keeps for itself that Trebell 2.0.0 to 2.1.2 linked into a local shadow home: those releases linked every
// name of the shared home but auth.json, models_cache.json, log, memories, tmp and .DS_Store. A link at one of these to the shared
// home's entry of the same name is such a release's own and goes, so Codex makes the shadow home's own entry (setUpCodexHomes); the
// model list is checked on its own (checkShadowOwnFiles). A link at any other name, or one that points anywhere else, can only be
// the person's, and stays; a WSL or SSH shadow home was never given one at a name each home keeps.
const NAMES_RELEASES_LINKED=Object.freeze(["cloud-config-bundle-cache.json","app-server-daemon","app-server-control","memories_v2","memories_extensions"]);

// Codex names each lock file it takes *.lock (rollout/src/maintenance.rs, rollout/src/writer_lock.rs,
// core-plugins/src/startup_sync.rs, app-server-daemon/src/lib.rs), so one at the top of a home is a lock too, from whichever Codex
// release made it.
const isCodexLock=name=>goesWay(name,LOCK)||name.endsWith(".lock");

const isGiven=value=>String(value??"").trim()!=="";
// A home as the person typed it, placed on this machine (local-home-path: ~, ~/..., and ~name/... under that user's home) and made
// absolute. Under a user this machine does not have it stays as typed, with the message that refuses it before anything is made.
function placedHome(typed){
  const placed=localHomePath(typed);
  return {path:resolve(placed.path),error:placed.error||null};
}

// Where a Codex profile's homes are, read from its settings without touching the disk. defaultHome is the home Codex uses when the
// profile names none (CODEX_HOME of Trebell's environment, else ~/.codex), taken as it is, as Codex takes it.
// mode: "direct" (one home) or "authOverlay" (a shadow home over the shared one); effectiveHomePath: the CODEX_HOME Codex runs with,
// null to leave Codex on its default; continuationKey: profiles with one shared home continue each other's threads; error: only
// when a home names a user this machine does not have.
export function planCodexHomes({homePath=null,shadowHomePath=null,defaultHome=join(homedir(),".codex")}={}){
  const own=isGiven(homePath),shared=own?placedHome(homePath):{path:resolve(defaultHome),error:null};
  const plan={mode:"direct",sharedHomePath:shared.path,effectiveHomePath:own?shared.path:null,continuationKey:"codex:home:"+shared.path};
  let error=shared.error;
  if(isGiven(shadowHomePath)){
    const shadow=placedHome(shadowHomePath);
    plan.mode="authOverlay";plan.effectiveHomePath=shadow.path;error||=shadow.error;
  }
  if(error)plan.error=error;
  return plan;
}

// What is at path, the link itself when it is one, with file ids as BigInts; null when nothing is there.
const entryAt=path=>lstat(path,{bigint:true}).catch(error=>{
  if(error?.code!=="ENOENT")throw error;
  return null;
});

// How a shadow home's entry stands against the shared entry it should reach:
//   "missing"   nothing is there;
//   "linked"    a link to the shared entry, or the shared file itself (the hard link Windows makes without symlink rights: one
//               device, one nonzero file id; NTFS ids pass 2^53, where two ids can be one Number, so they are compared as BigInts);
//   "elsewhere" a link to anything else;
//   "occupied"  a file or folder of the shadow home's own.
async function shadowEntryState(entry,shared){
  const found=await entryAt(entry);
  if(!found)return "missing";
  if(found.isSymbolicLink())return resolve(dirname(entry),await readlink(entry))===resolve(shared)?"linked":"elsewhere";
  const original=await entryAt(shared).catch(()=>null);
  return original&&found.ino!==0n&&found.dev===original.dev&&found.ino===original.ino?"linked":"occupied";
}

// Makes entry a link to shared: a folder gets a junction on Windows (no symlink right needed) and a symlink elsewhere; a file gets a
// symlink, and on a Windows that refuses one (no Developer Mode, not an administrator) a hard link, the same file under a second name.
async function makeLink(shared,entry){
  const windows=process.platform==="win32",folder=await stat(shared).then(info=>info.isDirectory(),()=>false);
  if(folder)return await symlink(shared,entry,windows?"junction":"dir");
  try{await symlink(shared,entry,"file")}catch(error){
    if(!windows||!["EPERM","EACCES"].includes(error?.code))throw error;
    await link(shared,entry);
  }
}

// Points one name of the shadow home at the shared home's. A right link stays (a running Codex may be writing through it), a link
// elsewhere is made again, and a file or folder of the shadow home's own is refused, but for one of Codex's locks, which gives way.
async function linkIntoShadow(sharedDir,shadowDir,name){
  const shared=join(sharedDir,name),entry=join(shadowDir,name),state=await shadowEntryState(entry,shared);
  if(state==="linked")return;
  if(state==="occupied"&&!isCodexLock(name))throw new Error(`The Codex shadow home cannot link '${name}': '${entry}' is already there and is not a link.`);
  if(state!=="missing")await rm(entry,{recursive:state==="occupied",force:true});
  await makeLink(shared,entry);
}

// The shadow home's sign-in has to be a file of its own, never a link to another home's; a model list linked in goes, so Codex
// writes the one for this home's sign-in.
async function checkShadowOwnFiles(shadowDir){
  const signIn=join(shadowDir,SIGN_IN_FILE);
  if((await entryAt(signIn))?.isSymbolicLink())throw new Error(`The Codex shadow home's own '${SIGN_IN_FILE}' at '${signIn}' is a link; it has to be a file of its own.`);
  const modelList=join(shadowDir,MODEL_LIST_FILE);
  if((await entryAt(modelList))?.isSymbolicLink())await rm(modelList,{force:true});
}

// Takes away the links an earlier release made at names each home now keeps for itself (NAMES_RELEASES_LINKED).
async function dropLinksAtOwnNames(sharedDir,shadowDir){
  for(const name of NAMES_RELEASES_LINKED){
    const entry=join(shadowDir,name);
    if(await shadowEntryState(entry,join(sharedDir,name))==="linked")await rm(entry,{force:true});
  }
}

// The names a shadow home links, in order: the folders shared from the start, then every other name of the shared home that is not
// kept by each home.
async function namesToLink(sharedDir){
  const names=new Set(CODEX_FOLDERS_SHARED_FROM_START);
  for(const name of await readdir(sharedDir))if(!goesWay(name,OWN))names.add(name);
  return [...names];
}

// Readies a plan's homes for Codex. A plan with an error is refused before anything is made; one home needs nothing; a shadow home
// gets the folders shared from the start made in the shared home and every shared name linked, one at a time, stopping at the first
// refusal.
export async function setUpCodexHomes(plan){
  if(plan?.error)throw new Error(plan.error);
  if(plan?.mode!=="authOverlay")return plan;
  const sharedDir=plan.sharedHomePath,shadowDir=plan.effectiveHomePath;
  if(!shadowDir)throw new Error("The Codex shadow home has no folder set.");
  if(resolve(shadowDir)===resolve(sharedDir))throw new Error(`The Codex shadow home '${shadowDir}' is the shared home '${sharedDir}' itself; it needs a folder of its own.`);
  await mkdir(sharedDir,{recursive:true});await mkdir(shadowDir,{recursive:true});
  for(const folder of CODEX_FOLDERS_SHARED_FROM_START)await mkdir(join(sharedDir,folder),{recursive:true});
  await checkShadowOwnFiles(shadowDir);
  await dropLinksAtOwnNames(sharedDir,shadowDir);
  for(const name of await namesToLink(sharedDir))await linkIntoShadow(sharedDir,shadowDir,name);
  return plan;
}

// A Codex profile's homes, planned and readied: the ones its app-server, its account check and its API key sign-in run in.
export async function prepareCodexHome(config={}){
  const plan=planCodexHomes(config);
  await setUpCodexHomes(plan);
  return plan;
}
