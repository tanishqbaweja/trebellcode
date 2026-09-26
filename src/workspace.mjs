import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, posix, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git","node_modules","target","dist","build",".next",".cache","desktop-dist"]);

function remoteProfile(environments,environmentId){
  if(!environmentId||!environments)return null;
  const profile=environments.get(environmentId);
  return profile&&profile.type!=="local"?profile:null;
}

function remotePath(root,path){
  const base=posix.normalize(String(root||"/"));
  const value=String(path||"").trim();
  const absolute=value.startsWith("/")?posix.normalize(value):posix.normalize(posix.join(base,value));
  if(absolute!==base&&!absolute.startsWith(base.endsWith("/")?base:base+"/"))throw new Error("File is outside the active workspace");
  return {base,absolute};
}

function remoteFindArgs(root,depth,type){
  const args=[root,"-maxdepth",String(Math.max(1,Number(depth)||1)),"-mindepth","1","("];
  let first=true;
  for(const name of SKIP){
    if(!first)args.push("-o");
    args.push("-name",name);first=false;
  }
  args.push(")","-prune","-o","-type",type,"-print");
  return args;
}

function gitFileEntries(raw,root,{remote=false}={}){
  const value=String(raw||"");
  const paths=(value.includes("\0")?value.split("\0"):value.split(/\r?\n/)).map(item=>item.trim()).filter(Boolean);
  return paths.filter(relativePath=>{
    const parts=relativePath.replace(/\\/g,"/").split("/").filter(Boolean);
    return parts.length&&!parts.some(part=>SKIP.has(part))&&!parts.includes("..");
  }).map(relativePath=>{
    const normalized=remote?relativePath.replace(/\\/g,"/"):relativePath;
    const path=remote?posix.join(root,normalized):resolve(root,normalized);
    const name=remote?posix.basename(normalized):basename(normalized);
    return {name,path,relativePath:normalized,isDirectory:false,isFile:true,depth:Math.max(0,normalized.replace(/\\/g,"/").split("/").length-1)};
  });
}

function compactSearchText(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"")}
function subsequenceScore(query,value){
  if(!query||!value)return null;
  let cursor=0,first=-1,previous=-2,gaps=0,streak=0;
  for(const character of query){
    const index=value.indexOf(character,cursor);if(index<0)return null;
    if(first<0)first=index;
    gaps+=Math.max(0,index-cursor);
    if(index===previous+1)streak++;
    previous=index;cursor=index+1;
  }
  return first*2+gaps*4+Math.max(0,value.length-query.length)*0.08-streak*1.5;
}

function workspaceSearchScore(entry,query){
  const needle=String(query||"").trim().toLowerCase().replace(/\\/g,"/");
  if(!needle)return null;
  const name=String(entry.name||"").toLowerCase().replace(/\\/g,"/");
  const path=String(entry.relativePath||entry.path||"").toLowerCase().replace(/\\/g,"/");
  if(name===needle)return 0;
  if(path===needle)return 2;
  if(name.startsWith(needle))return 10+(name.length-needle.length)*0.05;
  if(path.startsWith(needle))return 20+(path.length-needle.length)*0.03;
  const nameIndex=name.indexOf(needle);if(nameIndex>=0)return 30+nameIndex+(name.length-needle.length)*0.05;
  const pathIndex=path.indexOf(needle);if(pathIndex>=0)return 40+pathIndex+(path.length-needle.length)*0.03;
  const compactNeedle=compactSearchText(needle);if(!compactNeedle)return null;
  const nameFuzzy=subsequenceScore(compactNeedle,compactSearchText(name));
  const pathFuzzy=subsequenceScore(compactNeedle,compactSearchText(path));
  if(nameFuzzy==null&&pathFuzzy==null)return null;
  return Math.min(nameFuzzy==null?Infinity:60+nameFuzzy,pathFuzzy==null?Infinity:80+pathFuzzy);
}

export function rankWorkspaceSearchItems(entries,query,{limit=100}={}){
  const bounded=Math.max(1,Math.min(500,Number(limit)||100));
  return (entries||[]).filter(entry=>entry?.isFile!==false).map(entry=>({entry,score:workspaceSearchScore(entry,query)}))
    .filter(item=>item.score!=null&&Number.isFinite(item.score))
    .sort((a,b)=>a.score-b.score||String(a.entry.relativePath||a.entry.path||"").length-String(b.entry.relativePath||b.entry.path||"").length||String(a.entry.relativePath||a.entry.path||"").localeCompare(String(b.entry.relativePath||b.entry.path||"")))
    .slice(0,bounded).map(item=>item.entry);
}

