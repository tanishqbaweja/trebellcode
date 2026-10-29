import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as auditArtifacts from "../benchmarks/harbor/native-audit-artifacts.mjs";
import { captureFinalDiff, createToolCallLogger } from "../benchmarks/harbor/native-audit-artifacts.mjs";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";

const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",windowsHide:true});
const SAFE_ENV=()=>{const env={};for(const key of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"])if(process.env[key])env[key]=process.env[key];return env};

test("Native tool-call log records arguments and results, redacts secret environment values, and rethrows failures",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-tool-call-log-")),path=join(root,"calls.jsonl");
  try{
    const secret="sk-test-0123456789abcdef";
    const log=createToolCallLogger({path,environment:{OPENAI_API_KEY:secret,HOME:"/root",SHORT_TOKEN:"abc"}});
    const run=log.wrap(async call=>{
      if(call.name==="fails")throw new Error("boom "+secret);
      return {success:true,output:"saw "+secret+" "+"x".repeat(9_000)};
    });
    const result=await run({toolCall:1,modelTurn:2,namespace:"trebell_workspace",name:"replace_text",arguments:{path:"tests/test_x.py",oldText:"a",newText:"b"}});
    assert.equal(result.success,true,"the executor's result is returned unchanged");
    await assert.rejects(run({toolCall:2,modelTurn:2,namespace:"trebell_terminal",name:"fails",arguments:{command:"env"}}),/boom/);
    await log.flush();
    const rows=(await readFile(path,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(rows.length,2);
    assert.deepEqual([rows[0].toolCall,rows[0].modelTurn,rows[0].namespace,rows[0].name],[1,2,"trebell_workspace","replace_text"]);
    assert.match(rows[0].arguments,/tests\/test_x\.py/);
    assert.match(rows[0].output,/\[redacted\]/);
    assert.match(rows[0].output,/more chars\]$/,"long outputs are capped");
    assert.ok(rows[0].output.length<8_100);
    assert.match(rows[1].error,/boom \[redacted\]/);
    assert.ok(!JSON.stringify(rows).includes(secret),"no secret value reaches the log");
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("Native tool-call log keeps every hunk of a long replace_text edits list",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-tool-call-log-edits-")),path=join(root,"calls.jsonl");
  try{
    const log=createToolCallLogger({path,environment:{}}),run=log.wrap(async()=>({path:"/repo/src/a.py",size:10,replacements:6,beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),diff:"@@ -1 +1 @@\n-x\n+y"}));
    const edits=Array.from({length:6},(_,index)=>({old_text:`hunk-${index}-old `+"o".repeat(5_000),new_text:`hunk-${index}-new `+"n".repeat(5_000)}));
    await run({toolCall:1,modelTurn:1,namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/a.py",edits}});
    await run({toolCall:2,modelTurn:1,namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/a.py",old_text:"x".repeat(20_000),new_text:"y"}});
    await log.flush();
    const rows=(await readFile(path,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    for(let index=0;index<6;index++){assert.match(rows[0].arguments,new RegExp(`hunk-${index}-old`));assert.match(rows[0].arguments,new RegExp(`hunk-${index}-new`))}
    assert.ok(rows[0].arguments.length<40_000,"each hunk is capped on its own");
    assert.match(rows[0].output,/"beforeSha256":"a{64}","afterSha256":"b{64}"/,"the audit record keeps the hashes the model no longer reads");
    assert.ok(rows[1].arguments.length<16_100,"a single pair keeps the ordinary cap");
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("Native final diff captures tracked edits and untracked files without touching the graded workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-final-diff-")),repo=join(root,"repo"),path=join(root,"final.diff");
  try{
    execFileSync("git",["init","-q",repo],{windowsHide:true});
    git(repo,"config","user.email","test@example.com");git(repo,"config","user.name","Test");
    await writeFile(join(repo,".gitignore"),"ignored.log\n");
    await writeFile(join(repo,"fixture.py"),"def public():\n    pass\n");
    git(repo,"add",".");git(repo,"commit","-q","-m","base");
    await writeFile(join(repo,"fixture.py"),"def public():\n    pass\n\ndef _private_function(name):\n    pass\n");
    await writeFile(join(repo,"repro.py"),"print('repro')\n");
    await writeFile(join(repo,"ignored.log"),"noise\n");
    const statusBefore=git(repo,"status","--porcelain"),indexBefore=(await stat(join(repo,".git","index"))).mtimeMs;
    const summary=await captureFinalDiff({root:repo,path,environment:{...process.env,OPENAI_API_KEY:"sk-never-written-0123456789"}});
    const indexAfter=(await stat(join(repo,".git","index"))).mtimeMs,text=await readFile(path,"utf8");
    assert.equal(summary.captured,true);
    assert.equal(summary.untrackedFiles,1);
    assert.match(text,/\+def _private_function\(name\):/);
    assert.match(text,/=== untracked: repro\.py\nprint\('repro'\)/);
    assert.ok(!text.includes("noise"),"ignored files are not captured");
    assert.equal(indexAfter,indexBefore,"git does not rewrite the index");
    assert.equal(git(repo,"status","--porcelain"),statusBefore,"the workspace state is unchanged");
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

// Native's source-control tools reach a benchmark task that asks for Git work (the shared rule, src/native-configuration.mjs), and their
// commit_all, like git commit in the terminal, moves HEAD: a diff against HEAD would then lose the agent's committed work (review of
// native-one-config, 2026-10-29).
test("the runner's final diff is taken from the commit the task started at, so work the agent committed stays in it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-final-diff-base-")),repo=join(root,"repo"),path=join(root,"final.diff");t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  execFileSync("git",["init","-q",repo],{windowsHide:true});
  git(repo,"config","user.email","test@example.com");git(repo,"config","user.name","Test");
  await writeFile(join(repo,"fixture.py"),"def public():\n    pass\n");
  git(repo,"add",".");git(repo,"commit","-q","-m","base");const start=git(repo,"rev-parse","HEAD").trim();
  const run=await createHarborNativeRun({root:repo,instruction:"Explain fixture.py",manager:{status:()=>({hasKey:true}),close(){}},env:{...SAFE_ENV(),TREBELL_HOME:join(root,"home"),TREBELL_TOOL_OUTPUT_DIR:join(root,"out"),TREBELL_METRICS_PATH:join(root,"m.json"),TREBELL_EVENTS_PATH:join(root,"e.jsonl"),TREBELL_TOOL_CALLS_PATH:join(root,"t.jsonl"),TREBELL_FINAL_DIFF_PATH:path}});
  await run.session.close();
  assert.equal(run.startCommit,start,"the run records the commit it starts from");
  // The agent's work, committed as commit_all or git commit in its terminal would.
  await writeFile(join(repo,"fixture.py"),"def public():\n    return 42\n");git(repo,"commit","-q","-am","agent work");
  const summary=await captureFinalDiff({root:repo,path,environment:SAFE_ENV(),base:run.startCommit});
  assert.equal(summary.captured,true);assert.equal(summary.base,start);
  assert.match(await readFile(path,"utf8"),/\+    return 42/);
  assert.equal(typeof auditArtifacts.gitHeadCommit,"function");
  assert.equal(await auditArtifacts.gitHeadCommit({root:repo,environment:SAFE_ENV()}),git(repo,"rev-parse","HEAD").trim());
  assert.equal(await auditArtifacts.gitHeadCommit({root,environment:{...SAFE_ENV(),GIT_CEILING_DIRECTORIES:root}}),null,"no repository: no start commit");
  const source=await readFile(new URL("../benchmarks/harbor/native-harbor-run.mjs",import.meta.url),"utf8");
  assert.ok(source.includes("captureFinalDiff({root,path:finalDiffPath,environment:env,base:startCommit})"),"the runner diffs from the start commit");
  assert.ok(source.indexOf("const startCommit=await gitHeadCommit(")<source.indexOf("await session.prompt("),"the start commit is read before the agent runs");
});

test("Native final diff records why it is unavailable outside a Git workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-final-diff-none-")),path=join(root,"final.diff");
  try{
    const summary=await captureFinalDiff({root,path,environment:{...process.env,GIT_CEILING_DIRECTORIES:root}});
    assert.equal(summary.captured,false);
    assert.match(await readFile(path,"utf8"),/^\[final diff unavailable: /);
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("Harbor Native runner saves tool calls and the final diff as audit artifacts outside probe runs",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/native-harbor-run.mjs",import.meta.url),"utf8");
  assert.ok(source.includes("executeTool:toolCallLog.wrap(executor)"));
  assert.ok(source.includes('"/logs/agent/trebell-native-tool-calls.jsonl"'));
  assert.ok(source.includes('"/logs/agent/trebell-native-final.diff"'));
  assert.ok(source.includes("const finalDiff=probeOnly||liveProbe?null:await captureFinalDiff("));
  assert.ok(source.indexOf("await captureFinalDiff(")<source.indexOf("await writeFile(metricsPath"),"the diff is captured before metrics are written");
});
