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
  const needle=String(query||"").trim().toLowerCase();
  if(!needle) return {root:absolute,items:[]};
  const tree=await workspaceTree(absolute,{depth:8,limit:3000});
  const items=tree.entries
    .filter(entry=>entry.isFile && (entry.name.toLowerCase().includes(needle)||entry.relativePath.toLowerCase().includes(needle)))
    .slice(0,limit);
  return {root:absolute,items};
}

export async function environmentWorkspaceSearch(root,query,{limit=100,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceSearch(root,query,{limit});
  const absolute=posix.normalize(String(root||profile.cwd||"/"));
  const needle=String(query||"").trim().toLowerCase();
  if(!needle)return {root:absolute,items:[],environmentId};
  const tree=await remoteTree(environments,environmentId,absolute,{depth:8,limit:3000});
  const items=tree.entries
    .filter(entry=>entry.isFile&&(entry.name.toLowerCase().includes(needle)||entry.relativePath.toLowerCase().includes(needle)))
    .slice(0,limit);
  return {root:absolute,items,environmentId};
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
