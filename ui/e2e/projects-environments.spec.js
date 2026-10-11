import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The Projects and Environments pages, used the way a person uses them: real clicks and typing, with the server behind them.
const shots=fileURLToPath(new URL("../../visual-audit/polish/projects-environments/",import.meta.url));mkdirSync(shots,{recursive:true});
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"};
const MAIN="Polish Workspace";
const MODES=["dark","light"];
const LONG_NAME="A very long project name that somebody typed to describe their monorepo with services, tools and docs";
const SSH_PROFILE={id:"polish-ssh",name:"Build box",type:"ssh",host:"build.example.com",user:"dev",port:22,cwd:"",enabled:true};
// A project with every kind of saved setup: identity, actions, a hook, a recipe, overrides and cleanup rules.
const RICH_PROJECT={
  name:"Removable Project",
  icon:{kind:"emoji",value:"🧪",color:"#2f6fe0"},
  scripts:[
    {id:"dev-server",name:"Dev server",command:"npm run dev",previewUrl:"http://localhost:5173",autoOpenPreview:true,runOnWorktreeCreate:false,waitForSetup:false},
    {id:"unit-tests",name:"Unit tests",command:"npm test",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:true,waitForSetup:true},
  ],
  preferredScriptId:"unit-tests",
  hooks:[{id:"lint-gate",name:"Lint gate",event:"verification.required",command:"npm run lint",enabled:true,failureMode:"block",timeoutMs:45000,actions:[]}],
  recipes:[{id:"triage",name:"triage",title:"Triage",objective:"Find why the nightly build fails.",permission:"supervised",maxChildren:1}],
  defaultModel:"test/coding-fast",permissionMode:"edits",workspaceMode:"worktree",worktreeSubmodules:"top-level",
  worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:14,worktreeOnMerge:true,worktreeOnDelete:false,worktreeUnchanged:true}},
  settingsOverrides:{autoPull:true,sourceControlMergeMethod:"rebase"},
};

async function open(page,request,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  return boot;
}
const listedProjects=async request=>(await (await request.get("/api/projects")).json()).projects||[];
const listedEnvironments=async request=>(await (await request.get("/api/environments")).json()).profiles||[];
// What a person saved on a project: the record apart from its id and times, which a restore cannot keep.
const savedSetup=project=>{const {id,createdAt,lastOpenedAt,...rest}=project||{};return rest};
const flipMode=(page,mode)=>page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
const sideways=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);

// Each test leaves only the main project, under its own name, and no saved environments.
test.afterEach(async({request})=>{
  const boot=await (await request.get("/api/bootstrap")).json();
  for(const project of await listedProjects(request))if(project.path!==boot.cwd||project.environmentId)await request.delete("/api/projects?id="+encodeURIComponent(project.id));
  for(const profile of await listedEnvironments(request))await request.delete("/api/environments?id="+encodeURIComponent(profile.id));
  await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,icon:null}});
  await request.post("/api/settings",{data:BASE});
});

