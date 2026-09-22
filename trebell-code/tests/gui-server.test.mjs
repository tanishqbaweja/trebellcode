import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    const remoteEnvironment=await fetch(gui.url+"/api/environments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      id:"ssh-test",name:"Remote test",type:"ssh",host:"example.invalid",cwd:"/srv/app",
    })}).then(r=>r.json());
    assert.equal(remoteEnvironment.profile.id,"ssh-test");
    const remoteProject=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:"/srv/app",environmentId:"ssh-test",
      scripts:[{id:"remote-dev",name:"Remote dev",command:"npm run dev"}],
    })}).then(r=>r.json());
    assert.equal(remoteProject.project.path,"/srv/app");
    assert.equal(remoteProject.project.environmentId,"ssh-test");
    const projectsAfter=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.equal(projectsAfter.projects.find(project=>project.id===remoteProject.project.id).environment.name,"Remote test");
    const remoteAction=await fetch(gui.url+"/api/project-script/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"/srv/app",environmentId:"ssh-test",scriptId:"remote-dev"})}).then(r=>r.json());
    assert.equal(remoteAction.ok,true);
    assert.equal(remoteAction.session.environmentId,"ssh-test");
    assert.equal(remoteAction.session.environmentType,"ssh");
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
    const visualizationDir=join(configProject,"artifacts");await mkdir(visualizationDir,{recursive:true});
    const visualizationPath=join(visualizationDir,"chart.html");await writeFile(visualizationPath,"<!doctype html><style>body{margin:0}</style><script>document.body.dataset.ready='1'</script>","utf8");
    const visualizationResponse=await fetch(gui.url+"/api/visualization?"+new URLSearchParams({root:configProject,path:visualizationPath}));
    assert.equal(visualizationResponse.status,200);assert.match(await visualizationResponse.text(),/dataset\.ready/);
    assert.match(visualizationResponse.headers.get("content-security-policy")||"",/connect-src 'none'/);
    assert.match(visualizationResponse.headers.get("content-security-policy")||"",/script-src 'unsafe-inline'/);
    const outsideVisualization=join(home,"outside.html");await writeFile(outsideVisualization,"<p>outside</p>","utf8");
    const blockedVisualization=await fetch(gui.url+"/api/visualization?"+new URLSearchParams({root:configProject,path:outsideVisualization}));
    assert.equal(blockedVisualization.status,400);
    const settings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({followUpMode:"steer"})}).then(r=>r.json());
    assert.equal(settings.followUpMode,"steer");
    const meta=await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-test",patch:{pinned:true}})}).then(r=>r.json());
    assert.equal(meta.pinned,true);
    const general=await fetch(gui.url+"/api/general-workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({environmentId:null})}).then(r=>r.json());
    assert.equal(general.environmentId,null);
    assert.equal(general.remote,false);
    assert.equal(general.environmentName,"Local machine");
    assert.equal((await stat(general.path)).isDirectory(),true);
    assert.match(general.path,/general$/);
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-branch",patch:{
      cwd:projectPath,environmentId:null,branch:"feature/x",sectionName:"Active",
      branchPullRequest:{identity:{provider:"github",host:"github.com",repository:"acme/widget",number:21},number:21,title:"Detected review",state:"OPEN",url:"https://github.com/acme/widget/pull/21",headRefName:"feature/x",baseRefName:"main"},
      lastBranchPullRequestSyncAt:123,
    }})});
    const branchReviews=await fetch(gui.url+"/api/source-control/branch-reviews").then(r=>r.json());
    const detectedReview=branchReviews.items.find(item=>item.threadId==="thread-branch");
    assert.equal(detectedReview.branch,"feature/x");assert.equal(detectedReview.review.number,21);assert.equal(detectedReview.lastSyncedAt,123);
    const linked=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"link",threadId:"thread-test",refresh:false,source:"manual",pr:{
        identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},
        number:17,title:"Linked review",state:"OPEN",url:"https://github.com/acme/widget/pull/17",headRefName:"feature",baseRefName:"main",
      },
    })}).then(r=>r.json());
    assert.equal(linked.ok,true);assert.equal(linked.links.length,1);assert.equal(linked.link.identity.repository,"acme/widget");
    const threadLinks=await fetch(gui.url+"/api/source-control/thread-link?threadId=thread-test").then(r=>r.json());
    assert.equal(threadLinks.links[0].snapshot.title,"Linked review");
    const reverse=await fetch(gui.url+"/api/source-control/thread-link?host=github.com&repository=acme%2Fwidget&number=17&provider=github").then(r=>r.json());
    assert.equal(reverse.threads.some(thread=>thread.threadId==="thread-test"),true);
    const unlinked=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"unlink",threadId:"thread-test",identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},
    })}).then(r=>r.json());
    assert.equal(unlinked.links.length,0);
    await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({autoSettleMergedThreads:true})});
    await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"link",threadId:"thread-settle",refresh:false,source:"manual",pr:{
        identity:{provider:"github",host:"github.com",repository:"acme/widget",number:18},
        number:18,title:"Finished review",state:"MERGED",url:"https://github.com/acme/widget/pull/18",headRefName:"done",baseRefName:"main",mergedAt:"2026-09-22T10:00:00Z",
      },
    })});
    const syncedTerminal=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"sync",threadId:"thread-settle"})}).then(r=>r.json());
    assert.equal(syncedTerminal.lifecycle.terminal,true);assert.ok(syncedTerminal.pendingSettlement?.signature);
    const settlements=await fetch(gui.url+"/api/source-control/settlements").then(r=>r.json());
    assert.equal(settlements.enabled,true);assert.equal(settlements.items.some(item=>item.threadId==="thread-settle"),true);

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
