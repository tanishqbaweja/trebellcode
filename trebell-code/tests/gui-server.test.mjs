import test from "node:test";
import assert from "node:assert/strict";
import { createGuiServer } from "../src/gui-server.mjs";

test("GUI server exposes mock bootstrap, Freebuff-only models, and health", async () => {
  const gui=await createGuiServer({port:33210,appPort:33456,mock:true});
  try{
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);
    assert.equal(boot.loggedIn,true);
    assert.equal(boot.version,"0.6.0");

    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.ok(models.models.length>=1);
    assert.ok(models.models.every(id=>id.startsWith("freebuff/")));

    const projectsBefore=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.ok(Array.isArray(projectsBefore.projects));
    const settings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({followUpMode:"steer"})}).then(r=>r.json());
    assert.equal(settings.followUpMode,"steer");
    const meta=await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-test",patch:{pinned:true}})}).then(r=>r.json());
    assert.equal(meta.pinned,true);

    const overview=await fetch(gui.url+"/api/freebuff/overview?model=freebuff/deepseek/deepseek-v4-flash&timezone=UTC").then(r=>r.json());
    assert.equal(overview.loggedIn,true);
    assert.equal(overview.derived.balance,86);
    assert.equal(overview.derived.selectedPrice.current,10);
    assert.equal(overview.streak.streak,6);

    const health=await fetch(gui.url+"/api/health").then(r=>r.json());
    assert.equal(health.ok,true);
  } finally {
    await gui.close();
  }
});
