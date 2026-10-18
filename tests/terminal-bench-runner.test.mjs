import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harborLaneProcessCommand, lingeringJobProcesses, parsePsProcesses, parseWindowsProcessRows, waitForJobProcessDrain } from "../scripts/terminal-bench-process-drain.mjs";
import { launchDetachedDescriptor, readDetachedStatus, writeDetachedDescriptor } from "../scripts/detached-process.mjs";
import { windowsHarborEnv } from "../scripts/harbor-process-env.mjs";
import { acquireTerminalBenchPairLock, sharedTerminalBenchLockPath, sharedTerminalBenchNativeRerunLockPath } from "../scripts/terminal-bench-pair-lock.mjs";
import { cleanupSealedExitedHarborEnvironments, isAgentAuthenticationFailure, isDockerExecTransportFailure, isDockerImagePullFailure, isNativeAgentExternalTermination, isPreAgentDockerImagePullFailure, isPreAgentDockerSubnetExhaustion, sealedHarborEnvironmentProjects } from "../scripts/terminal-bench-docker-recovery.mjs";
import { benchmarkRunPrefix, preflightTerminalBenchDatasetTaskMembership, preflightTerminalBenchNetworkPolicy, terminalBenchTaskNoNetworkSectionsFromToml, prewarmTerminalBenchDockerImages, prewarmTerminalBenchTaskCache, terminalBenchDatasetTaskNamesFromVersionMetadata, terminalBenchTaskDockerImagesFromToml, terminalBenchTaskPackageRef, terminalBenchTaskQualifiedName, verifierDownloadCacheArgs } from "../scripts/terminal-bench-task-cache.mjs";
import { rewriteIndex, upstreamFor } from "../scripts/verifier-download-cache.mjs";
import { isSweBenchDataset, sweBenchVerifierReportMissing } from "../scripts/terminal-bench-verifier-summary.mjs";

