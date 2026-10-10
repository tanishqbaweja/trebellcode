import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_MAX_INPUT_CHARS, codexErrorInfoCode, codexErrorNotice, codexGoalStatusLabel, codexModelChoices, codexThreadSettings, codexTurnFailure, codexTurnInput, describeCodexGoal, parseCodexGoalCommand, parseCodexRetryProgress, splitCodexAttachmentText } from "../ui/src/codex-turn-options.js";
import { queuedSubmissionDraft } from "../ui/src/native-queue.js";
import { modelReasoningEffortKey } from "../src/model-reasoning-effort.mjs";
import { modelServiceTierKey } from "../src/model-service-tier.mjs";

const TIERS={serviceTiers:[{id:"priority",name:"Fast"}],defaultServiceTier:null};

test("a Codex thread's own settings come from thread/resume and thread/settings/updated",()=>{
  assert.deepEqual(codexThreadSettings("t1",{model:"gpt-6-luna",reasoningEffort:"high",serviceTier:"priority",thread:{id:"t1"}}),{threadId:"t1",model:"gpt-6-luna",effort:"high",serviceTier:"priority"});
  assert.deepEqual(codexThreadSettings("t1",{threadId:"t1",threadSettings:{model:"gpt-6-luna",effort:"ultra",serviceTier:null,collaborationMode:{mode:"default"}}}),{threadId:"t1",model:"gpt-6-luna",effort:"ultra",serviceTier:null});
  assert.equal(codexThreadSettings("t1",{threadSettings:{collaborationMode:{mode:"plan"}}}),null,"a report without the model is not the thread's settings");
  assert.equal(codexThreadSettings("",{model:"gpt-6-luna"}),null);
});

test("the open thread's effort and tier apply while the composer is on its model, otherwise the user's picks",()=>{
  const settings={modelReasoningEfforts:{[modelReasoningEffortKey("codex","openai","gpt-6-luna")]:"low"},modelServiceTiers:{[modelServiceTierKey("codex","openai","gpt-6-luna")]:"default"}};
  const thread={threadId:"t1",model:"gpt-6-luna",effort:"high",serviceTier:"priority"};
  assert.deepEqual(codexModelChoices({settings,provider:"openai",model:"gpt-6-luna",metadata:TIERS,thread}),{fromThread:true,effort:"high",serviceTier:"priority",serviceTierPicker:"priority"});
  assert.deepEqual(codexModelChoices({settings,provider:"openai",model:"gpt-6-luna",metadata:TIERS}),{fromThread:false,effort:"low",serviceTier:"default",serviceTierPicker:"default"});
  assert.deepEqual(codexModelChoices({settings:{},provider:"openai",model:"gpt-6-luna",metadata:TIERS,thread:{...thread,model:"gpt-6-sol"}}),{fromThread:false,effort:null,serviceTier:null,serviceTierPicker:"default"},"another model's thread settings do not apply; nothing is sent without a pick");
  assert.deepEqual(codexModelChoices({settings:{},provider:"openai",model:"custom",metadata:{},custom:{effort:"xhigh",serviceTier:"flex"}}),{fromThread:false,effort:"xhigh",serviceTier:"flex",serviceTierPicker:"flex"},"a custom model's own effort and tier");
});

test("Codex attachments are named with their saved paths in the prompt, and images and audio also go as items (T3)",()=>{
  const input=codexTurnInput("Review these.",["H:/a/spec.pdf","H:/a/diagram.PNG","H:/a/voice.mp3"],{displayName:path=>path.split("/").pop()});
  assert.deepEqual(input,[
    {type:"text",text:'Review these.\n\n[Attached file "spec.pdf" is saved at: H:/a/spec.pdf]\n\n[Attached image "diagram.PNG" is saved at: H:/a/diagram.PNG]\n\n[Attached file "voice.mp3" is saved at: H:/a/voice.mp3]',textElements:[]},
    {type:"localImage",path:"H:/a/diagram.PNG"},
    {type:"localAudio",path:"H:/a/voice.mp3"},
  ]);
  assert.equal(input.some(item=>item.type==="mention"),false,"Codex reads a mention item's file as nothing; the path line replaces it");
  assert.deepEqual(codexTurnInput("Hi",[]),[{type:"text",text:"Hi",textElements:[]}]);
  assert.equal(codexTurnInput("",["C:\\x\\notes.txt"])[0].text,'[Attached file "notes.txt" is saved at: C:\\x\\notes.txt]');
  // A line that would push the prompt past T3's input limit is left out; the image item still goes.
  const long="x".repeat(CODEX_MAX_INPUT_CHARS-10),capped=codexTurnInput(long,["H:/a/big.png"]);
  assert.equal(capped[0].text,long);assert.deepEqual(capped[1],{type:"localImage",path:"H:/a/big.png"});
});

