import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { museCardButtons, museChoiceDecision, museDecisionChoices, museDecisionToSend } from "../src/muse-asking.mjs";

// Muse Code's approval choices as Trebell's answers, word by word and scope by scope, against the decision words and scopes Meta's
// SDK declares (@muse-code/sdk's bundled MSP declarations), so an SDK that adds one fails here until Trebell reads it.

const sdkTypes=readFileSync(join(dirname(createRequire(import.meta.url).resolve("@muse-code/sdk/package.json")),"dist/src/msp.d.ts"),"utf8");
function declared(typeName){
  const line=sdkTypes.split("\n").find(row=>row.startsWith(`export type ${typeName} =`));
  assert.ok(line,`the SDK declares ${typeName}`);
  return [...line.matchAll(/"([^"]+)"/g)].map(match=>match[1]);
}

// What each word and scope is read as: [once, session, localPersistent, a scope Muse may add later, no scope].
const READ_AS={
  approved:["accept","acceptForSession","acceptAlways",null,null],
  approvedForSession:["acceptForSession","acceptForSession","acceptAlways",null,null],
  approvedPolicyAmendment:[null,"acceptForSession","acceptAlways",null,null],
  denied:["decline","declineForSession","declineAlways",null,null],
  deniedPolicyAmendment:[null,"declineForSession","declineAlways",null,null],
  timedOut:[null,null,null,null,null],
  abort:["cancel",null,null,null,null],
};
const SCOPES=["once","session","localPersistent","workspaceRoot",undefined];

test("every decision word and scope Meta's SDK declares has its reading here",()=>{
  assert.deepEqual(declared("ApprovalDecision").sort(),Object.keys(READ_AS).sort());
  assert.deepEqual(declared("ApprovalChoiceScope").sort(),SCOPES.slice(0,3).sort());
});

test("each word and scope is read as one of Trebell's answers, or as none when Trebell cannot say what picking it would do",()=>{
  for(const [word,answers] of Object.entries(READ_AS)){
    SCOPES.forEach((scope,at)=>{
      const choice={choiceId:"c",label:"Choice",decision:word,...(scope===undefined?{}:{scope})};
      assert.equal(museChoiceDecision(choice),answers[at],`${word} ${scope}`);
      assert.deepEqual([...museDecisionChoices([choice]).keys()],answers[at]===null?[]:answers[at]==="cancel"?["cancel","decline"]:[answers[at]],`${word} ${scope}`);
    });
  }
  assert.equal(museChoiceDecision({choiceId:"c",decision:"approvedLater",scope:"once"}),null,"a word Muse adds later");
  assert.equal(museChoiceDecision(null),null);
});

test("an answer for a single request never takes a choice whose word or scope says it lasts longer",()=>{
  for(const word of Object.keys(READ_AS))for(const scope of SCOPES){
    const answer=museChoiceDecision({choiceId:"c",decision:word,scope});
    if(answer==="accept"||answer==="decline"||answer==="cancel")assert.equal(scope,"once",`${word} ${scope} is ${answer}`);
  }
});

test("of several choices for one answer the one that leaves least behind is kept, and the answer keeps the place its first choice had",()=>{
  const saved=museDecisionChoices([
    {choiceId:"rule",label:"Always allow in this workspace: npm ...",decision:"approvedPolicyAmendment",scope:"localPersistent"},
    {choiceId:"deny",label:"Reject",decision:"denied",scope:"once"},
    {choiceId:"plain",label:"Always allow",decision:"approved",scope:"localPersistent"},
  ]);
  assert.deepEqual([...saved].map(([answer,choice])=>[answer,choice.choiceId]),[["acceptAlways","plain"],["decline","deny"]]);
  const session=museDecisionChoices([
    {choiceId:"rule",decision:"approvedPolicyAmendment",scope:"session"},
    {choiceId:"grant",decision:"approvedForSession",scope:"session"},
    {choiceId:"plain",decision:"approved",scope:"session"},
    {choiceId:"grant-2",decision:"approvedForSession",scope:"once"},
  ]);
  assert.equal(session.get("acceptForSession").choiceId,"plain","nothing left behind before a session grant before a rule");
  assert.deepEqual([...session.keys()],["acceptForSession"]);
});

