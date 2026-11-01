import { execFile, spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { gitEnvironment, gitInfo as localGitInfo, gitReason, removeWorktreeKeepingLinks, worktreeTurn, worktreeTurnKey } from "./git-service.mjs";

const execFileAsync=promisify(execFile);
const executionContext=new AsyncLocalStorage();
const PROVIDERS=["github","gitlab","forgejo","bitbucket","azure-devops"];

// editMerged: the host still edits a merged pull request's title and description (Bitbucket and Azure DevOps refuse to change one
// that is merged or completed).
const CAPABILITIES={
  github:{create:true,edit:true,editMerged:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,publish:true,viewedFiles:"host",approveWorkflows:true,revert:true,stacks:true},
  gitlab:{create:true,edit:true,editMerged:true,comment:true,editComments:true,review:true,requestChanges:false,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  forgejo:{create:true,edit:true,editMerged:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:false,updateBranch:true,checkout:false,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  bitbucket:{create:true,edit:true,editMerged:false,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:false,updateBranch:false,checkout:false,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  "azure-devops":{create:true,edit:true,editMerged:false,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:true,updateBranch:false,checkout:false,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
};

function currentExecutor(){return executionContext.getStore()?.executor||null}
export async function withSourceControlExecutor(executor,callback){
  if(!executor)return callback();
  return executionContext.run({executor},callback);
}

// A command that fails says why as git would to the Git panel: git's reason without the hints it adds for a terminal (gitReason),
// with the conflicts a revert or a rebase stopped on, which git writes to its output instead. The panel used to show the hints'
// commands too, for a temporary worktree already removed by then. git runs with its messages in English (gitEnvironment).
function refusal(result,fallback){
  const stderr=String(result?.stderr||"").trim(),stdout=String(result?.stdout||"").trim();
  if(!stderr)return gitReason(stdout||fallback);
  return gitReason([stderr,...stdout.split(/\r?\n/).filter(line=>line.startsWith("CONFLICT ("))].join("\n"));
}
const commandEnvironment=command=>command==="git"?gitEnvironment(process.env):process.env;
async function run(command,args,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  const executor=currentExecutor();
  if(executor?.run){
    const result=await executor.run(command,args,{cwd,timeout,maxBuffer});
    const normalized={ok:result?.ok!==false&&Number(result?.code??result?.exitCode??0)===0,stdout:result?.stdout||"",stderr:result?.stderr||"",code:Number(result?.code??result?.exitCode??0)};
    if(normalized.ok||allowFailure)return normalized;
    throw new Error(refusal(normalized,`${command} failed`));
  }
  try{
    const result=await execFileAsync(command,args,{cwd,env:commandEnvironment(command),windowsHide:true,timeout,maxBuffer});
    return {ok:true,stdout:result.stdout||"",stderr:result.stderr||""};
  }catch(error){
    if(!allowFailure) throw new Error(refusal(error,error.message||String(error)));
    return {ok:false,stdout:error.stdout||"",stderr:error.stderr||error.message||"",code:error.code??1};
  }
}

async function runStdin(command,args,input,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  const executor=currentExecutor();
  if(executor?.runStdin){
    const result=await executor.runStdin(command,args,input,{cwd,timeout,maxBuffer});
    const normalized={ok:result?.ok!==false&&Number(result?.code??result?.exitCode??0)===0,stdout:result?.stdout||"",stderr:result?.stderr||"",code:Number(result?.code??result?.exitCode??0)};
    if(normalized.ok||allowFailure)return normalized;
    throw new Error(refusal(normalized,`${command} failed`));
  }
  return await new Promise((resolve,reject)=>{
    let stdout="",stderr="",settled=false;
    const child=spawn(command,args,{cwd,env:commandEnvironment(command),windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{}},timeout);
    const append=(current,chunk)=>{const next=current+String(chunk);return Buffer.byteLength(next,"utf8")>maxBuffer?Buffer.from(next).subarray(0,maxBuffer).toString("utf8"):next};
    child.stdout.on("data",chunk=>{stdout=append(stdout,chunk)});
    child.stderr.on("data",chunk=>{stderr=append(stderr,chunk)});
    child.once("error",error=>{if(settled)return;settled=true;clearTimeout(timer);if(allowFailure)resolve({ok:false,stdout,stderr:error.message,code:1});else reject(error)});
    child.once("close",code=>{if(settled)return;settled=true;clearTimeout(timer);const result={ok:code===0,stdout,stderr,code};if(code===0||allowFailure)resolve(result);else reject(new Error(refusal(result,`${command} failed`)))});
    child.stdin.end(input??"");
  });
}

async function serviceGitInfo(cwd){
  const executor=currentExecutor();
  if(!executor)return localGitInfo(cwd);
  // A local executor's repository is read from its files, as the Git panel reads it: the git commands that are still needed (2
  // where 7 ran one after another) go through the executor. A Native branch_create read the info twice, 15 git processes in all.
  if(executor.local)return localGitInfo(cwd,{gitFn:(dir,args,{allowFailure=false}={})=>run("git",args,{cwd:dir,allowFailure}),env:executor.environmentFor?.("git")||process.env});
  const base=String(cwd||"").trim();
  const rootRes=await run("git",["rev-parse","--show-toplevel"],{cwd:base,allowFailure:true});
  if(!rootRes.ok)return {isGit:false,cwd:base,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]};
  const root=rootRes.stdout.trim();
  const branchRes=await run("git",["branch","--show-current"],{cwd:root,allowFailure:true});
  const branchesRes=await run("git",["for-each-ref","--format=%(refname:short)","refs/heads"],{cwd:root,allowFailure:true});
  const statusRes=await run("git",["status","--porcelain=v1","-b"],{cwd:root,allowFailure:true});
  const remoteRes=await run("git",["remote","-v"],{cwd:root,allowFailure:true});
  const worktreeRes=await run("git",["worktree","list","--porcelain"],{cwd:root,allowFailure:true});
  const branch=branchRes.stdout.trim();
  const upstreamRes=branch
    ?await run("git",["for-each-ref","--format=%(upstream:short)","refs/heads/"+branch],{cwd:root,allowFailure:true})
    :{ok:false,stdout:""};
  const statusLines=statusRes.stdout.split(/\r?\n/).filter(Boolean);
  const remotes=remoteRes.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
    const match=line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    return match?{name:match[1],url:match[2],kind:match[3]}:{raw:line};
  });
  const worktrees=[];let current=null;
  for(const line of worktreeRes.stdout.split(/\r?\n/)){
    if(line.startsWith("worktree ")){if(current)worktrees.push(current);current={path:line.slice(9)}}
    else if(current&&line.startsWith("HEAD "))current.head=line.slice(5);
    else if(current&&line.startsWith("branch "))current.branch=line.slice(7).replace(/^refs\/heads\//,"");
    else if(current&&line==="bare")current.bare=true;
  }
  if(current)worktrees.push(current);
  return {
    isGit:true,cwd:base,root,branch:branch||null,
    upstream:upstreamRes.ok?upstreamRes.stdout.trim()||null:null,
    branches:branchesRes.stdout.split(/\r?\n/).filter(Boolean),
    status:statusLines.slice(1).map(line=>({code:line.slice(0,2),path:line.slice(3)})),
    statusHeader:statusLines[0]||"",
    remotes,worktrees,
  };
}

async function serviceReadFile(path,encoding="utf8"){
  const executor=currentExecutor();
  if(executor?.readFile)return executor.readFile(path,encoding);
  return readFile(path,encoding);
}

async function serviceRequest(url,options={}){
  const executor=currentExecutor();
  if(executor?.request)return executor.request(url,options);
  const response=await fetch(url,options);
  const text=await response.text();
  return {ok:response.ok,status:response.status,text};
}

async function withServiceTempJson(value,callback){
  const content=JSON.stringify(value??{});
  const executor=currentExecutor();
  if(executor?.withTempJsonFile)return executor.withTempJsonFile(content,callback);
  const directory=await mkdtemp(pathJoin(tmpdir(),"trebell-azdo-"));
  const path=pathJoin(directory,"request.json");
  try{await writeFile(path,content,{encoding:"utf8",mode:0o600});return await callback(path)}
  finally{await rm(directory,{recursive:true,force:true}).catch(()=>{})}
}

export async function sourceControlGitInfo(cwd){
  return serviceGitInfo(cwd);
}

export async function sourceControlRecentCommitSubjects(cwd,{limit=8}={}){
  const info=await serviceGitInfo(cwd);if(!info.isGit)return [];
  const count=Math.max(1,Math.min(30,Number(limit)||8));
  const result=await run("git",["log","-n",String(count),"--pretty=%s"],{cwd:info.root,allowFailure:true,maxBuffer:256*1024});
  return result.ok?result.stdout.split(/\r?\n/).map(line=>line.trim()).filter(Boolean):[];
}

export async function sourceControlReviewRangeContext(cwd,{base=null}={}){
  const info=await serviceGitInfo(cwd);
  if(!info.isGit)return {isGit:false,baseBranch:null,baseRef:null,commitSummary:"",diffSummary:"",diff:""};
  const baseBranch=String(base||await defaultBaseBranch(info.root)).trim();
  if(!baseBranch)return {isGit:true,baseBranch:null,baseRef:null,commitSummary:"",diffSummary:"",diff:""};
  const fetchRemotes=[...new Set([
    ...(info.remotes||[]).filter(item=>item.kind==="fetch"&&item.name==="origin").map(item=>item.name),
    ...(info.remotes||[]).filter(item=>item.kind==="fetch"&&item.name!=="origin").map(item=>item.name),
  ])];
  let baseRef=baseBranch;
  for(const remote of fetchRemotes){
    const candidate=remote+"/"+baseBranch;
    const exists=await run("git",["rev-parse","--verify","--quiet","refs/remotes/"+candidate],{cwd:info.root,allowFailure:true,maxBuffer:64*1024});
    if(exists.ok&&exists.stdout.trim()){baseRef=candidate;break}
  }
  const commitRange=baseRef+"..HEAD",diffRange=baseRef+"...HEAD";
  const [commits,summary,patch]=await Promise.all([
    run("git",["log","--oneline",commitRange],{cwd:info.root,allowFailure:true,maxBuffer:512*1024}),
    run("git",["diff","--stat","--no-ext-diff","--no-color",diffRange],{cwd:info.root,allowFailure:true,maxBuffer:512*1024}),
    run("git",["diff","--no-ext-diff","--no-color","--patch","--minimal",diffRange],{cwd:info.root,allowFailure:true,maxBuffer:4*1024*1024}),
  ]);
  // A branch whose changes outgrow a read's buffer (generated or vendored files) still gets its title and description: the prompt
  // keeps only the start of each part, so a read cut at its buffer counts as read. It used to fail the whole request.
  const cut=result=>!result.ok&&result.code==="ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const error=[commits,summary,patch].find(result=>!result.ok&&!cut(result));
  if(error)throw new Error((error.stderr||error.stdout||"Could not compute pull request branch changes").trim());
  return {isGit:true,baseBranch,baseRef,commitSummary:commits.stdout||"",diffSummary:summary.stdout||"",diff:patch.stdout||"",cut:[commits,summary,patch].some(cut)};
}

// Pull request templates. A GitHub repository can commit the description its pull requests start from: one file in its .github
// folder, its root or its docs folder, or else the one Markdown file of a PULL_REQUEST_TEMPLATE folder in one of those (a folder
// that holds several asks the person to pick one, so none of them is the start). Review text follows it (gui-server's writing
// context). Only literals and functions at the top level: the Native runner bundles this module but never asks for a template,
// and esbuild leaves all of this out of its bundle.
const TEMPLATE_HOMES=[".github","","docs"];
const TEMPLATE_FILE_NAMES=["pull_request_template.md","PULL_REQUEST_TEMPLATE.md"];
const TEMPLATE_KEEP_CHARS=8000;
const inTemplateHome=(home,name)=>home?home+"/"+name:name;

// Where a template can be, best first: every home's single files, then every home's folder.
function templatePlaces(){
  const singleFiles=TEMPLATE_HOMES.flatMap(home=>TEMPLATE_FILE_NAMES.map(name=>({path:inTemplateHome(home,name),folder:false})));
  const folders=TEMPLATE_HOMES.map(home=>({path:inTemplateHome(home,"PULL_REQUEST_TEMPLATE"),folder:true}));
  return singleFiles.concat(folders);
}

// git ls-tree -z writes one "<mode> <type> <object>\t<name>" record per entry, ended by NUL, with the name as it is. A template is a
// regular file (mode 100644, or 100755 when executable) whose object is a Git object id: 40 hex digits, or 64 in a SHA-256
// repository. Links, submodules, folders and records of any other shape are left out. Maps each name to its object id.
function regularFilesListed(listing){
  const regularFile=/^100(?:644|755) blob ([\dA-Fa-f]{40}(?:[\dA-Fa-f]{24})?)\t([\s\S]+)$/;
  return new Map(String(listing||"").split("\0").map(record=>regularFile.exec(record)).filter(Boolean).map(([,id,name])=>[name,id]));
}

// The object ids a place offers, in the listing's order: a single file's own, or the Markdown files directly in a folder (a file
// in a folder below it is not one of its templates).
function templatesOffered(place,files){
  if(!place.folder)return files.has(place.path)?[files.get(place.path)]:[];
  const inside=place.path+"/";
  const isTemplate=name=>name.startsWith(inside)&&/^[^/]+$/.test(name.slice(inside.length))&&/\.md$/i.test(name);
  return [...files.keys()].filter(isTemplate).map(name=>files.get(name));
}

// What a template file starts the description with: its content without white space at either end, cut to its first 8,000
// characters (and marked so) when it is longer; null when nothing is left.
function templateStart(content){
  const text=String(content??"").trim();
  if(text.length<=TEMPLATE_KEEP_CHARS)return text||null;
  return text.slice(0,TEMPLATE_KEEP_CHARS)+"\n\n[truncated]";
}

// The template a GitHub repository commits in `treeish` (HEAD by default), or null. Files are read one at a time, best place first,
// through the selected environment's executor: a place gives its template when exactly one of its files has text, and a second one
// with text in a folder ends the search with none. A file git cannot give in 64 KiB, or one with only white space, has no text.
export async function sourceControlPullRequestTemplate(cwd,{treeish="HEAD"}={}){
  const ctx=await sourceContext(cwd).catch(()=>null);
  if(ctx?.provider!=="github")return null;
  // A tree name that starts with "-" would reach git as an option.
  const tree=String(treeish||"HEAD");if(tree.startsWith("-"))return null;
  const root=ctx.info.root,places=templatePlaces();
  const listing=await run("git",["ls-tree","--full-tree","-z","-r",tree,"--",...places.map(place=>place.path)],{cwd:root,allowFailure:true,maxBuffer:131072});
  if(!listing.ok)return null;
  const files=regularFilesListed(listing.stdout);
  for(const place of places){
    let template=null;
    for(const id of templatesOffered(place,files)){
      const read=await run("git",["cat-file","blob",id],{cwd:root,allowFailure:true,maxBuffer:65536});
      const text=read.ok?templateStart(read.stdout):null;
      if(!text)continue;
      if(template)return null;
      template=text;
    }
    if(template)return template;
  }
  return null;
}

// A Git action git refuses fails with git's reason, without the hints it adds for a terminal (refusal), as the local ones do.
const gitFailure=(result,fallback)=>new Error(refusal(result,fallback));
// A worktree add or remove waits its turn in its repository's queue, as the local ones do (git-service worktreeTurn): the executor's
// git names the repository's common git dir, and one on another host is known by its path there.
function inWorktreeTurn(root,task){
  const executor=currentExecutor();
  return worktreeTurnKey(root,{gitFn:(cwd,args,options)=>run("git",args,{cwd,...options}),remote:Boolean(executor&&!executor.local)}).then(key=>worktreeTurn(key,task));
}
// A worktree remove whose git runs on this machine leaves what the worktree's junctions point to, as the Git panel's does (git-service
// removeWorktreeKeepingLinks); another host's git (POSIX git deletes a link as a link) removes it as it is. A result, as run gives one.
function removeWorktreeHere(root,path,{force=false,timeout=120000}={}){
  const executor=currentExecutor(),gitFn=(cwd,args,options={})=>run("git",args,{cwd,timeout,...options});
  if(executor&&!executor.local)return gitFn(root,["worktree","remove",...(force?["--force"]:[]),path],{allowFailure:true});
  return removeWorktreeKeepingLinks(root,path,{force,gitFn});
}
export async function sourceControlGitAction(cwd,{action,name=null,message=null,setUpstream=false,startPoint=null,path=null,force=false}={}){
  const base=String(cwd||"").trim();
  if(!base)throw new Error("Repository path is required");
  if(action==="init"){
    const result=await run("git",["init"],{cwd:base,allowFailure:true});
    if(!result.ok)throw gitFailure(result,"Could not initialize Git");
    return serviceGitInfo(base);
  }
  const info=await serviceGitInfo(base);
  if(!info.isGit)throw new Error("Not a Git repository");
  const root=info.root;
  let result=null;
  if(action==="branch-create"){
    const branch=String(name||"").trim();if(!branch)throw new Error("Branch name is required");
    const args=["checkout","-b",branch];if(startPoint)args.push(String(startPoint));
    result=await run("git",args,{cwd:root,allowFailure:true});
  }else if(action==="branch-switch"){
    const branch=String(name||"").trim();if(!branch)throw new Error("Branch name is required");
    result=await run("git",["switch",branch],{cwd:root,allowFailure:true});
  }else if(action==="commit"){
    const subject=String(message||"").trim();if(!subject)throw new Error("Commit message is required");
    const add=await run("git",["add","-A"],{cwd:root,allowFailure:true});
    if(!add.ok)throw gitFailure(add,"Could not stage changes");
    result=await run("git",["commit","-m",subject],{cwd:root,allowFailure:true});
  }else if(action==="fetch"){
    result=await run("git",["fetch","--all","--prune"],{cwd:root,allowFailure:true,timeout:120000});
  }else if(action==="pull"){
    result=await run("git",["pull","--ff-only"],{cwd:root,allowFailure:true,timeout:120000});
  }else if(action==="auto-pull"){
    if(info.status.length)return {ok:false,reason:"dirty",info};
    if(!info.upstream)return {ok:false,reason:"no_upstream",info};
    if(!info.branch)return {ok:false,reason:"detached",info};
    const slash=info.upstream.indexOf("/");if(slash<=0)return {ok:false,reason:"invalid_upstream",info};
    const remote=info.upstream.slice(0,slash);
    const fetched=await run("git",["fetch",remote,"--prune"],{cwd:root,allowFailure:true,timeout:120000});
    if(!fetched.ok)return {ok:false,reason:"fetch_failed",error:(fetched.stderr||fetched.stdout||"Git fetch failed").trim(),info};
    const refreshed=await serviceGitInfo(root);
    if(refreshed.status.length)return {ok:false,reason:"dirty",info:refreshed};
    let defaultBranch=null;
    const head=await run("git",["symbolic-ref","refs/remotes/"+remote+"/HEAD","--short"],{cwd:root,allowFailure:true});
    if(head.ok&&head.stdout.trim()){const short=head.stdout.trim();defaultBranch=short.startsWith(remote+"/")?short.slice(remote.length+1):short}
    if(!defaultBranch){
      const shown=await run("git",["remote","show",remote],{cwd:root,allowFailure:true,timeout:120000});
      defaultBranch=shown.ok?(shown.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m)?.[1]||null):null;
    }
    if(!defaultBranch)return {ok:false,reason:"default_branch_unknown",info:refreshed};
    if(refreshed.branch!==defaultBranch)return {ok:false,reason:"not_default_branch",defaultBranch,info:refreshed};
    const counts=await run("git",["rev-list","--left-right","--count",refreshed.upstream+"...HEAD"],{cwd:root,allowFailure:true});
    if(!counts.ok)return {ok:false,reason:"compare_failed",error:(counts.stderr||counts.stdout||"Could not compare upstream").trim(),defaultBranch,info:refreshed};
    const [behindRaw,aheadRaw]=counts.stdout.trim().split(/\s+/);const behind=Number(behindRaw)||0,ahead=Number(aheadRaw)||0;
    if(ahead>0)return {ok:false,reason:"local_commits",ahead,behind,defaultBranch,info:refreshed};
    if(behind===0)return {ok:true,changed:false,ahead,behind,defaultBranch,info:refreshed};
    result=await run("git",["pull","--ff-only"],{cwd:root,allowFailure:true,timeout:120000});
    if(result&&!result.ok)throw gitFailure(result,"Git auto-pull failed");
    return {ok:true,changed:true,ahead:0,behind,defaultBranch,info:await serviceGitInfo(root),output:(result?.stdout||result?.stderr||"").trim()};
  }else if(action==="push"){
    const args=["push"];
    if(setUpstream){
      if(!info.branch)throw new Error("Cannot set upstream from a detached HEAD");
      const remote=info.remotes?.find(item=>item.name==="origin"&&item.kind==="push")?.name||info.remotes?.find(item=>item.kind==="push")?.name||"origin";
      args.push("-u",remote,info.branch);
    }
    result=await run("git",args,{cwd:root,allowFailure:true,timeout:120000});
  }else if(action==="worktree-create"){
    const branch=String(name||"").trim();const target=String(path||"").trim();
    if(!branch||!target)throw new Error("Worktree branch and path are required");
    const args=["worktree","add","-b",branch,target];if(startPoint)args.push(String(startPoint));
    result=await inWorktreeTurn(root,()=>run("git",args,{cwd:root,allowFailure:true,timeout:120000}));
  }else if(action==="worktree-remove"){
    const target=String(path||"").trim();if(!target)throw new Error("Worktree path is required");
    result=await inWorktreeTurn(root,()=>removeWorktreeHere(root,target,{force}));
  }else{
    throw new Error("Unsupported source-control Git action");
  }
  if(result&&!result.ok)throw gitFailure(result,"Git "+action+" failed");
  return {info:await serviceGitInfo(root),output:(result?.stdout||result?.stderr||"").trim()};
}

// Text without the slashes at either end.
function withoutEdgeSlashes(text){
  const value=String(text);let start=0,end=value.length;
  while(start<end&&value[start]==="/")start++;
  while(end>start&&value[end-1]==="/")end--;
  return value.slice(start,end);
}

// The repository path of a remote: no slash at either end, then no ".git" (in any case) at the end.
function remoteRepoPath(text){
  const path=withoutEdgeSlashes(text);
  return path.toLowerCase().endsWith(".git")?path.slice(0,-4):path;
}

export function parseRemoteUrl(value=""){
  const raw=String(value||"").trim();
  if(!raw)return null;
  const scp=raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if(scp&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)){
    return {raw,host:scp[1].toLowerCase(),path:remoteRepoPath(scp[2]),ssh:true};
  }
  try{const url=new URL(raw);return {raw,host:url.host.toLowerCase(),hostname:url.hostname.toLowerCase(),path:remoteRepoPath(url.pathname),ssh:url.protocol==="ssh:"}}catch{return null}
}

export function detectSourceControlProvider(remoteUrl){
  const remote=parseRemoteUrl(remoteUrl); if(!remote)return "unknown";
  const host=(remote.hostname||remote.host||"").toLowerCase();
  if(host==="github.com"||host.endsWith(".github.com"))return "github";
  if(host==="bitbucket.org"||host.endsWith(".bitbucket.org"))return "bitbucket";
  if(host==="dev.azure.com"||host==="ssh.dev.azure.com"||host.endsWith(".visualstudio.com"))return "azure-devops";
  if(host==="gitlab.com"||host.includes("gitlab"))return "gitlab";
  return "unknown";
}

function repositoryFromRemote(remote,provider){
  if(!remote)return ""; const parts=remote.path.split("/").filter(Boolean);
  if(provider==="azure-devops"){
    const gitIndex=parts.findIndex(x=>x.toLowerCase()==="_git");
    if(gitIndex>=1&&parts[gitIndex+1])return `${parts[gitIndex-1]}/${parts[gitIndex+1]}`;
    if(parts[0]?.toLowerCase()==="v3"&&parts.length>=4)return `${parts[2]}/${parts[3]}`;
  }
  return parts.join("/");
}

function normalizeProvider(value){const id=String(value||"").trim().toLowerCase();return PROVIDERS.includes(id)?id:null}

async function sourceContext(cwd,preferred=null){
  const info=await serviceGitInfo(cwd);
  if(!info.isGit)throw new Error("Workspace is not a Git repository");
  const origin=info.remotes.find(x=>x.name==="origin"&&x.kind==="fetch")||info.remotes.find(x=>x.kind==="fetch");
  const remoteUrl=origin?.url||""; const remote=parseRemoteUrl(remoteUrl);
  const detected=detectSourceControlProvider(remoteUrl);
  const provider=normalizeProvider(preferred)|| (detected!=="unknown"?detected:null);
  if(!provider)throw new Error("Could not identify this Git host. Choose GitHub, GitLab, Forgejo/Gitea, Bitbucket, or Azure DevOps.");
  return {info,provider,detected,remoteUrl,remote,remoteName:origin?.name||"origin",repository:repositoryFromRemote(remote,provider),capabilities:CAPABILITIES[provider]};
}
function identityRepositoryForContext(ctx){
  if(ctx.provider!=="azure-devops")return ctx.repository;
  const parts=String(ctx.remote?.path||"").split("/").filter(Boolean);
  if(parts[0]?.toLowerCase()==="v3"&&parts.length>=4)return [parts[1],parts[2],parts[3]].join("/");
  const gitIndex=parts.findIndex(part=>part.toLowerCase()==="_git");
  if(gitIndex>=2&&parts[gitIndex+1])return [...parts.slice(0,gitIndex),parts[gitIndex+1]].join("/");
  return ctx.repository;
}
function identityForContext(ctx,number){return {provider:ctx.provider,host:String(ctx.remote?.hostname||ctx.remote?.host||"").toLowerCase(),repository:identityRepositoryForContext(ctx),number:Number(number)}}
export async function sourceControlRepositoryIdentity(cwd,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);return {provider:ctx.provider,host:String(ctx.remote?.hostname||ctx.remote?.host||"").toLowerCase(),repository:identityRepositoryForContext(ctx),remoteUrl:ctx.remoteUrl};
}

