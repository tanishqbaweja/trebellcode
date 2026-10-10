import test from "node:test";
import assert from "node:assert/strict";
import { startupRuntimeOutcome } from "../ui/src/startup-runtime.js";

test("the first load applies its runtime and model catalog when no harness switch began meanwhile",()=>{
  assert.deepEqual(startupRuntimeOutcome({switchSeqAtStart:0,switchSeq:0,appliedSeqAtStart:0,appliedSeq:0}),{applyCatalog:true,keepLandedRuntime:false});
  assert.deepEqual(startupRuntimeOutcome(),{applyCatalog:true,keepLandedRuntime:false});
});

test("a harness switch begun during the first load keeps the replaced harness's models off the composer",()=>{
  // The live tour: switching from Cursor to OpenCode while Cursor still listed its models showed Cursor's 44 models under
  // "Switching to OpenCode…".
  assert.deepEqual(startupRuntimeOutcome({switchSeqAtStart:0,switchSeq:1,appliedSeqAtStart:0,appliedSeq:0}),{applyCatalog:false,keepLandedRuntime:false},
    "while it is pending, or after it failed with the server unmoved, the startup runtime stands: the server runs it");
  assert.deepEqual(startupRuntimeOutcome({switchSeqAtStart:0,switchSeq:1,appliedSeqAtStart:0,appliedSeq:1}),{applyCatalog:false,keepLandedRuntime:true},
    "once it has set the runtime, the startup runtime must not undo it");
  assert.deepEqual(startupRuntimeOutcome({switchSeqAtStart:2,switchSeq:4,appliedSeqAtStart:1,appliedSeq:3}),{applyCatalog:false,keepLandedRuntime:true});
});
