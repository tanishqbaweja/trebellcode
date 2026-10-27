import { createWriteStream, statfsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { AcpClient } from "./acp-client.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { antigravityEnvironment, antigravityIpv6Failure } from "./antigravity-auth.mjs";
import { trebellHome } from "./paths.mjs";

// extract-zip loads with the first install, not with the server (budget B25).
let extractZipModule=null;
const loadExtractZip=()=>extractZipModule??=import("extract-zip");

export const ACP_REGISTRY_URL="https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
// Antigravity's sign-in and the home it runs in are antigravity-auth.mjs's.

// What an install leaves free on its drive besides the download and the files it unpacks there (T3 FREE_SPACE_MARGIN).
export const ANTIGRAVITY_FREE_SPACE_MARGIN=256*1024*1024;
// How long the new runtime has to start and answer ACP's initialize, as long as a session's start has.
const START_CHECK_TIMEOUT_MS=90_000;
// What Windows says when a process holds a folder Trebell renames: a running Antigravity's own folder, or one just stopped.
const IN_USE_CODES=new Set(["EBUSY","EPERM","EACCES"]);

export function antigravityRegistryTarget(platform=process.platform,arch=process.arch){
  const platformName=platform==="win32"?"windows":platform==="darwin"?"darwin":platform==="linux"?"linux":null;
  const archName=arch==="x64"?"x86_64":arch==="arm64"?"aarch64":null;
  return platformName&&archName?`${platformName}-${archName}`:null;
}

// The registry's entry for this machine. Its download is checked against the SHA-256 the registry lists beside it, so an entry
// without one is refused, as is one with no version for the started runtime to be checked against.
function validateDistribution(entry,target){
  const distribution=entry?.distribution?.binary?.[target];
  if(!distribution?.archive||!distribution?.cmd)throw new Error(`The ACP registry does not publish Google Antigravity for ${target}`);
  const archive=new URL(distribution.archive);
  if(archive.protocol!=="https:"||archive.hostname!=="dl.google.com")throw new Error("Refusing an unexpected Antigravity download host from the ACP registry");
  const binaryName=basename(String(distribution.cmd).replace(/^\.\//,""));
  if(!/^agy_acp_server\.(?:exe|par)$/i.test(binaryName))throw new Error("The ACP registry returned an unexpected Antigravity executable name");
  const version=typeof entry.version==="string"?entry.version.trim():"";
  if(!version)throw new Error("The ACP registry lists no version for Google Antigravity, so Trebell Code cannot check the runtime it would download. Nothing was installed.");
  const sha256=typeof distribution.sha256==="string"?distribution.sha256.trim().toLowerCase():"";
  if(!/^[0-9a-f]{64}$/.test(sha256))throw new Error(`The ACP registry lists no SHA-256 for Google Antigravity ${version} on ${target}, so Trebell Code cannot check its download. Nothing was installed.`);
  // Antigravity's server starts its helper from its own folder: localharness_external, an .exe beside an .exe.
  const helperName=/\.exe$/i.test(binaryName)?"localharness_external.exe":"localharness_external";
  return {archive:archive.href,binaryName,helperName,version,sha256,args:Array.isArray(distribution.args)?distribution.args.map(String):[]};
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

// The bytes free to this process on the drive that holds path.
export function freeBytesAt(path){const {bavail,bsize}=statfsSync(path);return Number(bavail)*Number(bsize)}

// The bytes a zip unpacks to: the sizes its central directory lists, ZIP64's too, read from the end of the file (the registry lists
// no sizes, and Google's archives unpack to 1.8 to 3.5 times their own).
export async function zipUnpackedBytes(path){
  const file=await open(path,"r");
  try{
    const {size}=await file.stat(),tailSize=Math.min(size,22+65_535+20),tail=Buffer.alloc(tailSize);
    await file.read(tail,0,tailSize,size-tailSize);
    let end=-1;for(let at=tailSize-22;at>=0&&end<0;at--)if(tail.readUInt32LE(at)===0x06054b50)end=at;
    if(end<0)throw new Error("The download has no zip central directory");
    let count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count===0xffff||length===0xffffffff||offset===0xffffffff){
      // ZIP64: the locator just before the end record names the ZIP64 end record, which holds the whole count, size and offset.
      if(end<20||tail.readUInt32LE(end-20)!==0x07064b50)throw new Error("The download's ZIP64 locator is missing");
      const record=Buffer.alloc(56);await file.read(record,0,56,Number(tail.readBigUInt64LE(end-12)));
      if(record.readUInt32LE(0)!==0x06064b50)throw new Error("The download's ZIP64 end record is missing");
      count=Number(record.readBigUInt64LE(32));length=Number(record.readBigUInt64LE(40));offset=Number(record.readBigUInt64LE(48));
    }
    const directory=Buffer.alloc(length);await file.read(directory,0,length,offset);
    let total=0;
    for(let at=0,entry=0;entry<count;entry++){
      if(directory.readUInt32LE(at)!==0x02014b50)throw new Error("The download's zip central directory is damaged");
      let bytes=directory.readUInt32LE(at+24);const nameLength=directory.readUInt16LE(at+28),extraLength=directory.readUInt16LE(at+30),commentLength=directory.readUInt16LE(at+32);
      // A size too large for 32 bits is in the entry's ZIP64 extra field (id 1), uncompressed size first.
      if(bytes===0xffffffff)for(let extra=at+46+nameLength,stop=extra+extraLength;extra+4<=stop;extra+=4+directory.readUInt16LE(extra+2))if(directory.readUInt16LE(extra)===1){bytes=Number(directory.readBigUInt64LE(extra+4));break}
      total+=bytes;at+=46+nameLength+extraLength+commentLength;
    }
    return total;
  }finally{await file.close()}
}
// Sizes in whole MB (of 1,048,576 bytes), rounded up for what is needed and down for what is free, so that the parts add up.
const MB=1048576,wholeMb=bytes=>Math.ceil(Math.max(0,bytes)/MB),megabytes=count=>`${count.toLocaleString("en-US")} MB`;
// A step the drive has no room for: neededMb for its parts and the margin, against the bytes free.
const noRoom=({version,step,neededMb,parts,free,root})=>new Error(`Google Antigravity ${version} needs ${megabytes(neededMb)} free on the drive that holds ${root} to ${step} (${parts}, and ${megabytes(ANTIGRAVITY_FREE_SPACE_MARGIN/MB)} to spare), and ${megabytes(Math.floor(Math.max(0,free)/MB))} is free there. Free some space on that drive, then try again. Nothing was installed.`);

// What a started runtime said of itself, in a few plain words.
const saidName=agent=>[agent?.name,agent?.version].map(value=>String(value??"").replace(/[\u0000-\u001f\u007f]+/g," ").trim().slice(0,80)).filter(Boolean).join(" ");
// Why the new runtime did not start, in its error's first line and its log's last one, which says why (agy_acp_server is a PyInstaller
// bundle): the line before PyInstaller's generic "[PYI-…:ERROR] Failed to execute script", or the loader's own line when it failed
// itself (it could not unpack), without its "[PYI-…]" mark.
function startFailure(error,version){
  const ipv6=antigravityIpv6Failure(error);if(ipv6)return ipv6;
  const lines=String(error?.message||error||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean),said=lines.slice(1).filter(line=>!/^\[PYI-\d+:[A-Z]+\] Failed to execute script\b/.test(line));
  const last=said.at(-1)?.replace(/^\[PYI-\d+:[A-Z]+\]\s*/,"");
  const reason=(last?`${lines[0]}: ${last}`:lines[0]||"it gave no reason").slice(0,500);
  return new Error(`The downloaded Google Antigravity ${version} could not start on this machine (${reason}). Nothing was installed.`,{cause:error});
}

// The new runtime is started once, before it replaces the one in use (T3 AntigravityInstallation validate): it must answer ACP's
// initialize as antigravity-acp at the version the registry lists. It starts as Antigravity's sessions start it, from its own folder
// with launchEnv (the profile's launch environment), unpacking itself into a Trebell-owned temp folder that is removed once its
// process tree is stopped (acp-client.mjs), but in a throwaway home of its own with no key: the check touches neither Antigravity's
// home in Trebell nor a sign-in.
async function checkRuntimeStarts({binary,args,launchEnv,version,spawnProcess}){
  const home=await mkdtemp(join(tmpdir(),"trebell-antigravity-check-"));
  const client=new AcpClient({command:binary,args,cwd:dirname(binary),env:antigravityEnvironment(launchEnv,{home}),runTempRoot:acpRuntimeTempRoot(launchEnv,"antigravity"),spawnProcess});
  let agent=null;
  try{await client.start();agent=(await client.initialize({timeoutMs:START_CHECK_TIMEOUT_MS}))?.agentInfo||null}
  catch(error){throw startFailure(error,version)}
  finally{await client.stop().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{})}
  if(agent?.name!=="antigravity-acp"||String(agent?.version??"").trim()!==version){
    const expected=`Google Antigravity ${version} (antigravity-acp ${version})`,said=saidName(agent);
    throw new Error(said?`The downloaded runtime started as ${said}, not as ${expected}, which the ACP registry lists. Nothing was installed.`
      :`The downloaded runtime did not say which agent it is when it started, so it is not the ${expected} the ACP registry lists. Nothing was installed.`);
  }
}

// A folder renamed just after a process that ran from it stopped: Windows can hold it a moment longer (T3 retries 10 times at
// 100 ms). One a running process holds stays held, and the last refusal is thrown.
async function renameSettled(from,to,platform){
  for(let attempt=1;;attempt++){
    try{return await rename(from,to)}
    catch(error){if(platform!=="win32"||attempt>=10||!IN_USE_CODES.has(error?.code))throw error;await new Promise(resolve=>setTimeout(resolve,100))}
  }
}

// Installs or updates Antigravity's ACP runtime from the registry's entry for this machine into <Trebell home>/agent-runtimes/
// antigravity/current, leaving the runtime there unchanged unless every step passes:
// - room: before the download, its size twice (it unpacks to at least as much) and ANTIGRAVITY_FREE_SPACE_MARGIN; once it is in,
//   what its central directory says it unpacks to and the margin, before any file is written; before each file is unpacked, its
//   size and the margin (freeBytes);
// - integrity: the download, hashed as it arrives, must have the registry's SHA-256, and it must hold agy_acp_server with
//   localharness_external beside it;
// - a start: the new runtime answers ACP's initialize as antigravity-acp at the registry's version (checkRuntimeStarts).
// The unpacked folder is then renamed into place, not copied. On Windows a folder a running Antigravity chat holds cannot be renamed:
// that is said, and nothing changes.
export async function installAntigravityRuntime({env=process.env,fetchImpl=globalThis.fetch,platform=process.platform,arch=process.arch,extractImpl=null,launchEnv=env,spawnProcess=null,freeBytes=freeBytesAt}={}){
  const target=antigravityRegistryTarget(platform,arch);if(!target)throw new Error(`Antigravity ACP is not supported on ${platform}/${arch}`);
  const extract=extractImpl||(await loadExtractZip()).default;
  const registryResponse=await fetchImpl(ACP_REGISTRY_URL,{headers:{accept:"application/json"}});
  if(!registryResponse?.ok)throw new Error(`Could not read the ACP registry (${registryResponse?.status||"network error"})`);
  const registry=await registryResponse.json();
  const entry=(registry?.agents||[]).find(item=>item?.id==="antigravity-acp");
  if(!entry)throw new Error("Google Antigravity is missing from the ACP registry");
  const distribution=validateDistribution(entry,target),version=distribution.version;
  const root=join(trebellHome(env),"agent-runtimes","antigravity"),installId=randomUUID(),temp=join(root,`.install-${installId}`),archivePath=join(temp,"runtime.zip"),extracted=join(temp,"extracted"),ready=join(temp,"ready"),current=join(root,"current"),previous=join(root,`.previous-${installId}`);
  // A drive whose free space cannot be read is not checked (T3 skips its check too); a full one still fails as ENOSPC, said below.
  const freeOn=path=>{try{return freeBytes(path)}catch{return Infinity}};
  await mkdir(extracted,{recursive:true});
  try{
    const response=await fetchImpl(distribution.archive,{redirect:"follow"});
    if(!response?.ok||!response.body)throw new Error(`Could not download Google Antigravity ACP (${response?.status||"network error"})`);
    // Room for the download and what it unpacks to, at least as much again, from the size it says it has (a gzip-encoded download
    // says its encoded size, about the same for a zip); each file's own size is checked again as it is unpacked.
    const downloadMb=wholeMb(Number(response.headers?.get?.("content-length"))||0),neededMb=2*downloadMb+ANTIGRAVITY_FREE_SPACE_MARGIN/MB,free=freeOn(temp);
    if(free<neededMb*MB){
      try{await response.body.cancel()}catch{}
      throw noRoom({version,step:"install",neededMb,free,root,parts:downloadMb?`its ${megabytes(downloadMb)} download and at least as much again once unpacked`:"its download, which did not say its size"});
    }
    const hash=createHash("sha256");
    await pipeline(Readable.fromWeb(response.body),async function*(chunks){for await(const chunk of chunks){hash.update(chunk);yield chunk}},createWriteStream(archivePath,{mode:0o600}));
    if(hash.digest("hex")!==distribution.sha256)throw new Error(`The Google Antigravity ${version} download does not match the SHA-256 the ACP registry lists for it. Nothing was installed.`);
    // Room for what it unpacks to, as its central directory lists it, before any file is written: the install needs the download,
    // its files and the margin at once. Named whole, with what is free as the drive shows it once the download has gone again, so
    // freeing what is named lets the next install through. An archive whose sizes cannot be read is left to the checks below.
    const unpacked=await zipUnpackedBytes(archivePath).catch(()=>null);
    if(unpacked!=null){
      const downloaded=(await stat(archivePath)).size,free=freeOn(temp);
      if(free<unpacked+ANTIGRAVITY_FREE_SPACE_MARGIN)throw noRoom({version,step:"install",neededMb:wholeMb(downloaded)+wholeMb(unpacked)+ANTIGRAVITY_FREE_SPACE_MARGIN/MB,free:free+downloaded,root,parts:`its ${megabytes(wholeMb(downloaded))} download and the ${megabytes(wholeMb(unpacked))} it unpacks to`});
    }
    await extract(archivePath,{dir:extracted,onEntry:item=>{
      const fileMb=wholeMb(Number(item?.uncompressedSize)||0),neededMb=fileMb+ANTIGRAVITY_FREE_SPACE_MARGIN/MB,free=freeOn(extracted);
      if(free<neededMb*MB)throw noRoom({version,step:`unpack ${basename(String(item?.fileName||""))||"its files"}`,neededMb,free,root,parts:`${megabytes(fileMb)} for it`});
    }});
    await rm(archivePath,{force:true});
    const source=await findFile(extracted,distribution.binaryName);if(!source)throw new Error(`Downloaded Antigravity archive did not contain ${distribution.binaryName}`);
    const helper=await stat(join(dirname(source),distribution.helperName)).catch(()=>null);
    if(!helper?.isFile())throw new Error(`The Google Antigravity ${version} download has no ${distribution.helperName} beside ${distribution.binaryName}, which Antigravity needs to run. Nothing was installed.`);
    // The server's folder with its helper and whatever else Google ships beside it (the launcher expects those relative paths),
    // moved into place rather than copied: no second copy on the drive.
    await rename(dirname(source),ready);
    const installedBinary=join(ready,distribution.binaryName);
    if(platform!=="win32")for(const name of [distribution.binaryName,distribution.helperName])await chmod(join(ready,name),0o755);
    await checkRuntimeStarts({binary:installedBinary,args:distribution.args,launchEnv,version,spawnProcess});
    await writeFile(join(ready,"install.json"),JSON.stringify({runtime:"antigravity",source:"acp-registry",registryUrl:ACP_REGISTRY_URL,version,target,archive:distribution.archive,sha256:distribution.sha256,args:distribution.args,installedAt:new Date().toISOString()},null,2),{encoding:"utf8",mode:0o600});
    let movedPrevious=false;
    try{await renameSettled(current,previous,platform);movedPrevious=true}catch(error){
      if(error?.code==="ENOENT"){}
      // A chat's Antigravity runs from current until the chat is archived or deleted (most keep it so, for what their commands left
      // running) or Trebell quits: Stop ends a turn, not that process (agent-relay.mjs).
      else if(platform==="win32"&&IN_USE_CODES.has(error?.code))throw new Error(`Google Antigravity ${version} was downloaded and checked, but the Antigravity runtime in use could not be replaced: an Antigravity chat used since Trebell Code started still runs it, and Stop does not end that. Archive or delete those Antigravity chats, which also ends what they left running, or quit Trebell Code (from its tray icon too), then try again. Nothing was installed.`,{cause:error});
      else throw error;
    }
    try{await renameSettled(ready,current,platform)}catch(error){if(movedPrevious)await rename(previous,current).catch(()=>{});throw error}
    if(movedPrevious)await rm(previous,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
    return {ok:true,version,target,binary:join(current,distribution.binaryName),args:distribution.args};
  }catch(error){
    if(error?.code==="ENOSPC")throw new Error(`The drive that holds ${root} ran out of space while Trebell Code installed Google Antigravity ${version}. Free some space on that drive, then try again. Nothing was installed.`,{cause:error});
    throw error;
  }finally{await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{})}
}

export async function readAntigravityInstall({env=process.env}={}){
  try{return JSON.parse(await readFile(join(trebellHome(env),"agent-runtimes","antigravity","current","install.json"),"utf8"))}catch{return null}
}
