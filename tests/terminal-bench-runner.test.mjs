import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Terminal-Bench pair runner prevents overlapping pairs and saves comparable trial metrics",async()=>{
  const source=await readFile(new URL("../scripts/live-terminal-bench-harness-comparison.mjs",import.meta.url),"utf8");
  assert.match(source,/terminal-bench-pair\.lock/);
  assert.match(source,/Refusing to contaminate benchmark timing/);
  assert.match(source,/randomUUID/);
  assert.match(source,/lockId/);
  assert.match(source,/lockIdentity\(current\)!==lockIdentity\(existing\)/);
  assert.match(source,/current\?\.lockId===lockId/);
  assert.match(source,/SETUP_TIMEOUT_MULTIPLIER/);
  assert.match(source,/agentExecutionMs:elapsedMs\(trial\?\.agent_execution\)/);
  assert.match(source,/taskChecksum:trial\?\.task_checksum/);
  assert.match(source,/nativeBundleSha256/);
  assert.match(source,/nativeAdapterSha256/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_AUTH/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_AUTH\|\|"both"/);
  assert.match(source,/Terminal-Bench Codex auth mode must be api, oauth, or both/);
  assert.match(source,/CODEX_AUTH_MODE==="both"\?\["api","oauth"\]/);
  assert.match(source,/codexAuthMode:CODEX_AUTH_MODE/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_INSTALL/);
  assert.match(source,/TREBELL_TERMINAL_BENCH_CODEX_INSTALL\|\|"pinned"/);
  assert.match(source,/Terminal-Bench Codex install mode must be stock or pinned/);
  assert.match(source,/codexInstallMode:CODEX_INSTALL_MODE/);
  assert.match(source,/codexPinnedTarballSha256/);
  assert.match(source,/codexPinnedAdapterSha256/);
  assert.match(source,/3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb/);
  assert.match(source,/ensurePinnedCodexTarball/);
  assert.match(source,/npm_execpath/);
  assert.match(source,/@openai\/codex@\$\{CODEX_PINNED_VERSION\}-linux-x64/);
  assert.match(source,/benchmarks\.harbor\.pinned_codex_agent:PinnedCodexAgent/);
  assert.match(source,/loadEnvFile\(join\(root,"\.env"\)\)/);
  assert.match(source,/\.codex-api-auth-/);
  assert.match(source,/harnessEnv\.CODEX_AUTH_JSON_PATH=codexApiAuthPath/);
  assert.match(source,/delete harnessEnv\.OPENAI_API_KEY/);
  assert.match(source,/recoverTrialEvidence/);
  assert.match(source,/recoveredFromTrialFiles/);
  assert.match(source,/comparisonLanes:lanes\.map/);
  assert.match(source,/label:`codex-\$\{authMode\}`/);
  assert.match(source,/CODEX_AUTH_MODES\.includes\("oauth"\)&&codexLaneSelected\("oauth"\)/);
  assert.match(source,/CODEX_AUTH_MODES\.includes\("api"\)&&codexLaneSelected\("api"\)/);
  assert.match(source,/OPENAI_API_KEY is required for the Codex API benchmark lane/);
  assert.match(source,/CODEX_FORCE_AUTH_JSON="1"/);
  assert.match(source,/delete harnessEnv\.CODEX_AUTH_JSON_PATH/);
  assert.match(source,/delete harnessEnv\.CODEX_FORCE_AUTH_JSON/);
  assert.match(source,/harness,label,agent,jobName,runError,authMode/);
  assert.match(source,/agentVersion:trial\?\.agent_info\?\.version/);
  assert.match(source,/complete,activeHarness,activeJobName/);
  assert.match(source,/await persistReport\(\{complete:false,activeHarness:label,activeJobName:jobName\}\)/);
  assert.match(source,/await persistReport\(\{complete:false,activeHarness:null,activeJobName:null\}\)/);
  assert.match(source,/writeFile\(reportPath,JSON\.stringify\(report,null,2\)/);
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
  assert.doesNotMatch(source,/async def run\(/);
});

test("Trebell Native Harbor adapter skips package-manager setup when curl already exists",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
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
  assert.match(source,/const output=resolve\(root,/);
  assert.match(source,/--agent-setup-timeout-multiplier/);
});
