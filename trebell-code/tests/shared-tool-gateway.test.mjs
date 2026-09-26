import test from "node:test";
import assert from "node:assert/strict";
import { createSharedToolGateway, authorizePlatformToolCall, authorizeSharedToolCall } from "../src/shared-tool-gateway.mjs";
import { POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "../src/policy-engine.mjs";

test("shared tool authorization combines catalog requirements with unified policy",()=>{
  const missingDesktop=authorizeSharedToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only"});
  assert.equal(missingDesktop.decision,POLICY_REJECT);assert.match(missingDesktop.reason,/desktop app/i);assert.equal(missingDesktop.requirementFailed,true);

  const readSnapshot=authorizeSharedToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only",desktopAvailable:true});
  assert.equal(readSnapshot.decision,POLICY_ALLOW);assert.equal(readSnapshot.action.kind,"read");assert.equal(readSnapshot.action.riskLevel,"low");

  const supervisedSnapshot=authorizeSharedToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"supervised",desktopAvailable:true});
  assert.equal(supervisedSnapshot.decision,POLICY_CONFIRM);

  const fullComputer=authorizeSharedToolCall({namespace:"trebell_computer",name:"click",arguments:{x:10,y:20}},{permissionProfile:"full",desktopAvailable:true});
  assert.equal(fullComputer.decision,POLICY_ALLOW);assert.equal(fullComputer.action.externalSideEffect,true);assert.equal(fullComputer.action.riskLevel,"high");

  const guardedComputer=authorizeSharedToolCall({namespace:"trebell_computer",name:"click",arguments:{x:10,y:20}},{permissionProfile:"auto",desktopAvailable:true});
  assert.equal(guardedComputer.decision,POLICY_REJECT);assert.match(guardedComputer.reason,/full access/i);
});

test("project, device, delegation and unknown tool requirements fail closed",()=>{
  const sourceControl=authorizeSharedToolCall({namespace:"trebell_source_control",name:"link_pull_request",arguments:{url:"https://example.test/pr/1"}},{permissionProfile:"full",workspace:"/repo",projectAvailable:false});
  assert.equal(sourceControl.decision,POLICY_REJECT);assert.match(sourceControl.reason,/active project/i);
  const device=authorizeSharedToolCall({namespace:"trebell_device",name:"list",arguments:{}},{permissionProfile:"read-only",deviceAccess:false});
  assert.equal(device.decision,POLICY_REJECT);assert.match(device.reason,/device access is disabled/i);
  const delegation=authorizeSharedToolCall({namespace:"trebell_delegate",name:"delegate",arguments:{task:"test"}},{permissionProfile:"full",workspace:"/repo",projectAvailable:true,delegationAvailable:false});
  assert.equal(delegation.decision,POLICY_REJECT);assert.match(delegation.reason,/delegation is unavailable/i);
  const unknown=authorizeSharedToolCall({namespace:"trebell_browser",name:"teleport",arguments:{}},{permissionProfile:"full",desktopAvailable:true});
  assert.equal(unknown.decision,POLICY_REJECT);assert.match(unknown.reason,/unknown trebell tool/i);
});

test("repository intelligence goes through the same gateway as other Trebell tools",async()=>{
  const authorized=authorizePlatformToolCall({namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}},{permissionProfile:"read-only",workspace:"/repo"});
  assert.equal(authorized.decision,POLICY_ALLOW);assert.equal(authorized.definition.source,"repository");assert.equal(authorized.action.kind,"read");
  const noWorkspace=authorizePlatformToolCall({namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}},{permissionProfile:"full"});
  assert.equal(noWorkspace.decision,POLICY_REJECT);assert.match(noWorkspace.reason,/active workspace/i);
  const calls=[],gateway=createSharedToolGateway({execute:async call=>{calls.push(call);return {matches:["src/session.js"]}}});
  const result=await gateway.invoke({namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}},{permissionProfile:"read-only",workspace:"/repo"});
  assert.equal(result.success,true);assert.equal(calls[0].definition.handler,"searchSymbols");assert.deepEqual(calls[0].arguments,{query:"Session"});
});

test("shared tool gateway never executes rejected or unconfirmed work",async()=>{
  let executions=0;
  const gateway=createSharedToolGateway({execute:async()=>{executions++;return "should not run"}});
  const rejected=await gateway.invoke({namespace:"trebell_computer",name:"click",arguments:{x:1,y:2}},{permissionProfile:"supervised",desktopAvailable:true});
  assert.equal(rejected.success,false);assert.equal(rejected.decision,POLICY_REJECT);assert.equal(executions,0);
  const confirmation=await gateway.invoke({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"supervised",desktopAvailable:true});
  assert.equal(confirmation.success,false);assert.equal(confirmation.decision,POLICY_CONFIRM);assert.equal(confirmation.confirmationRequired,true);assert.equal(executions,0);
});

