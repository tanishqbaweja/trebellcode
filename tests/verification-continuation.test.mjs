import test from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS, verificationCheckNotApproved, verificationContinuationAttempt, verificationContinuationChainState, verificationContinuationContext, verificationContinuationPrompt, verificationContinuationRefusal, verificationContinuationState } from "../src/verification-continuation.mjs";
import { MAX_AUTOMATIC_VERIFICATION_ACTIONS, verificationAutomationAttempt, verificationAutomationChainState } from "../src/verification-automation.mjs";

const plan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",scope:"changed",cost:"low",required:true,reason:"Check syntax"},{id:"tests",kind:"tests",scope:"affected",cost:"medium",required:true,command:"npm test",reason:"Run tests"}]};

test("verification continuation selects and sanitizes the next missing step",()=>{
  const record={id:"v1",turnId:"user-turn",plan,evidence:[{stepId:"diagnostics",status:"passed",rawOutput:"SECRET"}],assessment:{risk:"medium"}},state=verificationContinuationState([record]);
  assert.equal(state.nextAction.action,"verify");assert.equal(state.nextAction.nextStep.id,"tests");const context=verificationContinuationContext(state);assert.match(context,/npm test/);assert.match(context,/next required verification step/i);assert.doesNotMatch(context,/SECRET/);assert.match(verificationContinuationPrompt(),/stop after that step/i);
});

test("automatic verification continuations and the shared verification automation chain are bounded",()=>{
  let chain=null,record={id:"v1",turnId:"user-turn"};
  for(let index=1;index<=MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS;index++){const attempt=verificationContinuationAttempt(chain,record,{automatic:true});assert.equal(attempt.allowed,true);const turn=`verify-${index}`;chain=verificationContinuationChainState(attempt,turn);record={id:`v${index+1}`,turnId:turn}}
  assert.equal(verificationContinuationAttempt(chain,record,{automatic:true}).allowed,false);
  let global=null,current={id:"g1",turnId:"user-turn"};for(let index=1;index<=MAX_AUTOMATIC_VERIFICATION_ACTIONS;index++){const attempt=verificationAutomationAttempt(global,current,{automatic:true,action:index%2?"verify":"repair"});assert.equal(attempt.allowed,true);const turn=`auto-${index}`;global=verificationAutomationChainState(attempt,turn);current={id:`g${index+1}`,turnId:turn}}
  assert.equal(verificationAutomationAttempt(global,current,{automatic:true,action:"verify"}).allowed,false);
});

test("an automatic check turn runs once per step of its chain: a step its check turn left unchecked starts no other by itself",()=>{
  // Each check turn's reading is a record of its own (v1 for the person's turn, v2 for the check turn's), on the same step.
  const first=verificationContinuationAttempt(null,{id:"v1",turnId:"user-turn"},{automatic:true,stepId:"focused_behavior"});
  assert.equal(first.allowed,true);assert.deepEqual(first.stepIds,["focused_behavior"]);
  const chain=verificationContinuationChainState(first,"check-1");assert.deepEqual(chain.stepIds,["focused_behavior"]);
  const again=verificationContinuationAttempt(chain,{id:"v2",turnId:"check-1"},{automatic:true,stepId:"focused_behavior"});
  assert.equal(again.allowed,false);assert.equal(again.stopped,"repeated");assert.equal(verificationContinuationRefusal(again),"That check already had a turn of its own.");
  // The plan's next step gets its own check turn, and the person can always ask for the same one again.
  const next=verificationContinuationAttempt(chain,{id:"v2",turnId:"check-1"},{automatic:true,stepId:"project_tests"});assert.equal(next.allowed,true);assert.deepEqual(next.stepIds,["focused_behavior","project_tests"]);assert.equal(next.rootRecordId,"v1");
  assert.equal(verificationContinuationAttempt(chain,{id:"v2",turnId:"check-1"},{automatic:false,stepId:"focused_behavior"}).allowed,true);
  // A later turn of the person's own starts a chain of its own.
  assert.equal(verificationContinuationAttempt(chain,{id:"v3",turnId:"user-turn-2"},{automatic:true,stepId:"focused_behavior"}).allowed,true);
});

test("a check the person did not allow starts no further automatic check turn",()=>{
  const first=verificationContinuationAttempt(null,{id:"v1",turnId:"user-turn"},{automatic:true,stepId:"focused_behavior"});
  const chain={...verificationContinuationChainState(first,"check-1"),stopped:"not-approved"};
  for(const stepId of ["focused_behavior","project_tests"]){
    const attempt=verificationContinuationAttempt(chain,{id:"v2",turnId:"check-1"},{automatic:true,stepId});
    assert.equal(attempt.allowed,false);assert.equal(attempt.stopped,"not-approved");assert.equal(verificationContinuationRefusal(attempt),"The last check was not allowed to run.");
  }
  assert.equal(verificationContinuationAttempt(chain,{id:"v2",turnId:"check-1"},{automatic:false,stepId:"focused_behavior"}).allowed,true);
});

test("a check turn whose check was denied or never answered reads as not approved, whatever the harness",()=>{
  const output={success:false,error:"Tool execution was not approved.",decision:"CONFIRM",confirmationRequired:true,uncertain:false,retrySafe:false};
  const native={type:"dynamicToolCall",namespace:"trebell_terminal",tool:"run",status:"failed",rawOutput:output};
  assert.equal(verificationCheckNotApproved({turnItems:[native]}),true);
  // A stored item may keep the output only as its content's text.
  assert.equal(verificationCheckNotApproved({turnItems:[{...native,rawOutput:undefined,contentItems:[{type:"inputText",text:JSON.stringify(output)}]}]}),true);
  // An ask that expired unanswered fails the same way, without a run.
  assert.equal(verificationCheckNotApproved({turnItems:[{...native,rawOutput:{success:false,error:"No answer came in time.",decision:"CONFIRM",confirmationRequired:false}}]}),true);
  assert.equal(verificationCheckNotApproved({turnItems:[{type:"commandExecution",command:"npm test",status:"declined"}]}),true);
  assert.equal(verificationCheckNotApproved({traces:[{name:"permission.resolved",status:"decline"}]}),true);
  assert.equal(verificationCheckNotApproved({traces:[{name:"item/completed",data:{item:{type:"commandExecution",status:"declined"}}}]}),true);
  // An allowed check that ran, also one that failed or timed out on its own, is not.
  assert.equal(verificationCheckNotApproved({turnItems:[{...native,status:"completed",rawOutput:{success:true,exitCode:0,stdout:"ok"}}]}),false);
  assert.equal(verificationCheckNotApproved({turnItems:[{...native,rawOutput:{success:false,exitCode:1,timedOut:true,signal:"SIGKILL"}}]}),false);
  assert.equal(verificationCheckNotApproved({traces:[{name:"permission.resolved",status:"accept"}]}),false);
  assert.equal(verificationCheckNotApproved({}),false);
});
