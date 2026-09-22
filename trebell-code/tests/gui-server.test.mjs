import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";

const packageVersion=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version;
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("GUI server exposes mock bootstrap, provider models, and health", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-test-"));
  const env={...process.env,TREBELL_HOME:home};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  try{
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);
    assert.equal(boot.loggedIn,true);
    assert.equal(boot.version,packageVersion);

    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.ok(models.models.length>=1);
    assert.equal(models.metadata.provider,boot.provider);
    assert.ok(models.metadata.models.every(model=>model.provider===boot.provider));

    const projectsBefore=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.ok(Array.isArray(projectsBefore.projects));
    const projectPath=process.cwd();
    const projectSaved=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:projectPath,
      scripts:[{id:"dev",name:"Dev server",command:"npm run dev",previewUrl:"http://localhost:5173",autoOpenPreview:true}],
      preferredScriptId:"dev",
    })}).then(r=>r.json());
    assert.equal(projectSaved.project.scripts[0].id,"dev");
    const actionRun=await fetch(gui.url+"/api/project-script/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:projectPath,scriptId:"dev"})}).then(r=>r.json());
    assert.equal(actionRun.ok,true);
    assert.equal(actionRun.session.id,"mock-project-action");
    assert.equal(actionRun.previewUrl,"http://localhost:5173");
    const previewServers=await fetch(gui.url+"/api/preview/servers").then(r=>r.json());
    assert.ok(Array.isArray(previewServers.servers));
    const suggested=await fetch(gui.url+"/api/project-actions/suggestions?path="+encodeURIComponent(projectPath)).then(r=>r.json());
    assert.ok(Array.isArray(suggested.scripts));
    assert.ok(suggested.scripts.some(script=>script.source==="package.json"));
    const configProject=join(home,"t3-project");await import("node:fs/promises").then(fs=>fs.mkdir(configProject,{recursive:true}));
    await writeFile(join(configProject,"t3.json"),JSON.stringify({defaultThreadEnvMode:"worktree",worktreeSubmodules:"top-level",scripts:[]}));
    const t3Suggested=await fetch(gui.url+"/api/project-actions/suggestions?path="+encodeURIComponent(configProject)).then(r=>r.json());
    assert.equal(t3Suggested.t3.defaultThreadEnvMode,"worktree");assert.equal(t3Suggested.t3.worktreeSubmodules,"top-level");
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

    const devices=await fetch(gui.url+"/api/devices").then(r=>r.json());
    assert.ok(devices.capabilities?.android);
    assert.ok(devices.capabilities?.ios);
    assert.ok(Array.isArray(devices.devices));
    assert.ok(devices.devices.every(device=>device.platform!=="android"||String(device.serial||"").startsWith("emulator-")));
  } finally {
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
