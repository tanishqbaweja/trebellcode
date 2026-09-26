import { createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import extractZip from "extract-zip";
import { trebellHome } from "./paths.mjs";

export const ACP_REGISTRY_URL="https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ANTIGRAVITY_AUTH_METHODS=new Set(["oauth-personal","oauth-business","gemini-api-key","agent-platform"]);

export function antigravityConfigHome(env=process.env){
  return String(env.GEMINI_HOME||join(env.USERPROFILE||env.HOME||homedir(),".gemini"));
}

export async function readAntigravityAuthState({env=process.env}={}){
  const root=join(antigravityConfigHome(env),"antigravity-acp"),settingsPath=join(root,"settings.json"),tokenPath=join(root,"acp_token.json");
  let settings=null;try{settings=JSON.parse(await readFile(settingsPath,"utf8"))}catch{}
  const methodId=String(settings?.auth?.type||"").trim()||null;
  let tokenPresent=false;try{await access(tokenPath);tokenPresent=true}catch{}
  return {configured:Boolean(methodId),methodId,tokenPresent,settingsPath,tokenPath};
}

export async function configureAntigravityAuth(methodId,{env=process.env}={}){
  const id=String(methodId||"").trim();if(!ANTIGRAVITY_AUTH_METHODS.has(id))throw new Error("Unsupported Antigravity authentication method");
  const root=join(antigravityConfigHome(env),"antigravity-acp"),settingsPath=join(root,"settings.json");await mkdir(root,{recursive:true});
  let current={};try{const parsed=JSON.parse(await readFile(settingsPath,"utf8"));if(parsed&&typeof parsed==="object")current=parsed}catch{}
  const next={...current,auth:{...(current.auth&&typeof current.auth==="object"?current.auth:{}),type:id}},tmp=settingsPath+`.tmp-${randomUUID()}`;
  await writeFile(tmp,JSON.stringify(next,null,2),{encoding:"utf8",mode:0o600});await rename(tmp,settingsPath);return {methodId:id,settingsPath};
}

export function antigravityRegistryTarget(platform=process.platform,arch=process.arch){
  const platformName=platform==="win32"?"windows":platform==="darwin"?"darwin":platform==="linux"?"linux":null;
  const archName=arch==="x64"?"x86_64":arch==="arm64"?"aarch64":null;
  return platformName&&archName?`${platformName}-${archName}`:null;
}

function validateDistribution(entry,target){
  const distribution=entry?.distribution?.binary?.[target];
  if(!distribution?.archive||!distribution?.cmd)throw new Error(`The ACP registry does not publish Google Antigravity for ${target}`);
  const archive=new URL(distribution.archive);
  if(archive.protocol!=="https:"||archive.hostname!=="dl.google.com")throw new Error("Refusing an unexpected Antigravity download host from the ACP registry");
  const binaryName=basename(String(distribution.cmd).replace(/^\.\//,""));
  if(!/^agy_acp_server\.(?:exe|par)$/i.test(binaryName))throw new Error("The ACP registry returned an unexpected Antigravity executable name");
  return {archive:archive.href,binaryName,args:Array.isArray(distribution.args)?distribution.args.map(String):[]};
}

async function findFile(root,name){
  const direct=join(root,name);try{await access(direct);return direct}catch{}
  const { readdir }=await import("node:fs/promises");
  const queue=[root];
  while(queue.length){
    const current=queue.shift();
    for(const entry of await readdir(current,{withFileTypes:true})){
      const path=join(current,entry.name);
      if(entry.isDirectory())queue.push(path);
      else if(entry.name===name)return path;
    }
  }
  return null;
}

export async function installAntigravityRuntime({env=process.env,fetchImpl=globalThis.fetch,platform=process.platform,arch=process.arch,extractImpl=extractZip}={}){
  const target=antigravityRegistryTarget(platform,arch);if(!target)throw new Error(`Antigravity ACP is not supported on ${platform}/${arch}`);
  const registryResponse=await fetchImpl(ACP_REGISTRY_URL,{headers:{accept:"application/json"}});
  if(!registryResponse?.ok)throw new Error(`Could not read the ACP registry (${registryResponse?.status||"network error"})`);
  const registry=await registryResponse.json();
  const entry=(registry?.agents||[]).find(item=>item?.id==="antigravity-acp");
  if(!entry)throw new Error("Google Antigravity is missing from the ACP registry");
  const distribution=validateDistribution(entry,target);
  const root=join(trebellHome(env),"agent-runtimes","antigravity"),installId=randomUUID(),temp=join(root,`.install-${installId}`),archivePath=join(temp,"runtime.zip"),extracted=join(temp,"extracted"),ready=join(temp,"ready"),current=join(root,"current"),previous=join(root,`.previous-${installId}`);
  await mkdir(extracted,{recursive:true});await mkdir(ready,{recursive:true});
  try{
    const response=await fetchImpl(distribution.archive,{redirect:"follow"});
    if(!response?.ok||!response.body)throw new Error(`Could not download Google Antigravity ACP (${response?.status||"network error"})`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(archivePath,{mode:0o600}));
    await extractImpl(archivePath,{dir:extracted});
    const source=await findFile(extracted,distribution.binaryName);if(!source)throw new Error(`Downloaded Antigravity archive did not contain ${distribution.binaryName}`);
    // Keep the full sibling payload rather than only the launcher. Google's
    // Windows/Linux ACP distributions may ship helper binaries next to the
    // server and the launcher expects those relative paths to remain intact.
    await cp(dirname(source),ready,{recursive:true,force:true});
    const installedBinary=join(ready,distribution.binaryName);if(platform!=="win32")await chmod(installedBinary,0o755);
    await writeFile(join(ready,"install.json"),JSON.stringify({runtime:"antigravity",source:"acp-registry",registryUrl:ACP_REGISTRY_URL,version:String(entry.version||"unknown"),target,archive:distribution.archive,args:distribution.args,installedAt:new Date().toISOString()},null,2),{encoding:"utf8",mode:0o600});
    let movedPrevious=false;
    try{await rename(current,previous);movedPrevious=true}catch(error){if(error?.code!=="ENOENT")throw error}
    try{await rename(ready,current)}catch(error){if(movedPrevious)await rename(previous,current).catch(()=>{});throw error}
    if(movedPrevious)await rm(previous,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
    return {ok:true,version:String(entry.version||"unknown"),target,binary:join(current,distribution.binaryName),args:distribution.args};
  }finally{await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{})}
}

export async function readAntigravityInstall({env=process.env}={}){
  try{return JSON.parse(await readFile(join(trebellHome(env),"agent-runtimes","antigravity","current","install.json"),"utf8"))}catch{return null}
}
