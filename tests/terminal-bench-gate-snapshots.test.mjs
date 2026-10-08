import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalBenchTaskArtifactsFromToml } from "../scripts/terminal-bench-task-cache.mjs";
import { createGateSnapshotter, gateSnapshotRelativePath, parseGateSnapshotArtifacts } from "../benchmarks/harbor/native-gate-snapshots.mjs";
import { buildGateSnapshotTrial, listGateSnapshots, taskPathFromTrialConfig } from "../scripts/terminal-bench-gate-regrade.mjs";

test("Terminal-Bench task artifacts parse every declared TOML shape",()=>{
  assert.deepEqual(terminalBenchTaskArtifactsFromToml(`artifacts = ["/app/score.musicxml"]\n[task]\nname = "x"\n`),[{source:"/app/score.musicxml",exclude:[],service:null}]);
  assert.deepEqual(terminalBenchTaskArtifactsFromToml(`# header\nartifacts = [\n    "/app/a/",  # first\n    "/app/b.json",\n]\n`),[{source:"/app/a/",exclude:[],service:null},{source:"/app/b.json",exclude:[],service:null}]);
  assert.deepEqual(terminalBenchTaskArtifactsFromToml(`artifacts = [\n  { source = "/usr/lib/pkg", exclude = ["./a.py", "__pycache__", "*.pyc"] },\n  { source = "/shared/out.json", service = "api" },\n]\n`),[
    {source:"/usr/lib/pkg",exclude:["./a.py","__pycache__","*.pyc"],service:null},
    {source:"/shared/out.json",exclude:[],service:"api"},
  ]);
  assert.deepEqual(terminalBenchTaskArtifactsFromToml(`[task]\nname = "no-artifacts"\n`),[]);
});

test("Native gate snapshot artifacts accept only absolute container paths",()=>{
  assert.deepEqual(parseGateSnapshotArtifacts(JSON.stringify(["/app/x.json",{source:"/app/src/",exclude:["*.pyc"]},"relative.txt","/app/../etc/passwd",{source:""}])),[
    {source:"/app/x.json",exclude:[]},{source:"/app/src/",exclude:["*.pyc"]},
  ]);
  assert.deepEqual(parseGateSnapshotArtifacts("not json"),[]);
  assert.equal(gateSnapshotRelativePath("/app/src/"),"app/src");
  assert.equal(gateSnapshotRelativePath("C:\\work\\out.json"),"work\\out.json");
});

