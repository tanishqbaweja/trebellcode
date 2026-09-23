import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteControlServer } from "../src/remote-control.mjs";

test("Trebell Remote keeps thread history provider-independent while new turns use the selected provider", async () => {
  const environments = {
    discover: async () => ({ profiles: [] }),
    probe: async () => ({}),
    execute: async () => ({}),
  };
  const remote = await createRemoteControlServer({
    port: 0,
    token: "test-token",
    version: "1.0.0-test",
    appPort: 65534,
    enabled: () => false,
    environments,
    getStatus: async () => ({
      provider: "vyceai",
      providerReady: true,
      model: "deepseek-v4.1",
      cwd: process.cwd(),
    }),
    host: "127.0.0.1",
  });

  try {
    const html = await fetch(`http://127.0.0.1:${remote.port}/`).then(r => r.text());
    assert.match(html, /request\('thread\/list',\{limit:50,sortKey:'updated_at',sortDirection:'desc'\}\)/);
    assert.match(html, /request\('thread\/resume',\{\.\.\.params,excludeTurns:true\}\)/);
    assert.match(html, /request\('thread\/items\/list',\{threadId:th\.id,cursor,limit:100,sortDirection:'desc'\}\)/);
    assert.match(html, /while\(cursor&&pages<4\)/);
    assert.match(html, /historyMode==='paginated'/);
    assert.match(html, /const legacy=await request\('thread\/resume',\{\.\.\.params,excludeTurns:false\}\)/);
    assert.match(html, /\['thread\/started','thread\/name\/updated','thread\/archived','thread\/unarchived','thread\/deleted','thread\/closed'\]\.includes\(msg\.method\)/);
    assert.match(html, /clearActiveThread\(p\.threadId\)/);
    assert.doesNotMatch(html, /modelProviders:/);
    assert.match(html, /modelProvider:statusData\?\.provider\|\|'freebuff'/);
    assert.doesNotMatch(html, /modelProvider:'freebuff'/);
    assert.match(html, /mcpServer\/elicitation\/request/);
    assert.match(html, /mcpServerOpenaiFormElicitation:true/);
    assert.match(html, /permissions:accept\?\(msg\.params\?\.permissions\|\|\{\}\):\{\}/);

    const status = await fetch(`http://127.0.0.1:${remote.port}/api/status`, {
      headers: { authorization: "Bearer test-token" },
    }).then(r => r.json());
    assert.equal(status.provider, "vyceai");
    assert.equal(status.providerReady, true);
    assert.equal(status.model, "deepseek-v4.1");
  } finally {
    await remote.close();
  }
});
