import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_MAX_INPUT_CHARS, codexErrorNotice, codexErrorVariant, codexGoalLine, codexGoalStatusLabel, codexGoalsMissing, codexModelChoices, codexRetryCount, codexThreadSettings, codexTurnFailure, codexTurnInput, splitCodexAttachmentText } from "../ui/src/codex-turn-options.js";
import { parseCodexGoalCommand } from "../ui/src/codex-goal-command.js";
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

test("Codex attachments are named with their saved paths in the prompt, and images and audio also go as items",()=>{
  const input=codexTurnInput("Review these.",["H:/a/spec.pdf","H:/a/diagram.PNG","H:/a/voice.mp3"],{displayName:path=>path.split("/").pop()});
  // The typed text, a blank line, then one line for each file, one under the other.
  assert.deepEqual(input,[
    {type:"text",text:'Review these.\n\n[File attachment "spec.pdf" at H:/a/spec.pdf]\n[Image attachment "diagram.PNG" at H:/a/diagram.PNG]\n[Audio attachment "voice.mp3" at H:/a/voice.mp3]',textElements:[]},
    {type:"localImage",path:"H:/a/diagram.PNG"},
    {type:"localAudio",path:"H:/a/voice.mp3"},
  ]);
  assert.equal(input.some(item=>item.type==="mention"),false,"Codex reads a mention item's file as nothing; the path line replaces it");
  assert.deepEqual(codexTurnInput("Hi",[]),[{type:"text",text:"Hi",textElements:[]}]);
  assert.equal(codexTurnInput("",["C:\\x\\notes.txt"])[0].text,'[File attachment "notes.txt" at C:\\x\\notes.txt]');
  assert.deepEqual(codexTurnInput("",["",null,"C:\\x\\a.txt"]).map(item=>item.text),['[File attachment "a.txt" at C:\\x\\a.txt]'],"an empty path is skipped");
  // The input limit never hides an attachment: a prompt at it still names its files, and the image item still goes.
  const long="x".repeat(CODEX_MAX_INPUT_CHARS-10),[full,image]=codexTurnInput(long,["H:/a/spec.pdf","H:/a/big.png"]);
  assert.ok(full.text.startsWith(long));
  assert.equal(full.text.slice(long.length),'\n\n[File attachment "spec.pdf" at H:/a/spec.pdf]\n[Image attachment "big.png" at H:/a/big.png]');
  assert.deepEqual(image,{type:"localImage",path:"H:/a/big.png"});
  assert.deepEqual(splitCodexAttachmentText(full.text).paths,["H:/a/spec.pdf","H:/a/big.png"]);
});

test("a queued Codex follow-up is edited as the draft it was, with its attachments back",()=>{
  const [text,...media]=codexTurnInput("Fix it\n\nplease",["H:/a/spec.pdf","H:/a/shot.png"]);
  assert.deepEqual(splitCodexAttachmentText(text.text),{text:"Fix it\n\nplease",paths:["H:/a/spec.pdf","H:/a/shot.png"]});
  assert.deepEqual(splitCodexAttachmentText("No attachments"),{text:"No attachments",paths:[]});
  const draft=queuedSubmissionDraft({id:"q1",input:[text,...media]});
  assert.equal(draft.draftText,"Fix it\n\nplease");assert.deepEqual(draft.attachments,["H:/a/shot.png","H:/a/spec.pdf"]);
  assert.equal(draft.editable,true);
});

// Threads and queued follow-ups sent before the line took its present wording hold an earlier line, a blank line before each one:
// they still give back their text and files. The earlier lines here have that line's shape in Trebell's own made-up words
// (attachment-line.mjs reads it by its shape and by the quoted name being the path's file).
test("a Codex message in the earlier attachment line's shape still gives back its text and files",()=>{
  const earlier='Fix it\n\nplease\n\n[Older file "spec.pdf" kept here: H:/a/spec.pdf]\n\n[Older image "shot.png" kept here: H:/a/shot.png]';
  assert.deepEqual(splitCodexAttachmentText(earlier),{text:"Fix it\n\nplease",paths:["H:/a/spec.pdf","H:/a/shot.png"]});
  assert.deepEqual(splitCodexAttachmentText('[Older file "report.docx" kept here: C:\\w (1)\\report.docx (its text: C:\\t\\report.docx.txt)]'),{text:"",paths:["C:\\w (1)\\report.docx"]},"a document's text file is not a path of its own");
  const draft=queuedSubmissionDraft({id:"q0",input:[{type:"text",text:earlier},{type:"localImage",path:"H:/a/shot.png"}]});
  assert.equal(draft.draftText,"Fix it\n\nplease");assert.deepEqual(draft.attachments,["H:/a/shot.png","H:/a/spec.pdf"]);
  // Only lines at the end count, and a bracket line whose quoted name is not its path's file stays the person's text.
  for(const text of ['[File attachment "a.txt" at H:/a.txt]\n\nthen my question','Look:\n\n[Linked folder "notes" kept here: H:/x]','[Image attachment "x.png" at ]','A note [File attachment "a" at H:/a]'])
    assert.deepEqual(splitCodexAttachmentText(text),{text,paths:[]},text);
});

