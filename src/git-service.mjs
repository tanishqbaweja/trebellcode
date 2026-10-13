import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const execFileAsync=promisify(execFile);

async function run(command,args,{cwd,env=process.env,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  try{
    const result=await execFileAsync(command,args,{cwd,env,windowsHide:true,timeout,maxBuffer});
    return {ok:true,stdout:result.stdout||"",stderr:result.stderr||""};
  }catch(error){
    if(!allowFailure) throw new Error((error.stderr||error.stdout||error.message||String(error)).trim());
    return {ok:false,stdout:error.stdout||"",stderr:error.stderr||error.message||"",code:error.code??1};
  }
}
export async function git(cwd,args,opts={}){ return run("git",args,{cwd,...opts}); }

// The repository part of a folder's gitInfo (root, branch, branches, upstream, remotes, worktrees) is kept while the files git reads
// it from are unchanged, for at most 30 s: HEAD from the git dir (so a linked worktree or a submodule reads its own), and config,
// packed-refs, refs/heads, refs/remotes (the upstream needs its ref) and worktrees from the common dir. git replaces a ref through a
// lock file in its own folder, which changes that folder's modification time, so every folder below the refs (a commit on
// feature/x, a new branch in it) counts too. In worktrees, the folder counts (a worktree added or removed) and each worktree's HEAD
// and gitdir (its path, which git worktree move and repair write in place), but not each worktree's folder: that is a linked
// worktree's git dir, which holds its index, and every status that may write the index (the full read's, an agent's git add)
// creates and removes the index lock there. A reftable repository (--ref-format=reftable, the default planned for Git 3) keeps
// every ref, HEAD among them, in a reftable folder instead, where git replaces tables.list on each update: the common dir's holds
// the branches and the main worktree's HEAD, and each linked worktree's folder has its own for its HEAD; .git/HEAD and refs/heads
// are stubs that never change. A warm poll then runs only git status, which is read every time.
// A caller's own env (a checkpoint's) can point git elsewhere, so only calls without one are kept.
const GIT_INFO_REUSE_MS=30_000;
const STATUS_ARGS=["status","--porcelain=v1","-b"];
const repositoryParts=new Map();
// The folder asked about and each one above it below the root: git looks in each for a repository of its own (a .git, or a bare
// repository's HEAD) before it reaches the root, so a git init, a clone or a new worktree there makes the next poll read everything.
function foldersBelowRoot(base,root){
  const folders=[],top=resolve(root),same=process.platform==="win32"?(a,b)=>a.toLowerCase()===b.toLowerCase():(a,b)=>a===b;
  for(let folder=base;!same(folder,top);){folders.push(folder);const parent=dirname(folder);if(parent===folder)break;folder=parent}
  return folders;
}
function repositorySignature(gitDir,commonDir,base,root){
  const parts=[];
  const add=(path,depth=0)=>{
    let info;try{info=statSync(path)}catch{parts.push("-");return}
    parts.push(info.mtimeMs+":"+info.size+":"+info.ino);
    if(depth>0&&info.isDirectory()){let entries=[];try{entries=readdirSync(path,{withFileTypes:true})}catch{}for(const entry of entries)if(entry.isDirectory())add(join(path,entry.name),depth-1)}
  };
  add(join(gitDir,"HEAD"));add(join(gitDir,"config.worktree"));add(join(commonDir,"config"));add(join(commonDir,"packed-refs"));
  add(join(commonDir,"refs","heads"),16);add(join(commonDir,"refs","remotes"),16);
  const worktrees=join(commonDir,"worktrees");add(worktrees);
  let linked=[];try{linked=readdirSync(worktrees,{withFileTypes:true}).filter(entry=>entry.isDirectory())}catch{}
  for(const entry of linked){
    parts.push(entry.name);add(join(worktrees,entry.name,"HEAD"));add(join(worktrees,entry.name,"gitdir"));add(join(worktrees,entry.name,"reftable","tables.list"));
  }
  add(join(gitDir,"reftable","tables.list"));add(join(commonDir,"reftable","tables.list"));
  for(const folder of foldersBelowRoot(base,root)){add(join(folder,".git"));add(join(folder,"HEAD"))}
  return parts.join("|");
}
// A warm poll's status never takes git's optional index lock, so a poll every 3.5 s does not hold the lock an agent's git add or
// commit needs (git fails at once when it is held) or rewrite the index and wake file watchers. The full read, at most 30 s apart,
// lets status take it: a file written again with the same content (a build, a formatter, a copy) differs from its index entry only
// in its times, and git reads and hashes it on every status until one that may write the index records them.
const statusOptions=opts=>({...opts,env:{...(opts.env||process.env),GIT_OPTIONAL_LOCKS:"0"},allowFailure:true});
function gitInfoResult(base,part,statusRes){
  const statusLines=statusRes.stdout.split(/\r?\n/).filter(Boolean);
  return {
    isGit:true,cwd:base,root:part.root,branch:part.branch,
    upstream:part.upstream,
    branches:[...part.branches],
    status:statusLines.slice(1).map(line=>({code:line.slice(0,2),path:line.slice(3)})),
    statusHeader:statusLines[0]||"",
    remotes:part.remotes.map(item=>({...item})),worktrees:part.worktrees.map(item=>({...item})),
  };
}

// gitFn runs each git command (tests count them through it); fresh reads the repository part again.
export async function gitInfo(cwd,{gitFn=git,fresh=false,...opts}={}){
  const base=resolve(cwd),cacheable=!opts.env,known=cacheable?repositoryParts.get(base):null;
  if(known&&!fresh&&Date.now()-known.at<GIT_INFO_REUSE_MS&&repositorySignature(known.gitDir,known.commonDir,base,known.root)===known.signature){
    const statusRes=await gitFn(known.root,STATUS_ARGS,statusOptions(opts));
    if(statusRes.ok)return gitInfoResult(base,known,statusRes);
  }
  const rootRes=await gitFn(base,["rev-parse","--show-toplevel","--absolute-git-dir","--git-common-dir"],{...opts,allowFailure:true});
  if(!rootRes.ok){repositoryParts.delete(base);return {isGit:false,cwd:base,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}}
  const [root,gitDir="",commonLine=""]=rootRes.stdout.split(/\r?\n/).map(line=>line.trim());
  // Read before the commands below, so a change while they run makes the next poll read everything again.
  const commonDir=commonLine?resolve(base,commonLine):"",signature=cacheable&&isAbsolute(gitDir)&&commonDir?repositorySignature(gitDir,commonDir,base,root):null;
  const [branchRes,branchesRes,statusRes,remoteRes,worktreeRes,upstreamRes]=await Promise.all([
    gitFn(root,["branch","--show-current"],{...opts,allowFailure:true}),
    gitFn(root,["for-each-ref","--format=%(refname:short)","refs/heads"],{...opts,allowFailure:true}),
    gitFn(root,STATUS_ARGS,{...opts,allowFailure:true}),
    gitFn(root,["remote","-v"],{...opts,allowFailure:true}),
    gitFn(root,["worktree","list","--porcelain"],{...opts,allowFailure:true}),
    gitFn(root,["rev-parse","--abbrev-ref","--symbolic-full-name","@{u}"],{...opts,allowFailure:true}),
  ]);
  const remotes=remoteRes.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
    const m=line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    return m?{name:m[1],url:m[2],kind:m[3]}:{raw:line};
  });
  const worktrees=[];
  let current=null;
  for(const line of worktreeRes.stdout.split(/\r?\n/)){
    if(line.startsWith("worktree ")){ if(current) worktrees.push(current); current={path:line.slice(9)}; }
    else if(current&&line.startsWith("HEAD ")) current.head=line.slice(5);
    else if(current&&line.startsWith("branch ")) current.branch=line.slice(7).replace(/^refs\/heads\//,"");
    else if(current&&line==="bare") current.bare=true;
  }
  if(current) worktrees.push(current);
  const part={root,branch:branchRes.stdout.trim()||null,upstream:upstreamRes.ok?upstreamRes.stdout.trim():null,branches:branchesRes.stdout.split(/\r?\n/).filter(Boolean),remotes,worktrees};
  if(signature)repositoryParts.set(base,{...part,at:Date.now(),gitDir,commonDir,signature});else repositoryParts.delete(base);
  return gitInfoResult(base,part,statusRes);
}

