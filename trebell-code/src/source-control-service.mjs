import { execFile, spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { gitInfo as localGitInfo } from "./git-service.mjs";

const execFileAsync=promisify(execFile);
const executionContext=new AsyncLocalStorage();
const PROVIDERS=["github","gitlab","forgejo","bitbucket","azure-devops"];

const CAPABILITIES={
  github:{create:true,edit:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,publish:true,viewedFiles:"host",approveWorkflows:true,revert:true,stacks:true},
  gitlab:{create:true,edit:true,comment:true,editComments:true,review:true,requestChanges:false,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  forgejo:{create:true,edit:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:false,updateBranch:true,checkout:false,reviewers:true,publish:false,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  bitbucket:{create:true,edit:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:false,updateBranch:false,checkout:false,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
  "azure-devops":{create:true,edit:true,comment:true,editComments:true,review:true,requestChanges:true,merge:true,autoMerge:true,updateBranch:false,checkout:false,reviewers:true,publish:true,viewedFiles:"environment",approveWorkflows:false,revert:false,stacks:false},
};

function currentExecutor(){return executionContext.getStore()?.executor||null}
export async function withSourceControlExecutor(executor,callback){
  if(!executor)return callback();
  return executionContext.run({executor},callback);
}

async function run(command,args,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  const executor=currentExecutor();
  if(executor?.run){
    const result=await executor.run(command,args,{cwd,timeout,maxBuffer});
    const normalized={ok:result?.ok!==false&&Number(result?.code??result?.exitCode??0)===0,stdout:result?.stdout||"",stderr:result?.stderr||"",code:Number(result?.code??result?.exitCode??0)};
    if(normalized.ok||allowFailure)return normalized;
    throw new Error((normalized.stderr||normalized.stdout||`${command} failed`).trim());
  }
  try{
    const result=await execFileAsync(command,args,{cwd,windowsHide:true,timeout,maxBuffer});
    return {ok:true,stdout:result.stdout||"",stderr:result.stderr||""};
  }catch(error){
    if(!allowFailure) throw new Error((error.stderr||error.stdout||error.message||String(error)).trim());
    return {ok:false,stdout:error.stdout||"",stderr:error.stderr||error.message||"",code:error.code??1};
  }
}

async function runStdin(command,args,input,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  const executor=currentExecutor();
  if(executor?.runStdin){
    const result=await executor.runStdin(command,args,input,{cwd,timeout,maxBuffer});
    const normalized={ok:result?.ok!==false&&Number(result?.code??result?.exitCode??0)===0,stdout:result?.stdout||"",stderr:result?.stderr||"",code:Number(result?.code??result?.exitCode??0)};
    if(normalized.ok||allowFailure)return normalized;
    throw new Error((normalized.stderr||normalized.stdout||`${command} failed`).trim());
  }
  return await new Promise((resolve,reject)=>{
    let stdout="",stderr="",settled=false;
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{}},timeout);
    const append=(current,chunk)=>{const next=current+String(chunk);return Buffer.byteLength(next,"utf8")>maxBuffer?Buffer.from(next).subarray(0,maxBuffer).toString("utf8"):next};
    child.stdout.on("data",chunk=>{stdout=append(stdout,chunk)});
    child.stderr.on("data",chunk=>{stderr=append(stderr,chunk)});
    child.once("error",error=>{if(settled)return;settled=true;clearTimeout(timer);if(allowFailure)resolve({ok:false,stdout,stderr:error.message,code:1});else reject(error)});
    child.once("close",code=>{if(settled)return;settled=true;clearTimeout(timer);const result={ok:code===0,stdout,stderr,code};if(code===0||allowFailure)resolve(result);else reject(new Error((stderr||stdout||`${command} failed`).trim()))});
    child.stdin.end(input??"");
  });
}

async function serviceGitInfo(cwd){
  if(!currentExecutor())return localGitInfo(cwd);
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
  if(!commits.ok||!summary.ok||!patch.ok){
    const error=[commits,summary,patch].find(result=>!result.ok);
    throw new Error((error?.stderr||error?.stdout||"Could not compute pull request branch changes").trim());
  }
  return {isGit:true,baseBranch,baseRef,commitSummary:commits.stdout||"",diffSummary:summary.stdout||"",diff:patch.stdout||""};
}

const PR_TEMPLATE_PATHS=[
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const PR_TEMPLATE_DIRECTORIES=[
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
];
function parseTemplateTreeEntries(raw){
  const entries=[];
  for(const record of String(raw||"").split("\0")){
    if(!record)continue;
    const tab=record.indexOf("\t");if(tab<0)continue;
    const [mode,type,objectId]=record.slice(0,tab).split(" ");
    if(type!=="blob"||!["100644","100755"].includes(mode)||!/^[0-9a-f]{40,64}$/i.test(objectId||""))continue;
    entries.push({objectId,path:record.slice(tab+1)});
  }
  return entries;
}
async function readTemplateBlob(root,entry){
  const result=await run("git",["cat-file","blob",entry.objectId],{cwd:root,allowFailure:true,maxBuffer:64*1024});
  if(!result.ok)return null;
  const text=String(result.stdout||"").trim();
  if(!text)return null;
  return text.length>8000?text.slice(0,8000)+"\n\n[truncated]":text;
}
export async function sourceControlPullRequestTemplate(cwd,{treeish="HEAD"}={}){
  const info=await serviceGitInfo(cwd);if(!info.isGit)return null;
  const origin=info.remotes.find(item=>item.name==="origin"&&item.kind==="fetch")||info.remotes.find(item=>item.kind==="fetch");
  if(detectSourceControlProvider(origin?.url||"")!=="github")return null;
  const treePaths=[...PR_TEMPLATE_PATHS,...PR_TEMPLATE_DIRECTORIES];
  const listed=await run("git",["ls-tree","-r","-z","--full-tree",String(treeish||"HEAD"),"--",...treePaths],{cwd:info.root,allowFailure:true,maxBuffer:128*1024});
  if(!listed.ok)return null;
  const entries=parseTemplateTreeEntries(listed.stdout);
  const byPath=new Map(entries.map(entry=>[entry.path,entry]));
  for(const path of PR_TEMPLATE_PATHS){
    const entry=byPath.get(path);if(!entry)continue;
    const template=await readTemplateBlob(info.root,entry);if(template)return template;
  }
  for(const directory of PR_TEMPLATE_DIRECTORIES){
    const prefix=directory+"/";
    const candidates=entries.filter(entry=>{
      if(!entry.path.startsWith(prefix))return false;
      const relative=entry.path.slice(prefix.length);
      return !relative.includes("/")&&relative.toLowerCase().endsWith(".md");
    });
    const templates=[];
    for(const entry of candidates){
      const template=await readTemplateBlob(info.root,entry);
      if(template)templates.push(template);
      if(templates.length>1)return null;
    }
    if(templates.length===1)return templates[0];
  }
  return null;
}

export async function sourceControlGitAction(cwd,{action,name=null,message=null,setUpstream=false,startPoint=null,path=null,force=false}={}){
  const base=String(cwd||"").trim();
  if(!base)throw new Error("Repository path is required");
  if(action==="init"){
    const result=await run("git",["init"],{cwd:base,allowFailure:true});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not initialize Git").trim());
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
    if(!add.ok)throw new Error((add.stderr||add.stdout||"Could not stage changes").trim());
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
    if(result&&!result.ok)throw new Error((result.stderr||result.stdout||"Git auto-pull failed").trim());
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
    result=await run("git",args,{cwd:root,allowFailure:true,timeout:120000});
  }else if(action==="worktree-remove"){
    const target=String(path||"").trim();if(!target)throw new Error("Worktree path is required");
    const args=["worktree","remove"];if(force)args.push("--force");args.push(target);
    result=await run("git",args,{cwd:root,allowFailure:true,timeout:120000});
  }else{
    throw new Error("Unsupported source-control Git action");
  }
  if(result&&!result.ok)throw new Error((result.stderr||result.stdout||("Git "+action+" failed")).trim());
  return {info:await serviceGitInfo(root),output:(result?.stdout||result?.stderr||"").trim()};
}

export function parseRemoteUrl(value=""){
  const raw=String(value||"").trim();
  if(!raw)return null;
  const scp=raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if(scp&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)){
    return {raw,host:scp[1].toLowerCase(),path:scp[2].replace(/^\/+|\/+$/g,"").replace(/\.git$/i,""),ssh:true};
  }
  try{const url=new URL(raw);return {raw,host:url.host.toLowerCase(),hostname:url.hostname.toLowerCase(),path:url.pathname.replace(/^\/+|\/+$/g,"").replace(/\.git$/i,""),ssh:url.protocol==="ssh:"}}catch{return null}
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
    if(ctx.provider==="gitlab")return actor(await glabApi(ctx,"user"))?.login||null;
    if(ctx.provider==="forgejo")return actor((await forgejoApi(ctx,"user")).data)?.login||null;
    if(ctx.provider==="bitbucket")return actor(await bitbucketApi(ctx,"user"))?.login||null;
    if(ctx.provider==="azure-devops"){
      const profile=await azureDevOpsInvoke(ctx,{area:"profile",resource:"profiles",route:{id:"me"}});
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
  const id=normalizeProvider(provider)||String(provider||"");const raw=String(value||"").trim().replace(/^\/+|\/+$/g,"");if(!raw)throw new Error("Repository name is required.");
  if(id==="bitbucket"||id==="azure-devops"){
    const parts=raw.split("/").filter(Boolean);if(parts.length!==2)throw new Error(id==="bitbucket"?"Bitbucket repository path must be workspace/repository.":"Azure DevOps repository path must be project/repository.");
    return id==="bitbucket"?{provider:id,workspace:parts[0],name:parts[1],path:raw}:{provider:id,project:parts[0],name:parts[1],path:raw};
  }
  if(id==="gitlab"){
    const parts=raw.split("/").filter(Boolean);return {provider:id,name:parts.at(-1),namespace:parts.length>1?parts.slice(0,-1).join("/"):null,path:raw};
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

function fjKeyPaths(){
  const home=homedir();
  if(process.platform==="win32"){
    const appData=process.env.APPDATA||pathJoin(home,"AppData","Roaming");
    return ["forgejo-cli","Cyborus"].map(org=>pathJoin(appData,org,"forgejo-cli","data","keys.json"));
  }
  if(process.platform==="darwin"){
    return ["forgejo-cli","Cyborus"].map(org=>pathJoin(home,"Library","Application Support",org+".forgejo-cli","keys.json"));
  }
  const dataHome=process.env.XDG_DATA_HOME&&process.env.XDG_DATA_HOME.startsWith("/")
    ? process.env.XDG_DATA_HOME
    : pathJoin(home,".local","share");
  return [pathJoin(dataHome,"forgejo-cli","keys.json")];
}

async function readFjKeys(){
  const executor=currentExecutor();
  if(executor?.readFjKeys){
    const parsed=await executor.readFjKeys();
    return parsed&&typeof parsed==="object"?parsed:{hosts:{},aliases:{}};
  }
  for(const path of fjKeyPaths()){
    try{
      const parsed=JSON.parse(await serviceReadFile(path,"utf8"));
      if(parsed&&typeof parsed==="object"&&parsed.hosts&&typeof parsed.hosts==="object")return parsed;
    }catch{}
  }
  return {hosts:{},aliases:{}};
}

function resolveFjAccount(ctx,keys){
  const remoteHost=String(ctx.remote?.host||"").toLowerCase();
  const remoteHostname=String(ctx.remote?.hostname||remoteHost.split(":")[0]||"").toLowerCase();
  const hosts=Object.entries(keys.hosts||{});
  const aliases=Object.entries(keys.aliases||{});
  let key=hosts.find(([host])=>host.toLowerCase()===remoteHost)?.[0]||null;
  if(!key){
    const aliasTarget=aliases.find(([alias])=>alias.toLowerCase()===remoteHost)?.[1];
    if(aliasTarget&&keys.hosts?.[aliasTarget])key=aliasTarget;
  }
  if(!key){
    const matches=hosts.filter(([host])=>host.toLowerCase().split(":")[0]===remoteHostname);
    if(matches.length===1)key=matches[0][0];
  }
  if(!key)return null;
  const token=String(keys.hosts?.[key]?.token||"").trim();
  if(!token)return null;
  const rawRemote=String(ctx.remoteUrl||"");
  const scheme=/^http:\/\//i.test(rawRemote)?"http":"https";
  return {host:key,token,baseUrl:`${scheme}://${key}`};
}

async function forgejoContext(ctx){
  const fj=await run("fj",["version"],{cwd:ctx.info.root,allowFailure:true,timeout:10000});
  if(fj.ok){
    const keys=await readFjKeys();
    const account=resolveFjAccount(ctx,keys);
    const parts=ctx.repository.split("/").filter(Boolean);
    if(account&&parts.length===2){
      return {command:"fj",token:account.token,repository:parts.join("/"),baseUrl:account.baseUrl};
    }
  }

  const listed=await run("tea",["login","list","--output","json"],{cwd:ctx.info.root,allowFailure:true});
  if(!listed.ok){
    throw new Error("Forgejo/Gitea support needs a matching `fj` login or tea 0.16+ with `tea login add`.");
  }
  const logins=parseJson(listed.stdout,[])||[]; const host=(ctx.remote?.host||"").toLowerCase();
  const login=logins.find(x=>{const r=parseRemoteUrl(x.url);return r&&(r.host===host||String(x.ssh_host||"").toLowerCase()===host)})||logins.find(x=>String(x.default)==="true")||logins[0];
  if(!login)throw new Error("No Forgejo/Gitea login matches this repository. Configure `fj` or run `tea login add`.");
  const loginRemote=parseRemoteUrl(login.url); let repository=ctx.repository;
  if(loginRemote?.path&&repository.startsWith(loginRemote.path+"/"))repository=repository.slice(loginRemote.path.length+1);
  if(repository.split("/").length>2)repository=repository.split("/").slice(-2).join("/");
  if(repository.split("/").length!==2)throw new Error("Could not resolve Forgejo/Gitea owner/repository from the Git remote.");
  return {command:"tea",login,repository,baseUrl:String(login.url).replace(/\/+$/,"")};
}

async function forgejoApi(ctx,path,{method="GET",body}={}){
  const target=await forgejoContext(ctx);
  if(target.command==="fj"){
    const base=new URL(target.baseUrl.replace(/\/+$/,"")+"/api/v1/");
    const url=new URL(String(path||"").replace(/^\/+/,""),base);
    if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw new Error("Invalid Forgejo API path.");
    const headers={Accept:"application/json",Authorization:`token ${target.token}`};
    if(body!==undefined)headers["Content-Type"]="application/json";
    const response=await serviceRequest(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"manual"});
    const text=response.text;
    if(!response.ok)throw new Error(`Forgejo HTTP ${response.status}: ${text.slice(0,800)}`);
    return {target,data:text?parseJson(text,text):null};
  }

  const args=["api","--include","--login",target.login.name,"--repo",target.repository,"--method",method];
  if(body!==undefined)args.push("--data","@-");
  args.push(`${target.baseUrl}/api/v1/${path}`);
  const result=await runStdin("tea",args,body===undefined?"":JSON.stringify(body),{cwd:ctx.info.root,allowFailure:true});
  const status=Number((result.stderr.match(/^HTTP\/\S+ (\d{3})/m)||[])[1]||0);
  if(!result.ok||!status||status>=400)throw new Error((result.stderr||result.stdout||`Forgejo HTTP ${status||"error"}`).trim());
  return {target,data:parseJson(result.stdout,result.stdout)};
}

async function bitbucketAuthHeaders(){
  const executor=currentExecutor();
  const values=executor?.env
    ?await executor.env(["TREBELL_BITBUCKET_ACCESS_TOKEN","T3CODE_BITBUCKET_ACCESS_TOKEN","TREBELL_BITBUCKET_EMAIL","T3CODE_BITBUCKET_EMAIL","TREBELL_BITBUCKET_API_TOKEN","T3CODE_BITBUCKET_API_TOKEN"])
    :process.env;
  const access=values.TREBELL_BITBUCKET_ACCESS_TOKEN||values.T3CODE_BITBUCKET_ACCESS_TOKEN;
  if(access)return {Authorization:`Bearer ${access}`};
  const email=values.TREBELL_BITBUCKET_EMAIL||values.T3CODE_BITBUCKET_EMAIL;
  const token=values.TREBELL_BITBUCKET_API_TOKEN||values.T3CODE_BITBUCKET_API_TOKEN;
  if(email&&token)return {Authorization:`Basic ${Buffer.from(email+":"+token).toString("base64")}`};
  return {};
}
async function bitbucketApi(ctx,path,{method="GET",body}={}){
  const headers={Accept:"application/json",...await bitbucketAuthHeaders()};
  if(!headers.Authorization)throw new Error("Bitbucket needs TREBELL_BITBUCKET_ACCESS_TOKEN, or TREBELL_BITBUCKET_EMAIL + TREBELL_BITBUCKET_API_TOKEN.");
  if(body!==undefined)headers["Content-Type"]="application/json";
  const response=await serviceRequest(`https://api.bitbucket.org/2.0/${path.replace(/^\/+/,"")}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=response.text;if(!response.ok)throw new Error(`Bitbucket HTTP ${response.status}: ${text.slice(0,800)}`);return parseJson(text,{});
}

async function glabApi(ctx,path,{method="GET",body}={}){
  const args=["api",path];if(method!=="GET")args.push("--method",method);
  if(body!==undefined)args.push("--input","-","--header","Content-Type: application/json");
  const r=body===undefined?await run("glab",args,{cwd:ctx.info.root,allowFailure:true}):await runStdin("glab",args,JSON.stringify(body),{cwd:ctx.info.root,allowFailure:true});
  if(!r.ok)throw new Error((r.stderr||r.stdout||"GitLab API request failed").trim());return parseJson(r.stdout,r.stdout);
}

async function azureCliRequest(ctx,args,body=undefined){
  const execute=async extra=>{
    const result=await run("az",[...args,...extra],{cwd:ctx.info.root,allowFailure:true,timeout:60000,maxBuffer:8*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Azure DevOps request failed").trim());
    return parseJson(result.stdout,{});
  };
  if(body===undefined)return execute([]);
  return withServiceTempJson(body,path=>execute(["--in-file",path,"--encoding","utf-8"]));
}

async function azureDevOpsInvoke(ctx,{area="git",resource,route={},method="GET",body,apiVersion="7.1"}={}){
  if(!resource)throw new Error("Azure DevOps resource is required");
  const args=["devops","invoke","--area",area,"--resource",resource,"--detect","true","--http-method",method,"--api-version",apiVersion,"--only-show-errors","--output","json"];
  const routes=Object.entries(route).filter(([,value])=>value!==undefined&&value!==null&&String(value)!=="").map(([key,value])=>key+"="+String(value));
  if(routes.length)args.push("--route-parameters",...routes);
  return azureCliRequest(ctx,args,body);
}

function azurePullRequestRoute(ctx,raw,number){
  const parts=String(ctx.repository||"").split("/").filter(Boolean);
  const repositoryId=raw?.repository?.id||parts.at(-1);
  if(!repositoryId)throw new Error("Could not determine the Azure DevOps repository ID");
  return {
    project:raw?.repository?.project?.id||raw?.repository?.project?.name||parts[0]||null,
    repositoryId,
    pullRequestId:Number(raw?.pullRequestId??raw?.id??number),
  };
}

async function azurePullRequestRaw(ctx,number){
  const result=await run("az",["repos","pr","show","--detect","true","--id",String(number),"--only-show-errors","--output","json"],{cwd:ctx.info.root,allowFailure:true,timeout:60000,maxBuffer:8*1024*1024});
  if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not read Azure DevOps pull request").trim());
  return parseJson(result.stdout,{});
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
  return {installed:true,authenticated:auth.ok,version:(version.stdout||version.stderr).split(/\r?\n/)[0]||command,detail:(auth.stdout||auth.stderr).trim()};
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
    cliProbe("az",["--version"],["account","show","--query","user.name","-o","tsv"],cwd,"Install Azure CLI + azure-devops extension."),
  ]);
  const bitHeaders=await bitbucketAuthHeaders();
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
    const t=await forgejoContext(ctx);const r=await forgejoApi(ctx,`repos/${t.repository}/pulls?state=open&sort=recentupdate&limit=50&page=1`);items=(Array.isArray(r.data)?r.data:[]).map(normalizeForgejo);
  }else if(ctx.provider==="bitbucket"){
    const data=await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests?state=OPEN&pagelen=50&sort=-updated_on`);items=(data.values||[]).map(normalizeBitbucket);
  }else if(ctx.provider==="azure-devops"){
    const r=await run("az",["repos","pr","list","--detect","true","--status","active","--top","50","--only-show-errors","--output","json"],{cwd:ctx.info.root,allowFailure:true,timeout:60000});
    if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),items:[]};items=(parseJson(r.stdout,[])||[]).map(normalizeAzure);
  }
  return {ok:true,provider:ctx.provider,capabilities:ctx.capabilities,items:items.map(item=>({...item,identity:identityForContext(ctx,item.number)}))};
}

export async function createPullRequest(cwd,{provider=null,title,body="",base=null,draft=false}={}){
  const ctx=await sourceContext(cwd,provider);const baseBranch=base||await defaultBaseBranch(ctx.info.root);
  if(ctx.provider==="github"){const args=["pr","create","--title",title,"--body",body];if(baseBranch)args.push("--base",baseBranch);if(draft)args.push("--draft");const r=await run("gh",args,{cwd:ctx.info.root});return {provider:ctx.provider,url:r.stdout.trim()}}
  if(ctx.provider==="gitlab"){const args=["mr","create","--title",title,"--description",body,"--target-branch",baseBranch,"--yes"];if(draft)args.push("--draft");const r=await run("glab",args,{cwd:ctx.info.root});return {provider:ctx.provider,url:(r.stdout.match(/https?:\/\/\S+/)||[])[0]||r.stdout.trim()}}
  const branch=ctx.info.branch;if(!branch)throw new Error("Check out a source branch before creating a change request.");
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);const r=await forgejoApi(ctx,`repos/${t.repository}/pulls`,{method:"POST",body:{base:baseBranch,head:branch,title,body}});return {provider:ctx.provider,url:r.data?.html_url||r.data?.url||""}}
  if(ctx.provider==="bitbucket"){const data=await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests`,{method:"POST",body:{title,description:body,source:{branch:{name:branch}},destination:{branch:{name:baseBranch}}}});return {provider:ctx.provider,url:data.links?.html?.href||""}}
  if(ctx.provider==="azure-devops"){const r=await run("az",["repos","pr","create","--only-show-errors","--detect","true","--target-branch",baseBranch,"--source-branch",branch,"--title",title,"--description",body,"--output","json"],{cwd:ctx.info.root,timeout:60000});const data=parseJson(r.stdout,{});return {provider:ctx.provider,url:data._links?.web?.href||data.repository?.webUrl||data.url||""}}
}

export async function editPullRequest(cwd,number,{provider=null,title,body=""}={}){
  const ctx=await sourceContext(cwd,provider);const nextTitle=String(title||"").trim();if(!nextTitle)throw new Error("Pull request title is required");
  if(ctx.provider==="github"){
    const result=await run("gh",["pr","edit",String(number),"--title",nextTitle,"--body",String(body||"")],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not edit pull request").trim());return {ok:true,provider:ctx.provider};
  }
  if(ctx.provider==="gitlab"){await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}`,{method:"PUT",body:{title:nextTitle,description:String(body||"")}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){const target=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${target.repository}/pulls/${Number(number)}`,{method:"PATCH",body:{title:nextTitle,body:String(body||"")}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}`,{method:"PUT",body:{title:nextTitle,description:String(body||"")}});return {ok:true,provider:ctx.provider}}
  const result=await run("az",["repos","pr","update","--detect","true","--id",String(number),"--title",nextTitle,"--description",String(body||""),"--only-show-errors","--output","json"],{cwd:ctx.info.root,allowFailure:true,timeout:60000});
  if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not edit Azure DevOps pull request").trim());return {ok:true,provider:ctx.provider};
}

