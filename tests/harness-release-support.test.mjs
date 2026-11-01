import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { HARNESS_RELEASES, harnessReleaseSupport, supportedLineRange } from "../src/harness-releases.mjs";
import { CLAUDE_OWN_ENDPOINT, museNotFound, openCodeReadiness, openCodeServerPassword, signInNeeded } from "../src/harness-status-words.mjs";
import { readCodexAccount } from "../src/codex-account-probe.mjs";

// Which harness releases Trebell Code knows work (harness-releases.mjs), and the sentences Settings shows for a harness that is not
// ready (harness-status-words.mjs).

const OPENCODE_WORKS="1.14.19 or a later 1.x or 2.x release";
const judged=(kind,said)=>{const {status,version,message,tested}=harnessReleaseSupport(kind,said);return {status,version,message,tested}};

test("OpenCode before 1.14.19 has a known fault, 1.x and 2.x from there work, and 3.0.0 on is newer than Trebell Code runs",()=>{
  for(const [said,version] of [["opencode 1.14.18","1.14.18"],["0.9.0","0.9.0"],["v1.2.27","1.2.27"]]){
    assert.deepEqual(judged("opencode",said),{status:"broken",version,tested:OPENCODE_WORKS,
      message:`OpenCode ${version} has a known fault that keeps it from working with Trebell Code. Install OpenCode ${OPENCODE_WORKS}.`},said);
  }
  for(const [said,version] of [["1.14.19","1.14.19"],["v1.14.19","1.14.19"],["opencode 1.18.35","1.18.35"],["2.0.0","2.0.0"],["opencode v2.0.24","2.0.24"],["2.99.99","2.99.99"],["\u001b[32mopencode 1.14.19\u001b[0m","1.14.19"]]){
    assert.deepEqual(judged("opencode",said),{status:"supported",version,message:null,tested:OPENCODE_WORKS},said);
  }
  for(const [said,version] of [["3.0.0","3.0.0"],["opencode 3.1.4","3.1.4"]]){
    assert.deepEqual(judged("opencode",said),{status:"unsupported",version,tested:OPENCODE_WORKS,
      message:`OpenCode ${version} is newer than any release Trebell Code can run. Install OpenCode ${OPENCODE_WORKS}.`},said);
  }
  // No X.Y.Z of its own: a build name, a prerelease, a four-part number, nothing at all.
  for(const said of ["dev-build","1.14.19-beta.1","1.2.3.4","1.14","",null,undefined]){
    assert.deepEqual(judged("opencode",said),{status:"unknown",version:null,message:null,tested:OPENCODE_WORKS},String(said));
  }
});

test("Muse Code 1.4.8 and later work, an older one is only not known to work, and the -R revision plays no part",()=>{
  const WORKS="1.4.8 or later";
  for(const [said,version] of [["1.4.8","1.4.8"],["muse 1.4.8-R5600","1.4.8"],["Muse Code 1.4.14 (1.4.14-R7309.1)","1.4.14"],
    ["\u001b[1mMuse Code\u001b[0m 1.4.13 (\u001b[32m1.4.13-R6996.1\u001b[0m)","1.4.13"],["2.0.0-R1","2.0.0"]]){
    assert.deepEqual(judged("muse",said),{status:"supported",version,message:null,tested:WORKS},said);
  }
  for(const [said,version] of [["1.4.7-R5000.1","1.4.7"],["muse 1.4.2","1.4.2"],["no version here",null],[null,null]]){
    assert.deepEqual(judged("muse",said),{status:"unknown",version,message:null,tested:WORKS},String(said));
  }
});

test("a harness Trebell Code does not judge by release gets no judgement, and the table cannot be changed",()=>{
  for(const kind of ["claude","codex","grok","cursor","antigravity","native","","toString","__proto__",null,undefined]){
    assert.equal(harnessReleaseSupport(kind,"1.14.19"),null,String(kind));
  }
  assert.equal(harnessReleaseSupport(" OpenCode ","1.14.19").status,"supported","the kind is read as the profile names it");
  assert.equal(Object.isFrozen(HARNESS_RELEASES),true);assert.equal(Object.isFrozen(HARNESS_RELEASES.opencode.from),true);
  assert.deepEqual(Object.keys(HARNESS_RELEASES).sort(),["muse","opencode"]);
  assert.throws(()=>signInNeeded("cursor"),/No sign-in sentence for cursor/);
});

