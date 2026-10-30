// Settings' Antigravity sign-in runs one at a time on the server, whichever window asked: a
// sign-in can take up to 5 minutes while the person finishes it in the browser, and a page opened again meanwhile (Agents & models
// left and opened again, another window) has no sign-in of its own running. A second one would start another Antigravity, which
// unpacks about 1 GB: it is refused, saying why, until the sign-in has ended. The GUI server runs outside mock mode with a stand-in
// for Antigravity's ACP server that answers authenticate a few seconds late.
import test from "node:test";
import assert from "node:assert/strict";
import { antigravityGui, until } from "./fixtures/antigravity-gui.mjs";

test("a second Antigravity sign-in waits for the one that runs to end, and says so",{timeout:120_000},async t=>{
  const fx=await antigravityGui(t,{authenticateDelayMs:4000});
  const initializes=async()=>(await fx.log()).filter(entry=>entry.method==="initialize").length;
  const running=fx.post({action:"login"});
  await until(async()=>(await fx.log()).some(entry=>entry.method==="authenticate"),"the first sign-in reached authenticate");
  const second=await fx.post({action:"login"});
  assert.equal(second.status,400,"the second sign-in is refused");
  assert.equal(second.body.error,"Antigravity is already signing in, which can take up to 5 minutes. Finish it in the browser page Antigravity opened, or try again once that sign-in has ended.");
  assert.equal(await initializes(),1,"no second Antigravity was started");
  const first=await running;
  assert.equal(first.status,200,first.text);assert.equal(first.body.auth.methodId,"oauth-personal");
  // Once it has ended, the next is taken.
  assert.equal((await fx.post({action:"login"})).status,200);
});

test("a sign-in that failed lets the next one run",{timeout:120_000},async t=>{
  const fx=await antigravityGui(t,{authenticate:{code:-32000,message:"Login was cancelled"}});
  const refused=await fx.post({action:"login"});
  assert.equal(refused.status,400);assert.equal(refused.body.error,"Antigravity could not sign in: Login was cancelled");
  await fx.scenario({});
  assert.equal((await fx.post({action:"login"})).status,200);
});