test("a Codex attachment line keeps a shown name inside its quotes, and reads back the path whatever it holds",()=>{
  const [input]=codexTurnInput("See",["/home/me/odd name (2).txt"],{displayName:()=>'say "hi"\nthere'});
  assert.equal(input.text,'See\n\n[File attachment "say \'hi\' there" at /home/me/odd name (2).txt]');
  assert.deepEqual(splitCodexAttachmentText(input.text),{text:"See",paths:["/home/me/odd name (2).txt"]});
  // A document's line names its text file after the path, and the path still comes back alone.
  const [document]=codexTurnInput("",["C:\\w\\plan, v2.docx"],{displayName:()=>"plan, v2.docx",textPath:path=>path+".txt"});
  assert.equal(document.text,'[File attachment "plan, v2.docx" at C:\\w\\plan, v2.docx, readable as text at C:\\w\\plan, v2.docx.txt]');
  assert.deepEqual(splitCodexAttachmentText("Read it\n"+document.text).paths,["C:\\w\\plan, v2.docx"]);
  // The typed text keeps its own blank lines and line breaks; one blank line before the files goes with them.
  const [typed]=codexTurnInput("First\n\n\nSecond\n",["H:/a/b.md"]);
  assert.equal(typed.text,'First\n\n\nSecond\n\n\n[File attachment "b.md" at H:/a/b.md]');
  assert.deepEqual(splitCodexAttachmentText(typed.text),{text:"First\n\n\nSecond\n",paths:["H:/a/b.md"]});
});

test("/goal parses like the Codex TUI",()=>{
  assert.deepEqual(parseCodexGoalCommand("/goal"),{type:"show"});
  assert.deepEqual(parseCodexGoalCommand("  /goal edit "),{type:"show"});
  assert.deepEqual(parseCodexGoalCommand("/goal clear"),{type:"clear"});
  assert.deepEqual(parseCodexGoalCommand("/goal PAUSE"),{type:"pause"});
  assert.deepEqual(parseCodexGoalCommand("/goal resume"),{type:"resume"});
  assert.deepEqual(parseCodexGoalCommand("/goal Ship the release\nwith notes"),{type:"set",objective:"Ship the release\nwith notes"});
  assert.equal(parseCodexGoalCommand("/goals"),null);assert.equal(parseCodexGoalCommand("set a goal"),null);
  assert.equal(codexGoalLine({objective:"Ship it",status:"budgetLimited"}),"Goal budget limited: Ship it");
  assert.equal(codexGoalLine(null),"This thread has no goal.");
  assert.equal(codexGoalStatusLabel("usageLimited"),"usage limited");
});

test("/goal counts only as its own lower-case word at the start, and any whitespace parts it from what follows",()=>{
  // Tabs, line breaks and wide or no-break spaces part the word from its argument, and none counts around the message.
  assert.deepEqual(parseCodexGoalCommand("/goal\tclear"),{type:"clear"});
  assert.deepEqual(parseCodexGoalCommand("\n/goal\n\npause\n"),{type:"pause"});
  assert.deepEqual(parseCodexGoalCommand("/goal\u00a0resume"),{type:"resume"});
  assert.deepEqual(parseCodexGoalCommand("\u3000/goal \t\u3000"),{type:"show"});
  // A message is read as it is turned into text, so a value that reads as the command is the command.
  assert.deepEqual(parseCodexGoalCommand({toString:()=>"/goal Pause"}),{type:"pause"});
  // Text before the word, the word in another case, or the word running on into other characters: another message.
  const others=["x /goal","/GOAL","/Goal clear","/goal:x","/goal-clear","/goal/clear","/goalclear","","   ",null,undefined,42,true];
  assert.deepEqual(others.map(text=>parseCodexGoalCommand(text)),others.map(()=>null));
});

