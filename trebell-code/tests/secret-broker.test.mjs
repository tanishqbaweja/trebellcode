import test from "node:test";
import assert from "node:assert/strict";
import { ScopedSecretBroker,secretNamesForScope } from "../src/secret-broker.mjs";

test("scoped secret broker exposes only credentials declared by the requested scope",async()=>{
  const broker=new ScopedSecretBroker({environment:{TREBELL_BITBUCKET_ACCESS_TOKEN:"bb-secret",UNRELATED_SECRET:"never"},platform:"linux"});
  assert.deepEqual(await broker.values("source-control.bitbucket"),{TREBELL_BITBUCKET_ACCESS_TOKEN:"bb-secret"});
  assert.equal(secretNamesForScope("source-control.bitbucket").includes("UNRELATED_SECRET"),false);
  await assert.rejects(()=>broker.values("arbitrary.environment"),/unknown secret scope/i);
});

test("remote secret broker reads only allowlisted names inside the pinned environment",async()=>{
  const calls=[],names=secretNamesForScope("source-control.bitbucket"),environments={
    get:id=>id==="ssh-1"?{id,type:"ssh",cwd:"/srv/app"}:null,
    executeArgv:async(id,request)=>{calls.push({id,request});return request.args[0]==="TREBELL_BITBUCKET_API_TOKEN"?{exitCode:0,stdout:"remote-token\n",stderr:""}:{exitCode:1,stdout:"",stderr:"missing"}},
  };
  const broker=new ScopedSecretBroker({environment:{UNRELATED_SECRET:"host-secret"},environments,environmentId:"ssh-1"});
  assert.deepEqual(await broker.values("source-control.bitbucket"),{TREBELL_BITBUCKET_API_TOKEN:"remote-token"});
  assert.equal(calls.length,names.length);for(const call of calls){assert.equal(call.id,"ssh-1");assert.equal(call.request.command,"printenv");assert.deepEqual(call.request.environmentNames,names);assert.equal(call.request.args.length,1);assert.ok(names.includes(call.request.args[0]))}
  assert.doesNotMatch(JSON.stringify(calls),/host-secret|UNRELATED_SECRET/);
});

test("secret broker refuses a missing pinned environment instead of falling back to host secrets",async()=>{
  const broker=new ScopedSecretBroker({environment:{TREBELL_BITBUCKET_ACCESS_TOKEN:"host-secret"},environments:{get:()=>null},environmentId:"gone"});
  await assert.rejects(()=>broker.values("source-control.bitbucket"),/environment is unavailable/i);
});
