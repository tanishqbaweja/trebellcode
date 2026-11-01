// An ACP harness's permission request on the approval card: each button is one of the harness's own options, under the name the
// harness gave it and in the harness's order, answering with what the option's kind means (allow_once accepts once, allow_always
// accepts for the session, reject_once declines), then Trebell's "Cancel this request". The answer picks back the very option the
// button named. Trebell has words only for an option without a name, and keeps Antigravity's security warning to 400 characters.
// Re-pinned on purpose: Grok's and Antigravity's buttons were fixed labels in a fixed order (Grok's cancel first), other harnesses'
// came in one fixed order, options without names read otherwise, and the warning was cut at 512 characters. The last button
// read "Stop the turn" for a while; it is now named for what it does, cancel this one request, since it sends no session/cancel.
import test from "node:test";
import assert from "node:assert/strict";
import { acpApprovalOptions, acpDecisionOption } from "../src/acp-agent-session.mjs";

// An option as a harness sends it; name and _meta only when given.
const option=(kind,optionId,name,meta)=>({kind,optionId,...(name===undefined?{}:{name}),...(meta===undefined?{}:{_meta:meta})});
const shown=buttons=>buttons.map(({decision,label})=>`${label} -> ${decision}`);
// What each button would send back to the harness, by the decision it answers with.
const picks=(runtime,options)=>acpApprovalOptions(runtime,options).map(button=>[button.label,acpDecisionOption(runtime,options,button.decision)]);

test("each button shows an option's own name in the harness's order, its kind decides the decision, and the answer picks that option",()=>{
  const offered=[option("reject_once","nope","Not this one"),option("allow_once","yes-once","  Go ahead  "),option("allow_always","yes-always","Keep allowing reads")];
  for(const runtime of ["cursor","opencode","antigravity","fixture",undefined]){
    assert.deepEqual(shown(acpApprovalOptions(runtime,offered)),["Not this one -> decline","Go ahead -> accept","Keep allowing reads -> acceptForSession","Cancel this request -> cancel"],String(runtime));
    assert.deepEqual(picks(runtime,offered),[["Not this one","nope"],["Go ahead","yes-once"],["Keep allowing reads","yes-always"],["Cancel this request",null]],String(runtime));
  }
  // The same kinds in another order make the same buttons in that order.
  const reordered=[offered[2],offered[0],offered[1]];
  assert.deepEqual(shown(acpApprovalOptions("cursor",reordered)),["Keep allowing reads -> acceptForSession","Not this one -> decline","Go ahead -> accept","Cancel this request -> cancel"]);
  // Cursor's documented ids, as its ACP page lists them, answered with the id each option came with.
  const cursor=[option("allow_once","allow-once","Allow once"),option("allow_always","allow-always","Always allow"),option("reject_once","reject-once","Reject")];
  assert.deepEqual(picks("cursor",cursor),[["Allow once","allow-once"],["Always allow","allow-always"],["Reject","reject-once"],["Cancel this request",null]]);
});

test("an option without a name reads in Trebell's words, and one Trebell cannot answer with is not a button",()=>{
  const nameless=[option("allow_once","a"),option("allow_always","b","   "),option("reject_once","c",null)];
  assert.deepEqual(shown(acpApprovalOptions("opencode",nameless)),["Allow this time -> accept","Allow and remember -> acceptForSession","Don't allow -> decline","Cancel this request -> cancel"]);
  // No id, a remembered refusal, an unknown kind and a second option of a decision already shown: none is a button.
  const mixed=[option("allow_once","  ","No id"),option("reject_always","never","Never"),option("ask_later","later","Later"),
    option("allow_once","first","First"),option("allow_once","second","Second"),option("toString","proto","Inherited name")];
  assert.deepEqual(shown(acpApprovalOptions("cursor",mixed)),["First -> accept","Cancel this request -> cancel"]);
  assert.equal(acpDecisionOption("cursor",mixed,"accept"),"first","the first option of a decision is the one its button picks");
  assert.equal(acpDecisionOption("cursor",mixed,"decline"),null,"a remembered refusal is never sent for a decline");
  for(const none of [null,undefined,[],"not a list",[null,7,"x"]])assert.deepEqual(shown(acpApprovalOptions("grok",none)),["Cancel this request -> cancel"],JSON.stringify(none));
  // A session answer with no session option is answered once; Trebell's stop and unknown decisions pick nothing.
  assert.equal(acpDecisionOption("cursor",[option("allow_once","once"),option("reject_once","no")],"acceptForSession"),"once");
  for(const decision of ["cancel","acceptAlways","",undefined])assert.equal(acpDecisionOption("cursor",nameless,decision),decision===undefined?"c":null,String(decision));
});