async function localGitFiles(root){
  try{
    const {stdout}=await execFileAsync("git",["-C",root,"ls-files","-co","--exclude-standard","-z"],{windowsHide:true,maxBuffer:16*1024*1024,timeout:12000});
    return {available:true,entries:gitFileEntries(stdout,root)};
  }catch{return {available:false,entries:[]}}
}

async function remoteGitFiles(environments,environmentId,root){
  try{
    const result=await environments.executeArgv(environmentId,{command:"git",args:["-C",root,"ls-files","-co","--exclude-standard","-z"],cwd:"",timeoutMs:15000,maxOutput:16*1024*1024});
    return result.exitCode===0?{available:true,entries:gitFileEntries(result.stdout,root,{remote:true})}:{available:false,entries:[]};
  }catch{return {available:false,entries:[]}}
}

async function remoteTree(environments,environmentId,root,{depth=3,limit=500}={}){
  const profile=remoteProfile(environments,environmentId);if(!profile)return null;
  const base=posix.normalize(String(root||profile.cwd||"/"));
  const maxDepth=Math.max(1,Math.min(12,Number(depth)+1||4));
  const [dirs,files]=await Promise.all([
    environments.executeArgv(environmentId,{command:"find",args:remoteFindArgs(base,maxDepth,"d"),cwd:"",timeoutMs:15000}),
    environments.executeArgv(environmentId,{command:"find",args:remoteFindArgs(base,maxDepth,"f"),cwd:"",timeoutMs:15000}),
  ]);
  if(dirs.exitCode!==0||files.exitCode!==0)throw new Error(dirs.stderr||files.stderr||"Could not list remote workspace");
  const make=(raw,isDirectory)=>String(raw||"").split(/\r?\n/).filter(Boolean).map(full=>{
    const relativePath=posix.relative(base,full);
    return {name:posix.basename(full),path:full,relativePath,isDirectory,isFile:!isDirectory,depth:Math.max(0,relativePath.split("/").length-1)};
  }).filter(item=>item.relativePath&&!item.relativePath.startsWith("../"));
  const entries=[...make(dirs.stdout,true),...make(files.stdout,false)]
    .sort((a,b)=>Number(b.isDirectory)-Number(a.isDirectory)||a.relativePath.localeCompare(b.relativePath));
  return {root:base,entries:entries.slice(0,limit),truncated:entries.length>limit,environmentId};
}

export async function workspaceTree(root, { depth = 3, limit = 500 } = {}) {
  const absolute = resolve(root || process.cwd());
  const result = [];
  let remaining = limit;

  async function walk(dir, level) {
    if (level > depth || remaining <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (remaining-- <= 0) break;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      result.push({
        name: entry.name,
        path: full,
        relativePath: full.slice(absolute.length + (absolute.endsWith("/") || absolute.endsWith("\\") ? 0 : 1)),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        depth: level,
      });
      if (entry.isDirectory()) await walk(full, level + 1);
    }
  }
  await walk(absolute, 0);
  return { root: absolute, entries: result, truncated: remaining <= 0 };
}

export async function environmentWorkspaceTree(root,{depth=3,limit=500,environments=null,environmentId=null}={}){
  return await remoteTree(environments,environmentId,root,{depth,limit})||workspaceTree(root,{depth,limit});
}

