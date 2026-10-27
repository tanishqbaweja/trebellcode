// Trebell Code installs Antigravity's ACP runtime from the ACP registry's entry for this machine (antigravity-runtime-installer.mjs),
// and the runtime in place stays unchanged unless every step passes: the drive has room for the download and for each file it
// unpacks, the download has the SHA-256 the registry lists beside it (an entry without one is refused), it holds agy_acp_server with
// localharness_external beside it, and the new runtime starts and says it is antigravity-acp at the registry's version (T3 Code's
// AntigravityInstallation checks). The unpacked folder is then moved into place, not copied; on Windows a runtime a running chat
// holds is not replaced, and the person is told to stop their Antigravity chats. Here the registry and the download are fakes, the
// archive a real zip that extract-zip unpacks, and the runtime started a stand-in for Antigravity's server (fixtures/
// antigravity-acp-agent.mjs, or fixtures/scripted-acp-agent.mjs for one that says it is another agent).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import extractZip from "extract-zip";
import { ACP_REGISTRY_URL, antigravityRegistryTarget, installAntigravityRuntime, readAntigravityInstall } from "../src/antigravity-runtime-installer.mjs";

const AGY=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url)),SCRIPTED=fileURLToPath(new URL("./fixtures/scripted-acp-agent.mjs",import.meta.url));
const ARCHIVE="https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-fixture-windows-x86_64.zip",MB=1048576;
const VERSION="1.4.3-fixture";// what the stand-in says it is (antigravity-acp-agent.mjs)
const RUNTIME={"agy_acp_server.exe":"stand-in server","localharness_external.exe":"stand-in helper"};
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const inside=(path,root)=>{const rel=relative(resolve(root),resolve(path));return Boolean(rel)&&!rel.startsWith("..")};
const gone=path=>access(path).then(()=>false,()=>true);

test("Antigravity ACP registry target matches supported platform/architecture names",()=>{
  assert.equal(antigravityRegistryTarget("win32","x64"),"windows-x86_64");
  assert.equal(antigravityRegistryTarget("win32","arm64"),"windows-aarch64");
  assert.equal(antigravityRegistryTarget("darwin","arm64"),"darwin-aarch64");
  assert.equal(antigravityRegistryTarget("linux","x64"),"linux-x86_64");
  assert.equal(antigravityRegistryTarget("freebsd","x64"),null);
});

// A zip of the files given ({name: text}), stored uncompressed, as extract-zip reads one.
function zipOf(files){
  const parts=[],directory=[];let offset=0;
  for(const [name,text] of Object.entries(files)){
    const data=Buffer.from(text),fileName=Buffer.from(name),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(fileName.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(fileName.length,28);central.writeUInt32LE(offset,42);
    parts.push(local,fileName,data);directory.push(central,fileName);offset+=30+fileName.length+data.length;
  }
  const centralBytes=Buffer.concat(directory),end=Buffer.alloc(22),count=Object.keys(files).length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,centralBytes,end]);
}

// A Trebell home of the test's own, with what each install there did: the registry and download requests, whether the download's
// body was read, and each start of the new runtime (its command, folder and launch environment, and what the stand-in logged).
async function home(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-antigravity-install-")),holders=[];
  t.after(async()=>{for(const holder of holders)await stopProcess(holder);await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const runtimes=join(root,"trebell-home","agent-runtimes","antigravity");
  return {root,holders,runtimes,current:join(runtimes,"current"),temp:join(root,"tmp"),env:{TREBELL_HOME:join(root,"trebell-home")}};
}
async function stopProcess(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once("exit",resolve));child.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);
}

