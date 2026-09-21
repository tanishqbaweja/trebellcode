import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { gitInfo } from "./git-service.mjs";

const execFileAsync=promisify(execFile);
const PROVIDERS=["github","gitlab","forgejo","bitbucket","azure-devops"];

const CAPABILITIES={
  github:{create:true,comment:true,review:true,requestChanges:true,merge:true,updateBranch:true},
  gitlab:{create:true,comment:true,review:true,requestChanges:false,merge:true,updateBranch:true},
  forgejo:{create:true,comment:true,review:true,requestChanges:true,merge:true,updateBranch:true},
  bitbucket:{create:true,comment:true,review:true,requestChanges:true,merge:true,updateBranch:false},
  "azure-devops":{create:true,comment:false,review:true,requestChanges:true,merge:true,updateBranch:false},
};

async function run(command,args,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  try{
    const result=await execFileAsync(command,args,{cwd,windowsHide:true,timeout,maxBuffer});
    return {ok:true,stdout:result.stdout||"",stderr:result.stderr||""};
  }catch(error){
    if(!allowFailure) throw new Error((error.stderr||error.stdout||error.message||String(error)).trim());
    return {ok:false,stdout:error.stdout||"",stderr:error.stderr||error.message||"",code:error.code??1};
  }
}

async function runStdin(command,args,input,{cwd,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
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
  const info=await gitInfo(cwd);
  if(!info.isGit)throw new Error("Workspace is not a Git repository");
  const origin=info.remotes.find(x=>x.name==="origin"&&x.kind==="fetch")||info.remotes.find(x=>x.kind==="fetch");
  const remoteUrl=origin?.url||""; const remote=parseRemoteUrl(remoteUrl);
  const detected=detectSourceControlProvider(remoteUrl);
  const provider=normalizeProvider(preferred)|| (detected!=="unknown"?detected:null);
  if(!provider)throw new Error("Could not identify this Git host. Choose GitHub, GitLab, Forgejo/Gitea, Bitbucket, or Azure DevOps.");
  return {info,provider,detected,remoteUrl,remote,repository:repositoryFromRemote(remote,provider),capabilities:CAPABILITIES[provider]};
}

function parseJson(raw,fallback=null){try{return JSON.parse(String(raw||"").trim()||"null")}catch{return fallback}}
function stateOf(value,merged=false){const v=String(value||"").toLowerCase();if(merged||v==="merged"||v==="completed")return "MERGED";if(["closed","declined","superseded","abandoned"].includes(v))return "CLOSED";return "OPEN"}
function actor(raw){if(!raw)return null;return {login:raw.login||raw.username||raw.nickname||raw.display_name||raw.displayName||raw.name||raw.uniqueName||"unknown",name:raw.name||raw.display_name||raw.displayName||null}}
function normalizeGitLab(item){return {provider:"gitlab",number:Number(item.iid??item.id),title:item.title||"",body:item.description||"",state:stateOf(item.state,item.merged_at!=null),isDraft:Boolean(item.draft??item.work_in_progress),url:item.web_url||item.webUrl||"",headRefName:item.source_branch||item.sourceBranch||"",baseRefName:item.target_branch||item.targetBranch||"",author:actor(item.author),reviewDecision:null,statusCheckRollup:item.pipeline?[item.pipeline]:[],reviews:(item.approved_by||item.reviewers||[]).map(x=>({author:actor(x.user||x),state:"REVIEWED",body:""}))}}
function normalizeForgejo(item){return {provider:"forgejo",number:Number(item.number??item.id),title:item.title||"",body:item.body||"",state:stateOf(item.state,item.merged),isDraft:Boolean(item.draft),url:item.html_url||item.url||"",headRefName:item.head?.ref||"",baseRefName:item.base?.ref||"",author:actor(item.user),reviewDecision:null,statusCheckRollup:[],reviews:(item.requested_reviewers||[]).map(x=>({author:actor(x),state:"REQUESTED",body:""}))}}
function normalizeBitbucket(item){return {provider:"bitbucket",number:Number(item.id),title:item.title||"",body:item.description||"",state:stateOf(item.state),isDraft:Boolean(item.draft),url:item.links?.html?.href||"",headRefName:item.source?.branch?.name||"",baseRefName:item.destination?.branch?.name||"",author:actor(item.author),reviewDecision:null,statusCheckRollup:[],reviews:(item.reviewers||[]).map(x=>({author:actor(x),state:item.participants?.find(p=>p.user?.uuid===x.uuid)?.approved?"APPROVED":"REVIEWED",body:""}))}}
function normalizeAzure(item){return {provider:"azure-devops",number:Number(item.pullRequestId??item.id),title:item.title||"",body:item.description||"",state:stateOf(item.status),isDraft:Boolean(item.isDraft),url:item._links?.web?.href||item.repository?.webUrl||item.url||"",headRefName:String(item.sourceRefName||"").replace(/^refs\/heads\//,""),baseRefName:String(item.targetRefName||"").replace(/^refs\/heads\//,""),author:actor(item.createdBy),reviewDecision:null,statusCheckRollup:[],reviews:(item.reviewers||[]).map(x=>({author:actor(x),state:Number(x.vote)>=10?"APPROVED":Number(x.vote)<=-5?"CHANGES_REQUESTED":"REVIEWED",body:""}))}}

async function defaultBaseBranch(cwd){
  const result=await run("git",["symbolic-ref","--quiet","--short","refs/remotes/origin/HEAD"],{cwd,allowFailure:true});
  const value=result.ok?result.stdout.trim().replace(/^origin\//,""):"";
  if(value)return value;
  const info=await gitInfo(cwd);return info.branches.includes("main")?"main":info.branches.includes("master")?"master":info.branch||"main";
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
  for(const path of fjKeyPaths()){
    try{
      const parsed=JSON.parse(await readFile(path,"utf8"));
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
    const response=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"manual"});
    const text=await response.text();
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

function bitbucketAuthHeaders(){
  const access=process.env.TREBELL_BITBUCKET_ACCESS_TOKEN||process.env.T3CODE_BITBUCKET_ACCESS_TOKEN;
  if(access)return {Authorization:`Bearer ${access}`};
  const email=process.env.TREBELL_BITBUCKET_EMAIL||process.env.T3CODE_BITBUCKET_EMAIL;
  const token=process.env.TREBELL_BITBUCKET_API_TOKEN||process.env.T3CODE_BITBUCKET_API_TOKEN;
  if(email&&token)return {Authorization:`Basic ${Buffer.from(email+":"+token).toString("base64")}`};
  return {};
}
async function bitbucketApi(ctx,path,{method="GET",body}={}){
  const headers={Accept:"application/json",...bitbucketAuthHeaders()};
  if(!headers.Authorization)throw new Error("Bitbucket needs TREBELL_BITBUCKET_ACCESS_TOKEN, or TREBELL_BITBUCKET_EMAIL + TREBELL_BITBUCKET_API_TOKEN.");
  if(body!==undefined)headers["Content-Type"]="application/json";
  const response=await fetch(`https://api.bitbucket.org/2.0/${path.replace(/^\/+/,"")}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await response.text();if(!response.ok)throw new Error(`Bitbucket HTTP ${response.status}: ${text.slice(0,800)}`);return parseJson(text,{});
}

async function glabApi(ctx,path,{method="GET",body}={}){
  const args=["api",path];if(method!=="GET")args.push("--method",method);
  if(body!==undefined)args.push("--input","-","--header","Content-Type: application/json");
  const r=body===undefined?await run("glab",args,{cwd:ctx.info.root,allowFailure:true}):await runStdin("glab",args,JSON.stringify(body),{cwd:ctx.info.root,allowFailure:true});
  if(!r.ok)throw new Error((r.stderr||r.stdout||"GitLab API request failed").trim());return parseJson(r.stdout,r.stdout);
}

async function cliProbe(command,versionArgs,authArgs,cwd,installHint){
  const version=await run(command,versionArgs,{cwd,allowFailure:true,timeout:20000});
  if(!version.ok)return {installed:false,authenticated:false,version:null,detail:installHint};
  const auth=authArgs?await run(command,authArgs,{cwd,allowFailure:true,timeout:20000}):{ok:true,stdout:""};
  return {installed:true,authenticated:auth.ok,version:(version.stdout||version.stderr).split(/\r?\n/)[0]||command,detail:(auth.stdout||auth.stderr).trim()};
}

export async function sourceControlDiagnostics(cwd,preferred=null){
  const info=await gitInfo(cwd); const origin=info.remotes?.find(x=>x.name==="origin"&&x.kind==="fetch")||info.remotes?.find(x=>x.kind==="fetch");
  const detected=detectSourceControlProvider(origin?.url||"");
  const [git,github,gitlab,tea,fj,azure]=await Promise.all([
    cliProbe("git",["--version"],null,cwd,"Install Git."),
    cliProbe("gh",["--version"],["auth","status"],cwd,"Install GitHub CLI (`gh`)."),
    cliProbe("glab",["--version"],["auth","status"],cwd,"Install GitLab CLI (`glab`)."),
    cliProbe("tea",["--version"],["login","status","--output","json"],cwd,"Install tea and run `tea login add`."),
    cliProbe("fj",["version"],["auth","list"],cwd,"Install Forgejo CLI (`fj`) or tea."),
    cliProbe("az",["--version"],["account","show","--query","user.name","-o","tsv"],cwd,"Install Azure CLI + azure-devops extension."),
  ]);
  const bitHeaders=bitbucketAuthHeaders();
  const providers={
    github:{...github,label:"GitHub"},
    gitlab:{...gitlab,label:"GitLab"},
    forgejo:{...(fj.installed?fj:tea),authenticated:fj.authenticated||tea.authenticated,label:"Forgejo / Gitea"},
    bitbucket:{installed:true,authenticated:Boolean(bitHeaders.Authorization),version:"REST API",detail:bitHeaders.Authorization?"Credentials configured":"Set TREBELL_BITBUCKET_* credentials.",label:"Bitbucket"},
    "azure-devops":{...azure,label:"Azure DevOps"},
  };
  return {git,detectedProvider:detected,selectedProvider:normalizeProvider(preferred)||(detected!=="unknown"?detected:null),remoteUrl:origin?.url||null,providers,...providers};
}

export async function listPullRequests(cwd,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider); let items=[];
  if(ctx.provider==="github"){
    const r=await run("gh",["pr","list","--limit","50","--json","number,title,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});
    if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),items:[]};
    items=(parseJson(r.stdout,[])||[]).map(x=>({...x,provider:"github"}));
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
  return {ok:true,provider:ctx.provider,capabilities:ctx.capabilities,items};
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

export async function pullRequestDetail(cwd,number,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);let item;
  if(ctx.provider==="github"){const r=await run("gh",["pr","view",String(number),"--json","number,title,body,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,comments,reviews,files,commits"],{cwd:ctx.info.root,allowFailure:true,maxBuffer:8*1024*1024});if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),item:null};item={...parseJson(r.stdout,{}),provider:"github"}}
  else if(ctx.provider==="gitlab"){const data=await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}`);item=normalizeGitLab(data);const notes=await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes?per_page=100`).catch(()=>[]);item.comments=(Array.isArray(notes)?notes:[]).map(n=>({id:n.id,body:n.body,author:actor(n.author)}))}
  else if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);const r=await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}`);item=normalizeForgejo(r.data);const reviews=await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/reviews`).catch(()=>({data:[]}));item.reviews=(Array.isArray(reviews.data)?reviews.data:[]).map(x=>({id:x.id,author:actor(x.user),state:x.state||"REVIEWED",body:x.body||""}))}
  else if(ctx.provider==="bitbucket"){const data=await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}`);item=normalizeBitbucket(data);const comments=await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments?pagelen=100`).catch(()=>({values:[]}));item.comments=(comments.values||[]).map(x=>({id:x.id,body:x.content?.raw||"",author:actor(x.user)}))}
  else {const r=await run("az",["repos","pr","show","--detect","true","--id",String(number),"--only-show-errors","--output","json"],{cwd:ctx.info.root,allowFailure:true,timeout:60000});if(!r.ok)return {ok:false,provider:ctx.provider,capabilities:ctx.capabilities,error:(r.stderr||r.stdout).trim(),item:null};item=normalizeAzure(parseJson(r.stdout,{}))}
  return {ok:true,provider:ctx.provider,capabilities:ctx.capabilities,item};
}

export async function commentOnPullRequest(cwd,number,body,{provider=null}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const r=await run("gh",["pr","comment",String(number),"--body",body],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,url:r.stdout.trim()}}
  if(ctx.provider==="gitlab"){await glabApi(ctx,`projects/${encodeURIComponent(ctx.repository)}/merge_requests/${Number(number)}/notes`,{method:"POST",body:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/issues/${Number(number)}/comments`,{method:"POST",body:{body}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/comments`,{method:"POST",body:{content:{raw:body}}});return {ok:true,provider:ctx.provider}}
  throw new Error("Azure DevOps PR comments are not exposed by the installed CLI path yet.");
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
  if(ctx.provider==="github"){const flag=method==="merge"?"--merge":method==="rebase"?"--rebase":"--squash";const args=["pr","merge",String(number),flag];if(auto)args.push("--auto");else args.push("--delete-branch");const r=await run("gh",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="gitlab"){const args=["mr","merge",String(number),"--auto-merge="+(auto?"true":"false"),"--yes"];if(method==="squash")args.push("--squash");if(method==="rebase")args.push("--rebase");const r=await run("glab",args,{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/merge`,{method:"POST",body:{Do:method==="rebase"?"rebase":method==="squash"?"squash":"merge"}});return {ok:true,provider:ctx.provider}}
  if(ctx.provider==="bitbucket"){const strategy=method==="rebase"?"rebase_fast_forward":method==="squash"?"squash":"merge_commit";await bitbucketApi(ctx,`repositories/${ctx.repository}/pullrequests/${Number(number)}/merge`,{method:"POST",body:{merge_strategy:strategy}});return {ok:true,provider:ctx.provider}}
  const args=["repos","pr","update","--detect","true","--id",String(number),"--status","completed","--delete-source-branch","true","--only-show-errors"];if(method==="squash")args.push("--squash","true");const r=await run("az",args,{cwd:ctx.info.root,timeout:60000});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()};
}

export async function updatePullRequestBranch(cwd,number,{provider=null,rebase=true}={}){
  const ctx=await sourceContext(cwd,provider);
  if(ctx.provider==="github"){const args=["pr","update-branch",String(number)];if(rebase)args.push("--rebase");const r=await run("gh",args,{cwd:ctx.info.root,allowFailure:true,maxBuffer:4*1024*1024});if(!r.ok)throw new Error((r.stderr||r.stdout||"Could not update PR branch").trim());return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="gitlab"){const r=await run("glab",["mr","rebase",String(number)],{cwd:ctx.info.root});return {ok:true,provider:ctx.provider,output:(r.stdout||r.stderr).trim()}}
  if(ctx.provider==="forgejo"){const t=await forgejoContext(ctx);await forgejoApi(ctx,`repos/${t.repository}/pulls/${Number(number)}/update?style=${rebase?"rebase":"merge"}`,{method:"POST"});return {ok:true,provider:ctx.provider}}
  throw new Error(`${ctx.provider} does not expose a safe update-branch action here.`);
}

export { CAPABILITIES, PROVIDERS };
