import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteControlServer } from "../src/remote-control.mjs";

test("Trebell Remote uses the selected provider instead of hardcoding Freebuff", async () => {
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
    assert.match(html, /modelProviders:\[statusData\?\.provider\|\|'freebuff'\]/);
    assert.match(html, /modelProvider:statusData\?\.provider\|\|'freebuff'/);
    assert.doesNotMatch(html, /modelProvider:'freebuff'/);

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
