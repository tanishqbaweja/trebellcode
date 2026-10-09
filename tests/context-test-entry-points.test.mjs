import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryContextEntries } from "../src/context-provenance.mjs";

// Record every child process started while these tests run. The recording wrappers delegate to the originals and are
// installed before a fresh Context Engine module instance loads (the query string bypasses any instance another test
// file already loaded in a shared process), so the engine's child_process bindings are the recording versions.
const spawned=[];
for(const name of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"]){
  const original=childProcess[name];
  const recording=function(...args){spawned.push(String(args[0]));return original.apply(this,args)};
  if(typeof original[promisify.custom]==="function")Object.defineProperty(recording,promisify.custom,{value:(...args)=>{spawned.push(String(args[0]));return original[promisify.custom](...args)}});
  childProcess[name]=recording;
}
syncBuiltinESMExports();
const { ContextEngine, testEntryPoints } = await import("../src/context-engine.mjs?spawn-recording");
const execFileAsync=promisify(childProcess.execFile);

function memoryIo(files,{root="/srv/repo",git={isGit:false,head:null,changed:new Set(),status:"",diff:""}}={}){
  const calls={metadata:[],readMany:[]},state={git};
  return {
    calls,state,root,cacheKey:"memory:"+root,
    discoverFiles:async()=>[...files.keys()],
    metadata:async paths=>{calls.metadata.push([...paths]);return new Map(paths.filter(path=>files.has(path)).map(path=>[path,{size:Buffer.byteLength(files.get(path)),version:"v1"}]))},
    readMany:async paths=>{calls.readMany.push([...paths]);return new Map(paths.filter(path=>files.has(path)).map(path=>[path,files.get(path)]))},
    readText:async path=>files.get(path)??"",
    gitState:async()=>({...state.git,changed:new Set(state.git.changed||[])}),
    relativeFocus:path=>path,
  };
}

test("test entry points come only from conventional runner files at the root or directly under bin, script, scripts, tests, or tools",async()=>{
  const files=new Map([
    ["bin/test","#!/usr/bin/env python\nimport sys\n"],
    ["script/test","#!/bin/sh\nset -e\n"],
    ["scripts/run_tests.sh","echo running\n"],
    ["tests/runtests.py","import sys\n"],
    ["tests/test_x.py","def test_x():\n    assert True\n"],
    ["src/test.py","print('not a runner')\n"],
    ["tox.ini","[tox]\nenvlist = py3\n"],
    ["noxfile.py","import nox\n"],
    ["setup.cfg","[tool:pytest]\n"],
    ["tests/unit/runtests.py","import sys\n"],
    ["docs/test.sh","echo docs\n"],
    ["lib/run_tests.py","import sys\n"],
    ["Tests/test.sh","echo case-sensitive directory\n"],
  ]);
  const io=memoryIo(files),before=spawned.length;
  assert.deepEqual(await testEntryPoints({paths:[...files.keys()],io,limit:10}),[
    {command:"python bin/test",path:"bin/test",source:"detected"},
    {command:"bash script/test",path:"script/test",source:"detected"},
    {command:"bash scripts/run_tests.sh",path:"scripts/run_tests.sh",source:"detected"},
    {command:"python tests/runtests.py",path:"tests/runtests.py",source:"detected"},
  ]);
  assert.deepEqual(io.calls.readMany,[["bin/test","script/test","scripts/run_tests.sh","tests/runtests.py"]],"only candidate runner files are read");
  assert.deepEqual(spawned.slice(before),[],"detection must not start any process");
  assert.deepEqual(await testEntryPoints({paths:["tests/test_x.py","src/test.py","tox.ini","noxfile.py"],io:memoryIo(files)}),[]);
});

test("test entry point invocations follow the file extension or the first-line shebang",async()=>{
  const bom=String.fromCharCode(0xfeff);
  const cases=[
    ["test","#!/usr/bin/env -S python3 -u\nimport sys\n","python test"],
    ["tools/test","#!/usr/bin/python3.12\n","python tools/test"],
    ["bin/test","#!/usr/bin/env bash\nset -e\n","bash bin/test"],
    ["scripts/test","#! /bin/sh\n","bash scripts/test"],
    ["tests/test",bom+"#!/usr/bin/env python\r\nprint('python')\r\n","python tests/test"],
    ["test.sh","#!/usr/bin/env python\n","python test.sh"],
    ["run_tests.sh","set -e\n","bash run_tests.sh"],
    ["tests/test","#!/usr/bin/env node\nconsole.log('#!/usr/bin/env python')\n","tests/test"],
    ["test","echo no shebang\n","./test"],
  ];
  for(const [path,content,command] of cases){
    assert.deepEqual(await testEntryPoints({paths:[path],io:memoryIo(new Map([[path,content]]))}),[{command,path,source:"detected"}],path+" "+JSON.stringify(content));
  }
});

