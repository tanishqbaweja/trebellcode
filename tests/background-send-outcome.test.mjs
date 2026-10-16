import test from "node:test";
import assert from "node:assert/strict";
import { settleModelFanout } from "../ui/src/background-send-outcome.js";

// A multi-model run's rows open to words, as a failed background launch's row does, not to the event's data: the models started
// with their threads, and for each model that did not start what failed, the thread and folder to check and where its draft went.
test("a multi-model run's rows open to the models started and, for each model that did not start, what failed and where its draft went",async()=>{
  const added=[],stashed=[],restored=[];
  const cutOff=Object.assign(new Error("App-server disconnected"),{trebellUncertain:{threadId:"thread-b",cwd:"H:\\repo-trebell-model-b",model:"model-b",phase:"turn",verificationError:null}});
  const unlisted=Object.assign(new Error("App-server disconnected"),{trebellUncertain:{threadId:null,cwd:"H:\\repo-trebell-model-c",model:"model-c",phase:"thread",verificationError:"Agent harness is not connected"}});
  const results=[
    {ok:true,modelId:"model-a",result:{thread:{id:"thread-a"}}},
    {ok:false,modelId:"model-b",error:cutOff},
    {ok:false,modelId:"model-c",error:unlisted},
    {ok:false,modelId:"model-d",error:new Error("Deliberate worktree failure")},
  ];
  await settleModelFanout({
    results,fanout:results.map(item=>item.modelId),draft:{text:"Run the checks"},
    saveFailureStash:async draft=>{stashed.push(draft.text);return draft.text.includes("model-d")?{ok:false,error:"Stash is full"}:{ok:true}},
    restoreFailedDraft:draft=>restored.push(draft.text),desktopNotify:()=>{},addEvents:rows=>added.push(...rows),
  });
  const [started,failed]=added;
  assert.equal(started.title,"Started 1/4 model in isolated worktrees");
  assert.equal(started.output,"Model: model-a · thread thread-a");
  assert.equal(failed.title,"3 model runs need attention; 2 may already have started · 2/3 failed drafts stashed; 1 restored to the composer because saving failed");
  assert.equal(failed.output,[
    "Could not tell whether the task's turn started: App-server disconnected","Possible thread: thread-b","Folder: H:\\repo-trebell-model-b","Model: model-b",
    "The draft was saved to Trebell stash, marked [CHECK EXISTING THREAD BEFORE RETRY · model-b].",
    "",
    "Could not tell whether the task's thread was created: App-server disconnected","Could not look for the task's thread: Agent harness is not connected","Folder: H:\\repo-trebell-model-c","Model: model-c",
    "The draft was saved to Trebell stash, marked [CHECK EXISTING THREAD BEFORE RETRY · model-c].",
    "",
    "Could not start the background task: Deliberate worktree failure","Model: model-d",
    "The draft could not be saved to Trebell stash, so it was restored to the composer: Stash is full",
  ].join("\n"));
  assert.deepEqual(stashed,["[CHECK EXISTING THREAD BEFORE RETRY · model-b] Run the checks","[CHECK EXISTING THREAD BEFORE RETRY · model-c] Run the checks","[model-d] Run the checks"]);
  assert.deepEqual(restored,["Run the checks"]);
});
