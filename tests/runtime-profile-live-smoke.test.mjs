import test from "node:test";
import assert from "node:assert/strict";
import { probeCompatibleRuntimeProfiles,publicRuntimeProfileSmokeResult } from "../src/runtime-profile-live-smoke.mjs";

test("runtime profile smoke selects an available continuation-compatible pair without exposing profile paths",async()=>{
  const instances=[
    {id:"claude-a",kind:"claude",displayName:"Work",homePath:"/private/work",enabled:true},
    {id:"claude-b",kind:"claude",displayName:"Router",homePath:"/private/work",enabled:true},
    {id:"claude-c",kind:"claude",displayName:"Personal",homePath:"/private/personal",enabled:true},
  ],runtimeManager={
    instances:()=>instances,
    compatibleInstanceIds:source=>source.homePath==="/private/work"?["claude-a","claude-b"]:["claude-c"],
    probe:async instance=>({available:true,authenticated:instance.id!=="claude-c",version:"1.2.3",message:"PRIVATE PATH "+instance.homePath}),
  };
  const result=await probeCompatibleRuntimeProfiles({runtimeManager,runtime:"claude"});assert.deepEqual(result.compatiblePair,{sourceId:"claude-a",targetId:"claude-b"});
  const publicResult=publicRuntimeProfileSmokeResult(result,{switched:true,fromInstanceId:"claude-a",toInstanceId:"claude-b"});assert.equal(publicResult.inferenceTurns,0);assert.equal(publicResult.switched,true);assert.doesNotMatch(JSON.stringify(publicResult),/private\/work|private\/personal|PRIVATE PATH/);
});

test("runtime profile smoke reports a clean skip when no compatible pair exists",async()=>{
  const runtimeManager={instances:()=>[{id:"only",kind:"claude",enabled:true}],compatibleInstanceIds:()=>["only"],probe:async()=>({available:true,authenticated:true,version:"1"})};
  const result=await probeCompatibleRuntimeProfiles({runtimeManager,runtime:"claude"});assert.equal(result.compatiblePair,null);assert.match(result.skipReason,/fewer than two/i);assert.equal(publicRuntimeProfileSmokeResult(result).inferenceTurns,0);
});