function parseJson(raw,fallback=null){try{return JSON.parse(String(raw||"").trim()||"null")}catch{return fallback}}
function stateOf(value,merged=false){const v=String(value||"").toLowerCase();if(merged||v==="merged"||v==="completed")return "MERGED";if(["closed","declined","superseded","abandoned"].includes(v))return "CLOSED";return "OPEN"}
function actor(raw){if(!raw)return null;return {login:raw.login||raw.username||raw.nickname||raw.emailAddress||raw.uniqueName||raw.display_name||raw.displayName||raw.name||"unknown",name:raw.name||raw.display_name||raw.displayName||null}}
async function sourceControlViewer(ctx){
  try{
    if(ctx.provider==="github"){
      const result=await run("gh",["api","user","--jq",".login"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:64*1024});
      return result.ok?String(result.stdout||"").trim()||null:null;
    }
    if(ctx.provider==="gitlab")return actor(await gitlabRequest(ctx.info.root,"user"))?.login||null;
    if(ctx.provider==="forgejo")return actor(await (await openForgejo(ctx)).call("user"))?.login||null;
    if(ctx.provider==="bitbucket")return actor(await bitbucketRequest("user"))?.login||null;
    if(ctx.provider==="azure-devops"){
      const profile=await azureRest(ctx,{area:"profile",resource:"profiles",route:{id:"me"}});
      return profile?.emailAddress||profile?.displayName||profile?.id||null;
    }
  }catch{}
  return null;
}
function markEditableComments(item,viewer){
  const login=String(viewer||"").trim().toLowerCase();
  if(!Array.isArray(item?.comments))return item;
  item.viewerLogin=viewer||null;
  item.comments=item.comments.map(comment=>({...comment,canEdit:Boolean(login&&String(comment.author?.login||"").trim().toLowerCase()===login)}));
  return item;
}
function normalizeGitLab(item){return {provider:"gitlab",number:Number(item.iid??item.id),title:item.title||"",body:item.description||"",state:stateOf(item.state,item.merged_at!=null),isDraft:Boolean(item.draft??item.work_in_progress),url:item.web_url||item.webUrl||"",headRefName:item.source_branch||item.sourceBranch||"",baseRefName:item.target_branch||item.targetBranch||"",headSha:item.sha||item.diff_refs?.head_sha||null,author:actor(item.author),reviewDecision:null,statusCheckRollup:item.pipeline?[item.pipeline]:[],reviews:(item.approved_by||item.reviewers||[]).map(x=>({author:actor(x.user||x),state:"REVIEWED",body:""}))}}
function normalizeForgejo(item){return {provider:"forgejo",number:Number(item.number??item.id),title:item.title||"",body:item.body||"",state:stateOf(item.state,item.merged),isDraft:Boolean(item.draft),url:item.html_url||item.url||"",headRefName:item.head?.ref||"",baseRefName:item.base?.ref||"",headSha:item.head?.sha||null,author:actor(item.user),reviewDecision:null,statusCheckRollup:[],reviews:(item.requested_reviewers||[]).map(x=>({author:actor(x),state:"REQUESTED",body:""}))}}
function normalizeBitbucket(item){return {provider:"bitbucket",number:Number(item.id),title:item.title||"",body:item.description||"",state:stateOf(item.state),isDraft:Boolean(item.draft),url:item.links?.html?.href||"",headRefName:item.source?.branch?.name||"",baseRefName:item.destination?.branch?.name||"",headSha:item.source?.commit?.hash||null,author:actor(item.author),reviewDecision:null,statusCheckRollup:[],reviews:(item.reviewers||[]).map(x=>({author:actor(x),state:item.participants?.find(p=>p.user?.uuid===x.uuid)?.approved?"APPROVED":"REVIEWED",body:""}))}}
function normalizeAzure(item){return {provider:"azure-devops",number:Number(item.pullRequestId??item.id),title:item.title||"",body:item.description||"",state:stateOf(item.status),isDraft:Boolean(item.isDraft),url:item._links?.web?.href||item.repository?.webUrl||item.url||"",headRefName:String(item.sourceRefName||"").replace(/^refs\/heads\//,""),baseRefName:String(item.targetRefName||"").replace(/^refs\/heads\//,""),headSha:item.lastMergeSourceCommit?.commitId||item.lastMergeCommit?.commitId||null,author:actor(item.createdBy),reviewDecision:null,statusCheckRollup:[],reviews:(item.reviewers||[]).map(x=>({author:actor(x),state:Number(x.vote)>=10?"APPROVED":Number(x.vote)<=-5?"CHANGES_REQUESTED":"REVIEWED",body:""}))}}
export function parsePublishTarget(provider,value){
  const id=normalizeProvider(provider)||String(provider||"");const raw=withoutEdgeSlashes(String(value||"").trim());if(!raw)throw new Error("Repository name is required.");
  if(id==="bitbucket"||id==="azure-devops"){
    const parts=raw.split("/").filter(Boolean);if(parts.length!==2)throw new Error(id==="bitbucket"?"Bitbucket repository path must be workspace/repository.":"Azure DevOps repository path must be project/repository.");
    return id==="bitbucket"?{provider:id,workspace:parts[0],name:parts[1],path:raw}:{provider:id,project:parts[0],name:parts[1],path:raw};
  }
  if(id==="gitlab"){
    const parts=raw.split("/").filter(Boolean);return {provider:id,name:parts.at(-1),namespace:parts.length>1?parts.slice(0,-1).join("/"):null,path:raw};
  }
  if(id==="forgejo"){
    const parts=raw.split("/").filter(Boolean);if(parts.length>2)throw new Error("Forgejo/Gitea repository path must be repository or owner/repository.");
    return {provider:id,name:parts.at(-1),owner:parts.length===2?parts[0]:null,path:raw};
  }
  return {provider:id,name:raw,path:raw};
}

export async function repositoryHasCommits(cwd){const result=await run("git",["rev-parse","--verify","HEAD"],{cwd,allowFailure:true});return result.ok&&Boolean(result.stdout.trim())}

async function defaultBaseBranch(cwd){
  const result=await run("git",["symbolic-ref","--quiet","--short","refs/remotes/origin/HEAD"],{cwd,allowFailure:true});
  const value=result.ok?result.stdout.trim().replace(/^origin\//,""):"";
  if(value)return value;
  const info=await serviceGitInfo(cwd);return info.branches.includes("main")?"main":info.branches.includes("master")?"master":info.branch||"main";
}

// Forgejo and Gitea. Trebell calls the server's REST API under /api/v1 (each server documents it on its own Swagger page) in one
// of two ways: with the token fj (forgejo-cli) saved for the server, or through `tea api` with one of tea's logins. An operation
// chooses its way once (forgejoLink) and sends each of its requests that way (forgejoSend); openForgejo gives the two together.
// Only literals and functions at the top level: the Native runner bundles this module and never reaches a Forgejo or Gitea server,
// so esbuild leaves all of this out of its bundle.

// fj keeps its logins in keys.json in its data folder, the one the Rust `directories` crate names for ProjectDirs::from("", <org>,
// "forgejo-cli"). fj's org is "forgejo-cli" now; older releases used "Cyborus", and fj still reads that file when the newer one is
// missing, so Trebell reads the two in that order.
const FJ_ORGS=["forgejo-cli","Cyborus"];

// The data folder the `directories` crate gives ProjectDirs::from("", org, app): Windows' roaming AppData\<org>\<app>\data, macOS's
// ~/Library/Application Support/<org>.<app>, and elsewhere <XDG data home>/<app>, where the XDG rules ignore a data home that is not
// an absolute path and the org is not part of the folder.
function rustProjectDataFolder({platform,env,home,join},org,app){
  if(platform==="win32"){
    const roaming=env.APPDATA?env.APPDATA:join(home,"AppData","Roaming");
    return join(roaming,org,app,"data");
  }
  if(platform==="darwin")return join(home,"Library/Application Support",org+"."+app);
  const xdg=env.XDG_DATA_HOME;
  return join(typeof xdg==="string"&&xdg[0]==="/"?xdg:join(home,".local","share"),app);
}

// The files fj may keep its logins in, in the order fj reads them (just one where both orgs share a folder).
export function fjKeyStoreFiles({platform=process.platform,env=process.env,home=homedir(),join=pathJoin}={}){
  const folders=FJ_ORGS.map(org=>rustProjectDataFolder({platform,env,home,join},org,"forgejo-cli"));
  return [...new Set(folders)].map(folder=>join(folder,"keys.json"));
}

// keys.json is {hosts: {<server>: {type, token, ...}}, aliases: {<alias>: <server>}}, where a server is its URL without the scheme
// or a last slash ("codeberg.org", "forge.example:3000"). Anything without a hosts object is no store.
function fjKeyStore(value){
  const hosts=value&&typeof value==="object"?value.hosts:null;
  if(!hosts||typeof hosts!=="object")return null;
  const aliases=value.aliases;
  return {hosts,aliases:aliases&&typeof aliases==="object"?aliases:{}};
}

// The selected environment's fj logins (its executor reads them where fj runs), else this machine's: the first file that holds a
// store. No store reads as one without servers.
async function loadFjKeyStore(){
  const executor=currentExecutor();
  if(executor?.readFjKeys)return fjKeyStore(await executor.readFjKeys())||fjKeyStore({hosts:{}});
  for(const file of fjKeyStoreFiles()){
    const text=await serviceReadFile(file,"utf8").catch(()=>null);
    const store=text===null?null:fjKeyStore(parseJson(text,null));
    if(store)return store;
  }
  return fjKeyStore({hosts:{}});
}

// A host without its port ("forge.example:3000" gives "forge.example"), in lower case.
function withoutPort(host){
  const text=String(host||"").toLowerCase(),colon=text.indexOf(":");
  return colon<0?text:text.slice(0,colon);
}

// The non-empty parts of a slash-separated path.
function pathParts(text){return String(text||"").split("/").filter(Boolean)}

// The fj account for a repository's remote ({remote, remoteUrl}, as sourceContext gives them): the store's server that is the
// remote's host and port, else the server an alias of that host names, else the only server on the remote's host name (an SSH
// remote of a server whose web address has a port). No server, or one without a token, is no account. The account's web address
// keeps http only when the remote itself is an http:// URL.
export function fjAccountFor(store,{remote,remoteUrl}={}){
  const servers=Object.keys(store?.hosts||{});
  const host=String(remote?.host||"").toLowerCase();
  const hostName=remote?.hostname?String(remote.hostname).toLowerCase():withoutPort(host);
  const direct=servers.find(server=>server.toLowerCase()===host);
  const aliasKey=Object.keys(store?.aliases||{}).find(name=>name.toLowerCase()===host);
  const aliased=aliasKey===undefined?"":String(store.aliases[aliasKey]||"");
  const sameName=servers.filter(server=>withoutPort(server)===hostName);
  const server=direct||(servers.includes(aliased)?aliased:"")||(sameName.length===1?sameName[0]:"");
  const token=server?String(store.hosts[server]?.token||"").trim():"";
  if(!token)return null;
  const scheme=String(remoteUrl||"").slice(0,7).toLowerCase()==="http://"?"http":"https";
  return {server,token,url:scheme+"://"+server};
}

// tea's logins: `tea login list --output json` gives one object per login with string values: name, url, ssh_host (the login's
// SSH host, else its URL's host), user and default ("true" or "false"). A tea that cannot list them gives ok false.
async function teaLoginList(cwd,options={}){
  const listed=await run("tea",["login","list","--output","json"],{...options,cwd,allowFailure:true});
  const parsed=listed.ok?parseJson(listed.stdout,null):null;
  return {ok:listed.ok,logins:Array.isArray(parsed)?parsed:[]};
}
function isDefaultTeaLogin(login){return login?.default===true||String(login?.default).toLowerCase()==="true"}

// The tea login for a remote: the first that serves the remote's host (by its URL's host or its SSH host), else the default
// login, else the first one.
export function teaLoginFor(logins,remote){
  const list=Array.isArray(logins)?logins:[],wanted=String(remote?.host||"").toLowerCase();
  const servesRemote=login=>[parseRemoteUrl(login?.url)?.host,String(login?.ssh_host||"").toLowerCase()].includes(wanted);
  return list.find(servesRemote)||list.find(isDefaultTeaLogin)||list[0]||null;
}

// The owner/repository to name to tea: the remote's path, less the login's own sub-path when the server is not at the root of its
// host, and only its last two parts when more are left. "" when the remote names no repository.
export function teaRepositoryFor(login,repository){
  const parts=pathParts(repository),mount=pathParts(parseRemoteUrl(login?.url)?.path);
  const underMount=mount.length>0&&parts.length>mount.length&&mount.every((part,index)=>parts[index]===part);
  return parts.slice(underMount?mount.length:0).slice(-2).join("/");
}

// `tea api --include` writes "<protocol> <status> <reason>" ("HTTP/1.1 404 Not Found"), the response headers and a blank line to
// standard error. The status is the number after the protocol on the first line that starts with one; 0 when there is none.
export function teaHttpStatus(stderr){
  const line=String(stderr||"").split(/\r?\n/).find(text=>text.startsWith("HTTP/"));
  const status=Number(line?.split(" ")[1]);
  return Number.isInteger(status)&&status>=100&&status<=599?status:0;
}

// How one operation reaches the server: with fj's token when fj runs here, has an account for the remote's server and the remote
// names owner/repository (or the operation needs no repository); else through tea's login for the remote.
async function forgejoLink(ctx){
  const cwd=ctx.info.root,parts=pathParts(ctx.repository),noRepositoryNeeded=Boolean(ctx.allowRepositoryless);
  const fjRuns=(await run("fj",["version"],{cwd,allowFailure:true,timeout:10000})).ok;
  const account=fjRuns?fjAccountFor(await loadFjKeyStore(),ctx):null;
  if(account&&(noRepositoryNeeded||parts.length===2))return {via:"fj",...account,slug:parts.join("/")};
  const tea=await teaLoginList(cwd);
  if(!tea.ok)throw new Error("To reach Forgejo or Gitea, sign in to this server with fj (fj auth login), or add a tea login (tea login add) with a tea that has the api command.");
  const login=teaLoginFor(tea.logins,ctx.remote);
  if(!login)throw new Error("tea has no login yet. Add one for this server with tea login add, or sign in with fj auth login.");
  const slug=teaRepositoryFor(login,ctx.repository);
  if(pathParts(slug).length===2||(slug===""&&noRepositoryNeeded))return {via:"tea",login,slug};
  throw new Error("The Git remote does not name a Forgejo or Gitea repository as owner/repository.");
}

// What a person reads when the server turns a request down: the status and the start of what the server said.
function forgejoAnswerError(status,text){
  if(status===0||(status>=300&&status<400))return new Error("The Forgejo/Gitea server answered with a redirect, which Trebell does not follow.");
  const said=String(text||"").trim().slice(0,800);
  return new Error("The Forgejo/Gitea server answered HTTP "+status+(said?": "+said:"."));
}

// With fj's token, straight to the server. The request must stay inside the account's own API: a URL that is not under its API
// root (another scheme, server or port, a sign-in in the URL, or a path out of /api/v1/) is refused before anything is sent. No
// redirect is followed, and no answer is awaited longer than 30 s.
async function fjSend(link,route,method,body){
  const apiRoot=new URL("api/v1/",link.url+"/").href,target=new URL(route,apiRoot).href;
  if(!target.startsWith(apiRoot))throw new Error("Trebell sends Forgejo/Gitea requests only under "+apiRoot+", so it did not send this one.");
  const payload=body===undefined?undefined:JSON.stringify(body);
  const headers={Accept:"application/json",Authorization:"token "+link.token,...(payload===undefined?{}:{"Content-Type":"application/json"})};
  const answer=await serviceRequest(target,{method,headers,body:payload,redirect:"manual",signal:AbortSignal.timeout(30000)});
  if(!answer.ok)throw forgejoAnswerError(answer.status,answer.text);
  return answer.text?parseJson(answer.text,answer.text):null;
}

// Through tea: `tea api` sends the request to its login's own server with that login's token, and puts /api/v1 before a path that
// does not start with /api/. The JSON body, when there is one, goes on standard input (--data @-).
async function teaSend(ctx,link,route,method,body){
  const flags=[["--method",method],["--login",link.login.name]];
  if(link.slug)flags.push(["--repo",link.slug]);
  if(body!==undefined)flags.push(["--data","@-"]);
  const result=await runStdin("tea",["api",...flags.flat(),"--include","/"+route],body===undefined?"":JSON.stringify(body),{cwd:ctx.info.root,allowFailure:true});
  if(!result.ok){
    const said=[result.stderr,result.stdout].map(text=>String(text||"").trim()).find(Boolean);
    throw new Error(said||"tea api failed.");
  }
  const status=teaHttpStatus(result.stderr);
  if(!status)throw new Error("tea api gave no HTTP status for this request.");
  if(status>=400)throw forgejoAnswerError(status,result.stdout);
  return parseJson(result.stdout,result.stdout);
}

// One API request over an operation's link. path is relative to /api/v1 ("repos/acme/widget/pulls"), and query, when given, adds
// its fields as URL parameters. Gives the answer's JSON, its text when it is not JSON, or null when it is empty.
function forgejoSend(ctx,link,path,{method="GET",body,query}={}){
  const route=path+(query?"?"+new URLSearchParams(query):"");
  return link.via==="fj"?fjSend(link,route,method,body):teaSend(ctx,link,route,method,body);
}

// An operation's link with its two kinds of request: call(path) for any API path, repo(path) for one under the repository.
async function openForgejo(ctx){
  const link=await forgejoLink(ctx);
  const call=(path,options)=>forgejoSend(ctx,link,path,options);
  return {link,call,repo:(path,options)=>call("repos/"+link.slug+"/"+path,options)};
}

// Where a new repository is published: the default tea login (or the only one) when it has a URL, else the only server fj has a
// token for. The answer stands in for a repository's context with no repository, so publishing reaches the server the way every
// other operation does.
async function forgejoPublishServer(cwd){
  const asPublishContext=(remote,remoteUrl)=>({info:{root:cwd},remote,remoteUrl,repository:"",allowRepositoryless:true});
  const {logins}=await teaLoginList(cwd,{maxBuffer:2*1024*1024});
  const login=logins.find(isDefaultTeaLogin)||(logins.length===1?logins[0]:null);
  const loginRemote=login?.url?parseRemoteUrl(login.url):null;
  if(loginRemote)return asPublishContext(loginRemote,String(login.url));
  const servers=Object.keys((await loadFjKeyStore()).hosts);
  if(servers.length===1)return asPublishContext({host:servers[0].toLowerCase(),hostname:withoutPort(servers[0])},"https://"+servers[0]+"/");
  throw new Error(servers.length>1
    ?"fj has tokens for several servers. Make one tea login the default (tea login default <name>) to say where to publish."
    :"Publishing to Forgejo or Gitea needs an fj login (fj auth login) or a default tea login (tea login add).");
}

// Publishing to Forgejo or Gitea: the repository is created for the signed-in person, or in the organization the path names when
// that is someone else, then added as origin and pushed when there are commits.
async function publishOnForgejo(info,target,{privacy,hasCommits,branch}){
  const forge=await openForgejo(await forgejoPublishServer(info.root));
  const viewer=await forge.call("user")||{};
  const owner=String(target.owner||"").trim();
  const forSomeoneElse=owner!==""&&owner.toLowerCase()!==String(viewer.login||viewer.username||"").toLowerCase();
  const created=await forge.call(forSomeoneElse?"orgs/"+encodeURIComponent(owner)+"/repos":"user/repos",{method:"POST",body:{name:target.name,private:privacy!=="public",auto_init:false}})||{};
  const cloneUrl=created.clone_url||created.ssh_url;
  if(!cloneUrl)throw new Error("Forgejo/Gitea created the repository but sent no clone URL for it.");
  const root=info.root;
  await run("git",["remote","add","origin",cloneUrl],{cwd:root});
  if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:root,timeout:180000});
  return {ok:true,provider:"forgejo",url:created.html_url||created.web_url||null,pushed:hasCommits,info:await serviceGitInfo(root)};
}

// How the pull request page lists Forgejo/Gitea's reviews, changed files and comments.
function forgejoReviewOf({id,user,state,body}){return {id,author:actor(user),state:state||"REVIEWED",body:body||""}}
function forgejoChangedFileOf({filename,new_path,previous_filename,status,patch,additions,deletions}){
  return {path:filename||new_path||"",oldPath:previous_filename||null,status:status||null,patch:patch||null,additions:Number(additions||0),deletions:Number(deletions||0)};
}
function forgejoCommentOf({id,body,user}){return {id,body:body||"",author:actor(user)}}

// A pull request with its reviews, changed files and comments, read side by side; one the server will not give is an empty list.
async function forgejoPullRequestPage(ctx,number){
  const forge=await openForgejo(ctx),pull="pulls/"+Number(number);
  const item=normalizeForgejo(await forge.repo(pull));
  const listed=(path,options)=>forge.repo(path,options).then(data=>Array.isArray(data)?data:[],()=>[]);
  const [reviews,files,comments]=await Promise.all([listed(pull+"/reviews"),listed(pull+"/files"),listed("issues/"+Number(number)+"/comments",{query:{limit:100}})]);
  return Object.assign(item,{reviews:reviews.map(forgejoReviewOf),files:files.map(forgejoChangedFileOf),comments:comments.map(forgejoCommentOf)});
}

// A review's verdict as Forgejo and Gitea name it.
function forgejoReviewEvent(verdict){return verdict==="APPROVE"?"APPROVED":verdict==="REQUEST_CHANGES"?"REQUEST_CHANGES":"COMMENT"}

// What a host's command line tool said when it failed: its own words (standard error, else standard output), else a sentence of
// Trebell's naming what it was asked to do.
function toolSaid(result,instead){return String(result?.stderr||"").trim()||String(result?.stdout||"").trim()||instead}

// Bitbucket Cloud, through its REST API 2.0. Trebell reads three variables of its own and no others. An access token (a repository,
// project or workspace token) goes as a Bearer token; failing that, an Atlassian account e-mail address with an API token goes as
// HTTP Basic, the address as the user name, as Atlassian documents for API tokens. An executor with a secret broker (Native's) is
// asked for the Bitbucket scope only, never for its whole environment; another executor is asked for the three names.
const BITBUCKET_REST="https://api.bitbucket.org/2.0/";
const BB_ACCESS_TOKEN="TREBELL_BITBUCKET_ACCESS_TOKEN",BB_EMAIL="TREBELL_BITBUCKET_EMAIL",BB_API_TOKEN="TREBELL_BITBUCKET_API_TOKEN";
async function bitbucketVariables(){
  const executor=currentExecutor();
  if(executor?.secretValues)return await executor.secretValues("source-control.bitbucket")||{};
  if(executor?.env)return await executor.env([BB_ACCESS_TOKEN,BB_EMAIL,BB_API_TOKEN])||{};
  return process.env;
}
// The Authorization header Bitbucket gets, "" while none of the variables is set.
async function bitbucketAuthorization(){
  const set=await bitbucketVariables();
  if(set[BB_ACCESS_TOKEN])return "Bearer "+set[BB_ACCESS_TOKEN];
  if(!set[BB_EMAIL]||!set[BB_API_TOKEN])return "";
  return "Basic "+Buffer.from(`${set[BB_EMAIL]}:${set[BB_API_TOKEN]}`,"utf8").toString("base64");
}
// One REST call: JSON both ways, 30 s at most. Without credentials it is not sent at all.
async function bitbucketRequest(path,{method="GET",json}={}){
  const authorization=await bitbucketAuthorization();
  if(!authorization)throw new Error(`Bitbucket has no credentials here. Set ${BB_ACCESS_TOKEN}, or ${BB_EMAIL} with ${BB_API_TOKEN}.`);
  const init={method,headers:{Accept:"application/json",Authorization:authorization},signal:AbortSignal.timeout(30_000)};
  if(json!==undefined){init.headers["Content-Type"]="application/json";init.body=JSON.stringify(json)}
  const answer=await serviceRequest(BITBUCKET_REST+String(path).replace(/^\/+/,""),init);
  if(!answer.ok)throw new Error(`Bitbucket answered ${answer.status}: ${String(answer.text??"").slice(0,800)}`);
  return parseJson(answer.text,{})??{};
}

// GitLab, through `glab api`, signed in as glab is. The endpoint is the word after "api" and the method is always named (-X). A
// JSON body is written to glab's standard input (--input -): current glab sends such a body as JSON by itself, and the header has
// older releases do the same (glab never overrides a header it is given).
async function gitlabRequest(root,endpoint,{method="GET",json}={}){
  const words=["api",endpoint,"-X",method];
  const result=json===undefined
    ?await run("glab",words,{cwd:root,allowFailure:true})
    :await runStdin("glab",[...words,"-H","Content-Type: application/json; charset=utf-8","--input","-"],JSON.stringify(json),{cwd:root,allowFailure:true});
  if(!result.ok)throw new Error(toolSaid(result,`glab could not ${method} ${endpoint}.`));
  const parsed=parseJson(result.stdout,undefined);
  return parsed===undefined?result.stdout:parsed;
}

// Azure DevOps, through the Azure CLI's azure-devops extension. Every call has az find the organisation and project from the Git
// remote, keep its warnings out of the answer and answer in JSON. A body travels in a temporary file (--in-file), and REST calls
// go to version 7.1 of the Azure DevOps API.
const AZ_EVERY_CALL=Object.freeze(["--detect","true","--only-show-errors","--output","json"]);
const AZURE_DEVOPS_API="7.1";
async function azureCall(root,words,{payload,instead}={}){
  if(payload!==undefined)return withServiceTempJson(payload,file=>azureCall(root,[...words,"--in-file",file,"--encoding","utf-8"],{instead}));
  const result=await run("az",[...words,...AZ_EVERY_CALL],{cwd:root,allowFailure:true,timeout:60_000,maxBuffer:8*1024*1024});
  if(!result.ok)throw new Error(toolSaid(result,instead||`az ${words.slice(0,3).join(" ")} failed.`));
  return parseJson(result.stdout,{})??{};
}
// The web page of a pull request az gave back: its own web link when there is one, else the repository's page and the pull request's
// number, else what az named.
function azurePullRequestPage(pull){
  const own=pull?._links?.web?.href;if(own)return own;
  const repositoryPage=pull?.repository?.webUrl,id=pull?.pullRequestId;
  if(repositoryPage&&id!=null)return `${String(repositoryPage).replace(/\/+$/,"")}/pullrequest/${id}`;
  return repositoryPage||pull?.url||"";
}
// A REST call through `az devops invoke`. Route parameters go as key=value words; one without a value is left out.
async function azureRest(ctx,{area="git",resource,route={},method="GET",payload}={}){
  if(!resource)throw new Error("An Azure DevOps REST call needs the resource it is for.");
  const words=["devops","invoke","--http-method",method,"--area",area,"--resource",resource,"--api-version",AZURE_DEVOPS_API];
  const given=Object.keys(route).filter(key=>route[key]!=null&&String(route[key])!=="");
  if(given.length)words.push("--route-parameters",...given.map(key=>`${key}=${route[key]}`));
  return azureCall(ctx.info.root,words,{payload,instead:`Azure DevOps refused ${method} ${area}/${resource}.`});
}
// A pull request as `az repos pr show` gives it, with the route of its threads: the project and repository az names for it,
// else those of the remote (project/repository).
async function azurePullRequest(ctx,number){
  const pull=await azureCall(ctx.info.root,["repos","pr","show","--id",String(number)],{instead:`Azure DevOps did not give pull request ${number}.`});
  const [remoteProject,...below]=String(ctx.repository||"").split("/").filter(Boolean);
  const repository=pull.repository||{},repositoryId=repository.id||below.at(-1)||remoteProject;
  if(!repositoryId)throw new Error(`Azure DevOps did not say which repository pull request ${number} is in.`);
  return {pull,route:{project:repository.project?.id||repository.project?.name||remoteProject||null,repositoryId,pullRequestId:Number(pull.pullRequestId??pull.id??number)}};
}

function azureThreadComments(raw){
  const threads=Array.isArray(raw)?raw:Array.isArray(raw?.value)?raw.value:[];
  const comments=[];
  for(const thread of threads){
    for(const comment of thread?.comments||[]){
      const type=String(comment?.commentType??"").toLowerCase();
      if(comment?.isDeleted||type==="system"||Number(comment?.commentType)===3)continue;
      if(type&&type!=="text"&&Number(comment?.commentType)!==1)continue;
      comments.push({id:String(thread.id)+":"+String(comment.id),threadId:Number(thread.id),nativeId:Number(comment.id),body:comment.content||"",author:actor(comment.author)});
    }
  }
  return comments;
}

const GITHUB_API_VERSION="2026-03-10";
async function githubApi(ctx,path,{method="GET",body,allowFailure=false}={}){
  const args=["api","--method",method,String(path),"--header","Accept: application/vnd.github+json","--header","X-GitHub-Api-Version: "+GITHUB_API_VERSION];
  const result=body===undefined
    ?await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:12*1024*1024})
    :await runStdin("gh",[...args,"--input","-","--header","Content-Type: application/json"],JSON.stringify(body),{cwd:ctx.info.root,allowFailure:true,maxBuffer:12*1024*1024});
  if(!result.ok&&!allowFailure)throw new Error((result.stderr||result.stdout||"GitHub API request failed").trim());
  return {ok:result.ok,data:parseJson(result.stdout,null),stdout:result.stdout,stderr:result.stderr,code:result.code};
}
function githubStackSummary(raw){
  if(!raw||typeof raw!=="object")return null;
  const number=Number(raw.number);const size=Number(raw.size);const position=Number(raw.position);
  if(!Number.isFinite(number)||number<=0)return null;
  return {number,size:Number.isFinite(size)?size:null,position:Number.isFinite(position)?position:null,baseRefName:raw.base?.ref||null,baseSha:raw.base?.sha||null};
}
function normalizeGitHubStackLayer(raw,index=0){
  return {
    position:index+1,number:Number(raw?.number),title:raw?.title||"",state:stateOf(raw?.state,Boolean(raw?.merged_at)),
    mergedAt:raw?.merged_at||null,isDraft:Boolean(raw?.draft),url:raw?.html_url||"",
    headRefName:raw?.head?.ref||"",headSha:raw?.head?.sha||null,baseRefName:raw?.base?.ref||"",baseSha:raw?.base?.sha||null,
  };
}
async function githubStackForPull(ctx,number,{pull=null}={}){
  const pr=pull||(await githubApi(ctx,"repos/"+ctx.repository+"/pulls/"+Number(number),{allowFailure:true})).data;
  const membership=githubStackSummary(pr?.stack);if(!membership)return null;
  const stackResult=await githubApi(ctx,"repos/"+ctx.repository+"/stacks/"+membership.number,{allowFailure:true});
  const stack=stackResult.ok?stackResult.data:null;
  const layers=(stack?.pull_requests||[]).map(normalizeGitHubStackLayer);
  return {
    ...membership,id:stack?.id||null,open:stack?.open!==false,baseRefName:stack?.base?.ref||membership.baseRefName,
    layers,selectedNumber:Number(number),
  };
}
async function githubPullRequestFiles(ctx,number){
  const files=[];
  for(let page=1;page<=50;page++){
    const result=await githubApi(ctx,"repos/"+ctx.repository+"/pulls/"+Number(number)+"/files?per_page=100&page="+page,{allowFailure:true});
    if(!result.ok||!Array.isArray(result.data))return null;
    for(const file of result.data){
      files.push({
        path:file?.filename||"",oldPath:file?.previous_filename||null,status:file?.status||null,
        patch:file?.patch||null,additions:Number(file?.additions||0),deletions:Number(file?.deletions||0),
        changes:Number(file?.changes||0),sha:file?.sha||null,blobUrl:file?.blob_url||null,rawUrl:file?.raw_url||null,
      });
    }
    if(result.data.length<100)break;
  }
  return files;
}

