// A Claude Code found signed out forgets its kept capability probe (its account and plan usage, kept five minutes for the model list
// and the Usage card): when the recheck after a failure finds `claude auth status` signed out, and when a turn failed to authenticate
// (an expired or revoked sign-in that `claude auth status` still lists), the next Refresh asks Claude Code again instead of showing
// the old account for up to five minutes more. Stubbed CLI runs and a scripted SDK only: no Claude Code is started or signed in.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { createClaudeCapabilitiesCache } from "../src/claude-capabilities.mjs";
import { scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const SIGNED_IN={email:"person@example.test",subscriptionType:"max",tokenSource:"claude.ai"};
const PLAN={session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:"2026-10-27T05:00:00Z"}}};
// The capability probe's answer for a signed-in account, counted.
function countedCache(){
  const probes=[];
  const cache=createClaudeCapabilitiesCache({probe:async input=>{probes.push(input);return {models:[{value:"default",displayName:"Default"}],commands:[],agents:[],account:SIGNED_IN,usage:PLAN,usageError:null,checkedAt:new Date().toISOString()}}});
  return {cache,probes};
}

test("dropping a Claude Code profile's probes forgets every folder's answer for that executable and Claude home, and only those",async()=>{
  const {cache,probes}=countedCache();
  const profile={command:"claude",env:{CLAUDE_CONFIG_DIR:"/home/a/.claude"},spawnProcess:null,scope:""},other={...profile,env:{CLAUDE_CONFIG_DIR:"/home/b/.claude"}};
  await cache.load({...profile,cwd:null});await cache.load({...profile,cwd:"/repo"});await cache.load({...other,cwd:null});
  assert.equal(probes.length,3);
  cache.drop(profile);
  assert.deepEqual([cache.peek({...profile,cwd:null}),cache.peek({...profile,cwd:"/repo"})],[null,null]);
  assert.ok(cache.peek({...other,cwd:null}),"another Claude home's answer stays");
  await cache.load({...profile,cwd:null});
  assert.equal(probes.length,4,"the next read asks Claude Code again");
});

test("a probe still running when the answers are dropped is shared by its readers but not kept, and its failure does not bring the old answer back",async()=>{
  const probes=[],answer=()=>({models:[],commands:[],agents:[],account:SIGNED_IN,usage:PLAN,usageError:null,checkedAt:new Date().toISOString()});
  const cache=createClaudeCapabilitiesCache({probe:()=>{let settle;const promise=new Promise((resolve,reject)=>{settle={resolve,reject}});probes.push(settle);return promise}});
  const profile={command:"claude",cwd:null,env:{CLAUDE_CONFIG_DIR:"/home/a/.claude"},spawnProcess:null,scope:""};
  const first=cache.load(profile);probes[0].resolve(answer());await first;
  assert.ok(cache.peek(profile),"kept");
  // A Refresh is reading again when the sign-out is found, and that read fails.
  const failing=cache.load(profile,{fresh:true});
  cache.drop(profile);
  assert.equal(cache.peek(profile),null,"the kept answer goes at once");
  assert.equal(cache.load(profile),failing,"the readers share the probe still running");
  probes[1].reject(new Error("Claude Code did not report its capabilities in time."));
  await assert.rejects(failing);
  assert.equal(cache.peek(profile),null,"the answer it was to replace stays gone");
  // A read that started before the sign-out was found answers signed in: it is not kept.
  const running=cache.load(profile);cache.drop(profile);probes[2].resolve(answer());await running;
  assert.equal(cache.peek(profile),null);
  const next=cache.load(profile);
  assert.equal(probes.length,4,"the next read asks Claude Code again");
  probes[3].resolve(answer());await next;
  assert.ok(cache.peek(profile),"a read after the drop is kept");
});