test("declared root test commands come first, match project commands, and the list is capped at three",async()=>{
  const files=new Map([
    ["package.json",JSON.stringify({scripts:{lint:"eslint .",test:"vitest run","test:e2e":"playwright test"}})],
    ["pnpm-lock.yaml","lockfileVersion: 9\n"],
    ["Makefile",".PHONY: test\nbuild:\n\tcc main.c\ntest: build\n\t./run-checks\n"],
    ["justfile","test:\n    cargo test\n"],
    ["web/package.json",JSON.stringify({scripts:{test:"jest"}})],
    ["bin/test","#!/usr/bin/env python\n"],
    ["src/main.js","export function main(){ return 1; }\n"],
  ]);
  const io=memoryIo(files);
  assert.deepEqual(await testEntryPoints({paths:[...files.keys()],io}),[
    {command:"pnpm run test",path:"package.json",source:"declared"},
    {command:"make test",path:"Makefile",source:"declared"},
    {command:"just test",path:"justfile",source:"declared"},
  ]);
  assert.ok(!io.calls.readMany.flat().includes("web/package.json"),"nested manifests have no root-runnable command and are not read");
  assert.deepEqual((await testEntryPoints({paths:[...files.keys()],io:memoryIo(files),limit:10})).map(entry=>entry.command),["pnpm run test","make test","just test","python bin/test"]);
  const commands=await new ContextEngine().projectCommands({root:"/srv/repo",io:memoryIo(files)});
  const declaredTests=commands.declared.filter(item=>item.kind==="test"&&item.name==="test"&&!item.path.includes("/")).map(item=>item.command);
  assert.deepEqual([...new Set(declaredTests)].sort(),["just test","make test","pnpm run test"],"declared entry points use the same commands as project_commands");
  assert.deepEqual(await testEntryPoints({paths:["package.json"],io:memoryIo(new Map([["package.json",JSON.stringify({scripts:{"test:unit":"vitest"}})]]))}),[],"only the canonical test script or target counts as declared");
});

test("npm init's always-failing placeholder test script is not listed as a test entry point",async()=>{
  const placeholder=JSON.stringify({name:"tool",version:"1.0.0",scripts:{test:"echo \"Error: no test specified\" && exit 1"}});
  assert.deepEqual(await testEntryPoints({paths:["package.json"],io:memoryIo(new Map([["package.json",placeholder]]))}),[]);
  const files=new Map([["package.json",placeholder],["scripts/run_tests.sh","echo running\n"]]);
  assert.deepEqual(await testEntryPoints({paths:[...files.keys()],io:memoryIo(files)}),[{command:"bash scripts/run_tests.sh",path:"scripts/run_tests.sh",source:"detected"}]);
});

test("test entry point detection skips oversized and binary candidates",async()=>{
  const binary=String.fromCharCode(0x7f)+"ELF"+String.fromCharCode(2,1,1,0)+"\nbinary";
  const files=new Map([["bin/test","#!/usr/bin/env python\n"+"#".repeat(2048)],["tests/test",binary],["test.sh","echo ok\n"]]);
  const io=memoryIo(files);
  assert.deepEqual(await testEntryPoints({paths:[...files.keys()],io,maxFileBytes:1024}),[{command:"bash test.sh",path:"test.sh",source:"detected"}]);
  assert.ok(!io.calls.readMany.flat().includes("bin/test"),"oversized candidates are never read");
});

