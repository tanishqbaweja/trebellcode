import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lingeringJobProcesses, parsePsProcesses, waitForJobProcessDrain } from "../scripts/terminal-bench-process-drain.mjs";
import { launchDetachedDescriptor, readDetachedStatus, writeDetachedDescriptor } from "../scripts/detached-process.mjs";
import { acquireTerminalBenchPairLock, sharedTerminalBenchLockPath } from "../scripts/terminal-bench-pair-lock.mjs";

test("Terminal-Bench pair runner prevents overlapping pairs and saves comparable trial metrics",async()=>{
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/sharedTerminalBenchLockPath/);
  assert.match(source,/rev-parse","--git-common-dir/);
  assert.match(source,/acquireTerminalBenchPairLock/);
  assert.match(source,/SETUP_TIMEOUT_MULTIPLIER/);
  assert.match(source,/AGENT_TIMEOUT_MULTIPLIER/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER\|\|1/);
  assert.match(source,/Terminal-Bench agent timeout multiplier must be > 0/);
  assert.match(source,/agentTimeoutMultiplier:AGENT_TIMEOUT_MULTIPLIER/);
  assert.match(source,/NATIVE_CONTEXT_WINDOW/);
  assert.match(source,/272_000/);
  assert.match(source,/NATIVE_COMPACT_THRESHOLD/);
  assert.match(source,/245_000/);
  assert.match(source,/nativeContextPolicy:/);
  assert.match(source,/TREBELL_HARBOR_CONTEXT_WINDOW:String\(NATIVE_CONTEXT_WINDOW\)/);
  assert.match(source,/TREBELL_HARBOR_COMPACT_THRESHOLD:String\(NATIVE_COMPACT_THRESHOLD\)/);
  assert.match(source,/--agent-timeout-multiplier/);
  assert.match(source,/agentExecutionMs:elapsedMs\(trial\?\.agent_execution\)/);
  assert.match(source,/taskChecksum:trial\?\.task_checksum/);
  assert.match(source,/sourceGitProvenance/);
  assert.match(source,/git\",\[\"rev-parse\",\"HEAD\"\]/);
  assert.match(source,/--untracked-files=no/);
  assert.match(source,/sourceTrackedDiffSha256/);
  assert.match(source,/nativeBundleSha256/);
  assert.match(source,/nativeAdapterSha256/);
  assert.match(source,/NATIVE_PINNED_NODE_VERSION="22\.23\.3"/);
  assert.match(source,/1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af/);
  assert.match(source,/ensurePinnedNodeTarball/);
  assert.match(source,/TREBELL_NODE_PINNED_TARBALL/);
  assert.match(source,/nativePinnedNodeTarballSha256/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_AUTH/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_AUTH\|\|"both"/);
  assert.match(source,/Terminal-Bench Codex auth mode must be api, oauth, or both/);
  assert.match(source,/CODEX_AUTH_MODE==="both"\?\["api","oauth"\]/);
  assert.match(source,/codexAuthMode:CODEX_AUTH_MODE/);
  assert.match(source,/--native-reasoning-context=/);
  assert.match(source,/nativeReasoningContext:NATIVE_REASONING_CONTEXT/);
  assert.match(source,/harnessEnv\.TREBELL_OPENAI_REASONING_CONTEXT=NATIVE_REASONING_CONTEXT/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_INSTALL/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_INSTALL\|\|"pinned"/);
  assert.match(source,/Terminal-Bench Codex install mode must be stock or pinned/);
  assert.match(source,/codexInstallMode:CODEX_INSTALL_MODE/);
  assert.match(source,/codexPinnedTarballSha256/);
  assert.match(source,/codexPinnedAdapterSha256/);
  assert.match(source,/3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb/);
  assert.match(source,/ensurePinnedCodexTarball/);
  assert.match(source,/npm_execpath/);
  assert.match(source,/node_modules","npm","bin","npm-cli\.js/);
  assert.match(source,/shell:process\.platform==="win32"/);
  assert.match(source,/@openai\/codex@\$\{CODEX_PINNED_VERSION\}-linux-x64/);
  assert.match(source,/benchmarks\.harbor\.pinned_codex_agent:PinnedCodexAgent/);
  assert.match(source,/repositoryRootFromGitCommonDir/);
  assert.match(source,/execFileSync\("git",\["rev-parse","--git-common-dir"\]/);
  assert.match(source,/loadEnvFile\(join\(root,"\.env"\)\)/);
  assert.match(source,/loadEnvFile\(join\(repositoryRoot,"\.env"\)\)/);
  assert.match(source,/process\.platform==="win32"\?\{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"\}/);
  assert.match(source,/\.codex-api-auth-/);
  assert.match(source,/harnessEnv\.CODEX_AUTH_JSON_PATH=codexApiAuthPath/);
  assert.match(source,/delete harnessEnv\.OPENAI_API_KEY/);
  assert.match(source,/recoverTrialEvidence/);
  assert.match(source,/recoveredFromTrialFiles/);
  assert.match(source,/recoverNativeEventEvidence/);
  assert.match(source,/recoveredFromNativeEvents/);
  assert.match(source,/recoveredEvidence\?\.inputTokens/);
  assert.match(source,/recoverCodexSessionEvidence/);
  assert.match(source,/recoveredFromCodexSessions/);
  assert.match(source,/comparisonLanes:selectedLanes\.map/);
  assert.match(source,/configuredComparisonLanes:lanes\.map/);
  assert.match(source,/Refusing inherited TREBELL_TERMINAL_BENCH_ONLY/);
  assert.match(source,/const PARALLEL=/);
  assert.match(source,/Promise\.all\(selectedLanes\.map\(\(lane,index\)=>runLane\(lane,index\)\)\)/);
  assert.match(source,/label:`codex-\$\{authMode\}`/);
  assert.match(source,/selectedLanes\.some\(lane=>lane\.label==="codex-oauth"\)/);
  assert.match(source,/selectedLanes\.some\(lane=>lane\.label==="codex-api"\)/);
  assert.match(source,/OPENAI_API_KEY is required for the Codex API benchmark lane/);
  assert.match(source,/CODEX_FORCE_AUTH_JSON="1"/);
  assert.match(source,/delete harnessEnv\.CODEX_AUTH_JSON_PATH/);
  assert.match(source,/delete harnessEnv\.CODEX_FORCE_AUTH_JSON/);
  assert.match(source,/harness,label,agent,jobName,runError,authMode/);
  assert.match(source,/cacheCarryover:trebellNative\.cache_carryover/);
  assert.match(source,/strategy:trebellNative\.strategy/);
  assert.match(source,/reasoningContext:trebellNative\.reasoning_context/);
  assert.match(source,/agentVersion:trial\?\.agent_info\?\.version/);
  assert.match(source,/activeLanes:laneStates\.filter/);
  assert.match(source,/lanes:laneStates\.map/);
  assert.match(source,/terminal-bench-latest\.json/);
  assert.match(source,/waitForJobProcessDrain\(jobName,\{/);
  assert.match(source,/readJobVerifierSummary/);
  assert.match(source,/jobsForPairReport/);
  assert.match(source,/jobs:jobsForPairReport\(jobs\.filter\(Boolean\),\{complete\}\)/);
  assert.match(source,/for\(const job of jobs\.filter\(Boolean\)\)job\.verifierChecks=await readJobVerifierSummary/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_LANE_DRAIN_MS/);
  assert.match(source,/runError=\[runError,drainError\]\.filter\(Boolean\)\.join/);
  assert.match(source,/laneState\.status=runError\?"failed":"finished"/);
  assert.match(source,/writeFile\(reportPath,JSON\.stringify\(report,null,2\)/);
});

test("Terminal-Bench pair lock is shared across worktrees that use one Git common directory",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-global-pair-lock-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourceRoot=join(dir,"source"),worktreeA=join(dir,"worktree-a"),worktreeB=join(dir,"worktree-b"),gitCommon=join(sourceRoot,".git");
  const lockA=sharedTerminalBenchLockPath(worktreeA,gitCommon),lockB=sharedTerminalBenchLockPath(worktreeB,gitCommon);
  assert.equal(lockA,lockB);
  const release=await acquireTerminalBenchPairLock({lockPath:lockA,task:"terminal-bench/example",model:"gpt-test",effort:"max",pid:111,processAliveFn:pid=>pid===111});
  await assert.rejects(
    acquireTerminalBenchPairLock({lockPath:lockB,task:"terminal-bench/other",model:"gpt-test",effort:"max",pid:222,processAliveFn:pid=>pid===111}),
    /Another Terminal-Bench paired run is active/,
  );
  await release();
});

test("Terminal-Bench lane drain detects a real descendant token and clears after exit",async t=>{
  const token=`trebell-lane-drain-${randomUUID()}`;
  assert.deepEqual(await lingeringJobProcesses(token),[]);

  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)",token],{stdio:"ignore",windowsHide:true});
  t.after(()=>{try{child.kill()}catch{}});

  let detected=[];
  for(let attempt=0;attempt<20&&!detected.includes(child.pid);attempt++){
    detected=await lingeringJobProcesses(token);
    if(!detected.includes(child.pid))await new Promise(resolveWait=>setTimeout(resolveWait,50));
  }
  assert.ok(detected.includes(child.pid),`expected spawned pid ${child.pid} in ${JSON.stringify(detected)}`);

  await assert.rejects(
    waitForJobProcessDrain(token,{timeoutMs:100,pollMs:20}),
    /left host processes alive after launcher exit/,
  );

  child.kill();
  await once(child,"exit");
  await waitForJobProcessDrain(token,{timeoutMs:3_000,pollMs:20});
  assert.deepEqual(await lingeringJobProcesses(token),[]);
});

test("Terminal-Bench Unix ps parsing only returns processes containing the exact job token",()=>{
  const token="tb4-native-gpt-6-luna-max-random-task-20260929T010203Z";
  const ps=[
    `  101 node worker.js ${token}`,
    "  202 python unrelated.py",
    `  303 harbor run --job-name ${token}`,
    "not-a-process-line",
  ].join("\n");
  assert.deepEqual(parsePsProcesses(ps,token),[101,303]);
  assert.deepEqual(parsePsProcesses(ps,"missing-job-token"),[]);
});

test("detached process launcher records a harmless child result outside the caller",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-detached-"));
  // On Windows the detached wrapper can remain alive for a few milliseconds
  // after it has persisted the final status, keeping its cwd locked. Let
  // fs.rm retry that expected handoff instead of turning it into a suite flake.
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  const descriptorPath=join(dir,"descriptor.json"),statusPath=join(dir,"status.json"),stdoutPath=join(dir,"stdout.log"),stderrPath=join(dir,"stderr.log");
  await writeDetachedDescriptor(descriptorPath,{
    command:process.execPath,
    args:["-e","setTimeout(()=>console.log('DETACHED_OK'),150)"],
    cwd:dir,stdoutPath,stderrPath,statusPath,
  });
  const launched=await launchDetachedDescriptor({descriptorPath,cwd:dir});
  assert.ok(Number.isInteger(launched.pid)&&launched.pid>0);
  let status=null;
  for(let attempt=0;attempt<100;attempt++){
    status=await readDetachedStatus(statusPath);
    if(status?.state==="finished")break;
    await new Promise(resolveWait=>setTimeout(resolveWait,50));
  }
  assert.equal(status?.state,"finished");
  assert.equal(status?.code,0);
  assert.match(await readFile(stdoutPath,"utf8"),/DETACHED_OK/);
  assert.equal(await readFile(stderrPath,"utf8"),"");
});

test("detached Terminal-Bench wrapper requires live mode and a task",async()=>{
  const source=await readFile(new URL("../scripts/launch-terminal-bench-detached.mjs",import.meta.url),"utf8");
  assert.match(source,/Refusing to launch paid\/live Terminal-Bench without --live/);
  assert.match(source,/requires --task=<task-id>/);
  assert.match(source,/live-terminal-bench-harness-comparison\.mjs/);
  assert.match(source,/\.harbor-validation","detached/);
});

test("Terminal-Bench watchdog persists latest and timestamped history snapshots",async()=>{
  const source=await readFile(new URL("../scripts/terminal-bench-watchdog.mjs",import.meta.url),"utf8");
  assert.match(source,/history\.jsonl/);
  assert.match(source,/snapshot-\$\{stamp\}\.json/);
  assert.match(source,/appendFile\(history,JSON\.stringify\(snap\)/);
  assert.match(source,/terminal-bench-latest\.json/);
});

test("Pinned Harbor Codex adapter changes only installation and verifies the exact official version",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/pinned_codex_agent.py",import.meta.url),"utf8");
  assert.match(source,/class PinnedCodexAgent\(Codex\)/);
  assert.match(source,/_PINNED_VERSION = "0\.158\.0"/);
  assert.match(source,/_PINNED_TARBALL_SHA256/);
  assert.match(source,/hashlib\.sha256/);
  assert.match(source,/SHA-256 mismatch/);
  assert.match(source,/TREBELL_CODEX_PINNED_TARBALL/);
  assert.match(source,/vendor\/x86_64-unknown-linux-musl\/bin\/codex/);
  assert.match(source,/codex --version/);
  assert.match(source,/\/logs\/agent\/codex-sessions/);
  assert.match(source,/ln -s \/logs\/agent\/codex-sessions \/tmp\/codex-home\/sessions/);
  assert.doesNotMatch(source,/async def run\(/);
});

test("Trebell Native Harbor adapter skips package-manager setup when curl already exists",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  assert.match(source,/_PINNED_NODE_VERSION = "22\.23\.3"/);
  assert.match(source,/_PINNED_NODE_TARBALL_SHA256/);
  assert.match(source,/TREBELL_NODE_PINNED_TARBALL/);
  assert.match(source,/tar -xzf/);
  assert.match(source,/Unexpected Node version/);
  assert.match(source,/command -v curl >\/dev\/null 2>&1/);
  assert.match(source,/except Exception:\s+await self\.ensure_system_dependencies\(environment, \("curl",\)\)/);
  assert.ok(source.indexOf("command -v curl")<source.indexOf('ensure_system_dependencies(environment, ("curl",))'));
});

test("Trebell Native Harbor runtime marker is written as root after agent runtime validation",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  assert.match(source,/async def write_runtime_marker\(runtime: str\)/);
  assert.match(source,/runtime_result = await self\.exec_as_agent/);
  assert.match(source,/runtime = str\(runtime_result\.stdout or ""\)\.strip\(\)/);
  assert.match(source,/await self\.exec_as_root\([\s\S]*chmod 0644 \{marker\}/);
  assert.match(source,/await write_runtime_marker\("node"\)/);
  assert.doesNotMatch(source,/printf '%s\\n' (?:bun|node) > \{self\._REMOTE_RUNTIME\}/);
});

test("Terminal-Bench single runner uses an absolute output path and the same safer setup-timeout default",async()=>{
  const source=await readFile(new URL("../scripts/run-terminal-bench.mjs",import.meta.url),"utf8");
  assert.match(source,/TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER\|\|3/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER\|\|1/);
  assert.match(source,/const output=resolve\(root,/);
  assert.match(source,/--agent-setup-timeout-multiplier/);
  assert.match(source,/--agent-timeout-multiplier/);
});