test("a recheck that finds Claude Code signed out drops its kept probe, so the next Usage read asks again, and one still signed in keeps it",async t=>{
  const home=mkdtempSync(join(tmpdir(),"trebell-claude-signed-out-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=join(home,"claude");writeFileSync(binary,"claude build 1");
  let loggedIn=true;
  const runFn=async(_command,args)=>args[0]==="--version"
    ?{ok:true,code:0,error:null,stdout:"2.1.311 (Claude Code)\n",stderr:""}
    :{ok:loggedIn,code:loggedIn?0:1,error:null,stdout:JSON.stringify({loggedIn,authMethod:loggedIn?"claude.ai":"none",apiProvider:"firstParty"}),stderr:""};
  const settings={agentRuntime:"claude",agentRuntimeInstances:[{id:"claude-default",kind:"claude",binaryPath:binary,environment:{}}]};
  const {cache,probes}=countedCache();
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn,claudeCapabilitiesCache:cache});
  assert.equal((await manager.usageLimits("claude")).windows?.length,1);
  await manager.usageLimits("claude");
  assert.equal(probes.length,1,"kept for five minutes");
  // A failed turn's recheck that still finds the account signed in keeps the probe.
  assert.equal((await manager.recheck("claude")).authenticated,true);
  await manager.usageLimits("claude");
  assert.equal(probes.length,1);
  // `claude auth logout` in the person's own terminal; the next failure's recheck finds it.
  loggedIn=false;
  const status=await manager.recheck("claude");
  assert.equal(status.authenticated,false,status.message);
  await manager.usageLimits("claude");
  assert.equal(probes.length,2,"the Usage card asks Claude Code again at once");
});

// The Usage card of a Claude Code profile with a Claude config directory of its own (its homePath, the CLAUDE_CONFIG_DIR its probe ran
// with) found signed out says to run `claude auth login` with that directory set: run as written, it signs in the person's default
// ~/.claude, and the card went on saying signed out. The default profile's names none.
test("the Usage card of a signed-out Claude Code profile with its own Claude config directory says to sign in with it set, and the default profile's names none",async t=>{
  const home=mkdtempSync(join(tmpdir(),"trebell-claude-signed-out-home-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=join(home,"claude"),work=join(home,"claude-work");writeFileSync(binary,"claude build 1");
  const settings={agentRuntime:"claude",agentRuntimeInstances:[{id:"claude-default",kind:"claude",binaryPath:binary,environment:{}},{id:"claude-work",kind:"claude",displayName:"Work",binaryPath:binary,homePath:work,environment:{}}]};
  const homes=[];
  const cache=createClaudeCapabilitiesCache({probe:async input=>{homes.push(input.env?.CLAUDE_CONFIG_DIR||null);return {models:[],commands:[],agents:[],account:{tokenSource:"none",apiProvider:"firstParty"},signedOut:true,usage:null,usageError:null,checkedAt:new Date().toISOString()}}});
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell")},runFn:async()=>({ok:false,code:1,error:null,stdout:"",stderr:""}),claudeCapabilitiesCache:cache});
  const profile=id=>manager.instances().find(item=>item.id===id);
  assert.deepEqual((await manager.usageLimits(profile("claude-work"))).unavailable,{reason:"signedOut",message:`Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login with CLAUDE_CONFIG_DIR set to "${work}", then press Refresh.`});
  assert.equal(homes.at(-1),work,"the probe that found it signed out ran with that directory");
  assert.equal((await manager.usageLimits(profile("claude-default"))).unavailable.message,"Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login, then press Refresh.");
  assert.equal(homes.at(-1),null);
});

test("a Claude turn that failed to authenticate drops the session's kept probes, the machine's and its folder's",async()=>{
  const {cache,probes}=countedCache();
  const env={CLAUDE_CONFIG_DIR:"/home/a/.claude"},machine={command:"claude",cwd:null,env,spawnProcess:null,scope:""};
  await cache.load(machine);
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit({type:"assistant",uuid:"auth",parent_tool_use_id:null,error:"authentication_failed",message:{id:"m-auth",content:[{type:"text",text:"Invalid API key · Please run /login"}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:401,result:"Invalid API key · Please run /login",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
  }});
  const claude=new ClaudeAgentSession({command:"claude",cwd:process.cwd(),env,sdk,capabilities:cache,onUpdate:()=>{}});
  await claude.start();
  for(let round=0;round<20&&probes.length<2;round++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(probes.length,2,"the folder's own probe ran as the session started");
  await assert.rejects(()=>claude.prompt([{type:"text",text:"Hello"}]),/Run `claude auth login`/);
  assert.deepEqual([cache.peek(machine),cache.peek({...machine,cwd:process.cwd()})],[null,null],"both forgotten");
  await claude.close();
});
