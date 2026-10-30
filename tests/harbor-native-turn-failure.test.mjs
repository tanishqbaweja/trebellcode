import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProviderManager } from "../src/provider-manager.mjs";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";

// The benchmark runner ends a turn the way the app's Native does when the provider's retries are spent: the app's relay fails the turn
// with its error message (agent-relay.mjs, settlePrompt). The runner used to rethrow it, so the process died on an uncaught exception
// (regex-chess on Terminal-Bench 2.0, 2026-10-30: a DOMException TimeoutError from ProviderManager.forwardResponses). It still exits 1:
// the Harbor adapter passes a non-zero exit through when the metrics hold an error, and Harbor classes the failure from the output (an
// invalid key, spent credits, a rate limit) instead of counting it as a try that ran. No request leaves the machine: the provider is a
// local fetch that always fails.

const home=()=>mkdtempSync(join(tmpdir(),"trebell-harbor-turn-failure-"));
const gitEnvironment=()=>({...Object.fromEntries(["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"});

test("the runner ends a turn whose provider retries ran out with its error, as the app does, instead of throwing",async()=>{
  const root=home(),repo=join(root,"repo"),logs=join(root,"logs");
  try{
    mkdirSync(repo,{recursive:true});mkdirSync(logs,{recursive:true});writeFileSync(join(repo,"README.md"),"# fixture\n");
    const gitEnv=gitEnvironment();
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

test("the runner's process exits 1 after a failed turn, its metrics written and one stderr line naming the error, with no uncaught stack",()=>{
  const root=home(),repo=join(root,"repo"),logs=join(root,"logs"),trebellHome=join(logs,"home");
  try{
    mkdirSync(repo,{recursive:true});mkdirSync(trebellHome,{recursive:true});writeFileSync(join(repo,"README.md"),"# fixture\n");
    const gitEnv=gitEnvironment();
    for(const args of [["init","-q"],["add","-A"],["commit","-qm","fixture"]])execFileSync("git",args,{cwd:repo,windowsHide:true,stdio:"ignore",env:gitEnv});
    // The key is a placeholder in the runner's own settings file (no key variable reaches the child), and every fetch answers OpenAI's 500.
    writeFileSync(join(trebellHome,"provider-secrets.json"),JSON.stringify({openai:"test-key"}));
    const preload=join(root,"failing-fetch.mjs");
    writeFileSync(preload,'globalThis.fetch=async()=>Response.json({error:{message:"The server had an error while processing your request.",type:"server_error",code:"server_error"}},{status:500});\n');
    const instruction=join(root,"instruction.md");writeFileSync(instruction,"Fix the typo in README.md.\n");
    const runner=fileURLToPath(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url));
    const child=spawnSync(process.execPath,["--import",pathToFileURL(preload).href,runner,instruction],{cwd:repo,encoding:"utf8",windowsHide:true,timeout:120_000,env:{...gitEnv,TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0",TREBELL_HOME:trebellHome,TREBELL_METRICS_PATH:join(logs,"metrics.json"),TREBELL_EVENTS_PATH:join(logs,"events.jsonl"),TREBELL_TOOL_CALLS_PATH:join(logs,"tool-calls.jsonl"),TREBELL_FINAL_DIFF_PATH:join(logs,"final.diff"),TREBELL_TOOL_OUTPUT_DIR:join(logs,"tool-output")}});
    assert.equal(child.error,undefined);
    assert.equal(child.status,1,"a failed turn exits 1: "+child.stderr.slice(-2000));
    const written=JSON.parse(readFileSync(join(logs,"metrics.json"),"utf8"));
    assert.equal(written.turnStatus,"failed");assert.match(written.error,/OpenAI API HTTP 500/);
    const lines=child.stderr.split(/\r?\n/).filter(line=>line.includes("Trebell Native turn failed"));
    assert.equal(lines.length,1,child.stderr);assert.match(lines[0],/^Trebell Native turn failed: OpenAI API HTTP 500: .*server_error.* \(HTTP 500\)$/);
    assert.doesNotMatch(child.stderr,/^\s+at /m,"no stack: "+child.stderr.slice(-2000));
  }finally{rmSync(root,{recursive:true,force:true})}
});