async function cliProbe(command,versionArgs,authArgs,cwd,installHint){
  const version=await run(command,versionArgs,{cwd,allowFailure:true,timeout:20000});
  if(!version.ok)return {installed:false,authenticated:false,version:null,detail:installHint};
  const auth=authArgs?await run(command,authArgs,{cwd,allowFailure:true,timeout:20000}):{ok:true,stdout:""};
  return {installed:true,authenticated:auth.ok,version:String(version.stdout||version.stderr||"").split(/\r?\n/)[0]||command,detail:String(auth.stdout||auth.stderr||"").trim()};
}

export async function sourceControlDiagnostics(cwd,preferred=null){
  const info=await serviceGitInfo(cwd); const origin=info.remotes?.find(x=>x.name==="origin"&&x.kind==="fetch")||info.remotes?.find(x=>x.kind==="fetch");
  const detected=detectSourceControlProvider(origin?.url||"");
  const [git,github,gitlab,tea,fj,azure]=await Promise.all([
    cliProbe("git",["--version"],null,cwd,"Install Git."),
    cliProbe("gh",["--version"],["auth","status"],cwd,"Install GitHub CLI (`gh`)."),
    cliProbe("glab",["--version"],["auth","status"],cwd,"Install GitLab CLI (`glab`)."),
    cliProbe("tea",["--version"],["login","status","--output","json"],cwd,"Install tea and run `tea login add`."),
    cliProbe("fj",["version"],["auth","list"],cwd,"Install Forgejo CLI (`fj`) or tea."),
    cliProbe("az",["--version"],["account","show","--query","user.name","--output","tsv"],cwd,"Install the Azure CLI with its azure-devops extension."),
  ]);
  const bitHeaders={Authorization:await bitbucketAuthorization()};
  const providers={
    github:{...github,label:"GitHub"},
    gitlab:{...gitlab,label:"GitLab"},
    forgejo:{...(fj.installed?fj:tea),authenticated:fj.authenticated||tea.authenticated,label:"Forgejo / Gitea"},
    bitbucket:{installed:true,authenticated:Boolean(bitHeaders.Authorization),version:"REST API",detail:bitHeaders.Authorization?"Credentials configured":"Set TREBELL_BITBUCKET_* credentials.",label:"Bitbucket"},
    "azure-devops":{...azure,label:"Azure DevOps"},
  };
  return {git,detectedProvider:detected,selectedProvider:normalizeProvider(preferred)||(detected!=="unknown"?detected:null),remoteUrl:origin?.url||null,providers,capabilities:CAPABILITIES,...providers};
}

