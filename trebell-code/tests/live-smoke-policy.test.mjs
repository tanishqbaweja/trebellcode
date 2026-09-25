import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";

test("live smoke guard refuses accidental execution without explicit opt-in",()=>{
  assert.throws(()=>createLiveSmokeGuard({env:{},argv:[],provider:"vyceai",model:"test"}),/disabled by default/i);
});

test("live smoke guard enforces declared turn budgets and emits a secret-free fingerprint",()=>{
  const guard=createLiveSmokeGuard({env:{TREBELL_LIVE_SMOKE:"1",VYCEAI_API_KEY:"secret"},argv:[],provider:"vyceai",model:"deepseek-v4.1",runtime:"codex",maxTurns:2,timeoutMs:30_000});
  guard.consumeTurn("direct inference");guard.consumeTurn("agent turn");
  assert.throws(()=>guard.consumeTurn("extra turn"),/turn budget exhausted/i);
  const fingerprint=guard.fingerprint();assert.equal(fingerprint.provider,"vyceai");assert.equal(fingerprint.usedTurns,2);assert.equal(fingerprint.maxTurns,2);
  assert.doesNotMatch(JSON.stringify(fingerprint),/secret/);
});

test("live smoke guard accepts --live and caps configured wall time",()=>{
  const guard=createLiveSmokeGuard({env:{TREBELL_LIVE_SMOKE_TIMEOUT_MS:"9999999"},argv:["--live"],maxTurns:1,timeoutMs:20_000});
  assert.equal(guard.timeoutMs,600_000);assert.equal(guard.maxTurns,1);
});
