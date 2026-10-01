import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("run arg parser keeps runtime arguments while consuming Trebell utility flags", () => {
  assert.deepEqual(
    parseRunArgs(["--model", "gpt-5.6-sol", "--port", "24444", "--", "exec", "hello"]),
    { model: "gpt-5.6-sol", provider: null, port: 24444, loginCheck: true, forwarded: ["exec", "hello"] },
  );
});

test("Codex args preserve Codex native provider configuration", () => {
  assert.deepEqual(
    codexArgs({ model: "gpt-5.6-sol", forwarded: ["exec", "hi"] }),
    ["-m", "gpt-5.6-sol", "exec", "hi"],
  );
  assert.throws(()=>codexArgs({provider:"freebuff"}),/native account\/provider configuration/i);
});

test("standalone Codex inherited process stays hidden on Windows",()=>{
  const source=readFileSync(new URL("../src/codex.mjs",import.meta.url),"utf8");
  assert.match(source,/stdio:\s*"inherit"[\s\S]{0,120}windowsHide:\s*true/);
  assert.doesNotMatch(source,/windowsHide:\s*false/);
});

test("standalone Codex child environment preserves Codex-native credentials without unrelated host secrets",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-codex-env-"));
  const env=codexChildEnvironment({
    PATH:process.env.PATH||"/usr/bin",
    HOME:root,
    USERPROFILE:root,
    TREBELL_HOME:root,
    CODEX_HOME:join(root,"native-codex-home"),
    OPENAI_API_KEY:"codex-openai-token",
    CODEX_API_KEY:"codex-native-token",
    GITHUB_TOKEN:"unrelated-secret",
    CUSTOM_PRIVATE_TOKEN:"hidden",
  });
  assert.equal(env.PATH,process.env.PATH||"/usr/bin");
  assert.equal(env.HOME,root);
  assert.equal(env.CODEX_HOME,join(root,"native-codex-home"));
  assert.equal(env.OPENAI_API_KEY,"codex-openai-token");
  assert.equal(env.CODEX_API_KEY,"codex-native-token");
  assert.equal(env.GITHUB_TOKEN,undefined);
  assert.equal(env.CUSTOM_PRIVATE_TOKEN,undefined);
});

test("terminal branding removes upstream product name from visible banner", () => {
  assert.equal(rebrandTerminalChunk(">_ OpenAI Codex\n"), ">_ Trebell Code\n");
  assert.equal(rebrandTerminalChunk("run codex now"), "run trebell now");
});
