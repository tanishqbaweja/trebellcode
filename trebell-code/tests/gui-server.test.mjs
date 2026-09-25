import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer, offlineE2eFetch } from "../src/gui-server.mjs";

const packageVersion=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version;
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("offline browser E2E fetch allows loopback only",async()=>{
  const requested=[];
  const guarded=offlineE2eFetch(async(input)=>{
    requested.push(input instanceof URL?input.href:String(input?.url||input));
    return new Response("ok",{status:200});
  });
  for(const url of ["http://127.0.0.1:3210/health","http://localhost:23333/state","http://[::1]:8080/"]){
    const response=await guarded(url);
    assert.equal(response.status,200);
  }
  await assert.rejects(()=>guarded("https://api.openai.com/v1/models"),/blocked external network request/);
  await assert.rejects(()=>guarded("https://api.github.com/repos/tanishqbaweja/trebellcode"),/blocked external network request/);
  await assert.rejects(()=>guarded("https://example.com/"),/blocked external network request/);
  assert.equal(requested.length,3);
});

test("offline browser E2E refuses to start a real provider or Codex app-server",async()=>{
  await assert.rejects(
    ()=>createGuiServer({mock:false,env:{...process.env,TREBELL_E2E_OFFLINE:"1"}}),
    /Offline browser E2E forbids starting a real Trebell provider or Codex app-server/,
  );
  const previous=process.env.TREBELL_E2E_OFFLINE;
  process.env.TREBELL_E2E_OFFLINE="1";
  try{
    await assert.rejects(
      ()=>createGuiServer({mock:false,env:{TREBELL_HOME:process.env.TREBELL_HOME||""}}),
      /Offline browser E2E forbids starting a real Trebell provider or Codex app-server/,
    );
  }finally{
    if(previous==null)delete process.env.TREBELL_E2E_OFFLINE;
    else process.env.TREBELL_E2E_OFFLINE=previous;
  }
});

