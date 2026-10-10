import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureFinalDiff, createToolCallLogger } from "../benchmarks/harbor/native-audit-artifacts.mjs";

const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",windowsHide:true});

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
    await rm(root,{recursive:true,force:true});
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
    await rm(root,{recursive:true,force:true});
  }
});

test("Native final diff records why it is unavailable outside a Git workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-final-diff-none-")),path=join(root,"final.diff");
  try{
    const summary=await captureFinalDiff({root,path,environment:{...process.env,GIT_CEILING_DIRECTORIES:root}});
    assert.equal(summary.captured,false);
    assert.match(await readFile(path,"utf8"),/^\[final diff unavailable: /);
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test("Harbor Native runner saves tool calls and the final diff as audit artifacts outside probe runs",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  assert.ok(source.includes("executeTool:toolCallLog.wrap(executor)"));
  assert.ok(source.includes('"/logs/agent/trebell-native-tool-calls.jsonl"'));
  assert.ok(source.includes('"/logs/agent/trebell-native-final.diff"'));
  assert.ok(source.includes("const finalDiff=probeOnly||liveProbe?null:await captureFinalDiff("));
  assert.ok(source.indexOf("await captureFinalDiff(")<source.indexOf("await writeFile(metricsPath"),"the diff is captured before metrics are written");
});