export async function listPullRequests(cwd,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider); let items=[];
  if(ctx.provider==="github"){
    const r=await run("gh",["pr","list","--limit","50","--json","number,title,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),items:[]};
    items=(parseJson(r.stdout,[])||[]).map(x=>({...x,provider:"github"}));
    const rest=await githubApi(ctx,"repos/"+ctx.repository+"/pulls?state=open&per_page=50",{allowFailure:true});
    if(rest.ok&&Array.isArray(rest.data)){
      const stacks=new Map(rest.data.map(pr=>[Number(pr.number),githubStackSummary(pr.stack)]));
      items=items.map(item=>({...item,stack:stacks.get(Number(item.number))||null}));
    }
  }else if(ctx.provider==="gitlab"){
    const r=await run("glab",["mr","list","--per-page","50","--output","json"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),items:[]};items=(parseJson(r.stdout,[])||[]).map(normalizeGitLab);
  }else if(ctx.provider==="forgejo"){
    // Open pull requests, the most recently updated first, 50 to a page.
    const open=await (await openForgejo(ctx)).repo("pulls",{query:{state:"open",sort:"recentupdate",page:1,limit:50}});
    items=(Array.isArray(open)?open:[]).map(normalizeForgejo);
  }else if(ctx.provider==="bitbucket"){
    const data=await bitbucketRequest(`repositories/${ctx.repository}/pullrequests?state=OPEN&pagelen=50&sort=-updated_on`);items=(data.values||[]).map(normalizeBitbucket);
  }else if(ctx.provider==="azure-devops"){
    let open;
    try{open=await azureCall(ctx.info.root,["repos","pr","list","--status","active","--top","50"],{instead:"Azure DevOps did not list the open pull requests."})}
    catch(error){return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:error.message,items:[]}}
    items=(Array.isArray(open)?open:[]).map(normalizeAzure);
  }
  return {ok:true,provider:ctx.provider,capabilities:ctx.capabilities,items:items.map(item=>({...item,identity:identityForContext(ctx,item.number)}))};
}