export async function workspaceDiff(root) {
  const cwd = resolve(root || process.cwd());
  try {
    const { stdout, stderr } = await execFileAsync("git", ["diff","--no-ext-diff","--no-color"], {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const { stdout: statusOut } = await execFileAsync("git", ["status","--short"], {
      cwd,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }).catch(() => ({stdout:""}));
    return { cwd, isGit: true, status: statusOut, diff: stdout, stderr };
  } catch (error) {
    return { cwd, isGit: false, status: "", diff: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function environmentWorkspaceDiff(root,{environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceDiff(root);
  const cwd=posix.normalize(String(root||profile.cwd||"/"));
  const inside=await environments.executeArgv(environmentId,{command:"git",args:["rev-parse","--show-toplevel"],cwd,timeoutMs:12000});
  if(inside.exitCode!==0)return {cwd,isGit:false,status:"",diff:"",error:(inside.stderr||inside.stdout||"Not a Git repository").trim(),environmentId};
  const [diff,status]=await Promise.all([
    environments.executeArgv(environmentId,{command:"git",args:["diff","--no-ext-diff","--no-color"],cwd,timeoutMs:20000}),
    environments.executeArgv(environmentId,{command:"git",args:["status","--short"],cwd,timeoutMs:12000}),
  ]);
  return {cwd,isGit:true,status:status.stdout||"",diff:diff.stdout||"",stderr:[diff.stderr,status.stderr].filter(Boolean).join("\n"),environmentId};
}

export async function workspaceFile(filePath, maxBytes = 512_000) {
  const absolute = resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Not a file");
  if (info.size > maxBytes) throw new Error(`File is too large to preview (${Math.ceil(info.size/1024)} KB)`);
  const content = await readFile(absolute, "utf8");
  return { path: absolute, name: basename(absolute), content, size: info.size };
}

export async function environmentWorkspaceFile(filePath,maxBytes=512_000,{root=null,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceFile(filePath,maxBytes);
  const {absolute}=remotePath(root||profile.cwd||"/",filePath);
  const info=await environments.attachmentInfo(environmentId,absolute);
  if(info.size>maxBytes)throw new Error("File is too large to preview ("+Math.ceil(info.size/1024)+" KB)");
  const result=await environments.executeArgv(environmentId,{command:"cat",args:[absolute],cwd:"",timeoutMs:12000});
  if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote file");
  return {path:absolute,name:posix.basename(absolute),content:result.stdout,size:info.size,environmentId};
}


export async function workspaceSearch(root, query, { limit = 100 } = {}) {
  const absolute=resolve(root||process.cwd());
  const needle=String(query||"").trim();
  if(!needle) return {root:absolute,items:[]};
  const gitFiles=await localGitFiles(absolute);
  if(gitFiles.available)return {root:absolute,items:rankWorkspaceSearchItems(gitFiles.entries,needle,{limit}),source:"git"};
  const tree=await workspaceTree(absolute,{depth:12,limit:12000});
  return {root:absolute,items:rankWorkspaceSearchItems(tree.entries,needle,{limit}),source:"tree",truncated:tree.truncated};
}

export async function environmentWorkspaceSearch(root,query,{limit=100,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceSearch(root,query,{limit});
  const absolute=posix.normalize(String(root||profile.cwd||"/"));
  const needle=String(query||"").trim();
  if(!needle)return {root:absolute,items:[],environmentId};
  const gitFiles=await remoteGitFiles(environments,environmentId,absolute);
  if(gitFiles.available)return {root:absolute,items:rankWorkspaceSearchItems(gitFiles.entries,needle,{limit}),environmentId,source:"git"};
  const tree=await remoteTree(environments,environmentId,absolute,{depth:12,limit:8000});
  return {root:absolute,items:rankWorkspaceSearchItems(tree.entries,needle,{limit}),environmentId,source:"tree",truncated:tree.truncated};
}

export async function workspaceWriteFile(filePath, content) {
  const absolute=resolve(filePath);
  await mkdir(join(absolute,".."),{recursive:true}).catch(()=>{});
  await writeFile(absolute,String(content??""),"utf8");
  return workspaceFile(absolute,2*1024*1024);
}

export async function environmentWorkspaceWriteFile(filePath,content,{root=null,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceWriteFile(filePath,content);
  const {absolute}=remotePath(root||profile.cwd||"/",filePath);
  const bytes=Buffer.byteLength(String(content??""),"utf8");
  if(bytes>2*1024*1024)throw new Error("File is too large to edit (maximum 2 MB)");
  await environments.writeTextFile(environmentId,absolute,content);
  return environmentWorkspaceFile(absolute,2*1024*1024,{root:root||profile.cwd,environments,environmentId});
}

export function environmentWorkspacePath(root,filePath,{environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return {remote:false,root:resolve(root||process.cwd()),path:resolve(filePath||"")};
  const resolved=remotePath(root||profile.cwd||"/",filePath);
  return {remote:true,root:resolved.base,path:resolved.absolute,profile};
}
