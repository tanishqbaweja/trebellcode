// A harness's sign-in over ACP (authenticate) can wait on the person, a sign-in in the browser for one, so its caller sets how long
// it waits; two minutes unless set.
import test from "node:test";
import assert from "node:assert/strict";
import { inlineAcpAgent, within } from "./fixtures/inline-acp-agent.mjs";

test("authenticate waits as long as it is told, and two minutes when it is not",{timeout:30000},async t=>{
  // The agent answers initialize and never authenticate, as one waiting on a sign-in in the browser.
  const {client}=await inlineAcpAgent(t,`if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});`);
  await client.start();await client.initialize();
  const started=Date.now();
  await assert.rejects(within(client.authenticate("login",{timeoutMs:1000}),8000,"authenticate's timeout"),/authenticate timed out/);
  assert.ok(Date.now()-started<8000);
  const asked=[];client.request=(method,params,timeoutMs)=>{asked.push([method,params,timeoutMs]);return Promise.resolve({})};
  await client.authenticate("login");await client.authenticate("oauth",{timeoutMs:300_000});
  assert.deepEqual(asked,[["authenticate",{methodId:"login"},120_000],["authenticate",{methodId:"oauth"},300_000]]);
});