export async function createPullRequest(cwd,{provider=null,title,body="",base=null,draft=false}={}){
  const ctx=await sourceContext(cwd,provider);const baseBranch=base||await defaultBaseBranch(ctx.info.root);
  if(ctx.provider==="github"){const args=["pr","create","--title",title,"--body",body];if(baseBranch)args.push("--base",baseBranch);if(draft)args.push("--draft");const r=await run("gh",args,{cwd:ctx.info.root});return {provider:ctx.provider,url:r.stdout.trim()}}
  if(ctx.provider==="gitlab"){const args=["mr","create","--title",title,"--description",body,"--target-branch",baseBranch,"--yes"];if(draft)args.push("--draft");const r=await run("glab",args,{cwd:ctx.info.root});return {provider:ctx.provider,url:(r.stdout.match(/https?:\/\/\S+/)||[])[0]||r.stdout.trim()}}
  const branch=ctx.info.branch;if(!branch)throw new Error("Check out a source branch before creating a change request.");
  if(ctx.provider==="forgejo"){const created=await (await openForgejo(ctx)).repo("pulls",{method:"POST",body:{base:baseBranch,head:branch,title,body}});return {provider:ctx.provider,url:created?.html_url||created?.url||""}}
  if(ctx.provider==="bitbucket"){const data=await bitbucketRequest(`repositories/${ctx.repository}/pullrequests`,{method:"POST",json:{title,description:body,source:{branch:{name:branch}},destination:{branch:{name:baseBranch}}}});return {provider:ctx.provider,url:data.links?.html?.href||""}}
  if(ctx.provider==="azure-devops"){
    const opened=await azureCall(ctx.info.root,["repos","pr","create","--title",title,"--description",body,"--source-branch",branch,"--target-branch",baseBranch],{instead:"Azure DevOps did not open the pull request."});
    return {provider:ctx.provider,url:azurePullRequestPage(opened)};
  }
}