export async function editPullRequestComment(cwd,number,commentId,body,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);const text=String(body||"");const id=String(commentId||"").trim();if(!id)throw new Error("Comment id is required");
  if(ctx.provider==="github"){
    const path=`repos/${ctx.repository}/issues/comments/${id}`;const result=await runStdin("gh",["api","--method","PATCH",path,"--input","-","--header","Content-Type: application/json"],JSON.stringify({body:text}),{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not edit GitHub comment").trim());return {ok:true,provider:ctx.provider};
  }
  if(ctx.provider==="gitlab"){await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes/${encodeURIComponent(id)}`,{method:"PUT",body:{body:text}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){const target=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${target.repository}/issues/comments/${encodeURIComponent(id)}`,{method:"PATCH",body:{body:text}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments/${encodeURIComponent(id)}`,{method:"PUT",body:{content:{raw:text}}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="azure-devops"){
    const raw=await azurePullRequestRaw(ctx,number);const route=azurePullRequestRoute(ctx,raw,number);
    let [threadId,nativeId]=id.includes(":")?id.split(":",2):["",id];
    if(!threadId){
      const threads=await azureDevOpsInvoke(ctx,{resource:"pullRequestThreads",route});
      const list=Array.isArray(threads)?threads:Array.isArray(threads?.value)?threads.value:[];
      const found=list.find(thread=>(thread.comments||[]).some(comment=>String(comment.id)===String(nativeId)));
      threadId=found?.id==null?"":String(found.id);
    }
    if(!threadId||!nativeId)throw new Error("Could not locate the Azure DevOps comment thread");
    await azureDevOpsInvoke(ctx,{resource:"pullRequestThreadComments",route:{...route,threadId,commentId:nativeId},method:"PATCH",body:{content:text}});
    return {ok:true,provider:ctx.provider};
  }
  throw new Error(`${ctx.provider} comment editing is not supported.`);
}

export async function checkoutPullRequest(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){
    const result=await run("gh",["pr","checkout",String(number)],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not check out pull request").trim());
    return {ok:true,provider:ctx.provider,info:await serviceGitInfo(ctx.info.root),output:(result.stdout||result.stderr).trim()};
  }
  if(ctx.provider==="gitlab"){
    const result=await run("glab",["mr","checkout",String(number)],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not check out merge request").trim());
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
    const users=await glabApi(ctx,"users?username="+encodeURIComponent(login));
    const user=(Array.isArray(users)?users:[]).find(item=>String(item.username||"").toLowerCase()===login.toLowerCase())||(Array.isArray(users)?users[0]:null);
    if(!user?.id)throw new Error("GitLab user '"+login+"' was not found.");
    const path="projects/"+encodeURIComponent(ctx.repository)+"/merge_requests/"+Number(number);
    const mr=await glabApi(ctx,path);
    const reviewerIds=[...new Set([...(mr?.reviewers||[]).map(item=>Number(item.id)).filter(Number.isFinite),Number(user.id)])];
    await glabApi(ctx,path,{method:"PUT",body:{reviewer_ids:reviewerIds}});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="forgejo"){
    const target=await forgejoContext(ctx);
    await forgejoApi(ctx,"repos/"+target.repository+"/pulls/"+Number(number)+"/requested_reviewers",{method:"POST",body:{reviewers:[login],team_reviewers:[]}});
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="azure-devops"){
    const result=await run("az",["repos","pr","reviewer","add","--id",String(number),"--reviewers",login,"--detect","true","--only-show-errors","--output","json"],{cwd:ctx.info.root,allowFailure:true,timeout:60000,maxBuffer:4*1024*1024});
    if(!result.ok)throw new Error((result.stderr||result.stdout||"Could not request Azure DevOps reviewer").trim());
    return {ok:true,provider:ctx.provider,reviewer:login};
  }
  if(ctx.provider==="bitbucket"){
    const user=await bitbucketApi(ctx,"users/"+encodeURIComponent(login));
    if(!user?.uuid)throw new Error("Bitbucket user '"+login+"' was not found.");
    const path="repositories/"+ctx.repository+"/pullrequests/"+Number(number);
    const pull=await bitbucketApi(ctx,path);
    const reviewerUuids=[...new Set([...(pull?.reviewers||[]).map(item=>String(item.uuid||"")).filter(Boolean),String(user.uuid)])];
    await bitbucketApi(ctx,path,{method:"PUT",body:{reviewers:reviewerUuids.map(uuid=>({uuid}))}});
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
    let namespaceId=null;
    if(target.namespace){const ns=await run("glab",["api",`namespaces/${encodeURIComponent(target.namespace)}`],{cwd:info.root,allowFailure:true,maxBuffer:2*1024*1024});if(!ns.ok)throw new Error((ns.stderr||ns.stdout||`Could not resolve GitLab namespace ${target.namespace}`).trim());namespaceId=parseJson(ns.stdout,{})?.id;if(!namespaceId)throw new Error(`GitLab namespace ${target.namespace} was not found.`)}
    const body={name:repoName,path:repoName,visibility:privacy,...(namespaceId?{namespace_id:namespaceId}:{})};
    const created=await runStdin("glab",["api","projects","--method","POST","--input","-","--header","Content-Type: application/json"],JSON.stringify(body),{cwd:info.root,allowFailure:true});
    if(!created.ok)throw new Error((created.stderr||created.stdout||"Could not create GitLab repository").trim());
    const project=parseJson(created.stdout,{});const remote=project.http_url_to_repo||project.ssh_url_to_repo;if(!remote)throw new Error("GitLab created the project but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});
    if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.web_url||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  if(provider==="bitbucket"){
    const project=await bitbucketApi(null,`repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(repoName)}`,{method:"POST",body:{scm:"git",name:repoName,is_private:privacy!=="public"}});
    const clones=Array.isArray(project.links?.clone)?project.links.clone:[];const remote=clones.find(item=>item.name==="https")?.href||clones.find(item=>item.name==="ssh")?.href;
    if(!remote)throw new Error("Bitbucket created the repository but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.links?.html?.href||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  if(provider==="azure-devops"){
    const created=await run("az",["repos","create","--detect","true","--project",target.project,"--name",repoName,"--only-show-errors","--output","json"],{cwd:info.root,allowFailure:true,timeout:60000,maxBuffer:8*1024*1024});
    if(!created.ok)throw new Error((created.stderr||created.stdout||"Could not create Azure DevOps repository").trim());const project=parseJson(created.stdout,{});const remote=project.remoteUrl||project.sshUrl;
    if(!remote)throw new Error("Azure DevOps created the repository but did not return a clone URL.");
    await run("git",["remote","add","origin",remote],{cwd:info.root});if(hasCommits)await run("git",["push","-u","origin",branch],{cwd:info.root,timeout:180000});
    return {ok:true,provider,url:project.webUrl||project.url||null,pushed:hasCommits,info:await serviceGitInfo(info.root)};
  }
  throw new Error(`${provider} repository publishing is not exposed by Trebell yet.`);
}

export async function pullRequestDetail(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);let item;
  if(ctx.provider==="github"){
    const r=await run("gh",["pr","view",String(number),"--json","number,title,body,state,isDraft,url,headRefName,headRefOid,baseRefName,author,reviewDecision,statusCheckRollup,comments,reviews,files,commits,mergeCommit,mergedAt"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});
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
    const data=await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}`);item=normalizeGitLab(data);
    const [notes,changes]=await Promise.all([glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes?per_page=100`).catch(()=>[]),glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/changes`).catch(()=>null)]);
    item.comments=(Array.isArray(notes)?notes:[]).map(n=>({id:n.id,body:n.body,author:actor(n.author)}));if(changes?.diff_refs?.head_sha)item.headSha=changes.diff_refs.head_sha;
    item.files=(changes?.changes||[]).map(file=>({path:file.new_path||file.old_path||"",oldPath:file.old_path||null,status:file.new_file?"added":file.deleted_file?"deleted":file.renamed_file?"renamed":"modified",patch:file.diff||null,additions:0,deletions:0}));
  }
  else if(ctx.provider==="forgejo"){
    const t=await forgejoContext(ctx);const r=await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}`);item=normalizeForgejo(r.data);
    const [reviews,files,comments]=await Promise.all([forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/reviews`).catch(()=>({data:[]})),forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/files`).catch(()=>({data:[]})),forgejoApi(ctx,`repos/${t.repository}/issues/${Number(number)}/comments?limit=100`).catch(()=>({data:[]}))]);
    item.reviews=(Array.isArray(reviews.data)?reviews.data:[]).map(x=>({id:x.id,author:actor(x.user),state:x.state||"REVIEWED",body:x.body||""}));item.files=(Array.isArray(files.data)?files.data:[]).map(file=>({path:file.filename||file.new_path||"",oldPath:file.previous_filename||null,status:file.status||null,patch:file.patch||null,additions:Number(file.additions||0),deletions:Number(file.deletions||0)}));item.comments=(Array.isArray(comments.data)?comments.data:[]).map(x=>({id:x.id,body:x.body||"",author:actor(x.user)}));
  }
  else if(ctx.provider==="bitbucket"){
    const data=await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}`);item=normalizeBitbucket(data);
    const [comments,diffstat]=await Promise.all([bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments?pagelen=100`).catch(()=>({values:[]})),bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/diffstat?pagelen=100`).catch(()=>({values:[]}))]);
    item.comments=(comments.values||[]).map(x=>({id:x.id,body:x.content?.raw||"",author:actor(x.user)}));item.files=(diffstat.values||[]).map(file=>({path:file.new?.path||file.old?.path||"",oldPath:file.old?.path||null,status:file.status||null,additions:Number(file.lines_added||0),deletions:Number(file.lines_removed||0),patch:null}));
  }
  else {
    try{
      const raw=await azurePullRequestRaw(ctx,number);item=normalizeAzure(raw);item.files=[];
      const threads=await azureDevOpsInvoke(ctx,{resource:"pullRequestThreads",route:azurePullRequestRoute(ctx,raw,number)});
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
    if(!fetched.ok)throw new Error((fetched.stderr||fetched.stdout||"Could not fetch the base branch").trim());
    const added=await run("git",["worktree","add","-b",branch,worktree,"origin/"+base],{cwd:ctx.info.root,allowFailure:true,timeout:120000});
    if(!added.ok)throw new Error((added.stderr||added.stdout||"Could not create the revert worktree").trim());worktreeAdded=true;
    const parents=await run("git",["rev-list","--parents","-n","1",mergeSha],{cwd:worktree,allowFailure:true,maxBuffer:128*1024});
    if(!parents.ok)throw new Error((parents.stderr||parents.stdout||"Could not inspect the merge commit").trim());
    const isMergeCommit=parents.stdout.trim().split(/\s+/).filter(Boolean).length>2;
    const revertArgs=["revert"];if(isMergeCommit)revertArgs.push("-m","1");revertArgs.push("--no-edit",mergeSha);
    const reverted=await run("git",revertArgs,{cwd:worktree,allowFailure:true,timeout:120000,maxBuffer:4*1024*1024});
    if(!reverted.ok)throw new Error((reverted.stderr||reverted.stdout||"Could not revert the merged change").trim());
    const pushedResult=await run("git",["push","-u","origin",branch],{cwd:worktree,allowFailure:true,timeout:180000,maxBuffer:4*1024*1024});
    if(!pushedResult.ok)throw new Error((pushedResult.stderr||pushedResult.stdout||"Could not push the revert branch").trim());pushed=true;
    const title=`Revert "${String(pr.title||("PR #"+number)).replace(/"/g,"'")}"`;
    const body=`Reverts #${Number(number)}.\n\nGenerated by Trebell Code.`;
    const created=await run("gh",["pr","create","--base",base,"--head",branch,"--title",title,"--body",body],{cwd:worktree,allowFailure:true,maxBuffer:4*1024*1024});
    if(!created.ok)throw new Error((created.stderr||created.stdout||"Could not open the revert pull request").trim());
    createdUrl=(created.stdout.match(/https?:\/\/\S+/)||[])[0]||created.stdout.trim()||null;
    return {ok:true,provider:"github",url:createdUrl,branch,revertedPullRequest:Number(number),mergeSha};
  }finally{
    if(worktreeAdded)await run("git",["worktree","remove","--force",worktree],{cwd:ctx.info.root,allowFailure:true,timeout:120000}).catch(()=>{});
    await run("git",["branch","-D",branch],{cwd:ctx.info.root,allowFailure:true}).catch(()=>{});
    if(pushed&&!createdUrl)await run("git",["push","origin","--delete",branch],{cwd:ctx.info.root,allowFailure:true,timeout:120000}).catch(()=>{});
  }
}

