import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  cursorUsageResponseToLimits,
  grokUsageResponseToLimits,
  openCodeUsageResponseToLimits,
  readCursorUsageLimits,
  readGrokUsageLimits,
  readOpenCodeUsageLimits,
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

test("Cursor usage uses the matching CLI token and never exposes it in failures",async()=>{
  let request=null;
  const success=await readCursorUsageLimits({
    environment:{CURSOR_AUTH_TOKEN:"private-cursor"},
    home:"/home/me",joinPath:join,readText:async()=>null,
    fetchImpl:async(url,options)=>{request={url,options};return jsonResponse({planUsage:{totalPercentUsed:42}})},
  });
  assert.equal(success.windows[0].usedPercent,42);
  assert.equal(request.options.headers.authorization,"Bearer private-cursor");
  const failure=await readCursorUsageLimits({
    environment:{CURSOR_AUTH_TOKEN:"private-cursor"},
    home:"/home/me",joinPath:join,readText:async()=>null,
    fetchImpl:async()=>jsonResponse({secret:"do not show"},{status:401}),
  });
  assert.equal(failure.unavailable.reason,"probeFailed");
  assert.doesNotMatch(JSON.stringify(failure),/private-cursor|do not show/);
});

test("Grok usage keeps API-key and custom deployment accounts separate from CLI subscription login",async()=>{
  assert.equal((await readGrokUsageLimits({environment:{XAI_API_KEY:"different-account"},home:"/home/me",joinPath:join,readText:async()=>null})).unavailable.reason,"unsupported");
  const parsed=grokUsageResponseToLimits({config:{creditUsagePercent:120,currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",end:"2026-09-25T10:00:00Z"}}},"2026-09-23T00:00:00.000Z");
  assert.deepEqual(parsed.windows.map(item=>[item.kind,item.usedPercent]),[["weekly",100]]);
  let authorization="";
  const usage=await readGrokUsageLimits({
    environment:{GROK_AUTH:JSON.stringify({"https://accounts.x.ai/sign-in":{key:"grok-secret"}})},
    home:"/home/me",joinPath:join,readText:async()=>null,
    fetchImpl:async(_url,options)=>{authorization=options.headers.authorization;return jsonResponse({config:{creditUsagePercent:37}})},
  });
  assert.equal(authorization,"Bearer grok-secret");
  assert.equal(usage.windows[0].usedPercent,37);
});

test("OpenCode Go usage distinguishes no entitlement from failed probes and clamps windows",async()=>{
  const parsed=openCodeUsageResponseToLimits({usage:{
    rolling:{percent:0,resetsAt:"2026-09-23T05:00:00Z"},
    weekly:{percent:10,resetsAt:"2026-09-28T00:00:00Z"},
    monthly:{percent:125,resetsAt:"2026-10-01T00:00:00Z"},
  }},"2026-09-23T00:00:00.000Z");
  assert.deepEqual(parsed.windows.map(item=>[item.kind,item.usedPercent]),[["session",0],["weekly",10],["monthly",100]]);
  const unsupported=await readOpenCodeUsageLimits({
    environment:{OPENCODE_AUTH_CONTENT:JSON.stringify({"opencode-go":{type:"api",key:"go-secret"}})},
    home:"/home/me",joinPath:join,readText:async()=>null,fetchImpl:async()=>jsonResponse({}, {status:403}),
  });
  assert.equal(unsupported.unavailable.reason,"unsupported");
  const failed=await readOpenCodeUsageLimits({
    environment:{OPENCODE_AUTH_CONTENT:JSON.stringify({"opencode-go":{type:"api",key:"go-secret"}})},
    home:"/home/me",joinPath:join,readText:async()=>null,fetchImpl:async()=>jsonResponse({}, {status:500}),
  });
  assert.equal(failed.unavailable.reason,"probeFailed");
  assert.doesNotMatch(JSON.stringify(failed),/go-secret/);
});
