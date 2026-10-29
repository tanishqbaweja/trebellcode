import test from "node:test";
import assert from "node:assert/strict";
import { codexAppServerEnvironment } from "../src/gui-server.mjs";

test("local Codex app-server receives only its bounded runtime environment, with no key",()=>{
  const env=codexAppServerEnvironment({
    platform:"linux",
    env:{
      PATH:"/usr/bin",
      HOME:"/home/test",
      OPENAI_API_KEY:"codex-runtime-key",
      GITHUB_TOKEN:"unrelated-secret",
      TEAM_PROXY:"http://proxy.test",
      TREBELL_PARENT_SECRET:"must-not-reach-codex",
    },
    runtimeInstance:{
      kind:"codex",
      approvedEnvironmentKeys:["TEAM_PROXY","OPENAI_API_KEY"],
      environment:{CUSTOM_MODE:"safe",CODEX_API_KEY:"profile-key"},
    },
    runtimeHome:"/home/test/.codex-work",
  });
  assert.equal(env.PATH,"/usr/bin");
  assert.equal(env.HOME,"/home/test");
  assert.equal(env.OPENAI_API_KEY,undefined,"Codex signs in with codex login, or, set to an API key, in a home of Trebell's own");
  assert.equal(env.CODEX_API_KEY,undefined);
  assert.equal(env.TEAM_PROXY,"http://proxy.test");
  assert.equal(env.CUSTOM_MODE,"safe");
  assert.equal(env.CODEX_HOME,"/home/test/.codex-work");
  assert.equal(env.GITHUB_TOKEN,undefined);
  assert.equal(env.TREBELL_PARENT_SECRET,undefined);
});
