import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCapabilitiesCache, probeClaudeCapabilities } from "../src/claude-capabilities.mjs";
import { readClaudeUsageLimits } from "../src/agent-usage-limits.mjs";

// Claude Code as the SDK's query() starts it for the capability probe, scripted: answer(index) gives each probe's account and
// usage answer, or the error its usage request fails with. Nothing is spawned and no prompt is read.
function scriptedClaude(answer){
  const probes=[];
  const query=()=>{
    const reply=answer(probes.length);probes.push(reply);
    return {
      initializationResult:async()=>({models:[{value:"default",displayName:"Default"}],commands:[{name:"review"}],agents:[],account:reply.account}),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>{if(reply.usageError)throw new Error(reply.usageError);return reply.usage},
      close(){},
    };
  };
  return {query,probes};
}
const SIGNED_IN={email:"person@example.test",subscriptionType:"max",tokenSource:"claude.ai"};
// What Claude Code answers signed out (T3 Code's recorded fixture): no account but tokenSource "none", and no plan limits.
const SIGNED_OUT={tokenSource:"none",apiProvider:"firstParty"};
const PLAN={session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:"2026-10-27T05:00:00Z"}}};
const NO_PLAN={session:{},rate_limits_available:false,rate_limits:null};
// What the Usage card says of a Claude Code that answered signed out: that it is, and how to sign in, not that it has no limits.
const SIGNED_OUT_USAGE={reason:"signedOut",message:"Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login, then press Refresh."};
// The machine-wide probe the model list and the Usage card share (AgentRuntimeManager claudeCapabilities).
const MACHINE={command:"claude",cwd:null,env:{CLAUDE_CONFIG_DIR:"/home/person/.claude"},spawnProcess:null,scope:"",includeUsage:true};
function usageCard(answers){
  let clock=0;
  const claude=scriptedClaude(index=>answers[Math.min(index,answers.length-1)]);
  const cache=createClaudeCapabilitiesCache({now:()=>clock,probe:input=>probeClaudeCapabilities({...input,query:claude.query,managedMcpExists:()=>false})});
  // Each read is the Usage card's Refresh a second after the last one, well inside the five minutes a kept probe is reused.
  const read=(input=MACHINE)=>{clock+=1000;return readClaudeUsageLimits({readCapabilities:()=>cache.load(input)})};
  return {cache,claude,read};
}
const windowsOf=limits=>limits.windows.map(window=>[window.id,window.usedPercent]);

test("Claude Code's plan usage is read again at the next refresh after its usage read failed, and kept once it was read",async()=>{
  const {cache,claude,read}=usageCard([{account:SIGNED_IN,usageError:"Claude Code did not report usage in time."},{account:SIGNED_IN,usage:PLAN}]);
  assert.deepEqual((await read()).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.equal(cache.peek(MACHINE),null,"the failed read is not offered as a current answer");
  assert.deepEqual(cache.peek(MACHINE,{maxAgeMs:Infinity})?.models,[{value:"default",displayName:"Default"}],"a caller that accepts an older answer still has its models and commands");
  const after=await read();
  assert.equal(claude.probes.length,2,"the next refresh asks Claude Code again instead of keeping the failure for five minutes");
  assert.equal(after.unavailable,undefined);assert.deepEqual(windowsOf(after),[["five_hour",12]]);
  assert.deepEqual(windowsOf(await read()),[["five_hour",12]]);
  assert.equal(claude.probes.length,2,"a probe that read the plan's usage is reused");
});

test("Claude Code's plan usage that said limits apply but sent none is read again at the next refresh",async()=>{
  const {claude,read}=usageCard([{account:SIGNED_IN,usage:{session:{},rate_limits_available:true,rate_limits:null}},{account:SIGNED_IN,usage:PLAN}]);
  assert.deepEqual((await read()).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.deepEqual(windowsOf(await read()),[["five_hour",12]]);
  assert.equal(claude.probes.length,2);
});

test("a Claude Code probe answered signed out is not kept, so the Usage card fills in at the first refresh after signing in",async()=>{
  const {cache,claude,read}=usageCard([{account:SIGNED_OUT,usage:NO_PLAN},{account:{...SIGNED_OUT,apiKeySource:"none"},usage:NO_PLAN},{account:SIGNED_IN,usage:PLAN}]);
  assert.deepEqual((await read()).unavailable,SIGNED_OUT_USAGE);
  assert.equal(cache.peek(MACHINE),null,"a signed-out answer is not offered as a current answer");
  assert.deepEqual((await read()).unavailable,SIGNED_OUT_USAGE);
  assert.equal(claude.probes.length,2,"still signed out: asked again, and not kept either");
  assert.deepEqual(windowsOf(await read()),[["five_hour",12]],"signed in: the next refresh shows the plan's windows");
  await read();assert.equal(claude.probes.length,3,"the signed-in answer is kept");
});

test("an account Claude Code signs in some other way is kept: an API key, another API backend or a custom endpoint",async()=>{
  const accounts=[
    {tokenSource:"none",apiKeySource:"ANTHROPIC_API_KEY"},
    {tokenSource:"none",email:"person@example.test"},
    {tokenSource:"none",subscriptionType:"pro"},
    {tokenSource:"none",apiProvider:"bedrock"},
    {tokenSource:"ANTHROPIC_AUTH_TOKEN"},
    null,
  ];
  for(const account of accounts){
    const {claude,read}=usageCard([{account,usage:NO_PLAN}]);
    assert.deepEqual((await read()).unavailable,{reason:"unsupported"},"not said to be signed out: "+JSON.stringify(account));await read();
    assert.equal(claude.probes.length,1,JSON.stringify(account));
  }
  // First-party account fields cannot show a custom endpoint's sign-in (T3 Code checks ANTHROPIC_BASE_URL the same way).
  for(const [baseUrl,probes,said] of [["https://gateway.example.test/anthropic",1,{reason:"unsupported"}],["https://api.anthropic.com",2,SIGNED_OUT_USAGE],["not a url",2,SIGNED_OUT_USAGE]]){
    const {claude,read}=usageCard([{account:SIGNED_OUT,usage:NO_PLAN}]);
    const input={...MACHINE,env:{...MACHINE.env,ANTHROPIC_BASE_URL:baseUrl}};
    assert.deepEqual((await read(input)).unavailable,said,baseUrl);await read(input);
    assert.equal(claude.probes.length,probes,baseUrl);
  }
});

test("a folder's probe that did not ask for usage is kept for its commands and agents, unless Claude Code answered it signed out",async()=>{
  const folder={...MACHINE,cwd:"/repo",includeUsage:false};
  const signedIn=usageCard([{account:SIGNED_IN}]);
  await signedIn.cache.load(folder);await signedIn.cache.load(folder);
  assert.equal(signedIn.claude.probes.length,1);
  assert.deepEqual(signedIn.cache.peek(folder)?.commands,[{name:"review"}]);
  const signedOut=usageCard([{account:SIGNED_OUT}]);
  await signedOut.cache.load(folder);await signedOut.cache.load(folder);
  assert.equal(signedOut.claude.probes.length,2);
});