export async function cloneRepository(url,destination){
  const dest=resolve(destination);
  await mkdir(dirname(dest),{recursive:true});
  await run("git",["clone",url,dest],{cwd:dirname(dest),timeout:10*60_000,maxBuffer:16*1024*1024});
  return gitInfo(dest,{fresh:true});
}
export async function initializeRepository(cwd){
  const target=resolve(cwd);await mkdir(target,{recursive:true});
  await git(target,["init"]);return gitInfo(target,{fresh:true});
}
export async function createBranch(cwd,name,{checkout=true,startPoint=null}={}){
  const args=checkout?["switch","-c",name]:["branch",name];
  if(startPoint) args.push(startPoint);
  await git(cwd,args); return gitInfo(cwd,{fresh:true});
}
export async function switchBranch(cwd,name){ await git(cwd,["switch",name]); return gitInfo(cwd,{fresh:true}); }
export async function commitAll(cwd,message){
  await git(cwd,["add","-A"]);
  const result=await git(cwd,["commit","-m",message],{allowFailure:true});
  return {result,...await gitInfo(cwd,{fresh:true})};
}
export async function fetchRepo(cwd){ await git(cwd,["fetch","--all","--prune"]); return gitInfo(cwd,{fresh:true}); }
export async function pullRepo(cwd){ await git(cwd,["pull","--ff-only"]); return gitInfo(cwd,{fresh:true}); }
export async function pushRepo(cwd,{setUpstream=false}={}){
  const info=await gitInfo(cwd);
  const args=setUpstream&&info.branch?["push","-u","origin",info.branch]:["push"];
  await git(cwd,args); return gitInfo(cwd,{fresh:true});
}
export async function safeAutoPull(cwd){
  let info=await gitInfo(cwd);
  if(!info.isGit) return {ok:false,reason:"not_git",info};
  if(info.status.length) return {ok:false,reason:"dirty",info};
  if(!info.upstream) return {ok:false,reason:"no_upstream",info};
  if(!info.branch)return {ok:false,reason:"detached",info};
  const slash=info.upstream.indexOf("/");if(slash<=0)return {ok:false,reason:"invalid_upstream",info};
  const remote=info.upstream.slice(0,slash);
  const fetched=await git(info.root,["fetch",remote,"--prune"],{allowFailure:true,timeout:120000});
  if(!fetched.ok)return {ok:false,reason:"fetch_failed",error:(fetched.stderr||fetched.stdout||"Git fetch failed").trim(),info};
  info=await gitInfo(info.root);
  if(info.status.length)return {ok:false,reason:"dirty",info};
  let defaultBranch=null;
  const head=await git(info.root,["symbolic-ref","refs/remotes/"+remote+"/HEAD","--short"],{allowFailure:true});
  if(head.ok&&head.stdout.trim()){const short=head.stdout.trim();defaultBranch=short.startsWith(remote+"/")?short.slice(remote.length+1):short}
  if(!defaultBranch){
    const shown=await git(info.root,["remote","show",remote],{allowFailure:true,timeout:120000});
    defaultBranch=shown.ok?(shown.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m)?.[1]||null):null;
  }
  if(!defaultBranch)return {ok:false,reason:"default_branch_unknown",info};
  if(info.branch!==defaultBranch)return {ok:false,reason:"not_default_branch",defaultBranch,info};
  const counts=await git(info.root,["rev-list","--left-right","--count",info.upstream+"...HEAD"],{allowFailure:true});
  if(!counts.ok)return {ok:false,reason:"compare_failed",error:(counts.stderr||counts.stdout||"Could not compare upstream").trim(),defaultBranch,info};
  const [behindRaw,aheadRaw]=counts.stdout.trim().split(/\s+/);const behind=Number(behindRaw)||0,ahead=Number(aheadRaw)||0;
  if(ahead>0)return {ok:false,reason:"local_commits",ahead,behind,defaultBranch,info};
  if(behind===0)return {ok:true,changed:false,ahead,behind,defaultBranch,info};
  await git(info.root,["pull","--ff-only"]);
  return {ok:true,changed:true,ahead:0,behind,defaultBranch,info:await gitInfo(info.root,{fresh:true})};
}
export function worktreeSubmoduleArgs(mode="recursive"){
  if(mode==="none")return null;
  return mode==="top-level"?["submodule","update","--init"]:["submodule","update","--init","--recursive"];
}
export async function createWorktree(cwd,{branch,path,baseBranch=null,submodules="recursive"}){
  const info=await gitInfo(cwd);
  if(!info.isGit) throw new Error("Workspace is not a Git repository");
  const dest=resolve(path);
  const args=["worktree","add"];
  if(branch){ args.push("-b",branch); }
  args.push(dest);
  if(baseBranch) args.push(baseBranch);
  await git(info.root,args,{timeout:180000});
  const submoduleArgs=worktreeSubmoduleArgs(submodules);
  if(submoduleArgs)await git(dest,submoduleArgs,{timeout:10*60_000,maxBuffer:16*1024*1024});
  return {worktree:dest,submodules:submodules||"recursive",info:await gitInfo(info.root,{fresh:true})};
}
export async function restoreWorktree(cwd,{branch,path,submodules="recursive"}){
  const info=await gitInfo(cwd);if(!info.isGit)throw new Error("Source workspace is not a Git repository");
  const dest=resolve(path);const branchName=String(branch||"").trim();if(!branchName)throw new Error("Managed worktree branch is missing");
  await git(info.root,["worktree","add",dest,branchName],{timeout:180000});
  const submoduleArgs=worktreeSubmoduleArgs(submodules);if(submoduleArgs)await git(dest,submoduleArgs,{timeout:10*60_000,maxBuffer:16*1024*1024});
  return {worktree:dest,submodules,info:await gitInfo(info.root,{fresh:true})};
}
export async function removeWorktree(cwd,path,{force=false}={}){
  const info=await gitInfo(cwd);
  const args=["worktree","remove"];
  if(force) args.push("--force");
  args.push(resolve(path));
  await git(info.root,args,{timeout:180000});
  return gitInfo(info.root,{fresh:true});
}
export async function sourceControlDiagnostics(cwd){
  const [gitVersion,ghVersion,ghAuth]=await Promise.all([
    run("git",["--version"],{cwd,allowFailure:true}),
    run("gh",["--version"],{cwd,allowFailure:true}),
    run("gh",["auth","status"],{cwd,allowFailure:true}),
  ]);
  return {
    git:{installed:gitVersion.ok,version:(gitVersion.stdout||gitVersion.stderr).split(/\r?\n/)[0]||null},
    github:{installed:ghVersion.ok,version:(ghVersion.stdout||"").split(/\r?\n/)[0]||null,authenticated:ghAuth.ok,detail:(ghAuth.stdout||ghAuth.stderr).trim()},
  };
}
export async function listPullRequests(cwd){
  const result=await run("gh",["pr","list","--limit","50","--json","number,title,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup"],{cwd,allowFailure:true,maxBuffer:4*1024*1024});
  if(!result.ok) return {ok:false,error:(result.stderr||result.stdout).trim(),items:[]};
  try{return {ok:true,items:JSON.parse(result.stdout)}}catch{return {ok:false,error:"Could not parse gh output",items:[]}}
}
export async function createPullRequest(cwd,{title,body="",base=null,draft=false}){
  const args=["pr","create","--title",title,"--body",body];
  if(base) args.push("--base",base);
  if(draft) args.push("--draft");
  const result=await run("gh",args,{cwd});
  return {url:result.stdout.trim()};
}