test("Terminal-Bench pair runner prevents overlapping pairs and saves comparable trial metrics",async()=>{
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  const singleRunnerSource=await readFile(new URL("../scripts/run-terminal-bench.mjs",import.meta.url),"utf8");
  const detachedSource=await readFile(new URL("../scripts/detached-process.mjs",import.meta.url),"utf8");
  const nativeRunnerSource=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  const nativeAdapterSource=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  const pinnedCodexAdapterSource=await readFile(new URL("../benchmarks/harbor/pinned_codex_agent.py",import.meta.url),"utf8");
  assert.match(source,/sharedTerminalBenchLockPath/);
  assert.match(source,/sharedTerminalBenchNativeRerunLockPath/);
  assert.match(source,/rev-parse","--git-common-dir/);
  assert.match(source,/acquireTerminalBenchPairLock/);
  assert.match(source,/SETUP_TIMEOUT_MULTIPLIER/);
  assert.match(source,/AGENT_TIMEOUT_MULTIPLIER/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER\|\|1/);
  assert.match(source,/Terminal-Bench agent timeout multiplier must be > 0/);
  assert.match(source,/agentTimeoutMultiplier:AGENT_TIMEOUT_MULTIPLIER/);
  assert.match(source,/usesBaseAgentTimeout:AGENT_TIMEOUT_MULTIPLIER===1/);
  assert.match(source,/timeoutComparability:AGENT_TIMEOUT_MULTIPLIER===1\?"benchmark-base":"extended-agent-timeout"/);
  assert.match(source,/const PARALLEL=!sequentialRequested/);
  assert.match(source,/prewarmTerminalBenchTaskCache/);
  assert.match(source,/prewarmTerminalBenchDockerImages/);
  assert.match(source,/preflightTerminalBenchDatasetTaskMembership/);
  assert.match(source,/datasetMembershipPreflight/);
  assert.match(source,/PARALLEL&&selectedLanes\.length>1/);
  assert.match(source,/taskCachePrewarm/);
  assert.match(source,/dockerImagePrewarm/);
  assert.match(source,/--sequential/);
  assert.match(source,/cannot be both --parallel and --sequential/);
  assert.match(nativeRunnerSource,/const semanticCompletionGate=String\(process\.env\.TREBELL_HARBOR_SEMANTIC_GATE\|\|""\)\.trim\(\)==="1";/);
  assert.match(nativeRunnerSource,/^  semanticCompletionGate,$/m);
  assert.match(nativeAdapterSource,/TREBELL_HARBOR_SEMANTIC_GATE/);
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
  assert.match(source,/sourceTrackedChanges/);
  assert.match(source,/sourceTrackedDiffSha256/);
  assert.match(source,/assertCleanTrackedSource\(sourceProvenance\)/);
  assert.match(source,/Refusing paid\/live Terminal-Bench launch from a tracked-dirty source tree/);
  assert.match(source,/tracked source cleanliness could not be verified/);
  assert.match(source,/nativeBundleSha256/);
  assert.match(source,/nativeAdapterSha256/);
  assert.ok(source.includes('agentTimeoutStopSha256=await sha256File(join(root,"benchmarks","harbor","agent_timeout_stop.py"))'));
  assert.match(source,/nativeAdapterSha256,agentTimeoutStopSha256,/);
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
  assert.match(source,/TREBELL_TERMINAL_BENCH_SERVICE_TIER\|\|"fast"/);
  assert.match(source,/Terminal-Bench service tier must be default or fast/);
  assert.match(source,/sameServiceTier:true/);
  assert.match(source,/sameHostedWebSearchPolicy:true/);
  assert.match(source,/hostedWebSearch:"disabled"/);
  assert.match(source,/serviceTier:SERVICE_TIER/);
  assert.match(source,/service_tier=fast/);
  assert.match(source,/web_search=disabled/);
  assert.match(source,/Fast comparison requires the pinned Codex adapter/);
  assert.match(nativeRunnerSource,/TREBELL_SERVICE_TIER\|\|"fast"/);
  assert.match(nativeRunnerSource,/serviceTier:serviceTier==="default"\?null:serviceTier/);
  assert.match(nativeAdapterSource,/service_tier: Literal\["default", "fast"\]/);
  assert.match(nativeAdapterSource,/"TREBELL_SERVICE_TIER": self\.options\.service_tier/);
  assert.match(pinnedCodexAdapterSource,/class PinnedCodexOptions\(CodexOptions\)/);
  assert.match(pinnedCodexAdapterSource,/service_tier=\{value\}/);
  assert.match(pinnedCodexAdapterSource,/web_search=\{value\}/);
  // ChatGPT connectors (codex_apps MCP) expose connector web search even with web_search disabled.
  assert.match(pinnedCodexAdapterSource,/features\.apps=\{value\}/);
  // Harbor parses --ak apps=false into the boolean False, so the option must accept it.
  assert.match(pinnedCodexAdapterSource,/BeforeValidator\(_lowercase_bool\)/);
  assert.match(source,/\["--ak","apps=false"\]/);
  assert.match(pinnedCodexAdapterSource,/default="disabled"/);
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
  assert.match(source,/windowsHide:true/);
  assert.match(singleRunnerSource,/windowsHide:true/);
  assert.doesNotMatch(singleRunnerSource,/windowsHide:false/);
  assert.match(detachedSource,/Start-Process/);
  assert.match(detachedSource,/-WindowStyle Hidden/);
  assert.match(detachedSource,/win32-hidden-start-process/);
  assert.match(source,/@openai\/codex@\$\{CODEX_PINNED_VERSION\}-linux-x64/);
  assert.match(source,/benchmarks\.harbor\.pinned_codex_agent:PinnedCodexAgent/);
  assert.match(source,/repositoryRootFromGitCommonDir/);
  assert.match(source,/execFileSync\("git",\["rev-parse","--git-common-dir"\]/);
  assert.match(source,/loadEnvFile\(join\(root,"\.env"\)\)/);
  assert.match(source,/loadEnvFile\(join\(repositoryRoot,"\.env"\)\)/);
  assert.match(source,/\.\.\.windowsHarborEnv\(process\.env\)/);
  assert.match(source,/\.codex-api-auth-/);
  assert.match(source,/harnessEnv\.CODEX_AUTH_JSON_PATH=codexApiAuthPath/);
  assert.match(source,/delete harnessEnv\.OPENAI_API_KEY/);
  assert.match(source,/recoverTrialEvidence/);
  assert.match(source,/recoveredFromTrialFiles/);
  assert.match(source,/recoverNativeEventEvidence/);
  assert.match(source,/recoveredFromNativeEvents/);
  assert.match(source,/recoverDroppedNativeTrial/);
  assert.match(source,/STANDALONE_NATIVE_RERUN&&harness==="native"/);
  assert.match(source,/args\.push\("--no-delete"\)/);
  assert.match(source,/nativeEnvironmentRetention:STANDALONE_NATIVE_RERUN/);
  assert.match(source,/recoveredByRegrade/);
  assert.match(source,/regradeTrialDir/);
  assert.match(source,/cleanupDockerProject/);
  assert.match(source,/cleanupSealedExitedHarborEnvironments/);
  assert.match(source,/isPreAgentDockerSubnetExhaustion/);
  assert.match(source,/isPreAgentDockerImagePullFailure/);
  assert.match(source,/isDockerImagePullFailure/);
  assert.match(source,/isDockerExecTransportFailure/);
  assert.match(source,/docker_subnet_exhaustion/);
  assert.match(source,/docker_image_pull_failure/);
  assert.match(source,/docker_exec_transport_failure/);
  assert.match(source,/infrastructureFailureReason/);
  assert.match(source,/infrastructureInterrupted:/);
  assert.match(source,/infrastructureComparable:/);
  assert.match(source,/preTrialRunnerFailure=Boolean\(runnerError\)&&!failedTrial/);
  assert.match(source,/if\(subnetExhaustion\|\|imagePullFailure\|\|preTrialRunnerFailure\)\{/);
  assert.match(source,/retryPreTrialRunnerFailure=Boolean\(runnerError\)&&!retryTrial/);
  assert.match(source,/pre_trial_runner_failure/);
  assert.doesNotMatch(source,/if\(subnetExhaustion\|\|dockerExecTransportFailure\)/);
  assert.match(source,/const failedTrial=await trialResult\(outputRoot,jobName\)/);
  assert.match(source,/trialInfrastructureFailure:/);
  assert.match(source,/retryJobName=jobName\+"-retry1"/);
  assert.match(source,/readTrialVerifierSummary/);
  assert.match(source,/recoveredEvidence\?\.inputTokens/);
  assert.match(source,/recoverCodexSessionEvidence/);
  // The ChatGPT backend reports no cache writes, so the OAuth lane is priced like the API lanes for the same token flow.
  assert.match(source,/recoverCodexSessionEvidence\(outputRoot,jobName,\{serviceTier:SERVICE_TIER,cacheWritesUnreported:authMode==="oauth"\}\)/);
  assert.match(source,/apiEquivalentCostAsReportedUsd:/);
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
  assert.match(source,/TREBELL_CODEX_OAUTH_AUTH_JSON/);
  assert.match(source,/\.trebell-codex-oauth","auth\.json"/);
  assert.match(source,/harnessEnv\.CODEX_AUTH_JSON_PATH=codexOauthAuthPath/);
  assert.doesNotMatch(source,/join\(homedir\(\),"\.codex","auth\.json"\)/);
  assert.doesNotMatch(source,/CODEX_FORCE_AUTH_JSON="1"/);
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
  assert.match(source,/trialProcessDrainNeedles\(outputRoot,jobName\)/);
  assert.match(source,/waitForJobProcessDrain\(jobName,\{timeoutMs:LANE_DRAIN_TIMEOUT_MS,cwd:root,additionalNeedles,outputRoot\}/);
  assert.match(source,/readJobVerifierSummary/);
  assert.match(source,/jobsForPairReport/);
  assert.match(source,/jobs:jobsForPairReport\(jobs\.filter\(Boolean\),\{complete\}\)/);
  assert.match(source,/for\(const job of jobs\.filter\(Boolean\)\)\{/);
  assert.match(source,/job\.regradeTrialDir\?await readTrialVerifierSummary\(job\.regradeTrialDir\):await readJobVerifierSummary/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_LANE_DRAIN_MS/);
  assert.match(source,/runError=\[runError,drainError\]\.filter\(Boolean\)\.join/);
  assert.match(source,/lane evidence recovery failed:/);
  assert.match(source,/exceptionType:"LaneEvidenceRecoveryError"/);
  assert.match(source,/verifier summary recovery failed:/);
  assert.match(source,/job\.verifierChecks=null/);
  assert.match(source,/const laneFailed=Boolean\(runError\)\|\|Number\(jobs\[laneIndex\]\?\.errors\|\|0\)>0\|\|Number\(jobs\[laneIndex\]\?\.completed\|\|0\)<1/);
  assert.match(source,/laneState\.status=jobs\[laneIndex\]\?\.infrastructureFailureReason\?"infrastructure-failed":laneFailed\?"failed":"finished"/);
  assert.match(source,/writeFile\(reportPath,JSON\.stringify\(report,null,2\)/);
});

test("Terminal-Bench parallel task cache prewarm derives the exact dataset task version",async()=>{
  assert.equal(terminalBenchTaskQualifiedName("terminal-bench/terminal-bench@4.0.0","example-task"),"terminal-bench/example-task");
  assert.equal(terminalBenchTaskQualifiedName("terminal-bench/terminal-bench@4.0.0","terminal-bench/example-task"),"terminal-bench/example-task");
  assert.equal(terminalBenchTaskQualifiedName("other-org/dataset@v2","terminal-bench/example-task"),null);
  assert.equal(terminalBenchTaskPackageRef("terminal-bench/terminal-bench@4.0.0","terminal-bench/example-task"),"terminal-bench/example-task@4.0.0");
  assert.equal(terminalBenchTaskPackageRef("terminal-bench/terminal-bench@4.0.0","example-task"),"terminal-bench/example-task@4.0.0");
  assert.equal(terminalBenchTaskPackageRef("other-org/dataset@v2","terminal-bench/example-task"),null);
  assert.equal(terminalBenchTaskPackageRef("terminal-bench/terminal-bench","terminal-bench/example-task"),null);
  const calls=[];
  const result=await prewarmTerminalBenchTaskCache({
    harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"terminal-bench/example-task",env:{SAFE:"1"},
    runFn:async(command,args,options)=>{calls.push({command,args,options})},
  });
  assert.deepEqual(result,{packageRef:"terminal-bench/example-task@4.0.0",completed:true});
  assert.deepEqual(calls,[{command:"harbor-test",args:["task","download","terminal-bench/example-task@4.0.0","--cache"],options:{env:{SAFE:"1"}}}]);
  await assert.rejects(()=>prewarmTerminalBenchTaskCache({harbor:"h",dataset:"local-dataset",task:"terminal-bench/example-task",runFn:async()=>{}}),/Cannot derive a registry task package ref/);
});

test("Terminal-Bench paid runner preflights authoritative dataset membership before task download",async()=>{
  const metadata={version:"4.0.0",revision:"rev-4",content_hash:"dataset-sha",tasks:[
    {available:true,task_version:{package:{name:"example-task",org:{name:"terminal-bench"}}}},
    {available:true,task_version:{package:{name:"second-task",org:{name:"terminal-bench"}}}},
    {available:false,task_version:{package:{name:"withdrawn-task",org:{name:"terminal-bench"}}}},
    {available:true,task_version:{package:{name:"wrong-org-task",org:{name:"other-org"}}}},
  ]};
  assert.deepEqual(terminalBenchDatasetTaskNamesFromVersionMetadata(metadata,{namespace:"terminal-bench"}),["example-task","second-task"]);
  const calls=[];
  const result=await preflightTerminalBenchDatasetTaskMembership({
    harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",env:{SAFE:"1"},
    captureFn:async(command,args,options)=>{calls.push({command,args,options});return JSON.stringify(metadata)},
  });
  assert.deepEqual(result,{completed:true,qualifiedTask:"terminal-bench/example-task",taskCount:2,datasetVersion:"4.0.0",datasetRevision:"rev-4",datasetContentHash:"dataset-sha",attempts:1});
  assert.deepEqual(calls,[{command:"harbor-test",args:["version","show","terminal-bench/terminal-bench@4.0.0","--tasks","--json"],options:{env:{SAFE:"1"}}}]);
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"stale-task",captureFn:async()=>JSON.stringify(metadata)}),/not a member of dataset/);
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",captureFn:async()=>"not-json"}),/Cannot parse dataset membership metadata/);
});

test("Terminal-Bench dataset membership preflight asks the registry again after a failed query, and never after an answer",async()=>{
  const metadata={version:"4.0.0",revision:"rev-4",content_hash:"dataset-sha",tasks:[{available:true,task_version:{package:{name:"example-task",org:{name:"terminal-bench"}}}}]};
  const dataset="terminal-bench/terminal-bench@4.0.0",waits=[],sleepFn=async ms=>{waits.push(ms)};
  let calls=0;
  const result=await preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset,task:"example-task",sleepFn,captureFn:async()=>{
    calls++;if(calls<3)throw new Error("harbor-test exited with 1: Error: canceling statement due to statement timeout");return JSON.stringify(metadata);
  }});
  assert.equal(result.attempts,3);
  assert.equal(calls,3);
  assert.deepEqual(waits,[15_000,45_000]);
  calls=0;waits.length=0;
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset,task:"example-task",sleepFn,captureFn:async()=>{calls++;throw new Error("harbor-test exited with 1: Error: The read operation timed out")}}),
    /^Error: Cannot verify dataset membership for terminal-bench\/example-task in terminal-bench\/terminal-bench@4\.0\.0 after 3 attempts: harbor-test exited with 1: Error: The read operation timed out$/);
  assert.equal(calls,3);
  assert.deepEqual(waits,[15_000,45_000]);
  // An answer that arrived is the registry's answer: a task it does not list, or output that is not JSON, is refused at once.
  for(const [task,output,refusal] of [["stale-task",JSON.stringify(metadata),/not a member of dataset/],["example-task","not-json",/Cannot parse dataset membership metadata/]]){
    calls=0;waits.length=0;
    await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset,task,sleepFn,captureFn:async()=>{calls++;return output}}),refusal);
    assert.equal(calls,1);
    assert.deepEqual(waits,[]);
  }
  calls=0;
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset,task:"example-task",attempts:1,sleepFn,captureFn:async()=>{calls++;throw new Error("down")}}),/after 1 attempt: down$/);
  assert.equal(calls,1);
});

