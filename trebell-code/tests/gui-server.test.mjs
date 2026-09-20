import test from "node:test";
import assert from "node:assert/strict";
import { createGuiServer } from "../src/gui-server.mjs";

test("GUI server exposes mock bootstrap, Freebuff-only models, and health", async () => {
  const gui=await createGuiServer({port:33210,appPort:33456,mock:true});
  try{
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);
    assert.equal(boot.loggedIn,true);

    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.ok(models.models.length>=1);
    assert.ok(models.models.every(id=>id.startsWith("freebuff/")));

    const health=await fetch(gui.url+"/api/health").then(r=>r.json());
    assert.equal(health.ok,true);
  } finally {
    await gui.close();
  }
});
