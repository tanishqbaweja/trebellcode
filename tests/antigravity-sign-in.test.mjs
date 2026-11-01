// Antigravity's own sign-in (signInAntigravity), against a stand-in for Antigravity's ACP server (fixtures/antigravity-acp-agent.mjs):
// it picks one of Antigravity's own logins (Google's first, never the key method), records it in Antigravity's home before the agent
// runs it, and opens its one session in a throwaway folder, never the project. No key is in its environment, whatever the launch
// held. It gives up after 5 minutes saying how to finish (as it signs in or as it opens its session), and says in plain words why
// when Antigravity exits for want of IPv6 sockets, when Google wants a subscription or when its session cannot start. Settings'
// route: antigravity-sign-in-route.test.mjs. The home "~" stands for and the IPv6 check alone: antigravity-home-and-ipv6.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANTIGRAVITY_IPV6_MESSAGE, antigravityEnvironment, antigravityOwnSignInMethod, signInAntigravity } from "../src/antigravity-auth.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const inside=(path,root)=>{const rel=relative(resolve(root),resolve(path));return Boolean(rel)&&!rel.startsWith("..")&&!isAbsolute(rel)};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// Trebell words these itself: sentences written elsewhere for them are not reused.
const UNREACHABLE="Antigravity's sign-in did not finish within 5 minutes. Finish it in the browser page Antigravity opened; Antigravity does not fall back to IPv4 when IPv6 fails, so also check that this machine reaches Google, then sign in again.";

// A scenario for the stand-in in a folder of its own, removed after the test; env is a launch's environment as Trebell builds it.
async function standIn(t,scenario,{key=null}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-sign-in-")),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(scenarioPath,JSON.stringify({expectKey:KEY,...scenario}));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env=antigravityEnvironment({...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath},{home:join(root,"agy-home"),apiKey:key});
  return {root,env,scenarioPath,async log(){try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}}};
}
const signIn=(fx,options={})=>signInAntigravity({command:process.execPath,args:[AGENT],env:fx.env,version:"test",...options});

test("Antigravity signs in with its own Google login, recorded before it runs, and opens its one session in a throwaway folder, never the project",async t=>{
  const fx=await standIn(t,{},{key:KEY});
  const recorded=[];
  const signedIn=await signIn(fx,{onMethod:async method=>{recorded.push([method,(await fx.log()).map(entry=>entry.method)])}});
  assert.deepEqual([signedIn.methodId,signedIn.methodName,signedIn.setup.sessionId],["oauth-personal","Log in with Google","agy-session"]);
  assert.deepEqual(recorded,[["oauth-personal",["initialize"]]],"the method is recorded in its home before authenticate runs");
  const log=await fx.log(),asked=log.map(entry=>entry.method);
  assert.deepEqual(asked.slice(0,3),["initialize","authenticate","session/new"]);
  const authenticate=log.find(entry=>entry.method==="authenticate"),created=log.find(entry=>entry.method==="session/new");
  assert.equal(authenticate.params.methodId,"oauth-personal");
  assert.equal(authenticate.keySet,false,"no Gemini key reaches its own sign-in, though the launch held one");
  assert.equal(authenticate.googleApiKey,false);
  assert.equal(authenticate.fileStorage,"1");assert.equal(authenticate.geminiHome,join(fx.root,"agy-home"));
  assert.ok(inside(created.params.cwd,tmpdir())&&basename(created.params.cwd).startsWith("trebell-antigravity-sign-in-"),`session/new ran in ${created.params.cwd}`);
  assert.notEqual(resolve(created.params.cwd),resolve(process.cwd()),"not the project");
  assert.deepEqual(created.params.mcpServers,[]);
  await assert.rejects(stat(created.params.cwd),{code:"ENOENT"},"the throwaway folder is gone once the sign-in has ended");
});

test("the login picked is the one asked for when listed, else Google's, Enterprise's, Agent Platform's, never the key method",()=>{
  const all=[{id:"gemini-api-key",name:"Gemini API key"},{id:"agent-platform",name:"Agent Platform"},{id:"oauth-business",name:"Enterprise"},{id:"oauth-personal",name:"Google"}];
  assert.equal(antigravityOwnSignInMethod(all).id,"oauth-personal");
  assert.equal(antigravityOwnSignInMethod(all,"oauth-business").id,"oauth-business");
  assert.equal(antigravityOwnSignInMethod(all,"gemini-api-key").id,"oauth-personal","the key method is never Sign in's");
  assert.equal(antigravityOwnSignInMethod(all.slice(0,2)).id,"agent-platform");
  assert.equal(antigravityOwnSignInMethod([{id:"gemini-api-key"}]),null);
  assert.equal(antigravityOwnSignInMethod([{id:"agent-login",type:"agent"}]).id,"agent-login");
});

