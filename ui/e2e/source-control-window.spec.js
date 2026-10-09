import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const execFileAsync=promisify(execFile);

// A throwaway repository with one tracked change, registered as a project; close() restores the runtime and active-project settings and removes both.
async function commitWriterFixture(request,name){
  const root=await mkdtemp(join(tmpdir(),"trebell-source-writer-")),git=args=>execFileAsync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  await git(["init"]);await git(["config","user.email","trebell-test@example.invalid"]);await git(["config","user.name","Trebell Test"]);
  await writeFile(join(root,"notes.txt"),"before\n","utf8");await git(["add","notes.txt"]);await git(["commit","-m","Seed notes"]);await writeFile(join(root,"notes.txt"),"after\n","utf8");
  const previous=await (await request.get("/api/settings")).json();
  const {project}=await (await request.post("/api/projects",{data:{path:root,name}})).json();
  return {async close(){
    await request.post("/api/settings",{data:{agentRuntime:previous.agentRuntime||"codex",agentRuntimeInstanceId:previous.agentRuntimeInstanceId||null,modelProvider:previous.modelProvider||"openai",activeProjectId:previous.activeProjectId||null}}).catch(()=>{});
    if(project?.id)await request.delete("/api/projects?id="+encodeURIComponent(project.id)).catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }};
}