test("Terminal-Bench parallel Docker prewarm pulls declared agent and verifier images once before lane fan-out",async()=>{
  const parsed=terminalBenchTaskDockerImagesFromToml(`
[environment]
docker_image = "registry.example/task-env@sha256:abc"
[verifier.environment]
docker_image = "registry.example/task-verifier@sha256:def"
`);
  assert.deepEqual(parsed,[
    {role:"agent",image:"registry.example/task-env@sha256:abc"},
    {role:"verifier",image:"registry.example/task-verifier@sha256:def"},
  ]);
  const root=await mkdtemp(join(tmpdir(),"trebell-tb-image-prewarm-"));
  try{
    const versionDir=join(root,"content-hash");await mkdir(versionDir,{recursive:true});
    await writeFile(join(versionDir,"task.toml"),`[task]\nname = "terminal-bench/example-task"\n[environment]\ndocker_image = "registry.example/task-env@sha256:abc"\n[verifier.environment]\ndocker_image = "registry.example/task-verifier@sha256:def"\n`);
    const pulls=[],inspects=[];
    const result=await prewarmTerminalBenchDockerImages({
      dataset:"terminal-bench/terminal-bench@4.0.0",task:"terminal-bench/example-task",cacheRoot:root,env:{SAFE:"1"},
      captureFn:async(command,args,options)=>{inspects.push({command,args,options});if(args.at(-1).includes("task-env"))return "present";throw new Error("missing")},
      runFn:async(command,args,options)=>{pulls.push({command,args,options})},
    });
    assert.equal(result.completed,true);assert.equal(result.taskTomlFound,true);
    assert.deepEqual(inspects.map(call=>call.args),[
      ["image","inspect","registry.example/task-env@sha256:abc"],
      ["image","inspect","registry.example/task-verifier@sha256:def"],
    ]);
    assert.deepEqual(pulls,[{command:"docker",args:["pull","registry.example/task-verifier@sha256:def"],options:{env:{SAFE:"1"}}}]);
    assert.deepEqual(result.attempts.map(item=>({role:item.role,status:item.status,attempt:item.attempt})),[
      {role:"agent",status:"already-present",attempt:0},
      {role:"verifier",status:"pulled",attempt:1},
    ]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Terminal-Bench Docker prewarm retries one transient pull serially and then stops",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-tb-image-retry-"));
  try{
    const versionDir=join(root,"content-hash");await mkdir(versionDir,{recursive:true});
    await writeFile(join(versionDir,"task.toml"),`[environment]\ndocker_image = "registry.example/task-env@sha256:abc"\n`);
    let calls=0;
    const result=await prewarmTerminalBenchDockerImages({dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",cacheRoot:root,maxAttempts:3,captureFn:async()=>{throw new Error("missing")},runFn:async()=>{calls++;if(calls<2)throw new Error("unexpected EOF")}});
    assert.equal(calls,2);assert.deepEqual(result.attempts.map(item=>item.status),["failed","pulled"]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Terminal-Bench network preflight refuses no-network tasks before inference when Docker cannot enforce them",async()=>{
  assert.deepEqual(terminalBenchTaskNoNetworkSectionsFromToml(`[environment]\nallow_internet = true\n[verifier.environment]\ncpus = 2\nallow_internet = false\n[agent]\nallow_internet = false\n`),["verifier.environment"]);
  assert.deepEqual(terminalBenchTaskNoNetworkSectionsFromToml(`[environment]\ndocker_image = "x"\n`),[]);
  const root=await mkdtemp(join(tmpdir(),"trebell-tb-network-preflight-"));
  try{
    const versionDir=join(root,"content-hash");await mkdir(versionDir,{recursive:true});
    const options={dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",cacheRoot:root,env:{SAFE:"1"}};
    await writeFile(join(versionDir,"task.toml"),`[environment]\ndocker_image = "registry.example/env@sha256:abc"\n`);
    let probes=0;
    const open=await preflightTerminalBenchNetworkPolicy({...options,captureFn:async()=>{probes++;return ""}});
    assert.equal(open.taskTomlFound,true);assert.deepEqual(open.noNetworkSections,[]);assert.equal(probes,0);
    await writeFile(join(versionDir,"task.toml"),`[environment]\ndocker_image = "registry.example/env@sha256:abc"\n[verifier.environment]\nallow_internet = false\n`);
    const calls=[];
    const enforced=await preflightTerminalBenchNetworkPolicy({...options,captureFn:async(command,args,captureOptions)=>{calls.push({command,args,captureOptions});return ""}});
    assert.equal(enforced.egressControlSupported,true);assert.deepEqual(enforced.noNetworkSections,["verifier.environment"]);
    assert.equal(calls.length,1);assert.equal(calls[0].command,"docker");assert.deepEqual(calls[0].args.slice(0,3),["container","run","--rm"]);assert.match(calls[0].args.at(-1),/CONFIG_NFT_FIB_INET/);assert.deepEqual(calls[0].captureOptions,{env:{SAFE:"1"}});
    await assert.rejects(preflightTerminalBenchNetworkPolicy({...options,captureFn:async()=>{throw new Error("docker exited with 1")}}),/allow_internet=false[\s\S]*verifier\.environment[\s\S]*Refusing launch/);
    const missing=await preflightTerminalBenchNetworkPolicy({...options,cacheRoot:join(root,"absent"),captureFn:async()=>{throw new Error("must not probe")}});
    assert.equal(missing.taskTomlFound,false);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/networkPolicyPreflight=await preflightTerminalBenchNetworkPolicy\(/);
  assert.ok(source.indexOf("preflightTerminalBenchNetworkPolicy(")<source.indexOf("const runLane=async"),"network preflight must run before any lane starts");
  assert.match(source,/networkPolicyPreflight,/);
});

test("Harbor processes on Windows opt out of the detached telemetry sender that opens console windows",async()=>{
  assert.deepEqual(windowsHarborEnv({},"win32"),{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",HARBOR_TELEMETRY:"0"});
  const explicit={HARBOR_TELEMETRY:"1"};
  assert.equal({...explicit,...windowsHarborEnv(explicit,"win32")}.HARBOR_TELEMETRY,"1");
  assert.deepEqual(windowsHarborEnv({},"linux"),{});
  for(const script of ["live-terminal-bench-harness-comparison.mjs","run-terminal-bench.mjs","terminal-bench-gate-regrade.mjs"]){
    const source=await readFile(new URL(`../scripts/${script}`,import.meta.url),"utf8");
    assert.match(source,/\.\.\.windowsHarborEnv\(process\.env\)/,script);
  }
});

test("Benchmark run IDs carry the dataset family without renaming Terminal-Bench 4 runs",async()=>{
  assert.equal(benchmarkRunPrefix("terminal-bench/terminal-bench@4.0.0"),"tb4");
  assert.equal(benchmarkRunPrefix("terminal-bench/terminal-bench@2.0"),"tb2");
  assert.equal(benchmarkRunPrefix("terminal-bench/terminal-bench-2@1"),"tb2");
  assert.equal(benchmarkRunPrefix("terminal-bench/terminal-bench-2@latest"),"tb2");
  assert.equal(benchmarkRunPrefix("swe-bench/swe-bench-verified@latest"),"swebv");
  assert.equal(benchmarkRunPrefix("example-org/My_Bench Pro@1.0"),"my-bench-pro");
  assert.equal(benchmarkRunPrefix(""),"bench");
  const comparison=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(comparison,/RUN_PREFIX=benchmarkRunPrefix\(DATASET\)/);
  assert.match(comparison,/pairId=`\$\{RUN_PREFIX\}-\$\{STANDALONE_NATIVE_RERUN\?"native-rerun":"pair"\}-/);
  assert.match(comparison,/jobName:`\$\{RUN_PREFIX\}-\$\{lane\.label\}-/);
  const launcher=await readFile(new URL("../scripts/launch-terminal-bench-detached.mjs",import.meta.url),"utf8");
  assert.match(launcher,/const id=`\$\{prefix\}-detached-/);
  const watchdog=await readFile(new URL("../scripts/terminal-bench-watchdog.mjs",import.meta.url),"utf8");
  assert.match(watchdog,/\/\^\[a-z0-9\]\+-\(\?:pair\|native-rerun\)-/);
});

test("A verifier download cache reaches only the verifier, is opt-in and the same for every lane",async()=>{
  assert.deepEqual(verifierDownloadCacheArgs(""),[]);
  assert.deepEqual(verifierDownloadCacheArgs(null),[]);
  const cache="http://host.docker.internal:18090";
  assert.deepEqual(verifierDownloadCacheArgs(cache+"/"),[
    "--ve",`UV_INSTALLER_GITHUB_BASE_URL=${cache}/gh`,
    "--ve",`UV_PYTHON_INSTALL_MIRROR=${cache}/gh/astral-sh/python-build-standalone/releases/download`,
    "--ve",`UV_DEFAULT_INDEX=${cache}/pypi/simple`,
    "--ve",`PIP_INDEX_URL=${cache}/pypi/simple`,
    "--ve","PIP_TRUSTED_HOST=host.docker.internal",
  ]);
  assert.throws(()=>verifierDownloadCacheArgs("host.docker.internal:18090"),/must look like/);
  assert.throws(()=>verifierDownloadCacheArgs("http://user:secret@cache:8080"),/must look like/);
  const comparison=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(comparison,/VERIFIER_CACHE_ARGS=verifierDownloadCacheArgs\(VERIFIER_DOWNLOAD_CACHE\)/);
  assert.match(comparison,/"--job-name",currentJobName,"-y",\.\.\.VERIFIER_CACHE_ARGS\]/);
  assert.match(comparison,/verifierDownloadCache:VERIFIER_DOWNLOAD_CACHE/);
  assert.doesNotMatch(comparison,/"--ae"[^\n]*(UV_|PIP_)|harnessEnv\.(UV_|PIP_)/);
});

test("The verifier download cache maps only release assets and PyPI paths, and points index links at itself",()=>{
  assert.deepEqual(upstreamFor("/gh/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz"),{kind:"file",url:"https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz",cachePath:"gh/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz"});
  assert.equal(upstreamFor("/gh/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz").url,"https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz");
  assert.deepEqual(upstreamFor("/pypi/simple/Pytest-JSON-CTRF/"),{kind:"index",url:"https://pypi.org/simple/pytest-json-ctrf/"});
  assert.equal(upstreamFor("/pypi/files/packages/29/16/c8a903f4c4dffe7a12843191437d7cd8e32751d5de349d45d3fe69544e87/pytest-8.4.1-py3-none-any.whl.metadata").url,"https://files.pythonhosted.org/packages/29/16/c8a903f4c4dffe7a12843191437d7cd8e32751d5de349d45d3fe69544e87/pytest-8.4.1-py3-none-any.whl.metadata");
  for(const path of ["/gh/astral-sh/uv/blob/main/README.md","/pypi/files/packages/../../etc/passwd","/pypi/files/../secret","/elsewhere","/gh/a/b/releases/download/t/x/y"])assert.equal(upstreamFor(path),null,path);
  const html='<a href="https://files.pythonhosted.org/packages/aa/bb/x-1.0.tar.gz#sha256=00">x</a>';
  assert.equal(rewriteIndex(html,"http://host.docker.internal:18090"),'<a href="http://host.docker.internal:18090/pypi/files/packages/aa/bb/x-1.0.tar.gz#sha256=00">x</a>');
  const json='{"files":[{"url":"https://files.pythonhosted.org/packages/cc/x.whl","hashes":{"sha256":"11"}}]}';
  assert.equal(JSON.parse(rewriteIndex(json,"http://h:1")).files[0].url,"http://h:1/pypi/files/packages/cc/x.whl");
});

test("Terminal-Bench Docker subnet retry only recognizes pre-agent exhaustion",()=>{
  const base={exception_info:{exception_message:"Error response from daemon: all predefined address pools have been fully subnetted"},agent_setup:null,agent_execution:null,verifier:null};
  assert.equal(isPreAgentDockerSubnetExhaustion(base),true);
  assert.equal(isPreAgentDockerSubnetExhaustion({...base,agent_setup:{started_at:"x"}}),false);
  assert.equal(isPreAgentDockerSubnetExhaustion({...base,exception_info:{exception_message:"unrelated Docker failure"}}),false);
});

test("Terminal-Bench Docker image-pull retry only recognizes pre-agent unexpected EOF",()=>{
  const base={
    exception_info:{exception_message:"Docker compose command failed for environment example. Image harborframework/terminal-bench:example Pulling abc Extracting 10B unexpected EOF"},
    agent_setup:null,agent_execution:null,verifier:null,
  };
  assert.equal(isPreAgentDockerImagePullFailure(base),true);
  assert.equal(isPreAgentDockerImagePullFailure({...base,agent_setup:{started_at:"x"}}),false);
  assert.equal(isPreAgentDockerImagePullFailure({...base,exception_info:{exception_message:"Docker compose command failed for environment example: permission denied"}}),false);
  assert.equal(isPreAgentDockerImagePullFailure({...base,exception_info:{exception_message:"download unexpected EOF"}}),false);
});

test("Terminal-Bench Docker image-pull classification also catches post-agent verifier setup EOFs without making them retryable",()=>{
  const afterAgent={
    exception_info:{exception_message:"Docker compose command failed for environment verifier. Image example Pulling abc Extracting 10B unexpected EOF"},
    agent_setup:{started_at:"a",finished_at:"b"},
    agent_execution:{started_at:"c",finished_at:"d"},
    verifier:null,
  };
  assert.equal(isDockerImagePullFailure(afterAgent),true);
  assert.equal(isPreAgentDockerImagePullFailure(afterAgent),false);
});

test("Terminal-Bench Docker exec transport classification recognizes Docker Desktop exec failures",()=>{
  const transport={
    exception_info:{
      exception_message:"request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.55/exec/634775e6da59e7512b241b62453a3d4b3ea3611e302c7b7495850770d8dd8041/json, check if the server supports the requested API version",
    },
    agent_execution:{started_at:"x",finished_at:"y"},
    verifier:{started_at:"z",finished_at:"w"},
  };
  assert.equal(isDockerExecTransportFailure(transport),true);
  assert.equal(isDockerExecTransportFailure({
    exception_info:{
      exception_type:"NonZeroAgentExitCodeError",
      exception_message:"Command failed (exit 4294967295): codex exec --json\\nstdout: partial\\nstderr: None",
    },
    agent_execution:{started_at:"x",finished_at:"y"},
  }),true);
  assert.equal(isDockerExecTransportFailure({
    exception_info:{
      exception_type:"NonZeroAgentExitCodeError",
      exception_message:"Command failed (exit -1): node /installed-agent/agent.mjs\\nstdout: partial\\nstderr: None",
    },
  }),true);
  assert.equal(isDockerExecTransportFailure({
    exception_info:{
      exception_type:"NonZeroAgentExitCodeError",
      exception_message:"Command failed (exit 1): codex exec --json\\nstdout: Error response from daemon: No such exec instance: d3572e40ca8156d2ac5b34dd602dc627b096218b381dcc11768f252c1d77206f\\nstderr: None",
    },
  }),true);
  assert.equal(isDockerExecTransportFailure({
    exception_info:{
      exception_type:"NonZeroAgentExitCodeError",
      exception_message:"Command failed (exit 1): codex exec --json\\nstdout: ordinary agent failure",
    },
  }),false);
  assert.equal(isDockerExecTransportFailure({...transport,exception_info:{exception_message:"request returned 500 Internal Server Error from some unrelated service"}}),false);
  assert.equal(isDockerExecTransportFailure({...transport,exception_info:{exception_message:"dockerDesktopLinuxEngine /exec/not-a-container-id/json returned 500"}}),false);
  assert.equal(isDockerExecTransportFailure(null),false);
});

test("Terminal-Bench classifies externally SIGTERM'd Trebell Native agents as infrastructure without hiding ordinary agent failures",()=>{
  const terminated={
    exception_info:{
      exception_type:"NonZeroAgentExitCodeError",
      exception_message:"Command failed (exit 143): node /installed-agent/trebell-native-agent.mjs /installed-agent/instruction.txt\nstdout: Terminated\n\nstderr: None",
    },
    agent_execution:{started_at:"a",finished_at:"b"},
  };
  assert.equal(isNativeAgentExternalTermination(terminated),true);
  assert.equal(isNativeAgentExternalTermination({
    ...terminated,
    exception_info:{...terminated.exception_info,exception_message:"Command failed (exit 143): node /installed-agent/other-agent.mjs\nstdout: Terminated"},
  }),false);
  assert.equal(isNativeAgentExternalTermination({
    ...terminated,
    exception_info:{...terminated.exception_info,exception_message:"Command failed (exit 1): node /installed-agent/trebell-native-agent.mjs\nstdout: ordinary agent failure"},
  }),false);
  assert.equal(isNativeAgentExternalTermination(null),false);
});

test("Terminal-Bench classifies agent authentication failures as infrastructure instead of quality zeros",async()=>{
  const authFailure={
    exception_info:{
      exception_type:"AgentAuthenticationError",
      exception_message:"Command failed (exit 1): codex exec --json -c web_search=disabled -- 'task'\nstdout: {\"type\":\"turn.failed\",\"error\":{\"message\":\"workspace routing discovery unauthorized (401)\"}}",
    },
    agent_execution:{started_at:"a",finished_at:"b"},
    verifier:{started_at:"c",finished_at:"d"},
    verifier_result:{rewards:{reward:0}},
  };
  assert.equal(isAgentAuthenticationFailure(authFailure),true);
  assert.equal(isAgentAuthenticationFailure({...authFailure,exception_info:{exception_type:"NonZeroAgentExitCodeError",exception_message:"Command failed (exit 1): codex exec --json\nstdout: unauthorized word in ordinary output"}}),false);
  assert.equal(isAgentAuthenticationFailure({verifier_result:{rewards:{reward:0}}}),false);
  assert.equal(isAgentAuthenticationFailure(null),false);
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/isAgentAuthenticationFailure\(failedTrial\)/);
  assert.match(source,/isAgentAuthenticationFailure\(trial\)\?"agent_authentication_failure"/);
});

test("SWE-bench lanes with a reward but no verifier report are infrastructure, not quality zeros",async t=>{
  assert.equal(isSweBenchDataset("swe-bench/swe-bench-verified@latest"),true);
  assert.equal(isSweBenchDataset("terminal-bench/terminal-bench@4.0.0"),false);
  assert.equal(isSweBenchDataset(""),false);
  const trialDir=await mkdtemp(join(tmpdir(),"trebell-swe-ungraded-"));
  t.after(()=>rm(trialDir,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  await mkdir(join(trialDir,"verifier"),{recursive:true});
  await writeFile(join(trialDir,"verifier","reward.txt"),"0\n");
  assert.equal(await sweBenchVerifierReportMissing(trialDir),true);
  await writeFile(join(trialDir,"verifier","report.json"),"{}\n");
  assert.equal(await sweBenchVerifierReportMissing(trialDir),false);
  assert.equal(await sweBenchVerifierReportMissing(null),false);
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  // Checked only once every lane has finished, with the other sealed verifier reads.
  const sealedReads=source.indexOf("Keep verifier internals sealed while comparison lanes are still running.");
  const check=source.indexOf("job.infrastructureFailureReason=\"swe_bench_verifier_report_missing\"");
  assert.ok(sealedReads>0&&check>sealedReads);
  assert.match(source,/isSweBenchDataset\(DATASET\)&&job\.reward!=null&&!job\.infrastructureFailureReason&&await sweBenchVerifierReportMissing\(job\.regradeTrialDir\|\|await findNativeTrialDir\(outputRoot,job\.jobName\)\)/);
  assert.match(source,/laneState\.infrastructureFailureReason=job\.infrastructureFailureReason;laneState\.status="infrastructure-failed"/);
});

test("Terminal-Bench Docker cleanup only removes exited environments from sealed verifier trials",async()=>{
  const entries={
    "ROOT":[{name:"job-a",isDirectory:()=>true},{name:"job-b",isDirectory:()=>true}],
    "ROOT/job-a":[{name:"task__Good",isDirectory:()=>true}],
    "ROOT/job-b":[{name:"task__Ungraded",isDirectory:()=>true}],
  };
  const readdirFn=async path=>entries[String(path).replaceAll("\\","/")]||[];
  const readFileFn=async path=>{
    const normalized=String(path).replaceAll("\\","/");
    if(normalized.endsWith("task__Good/result.json"))return JSON.stringify({finished_at:"done",verifier_result:{rewards:{reward:1}}});
    if(normalized.endsWith("task__Ungraded/result.json"))return JSON.stringify({finished_at:"done",verifier_result:null});
    throw new Error("missing");
  };
  const projects=await sealedHarborEnvironmentProjects("ROOT",{readdirFn,readFileFn});
  assert.deepEqual([...projects],["task__good__env"]);
  const captureFn=async(command,args)=>{
    if(command!=="docker")throw new Error("unexpected command");
    if(args[0]==="ps")return "good-id\nungraded-id\nrunning-id\n";
    if(args[0]==="inspect")return JSON.stringify([
      {Id:"good-id",State:{Status:"exited"},Config:{Labels:{"com.docker.compose.project":"task__good__env"}}},
      {Id:"ungraded-id",State:{Status:"exited"},Config:{Labels:{"com.docker.compose.project":"task__ungraded__env"}}},
      {Id:"running-id",State:{Status:"running"},Config:{Labels:{"com.docker.compose.project":"task__good__env"}}},
    ]);
    if(args[0]==="network")return "network-good\n";
    throw new Error("unexpected capture");
  };
  const runs=[];
  const runFn=async(command,args)=>{runs.push([command,args])};
  const result=await cleanupSealedExitedHarborEnvironments("ROOT",{captureFn,runFn,readdirFn,readFileFn});
  assert.deepEqual(result,{eligibleProjects:1,removedContainers:1,removedNetworks:1,projects:["task__good__env"]});
  assert.deepEqual(runs,[
    ["docker",["rm","-f","good-id"]],
    ["docker",["network","rm","network-good"]],
  ]);
});

test("Terminal-Bench standalone Native rerun lock is shared across worktrees but separate from the pair lock",()=>{
  const root="H:\\repo\\worktree-a",gitCommon="..\\.git";
  const pair=sharedTerminalBenchLockPath(root,gitCommon),rerun=sharedTerminalBenchNativeRerunLockPath(root,gitCommon);
  assert.notEqual(rerun,pair);
  assert.match(rerun,/terminal-bench-native-rerun\.lock$/);
  const other=sharedTerminalBenchNativeRerunLockPath("H:\\repo\\worktree-b","..\\.git");
  assert.equal(other,rerun);
});

test("Terminal-Bench pair lock is shared across worktrees that use one Git common directory",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-global-pair-lock-"));
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
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

  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)","harbor","run","--job-name",token],{stdio:"ignore",windowsHide:true});
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
  const trial="random-task__AbC123";
  const ps=[
    `  101 node worker.js ${token}`,
    "  202 python unrelated.py",
    `  303 harbor run --job-name ${token}`,
    `  404 docker compose --project-name random-task__abc123__env exec main bash -c agent`,
    `  505 powershell Get-Content .harbor-validation/${token}.json`,
    "not-a-process-line",
  ].join("\n");
  assert.deepEqual(parsePsProcesses(ps,token,[trial]),[303,404]);
  assert.deepEqual(parsePsProcesses(ps,"missing-job-token"),[]);
});

test("Terminal-Bench Windows process JSON parsing tolerates BOM and fails closed on malformed data",()=>{
  assert.deepEqual(parseWindowsProcessRows('\uFEFF[{"ProcessId":42,"CommandLine":"harbor run --job-name demo"}]'),[{ProcessId:42,CommandLine:"harbor run --job-name demo"}]);
  assert.deepEqual(parseWindowsProcessRows(""),[]);
  assert.throws(()=>parseWindowsProcessRows("not-json"),error=>error?.code==="terminal_bench_process_list_parse");
});

test("Terminal-Bench lane drain detects a surviving trial-token process even without the job name",async t=>{
  const jobToken=`trebell-job-${randomUUID()}`;
  const trialToken=`task__${randomUUID().replaceAll("-","")}`;
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)","docker","compose","--project-name",`${trialToken.toLowerCase()}__env`,"exec","main"],{stdio:"ignore",windowsHide:true});
  t.after(()=>{try{child.kill()}catch{}});

  let detected=[];
  for(let attempt=0;attempt<20&&!detected.includes(child.pid);attempt++){
    detected=await lingeringJobProcesses(jobToken,{additionalNeedles:[trialToken]});
    if(!detected.includes(child.pid))await new Promise(resolveWait=>setTimeout(resolveWait,50));
  }
  assert.ok(detected.includes(child.pid),`expected trial-token pid ${child.pid} in ${JSON.stringify(detected)}`);

  await assert.rejects(
    waitForJobProcessDrain(jobToken,{additionalNeedles:[trialToken],timeoutMs:100,pollMs:20}),
    /left host processes alive after launcher exit/,
  );

  child.kill();
  await once(child,"exit");
  await waitForJobProcessDrain(jobToken,{additionalNeedles:[trialToken],timeoutMs:3_000,pollMs:20});
});

test("Terminal-Bench lane drain ignores observers that merely mention benchmark identifiers",()=>{
  const job="tb4-native-gpt-6-luna-max-task-20261001T212950Z",trial="task__hP3FS7B";
  assert.equal(harborLaneProcessCommand(`powershell Get-Content .harbor-validation/${job}.json`,job,{additionalNeedles:[trial]}),false);
  assert.equal(harborLaneProcessCommand(`node watcher.mjs ${job} ${trial}`,job,{additionalNeedles:[trial]}),false);
  assert.equal(harborLaneProcessCommand(`harbor run -d dataset --job-name ${job}`,job,{additionalNeedles:[trial]}),true);
  assert.equal(harborLaneProcessCommand(`docker compose --project-name ${trial.toLowerCase()}__env exec main bash`,job,{additionalNeedles:[trial]}),true);
});

test("Terminal-Bench lane drain ignores a same-named Harbor run that another clone started in the same second",async()=>{
  // 2026-10-13: two clones launched the wdm-design Codex API lane at 19:02:24Z under one job name, and the first lane to
  // finish waited out its drain on the other clone's Harbor processes and was marked failed.
  const job="tb4-codex-api-gpt-6-luna-max-wdm-design-20261013T190226Z";
  const run=root=>`C:\\Users\\me\\.local\\bin\\harbor.exe run -d terminal-bench/terminal-bench@4.0.0 -i terminal-bench/wdm-design -n 1 -o ${root}\\.harbor-jobs --job-name ${job}`;
  assert.equal(harborLaneProcessCommand(run("H:\\TrebellExp-retry-2"),job,{outputRoot:"H:/TrebellExp-retry-1/.harbor-jobs"}),false);
  assert.equal(harborLaneProcessCommand(run("H:\\TrebellExp-retry-1"),job,{outputRoot:"H:/TrebellExp-retry-1/.harbor-jobs"}),true);
  assert.equal(harborLaneProcessCommand(run("H:\\TrebellExp-retry-1"),job,{outputRoot:"H:\\TrebellExp-retry-1\\.harbor-jobs\\"}),true);
  assert.equal(harborLaneProcessCommand(`"C:\\Program Files\\harbor.exe" run -o "H:\\Github Repositories\\Trebell\\.harbor-jobs" --job-name ${job}`,job,{outputRoot:"H:/Github Repositories/Trebell/.harbor-jobs"}),true);
  assert.equal(harborLaneProcessCommand(run("H:\\TrebellExp-retry-2"),job),true);
  assert.deepEqual(parsePsProcesses(`  11 harbor run -o /work/a/.harbor-jobs --job-name ${job}\n  22 harbor run -o /work/b/.harbor-jobs --job-name ${job}`,[job],[],{outputRoot:"/work/a/.harbor-jobs"}),[11]);
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/waitForJobProcessDrain\(jobName,\{timeoutMs:LANE_DRAIN_TIMEOUT_MS,cwd:root,additionalNeedles,outputRoot\}\)/);
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
  assert.match(source,/terminal-bench-native-rerun-latest\.json/);
  assert.match(source,/--target=/);
  assert.match(source,/native-rerun/);
  assert.match(source,/reportTimeMs/);
  assert.match(source,/sameRunConfiguration/);
  assert.match(source,/rerunTime>pairTime/);
  assert.match(source,/rerunTime>=pairTime/);
  assert.match(source,/ranked\.sort\(\(a,b\)=>b\.createdMs-a\.createdMs/);
  assert.match(source,/Target:.*STANDALONE NATIVE RERUN/);
  assert.match(source,/reasoningEffort:report\.reasoningEffort\?\?pointer\.reasoningEffort/);
  assert.match(source,/serviceTier:report\.serviceTier\?\?pointer\.serviceTier/);
  assert.match(source,/hostedWebSearch:report\.hostedWebSearch\?\?pointer\.hostedWebSearch/);
  assert.match(source,/Tracked dirty:/);
  assert.match(source,/apiEquivalentCostIsLowerBound/);
  assert.match(source,/lower bound because one or more provider responses omitted token usage/);
  assert.match(source,/recoverNativeEventEvidence\(jobsDir,lane\.jobName,\{serviceTier:report\?\.serviceTier\|\|"standard"\}\)/);
  assert.match(source,/readJobVerifierSummary\(jobsDir,lane\.jobName\)/);
  assert.match(source,/effectiveJob\.verifierChecks=\{\.\.\.\(effectiveJob\.verifierChecks\|\|\{\}\),\.\.\.checks\}/);
  assert.match(source,/exceptionType==="AgentAuthenticationError"\?"agent_authentication_failure"/);
  assert.match(source,/reward=infrastructureReason\?"INFRA"/);
  assert.match(source,/not a quality result; rerun only this lane/);
  assert.match(source,/REWARD\s+DIAG\s+PYTEST/);
  assert.match(source,/Verifier note: REWARD is Harbor's official task reward/);
});

test("Pinned Harbor Codex adapter pins the official version and uses Windows-safe persisted sessions",async()=>{
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
  // The root install makes CODEX_HOME; an image that runs as its own USER must still be able to write in it.
  assert.match(source,/chmod 0777 \/tmp\/codex-home /);
  assert.match(source,/def _get_session_dir\(self\)/);
  assert.match(source,/self\.logs_dir \/ "codex-sessions"/);
  assert.match(source,/WinError 1920/);
  assert.match(source,/except OSError:/);
  assert.doesNotMatch(source,/super\(\)\._get_session_dir\(\)/);
  assert.doesNotMatch(source,/async def run\(/);
});

test("Trebell Native Harbor adapter launches the agent with the image's login-shell environment",async()=>{
  const adapter=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  const loginEnvironment=adapter.slice(adapter.indexOf("_LOGIN_ENVIRONMENT = ("),adapter.indexOf("\n    )",adapter.indexOf("_LOGIN_ENVIRONMENT = (")));
  assert.ok(loginEnvironment.includes("bash -lc 'export -p'"),"import a separate login shell's exported environment");
  assert.ok(loginEnvironment.includes('trebell_path=\\"$PATH\\"')&&loginEnvironment.includes('PATH=\\"$trebell_path\\"'),"restore the original PATH so Dockerfile ENV PATH entries survive a resetting /etc/profile");
  assert.ok(loginEnvironment.includes('PATH=\\"$trebell_prefix:$PATH\\"'),"prepend only the entries the login shell added");
  const launch=adapter.slice(adapter.indexOf("await self.exec_as_agent("),adapter.indexOf("populate_context_post_run"));
  assert.ok(launch.indexOf("{self._LOGIN_ENVIRONMENT}")>0,"the agent launch must load the login environment");
  const pinned=launch.indexOf('runtime_cmd="$(command -v "$runtime_cmd"');
  assert.ok(pinned>launch.indexOf(". ~/.nvm/nvm.sh")&&pinned<launch.indexOf("{self._LOGIN_ENVIRONMENT}"),"resolve the agent runtime path before the login environment can shadow it");
  assert.ok(launch.indexOf("{self._LOGIN_ENVIRONMENT}")<launch.indexOf('"$runtime_cmd" {self._REMOTE_RUNNER}'),"the login environment must load before the agent starts");
});

test("Both Harbor adapters stop their agent, and everything still under it, when Harbor's agent timeout cancels the run",async()=>{
  const read=name=>readFile(new URL(`../benchmarks/harbor/${name}`,import.meta.url),"utf8");
  const [native,codex,stop]=await Promise.all([read("trebell_native_agent.py"),read("pinned_codex_agent.py"),read("agent_timeout_stop.py")]);
  const squeeze=text=>text.replace(/\s+/g," ");
  assert.ok(native.includes("from .agent_timeout_stop import stop_agent_tree"));
  const nativeRun=squeeze(native.slice(native.indexOf("await self._run_runner(environment, env)"),native.indexOf("async def _run_runner")));
  assert.ok(nativeRun.startsWith("await self._run_runner(environment, env) except asyncio.CancelledError: #"),"only Harbor's cancellation triggers the stop");
  assert.ok(nativeRun.includes("await asyncio.shield(stop_agent_tree(self, environment, self._RUNNER_MARKER)) raise"),"stop, then let the cancellation go on");
  assert.ok(native.includes('_RUNNER_MARKER = "trebell-native-agent.mjs"'));
  assert.ok(native.includes('_REMOTE_RUNNER = "/installed-agent/trebell-native-agent.mjs"'),"the marker is the runner's file name");
  assert.ok(codex.includes("from .agent_timeout_stop import stop_agent_tree"));
  const codexExec=squeeze(codex.slice(codex.indexOf("async def exec_as_agent("),codex.indexOf("raise",codex.indexOf("async def exec_as_agent("))+5));
  assert.ok(codexExec.includes("return await super().exec_as_agent( environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec ) except asyncio.CancelledError:"),"wrap every agent exec");
  assert.ok(codexExec.includes("await asyncio.shield(stop_agent_tree(self, environment, self._CODEX_MARKER)) raise"),"stop Codex inside the cancelled exec, before Harbor's run() copies the sessions");
  assert.ok(codex.includes('_CODEX_MARKER = "--dangerously-bypass-approvals-and-sandbox"'));
  assert.ok(stop.includes("half = len(marker) // 2")&&stop.includes(`pattern = f'"{marker[:half]}""{marker[half:]}"'`),"split the marker so the script never matches itself");
  assert.ok(stop.includes('[ "$pid" = "$me" ] || [ "$pid" = 1 ] && continue'),"never the script itself, never the container's first process");
  const script=stop.slice(stop.indexOf('return f"""'),stop.indexOf('"""',stop.indexOf('return f"""')+11));
  assert.ok(script.includes("/proc/[0-9]*")&&!/\bpkill\b|\bps\b/.test(script),"walk /proc: slim task images ship no ps or pkill");
  assert.ok(stop.indexOf("kill -STOP")>0&&stop.indexOf("kill -STOP")<stop.indexOf("kill -KILL"),"freeze the tree before killing it, so nothing under it starts another process");
  assert.ok(squeeze(stop).includes("agent.exec_as_root(environment, command=stop_tree_script(marker)), timeout=60"));
  assert.ok(stop.includes("except Exception as error:"),"a failed stop never replaces Harbor's timeout");
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

test("Terminal-Bench single runner uses pinned Node staging, an absolute output path, and the safer timeout/tier defaults",async()=>{
  const source=await readFile(new URL("../scripts/run-terminal-bench.mjs",import.meta.url),"utf8");
  assert.match(source,/NATIVE_PINNED_NODE_VERSION="22\.23\.3"/);
  assert.match(source,/NATIVE_PINNED_NODE_TARBALL_SHA256="1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af"/);
  assert.match(source,/\.harbor-validation/);
  assert.match(source,/node-stage/);
  assert.match(source,/async function ensurePinnedNodeTarball/);
  assert.match(source,/Pinned Node tarball SHA-256 mismatch/);
  assert.match(source,/TREBELL_NODE_PINNED_TARBALL:nativePinnedNodeTarballPath/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER\|\|3/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER\|\|1/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_SERVICE_TIER\|\|"fast"/);
  assert.match(source,/serviceTier==="fast"\?\["--ak","service_tier=fast"\]/);
  assert.match(source,/Terminal-Bench service tier must be default or fast/);
  assert.match(source,/const output=resolve\(root,/);
  assert.match(source,/--agent-setup-timeout-multiplier/);
  assert.match(source,/--agent-timeout-multiplier/);
});
