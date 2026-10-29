// What Trebell keeps of a harness's own answers is kept per sign-in: a profile moved between its own login and its API key (or onto
// another key) is asked again, never served what the other answered. Claude Code's capability probe (its models, slash commands,
// account and plan usage, which the Usage card shows) is kept five minutes per command, Claude home, folder and machine, and per
// sign-in (the key its launch has, by a fingerprint, or none); Antigravity's model list, which its sessions report, per profile,
// environment and sign-in. Fakes only: a scripted probe stands in for Claude Code, fixture keys, fresh folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { createClaudeCapabilitiesCache } from "../src/claude-capabilities.mjs";

function fixture(t,profile,{probe}={}){
  const home=mkdtempSync(join(tmpdir(),"trebell-sign-in-readings-"));t.after(()=>rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={PATH:"",HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex")};
  const providers=new ProviderManager({env});
  let settings={agentRuntime:profile.kind,agentRuntimeInstanceId:profile.id,agentRuntimeInstances:[profile]};
  const state={settings:()=>settings,updateSettings:patch=>{settings={...settings,...patch};return settings}};
  const runtimes=new AgentRuntimeManager({state,env,platform:"linux",providers,...(probe?{claudeCapabilitiesCache:createClaudeCapabilitiesCache({probe})}:{})});
  return {providers,runtimes};
}
const CLAUDE={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,environment:{}};
// What Claude Code's initialize reports: on a key the API key's account (no plan), else the person's claude.ai login and its plan.
function claudeProbe(probes){
  return async({env})=>{
    const key=env?.ANTHROPIC_API_KEY||null;probes.push(key);
    return key?{models:[{value:"default",displayName:"Default (API)"}],commands:[],agents:[],account:{tokenSource:"none",apiKeySource:"ANTHROPIC_API_KEY"}}
      :{models:[{value:"default",displayName:"Default (Max)"}],commands:[],agents:[],account:{tokenSource:"claude.ai",email:"person@example.invalid",subscriptionType:"max"}};
  };
}

test("Claude Code moved from Sign in to its API key, onto another key and back is asked again each time, never served the other's probe",async t=>{
  const probes=[],{providers,runtimes}=fixture(t,CLAUDE,{probe:claudeProbe(probes)});
  assert.equal((await runtimes.claudeCapabilities(CLAUDE)).account.subscriptionType,"max");
  providers.setKey("anthropic","sk-ant-fixture-1");
  const {instance:onKey}=runtimes.setAuthMethod("claude-default","api-key");
  assert.equal((await runtimes.claudeCapabilities(onKey)).account.apiKeySource,"ANTHROPIC_API_KEY","the account it runs on now");
  assert.deepEqual(probes,[null,"sk-ant-fixture-1"],"asked again on its key");
  await runtimes.claudeCapabilities(onKey);assert.equal(probes.length,2,"kept on the same key");
  providers.setKey("anthropic","sk-ant-fixture-2");
  await runtimes.claudeCapabilities(onKey);assert.deepEqual(probes.at(-1),"sk-ant-fixture-2","asked again on the key saved now");
  const {instance:own}=runtimes.setAuthMethod("claude-default","sign-in");
  const back=await runtimes.claudeCapabilities(own);
  assert.equal(back.account.subscriptionType,"max","its own login's probe, not the key's");assert.equal(back.account.apiKeySource,undefined);
  // A sign-out found drops every sign-in's probe for that Claude Code and home.
  const count=probes.length;runtimes.dropClaudeCapabilities(own);await runtimes.claudeCapabilities(own);assert.equal(probes.length,count+1);
});

test("Antigravity's model list a session reported on one sign-in is not served on the other, nor one key's on another",async t=>{
  const agy={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{}};
  const {providers,runtimes}=fixture(t,agy);
  runtimes.probe=async instance=>({id:instance.id,kind:"antigravity",available:true,installed:true});
  const list=id=>({configOptions:[{id:"model",name:"model",category:"model",type:"select",currentValue:id,options:[{value:id,name:id}]}]});
  runtimes.rememberAcpSessionModels(agy,list("gemini-own-sign-in"));
  assert.deepEqual((await runtimes.models(agy)).models,["gemini-own-sign-in"]);
  providers.setKey("gemini","AIzaSyTrebellFixtureKeyOne0123456789012");
  const {instance:onKey}=runtimes.setAuthMethod("antigravity-default","api-key");
  const first=await runtimes.models(onKey);
  assert.equal(first.source,"manifest","the stand-in list until a session on the key reports its own");assert.notDeepEqual(first.models,["gemini-own-sign-in"]);
  runtimes.rememberAcpSessionModels(onKey,list("gemini-key-one"));
  assert.deepEqual((await runtimes.models(onKey)).models,["gemini-key-one"]);
  providers.setKey("gemini","AIzaSyTrebellFixtureKeyTwo0123456789012");
  assert.equal((await runtimes.models(onKey)).source,"manifest","another key's list is its own");
  const {instance:own}=runtimes.setAuthMethod("antigravity-default","sign-in");
  assert.deepEqual((await runtimes.models(own)).models,["gemini-own-sign-in"],"its own sign-in's list again");
});