export async function pullRequestDetail(cwd,number){
  const result=await run("gh",["pr","view",String(number),"--json","number,title,body,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,comments,reviews,files,commits"],{cwd,allowFailure:true,maxBuffer:8*1024*1024});
  if(!result.ok) return {ok:false,error:(result.stderr||result.stdout).trim(),item:null};
  try{return {ok:true,item:JSON.parse(result.stdout)}}catch{return {ok:false,error:"Could not parse gh output",item:null}}
}
export async function commentOnPullRequest(cwd,number,body){
  const result=await run("gh",["pr","comment",String(number),"--body",body],{cwd});
  return {ok:true,url:result.stdout.trim()};
}
export async function reviewPullRequest(cwd,number,{event="COMMENT",body=""}={}){
  const flag=event==="APPROVE"?"--approve":event==="REQUEST_CHANGES"?"--request-changes":"--comment";
  const args=["pr","review",String(number),flag];
  if(body) args.push("--body",body);
  await run("gh",args,{cwd});
  return {ok:true};
}
export async function mergePullRequest(cwd,number,{method="squash",auto=false}={}){
  const flag=method==="merge"?"--merge":method==="rebase"?"--rebase":"--squash";
  const args=["pr","merge",String(number),flag];
  if(auto) args.push("--auto"); else args.push("--delete-branch");
  const result=await run("gh",args,{cwd});
  return {ok:true,output:(result.stdout||result.stderr).trim()};
}

export async function updatePullRequestBranch(cwd,number,{rebase=true}={}){
  const args=["pr","update-branch",String(number)];
  if(rebase) args.push("--rebase");
  const result=await run("gh",args,{cwd,allowFailure:true,maxBuffer:4*1024*1024});
  if(!result.ok) throw new Error((result.stderr||result.stdout||"Could not update PR branch").trim());
  return {ok:true,output:(result.stdout||result.stderr).trim()};
}
