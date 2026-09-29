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
});

test("Harbor Native runner keeps durable output retrieval available and avoids a smaller private task budget",async()=>{
  const source=await readFile(new URL("../benchmarks/harbor/trebell-native-runner.mjs",import.meta.url),"utf8");
  assert.match(source,/output:true/);
  assert.match(source,/TREBELL_HARBOR_MAX_MODEL_TURNS\)\|\|500/);
  assert.match(source,/TREBELL_HARBOR_MAX_TOOL_CALLS\)\|\|5000/);
  assert.match(source,/maxWallTimeMs=.*null/);
  assert.match(source,/TREBELL_OPENAI_REASONING_CONTEXT/);
  assert.match(source,/effectiveReasoningContexts/);
});
