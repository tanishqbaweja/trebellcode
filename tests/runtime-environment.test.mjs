import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEnvironment, normalizeApprovedEnvironmentKeys, runtimeEnvironmentKeys } from "../src/runtime-environment.mjs";

test("runtime environments keep OS essentials and only the selected runtime credentials",()=>{
  const parent={
    PATH:"/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8",
    ANTHROPIC_API_KEY:"claude-secret",OPENAI_API_KEY:"openai-secret",XAI_API_KEY:"xai-secret",
    GITHUB_TOKEN:"github-secret",AWS_SECRET_ACCESS_KEY:"aws-secret",TREBELL_INTERNAL_SECRET:"trebell-secret",
  };
  const claude=buildRuntimeEnvironment("claude",{parent,platform:"linux"});
  assert.equal(claude.PATH,"/usr/bin");assert.equal(claude.HOME,"/home/me");assert.equal(claude.ANTHROPIC_API_KEY,"claude-secret");
  assert.equal(claude.OPENAI_API_KEY,undefined);assert.equal(claude.XAI_API_KEY,undefined);assert.equal(claude.GITHUB_TOKEN,undefined);assert.equal(claude.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(claude.TREBELL_INTERNAL_SECRET,undefined);
  const codex=buildRuntimeEnvironment("codex",{parent,platform:"linux"});assert.equal(codex.OPENAI_API_KEY,"openai-secret");assert.equal(codex.ANTHROPIC_API_KEY,undefined);
});

test("explicit inherited variable names expose values without persisting them in the profile",()=>{
  const parent={PATH:"/bin",AWS_SECRET_ACCESS_KEY:"approved-secret",TEAM_FEATURE_FLAG:"yes",UNRELATED_SECRET:"nope"};
  const approved=normalizeApprovedEnvironmentKeys(["AWS_SECRET_ACCESS_KEY","TEAM_FEATURE_FLAG","TEAM_FEATURE_FLAG","not-valid?"]);
  assert.deepEqual(approved,["AWS_SECRET_ACCESS_KEY","TEAM_FEATURE_FLAG"]);
  const env=buildRuntimeEnvironment("opencode",{parent,approved,overrides:{CUSTOM_MODE:"safe"},platform:"linux"});
  assert.equal(env.AWS_SECRET_ACCESS_KEY,"approved-secret");assert.equal(env.TEAM_FEATURE_FLAG,"yes");assert.equal(env.CUSTOM_MODE,"safe");assert.equal(env.UNRELATED_SECRET,undefined);
  assert.ok(runtimeEnvironmentKeys("opencode",{approved}).includes("AWS_SECRET_ACCESS_KEY"));
});

test("OpenCode receives supported upstream provider variables without inheriting unrelated credentials",()=>{
  const parent={PATH:"/bin",HF_TOKEN:"hf-value",NVIDIA_API_KEY:"nv-value",OPENAI_API_KEY:"oa-value",GEMINI_API_KEY:"gem-value",GITHUB_TOKEN:"github-value",CI_DEPLOY_TOKEN:"ci-value"};
  const env=buildRuntimeEnvironment("opencode",{parent,platform:"linux"});
  assert.equal(env.HF_TOKEN,"hf-value");assert.equal(env.NVIDIA_API_KEY,"nv-value");assert.equal(env.OPENAI_API_KEY,"oa-value");assert.equal(env.GEMINI_API_KEY,"gem-value");
  assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.CI_DEPLOY_TOKEN,undefined);
});

test("Antigravity receives Google authentication inputs without inheriting unrelated secrets",()=>{
  const parent={PATH:"/bin",HOME:"/home/me",GOOGLE_API_KEY:"google-value",GOOGLE_CLOUD_PROJECT:"project-a",GOOGLE_APPLICATION_CREDENTIALS:"/home/me/adc.json",OPENAI_API_KEY:"other-provider",GITHUB_TOKEN:"unrelated"};
  const env=buildRuntimeEnvironment("antigravity",{parent,platform:"linux"});
  assert.equal(env.GOOGLE_API_KEY,"google-value");assert.equal(env.GOOGLE_CLOUD_PROJECT,"project-a");assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS,"/home/me/adc.json");
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITHUB_TOKEN,undefined);
});

test("Windows runtime environment lookup handles Path casing without copying unrelated variables",()=>{
  const env=buildRuntimeEnvironment("cursor",{parent:{Path:"C:\\Tools",USERPROFILE:"C:\\Users\\me",CURSOR_AUTH_TOKEN:"cursor-secret",RANDOM_TOKEN:"nope"},platform:"win32"});
  assert.equal(env.PATH,"C:\\Tools");assert.equal(env.USERPROFILE,"C:\\Users\\me");assert.equal(env.CURSOR_AUTH_TOKEN,"cursor-secret");assert.equal(env.RANDOM_TOKEN,undefined);
});

test("Antigravity inherits only its explicit Google auth lane plus the OS baseline",()=>{
  const env=buildRuntimeEnvironment("antigravity",{parent:{PATH:"/bin",GEMINI_HOME:"/tmp/gemini",GEMINI_API_KEY:"gem-value",GOOGLE_CLOUD_PROJECT:"project-value",OPENAI_API_KEY:"nope",GITHUB_TOKEN:"nope"},platform:"linux"});
  assert.equal(env.GEMINI_HOME,"/tmp/gemini");assert.equal(env.GEMINI_API_KEY,"gem-value");assert.equal(env.GOOGLE_CLOUD_PROJECT,"project-value");assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITHUB_TOKEN,undefined);
});