test("/goal's action words count in any case and only as the whole argument; any other text is the objective as typed",()=>{
  assert.deepEqual(parseCodexGoalCommand("/goal Edit"),{type:"show"});
  assert.deepEqual(parseCodexGoalCommand("/goal CLEAR"),{type:"clear"});
  assert.deepEqual(parseCodexGoalCommand("/goal rEsUmE"),{type:"resume"});
  assert.deepEqual(parseCodexGoalCommand("/goal clear the build cache"),{type:"set",objective:"clear the build cache"});
  assert.deepEqual(parseCodexGoalCommand("/goal edit the plan"),{type:"set",objective:"edit the plan"});
  assert.deepEqual(parseCodexGoalCommand("/goal Pause\nlater"),{type:"set",objective:"Pause\nlater"});
  assert.deepEqual(parseCodexGoalCommand("/goal   Fix  the Login\tFlow  "),{type:"set",objective:"Fix  the Login\tFlow"});
  // Each read is an object of its own: changing one changes no later read.
  const shown=parseCodexGoalCommand("/goal");shown.type="clear";
  assert.deepEqual(parseCodexGoalCommand("/goal"),{type:"show"});
  const set=parseCodexGoalCommand("/goal Ship");set.objective="Other";
  assert.deepEqual(parseCodexGoalCommand("/goal Ship"),{type:"set",objective:"Ship"});
});

test("every send whose first word is /goal, as the composer's commands split it, reads as a /goal command",()=>{
  const firstWord=text=>text.split(/\s+/)[0];
  const sends=["/goal","/goal ","/goal\n","/goal x","/goal\tx y","/goal \n pause","/goal  EDIT  "];
  assert.deepEqual(sends.map(firstWord),sends.map(()=>"/goal"),"each send's first word is /goal");
  assert.equal(sends.map(text=>parseCodexGoalCommand(text)).indexOf(null),-1);
});

test("a Codex without goals is told by its refusal of thread/goal/*, not by any goal error",()=>{
  const refused=(message,code)=>Object.assign(new Error(message),{rpcCode:code});
  assert.equal(codexGoalsMissing(refused("Method not found: thread/goal/get",-32601)),true);
  // How Codex 0.155.1's app-server answers a method it does not have.
  assert.equal(codexGoalsMissing(refused("Invalid request: unknown variant `thread/goal/set`, expected one of `initialize`, `server/diagnostics`, `thread/start`",-32600)),true);
  assert.equal(codexGoalsMissing(new Error("Method not found")),true);
  assert.equal(codexGoalsMissing(refused("Unsupported goal status: done",-32602)),false);
  assert.equal(codexGoalsMissing(refused("Invalid request: unknown variant `done`, expected one of `active`, `paused`",-32600)),false);
  assert.equal(codexGoalsMissing(refused("thread not found: 0199",-32600)),false);
  assert.equal(codexGoalsMissing(new Error("Codex relay disconnected")),false);
  assert.equal(codexGoalsMissing(null),false);
});

test("Codex error notifications read plainly: details first, limits and sign-in with a hint, retries keep the turn",()=>{
  assert.equal(codexErrorVariant("usageLimitExceeded"),"usageLimitExceeded");
  assert.equal(codexErrorVariant({httpConnectionFailed:{httpStatusCode:502}}),"httpConnectionFailed");
  assert.equal(codexErrorVariant(null),null);
  assert.deepEqual(codexRetryCount("Reconnecting... 3/5"),{attempt:3,maxAttempts:5});
  assert.equal(codexRetryCount("stream disconnected"),null);
  const usage=codexErrorNotice({threadId:"t",turnId:"u",willRetry:false,error:{message:"You've hit your usage limit.",codexErrorInfo:"usageLimitExceeded",additionalDetails:null}});
  assert.equal(usage.kind,"usage_limit");assert.equal(usage.message,"You've hit your usage limit.");assert.match(usage.title,/See Usage for your Codex limits\.$/);
  const auth=codexErrorNotice({error:{message:"401 Unauthorized",codexErrorInfo:"unauthorized"}});
  assert.equal(auth.kind,"auth");assert.match(auth.title,/Sign in to Codex again/);
  const detailed=codexErrorNotice({error:{message:"stream error",additionalDetails:"model 'nope' does not exist",codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}}});
  assert.equal(detailed.message,"model 'nope' does not exist");assert.equal(detailed.kind,"transport");
  const retry=codexErrorNotice({willRetry:true,error:{message:"Reconnecting... 3/5",codexErrorInfo:{responseStreamDisconnected:{}}}});
  assert.equal(retry.willRetry,true);assert.deepEqual(retry.retry,{attempt:3,maxAttempts:5});assert.equal(retry.title,"Retrying (3/5): Reconnecting... 3/5");
  assert.equal(codexErrorNotice({message:"Claude stopped"}).title,"Claude stopped","other harnesses' {message} errors read as before");
  assert.equal(codexErrorNotice({}).message,"Agent error");
});

