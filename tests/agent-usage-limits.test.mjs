import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeUsageResponseToLimits,
  cursorUsageResponseToLimits,
  grokUsageResponseToLimits,
  openCodeUsageResponseToLimits,
  readAgentRuntimeUsage,
  readClaudeUsageLimits,
} from "../src/agent-usage-limits.mjs";

function jsonResponse(value,{status=200}={}){
  return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
}

test("Cursor usage preserves advertised buckets and billing reset",()=>{
  const result=cursorUsageResponseToLimits({billingCycleEnd:"1789876386000",planUsage:{totalPercentUsed:72.4,autoPercentUsed:69.5,apiPercentUsed:150}},"2026-09-23T00:00:00.000Z");
  assert.deepEqual(result.windows.map(item=>[item.id,item.usedPercent]),[["totalPercentUsed",72.4],["autoPercentUsed",69.5],["apiPercentUsed",100]]);
  assert.equal(result.windows[0].kind,"monthly");
  assert.equal(result.windows[0].resetsAt,"2026-09-20T03:53:06.000Z");
});

// Cursor's, Grok Build's and OpenCode Go's usage would be read with the sign-in each keeps for itself (its auth.json, or a token in
// the environment), which Trebell never reads: their meters are unsupported, and no read is made, whatever the environment holds.
test("Cursor's, Grok's and OpenCode Go's meters read no sign-in, file or service, and say why",async()=>{
  for(const [runtime,name] of [["cursor","Cursor"],["grok","Grok Build"],["opencode","OpenCode"]]){
    let asked=0;const touched=()=>{asked++;return null};
    const usage=await readAgentRuntimeUsage(runtime,{name,environment:{CURSOR_AUTH_TOKEN:"private-cursor",GROK_AUTH:"{}",OPENCODE_AUTH_CONTENT:"{}",OPENCODE_API_KEY:"go-secret"},readText:touched,joinPath:touched,fetchImpl:touched});
    assert.equal(asked,0,runtime);assert.deepEqual(usage.windows,[]);
    assert.deepEqual(usage.unavailable,{reason:"unsupported",message:name+" does not report its usage to Trebell Code, which never reads the sign-in "+name+" keeps."});
  }
});

