import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Harbor Native adapter stages the OpenAI key instead of passing it through Docker exec env",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  assert.ok(source.includes('_REMOTE_API_KEY = "/installed-agent/openai-api-key"'));
  assert.ok(source.includes("content=access.api_key"));
  assert.ok(source.includes("remote_path=self._REMOTE_API_KEY"));
  assert.ok(source.includes('export OPENAI_API_KEY="$(cat {self._REMOTE_API_KEY})"'));
  assert.ok(source.includes("rm -f {self._REMOTE_API_KEY}"));
  assert.ok(source.includes('command=f"chown {owner} /installed-agent"'));
  assert.ok(!source.includes('"OPENAI_API_KEY": access.api_key'));
  assert.ok(source.includes('_REMOTE_RUNTIME = "/installed-agent/runtime"'));
  assert.ok(source.includes("command -v bun"));
  assert.ok(source.includes("bun {self._REMOTE_RUNNER} --version"));
  assert.ok(source.includes("command -v node"));
  // An image Node without a global fetch (Node 16) answers the runner's --version but cannot run it, so it falls through.
  const nodeProbe=source.indexOf("elif command -v node"),fetchProbe=source.indexOf("typeof fetch === 'function'");
  assert.ok(nodeProbe>0&&fetchProbe>nodeProbe&&fetchProbe<source.indexOf("node {self._REMOTE_RUNNER} --version",nodeProbe),"an image Node is accepted only with a global fetch, before the runner's own probe");
  assert.ok(source.includes("No compatible preinstalled Bun/Node runtime"));
  assert.ok(source.includes('ensure_system_dependencies(environment, ("curl",))'));
  assert.ok(!source.includes('("curl", "bash", "git", "ripgrep", "coreutils")'));
  assert.ok(source.indexOf("_upload_agent_owned_file")<source.indexOf('ensure_system_dependencies(environment, ("curl",))'),"the bundle should be uploaded and existing runtimes probed before installing curl/nvm");
  assert.ok(source.includes('if [ "$runtime" = "bun" ]; then runtime_cmd=bun'));
  assert.ok(source.includes('metrics_path.read_text(encoding="utf-8")'));
  assert.ok(source.includes('"cache_carryover": metrics.get("cacheCarryover") or {}'));
  assert.ok(source.includes('"strategy": metrics.get("strategy") or {}'));
  assert.ok(source.includes('TREBELL_OPENAI_REASONING_CONTEXT'));
  assert.ok(source.includes('"reasoning_context": metrics.get("reasoningContext")'));
  assert.ok(source.includes('"effective_reasoning_contexts": metrics.get("effectiveReasoningContexts") or []'));
  assert.ok(source.includes("pipeline_status=$?"));
  assert.ok(source.includes('metrics.error===null'));
  assert.ok(source.includes('JSON.parse(fs.readFileSync(process.argv[1],"utf8"))'));
  assert.match(source,/continuing to Harbor artifact collection and verification/);
  assert.ok(source.indexOf("pipeline_status=$?")<source.indexOf("continuing to Harbor artifact collection and verification"));
  assert.doesNotMatch(source,/cwd="\/app"/,"the Native adapter must preserve Harbor's task-specific container working directory");
});