test("a sign-in Antigravity never finishes ends after 5 minutes saying how to finish it",{timeout:60_000},async t=>{
  // The stand-in starts 3 s late, as an Antigravity can on a busy machine.
  const fx=await standIn(t,{authenticate:"hang",startDelayMs:3000});
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  let settled=null;
  const signing=signIn(fx).then(()=>{settled="signed in"},error=>{settled=error});
  for(const deadline=performance.now()+30_000;!(await fx.log()).some(entry=>entry.method==="authenticate");){assert.ok(performance.now()<deadline,"authenticate was never sent");await turn()}
  t.mock.timers.tick(299_999);for(let i=0;i<20;i++)await turn();
  assert.equal(settled,null,"still waiting a moment before 5 minutes");
  t.mock.timers.tick(1);
  await signing;
  assert.ok(settled instanceof Error,"the sign-in failed");
  assert.equal(settled.message,UNREACHABLE);
});

test("an Antigravity that exits for want of IPv6 sockets says it needs them, as it starts or as it signs in",async t=>{
  for(const [exitAt,stderr] of [["start","OSError: [Errno 97] Address family not supported by protocol: AF_INET6\n"],["authenticate","E1027 grpc: flag enforce_kernel_ipv6_support is set but this machine has no IPv6\n"]]){
    const fx=await standIn(t,{exitAt,stderr,exitCode:1});
    await assert.rejects(signIn(fx),error=>error.message===ANTIGRAVITY_IPV6_MESSAGE&&/ACP runtime exited code=1/.test(error.cause?.message||""),exitAt);
  }
});

// Note (2026-11-01): the subscription and session sentences are new wording of Trebell's own, which this test now pins in place of
// the earlier wording; the cases and their order are as before.
const NO_SUBSCRIPTION="Google says this account's plan does not include Antigravity (SUBSCRIPTION_REQUIRED). Sign in with an account whose plan includes it, or set Antigravity to run on a Google Gemini API key.";
test("Google's subscription refusal, a refused sign-in and a session that cannot start each say so, in plain words",async t=>{
  const cases=[
    [{authenticate:{code:-32603,message:"Internal error",data:{message:"SUBSCRIPTION_REQUIRED: this account has no Antigravity access"}}},NO_SUBSCRIPTION,-32603],
    // Google's reason code deep in the error's data (a google.rpc.ErrorInfo), under a message that says nothing.
    [{authenticate:{code:-32603,message:"Internal error",data:{error:{status:"PERMISSION_DENIED",details:[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",reason:"SUBSCRIPTION_REQUIRED"}]}}}},NO_SUBSCRIPTION,-32603],
    // The same code after the sign-in, as the session reads the account's models.
    [{sessionNew:{code:-32603,message:"Internal error",data:{message:"could not read the account's plan\nSUBSCRIPTION_REQUIRED"}}},NO_SUBSCRIPTION,-32603],
    [{sessionNew:{code:-32603,message:"Internal error",data:{message:"could not load models"}}},"The sign-in went through, but Antigravity failed to open a session and read the account's models: could not load models",-32603],
    [{authenticate:{code:-32000,message:"Login was cancelled"}},"Antigravity could not sign in: Login was cancelled",-32000],
    // A code inside a longer word is not Google's.
    [{authenticate:{code:-32603,message:"NOT_SUBSCRIPTION_REQUIRED_HERE"}},"Antigravity could not sign in: NOT_SUBSCRIPTION_REQUIRED_HERE",-32603],
  ];
  for(const [scenario,said,code] of cases){
    const fx=await standIn(t,scenario);
    await assert.rejects(signIn(fx),error=>{
      assert.equal(error.message,said);assert.equal(error.code,code,"the agent's JSON-RPC code stays on the error");
      assert.ok(error.cause instanceof Error,"what Antigravity answered is the cause");return true;
    });
  }
});

test("a session Antigravity never opens after signing in ends after 5 minutes saying how to finish",{timeout:60_000},async t=>{
  const fx=await standIn(t,{sessionNew:"hang"});
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  let settled=null;
  const signing=signIn(fx).then(()=>{settled="signed in"},error=>{settled=error});
  for(const deadline=performance.now()+30_000;!(await fx.log()).some(entry=>entry.method==="session/new");){assert.ok(performance.now()<deadline,"session/new was never sent");await turn()}
  t.mock.timers.tick(299_999);for(let i=0;i<20;i++)await turn();
  assert.equal(settled,null,"still waiting a moment before 5 minutes");
  t.mock.timers.tick(1);
  await signing;
  assert.ok(settled instanceof Error,"the sign-in failed");
  assert.equal(settled.message,UNREACHABLE);
});
