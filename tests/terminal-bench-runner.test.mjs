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
import { acquireTerminalBenchPairLock, sharedTerminalBenchLockPath, sharedTerminalBenchNativeRerunLockPath } from "../scripts/terminal-bench-pair-lock.mjs";
import { cleanupSealedExitedHarborEnvironments, isDockerExecTransportFailure, isDockerImagePullFailure, isPreAgentDockerImagePullFailure, isPreAgentDockerSubnetExhaustion, sealedHarborEnvironmentProjects } from "../scripts/terminal-bench-docker-recovery.mjs";
import { preflightTerminalBenchDatasetTaskMembership, prewarmTerminalBenchDockerImages, prewarmTerminalBenchTaskCache, terminalBenchDatasetTaskNamesFromVersionMetadata, terminalBenchTaskDockerImagesFromToml, terminalBenchTaskPackageRef, terminalBenchTaskQualifiedName } from "../scripts/terminal-bench-task-cache.mjs";

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
  assert.match(nativeRunnerSource,/semanticCompletionGate:true/);
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
  assert.match(source,/process\.platform==="win32"\?\{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"\}/);
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
  assert.match(source,/waitForJobProcessDrain\(jobName,\{timeoutMs:LANE_DRAIN_TIMEOUT_MS,cwd:root,additionalNeedles\}/);
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
  assert.deepEqual(result,{completed:true,qualifiedTask:"terminal-bench/example-task",taskCount:2,datasetVersion:"4.0.0",datasetRevision:"rev-4",datasetContentHash:"dataset-sha"});
  assert.deepEqual(calls,[{command:"harbor-test",args:["version","show","terminal-bench/terminal-bench@4.0.0","--tasks","--json"],options:{env:{SAFE:"1"}}}]);
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"stale-task",captureFn:async()=>JSON.stringify(metadata)}),/not a member of dataset/);
  await assert.rejects(()=>preflightTerminalBenchDatasetTaskMembership({harbor:"harbor-test",dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",captureFn:async()=>"not-json"}),/Cannot parse dataset membership metadata/);
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
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Terminal-Bench Docker prewarm retries one transient pull serially and then stops",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-tb-image-retry-"));
  try{
    const versionDir=join(root,"content-hash");await mkdir(versionDir,{recursive:true});
    await writeFile(join(versionDir,"task.toml"),`[environment]\ndocker_image = "registry.example/task-env@sha256:abc"\n`);
    let calls=0;
    const result=await prewarmTerminalBenchDockerImages({dataset:"terminal-bench/terminal-bench@4.0.0",task:"example-task",cacheRoot:root,maxAttempts:3,captureFn:async()=>{throw new Error("missing")},runFn:async()=>{calls++;if(calls<2)throw new Error("unexpected EOF")}});
    assert.equal(calls,2);assert.deepEqual(result.attempts.map(item=>item.status),["failed","pulled"]);
  }finally{await rm(root,{recursive:true,force:true})}
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
  assert.match(source,/reasoningEffort:report\.reasoningEffort\?\?pointer\.reasoningEffort/);
  assert.match(source,/serviceTier:report\.serviceTier\?\?pointer\.serviceTier/);
  assert.match(source,/hostedWebSearch:report\.hostedWebSearch\?\?pointer\.hostedWebSearch/);
  assert.match(source,/Tracked dirty:/);
  assert.match(source,/apiEquivalentCostIsLowerBound/);
  assert.match(source,/lower bound because one or more provider responses omitted token usage/);
  assert.match(source,/recoverNativeEventEvidence\(jobsDir,lane\.jobName,\{serviceTier:report\?\.serviceTier\|\|"standard"\}\)/);
  assert.match(source,/readJobVerifierSummary\(jobsDir,lane\.jobName\)/);
  assert.match(source,/!effectiveJob\.verifierChecks&&!effectiveJob\.recoveredVerifierChecks/);
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
  assert.match(source,/def _get_session_dir\(self\)/);
  assert.match(source,/self\.logs_dir \/ "codex-sessions"/);
  assert.match(source,/WinError 1920/);
  assert.match(source,/except OSError:/);
  assert.doesNotMatch(source,/super\(\)\._get_session_dir\(\)/);
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
  assert.match(source,/TREBELL_TERMINAL_BENCH_SERVICE_TIER\|\|"fast"/);
  assert.match(source,/serviceTier==="fast"\?\["--ak","service_tier=fast"\]/);
  assert.match(source,/Terminal-Bench service tier must be default or fast/);
  assert.match(source,/const output=resolve\(root,/);
  assert.match(source,/--agent-setup-timeout-multiplier/);
  assert.match(source,/--agent-timeout-multiplier/);
});