test("Grok's always answers that it keeps for the project are never buttons, and its edits-for-this-session option is its session answer",()=>{
  const grok=[option("allow_once","allow-once","Allow once"),option("allow_always","always-allow","Enable always-approve mode"),
    option("allow_always"," allow-edits-session ","Yes, allow all edits during this session"),option("allow_always","allow-always-command","Always allow: npm test"),option("reject_once","reject-once","Reject once")];
  assert.deepEqual(shown(acpApprovalOptions("grok",grok)),["Allow once -> accept","Yes, allow all edits during this session -> acceptForSession","Reject once -> decline","Cancel this request -> cancel"]);
  assert.deepEqual(picks("grok",grok),[["Allow once","allow-once"],["Yes, allow all edits during this session"," allow-edits-session "],["Reject once","reject-once"],["Cancel this request",null]],"the id goes back as Grok sent it");
  const projectOnly=grok.filter(entry=>entry.optionId!==" allow-edits-session ");
  assert.deepEqual(shown(acpApprovalOptions("grok",projectOnly)),["Allow once -> accept","Reject once -> decline","Cancel this request -> cancel"]);
  assert.equal(acpDecisionOption("grok",projectOnly,"acceptForSession"),"allow-once","a session answer never sends an answer Grok keeps for the project");
  // Only Grok keeps them: another harness's first always answer is its session answer.
  assert.equal(acpDecisionOption("cursor",grok,"acceptForSession"),"always-allow");
});

test("Antigravity's security warning goes with the option that carries it, and a long one ends after a whole word within 400 characters",()=>{
  const warned=note=>acpApprovalOptions("antigravity",[option("allow_once","once","Allow once"),option("allow_always","always","Allow for this conversation",{"agy.security.warning":note})])
    .find(button=>button.decision==="acceptForSession");
  assert.equal(warned({title:"  Runs any command  "}).warning,"Runs any command","the title when there is no message");
  assert.equal(warned({title:"Careful",message:" Every command in this thread runs unasked. "}).warning,"Every command in this thread runs unasked.");
  for(const none of [undefined,null,"a string",{},{message:"   ",title:""}])assert.equal(Object.hasOwn(warned(none),"warning"),false,JSON.stringify(none));
  assert.equal(warned({message:"w".repeat(400)}).warning,"w".repeat(400),"400 characters are shown whole");
  assert.equal(warned({message:"w".repeat(401)}).warning,"w".repeat(399)+"…","a long word is cut at the limit");
  const sentence="Every command in this conversation runs without asking you first. ";
  const long=warned({message:sentence.repeat(10)}).warning;
  assert.ok(long.length<=400&&long.endsWith("…"),long.length);
  assert.ok(sentence.repeat(10).startsWith(long.slice(0,-1)),"the start of the warning, as it was");
  assert.match(long,/[a-z.]…$/,"it ends after a whole word");
  assert.equal(long.slice(0,-1).split(" ").every(word=>sentence.includes(word)),true);
  // A warning on another option goes with that option's button.
  const once=acpApprovalOptions("antigravity",[option("allow_once","once","Allow once",{"agy.security.warning":{message:"Runs a script"}})]);
  assert.deepEqual(once[0],{decision:"accept",label:"Allow once",warning:"Runs a script"});
  assert.deepEqual(shown(acpApprovalOptions("antigravity",[option("reject_once","deny","Deny")])),["Deny -> decline","Cancel this request -> cancel"]);
});
