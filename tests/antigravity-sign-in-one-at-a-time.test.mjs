// Settings' Antigravity sign-in runs one at a time on the server, whichever window asked (T3 refuses a second Antigravity setup):
// a sign-in can take up to 5 minutes, and a form opened again meanwhile (Agents & models left and opened again, another window) has
// no sign-in of its own running. A second sign-in would start another Antigravity, which unpacks about 1 GB, and a Remove key would
// be undone once the running sign-in saved its key; both are refused, saying why, until the sign-in has ended. The GUI server runs
// outside mock mode with a stand-in for Antigravity's ACP server that answers authenticate a few seconds late.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { antigravityGui, until } from "./fixtures/antigravity-gui.mjs";

const FIRST="AIzaSyTrebellFixtureKeyFirst0123456789",SECOND="AIzaSyTrebellFixtureKeySecond012345678";

test("a second Antigravity sign-in, and Remove key, wait for the one that runs to end, and say so",{timeout:120_000},async t=>{
  const fx=await antigravityGui(t,{expectKey:FIRST,authenticateDelayMs:4000});
  const saved=async()=>JSON.parse(await readFile(join(fx.trebellHome,"harness-secrets.json"),"utf8").catch(()=>"{}"))["antigravity.geminiApiKey"]??null;
  const initializes=async()=>(await fx.log()).filter(entry=>entry.method==="initialize").length;
  const running=fx.post({action:"login",apiKey:FIRST});
  await until(async()=>(await fx.log()).some(entry=>entry.method==="authenticate"),"the first sign-in reached authenticate");
  const second=await fx.post({action:"login",apiKey:SECOND});
  assert.equal(second.status,400,"the second sign-in is refused");
  assert.equal(second.body.error,"Antigravity is already signing in with a Gemini API key, which can take up to 5 minutes. Try again once that sign-in has ended.");
  assert.equal(await initializes(),1,"no second Antigravity was started");
  const removed=await fx.post({action:"remove-key"});
  assert.equal(removed.status,400,"Remove key is refused while the sign-in runs");
  assert.equal(removed.body.error,"Antigravity is signing in with a Gemini API key, which it saves once it is signed in. Remove the key once that sign-in has ended.");
  const first=await running;
  assert.equal(first.status,200,first.text);assert.equal(await saved(),FIRST,"the running sign-in's key is saved, and was not removed under it");
  // Once it has ended, each is taken again.
  assert.equal((await fx.post({action:"remove-key"})).status,200);assert.equal(await saved(),null);
  assert.equal((await fx.post({action:"login",apiKey:SECOND})).status,200);assert.equal(await saved(),SECOND);
});

test("a sign-in that failed lets the next one run",{timeout:120_000},async t=>{
  const fx=await antigravityGui(t,{expectKey:FIRST,authenticate:{code:-32602,message:"Invalid params"}});
  const refused=await fx.post({action:"login",apiKey:FIRST});
  assert.equal(refused.status,400);assert.match(refused.body.error,/^Antigravity rejected the Gemini API key\./);
  await fx.scenario({expectKey:FIRST});
  assert.equal((await fx.post({action:"login",apiKey:FIRST})).status,200);
});
