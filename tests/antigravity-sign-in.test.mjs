// Antigravity's sign-in with a Gemini API key (signInAntigravity), against a stand-in for Antigravity's ACP server
// (fixtures/antigravity-acp-agent.mjs): it authenticates with the key method and opens its one session in a throwaway folder, never
// the project; it gives up after 5 minutes saying Antigravity could not reach Google, often for broken IPv6; and it says in plain
// words why when Antigravity exits for want of IPv6 sockets, when Google wants a subscription, when Antigravity rejects the key or
// when its session cannot start. The key never appears in what it says. Settings' route: antigravity-sign-in-route.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANTIGRAVITY_IPV6_MESSAGE, antigravityEnvironment, signInAntigravity } from "../src/antigravity-auth.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const inside=(path,root)=>{const rel=relative(resolve(root),resolve(path));return Boolean(rel)&&!rel.startsWith("..")&&!isAbsolute(rel)};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// Trebell words these itself: T3 Code's own sentences for them are not reused.
const UNREACHABLE="Google did not answer Antigravity's sign-in with the Gemini API key within 5 minutes. Antigravity does not fall back to IPv4 when IPv6 fails, so a network whose IPv6 does not work is the likeliest reason: check that this machine reaches Google, then sign in again.";
const T3_WORDS=/could not reach Google\. Check this machine's network connection|Broken IPv6 is a common cause|eligible Antigravity subscription/;

// A scenario for the stand-in in a folder of its own, removed after the test; env is a launch's environment as Trebell builds it.
async function standIn(t,scenario){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-sign-in-")),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(scenarioPath,JSON.stringify({expectKey:KEY,...scenario}));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env=antigravityEnvironment({...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath},{home:join(root,"agy-home")});
  return {root,env,scenarioPath,async log(){try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}}};
}
const signIn=(fx,options={})=>signInAntigravity({command:process.execPath,args:[AGENT],env:fx.env,version:"test",apiKey:KEY,...options});

test("Antigravity signs in with the Gemini API key method and opens its one session in a throwaway folder, never the project",async t=>{
  const fx=await standIn(t,{});
  const signedIn=await signIn(fx,{apiKey:`  "${KEY}"\n`});
  assert.equal(signedIn.key,KEY,"the key as pasted, without its quotes and spaces");
  assert.equal(signedIn.setup.sessionId,"agy-session");
  const log=await fx.log(),asked=log.map(entry=>entry.method);
  assert.deepEqual(asked.slice(0,3),["initialize","authenticate","session/new"]);
  const authenticate=log.find(entry=>entry.method==="authenticate"),created=log.find(entry=>entry.method==="session/new");
  assert.equal(authenticate.params.methodId,"gemini-api-key");
  assert.equal(authenticate.keyIsExpected,true,"the key reaches Antigravity as GEMINI_API_KEY");
  assert.equal(authenticate.googleApiKey,false,"no GOOGLE_API_KEY, which would take the key's place");
  assert.equal(authenticate.fileStorage,"1");assert.equal(authenticate.geminiHome,join(fx.root,"agy-home"));
  assert.ok(inside(created.params.cwd,tmpdir())&&basename(created.params.cwd).startsWith("trebell-antigravity-sign-in-"),`session/new ran in ${created.params.cwd}`);
  assert.notEqual(resolve(created.params.cwd),resolve(process.cwd()),"not the project");
  assert.deepEqual(created.params.mcpServers,[]);
  await assert.rejects(stat(created.params.cwd),{code:"ENOENT"},"the throwaway folder is gone once the sign-in has ended");
});

test("a sign-in Antigravity never answers ends after 5 minutes saying it could not reach Google, often for broken IPv6",async t=>{
  const fx=await standIn(t,{authenticate:"hang"});
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  let settled=null;
  const signing=signIn(fx).then(()=>{settled="signed in"},error=>{settled=error});
  // The stand-in has the authenticate request before the clock moves.
  for(let wait=0;!(await fx.log()).some(entry=>entry.method==="authenticate");wait++){assert.ok(wait<20_000,"authenticate was never sent");await turn()}
  t.mock.timers.tick(299_999);for(let i=0;i<20;i++)await turn();
  assert.equal(settled,null,"still waiting a moment before 5 minutes");
  t.mock.timers.tick(1);
  await signing;
  assert.ok(settled instanceof Error,"the sign-in failed");
  assert.equal(settled.message,UNREACHABLE,"Google out of reach for 5 minutes, and the likeliest reason, in Trebell's words");
  assert.doesNotMatch(settled.message,T3_WORDS,"not T3 Code's sentences");
});

test("an Antigravity that exits for want of IPv6 sockets says it needs them, as it starts or as it signs in",async t=>{
  for(const [exitAt,stderr] of [["start","Traceback (most recent call last):\n  File \"socket.py\", line 233, in __init__\n    _socket.socket.__init__(self, family, type, proto, fileno)\nOSError: [Errno 97] Address family not supported by protocol: AF_INET6\n"],["authenticate","E1027 grpc: flag enforce_kernel_ipv6_support is set but this kernel has no IPv6\n"]]){
    const fx=await standIn(t,{exitAt,stderr,exitCode:1});
    await assert.rejects(signIn(fx),error=>error.message===ANTIGRAVITY_IPV6_MESSAGE&&/ACP runtime exited code=1/.test(error.cause?.message||""),exitAt);
  }
  assert.match(ANTIGRAVITY_IPV6_MESSAGE,/remove ipv6\.disable=1 from \.wslconfig, then run wsl --shutdown/,"it says what to change, and changes nothing itself");
});

test("Google's subscription refusal, a rejected key and a session that cannot start each say so, without the key in it",async t=>{
  const cases=[
    [{authenticate:{code:-32603,message:"Internal error",data:{message:`SUBSCRIPTION_REQUIRED: this project has no Antigravity access (key ${KEY})`}}},/^Google refused Antigravity for this Gemini API key, saying the key's account needs a subscription that includes Antigravity \(SUBSCRIPTION_REQUIRED\)\.$/],
    [{authenticate:{code:-32602,message:"Invalid params",data:{message:`API key ${KEY} not valid`}}},/^Antigravity rejected the Gemini API key\. Check the key in Google AI Studio, then enter it again\.$/],
    [{sessionNew:{code:-32603,message:"Internal error",data:{message:`could not load models for ${KEY}`}}},/^Antigravity signed in with the Gemini API key but could not start a session or load its models: could not load models for \[redacted\]$/],
    [{authenticate:{code:-32000,message:`Login failed for ${KEY}`}},/^Antigravity could not sign in with the Gemini API key: Login failed for \[redacted\]$/],
  ];
  for(const [scenario,said] of cases){
    const fx=await standIn(t,scenario);
    await assert.rejects(signIn(fx),error=>{assert.match(error.message,said);assert.ok(!error.message.includes(KEY),"no key in the message");assert.doesNotMatch(error.message,T3_WORDS);return true});
  }
});

test("no key, or text that is no key, is refused before Antigravity starts",async t=>{
  const fx=await standIn(t,{});
  await assert.rejects(signIn(fx,{apiKey:"   "}),{message:"Antigravity needs a Gemini API key. Create one in Google AI Studio (aistudio.google.com/apikey), then add it to Antigravity in Settings."});
  await assert.rejects(signIn(fx,{apiKey:"two words"}),{message:"That is not a Gemini API key: paste the key Google AI Studio shows, on one line."});
  assert.deepEqual(await fx.log(),[],"Antigravity never started");
});