// One install into the home: the registry lists entry fields (version, sha256, ...) over a windows-x86_64 entry for the zip of files,
// whose download says its size; the new runtime's start runs agent (with scenario or initialize) in place of agy_acp_server.exe.
async function install(fx,{files=RUNTIME,version=VERSION,entry={},scenario={},agent=AGY,initialize=null,freeBytes=()=>64*1024*MB,extractImpl=extractZip}={}){
  const bytes=zipOf(files),requests=[],download={read:false,cancelled:false},launches=[],stamp=Date.now()+"-"+Math.random().toString(36).slice(2);
  const scenarioPath=join(fx.root,`scenario-${stamp}.json`),logPath=join(fx.root,`agent-${stamp}.jsonl`);
  await writeFile(scenarioPath,JSON.stringify(agent===SCRIPTED?{initialize}:scenario));
  const registry={agents:[{id:"antigravity-acp",version,distribution:{binary:{"windows-x86_64":{archive:ARCHIVE,cmd:"./agy_acp_server.exe",sha256:sha256(bytes),...entry}}}}]};
  const fetchImpl=async url=>{
    requests.push(String(url));
    if(url===ACP_REGISTRY_URL)return {ok:true,json:async()=>registry};
    return {ok:true,status:200,headers:new Headers({"content-length":String(bytes.length)}),body:new ReadableStream({pull(controller){download.read=true;controller.enqueue(new Uint8Array(bytes));controller.close()},cancel(){download.cancelled=true}},{highWaterMark:0})};
  };
  const spawnProcess=({command,args,cwd,env,stdio})=>{
    launches.push({command,args,cwd,temp:env.TEMP,geminiHome:env.GEMINI_HOME,key:env.GEMINI_API_KEY??null});
    return spawn(process.execPath,[agent,...args],{cwd,env:{...env,TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath,TREBELL_ACP_SCENARIO:scenarioPath},stdio,windowsHide:true});
  };
  // The profile's launch environment, as the runtime manager gives it: Antigravity's home in Trebell and a saved key among it.
  const launchEnv={...process.env,TEMP:fx.temp,TMP:fx.temp,GEMINI_HOME:join(fx.root,"antigravity-home"),GEMINI_API_KEY:"AIzaSyTrebellFixtureKey0123456789abcdef"};
  let result=null,error=null;
  try{result=await installAntigravityRuntime({env:fx.env,fetchImpl,platform:"win32",arch:"x64",extractImpl,launchEnv,spawnProcess,freeBytes})}catch(caught){error=caught}
  let logged=[];try{logged=(await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{}
  return {result,error,bytes,requests,download,launches,logged};
}
// What is left in the runtimes folder: current alone once an install has ended, never an install's or a replaced runtime's folder.
const leftovers=async fx=>(await readdir(fx.runtimes).catch(()=>[])).filter(name=>name!=="current");

test("an install checks the download against the registry's SHA-256, starts the new runtime once, and moves it into place",async t=>{
  const fx=await home(t);let unpacked=null;
  // The file extract-zip unpacked, to tell whether the installed one is it (moved) or a copy.
  const extractImpl=async(archive,options)=>{await extractZip(archive,options);unpacked=await stat(join(options.dir,"agy_acp_server.exe"))};
  const {result,error,requests,launches,logged}=await install(fx,{extractImpl});
  assert.equal(error,null,String(error?.message));
  assert.deepEqual(requests,[ACP_REGISTRY_URL,ARCHIVE]);
  assert.equal(result.version,VERSION);assert.equal(result.binary,join(fx.current,"agy_acp_server.exe"));
  assert.equal(await readFile(join(fx.current,"agy_acp_server.exe"),"utf8"),"stand-in server");
  assert.equal(await readFile(join(fx.current,"localharness_external.exe"),"utf8"),"stand-in helper");
  assert.equal((await stat(join(fx.current,"agy_acp_server.exe"))).ino,unpacked.ino,"the unpacked file was moved into place, not copied");
  const metadata=await readAntigravityInstall({env:fx.env});
  assert.equal(metadata.source,"acp-registry");assert.equal(metadata.target,"windows-x86_64");assert.equal(metadata.version,VERSION);
  assert.match(metadata.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(await leftovers(fx),[],"no install or replaced runtime folder is left");
  // Its one start: the new folder's server, run from that folder, before it was moved into place.
  assert.equal(launches.length,1,"the new runtime was started once");
  const [launch]=launches;
  assert.equal(basename(launch.command),"agy_acp_server.exe");assert.equal(launch.cwd,dirname(launch.command));
  assert.ok(inside(launch.command,fx.runtimes)&&!inside(launch.command,fx.current),`started from the install's own folder, not current: ${launch.command}`);
  assert.deepEqual(logged.map(item=>item.method),["initialize"],"the check asks initialize and nothing else");
  // In a throwaway home with no key, and unpacking into a Trebell-owned temp folder: all gone once it has stopped.
  assert.equal(launch.key,null,"no Gemini API key reaches the check");assert.equal(logged[0].keySet,false);assert.equal(logged[0].fileStorage,"1");
  assert.ok(basename(launch.geminiHome).startsWith("trebell-antigravity-check-"),`a throwaway home: ${launch.geminiHome}`);
  assert.equal(logged[0].geminiHome,launch.geminiHome);assert.ok(await gone(launch.geminiHome),"the throwaway home is removed");
  assert.ok(inside(launch.temp,join(fx.temp,"trebell-antigravity")),`unpacks into Trebell's run temp: ${launch.temp}`);
  assert.ok(await gone(launch.temp),"the run temp folder is removed");
});

test("a download whose SHA-256 is not the one the registry lists is refused, and the runtime in place is unchanged",async t=>{
  const fx=await home(t);
  const first=await install(fx);assert.equal(first.error,null,String(first.error?.message));
  const second=await install(fx,{version:"1.4.4-fixture",files:{...RUNTIME,"agy_acp_server.exe":"tampered server"},entry:{sha256:sha256("what the registry hashed")}});
  assert.equal(second.error?.message,"The Google Antigravity 1.4.4-fixture download does not match the SHA-256 the ACP registry lists for it. Nothing was installed.");
  assert.equal(second.launches.length,0,"nothing downloaded was started");
  assert.equal(await readFile(join(fx.current,"agy_acp_server.exe"),"utf8"),"stand-in server");
  assert.equal((await readAntigravityInstall({env:fx.env})).version,VERSION);
  assert.deepEqual(await leftovers(fx),[]);
});

test("a registry entry without a SHA-256 is refused before anything is downloaded",async t=>{
  const fx=await home(t);
  for(const sha of [undefined,"","not-a-sha256"]){
    const {error,requests}=await install(fx,{entry:{sha256:sha}});
    assert.equal(error?.message,`The ACP registry lists no SHA-256 for Google Antigravity ${VERSION} on windows-x86_64, so Trebell Code cannot check its download. Nothing was installed.`);
    assert.deepEqual(requests,[ACP_REGISTRY_URL],"the archive is never requested");
  }
  assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
});

test("a download without localharness_external beside agy_acp_server is refused",async t=>{
  const fx=await home(t);
  const {error,launches}=await install(fx,{files:{"agy_acp_server.exe":"stand-in server"}});
  assert.equal(error?.message,`The Google Antigravity ${VERSION} download has no localharness_external.exe beside agy_acp_server.exe, which Antigravity needs to run. Nothing was installed.`);
  // A helper elsewhere in the archive is not beside the server.
  const elsewhere=await install(fx,{files:{"agy_acp_server.exe":"stand-in server","helpers/localharness_external.exe":"stand-in helper"}});
  assert.equal(elsewhere.error?.message,error.message);
  assert.equal(launches.length+elsewhere.launches.length,0);assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
});

test("a downloaded runtime that says it is another agent, or another version, is refused, and the runtime in place is unchanged",async t=>{
  const fx=await home(t);
  const first=await install(fx);assert.equal(first.error,null,String(first.error?.message));
  const other=await install(fx,{version:"1.4.4-fixture",agent:SCRIPTED,initialize:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:"other-agent",version:"1.4.4-fixture"}}});
  assert.equal(other.error?.message,"The downloaded runtime started as other-agent 1.4.4-fixture, not as Google Antigravity 1.4.4-fixture (antigravity-acp 1.4.4-fixture), which the ACP registry lists. Nothing was installed.");
  assert.equal(other.launches.length,1);
  const older=await install(fx,{version:"1.4.4-fixture"});// the stand-in says 1.4.3-fixture
  assert.equal(older.error?.message,"The downloaded runtime started as antigravity-acp 1.4.3-fixture, not as Google Antigravity 1.4.4-fixture (antigravity-acp 1.4.4-fixture), which the ACP registry lists. Nothing was installed.");
  const silent=await install(fx,{version:"1.4.4-fixture",agent:SCRIPTED,initialize:{protocolVersion:1,agentCapabilities:{}}});
  assert.equal(silent.error?.message,"The downloaded runtime did not say which agent it is when it started, so it is not the Google Antigravity 1.4.4-fixture (antigravity-acp 1.4.4-fixture) the ACP registry lists. Nothing was installed.");
  assert.equal((await readAntigravityInstall({env:fx.env})).version,VERSION,"the runtime in place is unchanged");
  assert.deepEqual(await leftovers(fx),[]);
});

test("a downloaded runtime that cannot start is refused, with the last line of what it said",async t=>{
  const fx=await home(t);
  // The stand-in reads initialize, writes its traceback and exits without an answer, as a runtime that fails as it starts does
  // (PyInstaller's own last line said after it).
  const {error,launches}=await install(fx,{scenario:{exitAt:"initialize",exitCode:3,stderr:"Traceback (most recent call last):\n  File \"main.py\", line 31\nValueError: Unexpected git description\n[PYI-45220:ERROR] Failed to execute script 'main' due to unhandled exception!\n"}});
  assert.equal(error?.message,`The downloaded Google Antigravity ${VERSION} could not start on this machine (ACP runtime exited code=3 signal=null: ValueError: Unexpected git description). Nothing was installed.`);
  assert.equal(launches.length,1);assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
  // One that exits for want of IPv6 sockets says how to turn IPv6 on, as its sessions do (antigravity-auth.mjs).
  const ipv6=await install(fx,{scenario:{exitAt:"initialize",exitCode:1,stderr:"OSError: [Errno 97] Address family not supported by protocol: AF_INET6\n"}});
  assert.match(ipv6.error?.message||"",/^Antigravity needs IPv6 socket support, which this machine does not give it\./);
  assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
});

test("a downloaded runtime whose PyInstaller loader fails says the loader's own reason, its only one",async t=>{
  const fx=await home(t);
  // agy_acp_server is a PyInstaller bundle: a loader that cannot unpack itself (a full or unwritable temp folder) writes only its
  // own "[PYI-<pid>:ERROR]" lines.
  const {error}=await install(fx,{scenario:{exitAt:"initialize",exitCode:1,stderr:"[PYI-5120:ERROR] Could not create temporary directory!\n"}});
  assert.equal(error?.message,`The downloaded Google Antigravity ${VERSION} could not start on this machine (ACP runtime exited code=1 signal=null: Could not create temporary directory!). Nothing was installed.`);
  // Its generic last line after a script's own reason still gives way to that reason.
  const both=await install(fx,{scenario:{exitAt:"initialize",exitCode:1,stderr:"[PYI-5121:WARNING] Unpacking took long\nOSError: [Errno 28] No space left on device\n[PYI-5121:ERROR] Failed to execute script 'main' due to unhandled exception!\n"}});
  assert.equal(both.error?.message,`The downloaded Google Antigravity ${VERSION} could not start on this machine (ACP runtime exited code=1 signal=null: OSError: [Errno 28] No space left on device). Nothing was installed.`);
  assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
});

test("a drive without room for the download and what it unpacks to is refused before the download is read, naming how much is needed",async t=>{
  const fx=await home(t);
  const {error,download,requests}=await install(fx,{freeBytes:()=>100*MB+12345});
  // A download of under 1 MB: 1 MB for it, 1 MB to unpack it, and the 256 MB kept free.
  assert.equal(error?.message,`Google Antigravity ${VERSION} needs 258 MB free on the drive that holds ${fx.runtimes} to install (its 1 MB download and at least as much again once unpacked, and 256 MB to spare), and 100 MB is free there. Free some space on that drive, then try again. Nothing was installed.`);
  assert.deepEqual(requests,[ACP_REGISTRY_URL,ARCHIVE]);
  assert.equal(download.read,false,"the download's body was not read");assert.equal(download.cancelled,true,"the download was cancelled");
  assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
});

test("a drive that runs short while the download unpacks is refused before the file that would not fit, naming how much it needs",async t=>{
  const fx=await home(t);
  // Room for the download, then 200 MB once unpacking starts.
  const {error,launches}=await install(fx,{freeBytes:path=>basename(path)==="extracted"?200*MB:64*1024*MB});
  assert.equal(error?.message,`Google Antigravity ${VERSION} needs 257 MB free on the drive that holds ${fx.runtimes} to unpack agy_acp_server.exe (1 MB for it, and 256 MB to spare), and 200 MB is free there. Free some space on that drive, then try again. Nothing was installed.`);
  assert.equal(launches.length,0);assert.ok(await gone(fx.current));assert.deepEqual(await leftovers(fx),[]);
  // A drive that fills anyway says so in words, not as ENOSPC.
  const full=await install(fx,{extractImpl:async()=>{throw Object.assign(new Error("ENOSPC: no space left on device, write"),{code:"ENOSPC"})}});
  assert.equal(full.error?.message,`The drive that holds ${fx.runtimes} ran out of space while Trebell Code installed Google Antigravity ${VERSION}. Free some space on that drive, then try again. Nothing was installed.`);
  assert.deepEqual(await leftovers(fx),[]);
});

test("a drive whose free space cannot be read does not stop the install",async t=>{
  const fx=await home(t);
  const {error}=await install(fx,{freeBytes:()=>{throw Object.assign(new Error("statfs is not supported here"),{code:"ENOSYS"})}});
  assert.equal(error,null,String(error?.message));assert.equal((await readAntigravityInstall({env:fx.env})).version,VERSION);
});

test("on Windows, a runtime a running Antigravity chat holds is not replaced, and the install says to stop the chats first",async t=>{
  if(process.platform!=="win32")return t.skip("only Windows keeps a folder a running process holds from being renamed");
  const fx=await home(t);
  const first=await install(fx);assert.equal(first.error,null,String(first.error?.message));
  // A chat's Antigravity runs from current, as Trebell starts it (its process folder is the runtime's).
  const chat=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{cwd:fx.current,windowsHide:true,stdio:"ignore"});fx.holders.push(chat);
  await new Promise((resolve,reject)=>{chat.once("spawn",resolve);chat.once("error",reject)});
  const before=(await readAntigravityInstall({env:fx.env})).installedAt;
  const held=await install(fx);
  assert.equal(held.error?.message,`Google Antigravity ${VERSION} was downloaded and checked, but the Antigravity runtime in use could not be replaced: a running Antigravity chat holds it. Stop your Antigravity chats, then try again. Nothing was installed.`);
  assert.equal(held.launches.length,1,"it was checked first");
  assert.equal((await readAntigravityInstall({env:fx.env})).installedAt,before,"the runtime in place is unchanged");
  assert.deepEqual(await leftovers(fx),[]);
  // Once the chat has stopped, the install goes through.
  await stopProcess(chat);
  const retried=await install(fx);
  assert.equal(retried.error,null,String(retried.error?.message));assert.notEqual((await readAntigravityInstall({env:fx.env})).installedAt,before);
  assert.deepEqual(await leftovers(fx),[]);
});

// Antigravity's sign-in settings (auth.type, kept beside the agent's own) are antigravity-auth.mjs's: tests/antigravity-api-key.test.mjs.