export async function commentOnPullRequest(cwd,number,body,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const r=await run("gh",["pr","comment",String(number),"--body",body],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,url:r.stdout.trim()}}
  if(ctx.provider==="gitlab"){await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes`,{method:"POST",body:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/issues/${Number(number)}/comments`,{method:"POST",body:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments`,{method:"POST",body:{content:{raw:body}}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="azure-devops"){
    const raw=await azurePullRequestRaw(ctx,number);
    await azureDevOpsInvoke(ctx,{
      resource:"pullRequestThreads",
      route:azurePullRequestRoute(ctx,raw,number),
      method:"POST",
      body:{comments:[{parentCommentId:0,content:String(body||""),commentType:1}],status:1},
    });
    return {ok:true,provider:ctx.provider};
  }
  throw new Error(`${ctx.provider} pull-request comments are not supported.`);
}

export async function reviewPullRequest(cwd,number,{provider=null,event="COMMENT",body=""}={}){
  const ctx=await sourceContext(cwd,provider);const verdict=String(event||"COMMENT").toUpperCase();
  if(ctx.provider==="github"){const flag=verdict==="APPROVE"?"--approve":verdict==="REQUEST_CHANGES"?"--request-changes":"--comment";const args=["pr","review",String(number),flag];if(body)args.push("--body",body);await run("gh",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="gitlab"){if(body)await commentOnPullRequest(cwd,number,body,{provider:ctx.provider});if(verdict==="APPROVE")await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/approve`,{method:"POST"});else if(verdict==="REQUEST_CHANGES")throw new Error("GitLab does not have a changes-requested review verdict.");return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);const pr=(await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}`)).data;await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/reviews`,{method:"POST",body:{event:verdict==="APPROVE"?"APPROVED":verdict==="REQUEST_CHANGES"?"REQUEST_CHANGES":"COMMENT",body,commit_id:pr.head?.sha,comments:[]}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){if(body)await commentOnPullRequest(cwd,number,body,{provider:ctx.provider});const suffix=verdict==="REQUEST_CHANGES"?"request-changes":verdict==="APPROVE"?"approve":null;if(suffix)await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/${suffix}`,{method:"POST"});return {ok:true,provider:ctx.provider}}
  const vote=verdict==="APPROVE"?"approve":verdict==="REQUEST_CHANGES"?"reject":"reset";await run("az",["repos","pr","set-vote","--detect","true","--id",String(number),"--vote",vote,"--only-show-errors"],{cwd:ctx.info.root,timeout:60000});return {ok:true,provider:ctx.provider};
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
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/merge`,{method:"POST",body:{Do:method==="rebase"?"rebase":method==="squash"?"squash":"merge"}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){const strategy=method==="rebase"?"rebase_fast_forward":method==="squash"?"squash":"merge_commit";await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/merge`,{method:"POST",body:{merge_strategy:strategy}});return {ok:true,provider:ctx.provider}}
  const args=["repos","pr","update","--detect","true","--id",String(number),"--delete-source-branch","true","--only-show-errors"];if(auto)args.push("--auto-complete","true");else args.push("--status","completed");if(method==="squash")args.push("--squash","true");const r=await run("az",args,{cwd:ctx.info.root,timeout:60000});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()};
}

export async function rebasePullRequestStack(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);if(ctx.provider!=="github")throw new Error("Native PR stack rebasing is available only for GitHub.");
  const stack=await githubStackForPull(ctx,number);if(!stack)throw new Error("This pull request is not part of a GitHub stack.");
  const layers=(stack.layers||[]).filter(layer=>layer.state==="OPEN");
  if(!layers.length)return {ok:true,provider:"github",stack,updated:[]};
  const base=String(stack.baseRefName||"").trim();if(!base)throw new Error("GitHub did not return the stack base branch.");
  const root=ctx.info.root;const remoteName=ctx.remoteName||"origin";const stamp=Date.now().toString(36);const worktree=root+".trebell-stack-rebase-"+stack.number+"-"+stamp;
  let worktreeAdded=false;const updated=[];
  try{
    const fetchRef=async ref=>{
      const result=await run("git",["fetch",remoteName,"+refs/heads/"+ref+":refs/remotes/"+remoteName+"/"+ref],{cwd:root,allowFailure:true,timeout:120000,maxBuffer:4*1024*1024});
      if(!result.ok)throw new Error((result.stderr||result.stdout||("Could not fetch "+ref)).trim());
    };
    await fetchRef(base);for(const layer of layers)await fetchRef(layer.headRefName);
    const baseShaResult=await run("git",["rev-parse","refs/remotes/"+remoteName+"/"+base],{cwd:root,allowFailure:true,maxBuffer:128*1024});
    if(!baseShaResult.ok)throw new Error((baseShaResult.stderr||"Could not resolve the latest stack base").trim());
    let newParentSha=baseShaResult.stdout.trim();
    const added=await run("git",["worktree","add","--detach",worktree,newParentSha],{cwd:root,allowFailure:true,timeout:120000,maxBuffer:4*1024*1024});
    if(!added.ok)throw new Error((added.stderr||added.stdout||"Could not create temporary stack worktree").trim());worktreeAdded=true;
    for(const layer of layers){
      const oldHead=String(layer.headSha||"").trim();if(!oldHead)throw new Error("GitHub did not return a head SHA for PR #"+layer.number);
      const oldBase=String(layer.baseSha||"").trim();if(!oldBase)throw new Error("GitHub did not return the original base SHA for PR #"+layer.number);
      const checkout=await run("git",["checkout","--detach",oldHead],{cwd:worktree,allowFailure:true,maxBuffer:2*1024*1024});
      if(!checkout.ok)throw new Error((checkout.stderr||checkout.stdout||("Could not prepare PR #"+layer.number)).trim());
      const rebased=await run("git",["rebase","--onto",newParentSha,oldBase],{cwd:worktree,allowFailure:true,timeout:180000,maxBuffer:6*1024*1024});
      if(!rebased.ok){
        await run("git",["rebase","--abort"],{cwd:worktree,allowFailure:true}).catch(()=>{});
        const error=new Error("Stack rebase stopped at PR #"+layer.number+": "+(rebased.stderr||rebased.stdout||"rebase conflict").trim());error.updated=updated;throw error;
      }
      const head=await run("git",["rev-parse","HEAD"],{cwd:worktree,allowFailure:true,maxBuffer:128*1024});
      if(!head.ok)throw new Error("Could not read the rebased head for PR #"+layer.number);
      const newHead=head.stdout.trim();
      const pushed=await run("git",["push",remoteName,"--force-with-lease=refs/heads/"+layer.headRefName+":"+oldHead,"HEAD:refs/heads/"+layer.headRefName],{cwd:worktree,allowFailure:true,timeout:180000,maxBuffer:6*1024*1024});
      if(!pushed.ok)throw new Error("Stack rebase stopped while pushing PR #"+layer.number+": "+(pushed.stderr||pushed.stdout||"push rejected").trim());
      updated.push({number:layer.number,headRefName:layer.headRefName,oldHead,newHead});newParentSha=newHead;
    }
    return {ok:true,provider:"github",stack,updated};
  }finally{
    if(worktreeAdded){await run("git",["rebase","--abort"],{cwd:worktree,allowFailure:true}).catch(()=>{});await run("git",["worktree","remove","--force",worktree],{cwd:root,allowFailure:true,timeout:120000}).catch(()=>{})}
  }
}

export async function updatePullRequestBranch(cwd,number,{provider=null,rebase=true}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const args=["pr","update-branch",String(number)];if(rebase)args.push("--rebase");const r=await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});if(!r.ok)throw new Error((r.stderr||r.stdout||"Could not update PR branch").trim());return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="gitlab"){const r=await run("glab",["mr","rebase",String(number)],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/update?style=${rebase?"rebase":"merge"}`,{method:"POST"});return {ok:true,provider:ctx.provider}}
  throw new Error(`${ctx.provider} does not expose a safe update-branch action here.`);
}

export { CAPABILITIES, PROVIDERS, resolveFjAccount };