// An image Node the runner cannot use (preact-2757's Node 16, 2026-10-21) stays first on the PATH for the task's tests and the
// agent's commands: the pinned Node goes to /opt/trebell-node with no /usr/local/bin links, and the runner starts by its path.
// Linked into /usr/local/bin, Node 22 ran preact-2757's karma tests (webpack 4) and every one of them failed.
test("Harbor Native adapter keeps an image's own Node in place beside the pinned one",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  assert.ok(source.includes('_PRIVATE_NODE = "/opt/trebell-node/bin/node"'));
  const probe=source.indexOf("elif command -v node"),imageNode=source.indexOf("image-node",probe),noNode=source.indexOf("else exit 42",probe);
  assert.ok(probe>0&&imageNode>probe&&imageNode<noNode,"a Node the runner cannot use is reported as image-node, apart from no Node at all");
  assert.ok(source.includes('links = "" if image_node else ('),"no /usr/local/bin links beside an image's own Node");
  assert.ok(source.includes('await write_runtime_marker(self._PRIVATE_NODE if image_node else "node")'));
  assert.ok(source.includes('elif [ "$runtime" = {shlex.quote(self._PRIVATE_NODE)} ]; then runtime_cmd="$runtime"'),"the runner starts by the private Node's path");
  assert.ok(source.includes('elif [ "$runtime" = {shlex.quote(self._PRIVATE_NODE)} ]; then "$runtime" {self._REMOTE_RUNNER} --version'),"the version command asks the same Node");
});

// Harbor's own helper writes with Path.write_text, which on a Windows host turned every instruction line ending into CRLF
// for Native only (the Codex lanes get the instruction as a shell argument). Checked byte for byte with Harbor's interpreter
// on 2026-10-14: the helper wrote 8 CRs for a text holding 1, the override wrote the text exactly.
test("Harbor Native adapter uploads the instruction's exact bytes, not text-mode line endings",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell_native_agent.py",import.meta.url),"utf8");
  const start=source.indexOf("async def _upload_config_text("),end=source.indexOf("async def run(",start);
  assert.ok(start>0&&end>start,"the adapter overrides Harbor's config upload before run()");
  const upload=source.slice(start,end);
  assert.ok(upload.includes('local_path.write_bytes(content.encode("utf-8"))'));
  assert.ok(!upload.includes("write_text("),"text mode would translate line endings on Windows");
  assert.ok(upload.includes("chown {owner} {quoted_remote_path} && "),"the owner and mode stay as Harbor's helper sets them");
  assert.ok(upload.includes("chmod 600 {quoted_remote_path}"));
  assert.ok(source.includes("content=instruction,")&&source.includes("remote_path=self._REMOTE_INSTRUCTION"));
});

test("Harbor Native runner keeps durable output retrieval available and avoids a smaller private task budget",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  assert.match(source,/output:true/);
  assert.match(source,/process:true/);
  assert.match(source,/NativeBackgroundProcessManager/);
  assert.match(source,/backgroundProcesses,threadId:"trebell-harbor"/);
  assert.match(source,/"trebell_workspace","trebell_terminal","trebell_process"/);
  // The run's end leaves the agent's processes running (a server the task asked for is part of the result); it never stops them all.
  assert.match(source,/backgroundProcesses\.releaseAll\(\)/);assert.doesNotMatch(source,/backgroundProcesses\.closeAll\(\)/);
  assert.match(source,/backgroundProcessesAtEnd:/);
  assert.match(source,/TREBELL_HARBOR_MAX_MODEL_TURNS\)\|\|500/);
  assert.match(source,/TREBELL_HARBOR_MAX_TOOL_CALLS\)\|\|5000/);
  assert.match(source,/maxWallTimeMs=.*null/);
  assert.match(source,/TREBELL_OPENAI_REASONING_CONTEXT/);
  assert.match(source,/effectiveReasoningContexts/);
});

test("Harbor Native runner records when OpenAI server compaction arms in its context policy",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  assert.match(source,/import \{ NativeAgentSession, openAiServerCompactionArmTokens \} from "\.\.\/\.\.\/src\/native-agent-session\.mjs"/);
  assert.match(source,/openAiServerCompactionThreshold:compactionThreshold/);
  assert.match(source,/contextPolicy:\{operatingContextWindow:contextWindow,serverCompactionThreshold:compactionThreshold,serverCompactionArming:\{armAtMaxObservedInputTokens:openAiServerCompactionArmTokens\(compactionThreshold\),staysArmed:true\},retroactiveOpenAiReadCooling:false\}/);
});
