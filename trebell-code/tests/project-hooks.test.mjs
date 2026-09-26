import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectHook, normalizeProjectHooks, projectHookMatches, runProjectHooks, verificationHookSteps } from "../src/project-hooks.mjs";

test("project hooks normalize bounded lifecycle policy without executable defaults",()=>{
  assert.deepEqual(normalizeProjectHook({id:"lint",name:"Lint gate",event:"verification.required",command:"npm run lint",timeoutMs:999999,actions:["push"]}),{id:"lint",name:"Lint gate",event:"verification.required",command:"npm run lint",enabled:true,failureMode:"block",timeoutMs:300000,actions:[]});
  assert.deepEqual(normalizeProjectHook({event:"source-control.after",command:"echo done",failureMode:"block",actions:["push","push","git.commit"]}),{id:null,name:"Hook 1",event:"source-control.after",command:"echo done",enabled:true,failureMode:"warn",timeoutMs:30000,actions:["push","git.commit"]});
  assert.throws(()=>normalizeProjectHook({event:"tool.before",command:"echo nope"}),/unsupported project hook event/i);
  assert.throws(()=>normalizeProjectHook({event:"source-control.before"}),/command is required/i);
  assert.equal(normalizeProjectHooks([{id:"same",event:"source-control.before",command:"one"},{id:"same",event:"source-control.before",command:"two"}]).length,1);
});

test("verification hooks become stable required command evidence steps",()=>{
  const steps=verificationHookSteps([
    {id:"lint-hook",name:"Lint",event:"verification.required",command:"npm run lint"},
    {id:"after",name:"After push",event:"source-control.after",command:"echo done"},
  ]);
  assert.deepEqual(steps,[{id:"project_hook_lint_hook",kind:"command",scope:"project",required:true,cost:"medium",command:"npm run lint",reason:"Required project hook: Lint",hookId:"lint-hook",hookName:"Lint"}]);
});

test("source-control hooks filter actions and blocking failures stop before mutation",async()=>{
  const hooks=[
    {id:"warn",name:"Warn only",event:"source-control.before",command:"warn",failureMode:"warn",actions:["push"]},
    {id:"block",name:"Block push",event:"source-control.before",command:"block",failureMode:"block",actions:["push"]},
    {id:"other",name:"Commit only",event:"source-control.before",command:"commit",actions:["git.commit"]},
  ];
  assert.equal(projectHookMatches(normalizeProjectHook(hooks[2],2),{event:"source-control.before",action:"push"}),false);
  assert.equal(projectHookMatches(normalizeProjectHook({event:"source-control.before",command:"gate",actions:["push"]}),{event:"source-control.before",action:"git.push"}),true);
  const events=[];await assert.rejects(()=>runProjectHooks({hooks,event:"source-control.before",action:"push",execute:async hook=>({exitCode:hook.id==="warn"?3:hook.id==="block"?2:0,durationMs:4}),onEvent:event=>events.push(event)}),/Block push exited with code 2/);
  assert.deepEqual(events.filter(event=>event.phase==="started").map(event=>event.hook.id),["warn","block"]);
  assert.equal(events.some(event=>event.hook.id==="other"),false);
});

test("after-source-control hook failures are warnings and never expose command output",async()=>{
  const result=await runProjectHooks({hooks:[{id:"notify",name:"Notify",event:"source-control.after",command:"echo secret",failureMode:"block"}],event:"source-control.after",action:"push",execute:async()=>({exitCode:7,stdout:"TOP_SECRET",stderr:"PRIVATE"})});
  assert.deepEqual(result,[{hookId:"notify",name:"Notify",event:"source-control.after",action:"push",status:"failed",exitCode:7,timedOut:false,durationMs:0,failureMode:"warn"}]);
  assert.doesNotMatch(JSON.stringify(result),/TOP_SECRET|PRIVATE/);
});