test("confirmed shared tool work executes once, redacts results, and keeps raw arguments out of trace events",async()=>{
  const secret="gateway-secret-value",events=[],calls=[];
  const gateway=createSharedToolGateway({
    environment:{CUSTOM_TOKEN:secret},
    confirm:async payload=>{assert.equal(payload.authorization.decision,POLICY_CONFIRM);return "approved"},
    execute:async call=>{calls.push(call);return {success:true,content:`result token=${secret}`,authorization:"Bearer "+secret}},
    onEvent:event=>events.push(event),
  });
  const result=await gateway.invoke({namespace:"trebell_browser",name:"snapshot",arguments:{secretPrompt:"do not trace me"}},{permissionProfile:"supervised",desktopAvailable:true});
  assert.equal(result.success,true);assert.equal(calls.length,1);assert.equal(calls[0].definition.name,"snapshot");
  assert.match(result.result.content,/\[redacted\]/);assert.equal(result.result.authorization,"[redacted]");
  const trace=JSON.stringify(events);assert.doesNotMatch(trace,/do not trace me/);assert.doesNotMatch(trace,new RegExp(secret));
  assert.deepEqual(events.map(event=>event.name),["shared_tool.policy","shared_tool.confirmation_requested","shared_tool.confirmation_resolved","shared_tool.started","shared_tool.completed"]);
});

test("explicit user policy rules still override a catalog tool that would otherwise run",async()=>{
  let executed=false;
  const gateway=createSharedToolGateway({execute:async()=>{executed=true;return "ok"}});
  const result=await gateway.invoke({namespace:"trebell_browser",name:"snapshot",arguments:{}},{
    permissionProfile:"full",desktopAvailable:true,rules:[{effect:"REJECT",kind:"read",reason:"No browser reads in this task."}],
  });
  assert.equal(result.success,false);assert.equal(result.decision,POLICY_REJECT);assert.match(result.error,/no browser reads/i);assert.equal(executed,false);
});

