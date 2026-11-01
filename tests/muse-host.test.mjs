import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSE_HOST_BOUNDS, MuseHost, museHostEnvironment, museLaunchPlan, museSchemaVerdict, museServeArgs, museSessionSettings, museWorkspaceRoot, verbatimWindowsPath } from "../src/muse-host.mjs";
import { MuseAgentSession } from "../src/muse-agent-session.mjs";
import { FakeMuse, INIT, fakeChild, fakeStop } from "./fixtures/muse/fake-host.mjs";

// How Trebell starts `muse serve`, which folder it names to Muse Code, the settings and environment a host gets, and how a start
// reads Muse's initialize answer. The launch, session/start and turn/start themselves are checked in
// tests/muse-agent-session.test.mjs and tests/muse-approvals.test.mjs.

const READ_ONLY=["serve","--disable-shell","--disable-write"];
const TRUSTED=["serve","--trust-workspace"];
const FULL=["serve","--trust-workspace","--disable-sandbox"];

test("muse serve's arguments: each access level's flags in one order, with the session log off only when the caller says so",()=>{
  const cases=[
    [["read-only"],READ_ONLY],
    [["read-only",{sessionLog:false}],[...READ_ONLY,"--no-session-log"]],
    [["full"],FULL],
    [["full",{sessionLog:false}],[...FULL,"--no-session-log"]],
    [["full",{sessionLog:true}],FULL],
    [["edits",{sessionLog:undefined}],TRUSTED],
    [["auto",{sessionLog:null}],[...TRUSTED,"--no-session-log"]],
    [["supervised",{}],TRUSTED],
    // No mode at all is Supervised, as MuseHost's own default is.
    [[],TRUSTED],
    [[undefined,{sessionLog:false}],[...TRUSTED,"--no-session-log"]],
    // The other names Trebell's permission policy reads, and a mode it does not know (Supervised).
    [["readonly"],READ_ONLY],
    [["workspace-write"],TRUSTED],
    [["isolated"],TRUSTED],
    [["full-access"],FULL],
    [["no-such-mode"],TRUSTED],
  ];
  for(const [args,expected] of cases)assert.deepEqual(museServeArgs(...args),expected,JSON.stringify(args));
});

test("each call gives a host its own arguments, and the launch plan carries the same ones",()=>{
  const first=museServeArgs("full");
  first.push("--provider","echo");
  assert.deepEqual(museServeArgs("full"),FULL,"a host that changes its copy changes no other host's");
  assert.notEqual(museServeArgs("read-only"),museServeArgs("read-only"));
  for(const mode of ["read-only","supervised","edits","auto","full"])assert.deepEqual(museLaunchPlan(mode).args,museServeArgs(mode),mode);
});

test("the verbatim form: a drive path and a share take their prefixes, a verbatim path of either kind stays, nothing else changes",()=>{
  assert.equal(verbatimWindowsPath("C:\\Users\\ada\\code"),"\\\\?\\C:\\Users\\ada\\code");
  assert.equal(verbatimWindowsPath("c:\\lower case\\"),"\\\\?\\c:\\lower case\\","letter case and a trailing separator are kept");
  assert.equal(verbatimWindowsPath("\\\\Fileserver\\Team Share\\app"),"\\\\?\\UNC\\Fileserver\\Team Share\\app");
  assert.equal(verbatimWindowsPath("\\\\?\\UNC\\fileserver\\team\\app"),"\\\\?\\UNC\\fileserver\\team\\app");
  assert.equal(verbatimWindowsPath("\\\\?\\Z:\\"),"\\\\?\\Z:\\");
  for(const missing of [undefined,null,""])assert.equal(verbatimWindowsPath(missing),"\\\\?\\",String(missing));
});

