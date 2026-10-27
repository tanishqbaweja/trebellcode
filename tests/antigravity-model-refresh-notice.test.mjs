// Antigravity's model list is a stand-in until a session of its own has read the account's list in the background. A refresh that
// ended because this machine gives Antigravity no IPv6 sockets says so beside the stand-in list, and the windows already open hear
// that the list changed (agentRuntime/models/updated, as a list a session read is announced), so their composer reads it again and
// shows why, rather than only after a reload.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ANTIGRAVITY_IPV6_MESSAGE } from "../src/antigravity-auth.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));

test("a model-list refresh Antigravity could not run for want of IPv6 sockets tells the open windows, which then read why",{timeout:60_000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-models-")),scenarioPath=join(root,"scenario.json");
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  await mkdir(join(root,"tmp"),{recursive:true});await mkdir(join(root,"person"),{recursive:true});
  await writeFile(scenarioPath,JSON.stringify({exitAt:"initialize",exitCode:1,stderr:"OSError: [Errno 97] Address family not supported by protocol (AF_INET6)\n"}));
  // The profile's own executable, a wrapper of the stand-in.
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  const env={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),HOME:join(root,"person"),USERPROFILE:join(root,"person"),TREBELL_HOME:join(root,"trebell"),TREBELL_AGY_SCENARIO:scenarioPath};
  const settings={agentRuntimeInstances:[{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,binaryPath:wrapper,environment:{},approvedEnvironmentKeys:["TREBELL_AGY_SCENARIO"]}]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env});
  const heard=[];let told;const told$=new Promise(resolve=>{told=resolve});
  const stop=manager.onModelsChanged(change=>{heard.push(change);told()});t.after(stop);
  const first=await manager.models("antigravity");
  assert.equal(first.source,"manifest");assert.equal(first.error,undefined,"the stand-in list, while the refresh runs");
  const timer=setTimeout(()=>told("timeout"),20_000);
  const outcome=await told$;clearTimeout(timer);
  assert.notEqual(outcome,"timeout","the open windows were told the list changed");
  assert.deepEqual(heard,[{runtime:"antigravity",instanceId:"antigravity-default",environmentId:null}]);
  const reread=await manager.models("antigravity");
  assert.equal(reread.error,ANTIGRAVITY_IPV6_MESSAGE);assert.ok(reread.models.length>0,"beside the stand-in list");
});