test("a queued Codex follow-up is edited as the draft it was, with its attachments back",()=>{
  const [text,...media]=codexTurnInput("Fix it\n\nplease",["H:/a/spec.pdf","H:/a/shot.png"]);
  assert.deepEqual(splitCodexAttachmentText(text.text),{text:"Fix it\n\nplease",paths:["H:/a/spec.pdf","H:/a/shot.png"]});
  assert.deepEqual(splitCodexAttachmentText("No attachments"),{text:"No attachments",paths:[]});
  const draft=queuedSubmissionDraft({id:"q1",input:[text,...media]});
  assert.equal(draft.draftText,"Fix it\n\nplease");assert.deepEqual(draft.attachments,["H:/a/shot.png","H:/a/spec.pdf"]);
  assert.equal(draft.editable,true);
});

test("/goal parses like the Codex TUI and T3 Code",()=>{
  assert.deepEqual(parseCodexGoalCommand("/goal"),{type:"show"});
  assert.deepEqual(parseCodexGoalCommand("  /goal edit "),{type:"show"});
  assert.deepEqual(parseCodexGoalCommand("/goal clear"),{type:"clear"});
  assert.deepEqual(parseCodexGoalCommand("/goal PAUSE"),{type:"pause"});
  assert.deepEqual(parseCodexGoalCommand("/goal resume"),{type:"resume"});
  assert.deepEqual(parseCodexGoalCommand("/goal Ship the release\nwith notes"),{type:"set",objective:"Ship the release\nwith notes"});
  assert.equal(parseCodexGoalCommand("/goals"),null);assert.equal(parseCodexGoalCommand("set a goal"),null);
  assert.equal(describeCodexGoal({objective:"Ship it",status:"budgetLimited"}),"Goal budget limited: Ship it");
  assert.equal(describeCodexGoal(null),"No goal is set.");
  assert.equal(codexGoalStatusLabel("usageLimited"),"usage limited");
});

test("Codex error notifications read like T3's: details first, limits and sign-in with a hint, retries keep the turn",()=>{
  assert.equal(codexErrorInfoCode("usageLimitExceeded"),"usageLimitExceeded");
  assert.equal(codexErrorInfoCode({httpConnectionFailed:{httpStatusCode:502}}),"httpConnectionFailed");
  assert.equal(codexErrorInfoCode(null),null);
  assert.deepEqual(parseCodexRetryProgress("Reconnecting... 2/5"),{attempt:2,maxAttempts:5});
  assert.equal(parseCodexRetryProgress("stream disconnected"),null);
  const usage=codexErrorNotice({threadId:"t",turnId:"u",willRetry:false,error:{message:"You've hit your usage limit.",codexErrorInfo:"usageLimitExceeded",additionalDetails:null}});
  assert.equal(usage.kind,"usage_limit");assert.equal(usage.message,"You've hit your usage limit.");assert.match(usage.title,/See Usage for your Codex limits\.$/);
  const auth=codexErrorNotice({error:{message:"401 Unauthorized",codexErrorInfo:"unauthorized"}});
  assert.equal(auth.kind,"auth");assert.match(auth.title,/Sign in to Codex again/);
  const detailed=codexErrorNotice({error:{message:"stream error",additionalDetails:"model 'nope' does not exist",codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}});
  assert.equal(detailed.message,"model 'nope' does not exist");assert.equal(detailed.kind,"transport");
  const retry=codexErrorNotice({willRetry:true,error:{message:"Reconnecting... 2/5",codexErrorInfo:{responseStreamDisconnected:{}}}});
  assert.equal(retry.willRetry,true);assert.deepEqual(retry.retry,{attempt:2,maxAttempts:5});assert.equal(retry.title,"Retrying (2/5): Reconnecting... 2/5");
  assert.equal(codexErrorNotice({message:"Claude stopped"}).title,"Claude stopped","other harnesses' {message} errors read as before");
  assert.equal(codexErrorNotice({}).message,"Agent error");
});

test("a failed Codex turn reports its error at turn/completed",()=>{
  assert.equal(codexTurnFailure({id:"u",status:"completed"}),null);
  assert.equal(codexTurnFailure({id:"u",status:"interrupted"}),null);
  assert.equal(codexTurnFailure({id:"u",status:"failed",error:{message:"boom",codexErrorInfo:"internalServerError"}}).message,"boom");
  assert.equal(codexTurnFailure({id:"u",status:"failed",error:null}).message,"The turn failed.");
});