test("a Codex goal's line names its status in words and its objective, and a thread without a goal says so",()=>{
  const line=status=>codexGoalLine({objective:"Tidy the changelog",status});
  const statuses=["active","paused","blocked","usageLimited","budgetLimited","complete"];
  assert.equal(statuses.map(line).join("\n"),"Goal active: Tidy the changelog\nGoal paused: Tidy the changelog\nGoal blocked: Tidy the changelog\nGoal usage limited: Tidy the changelog\nGoal budget limited: Tidy the changelog\nGoal complete: Tidy the changelog");
  assert.equal(line("archived"),"Goal archived: Tidy the changelog","a status Codex adds later shows as it is");
  assert.equal(codexGoalLine({objective:"Tidy the changelog"}),"Goal : Tidy the changelog","a goal sent without a status has no words for it");
  assert.equal(codexGoalLine({objective:42,status:"active"}),"Goal active: 42");
  for(const goal of [undefined,{},{objective:""},{objective:null,status:"active"},{status:"paused"},"Tidy the changelog",7])assert.equal(codexGoalLine(goal),"This thread has no goal.",JSON.stringify(goal));
});

test("a Codex error's variant is its name, or the one key of a variant that carries data",()=>{
  assert.equal(codexErrorVariant("serverOverloaded"),"serverOverloaded");
  assert.equal(codexErrorVariant({responseStreamConnectionFailed:{httpStatusCode:503}}),"responseStreamConnectionFailed");
  assert.equal(codexErrorVariant({first:{},second:{}}),"first","an object's first key");
  for(const info of ["",{},undefined,0,404,true,()=>"unauthorized"])assert.equal(codexErrorVariant(info),null,String(info));
});

test("a Codex retry's count is the first slash with a whole number on each side",()=>{
  const count=(attempt,maxAttempts)=>({attempt,maxAttempts});
  assert.deepEqual(codexRetryCount("Reconnecting... 4/5"),count(4,5));
  assert.equal(codexRetryCount("Reconnecting... waiting for network"),null,"Codex's wait for the network counts no try");
  // Blanks may stand on either side of the slash, a line break too.
  assert.deepEqual(codexRetryCount("try 3 / 7"),count(3,7));
  assert.deepEqual(codexRetryCount("try 3\n/\t7"),count(3,7));
  // A number glued to a letter, a digit or "_" is part of a word; punctuation around a count is not.
  for(const text of ["build v3/7","3/7x","3/7_","_3/7"])assert.equal(codexRetryCount(text),null,text);
  for(const text of ["#3/7","(3/7)","3/7.","...3/7"])assert.deepEqual(codexRetryCount(text),count(3,7),text);
  // Leading zeros do not count; a slash that is no count is passed over, and the first count is the answer.
  assert.deepEqual(codexRetryCount("03/07"),count(3,7));
  assert.deepEqual(codexRetryCount("from a/b, then 3/7"),count(3,7));
  assert.deepEqual(codexRetryCount("x1/3/7"),count(3,7));
  assert.deepEqual(codexRetryCount("3/7, before it 1/7"),count(3,7));
  // Codex counts from 1: a first count with a 0 is none, whatever follows it.
  for(const text of ["0/7","3/0","0/7 then 3/7"])assert.equal(codexRetryCount(text),null,text);
  assert.deepEqual(codexRetryCount("8/7"),count(8,7),"a try past the number of tries is read as written");
  for(const message of [null,undefined,37,""])assert.equal(codexRetryCount(message),null,String(message));
  // A long error text full of slashes is read in one pass: each slash looks only at the numbers written beside it.
  const started=performance.now();
  assert.equal(codexRetryCount("x1 / 2".repeat(200_000)),null);
  assert.ok(performance.now()-started<1000);
});

test("a failed Codex turn reports its error at turn/completed",()=>{
  assert.equal(codexTurnFailure({id:"u",status:"completed"}),null);
  assert.equal(codexTurnFailure({id:"u",status:"interrupted"}),null);
  assert.equal(codexTurnFailure({id:"u",status:"failed",error:{message:"boom",codexErrorInfo:"internalServerError"}}).message,"boom");
  assert.equal(codexTurnFailure({id:"u",status:"failed",error:null}).message,"The turn failed.");
});
