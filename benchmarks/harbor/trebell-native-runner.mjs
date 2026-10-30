import { readFile } from "node:fs/promises";

import { createHarborNativeRun, HARBOR_NATIVE_VERSION } from "./native-harbor-run.mjs";

// The Harbor benchmark runner: the app's Native (src/native-configuration.mjs), built for the task in native-harbor-run.mjs.
if(process.argv.includes("--version")){
  console.log(HARBOR_NATIVE_VERSION);
  process.exit(0);
}

const instructionPath=process.argv[2];
if(!instructionPath)throw new Error("Usage: trebell-native-agent.mjs <instruction-file>");
const instruction=String(await readFile(instructionPath,"utf8")).trim();
if(!instruction)throw new Error("Benchmark instruction is empty.");

const run=await createHarborNativeRun({root:process.cwd(),instruction,env:process.env});
const metrics=await run.run();
// A turn that failed exits 1 once its metrics and its stderr line are written: the adapter (trebell_native_agent.py) passes a non-zero
// exit through when the metrics hold an error, and Harbor then records the agent's failure and classes it from the output (an invalid
// key, spent credits, a rate limit), while it still collects the artifacts and verifies the work.
if(metrics?.turnStatus==="failed")process.exitCode=1;