test("per-turn tool allowlists reject tools outside the active recipe before execution",async()=>{
  const namespaceAllowed=authorizePlatformToolCall({namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}},{permissionProfile:"read-only",workspace:"/repo",toolAllowlist:["trebell_repo"]});
  assert.equal(namespaceAllowed.decision,POLICY_ALLOW);
  const aliasAllowed=authorizePlatformToolCall({namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}},{permissionProfile:"read-only",workspace:"/repo",toolAllowlist:["repo"]});
  assert.equal(aliasAllowed.decision,POLICY_ALLOW);
  const exactAllowed=authorizePlatformToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only",desktopAvailable:true,toolAllowlist:["trebell_browser/snapshot"]});
  assert.equal(exactAllowed.decision,POLICY_ALLOW);
  const aliasExactAllowed=authorizePlatformToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only",desktopAvailable:true,toolAllowlist:["browser/snapshot"]});assert.equal(aliasExactAllowed.decision,POLICY_ALLOW);
  const wildcardAllowed=authorizePlatformToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only",desktopAvailable:true,toolAllowlist:["trebell_browser/*"]});
  assert.equal(wildcardAllowed.decision,POLICY_ALLOW);
  const blocked=authorizePlatformToolCall({namespace:"trebell_terminal",name:"run",arguments:{command:"npm",args:["test"]}},{permissionProfile:"auto",workspace:"/repo",toolAllowlist:["trebell_repo","trebell_browser/snapshot"]});
  assert.equal(blocked.decision,POLICY_REJECT);assert.match(blocked.reason,/not allowed by the active recipe/i);assert.equal(blocked.requirementFailed,true);
  let executed=false;const gateway=createSharedToolGateway({execute:async()=>{executed=true;return "nope"}});
  const denied=await gateway.invoke({namespace:"trebell_browser",name:"click",arguments:{ref:"x"}},{permissionProfile:"full",desktopAvailable:true,toolAllowlist:["trebell_browser/snapshot"]});
  assert.equal(denied.success,false);assert.equal(denied.decision,POLICY_REJECT);assert.equal(executed,false);
});

test("tool execution failures are normalized and secret-redacted",async()=>{
  const secret="tool-executor-secret";
  const gateway=createSharedToolGateway({environment:{API_TOKEN:secret},execute:async()=>{throw new Error("failed with "+secret)}});
  const result=await gateway.invoke({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"read-only",desktopAvailable:true});
  assert.equal(result.success,false);assert.equal(result.decision,POLICY_ALLOW);assert.doesNotMatch(result.error,new RegExp(secret));assert.match(result.error,/\[redacted\]/);
});

test("Native terminal policy classifies argv content instead of trusting a static medium-risk label",()=>{
  const ordinary=authorizePlatformToolCall({namespace:"trebell_terminal",name:"run",arguments:{command:"npm",args:["test"],cwd:"."}},{permissionProfile:"auto",workspace:"/repo",runtime:"native"});
  assert.equal(ordinary.decision,POLICY_ALLOW);assert.equal(ordinary.action.riskLevel,"medium");
  const push=authorizePlatformToolCall({namespace:"trebell_terminal",name:"run",arguments:{command:"git",args:["push","origin","main"],cwd:"."}},{permissionProfile:"auto",workspace:"/repo",runtime:"native"});
  assert.equal(push.decision,POLICY_CONFIRM);assert.equal(push.action.externalSideEffect,true);assert.equal(push.action.riskLevel,"high");
  const backgroundPush=authorizePlatformToolCall({namespace:"trebell_terminal",name:"start_background",arguments:{command:"git",args:["push","origin","main"],cwd:"."}},{permissionProfile:"auto",workspace:"/repo",runtime:"native"});
  assert.equal(backgroundPush.decision,POLICY_CONFIRM);assert.equal(backgroundPush.action.externalSideEffect,true);assert.equal(backgroundPush.action.riskLevel,"high");
  const destructive=authorizePlatformToolCall({namespace:"trebell_terminal",name:"run",arguments:{command:"rm",args:["-rf","dist"],cwd:"."}},{permissionProfile:"auto",workspace:"/repo",runtime:"native"});
  assert.equal(destructive.decision,POLICY_REJECT);assert.equal(destructive.action.riskLevel,"critical");
  const readOnly=authorizePlatformToolCall({namespace:"trebell_terminal",name:"run",arguments:{command:"npm",args:["test"],cwd:"."}},{permissionProfile:"read-only",workspace:"/repo",runtime:"native"});assert.equal(readOnly.decision,POLICY_REJECT);
});

test("Native source-control policy keeps reads cheap and remote writes explicit",()=>{
  const status=authorizePlatformToolCall({namespace:"trebell_source_control",name:"status",arguments:{}},{permissionProfile:"read-only",workspace:"/repo",projectAvailable:true,runtime:"native"});
  assert.equal(status.decision,POLICY_ALLOW);assert.equal(status.action.riskLevel,"low");
  const commit=authorizePlatformToolCall({namespace:"trebell_source_control",name:"commit_all",arguments:{message:"local change"}},{permissionProfile:"auto",workspace:"/repo",projectAvailable:true,runtime:"native"});
  assert.equal(commit.decision,POLICY_ALLOW);assert.equal(commit.action.externalSideEffect,false);
  const push=authorizePlatformToolCall({namespace:"trebell_source_control",name:"push",arguments:{set_upstream:true}},{permissionProfile:"auto",workspace:"/repo",projectAvailable:true,runtime:"native"});
  assert.equal(push.decision,POLICY_CONFIRM);assert.equal(push.action.externalSideEffect,true);assert.equal(push.action.reversibility,"none");
  const readOnlyCommit=authorizePlatformToolCall({namespace:"trebell_source_control",name:"commit_all",arguments:{message:"nope"}},{permissionProfile:"read-only",workspace:"/repo",projectAvailable:true,runtime:"native"});assert.equal(readOnlyCommit.decision,POLICY_REJECT);
});

test("interactive browser actions are treated as external side effects",()=>{
  const snapshot=authorizePlatformToolCall({namespace:"trebell_browser",name:"snapshot",arguments:{}},{permissionProfile:"auto",desktopAvailable:true,runtime:"native"});assert.equal(snapshot.decision,POLICY_ALLOW);assert.equal(snapshot.action.externalSideEffect,false);
  const click=authorizePlatformToolCall({namespace:"trebell_browser",name:"click",arguments:{ref:"button-1"}},{permissionProfile:"auto",desktopAvailable:true,runtime:"native"});assert.equal(click.decision,POLICY_CONFIRM);assert.equal(click.action.externalSideEffect,true);
  const type=authorizePlatformToolCall({namespace:"trebell_browser",name:"type",arguments:{ref:"input-1",text:"hello"}},{permissionProfile:"read-only",desktopAvailable:true,runtime:"native"});assert.equal(type.decision,POLICY_REJECT);assert.equal(type.action.externalSideEffect,true);
});
