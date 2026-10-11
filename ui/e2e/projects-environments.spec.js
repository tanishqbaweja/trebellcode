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
// The project Trebell opens on its next start: the server's active project.
const nextStartProject=async request=>{const {settings}=await (await request.get("/api/state")).json();return (await listedProjects(request)).find(project=>project.id===settings.activeProjectId)?.name||null};
const projectCard=(page,name)=>page.locator(".project-card").filter({has:page.locator(".project-open strong",{hasText:new RegExp("^"+name+"$")})});
// What a person saved on a project: the record apart from its id and times, which a restore cannot keep.
const savedSetup=project=>{const {id,createdAt,lastOpenedAt,...rest}=project||{};return rest};
const flipMode=(page,mode)=>page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
const sideways=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
// A card is drawn before its Git details arrive. One with a remote then moves into its repository's group, which draws the
// card and its open fields again, so the tests that type into a card wait for that first.
async function openProjects(page){
  const git=page.waitForResponse(response=>response.url().includes("/api/git/info"));
  await nav(page,"Projects").click();
  const info=await (await git).json().catch(()=>null);
  const remote=info?.remotes?.find(item=>item.kind==="fetch")?.url;
  if(remote)await expect(page.locator(".project-group-head").filter({hasText:remote}).first()).toBeVisible();
}

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
    // The page polls the list while a clone runs: a read still in flight when the test ends must not fail the next test.
    await page.unrouteAll({behavior:"ignoreErrors"});
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

  // The person removes the project they are in. Undo at once makes it the open project again; Undo given after they opened
  // another project only puts it back in the list, and leaves them in the one they opened, now and at the next start.
  test("Undo of the open project's removal opens it again only if no other project was opened meanwhile",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",activate:true,scripts:[{id:"a-tests",name:"A tests",command:"npm test"}]}});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const header=page.locator("header.workspace-header").first(),toast=page.getByTestId("thread-undo-toast");
    await expect(header.getByRole("button",{name:"A tests",exact:true})).toBeVisible();
    await nav(page,"Projects").click();
    const removeA=()=>projectCard(page,"Project A").getByRole("button",{name:"Remove Project A",exact:true}).click();
    await removeA();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(projectCard(page,"Project A")).toHaveClass(/active/);
    await expect.poll(()=>nextStartProject(request)).toBe("Project A");
    // Removed again, then the person opens the main project before changing their mind.
    await removeA();
    await expect(toast).toContainText("Project “Project A” removed");
    await projectCard(page,MAIN).locator(".project-open").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(header).toContainText(MAIN);
    await expect.poll(()=>nextStartProject(request)).toBe(MAIN);
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(async()=>(await listedProjects(request)).some(project=>project.path===path)).toBe(true);
    await page.waitForTimeout(300);
    await expect(header,"the header names the project the person is in").toContainText(MAIN);
    await expect(header.getByRole("button",{name:"A tests",exact:true}),"Project A's action in the main project's header").toHaveCount(0);
    expect(await nextStartProject(request),"the project the next start opens").toBe(MAIN);
    await page.screenshot({animations:"disabled",path:shots+"project-undo-after-opening-another-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"project-undo-after-opening-another-light-1280.png"});
    await flipMode(page,"dark");
    await nav(page,"Settings").click();
    await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:/^Shortcuts/}).click();
    await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
    await expect(page.locator(".keybinding-row strong").filter({hasText:/^Run A tests$/}),"Project A's action listed while the main project is open").toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(header).toContainText(MAIN);
    await nav(page,"Projects").click();
    await expect(page.locator(".project-card.active .project-open strong")).toHaveText(MAIN);
    await expect(projectCard(page,"Project A")).toBeVisible();
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

  // The person removes an environment, looks on Projects at what used it, and puts it back from the toast there.
  test("an environment Undo shows on the Projects page that is open, and its projects can be removed with an Undo again",async({page,request})=>{
    await open(page,request);
    expect((await request.post("/api/environments",{data:{id:"polish-undo-box",type:"ssh",name:"Build box",host:"build.example.com",user:"dev",port:22,cwd:"/srv"}})).ok()).toBe(true);
    expect((await request.post("/api/projects",{data:{path:"/srv/api",environmentId:"polish-undo-box",name:"Remote API"}})).ok()).toBe(true);
    await nav(page,"Environments").click();
    await page.locator(".environment-list>div").filter({hasText:"Build box"}).getByRole("button",{name:"Remove Build box",exact:true}).click();
    const toast=page.getByTestId("thread-undo-toast");
    await expect(toast).toContainText("Environment “Build box” removed");
    await nav(page,"Projects").click();
    const remote=projectCard(page,"Remote API"),place=remote.locator(".project-open>div>span");
    await expect(place).toHaveText("Unavailable environment · /srv/api");
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(place).toHaveText("Build box · /srv/api");
    await remote.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"environment-undo-on-projects-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"environment-undo-on-projects-light-1280.png"});
    await flipMode(page,"dark");
    const asked=[];page.on("dialog",dialog=>{asked.push(dialog.message());dialog.dismiss().catch(()=>{})});
    await remote.getByRole("button",{name:"Remove Remote API",exact:true}).click();
    await expect(toast).toContainText("Project “Remote API” removed");
    expect(asked,"removing the project asks as if its environment were gone").toEqual([]);
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(place).toHaveText("Build box · /srv/api");
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

  // A second failure reads differently and is a new message, so it is seen and said again; the keyboard stays on Retry.
  test("a Retry that fails again says it still could not load the projects",async({page,request})=>{
    await open(page,request);
    let reads=0;
    await page.route(/\/api\/projects$/,route=>{if(route.request().method()!=="GET")return route.fallback();reads++;return json(route,{error:"Deliberate projects failure"},500)});
    await nav(page,"Projects").click();
    const alert=page.locator(".projects-page").getByRole("alert"),retry=alert.getByRole("button",{name:"Retry",exact:true});
    await expect(alert).toHaveText(/^Could not load projects: Deliberate projects failure/);
    const message=await alert.locator("span").first().elementHandle();
    const before=reads;
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(()=>reads).toBeGreaterThan(before);
    await expect(alert).toHaveText(/^Still could not load projects: Deliberate projects failure/);
    expect(await message.evaluate(node=>node.isConnected),"the message is a new one, so it is said again").toBe(false);
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    await page.screenshot({animations:"disabled",path:shots+"projects-load-failed-again-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"projects-load-failed-again-light-1280.png"});
    await flipMode(page,"dark");
    // Each later failure is a new message too.
    const second=await alert.locator("span").first().elementHandle();
    await page.keyboard.press("Enter");
    await expect.poll(async()=>second.evaluate(node=>node.isConnected)).toBe(false);
    await expect(alert).toHaveText(/^Still could not load projects: Deliberate projects failure/);
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

test.describe("Clone",()=>{
  test("Clone with no parent directory says one is needed, marks the field and sends nothing",async({page,request})=>{
    await page.route(/\/api\/environments$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      const body=await (await route.fetch()).json();
      return json(route,{...body,profiles:[SSH_PROFILE]});
    });
    let posts=0;await page.route(/\/api\/clone-jobs$/,route=>{if(route.request().method()==="POST")posts++;return json(route,{error:"Deliberate clone refusal"},400)});
    await open(page,request);
    await nav(page,"Projects").click();
    const clone=page.locator(".clone-card");
    await clone.getByRole("textbox",{name:"Clone URL"}).fill("https://github.com/owner/repo.git");
    const parent=clone.getByRole("textbox",{name:"Clone parent directory"});
    await expect(parent).toHaveValue("");
    await clone.getByRole("button",{name:"Clone",exact:true}).click();
    const message=clone.getByText("Enter a parent directory on Build box.");
    await expect(message).toBeVisible();
    await expect(parent).toHaveAttribute("aria-invalid","true");
    await expect(parent).toBeFocused();
    expect(posts).toBe(0);
    // The empty field reads as empty: its placeholder names the field instead of looking like a path.
    await expect(parent).toHaveAttribute("placeholder","Parent directory");
    for(const [mode,width] of [["dark",1280],["light",1280],["dark",900],["light",900]]){
      await page.setViewportSize({width,height:800});await flipMode(page,mode);
      await clone.scrollIntoViewIfNeeded();
      expect(await sideways(page)).toBeLessThanOrEqual(1);
      const box=await clone.boundingBox(),text=await message.boundingBox();
      expect(text.x+text.width,`message inside the card at ${width}`).toBeLessThanOrEqual(box.x+box.width+1);
      const room=await parent.evaluate(el=>{
        const style=getComputedStyle(el),pen=document.createElement("canvas").getContext("2d");
        pen.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return el.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-pen.measureText(el.placeholder).width;
      });
      expect(room,`the placeholder is not cut at ${width}`).toBeGreaterThanOrEqual(0);
      // The field keeps the red line while it has focus, in either mode.
      await expect(parent).toBeFocused();
      const red=await parent.evaluate(el=>{
        const probe=document.createElement("i");probe.style.cssText="position:absolute;border:1px solid var(--errb)";el.parentElement.appendChild(probe);
        const colour=getComputedStyle(probe).borderTopColor;probe.remove();return colour;
      });
      // The field eases between colours, so its line is read until it settles.
      await expect.poll(()=>parent.evaluate(el=>getComputedStyle(el).borderTopColor),{message:`the parent field is outlined in red (${mode})`}).toBe(red);
      await page.screenshot({animations:"disabled",path:shots+`clone-no-parent-${mode}-${width}.png`});
    }
    // Typing a parent clears the message, and Clone then asks the server.
    await parent.fill("/srv/projects");
    await expect(message).toHaveCount(0);
    await expect(parent).not.toHaveAttribute("aria-invalid","true");
    await clone.getByRole("button",{name:"Clone",exact:true}).click();
    await expect(page.getByRole("alert").filter({hasText:"Deliberate clone refusal"})).toBeVisible();
    expect(posts).toBe(1);
  });
});

test.describe("Renaming a project",()=>{
  test("Enter in the Name field saves the name, and Escape puts back the saved one",async({page,request})=>{
    const boot=await open(page,request);
    await openProjects(page);
    const card=page.locator(".project-card.active");
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    const saves=[];page.on("request",sent=>{if(sent.method()==="POST"&&/\/api\/projects$/.test(sent.url()))saves.push(sent.postDataJSON()?.name)});
    await name.fill("Renamed With Enter");
    await name.press("Enter");
    await expect(card.locator(".project-open strong")).toHaveText("Renamed With Enter");
    await expect.poll(async()=>(await listedProjects(request)).find(project=>project.path===boot.cwd)?.name).toBe("Renamed With Enter");
    // The field keeps focus, so the keyboard stays where it was, and leaving it afterwards does not send the name again.
    await expect(name).toBeFocused();
    await name.press("Tab");
    await page.waitForTimeout(300);
    expect(saves).toEqual(["Renamed With Enter"]);
    await name.focus();
    await name.fill("Typed and given up");
    await name.press("Escape");
    await expect(name).toHaveValue("Renamed With Enter");
    await expect(name).toBeFocused();
    await name.press("Tab");
    await page.waitForTimeout(400);
    await expect(card.locator(".project-open strong")).toHaveText("Renamed With Enter");
    expect((await listedProjects(request)).find(project=>project.path===boot.cwd)?.name).toBe("Renamed With Enter");
    expect(saves).toEqual(["Renamed With Enter"]);
    // Escape in the field does not leave the page.
    await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  });

  test("Enter and then leaving the field while the save is still on its way sends the name once",async({page,request})=>{
    const boot=await open(page,request);
    const saves=[];
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST")return route.fallback();
      saves.push(route.request().postDataJSON()?.name);
      await new Promise(resolve=>setTimeout(resolve,600));
      return route.fallback();
    });
    await openProjects(page);
    const card=page.locator(".project-card.active");
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    await name.fill("Sent Once");
    await name.press("Enter");
    await name.press("Tab");
    await expect(card.locator(".project-open strong")).toHaveText("Sent Once");
    await expect.poll(async()=>(await listedProjects(request)).find(project=>project.path===boot.cwd)?.name).toBe("Sent Once");
    expect(saves).toEqual(["Sent Once"]);
  });

  // A name Enter sent is the saved name while it is on its way: Escape then has no edit to give up, and an emptied field gets
  // that name back, so neither puts the old name in the field for leaving it to send.
  test("Escape or an emptied field while a name sent with Enter is still saving keeps the new name",async({page,request})=>{
    const boot=await open(page,request);
    const saves=[];
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST")return route.fallback();
      saves.push(route.request().postDataJSON()?.name);
      await new Promise(resolve=>setTimeout(resolve,800));
      return route.fallback();
    });
    await openProjects(page);
    const card=page.locator(".project-card.active"),title=card.locator(".project-open strong");
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    const savedName=async()=>(await listedProjects(request)).find(project=>project.path===boot.cwd&&!project.environmentId)?.name;
    await name.fill("Renamed Then Escaped");
    await name.press("Enter");
    await name.press("Escape");
    await expect(name).toHaveValue("Renamed Then Escaped");
    await expect(title).toHaveText("Renamed Then Escaped");
    await expect(name,"the field once the name is saved").toHaveValue("Renamed Then Escaped");
    await card.locator(".project-identity-editor").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"project-name-escape-while-saving-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"project-name-escape-while-saving-light-1280.png"});
    await flipMode(page,"dark");
    await name.press("Tab");
    await page.waitForTimeout(1200);
    expect(saves,"leaving the field sends nothing more").toEqual(["Renamed Then Escaped"]);
    await expect(title).toHaveText("Renamed Then Escaped");
    expect(await savedName()).toBe("Renamed Then Escaped");
    // Emptied while the next name is on its way: that name comes back, not the one before it.
    await name.fill("Second Name");
    await name.press("Enter");
    await name.fill("");
    await name.press("Tab");
    await expect(name).toHaveValue("Second Name");
    await expect(title).toHaveText("Second Name");
    await page.waitForTimeout(1200);
    expect(saves).toEqual(["Renamed Then Escaped","Second Name"]);
    expect(await savedName()).toBe("Second Name");
  });

  for(const mode of MODES)test(`clearing the name puts the saved name back and says why (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    await openProjects(page);
    const card=page.locator(".project-card.active");
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    await name.fill("   ");
    await name.press("Tab");
    await expect(name).toHaveValue(MAIN);
    const note=card.getByText("A project needs a name, so the saved one is back.");
    await expect(note).toBeVisible();
    await expect(card.locator(".project-open strong")).toHaveText(MAIN);
    expect((await listedProjects(request)).find(project=>project.path===boot.cwd)?.name).toBe(MAIN);
    await card.locator(".project-identity-editor").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+`project-name-cleared-${mode}-1280.png`});
    // The note goes once the name is edited again.
    await name.fill(MAIN+" 2");
    await expect(note).toHaveCount(0);
  });
});

test.describe("A long project name",()=>{
  for(const mode of MODES)test(`wraps on its card, shows in full on hover, and leaves the card header aligned (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    await request.post("/api/projects",{data:{path:boot.cwd,name:LONG_NAME,activate:true}});
    await request.post("/api/projects",{data:{path:join(boot.cwd,"docs"),name:"Short Neighbour"}});
    await openProjects(page);
    const card=page.locator(".project-card.active"),title=card.locator(".project-open strong");
    await expect(title).toHaveText(LONG_NAME);
    await expect(title).toHaveAttribute("title",LONG_NAME);
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      await card.scrollIntoViewIfNeeded();
      const metrics=await card.evaluate(node=>{
        // One line of a title, from the neighbour's short name.
        const oneLine=()=>[...document.querySelectorAll(".project-open strong")].find(item=>item.textContent==="Short Neighbour").getBoundingClientRect().height;
        const name=node.querySelector(".project-open strong"),open=node.querySelector(".project-open"),identity=node.querySelector(".project-identity-toggle button"),remove=node.querySelector(".project-remove");
        const pill=getComputedStyle(node,"::after"),cardBox=node.getBoundingClientRect(),nameBox=name.getBoundingClientRect(),lineHeight=oneLine();
        return {cut:name.scrollHeight>name.clientHeight+1||name.scrollWidth>name.clientWidth+1,lines:Math.round(nameBox.height/lineHeight),nameRight:nameBox.right,
          pillLeft:cardBox.right-parseFloat(pill.right)-parseFloat(pill.width),identityTop:identity.getBoundingClientRect().top,removeTop:remove.getBoundingClientRect().top,
          openBottom:open.getBoundingClientRect().bottom,removeBottom:remove.getBoundingClientRect().bottom};
      });
      expect(metrics.cut,`the name is cut at ${width}`).toBe(false);
      expect(metrics.lines,`the name wraps to at most two lines at ${width}`).toBeLessThanOrEqual(2);
      expect(metrics.nameRight,`the name stays clear of the Current pill at ${width}`).toBeLessThanOrEqual(metrics.pillLeft);
      expect(Math.abs(metrics.identityTop-metrics.removeTop),`header buttons on one line at ${width}`).toBeLessThan(1);
      expect(metrics.openBottom,`the header holds its buttons at ${width}`).toBeGreaterThanOrEqual(metrics.removeBottom);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
      await page.screenshot({animations:"disabled",path:shots+`project-long-name-${mode}-${width}.png`});
    }
    // A name too long for two lines stops at two with an ellipsis, and the tooltip still has all of it.
    const longer=LONG_NAME+", plus the migration scripts, the design system, the release tooling and a few experiments nobody remembers starting";
    await request.post("/api/projects",{data:{path:boot.cwd,name:longer}});
    await page.getByRole("button",{name:"Refresh projects",exact:true}).click();
    await expect(title).toHaveAttribute("title",longer);
    await page.setViewportSize({width:900,height:800});
    const clamp=await title.evaluate(name=>{
      const oneLine=[...document.querySelectorAll(".project-open strong")].find(item=>item.textContent==="Short Neighbour").getBoundingClientRect().height;
      return {lines:Math.round(name.getBoundingClientRect().height/oneLine)};
    });
    expect(clamp.lines).toBe(2);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+`project-longer-name-${mode}-900.png`});
  });
});
