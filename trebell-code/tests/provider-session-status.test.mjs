import test from "node:test";
import assert from "node:assert/strict";
import { contextCompactionSignal } from "../ui/src/provider-session-status.js";

test("provider session status maps Claude compaction lifecycle without guessing",()=>{
  assert.deepEqual(contextCompactionSignal({status:"compacting"}),{phase:"running",title:"Compacting context"});
  assert.deepEqual(contextCompactionSignal({compactResult:"success"}),{phase:"done",title:"Context compacted"});
  assert.deepEqual(contextCompactionSignal({compact_result:"failed",compact_error:"summary overflow"}),{phase:"error",title:"Context compaction failed",detail:"summary overflow"});
  assert.equal(contextCompactionSignal({status:"requesting"}),null);
});
