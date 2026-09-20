import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCodexConfig, ensureCodexConfig } from "../src/config.mjs";
import { parseRunArgs } from "../src/trebell.mjs";
import { codexArgs } from "../src/codex.mjs";
import { rebrandTerminalChunk } from "../src/branding.mjs";
import { trebellHome, codexHome, freebuffConfigDir } from "../src/paths.mjs";

test("Trebell paths are isolated from ~/.codex and ~/.config/freebuff2api", () => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  const env = { ...process.env, TREBELL_HOME: root };
  assert.equal(trebellHome(env), root);
  assert.equal(codexHome(env), join(root, "codex"));
  assert.equal(freebuffConfigDir(env), join(root, "freebuff2api"));
});

test("Codex provider config supports Freebuff and OpenAI-compatible providers", () => {
  const freebuff = renderCodexConfig({ port: 24444, provider: "freebuff" });
  assert.match(freebuff, /model_provider = "freebuff"/);
  assert.match(freebuff, /base_url = "http:\/\/127\.0\.0\.1:24444\/v1"/);
  assert.match(freebuff, /wire_api = "responses"/);
  assert.match(freebuff, /requires_openai_auth = false/);

  const router = renderCodexConfig({ provider: "agentrouter" });
  assert.match(router, /model_provider = "agentrouter"/);
  assert.match(router, /base_url = "https:\/\/co\.agentrouter\.org\/v1"/);
  assert.match(router, /env_key = "AGENTROUTER_API_KEY"/);
  assert.match(router, /wire_api = "chat"/);

  const worker = renderCodexConfig({ provider: "justworker" });
  assert.match(worker, /base_url = "https:\/\/api\.justwoker\.icu\/v1"/);
  assert.match(worker, /env_key = "JUSTWORKER_API_KEY"/);

  const hcn = renderCodexConfig({ provider: "hcnsec" });
  assert.match(hcn, /base_url = "https:\/\/api\.hcnsec\.cn\/v1"/);
  assert.match(hcn, /env_key = "HCNSEC_API_KEY"/);
});

test("ensureCodexConfig writes into Trebell home", () => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  const env = { ...process.env, TREBELL_HOME: root };
  const path = ensureCodexConfig({ port: 23333, provider: "agentrouter", env });
  assert.equal(path, join(root, "codex", "config.toml"));
  assert.match(readFileSync(path, "utf8"), /AgentRouter/);
});

test("run arg parser keeps runtime arguments while consuming Trebell flags", () => {
  assert.deepEqual(
    parseRunArgs(["--model", "freebuff/x/y", "--port", "24444", "--", "exec", "hello"]),
    { model: "freebuff/x/y", port: 24444, loginCheck: true, forwarded: ["exec", "hello"] },
  );
});

test("Codex args force the Freebuff provider", () => {
  assert.deepEqual(
    codexArgs({ model: "freebuff/a/b", forwarded: ["exec", "hi"] }),
    ["-c", 'model_provider="freebuff"', "-m", "freebuff/a/b", "exec", "hi"],
  );
});

test("terminal branding removes upstream product name from visible banner", () => {
  assert.equal(rebrandTerminalChunk(">_ OpenAI Codex\n"), ">_ Trebell Code\n");
  assert.equal(rebrandTerminalChunk("run codex now"), "run trebell now");
});