test("Muse's own choice sets: each choice keeps its words on the card, and a rule is never the Reject",()=>{
  // Choice ids and labels Muse Code 1.4.13 carries for tool approvals, each with the word and scope its label describes.
  const network=[
    {choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},
    {choiceId:"allow_session",label:"Allow for this session",decision:"approvedForSession",scope:"session"},
    {choiceId:"allow_local_network",label:"Always allow this network destination",decision:"approvedPolicyAmendment",scope:"localPersistent"},
    {choiceId:"abort",label:"Reject",decision:"abort",scope:"once",acceptsFeedback:true},
  ];
  // Each button: Muse's words, then the answer Trebell sends when it is pressed.
  assert.deepEqual(museCardButtons(network),[
    {label:"Allow once",decision:"accept"},
    {label:"Allow for this session",decision:"acceptForSession"},
    {label:"Always allow this network destination",decision:"acceptAlways"},
    {label:"Reject",decision:"decline"},
  ]);
  const app=[
    {choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},
    {choiceId:"deny_computer_use_app",label:"Always deny this app",decision:"deniedPolicyAmendment",scope:"localPersistent"},
    {choiceId:"abort",label:"Reject",decision:"abort",scope:"once"},
  ];
  const offered=museDecisionChoices(app);
  assert.deepEqual([offered.get("decline").choiceId,offered.get("declineAlways").choiceId,offered.get("cancel").choiceId],["abort","deny_computer_use_app","abort"]);
  assert.equal(museDecisionChoices(app.slice(0,2)).has("decline"),false,"with no abort, nothing is the Reject");
});

test("a denial for the session is a button of its own and not the Reject, and a stop that would last is never offered",()=>{
  const choices=[
    {choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},
    {choiceId:"deny_session",label:"Reject for this session",decision:"denied",scope:"session"},
    {choiceId:"abort",label:"Reject",decision:"abort",scope:"once"},
  ];
  assert.deepEqual(museCardButtons(choices),[{label:"Allow once",decision:"accept"},{label:"Reject for this session",decision:"declineForSession"},{label:"Reject",decision:"decline"}]);
  assert.equal(museDecisionChoices(choices).get("decline").choiceId,"abort");
  assert.deepEqual([...museDecisionChoices([{choiceId:"x",label:"Stop",decision:"abort",scope:"session"}]).keys()],[]);
  assert.deepEqual([...museDecisionChoices([{choiceId:"t",label:"Timed out",decision:"timedOut",scope:"once"}]).keys()],[]);
  assert.deepEqual(museCardButtons("not a list"),[]);
});

test("what Trebell sends: each of its answers as given, a stop as the Reject when Muse offers no abort, anything else as the Reject",()=>{
  const offered=museDecisionChoices([{choiceId:"allow_once",decision:"approved",scope:"once"},{choiceId:"deny",decision:"denied",scope:"once"}]);
  for(const answer of ["accept","acceptForSession","acceptAlways","decline","declineForSession","declineAlways"])assert.equal(museDecisionToSend(answer,offered),answer);
  assert.equal(museDecisionToSend("cancel",offered),"decline");
  assert.equal(museDecisionToSend("cancel",museDecisionChoices([{choiceId:"abort",decision:"abort",scope:"once"}])),"cancel");
  for(const other of ["approved","abort","",undefined,"acceptOnce"])assert.equal(museDecisionToSend(other,offered),"decline",String(other));
});

test("each answer keeps Muse's own choice, and its button shows Muse's words without the space around them or, when blank, the answer's name",()=>{
  const once={choiceId:"allow_once",label:"\tAllow once \n",decision:"approved",scope:"once"},blank={choiceId:"deny",label:"   ",decision:"denied",scope:"once"};
  const offered=museDecisionChoices([once,blank]);
  assert.equal(offered.get("accept"),once,"the same object Muse sent, so its id goes back as it came");
  assert.equal(offered.get("decline"),blank);
  assert.deepEqual(museCardButtons([once,blank]),[{label:"Allow once",decision:"accept"},{label:"decline",decision:"decline"}]);
  for(const notAList of [undefined,null,"allow_once",{0:once,length:1}])assert.equal(museDecisionChoices(notAList).size,0,String(notAList));
});