for(const [runtime,writer] of [["native","OpenAI API"],["codex","Codex"]]){
  test(`Generate names ${writer} as the commit text writer, as the server reports`,async({page,request})=>{
    test.setTimeout(40_000);
    const name="Source control writer "+runtime,fixture=await commitWriterFixture(request,name);
    try{
      await request.post("/api/settings",{data:{onboardingComplete:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai"}});
      await page.goto("/");await page.getByRole("button",{name:"Projects",exact:true}).click();
      const project=page.locator(".project-card").filter({hasText:name});await expect(project).toBeVisible();await project.locator(".project-open").click();
      await page.getByTestId("right-panel-toggle").click();const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
      // Trebell Native writes with its model provider; any other runtime writes with the harness itself.
      const generate=right.getByRole("button",{name:"Generate with "+writer,exact:true});await expect(generate).toBeVisible({timeout:10_000});
      const reply=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/git/commit-message");
      await generate.click();
      const response=await reply;expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({message:"Mock generated commit",runtime,generatedWith:writer});
      await expect(right.getByPlaceholder("Commit message")).toHaveValue("Mock generated commit");
    }finally{await fixture.close()}
  });
}

test("large source control collections mount bounded windows",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control stress"}});

  const status=Array.from({length:200},(_,index)=>({code:" M",path:"src/generated/file-"+String(index).padStart(3,"0")+".js"}));
  const prs=Array.from({length:150},(_,index)=>({
    provider:"github",number:index+1,title:"Stress PR "+String(index+1).padStart(3,"0"),state:"OPEN",
    url:"https://example.test/pr/"+(index+1),headRefName:"feature-"+(index+1),baseRefName:"main",
  }));
  const files=Array.from({length:180},(_,index)=>({
    path:"src/changed/file-"+String(index).padStart(3,"0")+".js",additions:index+1,deletions:index%7,patch:"+ fixture",
  }));
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status,worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://example.test/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:prs}));
  await page.route("**/api/source-control/pr-detail?**",route=>{
    const number=Number(new URL(route.request().url()).searchParams.get("number"))||1;
    const pr=prs.find(item=>item.number===number)||prs[0];
    return json(route,{provider:"github",item:{...pr,body:"Large deterministic pull request fixture.",comments:[],reviews:[],files,statusCheckRollup:[]}});
  });
  await page.route("**/api/source-control/pr-viewed?**",route=>json(route,{provider:"github",store:"host",files:[]}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control stress"});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();

  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await right.getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(60);
  await expect(right.locator(".pr-list > button")).toHaveCount(60);
  await expect(right.getByRole("button",{name:"Show 60 more changes"})).toBeVisible();
  await expect(right.getByRole("button",{name:"Show 60 more PRs"})).toBeVisible();

  await right.getByRole("button",{name:"Show 60 more changes"}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(120);
  await right.getByRole("button",{name:"Show 60 more PRs"}).click();
  await expect(right.locator(".pr-list > button")).toHaveCount(120);

  await right.getByRole("button",{name:/#1 Stress PR 001/}).click();
  await expect(right.locator(".pr-file")).toHaveCount(60);
  await expect(right.getByRole("button",{name:"Show 60 more files"})).toBeVisible();
  await right.getByRole("button",{name:"Show 60 more files"}).click();
  await expect(right.locator(".pr-file")).toHaveCount(120);

  await page.setViewportSize({width:1280,height:800});
  await right.scrollIntoViewIfNeeded();
  const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-windowing-dark-1280x800.png",fullPage:true});
});

test("source control keeps the last-known Git version visible during diagnostics refresh",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control refresh state"}});

  const gitInfo={isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]};
  const diagnostics={selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  let diagnosticsCalls=0,resolveSecondStarted,resolveSecondRelease;
  const secondStarted=new Promise(resolve=>{resolveSecondStarted=resolve});
  const secondRelease=new Promise(resolve=>{resolveSecondRelease=resolve});
  await page.route("**/api/git/info?**",route=>json(route,gitInfo));
  await page.route("**/api/source-control/diagnostics?**",async route=>{
    diagnosticsCalls++;
    if(diagnosticsCalls===2){resolveSecondStarted();await secondRelease}
    return json(route,diagnostics);
  });
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:diagnostics.capabilities.github,items:[]}));
  await page.route("**/api/git/action",route=>json(route,{ok:true,result:{info:gitInfo}}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control refresh state"});
  await expect(project).toBeVisible();await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.getByText("Git: git version fixture",{exact:true})).toBeVisible();

  await right.getByRole("button",{name:"Fetch",exact:true}).click();
  await secondStarted;
  await expect(right.getByText("Git: git version fixture",{exact:true})).toBeVisible();
  await expect(right.getByText("Git: checking…",{exact:true})).toHaveCount(0);
  resolveSecondRelease();
  await expect(right.getByRole("button",{name:"Fetch",exact:true})).toBeEnabled();
  expect(diagnosticsCalls).toBe(2);
});

test("linked thread refresh failures retain last-known-good data for the same pull request",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control reliability"}});

  const pr={provider:"github",number:7,title:"Reliability PR",state:"OPEN",url:"https://example.test/pr/7",headRefName:"reliability",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"owner/repo",number:7}};
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:[pr]}));
  await page.route("**/api/source-control/pr-detail?**",route=>json(route,{provider:"github",item:{...pr,body:"Reliability fixture.",comments:[],reviews:[],files:[],statusCheckRollup:[]}}));
  await page.route("**/api/source-control/pr-viewed?**",route=>json(route,{provider:"github",store:"host",files:[]}));
  let reverseReads=0;
  await page.route(/\/api\/source-control\/thread-link\?/,route=>{
    reverseReads++;
    if(reverseReads===1)return json(route,{threads:[{threadId:"thread-stable",title:"Stable review thread",archived:false}]});
    return json(route,{error:"Deliberate reverse-link refresh failure"},500);
  });

  await page.goto("/");await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control reliability"});await expect(project).toBeVisible();await project.locator(".project-open").click();await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
  const prButton=right.getByRole("button",{name:/#7 Reliability PR/});await expect(prButton).toBeVisible();await prButton.click();await expect(right.getByText("Stable review thread")).toBeVisible();
  await prButton.click();await expect(right.getByText("Stable review thread")).toBeVisible();await expect(right.getByText(/Deliberate reverse-link refresh failure/)).toBeVisible();expect(reverseReads).toBe(2);
  await page.setViewportSize({width:1280,height:800});await right.scrollIntoViewIfNeeded();const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"source-control-linked-thread-refresh-failure-1280x800.png",fullPage:true});
});
