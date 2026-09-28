import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Terminal-Bench pair runner prevents overlapping pairs and saves comparable trial metrics",async()=>{
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/terminal-bench-pair\.lock/);
  assert.match(source,/Refusing to contaminate benchmark timing/);
  assert.match(source,/SETUP_TIMEOUT_MULTIPLIER/);
  assert.match(source,/agentExecutionMs:elapsedMs\(trial\?\.agent_execution\)/);
  assert.match(source,/taskChecksum:trial\?\.task_checksum/);
  assert.match(source,/nativeBundleSha256/);
  assert.match(source,/nativeAdapterSha256/);
  assert.match(source,/agentVersion:trial\?\.agent_info\?\.version/);
  assert.match(source,/complete,activeHarness,activeJobName/);
  assert.match(source,/await persistReport\(\{complete:false,activeHarness:harness,activeJobName:jobName\}\)/);
  assert.match(source,/await persistReport\(\{complete:false,activeHarness:null,activeJobName:null\}\)/);
  assert.match(source,/writeFile\(reportPath,JSON\.stringify\(report,null,2\)/);
});

test("Terminal-Bench single runner uses an absolute output path and the same safer setup-timeout default",async()=>{
  const source=await readFile(new URL("../scripts/run-terminal-bench.mjs",import.meta.url),"utf8");
  assert.match(source,/TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER\|\|3/);
  assert.match(source,/const output=resolve\(root,/);
  assert.match(source,/--agent-setup-timeout-multiplier/);
});
