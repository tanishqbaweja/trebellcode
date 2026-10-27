import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccountLabel, codexAccountStatus, readCodexAccount } from "../src/codex-account-probe.mjs";

// ChatGPT renamed its plans (T3 Code 33f1fe5eb): Pro is Pro 200, its lighter and larger tiers Pro 100 and Pro 500, and Team is
// Business, next to Business Premium. A Codex profile signed in with one of them is named the way ChatGPT names it.
test("a Codex profile signed in with ChatGPT names its plan with ChatGPT's current plan names",()=>{
  const label=planType=>codexAccountLabel({type:"chatgpt",email:"a@b.c",planType});
  assert.equal(label("pro"),"ChatGPT Pro 200");
  assert.equal(label("prolite"),"ChatGPT Pro 100");
  assert.equal(label("promax"),"ChatGPT Pro 500");
  assert.equal(label("self_serve_business_prolite"),"ChatGPT Business Premium");
  assert.equal(label("team"),"ChatGPT Business");
  // The names ChatGPT kept stay as they were.
  assert.equal(label("plus"),"ChatGPT Plus");
  assert.equal(label("business"),"ChatGPT Business");
  assert.equal(label("self_serve_business_usage_based"),"ChatGPT Business");
  assert.equal(label("enterprise"),"ChatGPT Enterprise");
  assert.equal(label("edu_pro"),"ChatGPT Edu");
  assert.equal(label("not-a-plan-yet"),"ChatGPT");
});

// A stand-in Codex app-server on stdio that answers initialize and account/read for the plan it is given.
const FAKE_CODEX=String.raw`
import { createInterface } from "node:readline";
const [planType]=process.argv.slice(2);
const lines=createInterface({input:process.stdin});
lines.on("line",line=>{
  const message=JSON.parse(line);if(message.id===undefined)return;
  const result=message.method==="initialize"?{userAgent:"codex_cli_rs/0.155.1 (Windows 11; x86_64) trebell"}:message.method==="account/read"?{account:{type:"chatgpt",email:"user@example.test",planType},requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:message.id,result})+"\n");
});
lines.on("close",()=>process.exit(0));
`;

test("the Codex account check reports a Pro, Pro 100 and Team sign-in with ChatGPT's names",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-plan-labels-"));
  try{
    const script=join(root,"codex.mjs");await writeFile(script,FAKE_CODEX,"utf8");
    const check=async planType=>codexAccountStatus((await readCodexAccount({spawnAppServer:args=>spawn(process.execPath,[script,planType,...args],{windowsHide:true,stdio:["pipe","pipe","pipe"]}),timeoutMs:15_000})).account);
    for(const [planType,label] of [["pro","ChatGPT Pro 200"],["prolite","ChatGPT Pro 100"],["team","ChatGPT Business"]]){
      const status=await check(planType);
      assert.deepEqual({ready:status.ready,authenticated:status.authenticated,label:status.label,message:status.message},{ready:true,authenticated:true,label,message:"Signed in with "+label},planType);
    }
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
