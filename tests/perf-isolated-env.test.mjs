import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { isolatedEnv } from "../scripts/perf/lib/server.mjs";

// The perf tool starts the real GUI server, and through it real harnesses: none of them may see this machine's harness homes,
// credentials or the shell's own session.
test("the perf tool's measured processes get only system variables and user folders inside the run directory", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "trebell-perf-env-"));
  const leaks = { CLAUDE_CONFIG_DIR: "C:/Users/someone/.claude-session", CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-ant-real", OPENCODE_CONFIG_DIR: "C:/Users/someone/.config/opencode", TREBELL_LEAK_CANARY: "leaked" };
  const before = Object.fromEntries(Object.keys(leaks).map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, leaks);
    const env = isolatedEnv({ home: join(runDir, "trebell-home"), runDir, extra: { TREBELL_UI_DIST: "ui-dist" } });
    for (const name of ["CLAUDECODE", "ANTHROPIC_API_KEY", "OPENCODE_CONFIG_DIR", "TREBELL_LEAK_CANARY"]) assert.equal(env[name], undefined, name);
    const inside = value => { const path = relative(runDir, value); return !!path && !path.startsWith("..") && !isAbsolute(path); };
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TREBELL_HOME", "TEMP", "TMP", "npm_config_cache"])
      assert.ok(inside(env[name]), `${name} = ${env[name]}`);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.TREBELL_UI_DIST, "ui-dist");
    assert.match(await readFile(join(env.HOME, ".gitconfig"), "utf8"), /name = Trebell Perf/);
  } finally {
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(runDir, { recursive: true, force: true });
  }
});