// A field that is not given (null) is left as the host has it: changing only the title must not rewrite the description.
export async function editPullRequest(cwd,number,{provider=null,title=null,body=null}={}){
  const ctx=await sourceContext(cwd,provider);const nextTitle=title==null?null:String(title).trim(),nextBody=body==null?null:String(body);
  if(nextTitle==="")throw new Error("Pull request title is required");if(nextTitle==null&&nextBody==null)throw new Error("Give a new title or description");
  const fields=(titleKey,bodyKey)=>({...(nextTitle!=null?{[titleKey]:nextTitle}:{}),...(nextBody!=null?{[bodyKey]:nextBody}:{})});
  const flags=(titleFlag,bodyFlag)=>[...(nextTitle!=null?[titleFlag,nextTitle]:[]),...(nextBody!=null?[bodyFlag,nextBody]:[])];
  if(ctx.provider==="github"){
    const result=await run("gh",["pr","edit",String(number),...flags("--title","--body")],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not edit pull request").trim());return {ok:true,provider:ctx.provider};
  }
  if(ctx.provider==="gitlab"){await gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}`,{method:"PUT",json:fields("title","description")});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){await (await openForgejo(ctx)).repo("pulls/"+Number(number),{method:"PATCH",body:fields("title","body")});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}`,{method:"PUT",json:fields("title","description")});return {ok:true,provider:ctx.provider}}
  await azureCall(ctx.info.root,["repos","pr","update","--id",String(number),...flags("--title","--description")],{instead:"Azure DevOps did not change the pull request."});
  return {ok:true,provider:ctx.provider};
}

