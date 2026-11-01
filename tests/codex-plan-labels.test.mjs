import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccountLabel, codexAccountStatus, readCodexAccount } from "../src/codex-account-probe.mjs";

// Re-pinned: the names are now exactly those Codex's own /status shows (openai/codex codex-rs/tui/src/subscription.rs, Status, at
// 67f0994b). Changed from Trebell's earlier grouping: business reads Enterprise (it read Business), enterprise_cbp_automation reads
// Enterprise (Automation), edu_plus and edu_pro read Edu Plus and Edu Pro (both read Edu), and sci and sci_plus, which Codex added,
// read Academic Researchers and Academic Researchers Plus (both read plain ChatGPT).
test("a Codex profile signed in with ChatGPT names its plan as Codex's own status does",()=>{
  const label=planType=>codexAccountLabel({type:"chatgpt",email:"a@b.c",planType});
  assert.equal(label("pro"),"ChatGPT Pro 200");
  assert.equal(label("prolite"),"ChatGPT Pro 100");
  assert.equal(label("promax"),"ChatGPT Pro 500");
  assert.equal(label("self_serve_business_prolite"),"ChatGPT Business Premium");
  assert.equal(label("team"),"ChatGPT Business");
  assert.equal(label("plus"),"ChatGPT Plus");
  assert.equal(label("business"),"ChatGPT Enterprise");
  assert.equal(label("self_serve_business_usage_based"),"ChatGPT Business");
  assert.equal(label("enterprise"),"ChatGPT Enterprise");
  assert.equal(label("enterprise_cbp_automation"),"ChatGPT Enterprise (Automation)");
  assert.equal(label("edu_pro"),"ChatGPT Edu Pro");
  assert.equal(label("not-a-plan-yet"),"ChatGPT");
});

// Every plan type Codex can put in account/read (its PlanType in codex-rs/protocol/src/account.rs at openai/codex 67f0994b, whose
// names are the variants in lower case or as renamed there).
const CODEX_PLAN_TYPES=["free","go","plus","pro","prolite","promax","team","self_serve_business_prolite","self_serve_business_usage_based","business","ent26","enterprise_cbp_automation","enterprise_cbp_usage_based","enterprise","edu","edu_plus","edu_pro","sci","sci_plus","unknown"];

test("every plan Codex can report is named, and Codex's unknown plan is plain ChatGPT",()=>{
  const expected={free:"ChatGPT Free",go:"ChatGPT Go",plus:"ChatGPT Plus",pro:"ChatGPT Pro 200",prolite:"ChatGPT Pro 100",promax:"ChatGPT Pro 500",
    team:"ChatGPT Business",self_serve_business_prolite:"ChatGPT Business Premium",self_serve_business_usage_based:"ChatGPT Business",business:"ChatGPT Enterprise",
    ent26:"ChatGPT Enterprise",enterprise_cbp_automation:"ChatGPT Enterprise (Automation)",enterprise_cbp_usage_based:"ChatGPT Enterprise",enterprise:"ChatGPT Enterprise",
    edu:"ChatGPT Edu",edu_plus:"ChatGPT Edu Plus",edu_pro:"ChatGPT Edu Pro",sci:"ChatGPT Academic Researchers",sci_plus:"ChatGPT Academic Researchers Plus",unknown:"ChatGPT"};
  assert.deepEqual(Object.keys(expected).sort(),[...CODEX_PLAN_TYPES].sort(),"every plan type in Codex's list is checked");
  for(const planType of CODEX_PLAN_TYPES)assert.equal(codexAccountLabel({type:"chatgpt",email:"a@b.c",planType}),expected[planType],planType);
});

test("a plan with no name is plain ChatGPT, a plan is matched as Codex spells it, and the email is never shown",()=>{
  const label=planType=>codexAccountLabel({type:"chatgpt",email:"person@example.test",planType});
  for(const planType of ["Pro","PLUS"," pro","pro_max_2027",undefined,null,""])assert.equal(label(planType),"ChatGPT",String(planType));
  assert.equal(codexAccountLabel({type:"chatgpt",email:"person@example.test"}),"ChatGPT","an account with no plan at all");
  // Names every JavaScript object has are not plans: each one is plain ChatGPT, never an inherited function or object.
  for(const planType of ["constructor","toString","valueOf","hasOwnProperty","__proto__"])assert.equal(label(planType),"ChatGPT",planType);
  assert.equal(label("plus"),"ChatGPT Plus");assert.doesNotMatch(label("plus"),/person@example\.test/);
});

test("an API key, Amazon Bedrock, a kind of account Codex adds later and no account are each named as Settings shows them",()=>{
  assert.equal(codexAccountLabel({type:"apiKey"}),"OpenAI API key");
  assert.equal(codexAccountLabel({type:"amazonBedrock"}),"Amazon Bedrock");
  assert.equal(codexAccountLabel({type:"amazonBedrock",usesCodexManagedCredentials:true}),"Amazon Bedrock");
  assert.equal(codexAccountLabel({type:"futureProvider"}),"futureProvider","a kind Trebell does not know yet is shown by Codex's own name for it");
  for(const account of [null,undefined,"chatgpt",42,{},{type:""},{type:null}])assert.equal(codexAccountLabel(account),null,String(JSON.stringify(account)));
  assert.deepEqual(codexAccountStatus({account:{type:"amazonBedrock",usesCodexManagedCredentials:false},requiresOpenaiAuth:false}),{ready:true,authenticated:true,authType:"amazonBedrock",label:"Amazon Bedrock",message:"Signed in with Amazon Bedrock"});
  assert.deepEqual(codexAccountStatus({account:{},requiresOpenaiAuth:true}),{ready:true,authenticated:true,authType:null,label:null,message:"Signed in"},"an account with nothing to name it by is still signed in");
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
