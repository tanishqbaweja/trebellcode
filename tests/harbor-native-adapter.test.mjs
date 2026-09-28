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
  assert.ok(!source.includes('"OPENAI_API_KEY": access.api_key'));
  assert.ok(source.includes('ensure_system_dependencies(environment, ("curl",))'));
  assert.ok(!source.includes('("curl", "bash", "git", "ripgrep", "coreutils")'));
});
