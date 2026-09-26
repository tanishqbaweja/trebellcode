import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCodexConfig, ensureCodexConfig } from "../src/config.mjs";
import { parseRunArgs } from "../src/trebell.mjs";
import { codexArgs, codexChildEnvironment } from "../src/codex.mjs";
import { rebrandTerminalChunk } from "../src/branding.mjs";
import { trebellHome, codexHome, freebuffConfigDir } from "../src/paths.mjs";

test("Trebell paths are isolated from ~/.codex and ~/.config/freebuff2api", () => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  const env = { ...process.env, TREBELL_HOME: root };
  assert.equal(trebellHome(env), root);
  assert.equal(codexHome(env), join(root, "codex"));
  assert.equal(freebuffConfigDir(env), join(root, "freebuff2api"));
});

test("Codex provider config always uses the Responses API", () => {
  const freebuff = renderCodexConfig({ port: 24444, provider: "freebuff" });
  assert.match(freebuff, /model_provider = "freebuff"/);
  assert.match(freebuff, /base_url = "http:\/\/127\.0\.0\.1:24444\/v1"/);
  assert.match(freebuff, /wire_api = "responses"/);
  assert.match(freebuff, /requires_openai_auth = false/);

  for (const provider of ["agentrouter","justworker","hcnsec","vyceai"]) {
    const text = renderCodexConfig({ provider });
    assert.match(text, new RegExp(`model_provider = "${provider}"`));
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:23334\/v1"/);
    assert.match(text, /wire_api = "responses"/);
    assert.match(text, /requires_openai_auth = false/);
    assert.doesNotMatch(text, /wire_api = "chat"/);
    assert.doesNotMatch(text, /env_key\s*=/);
  }
  const dynamicAgentRouter=renderCodexConfig({provider:"agentrouter",port:28765});
  assert.match(dynamicAgentRouter,/base_url = "http:\/\/127\.0\.0\.1:28765\/v1"/);
});

test("ensureCodexConfig writes into Trebell home", () => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  const env = { ...process.env, TREBELL_HOME: root };
  const path = ensureCodexConfig({ port: 23333, provider: "agentrouter", env });
  assert.equal(path, join(root, "codex", "config.toml"));
  assert.match(readFileSync(path, "utf8"), /AgentRouter/);
});

test("ensureCodexConfig replaces legacy chat provider config", () => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  const env = { ...process.env, TREBELL_HOME: root };
  const codexDir = join(root, "codex");
  const path = ensureCodexConfig({ provider: "agentrouter", env });
  writeFileSync(path, `model_provider = "agentrouter"\n[model_providers.agentrouter]\nbase_url = "https://co.agentrouter.org/v1"\nwire_api = "chat"\n`);
  ensureCodexConfig({ provider: "agentrouter", env });
  const text = readFileSync(path, "utf8");
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:23334\/v1"/);
  assert.match(text, /wire_api = "responses"/);
  assert.doesNotMatch(text, /wire_api = "chat"/);
});

test("run arg parser keeps runtime arguments while consuming Trebell flags", () => {
  assert.deepEqual(
    parseRunArgs(["--model", "freebuff/x/y", "--port", "24444", "--", "exec", "hello"]),
    { model: "freebuff/x/y", provider: null, port: 24444, loginCheck: true, forwarded: ["exec", "hello"] },
  );
});

test("Codex args use the selected provider", () => {
  assert.deepEqual(
    codexArgs({ model: "freebuff/a/b", provider: "freebuff", forwarded: ["exec", "hi"] }),
    ["-c", 'model_provider="freebuff"', "-m", "freebuff/a/b", "exec", "hi"],
  );
  assert.deepEqual(
    codexArgs({ model: "gpt-5.5", provider: "agentrouter", forwarded: ["exec", "hi"] }),
    ["-c", 'model_provider="agentrouter"', "-m", "gpt-5.5", "exec", "hi"],
  );
});

test("standalone Codex child environment excludes unrelated host credentials",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-codex-env-"));
  const env=codexChildEnvironment({
    PATH:process.env.PATH||"/usr/bin",
    HOME:root,
    USERPROFILE:root,
    TREBELL_HOME:root,
    OPENAI_API_KEY:"must-not-reach-codex",
    CODEX_API_KEY:"must-not-reach-codex-either",
    GITHUB_TOKEN:"unrelated-secret",
    CUSTOM_PRIVATE_TOKEN:"hidden",
  });
  assert.equal(env.PATH,process.env.PATH||"/usr/bin");
  assert.equal(env.HOME,root);
  assert.equal(env.CODEX_HOME,join(root,"codex"));
  assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(env.CODEX_API_KEY,undefined);
  assert.equal(env.GITHUB_TOKEN,undefined);
  assert.equal(env.CUSTOM_PRIVATE_TOKEN,undefined);
});

test("terminal branding removes upstream product name from visible banner", () => {
  assert.equal(rebrandTerminalChunk(">_ OpenAI Codex\n"), ">_ Trebell Code\n");
  assert.equal(rebrandTerminalChunk("run codex now"), "run trebell now");
});
