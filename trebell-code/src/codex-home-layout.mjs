import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, link as hardlink, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";

const SHARED_DIRECTORIES=["sessions","archived_sessions","sqlite","shell_snapshots","worktrees","skills","plugins","cache","logs","mcp-oauth-locks"];
const PRIVATE_ENTRIES=new Set(["auth.json","models_cache.json"]);
const SHADOW_LOCAL_ENTRIES=new Set(["log","memories","tmp"]);
const REPLACEABLE_SHARED_ENTRIES=new Set(["mcp-oauth-locks"]);

function expandHome(value){
  const raw=String(value||"").trim();
  if(raw==="~")return homedir();
  if(raw.startsWith("~/")||raw.startsWith("~\\"))return join(homedir(),raw.slice(2));
  return raw;
}
function normalized(value,fallback){return resolve(expandHome(value)||fallback)}
async function linkState(path){
  try{const stat=await lstat(path);if(!stat.isSymbolicLink())return {kind:"other"};return {kind:"link",target:await readlink(path)}}catch(error){if(error?.code==="ENOENT")return {kind:"missing"};throw error}
}
async function ensureLink({sharedHome,effectiveHome,name}){
  const target=join(sharedHome,name),link=join(effectiveHome,name),state=await linkState(link);
  if(state.kind==="other"){
    try{
      const [existing,targetStat]=await Promise.all([lstat(link),lstat(target)]);
      if(existing.dev===targetStat.dev&&existing.ino&&existing.ino===targetStat.ino)return;
    }catch{}
    if(!REPLACEABLE_SHARED_ENTRIES.has(name))throw new Error(`Cannot create Codex shadow home entry '${name}' because '${link}' already exists and is not a symlink.`);
    await rm(link,{recursive:true,force:true});
  }else if(state.kind==="link"){
    const existing=resolve(dirname(link),state.target);if(existing===target)return;await rm(link,{force:true});
  }
  let targetStat=null;try{targetStat=await lstat(target)}catch{}
  const type=targetStat?.isDirectory()?(process.platform==="win32"?"junction":"dir"):"file";
  try{await symlink(target,link,type)}catch(error){
    if(process.platform==="win32"&&type==="file"&&["EPERM","EACCES"].includes(error?.code)){await hardlink(target,link);return}
    throw error;
  }
}

export function resolveCodexHomeLayout({homePath=null,shadowHomePath=null,defaultHome=join(homedir(),".codex")}={}){
  const sharedHomePath=normalized(homePath,defaultHome);const shadow=String(shadowHomePath||"").trim();
  if(!shadow)return {mode:"direct",sharedHomePath,effectiveHomePath:homePath?sharedHomePath:null,continuationKey:`codex:home:${sharedHomePath}`};
  const effectiveHomePath=normalized(shadow,defaultHome);
  return {mode:"authOverlay",sharedHomePath,effectiveHomePath,continuationKey:`codex:home:${sharedHomePath}`};
}

export async function materializeCodexShadowHome(layout){
  if(layout?.mode!=="authOverlay")return layout;
  const sharedHome=layout.sharedHomePath,effectiveHome=layout.effectiveHomePath;
  if(!effectiveHome)throw new Error("Codex shadow home path is missing");
  if(resolve(sharedHome)===resolve(effectiveHome))throw new Error(`Codex shadow home path '${effectiveHome}' must be different from the shared home path '${sharedHome}'.`);
  await Promise.all([mkdir(sharedHome,{recursive:true}),mkdir(effectiveHome,{recursive:true}),...SHARED_DIRECTORIES.map(name=>mkdir(join(sharedHome,name),{recursive:true}))]);

  for(const name of PRIVATE_ENTRIES){
    const path=join(effectiveHome,name);const state=await linkState(path);
    if(name==="auth.json"&&state.kind==="link")throw new Error(`Codex shadow home private entry 'auth.json' at '${path}' must be a real file, not a symlink.`);
    if(name!=="auth.json"&&state.kind==="link")await rm(path,{force:true});
  }

  const entries=new Set(SHARED_DIRECTORIES);
  for(const name of await readdir(sharedHome))if(!PRIVATE_ENTRIES.has(name)&&!SHADOW_LOCAL_ENTRIES.has(name))entries.add(name);
  for(const name of entries)await ensureLink({sharedHome,effectiveHome,name});
  return layout;
}

export async function prepareCodexHome(config={}){
  const layout=resolveCodexHomeLayout(config);await materializeCodexShadowHome(layout);return layout;
}