test("context packets carry detected test entry points and reuse them only while the repository state is unchanged",async()=>{
  const files=new Map([
    ["src/app.py","def run():\n    return 1\n"],
    ["bin/test","#!/usr/bin/env python\nimport sys\n"],
    ["tests/runtests.py","#!/usr/bin/env python\nimport sys\n"],
  ]);
  const io=memoryIo(files,{git:{isGit:true,head:"head-1",changed:new Set(),status:"",statusFingerprint:"clean",diff:""}});
  const engine=new ContextEngine(),before=spawned.length,runnerReads=()=>io.calls.readMany.filter(paths=>paths.includes("bin/test")).length;
  const expected=[{command:"python bin/test",path:"bin/test",source:"detected"},{command:"python tests/runtests.py",path:"tests/runtests.py",source:"detected"}];
  const build=()=>engine.buildPacket({root:"/srv/repo",io,task:"Fix run"});
  const first=await build();
  assert.deepEqual(first.testEntryPoints,expected);assert.equal(runnerReads(),1);
  assert.ok(first.items.some(item=>item.path==="src/app.py"));
  const second=await build();
  assert.deepEqual(second.testEntryPoints,expected);assert.equal(runnerReads(),1,"clean unchanged repositories must not reread runner files");
  second.testEntryPoints[0].command="mutated";
  assert.deepEqual((await build()).testEntryPoints,expected,"callers cannot mutate the cached detection");

  files.set("bin/test","#!/bin/sh\nexec python -m pytest\n");
  io.state.git={...io.state.git,changed:new Set(["bin/test"]),status:" M bin/test\n",statusFingerprint:"dirty-bin-test"};
  assert.equal((await build()).testEntryPoints[0].command,"bash bin/test");assert.equal(runnerReads(),2);
  await build();
  assert.equal(runnerReads(),3,"a dirty runner can change without any status change, so it is reread");

  files.set("bin/test","#!/usr/bin/env python\n");
  io.state.git={...io.state.git,head:"head-2",changed:new Set(),status:"",statusFingerprint:"clean"};
  assert.deepEqual((await build()).testEntryPoints,expected);assert.equal(runnerReads(),4,"a new HEAD invalidates reuse");
  await build();assert.equal(runnerReads(),4);

  io.state.git={...io.state.git,changed:new Set(["bin/"]),status:"?? bin/\n",statusFingerprint:"untracked-bin"};
  await build();await build();assert.equal(runnerReads(),6,"runners inside an untracked directory are treated as dirty");
  assert.deepEqual(spawned.slice(before),[],"building packets over in-memory I/O must not start any process");
});

test("test entry point read failures never fail the context packet, but cancellation still does",async()=>{
  const files=new Map([["src/app.py","def run():\n    return 1\n"],["bin/test","#!/usr/bin/env python\n"]]);
  const failing=memoryIo(files),readMany=failing.readMany;
  failing.readMany=async(paths,...rest)=>{if(paths.includes("bin/test"))throw new Error("remote read failed");return readMany(paths,...rest)};
  const packet=await new ContextEngine().buildPacket({root:"/srv/repo",io:failing,task:"Fix run"});
  assert.deepEqual(packet.testEntryPoints,[]);assert.ok(packet.items.some(item=>item.path==="src/app.py"));

  const controller=new AbortController(),cancelling=memoryIo(files),original=cancelling.readMany;
  cancelling.readMany=async(paths,...rest)=>{
    if(paths.includes("bin/test")){controller.abort();const error=new Error("cancelled");error.name="AbortError";throw error}
    return original(paths,...rest);
  };
  await assert.rejects(new ContextEngine().buildPacket({root:"/srv/repo",io:cancelling,task:"Fix run",signal:controller.signal}),error=>error?.name==="AbortError");
});

test("a local repository's runner files reach the untrusted Native seed as one bounded line",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-test-entry-"));
  try{
    await mkdir(join(root,"bin"),{recursive:true});await mkdir(join(root,"tests"),{recursive:true});await mkdir(join(root,"src"),{recursive:true});
    await writeFile(join(root,"bin","test"),"#!/usr/bin/env python\nimport sys\n","utf8");
    await writeFile(join(root,"tests","runtests.py"),"#!/usr/bin/env python\nimport sys\n","utf8");
    await writeFile(join(root,"src","calc.py"),"def add(a, b):\n    return a + b\n","utf8");
    await execFileAsync("git",["init","-q"],{cwd:root});await execFileAsync("git",["add","."],{cwd:root});
    const before=spawned.length,packet=await new ContextEngine().buildPacket({root,task:"Fix add"});
    assert.ok(spawned.slice(before).includes("git"),"the recorder must observe the engine's own Git calls, so the no-spawn checks above are meaningful");
    assert.ok(spawned.slice(before).every(command=>command==="git"),"local packets only start Git; detection itself starts nothing");
    assert.deepEqual(packet.testEntryPoints,[
      {command:"python bin/test",path:"bin/test",source:"detected"},
      {command:"python tests/runtests.py",path:"tests/runtests.py",source:"detected"},
    ]);
    const evidence=repositoryContextEntries(packet,{seedOnly:true,currentTask:"Fix add"})["trebell.repo_evidence"],line=evidence.value.split("\n").at(-1);
    assert.equal(evidence.kind,"untrusted");
    assert.equal(line,"Test entry points (detected from repository files; unverified): python bin/test; python tests/runtests.py");
    assert.ok(Buffer.byteLength(line,"utf8")<=200);
  }finally{await rm(root,{recursive:true,force:true})}
});