test.describe("Removing a project",()=>{
  for(const mode of MODES)test(`Undo brings the removed project back as it was, in its place (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,...RICH_PROJECT}});
    await request.post("/api/projects",{data:{path:join(boot.cwd,"docs"),name:"Neighbour Project"}});
    const before=(await listedProjects(request)).find(project=>project.path===path);
    let dialogs=0;page.on("dialog",dialog=>{dialogs++;dialog.dismiss().catch(()=>{})});
    await nav(page,"Projects").click();
    const card=page.locator(".project-card").filter({hasText:"Removable Project"});
    const titles=page.locator(".project-card .project-open strong");
    await expect(card).toBeVisible();
    await expect(page.locator(".project-group-head").first()).toContainText("3 checkouts");
    const order=await titles.allTextContents();
    await card.getByRole("button",{name:"Remove Removable Project",exact:true}).click();
    const toast=page.getByTestId("thread-undo-toast");
    await expect(toast).toContainText("Project “Removable Project” removed");
    await expect(card).toHaveCount(0);
    expect(dialogs,"a removal Undo can put back asks nothing").toBe(0);
    await page.screenshot({animations:"disabled",path:shots+`project-removed-undo-${mode}-1280.png`});
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(toast).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(titles).toHaveText(order);
    await expect(card.locator(".project-action-row")).toHaveCount(2);
    await expect(card.locator(".project-hook-row")).toHaveCount(1);
    await expect(card.locator(".project-icon-emoji")).toHaveText("🧪");
    const after=(await listedProjects(request)).find(project=>project.path===path);
    expect(savedSetup(after)).toEqual(savedSetup(before));
    await expect(page.locator(".projects-page").getByRole("alert")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:shots+`project-restored-${mode}-1280.png`});
  });

  test("a project that is still cloning asks first, names what is lost, and Cancel keeps it",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Cloning Project"}});
    // The list says this project is still cloning, as it does while a clone job runs.
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      const body=await (await route.fetch()).json();
      return json(route,{...body,projects:(body.projects||[]).map(project=>project.path===path?{...project,cloneJob:{id:"polish-clone",url:"https://github.com/owner/repo.git",status:"running",progress:40,phase:"Receiving objects",error:null,startedAt:Date.now(),completedAt:null}}:project)});
    });
    const deletes=[];page.on("request",request=>{if(request.method()==="DELETE"&&/\/api\/projects\?/.test(request.url()))deletes.push(request.url())});
    await nav(page,"Projects").click();
    const card=page.locator(".project-card").filter({hasText:"Cloning Project"});
    await expect(card.locator(".project-clone-status")).toContainText("Receiving objects");
    const asked=[];
    page.once("dialog",dialog=>{asked.push(dialog.message());dialog.dismiss().catch(()=>{})});
    await card.getByRole("button",{name:"Remove Cloning Project",exact:true}).click();
    await expect.poll(()=>asked.length).toBe(1);
    expect(asked[0]).toBe("Remove “Cloning Project” while it is still cloning? This cannot be undone: its saved actions, hooks and settings are lost. The clone keeps running.");
    await page.waitForTimeout(300);
    expect(deletes).toEqual([]);
    await expect(card).toBeVisible();
    page.once("dialog",dialog=>dialog.accept().catch(()=>{}));
    await card.getByRole("button",{name:"Remove Cloning Project",exact:true}).click();
    await expect(card).toHaveCount(0);
    expect(deletes.length).toBe(1);
    await expect(page.getByTestId("thread-undo-toast")).toHaveCount(0);
  });

  test("Undo still works once Projects is left, and a failed Undo says so where the person is",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,...RICH_PROJECT}});
    const before=(await listedProjects(request)).find(project=>project.path===path);
    await nav(page,"Projects").click();
    const card=page.locator(".project-card").filter({hasText:"Removable Project"}),toast=page.getByTestId("thread-undo-toast");
    // Undo from another page: the project is back the next time Projects opens.
    await card.getByRole("button",{name:"Remove Removable Project",exact:true}).click();
    await expect(toast).toContainText("Project “Removable Project” removed");
    await nav(page,"History").click();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(async()=>savedSetup((await listedProjects(request)).find(project=>project.path===path))).toEqual(savedSetup(before));
    await nav(page,"Projects").click();
    await expect(card.locator(".project-action-row")).toHaveCount(2);
    // A failed Undo on Projects shows in the page's alert, without the app's error toast.
    const failRestore=()=>page.route(/\/api\/projects$/,route=>route.request().method()==="POST"?json(route,{error:"Deliberate restore failure"},500):route.fallback());
    await card.getByRole("button",{name:"Remove Removable Project",exact:true}).click();
    await expect(card).toHaveCount(0);
    await failRestore();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(page.locator(".projects-page").getByRole("alert")).toContainText("Could not restore project: Deliberate restore failure");
    await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:shots+"project-undo-failed-on-projects-dark-1280.png"});
    await page.unroute(/\/api\/projects$/);
    // A failed Undo from another page shows in the app's error toast.
    await request.post("/api/projects",{data:{path,...RICH_PROJECT}});
    await page.getByRole("button",{name:"Refresh projects",exact:true}).click();
    await expect(card).toBeVisible();
    await card.getByRole("button",{name:"Remove Removable Project",exact:true}).click();
    await expect(toast).toContainText("Project “Removable Project” removed");
    await nav(page,"History").click();
    await failRestore();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(page.getByTestId("app-action-error")).toContainText("Undo failed: Deliberate restore failure");
    expect((await listedProjects(request)).some(project=>project.path===path)).toBe(false);
    await page.screenshot({animations:"disabled",path:shots+"project-undo-failed-elsewhere-dark-1280.png"});
  });
});

test.describe("Removing an environment",()=>{
  for(const mode of MODES)test(`Undo brings the removed environment back with the same id and fields (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const created=await request.post("/api/environments",{data:{id:"polish-build-box",type:"ssh",name:"Removable build box",host:"build.example.com",user:"dev",port:2222,identityFile:"C:\\Users\\me\\.ssh\\id_ed25519",cwd:"/srv/app",themeDirectory:"/srv/themes",enabled:false}});
    expect(created.ok()).toBe(true);
    const before=(await listedEnvironments(request)).find(profile=>profile.id==="polish-build-box");
    let dialogs=0;page.on("dialog",dialog=>{dialogs++;dialog.dismiss().catch(()=>{})});
    await nav(page,"Environments").click();
    const row=page.locator(".environment-list>div").filter({hasText:"Removable build box"});
    await expect(row).toBeVisible();
    await row.getByRole("button",{name:"Remove Removable build box",exact:true}).click();
    const toast=page.getByTestId("thread-undo-toast");
    await expect(toast).toContainText("Environment “Removable build box” removed");
    await expect(row).toHaveCount(0);
    expect(dialogs).toBe(0);
    await page.screenshot({animations:"disabled",path:shots+`environment-removed-undo-${mode}-1280.png`});
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(toast).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(row).toContainText("switched off");
    const after=(await listedEnvironments(request)).find(profile=>profile.id==="polish-build-box");
    expect({...after,updatedAt:0}).toEqual({...before,updatedAt:0});
    await expect(page.locator(".environments-page").getByRole("alert")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:shots+`environment-restored-${mode}-1280.png`});
  });

  test("Undo still works once Environments is left, and a failed Undo on the page says so there",async({page,request})=>{
    await open(page,request);
    await request.post("/api/environments",{data:{id:"polish-later-box",type:"ssh",name:"Later box",host:"later.example.com",user:"dev",port:22,cwd:"/srv/later"}});
    const before=(await listedEnvironments(request)).find(profile=>profile.id==="polish-later-box");
    await nav(page,"Environments").click();
    const row=page.locator(".environment-list>div").filter({hasText:"Later box"}),toast=page.getByTestId("thread-undo-toast");
    await row.getByRole("button",{name:"Remove Later box",exact:true}).click();
    await expect(toast).toContainText("Environment “Later box” removed");
    await nav(page,"History").click();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(async()=>(await listedEnvironments(request)).find(profile=>profile.id==="polish-later-box")?.createdAt).toBe(before.createdAt);
    await nav(page,"Environments").click();
    await expect(row).toBeVisible();
    await row.getByRole("button",{name:"Remove Later box",exact:true}).click();
    await expect(row).toHaveCount(0);
    await page.route(/\/api\/environments$/,route=>route.request().method()==="POST"?json(route,{error:"Deliberate restore failure"},500):route.fallback());
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(page.locator(".environments-page").getByRole("alert")).toContainText("Could not restore environment: Deliberate restore failure");
    await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:shots+"environment-undo-failed-dark-1280.png"});
  });
});

