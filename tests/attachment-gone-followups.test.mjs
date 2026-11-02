import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentManager } from "../src/environment-manager.mjs";
import { sendInBackground, sendModelFanout, sendQueuedNow } from "../ui/src/turn-support.js";

// L10-F-1's review (tour L10, 2026-11-02): the chip of an attached file that is gone came off the draft only on the main send. A
// multi-model send, a background send (Ctrl/Cmd+Enter) and a queued follow-up's Send now each added a card with the same refusal at
// every press, and attaching the file again, as it advised, added a second chip while the dead one kept refusing. A thread in an SSH or
// WSL environment got 'Attachment does not exist in <environment>', naming no file, and no chip came off at all. Each now hands the
// refusal to the composer (dropGoneAttachments), which takes the files off and says so once; the remote check names the file.

const gone=()=>Object.assign(new Error('The attached file "notes.txt" is no longer on this computer. Attach it again.'),{data:{missing:["/home/me/.trebell/attachments/1761500000000-ab12cd34-notes.txt"]}});
function deps(extra={}){
  const calls={dropped:[],events:[],sent:0};
  const value={
    activeThread:null,activeTurnId:null,agentRuntime:"native",agentRuntimeLabel:"Trebell Native",attachments:["/home/me/.trebell/attachments/1761500000000-ab12cd34-notes.txt"],
    bootstrap:{cwd:"/repo"},contextChips:[],desktopNotify(){},dropSentDraft(){},gitInfo:{isGit:true,branch:"main"},maxComposerChars:100000,model:"m1",models:["m1","m2"],modelsRef:{current:["m1","m2"]},
    projectPath:"/repo",projectlessMode:false,prompt:"Summarize the notes",resetAssistantStream(){},restoreFailedDraft(){},rpc:{request:async()=>{calls.sent++;return {}}},rpcStatus:"connected",running:false,
    runtimeCapabilities:{multiModelFanout:true,detachedTasks:true,steering:true},runtimeSwitchRef:{current:null},selectedModels:["m1","m2"],send:async()=>{calls.sent++},
    setEvents:update=>calls.events.push(...update([])),setPrompt(){},setPromptHistoryIndex(){},setSection(){},showActionError(){},
    validateAttachmentPaths:async paths=>{if(paths.length)throw gone();return {files:[],count:0}},waitForActiveClone:async()=>{},
    dropGoneAttachments:(error,item)=>{if(!error?.data?.missing?.length)return false;calls.dropped.push({missing:error.data.missing,item:item?.id||null});return true},
    ...extra};
  return {value,calls};
}

test("a multi-model send whose attached file is gone hands it to the composer to take off, with no card, and keeps the draft",async()=>{
  const {value,calls}=deps();
  assert.equal(await sendModelFanout(value,"Summarize the notes"),"kept");
  assert.deepEqual(calls.dropped,[{missing:value.attachments,item:null}]);
  assert.deepEqual(calls.events,[],"no card stands for the refusal");
  assert.equal(calls.sent,0);
});

test("a background send whose attached file is gone hands it to the composer to take off, with no card, and keeps the task",async()=>{
  const {value,calls}=deps({selectedModels:["m1"]});
  assert.equal(await sendInBackground(value),"kept");
  assert.deepEqual(calls.dropped,[{missing:value.attachments,item:null}]);
  assert.deepEqual(calls.events,[]);
  assert.equal(calls.sent,0);
});

test("a refusal that is no file gone still says why on a card, as before",async()=>{
  const {value,calls}=deps({selectedModels:["m1"],validateAttachmentPaths:async()=>{throw new Error("Images in one message cannot exceed 80 MiB total")}});
  assert.equal(await sendInBackground(value),"kept");
  assert.deepEqual(calls.dropped,[]);
  assert.deepEqual(calls.events.map(event=>event.title),["Images in one message cannot exceed 80 MiB total"]);
});

test("Send now of a queued follow-up whose attached file is gone takes the file off that follow-up and sends nothing",async()=>{
  const item={id:"q1",text:"And the notes?",attachments:["/home/me/.trebell/attachments/1761500000000-ab12cd34-notes.txt"],contextChips:[]};
  const {value,calls}=deps({activeThread:{id:"t1"},running:false,setComposerAlert(){},localQueueStartRef:{current:new Set()},queuedEditId:null,queuedOnItsWay:()=>false,
    queueNow:()=>[item],persistLocalQueue:async()=>{calls.sent++},startTurn:async()=>{calls.sent++},clearQueuedDispatch:async()=>{},queueKeysDone(){}});
  await sendQueuedNow(value,item);
  assert.deepEqual(calls.dropped,[{missing:item.attachments,item:"q1"}],"the follow-up's own file comes off it");
  assert.equal(calls.sent,0,"nothing was sent or marked on its way");
  assert.equal(value.localQueueStartRef.current.size,0,"it is no longer on its way");
});

test("a remote environment's copy that is gone is refused by its name, with the environment's name, so its chip comes off",async()=>{
  const manager=new EnvironmentManager({state:{environments:()=>[{id:"box",type:"ssh",name:"Build box",enabled:true}]}});
  manager.execute=async()=>({exitCode:44,stdout:"",stderr:""});
  const path="/home/me/.trebell/attachments/1761500000000-ab12cd34-notes.txt";
  await assert.rejects(manager.validateAttachments("box",[path]),error=>{
    assert.equal(error.message,'The attached file "notes.txt" is no longer in Build box. Attach it again.');
    assert.deepEqual(error.missingPaths,[path]);
    assert.equal(error.missingIn,"Build box");
    return true;
  });
  // A host that could not be reached is not a file that is gone: it keeps its own words and no chip comes off.
  manager.execute=async()=>({exitCode:255,stdout:"",stderr:"ssh: connect to host box port 22: Connection refused"});
  await assert.rejects(manager.validateAttachments("box",[path]),error=>{assert.equal(error.missingPaths,undefined);assert.match(error.message,/Connection refused/);return true});
});
