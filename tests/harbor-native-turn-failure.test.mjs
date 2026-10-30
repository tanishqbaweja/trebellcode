import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "../src/provider-manager.mjs";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";

// The benchmark runner ends a turn the way the app's Native does when the provider's retries are spent: the app's relay fails the turn
// with its error message and goes on (agent-relay.mjs, settlePrompt). The runner used to rethrow it, so the process died on an uncaught
// exception (regex-chess on Terminal-Bench 2.0, 2026-10-30: a DOMException TimeoutError from ProviderManager.forwardResponses, which
// Harbor recorded as NonZeroAgentExitCodeError). No request leaves the machine: the provider is a local fetch that always fails.

const home=()=>mkdtempSync(join(tmpdir(),"trebell-harbor-turn-failure-"));

test("the runner ends a turn whose provider retries ran out with its error, as the app does, instead of throwing",async()=>{
  const root=home(),repo=join(root,"repo"),logs=join(root,"logs");
  try{
    mkdirSync(repo,{recursive:true});mkdirSync(logs,{recursive:true});writeFileSync(join(repo,"README.md"),"# fixture\n");
    const gitEnv={...Object.fromEntries(["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"};
    for(const args of [["init","-q"],["add","-A"],["commit","-qm","fixture"]])execFileSync("git",args,{cwd:repo,windowsHide:true,stdio:"ignore",env:gitEnv});
    let calls=0;
    const manager=new ProviderManager({env:{TREBELL_HOME:join(logs,"home"),OPENAI_API_KEY:"test-key",TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0"},fetchFn:async()=>{calls++;return Response.json({error:{message:"The server had an error while processing your request.",type:"server_error",code:"server_error"}},{status:500})}});
    const run=await createHarborNativeRun({root:repo,instruction:"Fix the typo in README.md.",manager,env:{...gitEnv,TREBELL_HOME:join(logs,"home"),TREBELL_METRICS_PATH:join(logs,"metrics.json"),TREBELL_EVENTS_PATH:join(logs,"events.jsonl"),TREBELL_TOOL_CALLS_PATH:join(logs,"tool-calls.jsonl"),TREBELL_FINAL_DIFF_PATH:join(logs,"final.diff"),TREBELL_TOOL_OUTPUT_DIR:join(logs,"tool-output")}});
    const metrics=await run.run();
    assert.equal(calls,3,"the loop's three attempts");
    assert.equal(metrics.turnStatus,"failed");assert.match(metrics.error,/OpenAI API HTTP 500/);
    const written=JSON.parse(readFileSync(join(logs,"metrics.json"),"utf8"));
    assert.equal(written.turnStatus,"failed");assert.match(written.error,/OpenAI API HTTP 500/);assert.equal(written.modelTurns,1);
  }finally{rmSync(root,{recursive:true,force:true})}
});
