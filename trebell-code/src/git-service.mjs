import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, resolve } from "node:path";
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

export async function gitInfo(cwd){
  const base=resolve(cwd);
  const rootRes=await git(base,["rev-parse","--show-toplevel"],{allowFailure:true});
  if(!rootRes.ok) return {isGit:false,cwd:base,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]};
  const root=rootRes.stdout.trim();
  const [branchRes,branchesRes,statusRes,remoteRes,worktreeRes,upstreamRes]=await Promise.all([
    git(root,["branch","--show-current"],{allowFailure:true}),
    git(root,["for-each-ref","--format=%(refname:short)","refs/heads"],{allowFailure:true}),
    git(root,["status","--porcelain=v1","-b"],{allowFailure:true}),
    git(root,["remote","-v"],{allowFailure:true}),
    git(root,["worktree","list","--porcelain"],{allowFailure:true}),
    git(root,["rev-parse","--abbrev-ref","--symbolic-full-name","@{u}"],{allowFailure:true}),
  ]);
  const statusLines=statusRes.stdout.split(/\r?\n/).filter(Boolean);
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
  return {
    isGit:true,cwd:base,root,branch:branchRes.stdout.trim()||null,
    upstream:upstreamRes.ok?upstreamRes.stdout.trim():null,
    branches:branchesRes.stdout.split(/\r?\n/).filter(Boolean),
    status:statusLines.slice(1).map(line=>({code:line.slice(0,2),path:line.slice(3)})),
    statusHeader:statusLines[0]||"",
    remotes,worktrees,
  };
}

export async function cloneRepository(url,destination){
  const dest=resolve(destination);
  await mkdir(dirname(dest),{recursive:true});
  await run("git",["clone",url,dest],{cwd:dirname(dest),timeout:10*60_000,maxBuffer:16*1024*1024});
  return gitInfo(dest);
}
export async function createBranch(cwd,name,{checkout=true,startPoint=null}={}){
  const args=checkout?["switch","-c",name]:["branch",name];
  if(startPoint) args.push(startPoint);
  await git(cwd,args); return gitInfo(cwd);
}
export async function switchBranch(cwd,name){ await git(cwd,["switch",name]); return gitInfo(cwd); }
export async function commitAll(cwd,message){
  await git(cwd,["add","-A"]);
  const result=await git(cwd,["commit","-m",message],{allowFailure:true});
  return {result,...await gitInfo(cwd)};
}
export async function fetchRepo(cwd){ await git(cwd,["fetch","--all","--prune"]); return gitInfo(cwd); }
export async function pullRepo(cwd){ await git(cwd,["pull","--ff-only"]); return gitInfo(cwd); }
export async function pushRepo(cwd,{setUpstream=false}={}){
  const info=await gitInfo(cwd);
  const args=setUpstream&&info.branch?["push","-u","origin",info.branch]:["push"];
  await git(cwd,args); return gitInfo(cwd);
}
export async function safeAutoPull(cwd){
  const info=await gitInfo(cwd);
  if(!info.isGit) return {ok:false,reason:"not_git",info};
  if(info.status.length) return {ok:false,reason:"dirty",info};
  if(!info.upstream) return {ok:false,reason:"no_upstream",info};
  await git(info.root,["pull","--ff-only"]);
  return {ok:true,info:await gitInfo(info.root)};
}
export async function createWorktree(cwd,{branch,path,baseBranch=null}){
  const info=await gitInfo(cwd);
  if(!info.isGit) throw new Error("Workspace is not a Git repository");
  const dest=resolve(path);
  const args=["worktree","add"];
  if(branch){ args.push("-b",branch); }
  args.push(dest);
  if(baseBranch) args.push(baseBranch);
  await git(info.root,args,{timeout:180000});
  return {worktree:dest,info:await gitInfo(info.root)};
}
export async function removeWorktree(cwd,path,{force=false}={}){
  const info=await gitInfo(cwd);
  const args=["worktree","remove"];
  if(force) args.push("--force");
  args.push(resolve(path));
  await git(info.root,args,{timeout:180000});
  return gitInfo(info.root);
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