test("the npm range of a line of releases that work: OpenCode's 2.x up to 3.0.0, its 1.x from 1.14.19, and none past the table",()=>{
  assert.equal(supportedLineRange("opencode",2),">=2.0.0 <3.0.0");
  assert.equal(supportedLineRange("opencode",1),">=1.14.19 <2.0.0");
  for(const major of [0,3,4,-1,1.5,"2"])assert.equal(supportedLineRange("opencode",major),null,String(major));
  assert.equal(supportedLineRange("muse",1),">=1.4.8 <2.0.0");
  assert.equal(supportedLineRange("claude",2),null);
});

test("the sentences for a harness that is not ready say what to do",()=>{
  assert.equal(signInNeeded("claude"),"Claude Code has no account signed in. Run `claude auth login`, then try again.");
  assert.equal(signInNeeded("codex"),"Codex has no account signed in. Run codex login, then try again.");
  assert.equal(signInNeeded("grok"),"Grok Build has no account signed in. Run grok login, then try again.");
  assert.deepEqual({...CLAUDE_OWN_ENDPOINT},{type:"ownEndpoint",label:"Own API endpoint",
    message:"Claude Code sends its requests to this profile's own API endpoint, which holds the credentials. A session checks them when it starts."});
  assert.equal(museNotFound("irm https://dev.meta.ai/install.ps1 | iex"),
    "Trebell Code cannot find Muse Code's muse command. Install Muse Code with irm https://dev.meta.ai/install.ps1 | iex (see https://dev.meta.ai/docs/muse-code), then run muse login.");
  // OpenCode, on this machine and at a profile's own server URL: no provider, providers but no models yet, and ready.
  assert.equal(openCodeReadiness(),openCodeReadiness({providers:0}),"no count is none");
  assert.equal(openCodeReadiness({providers:0}),"No provider is connected to OpenCode yet. Add one with opencode auth login, then press Refresh.");
  assert.equal(openCodeReadiness({providers:"none"}),openCodeReadiness({providers:0}),"a count that is not a number is none");
  assert.equal(openCodeReadiness({providers:0,ownServer:true}),"No provider is connected to the OpenCode server at this profile's URL yet. Connect one on that server, then press Refresh.");
  assert.equal(openCodeReadiness({providers:1,models:0}),"OpenCode is connected to 1 provider but lists no models yet. Press Refresh to look again.");
  assert.equal(openCodeReadiness({providers:2,ownServer:true,models:0}),"The OpenCode server at this profile's URL is connected to 2 providers but lists no models yet. Press Refresh to look again.");
  assert.equal(openCodeReadiness({providers:1,models:3}),"OpenCode is ready, listing models from the provider it is connected to.");
  assert.equal(openCodeReadiness({providers:3,ownServer:true}),"The OpenCode server at this profile's URL is ready, listing models from the 3 providers it is connected to.");
  // A refused password: a 2.x server is sent the profile's password, a 1.x one (or one whose version is unknown) none.
  assert.equal(openCodeServerPassword("2.0.24"),"The OpenCode server at this profile's URL refused Trebell Code's password. Check the URL, and the OPENCODE_SERVER_PASSWORD in the profile's environment.");
  const ONE_X="The OpenCode server at this profile's URL wants a password, and Trebell Code gives one only to an OpenCode 1.x server it starts itself. Check the URL, or leave it empty so Trebell Code starts OpenCode for you.";
  assert.equal(openCodeServerPassword("1.18.32"),ONE_X);assert.equal(openCodeServerPassword(null),ONE_X);
});

// A stand-in app-server: one that answers nothing, and one that answers initialize but never account/read.
const SILENT="setInterval(()=>{},1000)";
const STARTS_ONLY=`process.stdin.setEncoding("utf8");let held="";process.stdin.on("data",chunk=>{held+=chunk;let end;while((end=held.indexOf("\\n"))>=0){const line=held.slice(0,end);held=held.slice(end+1);let message;try{message=JSON.parse(line)}catch{continue}if(message.method==="initialize")process.stdout.write(JSON.stringify({id:message.id,result:{userAgent:"codex_cli_rs/0.162.0"}})+"\\n")}});setInterval(()=>{},1000);`;
test("a Codex account read that runs out of time says which request went unanswered and after how long",{timeout:30_000},async()=>{
  const appServer=script=>()=>spawn(process.execPath,["-e",script],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  await assert.rejects(readCodexAccount({spawnAppServer:appServer(SILENT),timeoutMs:1500}),{message:"Codex app-server did not answer initialize within 1.5 seconds"});
  await assert.rejects(readCodexAccount({spawnAppServer:appServer(STARTS_ONLY),timeoutMs:1000}),{message:"Codex app-server did not answer account/read within 1 second"});
  await assert.rejects(readCodexAccount({spawnAppServer:appServer(SILENT),timeoutMs:400}),{message:"Codex app-server did not answer initialize within 400 ms"});
});
