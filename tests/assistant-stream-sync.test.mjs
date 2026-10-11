import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_ASSISTANT_STREAM, assistantStreamDelta } from "../ui/src/assistant-stream-sync.js";

// Applies frames as App.jsx does and returns the text a client would show.
function replay(frames){
  let state=EMPTY_ASSISTANT_STREAM,text="";
  for(const frame of frames){
    if(frame.reset){state=EMPTY_ASSISTANT_STREAM;text="";continue}
    const step=assistantStreamDelta(state,frame.delta,frame.offset);if(step.restart)text="";text+=step.append;state=step.state;
  }
  return {text,state};
}

test("deltas without an offset append as they always have and keep counting",()=>{
  assert.deepEqual(replay([{delta:"Hello"},{delta:" world"}]),{text:"Hello world",state:{chars:11,desynced:false}});
  assert.deepEqual(assistantStreamDelta(undefined,"",undefined),{restart:false,append:"",state:{chars:0,desynced:false}});
});

test("Native draft deltas append only where the shown text ends",()=>{
  assert.deepEqual(replay([{delta:"Hel",offset:0},{delta:"lo",offset:3},{delta:" world",offset:5}]),{text:"Hello world",state:{chars:11,desynced:false}});
  // A repeated frame or a gap sets the stream aside instead of garbling the text, and every later frame waits too.
  assert.deepEqual(replay([{delta:"Hel",offset:0},{delta:"Hel",offset:0},{delta:"lo",offset:3}]),{text:"Hel"+"lo",state:{chars:5,desynced:false}},"a repeated first frame restarts the draft, which then continues");
  assert.deepEqual(replay([{delta:"Hel",offset:0},{delta:"o",offset:4},{delta:"!",offset:5}]),{text:"Hel",state:{chars:3,desynced:true}});
  assert.deepEqual(replay([{delta:"Hel",offset:0},{delta:"lo",offset:1}]),{text:"Hel",state:{chars:3,desynced:true}});
  for(const offset of [-1,1.5,"x",Number.NaN])assert.deepEqual(assistantStreamDelta({chars:3,desynced:false},"a",offset),{restart:false,append:"",state:{chars:3,desynced:true}},String(offset));
});

test("offset 0 starts a new draft over a stale or set-aside one, and a reset clears it",()=>{
  // A draft whose reset was missed: the next draft starts again from its first character.
  assert.deepEqual(replay([{delta:"Old draft",offset:0},{delta:"New",offset:0},{delta:" draft",offset:3}]),{text:"New draft",state:{chars:9,desynced:false}});
  const restarted=assistantStreamDelta({chars:4,desynced:true},"Fresh",0);assert.deepEqual(restarted,{restart:true,append:"Fresh",state:{chars:5,desynced:false}});
  assert.deepEqual(replay([{delta:"Draft",offset:0},{reset:true},{delta:"Final reply"}]),{text:"Final reply",state:{chars:11,desynced:false}});
  // A thread opened after its draft began: the held frames do not start at 0, so nothing partial shows until the next draft.
  assert.deepEqual(replay([{delta:"middle",offset:40},{delta:" more",offset:46}]),{text:"",state:{chars:0,desynced:true}});
  assert.deepEqual(replay([{delta:"middle",offset:40},{delta:"Next draft",offset:0}]),{text:"Next draft",state:{chars:10,desynced:false}});
  // The final reply after a shown draft adds only the rest, at the draft's end.
  assert.deepEqual(replay([{delta:"The answer ",offset:0},{delta:"is 42.",offset:11}]),{text:"The answer is 42.",state:{chars:17,desynced:false}});
  assert.equal(Object.isFrozen(EMPTY_ASSISTANT_STREAM),true);
});
