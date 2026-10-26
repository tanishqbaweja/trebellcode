// Cursor's usage read asks Cursor's dashboard as Trebell itself: the request carries the person's Cursor login and Connect's
// protocol headers, and no x-cursor-client-type header that would pass Trebell off as the Cursor CLI. A read Cursor refuses
// shows the existing "Cursor could not read usage limits." and is not asked again under another name.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readAgentRuntimeUsage } from "../src/agent-usage-limits.mjs";

function cursorRead(requests,answer){
  return readAgentRuntimeUsage("cursor",{
    environment:{CURSOR_AUTH_TOKEN:"cursor-fixture-token"},platform:"linux",home:"/home/me",joinPath:join,readText:async()=>null,
    fetchImpl:async(url,options)=>{requests.push({url,options});return answer()},
  });
}
const headerNames=request=>Object.keys(request.options.headers).map(name=>name.toLowerCase()).sort();

test("Cursor's usage read goes out without the Cursor CLI's client-type header",async()=>{
  const requests=[];
  const usage=await cursorRead(requests,()=>Response.json({planUsage:{totalPercentUsed:42},billingCycleEnd:"1790000000000"}));
  assert.deepEqual(usage.windows.map(window=>[window.id,window.usedPercent]),[["totalPercentUsed",42]]);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,"https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
  assert.equal(requests[0].options.method,"POST");
  assert.deepEqual(headerNames(requests[0]),["authorization","connect-protocol-version","content-type"],"no x-cursor-client-type: Trebell does not pose as the CLI");
  assert.equal(requests[0].options.headers.authorization,"Bearer cursor-fixture-token");
});

test("a usage read Cursor refuses is a failed probe, asked once and never again under another identity",async()=>{
  for(const status of [401,403,500]){
    const requests=[];
    const usage=await cursorRead(requests,()=>Response.json({error:"needs the CLI"},{status}));
    assert.deepEqual(usage.windows,[]);
    assert.deepEqual(usage.unavailable,{reason:"probeFailed",message:"Cursor could not read usage limits."},String(status));
    assert.equal(requests.length,1,`HTTP ${status} is not retried`);
    assert.deepEqual(headerNames(requests[0]),["authorization","connect-protocol-version","content-type"]);
    assert.doesNotMatch(JSON.stringify(usage),/cursor-fixture-token|needs the CLI/);
  }
});