test("the workspace root: a folder that cannot be resolved gets Windows separators on Windows and is left as given elsewhere",async()=>{
  const missing=async path=>{throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`),{code:"ENOENT"})};
  assert.equal(await museWorkspaceRoot("D:/work/site",{platform:"win32",verbatim:false,resolveReal:missing}),"D:\\work\\site");
  assert.equal(await museWorkspaceRoot("D:/work/site",{platform:"win32",resolveReal:missing}),"\\\\?\\D:\\work\\site");
  assert.equal(await museWorkspaceRoot("//fileserver/team/site",{platform:"win32",resolveReal:missing}),"\\\\?\\UNC\\fileserver\\team\\site");
  for(const verbatim of [true,false]){
    assert.equal(await museWorkspaceRoot("/srv/work/site",{platform:"darwin",verbatim,resolveReal:missing}),"/srv/work/site");
    assert.equal(await museWorkspaceRoot("/srv/a\\b",{platform:"linux",verbatim,resolveReal:missing}),"/srv/a\\b","a backslash is part of a Linux name");
  }
  // A resolver that throws at once fails the same way as one that rejects.
  assert.equal(await museWorkspaceRoot("E:/x",{platform:"win32",verbatim:false,resolveReal:()=>{throw new Error("refused")}}),"E:\\x");
});

test("the workspace root: the resolved folder in Muse's form for the platform, a share on Windows in the UNC verbatim form",async()=>{
  const share=async()=>"\\\\fileserver\\team\\app";
  assert.equal(await museWorkspaceRoot("S:\\app",{platform:"win32",resolveReal:share}),"\\\\?\\UNC\\fileserver\\team\\app");
  assert.equal(await museWorkspaceRoot("S:\\app",{platform:"win32",verbatim:false,resolveReal:share}),"\\\\fileserver\\team\\app");
  const asked=[];
  const moved=async path=>{asked.push(path);return path.replace("/home/ada","/mnt/data")};
  assert.equal(await museWorkspaceRoot("/home/ada/app",{platform:"linux",resolveReal:moved}),"/mnt/data/app");
  assert.equal(await museWorkspaceRoot({toString:()=>"/home/ada/web"},{platform:"linux",verbatim:false,resolveReal:moved}),"/mnt/data/web");
  assert.deepEqual(asked,["/home/ada/app","/home/ada/web"],"the resolver gets the path as text");
});

test("the workspace root follows a link to the folder it names, plain and in the verbatim form",async()=>{
  const base=await mkdtemp(join(tmpdir(),"trebell-muse-root-"));
  try{
    const target=join(base,"Real Folder");
    await mkdir(target);
    const link=join(base,"linked");
    await symlink(target,link,process.platform==="win32"?"junction":"dir");
    const real=await realpath(target);
    assert.equal(await museWorkspaceRoot(link,{verbatim:false}),real);
    const turnRoot=await museWorkspaceRoot(link);
    if(process.platform==="win32"){
      assert.ok(turnRoot.startsWith("\\\\?\\"),turnRoot);
      assert.equal(turnRoot,verbatimWindowsPath(real));
    }else assert.equal(turnRoot,real);
  }finally{await rm(base,{recursive:true,force:true})}
});

test("a session's settings: each access level by any name Trebell's policy knows it by, a new object each time, and plans in one key order",()=>{
  const settings=(permissionProfile,approvalMode)=>({permissionProfile,approvalMode});
  const ASK=settings(":ask-me","promptUnmatched"),UNRESTRICTED=settings(":unrestricted","allowAll"),REVIEWED=settings(":auto-review","promptUnmatched");
  const cases=[
    ["full",UNRESTRICTED],["full-access",UNRESTRICTED],["FULL",UNRESTRICTED],
    ["auto",REVIEWED],["isolated",REVIEWED],["isolated-environment",REVIEWED],
    ["supervised",ASK],["edits",ASK],["workspace-write",ASK],["read-only",ASK],["readonly",ASK],["no-such-mode",ASK],[undefined,ASK],[null,ASK],
  ];
  for(const [mode,expected] of cases)assert.deepEqual(museSessionSettings(mode),expected,String(mode));
  const changed=museSessionSettings("full");changed.approvalMode="denyUnmatched";
  assert.deepEqual(museSessionSettings("full"),UNRESTRICTED,"a caller that changes its answer changes no later one");
  // needsRelaunch compares plans as JSON.
  for(const mode of ["read-only","supervised","edits","auto","full"])assert.deepEqual(Object.keys(museLaunchPlan(mode)),["args","permissionProfile","approvalMode"],mode);
});

test("a host's environment: the key variables held back in any case on every profile but the Meta key of one set to its API key, and the self-update always off",()=>{
  const KEYS=Object.fromEntries([["META_API_KEY","meta"],["model_api_key","model"],["OpenAI_Api_Key","openai"],["ANTHROPIC_API_KEY","anthropic"],["openrouter_api_key","openrouter"],["Muse_Custom_Headers","headers"]]);
  const source={PATH:"/bin",GEMINI_API_KEY:"not for Muse",META_API_KEY_FILE:"/keys/meta",...KEYS};
  assert.deepEqual(museHostEnvironment(source),{PATH:"/bin",GEMINI_API_KEY:"not for Muse",META_API_KEY_FILE:"/keys/meta",MUSE_NO_AUTO_UPDATE:"1"},"only the names themselves are held back");
  assert.deepEqual(museHostEnvironment(source,{authMethod:"api-key"}),{PATH:"/bin",GEMINI_API_KEY:"not for Muse",META_API_KEY_FILE:"/keys/meta",META_API_KEY:"meta",MUSE_NO_AUTO_UPDATE:"1"},"an API key profile passes on its Meta key alone");
  assert.equal(museHostEnvironment({meta_api_key:"lower"},{authMethod:"api-key"}).meta_api_key,"lower","in the case it was given");
  for(const authMethod of ["sign-in","API-KEY",undefined])assert.equal("META_API_KEY" in museHostEnvironment(source,{authMethod}),false,String(authMethod));
  assert.deepEqual(museHostEnvironment({MUSE_NO_AUTO_UPDATE:"0",PATH:"/bin"}),{MUSE_NO_AUTO_UPDATE:"1",PATH:"/bin"},"a self-update the environment turned on is turned off");
  assert.deepEqual(museHostEnvironment(null),{MUSE_NO_AUTO_UPDATE:"1"});
  assert.deepEqual(Object.keys(source),["PATH","GEMINI_API_KEY","META_API_KEY_FILE",...Object.keys(KEYS)],"the given environment stays as it was");
  const own=museHostEnvironment();
  assert.deepEqual(Object.keys(own).filter(name=>name!=="MUSE_NO_AUTO_UPDATE"),Object.keys(process.env).filter(name=>!/^(?:META_API_KEY|MODEL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|MUSE_CUSTOM_HEADERS|MUSE_NO_AUTO_UPDATE)$/i.test(name)),"no environment given is the process's own");
});

test("an initialize answer's schema: version 1 or a refusal that names what Muse Code gave, and a fingerprint compared through the SDK that only warns",()=>{
  const compared=[],compare=served=>{compared.push(served);return served===INIT.schema.fingerprint?undefined:{message:`moved: ${served}`}};
  assert.deepEqual(museSchemaVerdict(INIT,compare),{warning:null},"the pinned fingerprint");
  assert.deepEqual(museSchemaVerdict({...INIT,schema:{version:1,fingerprint:"sha256:new"}},compare),{warning:"moved: sha256:new"});
  assert.deepEqual(compared,[INIT.schema.fingerprint,"sha256:new"]);
  assert.match(museSchemaVerdict({...INIT,schema:{version:1}},compare).warning,/did not name its protocol schema fingerprint.*the session goes on/);
  assert.match(museSchemaVerdict({...INIT,schema:{version:1,fingerprint:7}},compare).warning,/did not name its protocol schema fingerprint/);
  for(const [answer,named] of [
    [{...INIT,schema:{...INIT.schema,version:2}},"answered with session protocol version 2,"],
    [{...INIT,schema:{...INIT.schema,version:"1"}},"answered with session protocol version \"1\","],
    [{...INIT,schema:{fingerprint:INIT.schema.fingerprint}},"named no session protocol version,"],
    [{...INIT,schema:undefined},"named no session protocol version,"],
    [null,"named no session protocol version,"],
  ]){
    const {refusal,warning}=museSchemaVerdict(answer,compare);
    assert.equal(warning,undefined);
    assert.equal(refusal,`Muse Code ${named} but Trebell Code reads only version 1. Install a Muse Code release that serves version 1.`);
  }
  assert.equal(compared.length,2,"a refused answer's fingerprint is not compared");
});

test("a start sends Trebell Code's initialize, then initialized only for an answer it accepts; a missing fingerprint warns, a refusal closes the host",async()=>{
  const start=async(answer,{startOptions={},onWarning}={})=>{
    const child=fakeChild(),muse=new FakeMuse(child,{handlers:{initialize:()=>answer}}),warnings=[];
    const host=new MuseHost({command:"muse",spawnFn:()=>child,stopTree:fakeStop,onWarning:onWarning||(message=>warnings.push(message))});
    const outcome=await host.start(startOptions).then(value=>({value}),error=>({error}));
    await host.close();
    return {host,muse,warnings,outcome,sent:method=>muse.frames.filter(frame=>frame.method===method)};
  };
  const pinned=await start(INIT,{startOptions:{version:"",requestedCapabilities:["sessionMcp","userShell"]}});
  assert.equal(pinned.outcome.value,pinned.host,"a start resolves to its host");
  assert.deepEqual(pinned.sent("initialize")[0].params,{clientInfo:{name:"trebell_code",title:"Trebell Code",version:"0.0.0"},capabilities:{requestedCapabilities:["sessionMcp","userShell"]}});
  assert.equal(pinned.sent("initialized").length,1);
  assert.deepEqual([pinned.warnings,pinned.host.schemaWarning],[[],null],"the pinned fingerprint warns of nothing");
  assert.equal(pinned.host.initializeResult.museHome,INIT.museHome);
  const unnamed=await start({...INIT,schema:{version:1}});
  assert.equal(unnamed.outcome.value,unnamed.host);
  assert.equal(unnamed.warnings.length,1);
  assert.match(unnamed.warnings[0],/did not name its protocol schema fingerprint/);
  assert.equal(unnamed.host.schemaWarning,unnamed.warnings[0]);
  const listenerFails=await start({...INIT,schema:{version:1,fingerprint:"sha256:"+"0".repeat(64)}},{onWarning:()=>{throw new Error("the listener failed")}});
  assert.equal(listenerFails.outcome.value,listenerFails.host,"a listener that throws does not fail the start");
  assert.match(listenerFails.host.schemaWarning,/differs from the fingerprint this SDK pins/);
  for(const schema of [undefined,{fingerprint:INIT.schema.fingerprint},{...INIT.schema,version:"1"}]){
    const refused=await start({...INIT,schema});
    assert.match(refused.outcome.error?.message,/but Trebell Code reads only version 1/,JSON.stringify(schema));
    assert.equal(refused.sent("initialized").length,0);
    assert.equal(refused.muse.stdinEnded,true,"the refused host's input is closed");
    assert.equal(refused.host.initializeResult,null);
  }
});

test("a host waits 20 s for its initialize answer and 10 s for its exit unless its options say otherwise, and a session hands its own on",()=>{
  assert.deepEqual(MUSE_HOST_BOUNDS,{answerMs:20_000,exitMs:10_000});
  assert.equal(Object.isFrozen(MUSE_HOST_BOUNDS),true);
  const plain=new MuseHost({command:"muse",env:{PATH:"/bin"}});
  assert.deepEqual([plain.startupTimeoutMs,plain.shutdownTimeoutMs],[20_000,10_000]);
  const quick=new MuseHost({command:"muse",env:{PATH:"/bin"},startupTimeoutMs:8_000,shutdownTimeoutMs:2_000});
  assert.deepEqual([quick.startupTimeoutMs,quick.shutdownTimeoutMs],[8_000,2_000]);
  const session=new MuseAgentSession({command:"muse",cwd:process.cwd(),onUpdate:()=>{}});
  assert.deepEqual([session.hostOptions.startupTimeoutMs,session.hostOptions.shutdownTimeoutMs],[20_000,10_000]);
  const tuned=new MuseAgentSession({command:"muse",cwd:process.cwd(),onUpdate:()=>{},startupTimeoutMs:5_000,shutdownTimeoutMs:1_000});
  assert.deepEqual([tuned.hostOptions.startupTimeoutMs,tuned.hostOptions.shutdownTimeoutMs],[5_000,1_000]);
});