export async function editPullRequestComment(cwd,number,commentId,body,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);const text=String(body||"");const id=String(commentId||"").trim();if(!id)throw new Error("Comment id is required");
  if(ctx.provider==="github"){
    const path=`repos/${ctx.repository}/issues/comments/${id}`;const result=await runStdin("gh",["api","--method","PATCH",path,"--input","-","--header","Content-Type: application/json"],JSON.stringify({body:text}),{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not edit GitHub comment").trim());return {ok:true,provider:ctx.provider};
  }
  if(ctx.provider==="gitlab"){await gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes/${encodeURIComponent(id)}`,{method:"PUT",json:{body:text}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){await (await openForgejo(ctx)).repo("issues/comments/"+encodeURIComponent(id),{method:"PATCH",body:{body:text}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments/${encodeURIComponent(id)}`,{method:"PUT",json:{content:{raw:text}}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="azure-devops"){
    const {route}=await azurePullRequest(ctx,number);
    let [threadId,nativeId]=id.includes(":")?id.split(":",2):["",id];
    if(!threadId){
      const threads=await azureRest(ctx,{resource:"pullRequestThreads",route});
      const list=Array.isArray(threads)?threads:Array.isArray(threads?.value)?threads.value:[];
      const found=list.find(thread=>(thread.comments||[]).some(comment=>String(comment.id)===String(nativeId)));
      threadId=found?.id==null?"":String(found.id);
    }
    if(!threadId||!nativeId)throw new Error("Could not locate the Azure DevOps comment thread");
    await azureRest(ctx,{resource:"pullRequestThreadComments",route:{...route,threadId,commentId:nativeId},method:"PATCH",payload:{content:text}});
    return {ok:true,provider:ctx.provider};
  }
  throw new Error(`${ctx.provider} comment editing is not supported.`);
}

export async function checkoutPullRequest(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){
    const result=await run("gh",["pr","checkout",String(number)],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error(refusal(result,"Could not check out pull request"));
    return {ok:true,provider:ctx.provider,info:await serviceGitInfo(ctx.info.root),output:(result.stdout||result.stderr).trim()};
  }
  if(ctx.provider==="gitlab"){
    const result=await run("glab",["mr","checkout",String(number)],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error(refusal(result,"Could not check out merge request"));
    return {ok:true,provider:ctx.provider,info:await serviceGitInfo(ctx.info.root),output:(result.stdout||result.stderr).trim()};
  }
  throw new Error(`${ctx.provider} pull-request checkout is not safely supported by the configured client.`);
}

export async function requestPullRequestReviewer(cwd,number,reviewer,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);const login=String(reviewer||"").trim();if(!login)throw new Error("Reviewer is required");
  if(ctx.provider==="github"){
    const result=await run("gh",["pr","edit",String(number),"--add-reviewer",login],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not request reviewer").trim());
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="gitlab"){
    const users=await gitlabRequest(ctx.info.root,"users?username="+encodeURIComponent(login));
    const user=(Array.isArray(users)?users:[]).find(item=>String(item.username||"").toLowerCase()===login.toLowerCase())||(Array.isArray(users)?users[0]:null);
    if(!user?.id)throw new Error("GitLab user '"+login+"' was not found.");
    const path="projects/"+encodeURIComponent(ctx.repository)+"/merge_requests/"+Number(number);
    const mr=await gitlabRequest(ctx.info.root,path);
    const reviewerIds=[...new Set([...(mr?.reviewers||[]).map(item=>Number(item.id)).filter(Number.isFinite),Number(user.id)])];
    await gitlabRequest(ctx.info.root,path,{method:"PUT",json:{reviewer_ids:reviewerIds}});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="forgejo"){
    await (await openForgejo(ctx)).repo("pulls/"+Number(number)+"/requested_reviewers",{method:"POST",body:{reviewers:[login],team_reviewers:[]}});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="azure-devops"){
    await azureCall(ctx.info.root,["repos","pr","reviewer","add","--id",String(number),"--reviewers",login],{instead:`Azure DevOps did not add ${login} as a reviewer.`});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="bitbucket"){
    const user=await bitbucketRequest("users/"+encodeURIComponent(login));
    if(!user?.uuid)throw new Error("Bitbucket user '"+login+"' was not found.");
    const path="repositories/"+ctx.repository+"/pullrequests/"+Number(number);
    const pull=await bitbucketRequest(path);
    const reviewerUuids=[...new Set([...(pull?.reviewers||[]).map(item=>String(item.uuid||"")).filter(Boolean),String(user.uuid)])];
    await bitbucketRequest(path,{method:"PUT",json:{reviewers:reviewerUuids.map(uuid=>({uuid}))}});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  throw new Error(`${ctx.provider} reviewer requests are not exposed by Trebell yet.`);
}

export async function publishRepository(cwd,{provider="github",name=null,visibility="private"}={}){
  const info=await serviceGitInfo(cwd);if(!info.isGit)throw new Error("Initialize Git before publishing this project.");
  if(info.remotes?.some(remote=>remote.name==="origin"))throw new Error("This repository already has an origin remote.");
  const target=parsePublishTarget(provider,name||info.root.split(/[\\/]/).filter(Boolean).pop()||"");const repoName=target.name;
  const privacy=visibility==="public"?"public":"private";
  const hasCommits=await repositoryHasCommits(info.root);const branch=info.branch||"main";
  if(provider==="github"){
    const args=["repo","create",target.path,"--source",info.root,"--remote","origin","--"+privacy];if(hasCommits)args.push("--push");
    const result=await run("gh",args,{cwd:info.root,allowFailure:true,timeout:180000,maxBuffer:8*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not publish GitHub repository").trim());
    return {ok:true,provider,url:(result.stdout.match(/https?:\/\/\S+/)||[])[0]||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  if(provider==="gitlab"){
    // The project goes in the group or user namespace named (GitLab gives its id), else in the person's own.
    const namespace=target.namespace?await gitlabRequest(info.root,"namespaces/"+encodeURIComponent(target.namespace)):null;
    if(target.namespace&&!namespace?.id)throw new Error(`GitLab namespace ${target.namespace} was not found.`);
    const settings={name:repoName,path:repoName,visibility:privacy,...(namespace?{namespace_id:namespace.id}:{})};
    const project=await gitlabRequest(info.root,"projects",{method:"POST",json:settings})||{};const remote=project.http_url_to_repo||project.ssh_url_to_repo;if(!remote)throw new Error("GitLab created the project but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});
    if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.web_url||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  if(provider==="forgejo")return publishOnForgejo(info,target,{privacy,hasCommits,branch});
  if(provider==="bitbucket"){
    const project=await bitbucketRequest(`repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(repoName)}`,{method:"POST",json:{scm:"git",name:repoName,is_private:privacy!=="public"}});
    const clones=Array.isArray(project.links?.clone)?project.links.clone:[];const remote=clones.find(item=>item.name==="https")?.href||clones.find(item=>item.name==="ssh")?.href;
    if(!remote)throw new Error("Bitbucket created the repository but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.links?.html?.href||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  if(provider==="azure-devops"){
    const project=await azureCall(info.root,["repos","create","--name",repoName,"--project",target.project],{instead:"Azure DevOps did not create the repository."});
    const remote=project.remoteUrl||project.sshUrl;
    if(!remote)throw new Error("Azure DevOps created the repository but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.webUrl||project.url||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  throw new Error(`${provider} repository publishing is not exposed by Trebell yet.`);
}

export async function pullRequestDetail(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);let item;
  if(ctx.provider==="github"){
    const r=await run("gh",["pr","view",String(number),"--json","number,title,body,state,isDraft,url,headRefName,headRefOid,baseRefName,author,reviewDecision,statusCheckRollup,comments,reviews,files,commits,mergeCommit,mergedAt,autoMergeRequest,reviewRequests"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});
    if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),item:null};const raw=parseJson(r.stdout,{});item={...raw,provider:"github",headSha:raw.headRefOid||null,mergeCommitSha:raw.mergeCommit?.oid||null,files:(raw.files||[]).map(file=>({path:file.path||file.filename||"",additions:Number(file.additions||0),deletions:Number(file.deletions||0),status:file.status||null,patch:file.patch||null}))};
    item.awaitingWorkflowApproval=await githubAwaitingWorkflowRuns(ctx,item.headSha).catch(()=>[]);
    const [rest,apiFiles]=await Promise.all([
      githubApi(ctx,"repos/"+ctx.repository+"/pulls/"+Number(number),{allowFailure:true}),
      githubPullRequestFiles(ctx,number).catch(()=>null),
    ]);
    if(apiFiles)item.files=apiFiles;
    if(rest.ok&&rest.data){
      item.stack=await githubStackForPull(ctx,number,{pull:rest.data}).catch(()=>null);
      if(rest.data.merged_at&&!item.mergedAt)item.mergedAt=rest.data.merged_at;
    }else item.stack=null;
  }
  else if(ctx.provider==="gitlab"){
    const data=await gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}`);item=normalizeGitLab(data);
    const [notes,changes]=await Promise.all([gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes?per_page=100`).catch(()=>[]),gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/changes`).catch(()=>null)]);
    item.comments=(Array.isArray(notes)?notes:[]).map(n=>({id:n.id,body:n.body,author:actor(n.author)}));if(changes?.diff_refs?.head_sha)item.headSha=changes.diff_refs.head_sha;
    item.files=(changes?.changes||[]).map(file=>({path:file.new_path||file.old_path||"",oldPath:file.old_path||null,status:file.new_file?"added":file.deleted_file?"deleted":file.renamed_file?"renamed":"modified",patch:file.diff||null,additions:0,deletions:0}));
  }
  else if(ctx.provider==="forgejo")item=await forgejoPullRequestPage(ctx,number);
  else if(ctx.provider==="bitbucket"){
    const data=await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}`);item=normalizeBitbucket(data);
    const [comments,diffstat]=await Promise.all([bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments?pagelen=100`).catch(()=>({values:[]})),bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/diffstat?pagelen=100`).catch(()=>({values:[]}))]);
    item.comments=(comments.values||[]).map(x=>({id:x.id,body:x.content?.raw||"",author:actor(x.user)}));item.files=(diffstat.values||[]).map(file=>({path:file.new?.path||file.old?.path||"",oldPath:file.old?.path||null,status:file.status||null,additions:Number(file.lines_added||0),deletions:Number(file.lines_removed||0),patch:null}));
  }
  else {
    try{
      const {pull,route}=await azurePullRequest(ctx,number);item=normalizeAzure(pull);item.files=[];
      const threads=await azureRest(ctx,{resource:"pullRequestThreads",route});
      item.comments=azureThreadComments(threads);
    }catch(error){
      return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:error.message||String(error),item:null};
    }
  }
  if(item)item.identity=identityForContext(ctx,item.number||number);
  if(ctx.capabilities.editComments&&item?.comments?.length)markEditableComments(item,await sourceControlViewer(ctx));
  return {ok:true,provider:ctx.provider,capabilities:ctx.capabilities,item};
}

const GITHUB_VIEWED_QUERY=`query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } } } }`;
function githubRepoParts(ctx){const parts=String(ctx.repository||"").split("/").filter(Boolean);if(parts.length!==2)throw new Error("Could not resolve GitHub owner/repository from the Git remote.");return {owner:parts[0],name:parts[1]}}
async function githubAwaitingWorkflowRuns(ctx,headSha){
  if(!headSha)return[];
  const result=await run("gh",["api","--method","GET","repos/"+ctx.repository+"/actions/runs","-f","head_sha="+headSha,"-f","event=pull_request","-f","per_page=100"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});
  if(!result.ok)return[];
  const runs=parseJson(result.stdout,{})?.workflow_runs||[];
  return runs.filter(run=>run?.status==="action_required"||run?.conclusion==="action_required").map(run=>({id:Number(run.id),name:run.name||run.display_title||"Workflow",url:run.html_url||null,status:run.status||null,conclusion:run.conclusion||null}));
}
function githubViewedState(raw){const value=String(raw||"").trim().toUpperCase();return value==="VIEWED"?"viewed":value==="DISMISSED"?"dismissed":"unviewed"}
async function githubViewedPage(ctx,number,after=null){
  const repo=githubRepoParts(ctx);const args=["api","graphql","-f",`query=${GITHUB_VIEWED_QUERY}`,"-f",`owner=${repo.owner}`,"-f",`name=${repo.name}`,"-F",`number=${Number(number)}`];if(after)args.push("-f",`after=${after}`);
  const result=await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not read GitHub viewed files").trim());
  const pr=parseJson(result.stdout,{})?.data?.repository?.pullRequest;if(!pr)throw new Error("GitHub pull request was not found");const files=pr.files||{};
  return {pullRequestId:pr.id,files:(files.nodes||[]).filter(Boolean).map(file=>({path:file.path,state:githubViewedState(file.viewerViewedState)})),nextCursor:files.pageInfo?.hasNextPage?files.pageInfo?.endCursor:null};
}
export async function getPullRequestFilesViewed(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);if(ctx.provider!=="github")return {ok:true,provider:ctx.provider,store:"environment",files:[]};
  const files=[];let cursor=null,pullRequestId=null;do{const page=await githubViewedPage(ctx,number,cursor);pullRequestId=page.pullRequestId;files.push(...page.files);cursor=page.nextCursor}while(cursor&&files.length<5000);
  return {ok:true,provider:"github",store:"host",pullRequestId,files};
}
export async function setPullRequestFilesViewed(cwd,number,updates,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);if(ctx.provider!=="github")throw new Error("This host stores viewed-file marks in Trebell, not through the source-control API.");
  const files=(updates||[]).map(item=>({path:String(item?.path||"").trim(),viewed:item?.viewed!==false})).filter(item=>item.path).slice(0,200);if(!files.length)return getPullRequestFilesViewed(cwd,number,{provider:ctx.provider});
  const first=await githubViewedPage(ctx,number,null);const pullRequestId=first.pullRequestId;
  for(let offset=0;offset<files.length;offset+=40){const batch=files.slice(offset,offset+40);const params=batch.map((_,index)=>`$path${index}: String!`).join(", ");const fields=batch.map((file,index)=>`f${index}: ${file.viewed?"markFileAsViewed":"unmarkFileAsViewed"}(input: { pullRequestId: $pullRequestId, path: $path${index} }) { clientMutationId }`).join(" ");const query=`mutation($pullRequestId: ID!, ${params}) { ${fields} }`;const args=["api","graphql","-f",`query=${query}`,"-f",`pullRequestId=${pullRequestId}`];for(const [index,file] of batch.entries())args.push("-f",`path${index}=${file.path}`);const result=await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not update GitHub viewed files").trim())}
  return getPullRequestFilesViewed(cwd,number,{provider:ctx.provider});
}

export async function approvePullRequestWorkflows(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);if(ctx.provider!=="github")throw new Error("Waiting workflow approval is available only for GitHub pull requests.");
  const pr=await run("gh",["pr","view",String(number),"--json","headRefOid"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:2*1024*1024});
  if(!pr.ok)throw new Error((pr.stderr||pr.stdout||"Could not read pull request").trim());
  const headSha=parseJson(pr.stdout,{})?.headRefOid;const runs=await githubAwaitingWorkflowRuns(ctx,headSha);
  if(!runs.length)return {ok:true,provider:"github",approved:0,runs:[]};
  const approved=[];
  for(const runInfo of runs){
    const result=await run("gh",["api","--method","POST","repos/"+ctx.repository+"/actions/runs/"+runInfo.id+"/approve"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:2*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||("Could not approve workflow "+runInfo.name)).trim());
    approved.push(runInfo);
  }
  return {ok:true,provider:"github",approved:approved.length,runs:approved};
}

export async function revertPullRequest(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);if(ctx.provider!=="github")throw new Error("Revert pull requests are available only for GitHub.");
  const detail=await run("gh",["pr","view",String(number),"--json","number,title,state,mergedAt,mergeCommit,baseRefName"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:2*1024*1024});
  if(!detail.ok)throw new Error((detail.stderr||detail.stdout||"Could not read pull request").trim());
  const pr=parseJson(detail.stdout,{});
  const mergeSha=pr.mergeCommit?.oid||null;const base=String(pr.baseRefName||"").trim();
  if(!pr.mergedAt||!mergeSha)throw new Error("Only merged pull requests with a merge commit can be reverted.");
  if(!base)throw new Error("Could not determine the pull request base branch.");

  const stamp=Date.now().toString(36);const branch=`trebell/revert-pr-${Number(number)}-${stamp}`;const worktree=ctx.info.root+".trebell-revert-"+Number(number)+"-"+stamp;
  let worktreeAdded=false,pushed=false,createdUrl=null;
  try{
    const fetched=await run("git",["fetch","origin",base],{cwd:ctx.info.root,allowFailure:true,timeout:120000});
    if(!fetched.ok)throw new Error(refusal(fetched,"Could not fetch the base branch"));
    const added=await inWorktreeTurn(ctx.info.root,()=>run("git",["worktree","add","-b",branch,worktree,"origin/"+base],{cwd:ctx.info.root,allowFailure:true,timeout:120000}));
    if(!added.ok)throw new Error(refusal(added,"Could not create the revert worktree"));worktreeAdded=true;
    const parents=await run("git",["rev-list","--parents","-n","1",mergeSha],{cwd:worktree,allowFailure:true,maxBuffer:128*1024});
    if(!parents.ok)throw new Error(refusal(parents,"Could not inspect the merge commit"));
    const isMergeCommit=parents.stdout.trim().split(/\s+/).filter(Boolean).length>2;
    const revertArgs=["revert"];if(isMergeCommit)revertArgs.push("-m","1");revertArgs.push("--no-edit",mergeSha);
    const reverted=await run("git",revertArgs,{cwd:worktree,allowFailure:true,timeout:120000,maxBuffer:4*1024*1024});
    if(!reverted.ok)throw new Error(refusal(reverted,"Could not revert the merged change"));
    const pushedResult=await run("git",["push","-u","origin",branch],{cwd:worktree,allowFailure:true,timeout:180000,maxBuffer:4*1024*1024});
    if(!pushedResult.ok)throw new Error(refusal(pushedResult,"Could not push the revert branch"));pushed=true;
    const title=`Revert "${String(pr.title||("PR #"+number)).replace(/"/g,"'")}"`;
    const body=`Reverts #${Number(number)}.\n\nGenerated by Trebell Code.`;
    const created=await run("gh",["pr","create","--base",base,"--head",branch,"--title",title,"--body",body],{cwd:worktree,allowFailure:true,maxBuffer:4*1024*1024});
    if(!created.ok)throw new Error(refusal(created,"Could not open the revert pull request"));
    createdUrl=(created.stdout.match(/https?:\/\/\S+/)||[])[0]||created.stdout.trim()||null;
    return {ok:true,provider:"github",url:createdUrl,branch,revertedPullRequest:Number(number),mergeSha};
  }finally{
    if(worktreeAdded)await inWorktreeTurn(ctx.info.root,()=>removeWorktreeHere(ctx.info.root,worktree,{force:true})).catch(()=>{});
    await run("git",["branch","-D",branch],{cwd:ctx.info.root,allowFailure:true}).catch(()=>{});
    if(pushed&&!createdUrl)await run("git",["push","origin","--delete",branch],{cwd:ctx.info.root,allowFailure:true,timeout:120000}).catch(()=>{});
  }
}

export async function commentOnPullRequest(cwd,number,body,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const r=await run("gh",["pr","comment",String(number),"--body",body],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,url:r.stdout.trim()}}
  if(ctx.provider==="gitlab"){await gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes`,{method:"POST",json:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){await (await openForgejo(ctx)).repo("issues/"+Number(number)+"/comments",{method:"POST",body:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments`,{method:"POST",json:{content:{raw:body}}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="azure-devops"){
    // A new thread, active (status 1), whose one text comment (commentType 1) starts it (parentCommentId 0).
    const {route}=await azurePullRequest(ctx,number);
    const thread={comments:[{parentCommentId:0,content:String(body||""),commentType:1}],status:1};
    await azureRest(ctx,{resource:"pullRequestThreads",route,method:"POST",payload:thread});
    return {ok:true,provider:ctx.provider};
  }
  throw new Error(`${ctx.provider} pull-request comments are not supported.`);
}

export async function reviewPullRequest(cwd,number,{provider=null,event="COMMENT",body=""}={}){
  const ctx=await sourceContext(cwd,provider);const verdict=String(event||"COMMENT").toUpperCase();
  if(ctx.provider==="github"){const flag=verdict==="APPROVE"?"--approve":verdict==="REQUEST_CHANGES"?"--request-changes":"--comment";const args=["pr","review",String(number),flag];if(body)args.push("--body",body);await run("gh",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="gitlab"){if(body)await commentOnPullRequest(cwd,number,body,{provider:ctx.provider});if(verdict==="APPROVE")await gitlabRequest(ctx.info.root,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/approve`,{method:"POST"});else if(verdict==="REQUEST_CHANGES")throw new Error("GitLab does not have a changes-requested review verdict.");return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){
    // The review is pinned to the head commit the pull request has now.
    const forge=await openForgejo(ctx),pull="pulls/"+Number(number),head=(await forge.repo(pull))?.head?.sha;
    await forge.repo(pull+"/reviews",{method:"POST",body:{event:forgejoReviewEvent(verdict),body,commit_id:head,comments:[]}});
    return {ok:true,provider:ctx.provider};
  }
  if(ctx.provider==="bitbucket"){if(body)await commentOnPullRequest(cwd,number,body,{provider:ctx.provider});const suffix=verdict==="REQUEST_CHANGES"?"request-changes":verdict==="APPROVE"?"approve":null;if(suffix)await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/${suffix}`,{method:"POST"});return {ok:true,provider:ctx.provider}}
  const vote=verdict==="APPROVE"?"approve":verdict==="REQUEST_CHANGES"?"reject":"reset";
  await azureCall(ctx.info.root,["repos","pr","set-vote","--id",String(number),"--vote",vote],{instead:"Azure DevOps did not record the vote."});
  return {ok:true,provider:ctx.provider};
}

export async function mergePullRequest(cwd,number,{provider=null,method="squash",auto=false}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){
    const pr=await githubApi(ctx,"repos/"+ctx.repository+"/pulls/"+Number(number),{allowFailure:true});
    const stack=pr.ok?await githubStackForPull(ctx,number,{pull:pr.data}).catch(()=>null):null;
    if(stack){
      if(auto)throw new Error("GitHub does not support auto-merge for stacked pull requests. Merge or queue the stack instead.");
      const mergeMethod=method==="merge"?"merge":method==="rebase"?"rebase":"squash";
      const result=await githubApi(ctx,"repos/"+ctx.repository+"/pulls/"+Number(number)+"/merge-async",{method:"PUT",body:{sha:pr.data?.head?.sha||undefined,merge_method:mergeMethod,merge_action:"default"}});
      return {ok:true,provider:"github",stack:true,async:true,request:result.data||null,stackInfo:stack};
    }
    const flag=method==="merge"?"--merge":method==="rebase"?"--rebase":"--squash";const args=["pr","merge",String(number),flag];if(auto)args.push("--auto");else args.push("--delete-branch");const r=await run("gh",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}
  }
  if(ctx.provider==="gitlab"){const args=["mr","merge",String(number),"--auto-merge="+(auto?"true":"false"),"--yes"];if(method==="squash")args.push("--squash");if(method==="rebase")args.push("--rebase");const r=await run("glab",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="forgejo"){await (await openForgejo(ctx)).repo("pulls/"+Number(number)+"/merge",{method:"POST",body:{Do:method==="rebase"||method==="squash"?method:"merge"}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){const strategy=method==="rebase"?"rebase_fast_forward":method==="squash"?"squash":"merge_commit";await bitbucketRequest(`repositories/${ctx.repository}/pullrequests/${Number(number)}/merge`,{method:"POST",json:{merge_strategy:strategy}});return {ok:true,provider:ctx.provider}}
  // Completing takes the pull request in now; auto-complete leaves it to Azure DevOps once its policies pass. Either way the source
  // branch goes afterwards, and a squash is asked for by name.
  const finish=auto?["--auto-complete","true"]:["--status","completed"];
  const updated=await azureCall(ctx.info.root,["repos","pr","update","--id",String(number),...finish,"--delete-source-branch","true",...(method==="squash"?["--squash","true"]:[])],{instead:"Azure DevOps did not complete the pull request."});
  return {ok:true,provider:ctx.provider,output:String(updated?.status||"")};
}

// A GitHub stack is rebased from the bottom up in a worktree of its own beside the repository, so the person's checkout is not
// touched. Each open pull request's own commits (those after the base GitHub has for it) are replayed onto the new head of the
// layer below it, the lowest onto the stack's base branch as the remote has it now, and pushed with a lease on the head GitHub
// reported, so a branch someone pushed to meanwhile is not overwritten. The first layer that conflicts, or whose push is refused,
// ends the run: the layers below it stay rebased and pushed, and the error lists them (updated), as the answer does.

// git for a stack's rebase: a refusal comes back as an answer to read, with the bounds the step needs (a fetch, a rebase, a push or
// a worktree add may take minutes; a checkout or a lookup does not).
const STACK_LONG={timeout:180000,maxBuffer:6*1024*1024},STACK_SHORT={maxBuffer:1024*1024};
const stackGit=(cwd,args,bounds=STACK_SHORT)=>run("git",args,{cwd,allowFailure:true,...bounds});
const trimmed=value=>String(value??"").trim();

// The open layers, bottom to top, with what each one's rebase needs, all checked before anything is fetched or pushed.
function stackLayersToRebase(stack){
  const open=(stack.layers||[]).filter(layer=>layer.state==="OPEN");
  return open.map(layer=>{
    const plan={number:layer.number,branch:trimmed(layer.headRefName),oldHead:trimmed(layer.headSha),oldBase:trimmed(layer.baseSha)};
    const missing=[plan.branch?"":"its branch",plan.oldHead?"":"its head commit",plan.oldBase?"":"the commit it starts from"].filter(Boolean);
    if(missing.length)throw new Error(`GitHub did not give ${missing.join(" or ")} for #${layer.number}, so no layer of the stack was rebased.`);
    return plan;
  });
}
function stackHalt(layer,what,why,updated){
  const error=new Error(`#${layer.number} ${what}, so it and the layers above it were not changed: ${why}`);
  error.updated=updated;return error;
}
// The base branch and every layer's branch as the remote has them now, into its remote-tracking refs, in one fetch; then the
// base's tip, where the lowest layer goes.
async function fetchStackBase(root,remote,base,layers){
  const branches=[...new Set([base,...layers.map(layer=>layer.branch)])];
  const fetched=await stackGit(root,["fetch",remote,...branches.map(branch=>`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`)],STACK_LONG);
  if(!fetched.ok)throw new Error(refusal(fetched,"The stack's branches could not be fetched"));
  const tip=await stackGit(root,["rev-parse",`refs/remotes/${remote}/${base}`]);
  if(!tip.ok||!trimmed(tip.stdout))throw new Error(refusal(tip,`${base} could not be read after the fetch`));
  return trimmed(tip.stdout);
}
// One layer onto its new parent in the stack's worktree: its old head checked out, its own commits replayed with rebase --onto
// (a conflict aborts that rebase), its new head read, then pushed to its branch only while the branch is still at the head GitHub
// reported (the lease). The push is written in the order of git push's synopsis: options, the remote, then the refspec.
async function moveStackLayer(tree,remote,layer,parent,parentName,updated){
  const checkout=await stackGit(tree,["checkout","--detach",layer.oldHead]);
  if(!checkout.ok)throw stackHalt(layer,"did not check out in the stack's worktree",refusal(checkout,"git checkout failed"),updated);
  const replay=await stackGit(tree,["rebase","--onto",parent,layer.oldBase],STACK_LONG);
  if(!replay.ok){
    await stackGit(tree,["rebase","--abort"]).catch(()=>{});
    throw stackHalt(layer,"conflicts with "+parentName,refusal(replay,"rebase conflict"),updated);
  }
  const head=await stackGit(tree,["rev-parse","HEAD"]),newHead=trimmed(head.stdout);
  if(!head.ok||!newHead)throw stackHalt(layer,"was rebased but its new head could not be read",refusal(head,"git rev-parse failed"),updated);
  const lease=`--force-with-lease=refs/heads/${layer.branch}:${layer.oldHead}`;
  const pushed=await stackGit(tree,["push",lease,remote,`${newHead}:refs/heads/${layer.branch}`],STACK_LONG);
  if(!pushed.ok)throw stackHalt(layer,"could not be pushed",refusal(pushed,"push refused"),updated);
  return {number:layer.number,headRefName:layer.branch,oldHead:layer.oldHead,newHead};
}
export async function rebasePullRequestStack(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider!=="github")throw new Error("Only a GitHub stack can be rebased here.");
  const stack=await githubStackForPull(ctx,number);
  if(!stack)throw new Error(`#${Number(number)} is not in a GitHub stack, so there is no stack to rebase.`);
  const layers=stackLayersToRebase(stack),updated=[];
  if(!layers.length)return {ok:true,provider:"github",stack,updated};
  const base=trimmed(stack.baseRefName);
  if(!base)throw new Error("GitHub did not say which branch the stack is based on.");
  const root=ctx.info.root,remote=ctx.remoteName||"origin";
  const baseTip=await fetchStackBase(root,remote,base,layers);
  const tree=`${root}.trebell-stack-rebase-${stack.number}-${Date.now().toString(36)}`;
  const added=await inWorktreeTurn(root,()=>stackGit(root,["worktree","add","--detach",tree,baseTip],STACK_LONG));
  if(!added.ok)throw new Error(refusal(added,"The stack's worktree could not be added"));
  try{
    let parent=baseTip,parentName=base+" as it is now";
    for(const layer of layers){
      const moved=await moveStackLayer(tree,remote,layer,parent,parentName,updated);
      updated.push(moved);parent=moved.newHead;parentName="the rebased #"+layer.number;
    }
    return {ok:true,provider:"github",stack,updated};
  }finally{
    await stackGit(tree,["rebase","--abort"]).catch(()=>{});
    await inWorktreeTurn(root,()=>removeWorktreeHere(root,tree,{force:true})).catch(()=>{});
  }
}

export async function updatePullRequestBranch(cwd,number,{provider=null,rebase=true}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const args=["pr","update-branch",String(number)];if(rebase)args.push("--rebase");const r=await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});if(!r.ok)throw new Error((r.stderr||r.stdout||"Could not update PR branch").trim());return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="gitlab"){const r=await run("glab",["mr","rebase",String(number)],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="forgejo"){await (await openForgejo(ctx)).repo("pulls/"+Number(number)+"/update",{method:"POST",query:{style:rebase?"rebase":"merge"}});return {ok:true,provider:ctx.provider}}
  throw new Error(`${ctx.provider} does not expose a safe update-branch action here.`);
}

export { CAPABILITIES, PROVIDERS };