test("GUI server exposes mock bootstrap, provider models, and health", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-test-"));
  const externalCodexHome=join(home,"external-codex");const externalRollouts=join(externalCodexHome,"sessions","2026","09","23");await mkdir(externalRollouts,{recursive:true});
  const externalSessionId="12345678-1234-4abc-8123-123456789abc";
  await writeFile(join(externalRollouts,"rollout-import.jsonl"),[
    JSON.stringify({timestamp:"2026-09-23T01:00:00Z",type:"session_meta",payload:{id:externalSessionId,cwd:process.cwd()}}),
    JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"Imported GUI history fixture"}}),
  ].join("\n"));
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:externalCodexHome,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  try{
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);
    assert.equal(boot.loggedIn,true);
    assert.equal(boot.version,packageVersion);
    assert.equal(boot.runtimeCapabilities.nativeSandbox,true);
    assert.equal(boot.runtimeCapabilities.dynamicTools,true);

    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.ok(models.models.length>=1);
    const traces=await fetch(gui.url+"/api/traces?limit=20").then(r=>r.json());
    assert.ok(Array.isArray(traces.items));
    assert.equal(traces.journal.lastError,null);
    assert.equal(typeof traces.journal.records,"number");
    assert.equal(models.metadata.provider,boot.provider);
    assert.ok(models.metadata.models.every(model=>model.provider===boot.provider));
    const runtimeUsage=await fetch(gui.url+"/api/agent-runtime-usage").then(r=>r.json());
    assert.equal(runtimeUsage.runtime,"codex");
    assert.deepEqual(runtimeUsage.windows,[]);
    assert.equal(runtimeUsage.unavailable.reason,"unsupported");
    const runtimeAuth=await fetch(gui.url+"/api/agent-runtime-auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",runtime:"claude",environmentId:null,cwd:process.cwd()})}).then(r=>r.json());
    assert.equal(runtimeAuth.ok,true);
    assert.deepEqual(runtimeAuth.auth.args,["auth","login"]);
    assert.equal(runtimeAuth.session.id,"mock-runtime-auth");
    assert.equal(runtimeAuth.session.environmentId,null);

    const projectsBefore=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.ok(Array.isArray(projectsBefore.projects));
    const historyImport=await fetch(gui.url+"/api/history-import").then(r=>r.json());
    const codexHistory=historyImport.sessions.find(item=>item.providerSessionId===externalSessionId);
    assert.equal(codexHistory.source,"codex");assert.equal(codexHistory.title,"Imported GUI history fixture");assert.equal(codexHistory.alreadyImported,false);assert.equal(Object.prototype.hasOwnProperty.call(codexHistory,"sourcePath"),false);
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
    assert.equal(remoteEnvironment.profile.enabled,true);
    const disabledEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:false})}).then(r=>r.json());
    assert.equal(disabledEnvironment.profile.enabled,false);
    const disabledActivationResponse=await fetch(gui.url+"/api/environment/activate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test"})});
    assert.equal(disabledActivationResponse.status,400);
    assert.match((await disabledActivationResponse.json()).error,/switched off/i);
    const environmentsWhileDisabled=await fetch(gui.url+"/api/environments").then(r=>r.json());
    assert.equal(environmentsWhileDisabled.profiles.find(profile=>profile.id==="ssh-test").enabled,false);
    const enabledEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:true})}).then(r=>r.json());
    assert.equal(enabledEnvironment.profile.enabled,true);
    const activatedEnvironment=await fetch(gui.url+"/api/environment/activate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test"})}).then(r=>r.json());
    assert.equal(activatedEnvironment.activeEnvironmentId,"ssh-test");
    assert.equal(activatedEnvironment.agentRuntime,"codex");
    assert.equal(activatedEnvironment.agentRuntimeReady,true);
    assert.equal(activatedEnvironment.appServerReady,true);
    assert.ok(activatedEnvironment.agentRuntimeInstanceId);
    const disabledActiveEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:false})}).then(r=>r.json());
    assert.equal(disabledActiveEnvironment.activeEnvironmentId,null);
    const afterActiveDisable=await fetch(gui.url+"/api/environments").then(r=>r.json());
    assert.equal(afterActiveDisable.activeEnvironmentId,null);
    await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:true})});
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
    await mkdir(join(configProject,"src"),{recursive:true});
    await mkdir(join(configProject,"tests"),{recursive:true});
    await writeFile(join(configProject,"AGENTS.md"),"Prefer deterministic repository context.\n");
    await writeFile(join(configProject,"package.json"),JSON.stringify({packageManager:"pnpm@10.0.0",scripts:{test:"node --test",build:"vite build"}}));
    await writeFile(join(configProject,"src","session.js"),"export class RefreshSession { refresh(token) { return token; } }\n");
    await writeFile(join(configProject,"src","broken.ts"),"export const broken: string = ;\n");
    await writeFile(join(configProject,"tests","session.test.js"),"import { RefreshSession } from \"../src/session.js\";\nexport function testSession() { return new RefreshSession().refresh(\"x\"); }\n");
    const contextPacketResponse=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:configProject,task:"Fix refresh session",maxTokens:1200,maxFiles:6,environmentId:null})});
    assert.equal(contextPacketResponse.status,200);
    const contextPacket=await contextPacketResponse.json();
    assert.ok(contextPacket.items.some(item=>item.path==="src/session.js"));
    assert.match(contextPacket.injection,/Prefer deterministic repository context/);
    assert.ok(contextPacket.tokenEstimate<=1200);
    const symbolResponse=await fetch(gui.url+"/api/context/symbols?"+new URLSearchParams({path:configProject,q:"RefreshSession"}));
    assert.equal(symbolResponse.status,200);
    const symbolResult=await symbolResponse.json();
    assert.equal(symbolResult.data[0].name,"RefreshSession");
    assert.equal(symbolResult.data[0].path,"src/session.js");
    const fileResponse=await fetch(gui.url+"/api/context/files?"+new URLSearchParams({path:configProject,q:"session",limit:"10"}));
    assert.equal(fileResponse.status,200);
    const fileResult=await fileResponse.json();
    assert.ok(fileResult.data.some(item=>item.path==="src/session.js"&&item.indexedSource===true));
    const mapResponse=await fetch(gui.url+"/api/context/map?"+new URLSearchParams({path:configProject,q:"refresh session",limit:"10"}));
    assert.equal(mapResponse.status,200);
    const mapResult=await mapResponse.json();
    assert.ok(mapResult.data.some(item=>item.path==="src/session.js"&&item.definitions.some(definition=>definition.name==="RefreshSession")));
    const commandsResponse=await fetch(gui.url+"/api/context/commands?"+new URLSearchParams({path:configProject,limit:"10"}));
    assert.equal(commandsResponse.status,200);
    const commandsResult=await commandsResponse.json();
    assert.ok(commandsResult.declared.some(item=>item.command==="pnpm run test"&&item.confidence==="declared"));
    assert.ok(commandsResult.declared.some(item=>item.command==="pnpm run build"));
    const relationResponse=await fetch(gui.url+"/api/context/relations?"+new URLSearchParams({path:configProject,file:"src/session.js"}));
    assert.equal(relationResponse.status,200);
    const relationResult=await relationResponse.json();
    assert.equal(relationResult.path,"src/session.js");
    assert.ok(relationResult.definitions.some(item=>item.name==="RefreshSession"));
    const relatedTestsResponse=await fetch(gui.url+"/api/context/tests?"+new URLSearchParams({path:configProject,file:"src/session.js"}));
    assert.equal(relatedTestsResponse.status,200);
    const relatedTests=await relatedTestsResponse.json();
    assert.deepEqual(relatedTests.data.map(item=>item.path),["tests/session.test.js"]);
    const callsResponse=await fetch(gui.url+"/api/context/calls?"+new URLSearchParams({path:configProject,name:"RefreshSession",limit:"10"}));
    assert.equal(callsResponse.status,200);
    const callsResult=await callsResponse.json();
    assert.equal(callsResult.semantic,false);
    assert.ok(callsResult.callers.some(item=>item.path==="tests/session.test.js"&&item.caller==="testSession"&&item.kind==="construct"));
    const diagnosticsResponse=await fetch(gui.url+"/api/context/diagnostics?"+new URLSearchParams({path:configProject,file:"src/broken.ts",limit:"10"}));
    assert.equal(diagnosticsResponse.status,200);
    const diagnosticsResult=await diagnosticsResponse.json();
    assert.equal(diagnosticsResult.supported,true);assert.equal(diagnosticsResult.engine,"babel-parser");assert.equal(diagnosticsResult.semantic,false);assert.ok(diagnosticsResult.diagnostics.length>=1);
    const semanticDiagnosticsResponse=await fetch(gui.url+"/api/context/diagnostics?"+new URLSearchParams({path:configProject,file:"src/session.js",semantic:"true",limit:"10"}));
    assert.equal(semanticDiagnosticsResponse.status,200);
    const semanticDiagnosticsResult=await semanticDiagnosticsResponse.json();
    assert.equal(semanticDiagnosticsResult.semanticRequested,true);assert.equal(semanticDiagnosticsResult.semantic,false);assert.equal(semanticDiagnosticsResult.semanticInfo.available,false);
    const languageSymbolResponse=await fetch(gui.url+"/api/context/language-symbol?"+new URLSearchParams({path:configProject,file:"src/session.js",line:"1",column:"14",operation:"definition",limit:"10"}));
    assert.equal(languageSymbolResponse.status,200);
    const languageSymbolResult=await languageSymbolResponse.json();
    assert.equal(languageSymbolResult.supported,false);assert.equal(languageSymbolResult.semantic,false);assert.match(languageSymbolResult.reason,/TypeScript/i);
    const codeActionsResponse=await fetch(gui.url+"/api/context/code-actions?"+new URLSearchParams({path:configProject,file:"src/session.js",line:"1",column:"14",codes:"2322",limit:"10"}));
    assert.equal(codeActionsResponse.status,200);
    const codeActionsResult=await codeActionsResponse.json();
    assert.equal(codeActionsResult.supported,false);assert.equal(codeActionsResult.semantic,false);assert.deepEqual(codeActionsResult.actions,[]);assert.match(codeActionsResult.reason,/TypeScript/i);
    const referencesResponse=await fetch(gui.url+"/api/context/references?"+new URLSearchParams({path:configProject,name:"RefreshSession",limit:"10"}));
    assert.equal(referencesResponse.status,200);
    const referencesResult=await referencesResponse.json();
    assert.ok(referencesResult.data.some(item=>item.path==="src/session.js"&&item.definition===true&&item.precision==="ast"));
    const codeSearchResponse=await fetch(gui.url+"/api/context/search?"+new URLSearchParams({path:configProject,q:"RefreshSession",limit:"10"}));
    assert.equal(codeSearchResponse.status,200);
    const codeSearch=await codeSearchResponse.json();
    assert.ok(codeSearch.data.some(item=>item.path==="src/session.js"&&item.line===1));
    const sourceResponse=await fetch(gui.url+"/api/context/source?"+new URLSearchParams({path:configProject,file:"src/session.js",startLine:"1",endLine:"1"}));
    assert.equal(sourceResponse.status,200);
    const sourceRange=await sourceResponse.json();
    assert.equal(sourceRange.path,"src/session.js");assert.equal(sourceRange.startLine,1);assert.equal(sourceRange.endLine,1);assert.match(sourceRange.content,/RefreshSession/);
    const gitContextResponse=await fetch(gui.url+"/api/context/git?"+new URLSearchParams({path:configProject}));
    assert.equal(gitContextResponse.status,200);assert.equal((await gitContextResponse.json()).isGit,false);
    const historyResponse=await fetch(gui.url+"/api/context/history?"+new URLSearchParams({path:configProject,file:"src/session.js",limit:"5"}));
    assert.equal(historyResponse.status,200);assert.deepEqual((await historyResponse.json()).data,[]);
    const blameResponse=await fetch(gui.url+"/api/context/blame?"+new URLSearchParams({path:configProject,file:"src/session.js",startLine:"1",endLine:"1"}));
    assert.equal(blameResponse.status,400);
    const missingRelationResponse=await fetch(gui.url+"/api/context/relations?"+new URLSearchParams({path:configProject,file:"../outside.js"}));
    assert.equal(missingRelationResponse.status,400);
    const remoteContextResponse=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"/srv/app",task:"remote task",environmentId:"ssh-test"})});
    assert.equal(remoteContextResponse.status,400);
    assert.doesNotMatch((await remoteContextResponse.json()).error,/local workspaces only/i);
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
    const customCodexId="codex-settings-test";
    const customCodex=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",instance:{id:customCodexId,kind:"codex",displayName:"Settings API test",homePath:join(home,"codex-settings-test")}})}).then(r=>r.json());
    assert.equal(customCodex.instance.id,customCodexId);
    const codexSettingsResponse=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"codex",agentRuntimeInstanceId:customCodexId})});
    assert.equal(codexSettingsResponse.status,200);
    const codexSettings=await codexSettingsResponse.json();
    assert.equal(codexSettings.agentRuntime,"codex");assert.equal(codexSettings.agentRuntimeInstanceId,customCodexId);
    const codexRuntimeSnapshot=await fetch(gui.url+"/api/agent-runtimes").then(r=>r.json());
    assert.equal(codexRuntimeSnapshot.selectedRuntime,"codex");assert.equal(codexRuntimeSnapshot.selectedInstanceId,customCodexId);
    const codexBootstrap=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(codexBootstrap.agentRuntime,"codex");assert.equal(codexBootstrap.agentRuntimeInstanceId,customCodexId);
    const unavailableClaude=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default"})});
    if(unavailableClaude.status===400){
      const afterRejectedRuntime=await fetch(gui.url+"/api/agent-runtimes").then(r=>r.json());
      assert.equal(afterRejectedRuntime.selectedRuntime,"codex");assert.equal(afterRejectedRuntime.selectedInstanceId,customCodexId);
    }
    const resetCodex=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"codex",agentRuntimeInstanceId:"codex-default"})});
    assert.equal(resetCodex.status,200);
    const storageBefore=await fetch(gui.url+"/api/storage-cleanup").then(r=>r.json());
    assert.deepEqual(storageBefore.settings,{attachmentsAfterDays:null,terminalHistoryAfterDays:null});
    const storageSettings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({storageCleanup:{attachmentsAfterDays:7,terminalHistoryAfterDays:30}})}).then(r=>r.json());
    assert.deepEqual(storageSettings.storageCleanup,{attachmentsAfterDays:7,terminalHistoryAfterDays:30});
    const storageSweep=await fetch(gui.url+"/api/storage-cleanup",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json());
    assert.equal(storageSweep.attachments.enabled,true);assert.equal(storageSweep.attachments.removed,0);
    assert.equal(storageSweep.terminalHistory.enabled,false);
    const sourceDefaults=await fetch(gui.url+"/api/scoped-settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({environmentId:null,projectId:projectSaved.project.id,patch:{sourceControlMergeMethod:"rebase",sourceControlTextStyle:"repository",sourceControlTextModel:"freebuff/test/coding-fast"},resetKeys:[]})}).then(r=>r.json());
    assert.equal(sourceDefaults.effective.sourceControlMergeMethod,"rebase");
    assert.equal(sourceDefaults.effective.sourceControlTextStyle,"repository");
    assert.equal(sourceDefaults.effective.sourceControlTextModel,"freebuff/test/coding-fast");
    const commitText=await fetch(gui.url+"/api/git/commit-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:projectPath,environmentId:null,model:"freebuff/test/coding-large"})}).then(r=>r.json());
    assert.equal(commitText.message,"Mock generated commit");assert.equal(commitText.style,"repository");assert.equal(commitText.model,"freebuff/test/coding-fast");
    const reviewText=await fetch(gui.url+"/api/git/review-text",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:projectPath,environmentId:null,model:"freebuff/test/coding-large"})}).then(r=>r.json());
    assert.equal(reviewText.title,"Mock generated review");assert.equal(reviewText.body,"Mock generated description.");assert.equal(reviewText.style,"repository");assert.equal(reviewText.model,"freebuff/test/coding-fast");
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