test("Native gate snapshotter copies declared deliverables per gate without touching the workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-gate-snapshots-"));
  try{
    const work=join(root,"work"),src=join(work,"src"),out=join(root,"logs");
    await mkdir(join(src,"__pycache__"),{recursive:true});
    await writeFile(join(work,"result.json"),"{\"v\":1}");await writeFile(join(src,"main.py"),"print(1)\n");await writeFile(join(src,"skip.pyc"),"x");await writeFile(join(src,"__pycache__","c.pyc"),"x");
    await writeFile(join(work,"huge.bin"),Buffer.alloc(4096,1));
    const snapshotter=createGateSnapshotter({artifacts:[{source:join(work,"result.json"),exclude:[]},{source:src+"/",exclude:["*.pyc","__pycache__"]},{source:join(work,"absent.txt"),exclude:[]},{source:join(work,"huge.bin"),exclude:[]}],directory:out,maxBytesPerSnapshot:1024});
    assert.equal(snapshotter.enabled,true);
    const first=snapshotter.snapshot({modelTurn:7,editRevision:2});
    assert.deepEqual(first.entries.map(item=>item.status),["ok","ok","missing","too_large"]);
    assert.equal(first.modelTurn,7);assert.equal(first.index,1);
    const gate1=join(out,"gate-1","artifacts");
    assert.equal(await readFile(join(gate1,gateSnapshotRelativePath(join(work,"result.json"))),"utf8"),"{\"v\":1}");
    assert.deepEqual((await readdir(join(gate1,gateSnapshotRelativePath(src)))).sort(),["main.py"]);
    await writeFile(join(work,"result.json"),"{\"v\":2}");
    const second=snapshotter.snapshot({modelTurn:9});
    assert.equal(second.index,2);assert.equal(snapshotter.count,2);
    assert.equal(await readFile(join(out,"gate-2","artifacts",gateSnapshotRelativePath(join(work,"result.json"))),"utf8"),"{\"v\":2}");
    assert.equal(await readFile(join(gate1,gateSnapshotRelativePath(join(work,"result.json"))),"utf8"),"{\"v\":1}");
    assert.equal(await readFile(join(work,"result.json"),"utf8"),"{\"v\":2}");
    assert.equal(createGateSnapshotter({artifacts:[],directory:out}).snapshot(),null);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Gate regrade builds exact synthetic trials from snapshots and flags uncaptured deliverables",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-gate-regrade-"));
  try{
    const trial=join(root,"trial");
    await mkdir(join(trial,"artifacts","app","src"),{recursive:true});await mkdir(join(trial,"verifier"),{recursive:true});
    await writeFile(join(trial,"config.json"),JSON.stringify({task:{name:"terminal-bench/example",ref:"sha256:abc123"},trial_name:"example__1"}));
    await writeFile(join(trial,"result.json"),"{}");await writeFile(join(trial,"verifier","reward.txt"),"0");
    await writeFile(join(trial,"artifacts","app","out.json"),"final");await writeFile(join(trial,"artifacts","app","src","m.py"),"final-src");await writeFile(join(trial,"artifacts","app","extra.txt"),"final-extra");
    await writeFile(join(trial,"artifacts","manifest.json"),JSON.stringify([
      {source:"/logs/artifacts",destination:"artifacts/logs/artifacts",type:"directory",status:"empty",service:null,exclude:[]},
      {source:"/app/out.json",destination:"artifacts/app/out.json",type:"file",status:"ok",service:null,exclude:[]},
      {source:"/app/src/",destination:"artifacts/app/src",type:"directory",status:"ok",service:null,exclude:[]},
      {source:"/app/extra.txt",destination:"artifacts/app/extra.txt",type:"file",status:"ok",service:null,exclude:[]},
    ]));
    const gate=join(trial,"agent","gate-snapshots","gate-1");
    await mkdir(join(gate,"artifacts","app","src"),{recursive:true});await mkdir(join(trial,"agent"),{recursive:true});await writeFile(join(trial,"agent","trebell-native-events.jsonl"),"{}\n");
    await writeFile(join(gate,"artifacts","app","out.json"),"gate-1");await writeFile(join(gate,"artifacts","app","src","m.py"),"gate-1-src");
    await writeFile(join(gate,"snapshot.json"),JSON.stringify({index:1,modelTurn:12,entries:[{source:"/app/out.json",status:"ok"},{source:"/app/src/",status:"ok"},{source:"/app/extra.txt",status:"missing"}]}));
    const snapshots=await listGateSnapshots(trial);assert.equal(snapshots.length,1);assert.equal(snapshots[0].manifest.modelTurn,12);
    const destination=join(root,"synthetic","example__1-gate-1");
    const built=await buildGateSnapshotTrial({trialDir:trial,snapshot:snapshots[0],destination});
    assert.equal(built.exact,true);assert.deepEqual(built.gaps,[]);
    assert.equal(await readFile(join(destination,"artifacts","app","out.json"),"utf8"),"gate-1");
    assert.equal(await readFile(join(destination,"artifacts","app","src","m.py"),"utf8"),"gate-1-src");
    assert.equal(existsSync(join(destination,"artifacts","app","extra.txt")),false);
    assert.equal(existsSync(join(destination,"verifier")),false);assert.equal(existsSync(join(destination,"agent","gate-snapshots")),false);
    assert.equal(existsSync(join(destination,"agent","trebell-native-events.jsonl")),true);
    const manifest=JSON.parse(await readFile(join(destination,"artifacts","manifest.json"),"utf8"));
    assert.equal(manifest.find(item=>item.source==="/app/extra.txt").status,"missing");
    await writeFile(join(gate,"snapshot.json"),JSON.stringify({index:1,entries:[{source:"/app/out.json",status:"ok"},{source:"/app/src/",status:"too_large"}]}));
    const partial=await buildGateSnapshotTrial({trialDir:trial,snapshot:(await listGateSnapshots(trial))[0],destination});
    assert.equal(partial.exact,false);assert.deepEqual(partial.gaps.map(item=>item.source),["/app/src/","/app/extra.txt"]);
    assert.equal(await readFile(join(destination,"artifacts","app","src","m.py"),"utf8"),"final-src");
    assert.equal(taskPathFromTrialConfig({task:{name:"terminal-bench/example",ref:"sha256:abc123"}},{home:"/home/u"}).replace(/\\/g,"/"),"/home/u/.cache/harbor/tasks/packages/terminal-bench/example/abc123");
    assert.equal(taskPathFromTrialConfig({task:{name:"../x",ref:"sha256:1"}}),null);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Gate snapshot paths reach only the Native lane and are captured at completion gates",async()=>{
  const comparison=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(comparison,/nativeGateSnapshotArtifacts=\(await terminalBenchCachedTaskArtifacts\(/);
  assert.match(comparison,/filter\(item=>!item\.service\)/);
  assert.match(comparison,/harnessEnv\.TREBELL_HARBOR_GATE_SNAPSHOT_PATHS=JSON\.stringify\(nativeGateSnapshotArtifacts\)/);
  assert.match(comparison,/\}else delete harnessEnv\.TREBELL_HARBOR_GATE_SNAPSHOT_PATHS;/);
  const adapter=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  assert.match(adapter,/env\["TREBELL_HARBOR_GATE_SNAPSHOT_PATHS"\] = gate_snapshot_paths/);
  const runner=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  assert.match(runner,/row\.name==="native\.completion\.gate_requested"\)\{try\{gateSnapshots\.snapshot\(/);
  assert.match(runner,/gateSnapshots:gateSnapshots\.count/);
});