test.describe("A project list that failed or is still loading",()=>{
  for(const mode of MODES)test(`a failed first read says so with Retry, and does not claim there are no projects (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    let fail=true;
    await page.route(/\/api\/projects$/,route=>route.request().method()==="GET"&&fail?json(route,{error:"Deliberate projects failure"},500):route.fallback());
    await nav(page,"Projects").click();
    const alert=page.locator(".projects-page").getByRole("alert");
    await expect(alert).toContainText("Deliberate projects failure");
    // The open workspace is a project: a failed read is not an empty list.
    await expect(page.getByText("No projects yet.")).toHaveCount(0);
    await expect(page.locator(".project-window-count")).not.toHaveText(/0\s*\/\s*0/);
    await expect(alert).toContainText("Could not load projects: Deliberate projects failure");
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      expect(await sideways(page)).toBeLessThanOrEqual(1);
      await page.screenshot({animations:"disabled",path:shots+`projects-load-failed-${mode}-${width}.png`});
    }
    fail=false;
    await alert.getByRole("button",{name:"Retry",exact:true}).click();
    await expect(page.locator(".project-card").filter({hasText:MAIN})).toBeVisible();
    await expect(page.locator(".projects-page").getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".project-window-count")).toHaveText(/1\s*\/\s*1/);
  });

  for(const mode of MODES)test(`while the first read is slow the page says it is loading, not that there are none (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    let release;const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/projects$/,async route=>{if(route.request().method()==="GET")await held;return route.fallback()});
    await nav(page,"Projects").click();
    const loading=page.locator(".projects-page").getByText("Loading projects…");
    await expect(loading).toBeVisible();
    await expect(page.getByText("No projects yet.")).toHaveCount(0);
    await expect(page.locator(".project-window-count")).not.toHaveText(/0\s*\/\s*0/);
    await page.screenshot({animations:"disabled",path:shots+`projects-loading-${mode}-1280.png`});
    release();
    await expect(page.locator(".project-card").filter({hasText:MAIN})).toBeVisible();
    await expect(loading).toHaveCount(0);
  });
});