test("Grok usage maps a reported period, clamped",()=>{
  const parsed=grokUsageResponseToLimits({config:{creditUsagePercent:120,currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",end:"2026-09-25T10:00:00Z"}}},"2026-09-23T00:00:00.000Z");
  assert.deepEqual(parsed.windows.map(item=>[item.kind,item.usedPercent]),[["weekly",100]]);
});

test("OpenCode Go usage clamps the windows it maps",()=>{
  const parsed=openCodeUsageResponseToLimits({usage:{
    rolling:{percent:0,resetsAt:"2026-09-23T05:00:00Z"},
    weekly:{percent:10,resetsAt:"2026-09-28T00:00:00Z"},
    monthly:{percent:125,resetsAt:"2026-10-01T00:00:00Z"},
  }},"2026-09-23T00:00:00.000Z");
  assert.deepEqual(parsed.windows.map(item=>[item.kind,item.usedPercent]),[["session",0],["weekly",10],["monthly",100]]);
});

test("Claude usage maps the SDK usage request's session, weekly and model-scoped windows",()=>{
  const at="2026-10-09T20:00:00.000Z";
  const result=claudeUsageResponseToLimits({rate_limits_available:true,rate_limits:{
    five_hour:{utilization:12,resets_at:"2026-10-09T22:59:59Z"},
    seven_day:{utilization:140,resets_at:null},
    model_scoped:[{display_name:"Fable",utilization:0,resets_at:"2026-10-15T00:00:00Z"},{display_name:"Skipped",utilization:null,resets_at:null}],
  }},at);
  assert.deepEqual(result,{checkedAt:at,windows:[
    {id:"five_hour",kind:"session",label:"Session",windowDurationMins:300,usedPercent:12,resetsAt:"2026-10-09T22:59:59.000Z"},
    {id:"seven_day",kind:"weekly",label:"Weekly",windowDurationMins:10080,usedPercent:100},
    {id:"seven_day_fable",kind:"weekly",label:"Weekly · Fable",windowDurationMins:10080,usedPercent:0,resetsAt:"2026-10-15T00:00:00.000Z"},
  ]});
  assert.deepEqual(claudeUsageResponseToLimits({rate_limits_available:false,rate_limits:null},at),{checkedAt:at,windows:[],unavailable:{reason:"unsupported"}});
});

test("Claude usage reads the capability probe and tells a failed read from an account without limits",async()=>{
  const usage={rate_limits_available:true,rate_limits:{five_hour:{utilization:30,resets_at:"2026-10-09T22:59:59Z"}}};
  const read=await readAgentRuntimeUsage("claude",{readCapabilities:async()=>({usage,checkedAt:"2026-10-09T20:00:00.000Z"})});
  assert.deepEqual(read.windows.map(window=>[window.id,window.usedPercent]),[["five_hour",30]]);
  assert.equal(read.checkedAt,"2026-10-09T20:00:00.000Z");
  assert.deepEqual((await readClaudeUsageLimits({readCapabilities:async()=>{throw new Error("spawn failed")}})).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.deepEqual((await readClaudeUsageLimits({readCapabilities:async()=>({usage:null,usageError:"timed out"})})).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.deepEqual((await readClaudeUsageLimits({readCapabilities:async()=>({usage:null})})).unavailable,{reason:"unsupported"});
  assert.deepEqual((await readClaudeUsageLimits()).unavailable,{reason:"unsupported"});
});

// A Claude Code that answered signed out (the probe's signedOut, claude-capabilities.mjs) says so and how to sign in, whatever its
// usage read brought, instead of reading as an account that exposes no limits.
test("Claude usage of a Claude Code that answered signed out says it is signed out and how to sign in",async()=>{
  const signedOut={reason:"signedOut",message:"Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login, then press Refresh."};
  const account={tokenSource:"none",apiProvider:"firstParty"},checkedAt="2026-10-09T20:00:00.000Z";
  assert.deepEqual(await readAgentRuntimeUsage("claude",{readCapabilities:async()=>({account,signedOut:true,usage:{rate_limits_available:false,rate_limits:null},usageError:null,checkedAt})}),{checkedAt,windows:[],unavailable:signedOut});
  assert.deepEqual((await readClaudeUsageLimits({readCapabilities:async()=>({account,signedOut:true,usage:null,usageError:"Claude Code did not report usage in time."})})).unavailable,signedOut);
  // An account without plan limits that is signed in (an API key) still says it exposes none.
  assert.deepEqual((await readClaudeUsageLimits({readCapabilities:async()=>({account:{tokenSource:"none",apiKeySource:"ANTHROPIC_API_KEY"},signedOut:false,usage:{rate_limits_available:false,rate_limits:null}})})).unavailable,{reason:"unsupported"});
});

// A profile with a Claude config directory of its own (configDir, its homePath) signs in there: the command is said with it, as a
// turn's sign-out says it (claudeSignedOutMessage). `claude auth login` run as written in the person's own terminal signs in their
// default ~/.claude, and the card went on saying signed out.
test("Claude usage of a signed-out profile with a Claude config directory of its own says to sign in with it set",async()=>{
  const account={tokenSource:"none",apiProvider:"firstParty"};
  assert.deepEqual((await readClaudeUsageLimits({configDir:"/home/me/.claude-work",readCapabilities:async()=>({account,signedOut:true,usage:null})})).unavailable,{reason:"signedOut",message:"Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login with CLAUDE_CONFIG_DIR set to \"/home/me/.claude-work\", then press Refresh."});
  assert.deepEqual((await readAgentRuntimeUsage("claude",{configDir:" ",readCapabilities:async()=>({account,signedOut:true,usage:null})})).unavailable.message,"Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login, then press Refresh.","a blank one names none");
});
