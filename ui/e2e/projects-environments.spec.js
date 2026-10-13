import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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

async function open(page,request,{mode="dark",width=1280,height=800,settings={}}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode,...settings}});
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
// The header's mode button, clicked as a person switches between dark and light.
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
// A screenshot of what is on screen in dark and light, at 1280 and 900 wide, with show (a locator) brought into view at each width;
// the page is left dark at 1280.
async function shootModes(page,name,{height=800,show=null}={}){
  for(const mode of MODES){
    await page.setViewportSize({width:1280,height});await switchMode(page,mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height});await show?.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height});await switchMode(page,"dark");
}
// Host discovery has answered once the Host capabilities card says whether WSL and SSH are ready.
async function hostDiscovered(page){
  for(const name of ["WSL","SSH"])await expect(page.locator(".capability-list>div").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})}).locator("em")).toHaveText(/^(Ready|Unavailable)$/,{timeout:20_000});
}
// A loopback port with nothing listening on it.
async function deadPort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port;
}
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

  // The person removes the project they are in, then looks around before choosing Undo: the header no longer names it or offers
  // its action, nor does the palette, and Undo brings both back at once, without waiting for the app to read the project list.
  for(const mode of MODES)test(`removing the open project shows at once in the header and the palette, and so does its Undo (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",activate:true,scripts:[{id:"a-tests",name:"A tests",command:"npm test"}]}});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const header=page.locator("header.workspace-header").first(),crumb=header.locator(".project-crumb:not(.sidebar-reopen) span"),toast=page.getByTestId("thread-undo-toast");
    const action=header.getByRole("button",{name:"A tests",exact:true}),palette=page.getByTestId("command-palette");
    // The palette searched for the action, once its code has come (the stand-in shown before it is busy): it lists the action, or
    // says nothing matched.
    const paletteRuns=async()=>{
      await page.getByRole("button",{name:"Search or jump to"}).click();
      await expect(palette).toBeVisible();
      await page.keyboard.type("A tests");
      await expect(palette.locator(".command-palette[aria-busy]")).toHaveCount(0);
      await expect(palette.locator("input")).toHaveValue("A tests");
      await expect(palette.locator(".command-palette-item,.command-palette-empty").first()).toBeVisible();
      const found=await palette.locator(".command-palette-item").filter({hasText:/^Run A tests/}).count();
      await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
      return found;
    };
    await expect(crumb).toHaveText("Project A");await expect(action).toBeVisible();
    await nav(page,"Projects").click();
    await projectCard(page,"Project A").getByRole("button",{name:"Remove Project A",exact:true}).click();
    await expect(toast).toContainText("Project “Project A” removed");
    expect(await paletteRuns(),"the palette still runs the removed project's action").toBe(0);
    await nav(page,"New task").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(crumb,"the header still names the removed project").toHaveText("ui");
    await expect(action,"the header still offers the removed project's action").toHaveCount(0);
    // Its folder stays open, without the record: the branch still shows.
    await expect(header.locator(".branch-control")).toBeVisible();
    await page.screenshot({animations:"disabled",path:shots+`project-open-removed-${mode}-1280.png`});
    await page.setViewportSize({width:900,height:800});
    await expect(crumb).toHaveText("ui");
    await page.screenshot({animations:"disabled",path:shots+`project-open-removed-${mode}-900.png`});
    await page.setViewportSize({width:1280,height:800});
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(toast).toHaveCount(0);
    await expect(crumb,"the header names the restored project").toHaveText("Project A");
    await expect(action).toBeVisible();
    expect(await paletteRuns(),"the palette runs the restored project's action").toBe(1);
    await page.screenshot({animations:"disabled",path:shots+`project-open-restored-${mode}-1280.png`});
  });

  // A setting of the open project is still saving (a slow server; the server has already applied it) when the person removes the
  // project. The save's answer comes after the removal and does not bring the removed project back into the header.
  for(const mode of MODES)test(`a save that answers after the open project's removal does not name it again (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",activate:true,scripts:[{id:"a-tests",name:"A tests",command:"npm test"}]}});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const header=page.locator("header.workspace-header").first(),crumb=header.locator(".project-crumb:not(.sidebar-reopen) span"),action=header.getByRole("button",{name:"A tests",exact:true});
    await expect(crumb).toHaveText("Project A");await expect(action).toBeVisible();
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});let sent=false,answered=false,readSince=false;
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST"||route.request().postDataJSON()?.permissionMode!=="supervised")return route.fallback();
      sent=true;const response=await route.fetch();await held;await route.fulfill({response});answered=true;
    });
    // The page reads the list again once it has the save's answer.
    page.on("request",item=>{if(answered&&item.method()==="GET"&&/\/api\/projects$/.test(item.url()))readSince=true});
    try{
      await nav(page,"Projects").click();
      const card=projectCard(page,"Project A");
      await card.getByRole("combobox",{name:"Permissions"}).selectOption("supervised");
      await expect.poll(()=>sent).toBe(true);
      await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
      await expect(page.getByTestId("thread-undo-toast")).toContainText("Project “Project A” removed");
      release();
      await expect.poll(()=>readSince).toBe(true);
      await nav(page,"New task").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(crumb,"the header names the removed project again").toHaveText("ui");
      await expect(action,"the header offers the removed project's action again").toHaveCount(0);
      expect((await listedProjects(request)).filter(project=>project.path===path),"the project is removed on the server").toEqual([]);
      await page.screenshot({animations:"disabled",path:shots+`project-save-after-removal-${mode}-1280.png`});
      await page.setViewportSize({width:900,height:800});
      await expect(crumb).toHaveText("ui");
      await page.screenshot({animations:"disabled",path:shots+`project-save-after-removal-${mode}-900.png`});
    }finally{release();await page.unrouteAll({behavior:"ignoreErrors"})}
  });

  // The palette shows the project list it read when it was last open until it has read the list again. A project removed on
  // Projects is not offered there meanwhile (opening it would add it back), and its Undo puts it back there at once.
  for(const mode of MODES)test(`the palette offers a removed project no more, and a restored one again, before it reads the list again (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    await request.post("/api/projects",{data:{path:join(boot.cwd,"ui"),name:"Project A"}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    const palette=page.getByTestId("command-palette"),toast=page.getByTestId("thread-undo-toast");
    const projectRow=palette.locator(".command-palette-item").filter({has:page.locator("strong",{hasText:/^Project A$/})});
    const search=async()=>{
      await page.keyboard.press("Control+K");
      await expect(palette).toBeVisible();
      await palette.locator("input").fill("Project A");
      await expect(palette.locator(".command-palette-item,.command-palette-empty").first()).toBeVisible();
    };
    await search();
    await expect(projectRow).toBeVisible();
    await page.keyboard.press("Escape");await expect(palette).toBeHidden();
    await nav(page,"Projects").click();
    await projectCard(page,"Project A").getByRole("button",{name:"Remove Project A",exact:true}).click();
    await expect(toast).toContainText("Project “Project A” removed");
    await expect(projectCard(page,"Project A")).toHaveCount(0);
    // From here the server answers no read of the list until the test ends.
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/projects$/,async route=>{if(route.request().method()==="GET")await held;return route.fallback()});
    try{
      await search();
      await expect(projectRow,"the palette offers the project just removed").toHaveCount(0);
      await page.screenshot({animations:"disabled",path:shots+`palette-project-removed-${mode}-1280.png`});
      await page.setViewportSize({width:900,height:800});
      await page.screenshot({animations:"disabled",path:shots+`palette-project-removed-${mode}-900.png`});
      await page.setViewportSize({width:1280,height:800});
      await page.keyboard.press("Escape");await expect(palette).toBeHidden();
      await toast.getByRole("button",{name:"Undo",exact:true}).click();
      await expect(toast).toHaveCount(0);
      await search();
      await expect(projectRow,"the palette offers the restored project").toBeVisible();
      await page.screenshot({animations:"disabled",path:shots+`palette-project-restored-${mode}-1280.png`});
    }finally{release();await page.unrouteAll({behavior:"ignoreErrors"})}
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

test.describe("Adding an environment",()=>{
  // A person clears the Codex executable field as they clear any field, and it stays empty; the path they type is saved with the
  // environment, whose Codex app-server starts it. The empty field's placeholder names the default it stands for.
  test("the Codex executable field can be cleared and the path typed is saved",async({page,request})=>{
    // SSH needs an OpenSSH client on the host; the form offers it as on a host that has one.
    await page.route(/\/api\/environments$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      const body=await (await route.fetch()).json(),ssh=body.capabilities?.ssh;
      return json(route,{...body,capabilities:{...body.capabilities,ssh:ssh?.available?ssh:{available:true,version:"OpenSSH client",error:null}}});
    });
    await open(page,request);
    await nav(page,"Environments").click();
    const form=page.locator(".environment-create"),field=label=>form.locator("label").filter({hasText:new RegExp("^"+label)}).locator("input, select").first();
    await hostDiscovered(page);
    await field("Type").selectOption("ssh");
    const codex=field("Codex executable");
    await codex.click();await page.keyboard.press("End");
    for(let key=0;key<8;key++)await page.keyboard.press("Backspace");
    await expect(codex,"the field stays empty once cleared").toHaveValue("");
    await page.keyboard.type("/usr/bin/codx",{delay:20});
    await page.keyboard.press("Control+a");await page.keyboard.press("Backspace");
    await expect(codex).toHaveValue("");
    await page.keyboard.type("/opt/lane/bin/codex",{delay:20});
    await expect(codex).toHaveValue("/opt/lane/bin/codex");
    await field("Name").click();await page.keyboard.type("Lane box",{delay:20});
    await field("Host").click();await page.keyboard.type("lane.example.test",{delay:20});
    await form.getByRole("button",{name:"Add environment"}).click();
    await expect(page.locator(".environment-list>div").filter({hasText:"Lane box"})).toBeVisible();
    expect((await listedEnvironments(request)).find(profile=>profile.name==="Lane box")?.codexPath,"the typed path is saved").toBe("/opt/lane/bin/codex");
    // The form starts over for the next environment, the field empty with its placeholder.
    await field("Type").selectOption("ssh");
    await expect(codex).toHaveValue("");
    await expect(codex).toHaveAttribute("placeholder","Default codex on the host's PATH");
    await shootModes(page,"environment-codex-executable-empty",{show:codex});
  });

  // Docker Desktop's own WSL distro runs its engine. Host discovery here is real (wsl --list only names the distros), and on a host
  // that has Docker Desktop its distro is neither listed as a WSL target nor offered in the Distribution picker.
  test("Docker Desktop's own WSL distro is not offered for agents",async({page,request})=>{
    await open(page,request);
    await nav(page,"Environments").click();
    await hostDiscovered(page);
    const wsl=page.locator(".capability-list>div").filter({has:page.locator("strong",{hasText:/^WSL$/})});
    await expect(wsl).toBeVisible();
    await expect(wsl).not.toContainText("docker-desktop");
    const form=page.locator(".environment-create"),type=form.locator("label").filter({hasText:/^Type/}).locator("select");
    if(await type.locator("option[value=wsl]").isEnabled()){
      await type.selectOption("wsl");
      expect(await form.locator("label").filter({hasText:/^Distribution/}).locator("option").allTextContents()).not.toContain("docker-desktop");
      await type.selectOption("local");
    }
    await shootModes(page,"environment-wsl-without-docker-desktop",{show:wsl});
  });
});

test.describe("Using an environment for agents",()=>{
  // Use for agent, with Codex as the harness, on an SSH host whose port has nothing listening. The switch fails, says so where the
  // person looks, and Local machine stays the agent environment on the page, on the server and after a reload.
  test("a host the agent cannot reach is not made active, before or after a reload",async({page,request})=>{
    test.setTimeout(90_000);
    await open(page,request,{settings:{agentRuntime:"codex"}});
    const port=await deadPort();
    expect((await request.post("/api/environments",{data:{id:"polish-dead-host",type:"ssh",name:"Dead host",host:"127.0.0.1",port,cwd:"/srv/app"}})).ok()).toBe(true);
    await nav(page,"Environments").click();
    const rows=page.locator(".environment-list>div"),local=rows.filter({hasText:"Local machine"}),dead=rows.filter({hasText:"Dead host"});
    await expect(local.getByText("Active",{exact:true})).toBeVisible();
    await dead.getByRole("button",{name:"Use for agent",exact:true}).click();
    const alert=page.locator(".environments-page").getByRole("alert");
    await expect(alert).toContainText("Connection refused",{timeout:30_000});
    const server=async()=>(await (await request.get("/api/environments")).json()).activeEnvironmentId;
    expect(await server(),"the server keeps Local machine").toBe(null);
    await expect(alert).toHaveText(`Could not use Dead host for agents: ssh: connect to host 127.0.0.1 port ${port}: Connection refused`);
    await expect(local.getByText("Active",{exact:true})).toBeVisible();
    await expect(dead.getByRole("button",{name:"Use for agent",exact:true})).toBeEnabled();
    await shootModes(page,"environment-unreachable-not-used");
    await page.reload();
    await expect(page.getByTestId("composer").or(page.locator(".environments-page")).first()).toBeVisible();
    if(!await page.locator(".environments-page").count())await nav(page,"Environments").click();
    await expect(local.getByText("Active",{exact:true})).toBeVisible();
    await expect(dead.getByRole("button",{name:"Use for agent",exact:true})).toBeEnabled();
    await expect(dead.getByText("Agent active",{exact:true})).toHaveCount(0);
    expect(await server()).toBe(null);
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

  // A remote that takes the request and never answers holds git and its HTTP helper on the transfer. The card's Cancel ends them
  // within a few seconds: the remote sees its connection close, the partial folder goes and the card says the clone was cancelled,
  // with Retry. The folder the person picks comes from the desktop bridge, as the folder dialog would give it.
  test("Cancel on a clone the remote holds ends it within seconds and offers Retry",async({page,request})=>{
    test.setTimeout(90_000);
    const parent=mkdtempSync(join(tmpdir(),"trebell-e2e-clone-held-"));
    const sockets=new Set(),remote=createHttpServer(incoming=>{sockets.add(incoming.socket)});
    await new Promise((resolve,reject)=>remote.listen(0,"127.0.0.1",resolve).once("error",reject));
    try{
      await page.addInitScript(folder=>{window.trebellDesktop={pickDirectory:async()=>folder}},parent);
      await open(page,request);
      await nav(page,"Projects").click();
      const clone=page.locator(".clone-card");
      await clone.getByRole("textbox",{name:"Clone URL"}).click();
      await page.keyboard.type(`http://127.0.0.1:${remote.address().port}/team/slow-repo.git`,{delay:10});
      await clone.getByRole("button",{name:"Clone",exact:true}).click();
      // The new project opens with its clone banner; the person goes back to Projects to its card.
      await expect(page.getByTestId("clone-banner")).toBeVisible({timeout:20_000});
      await expect.poll(()=>sockets.size,{message:"git reached the remote",timeout:20_000}).toBeGreaterThan(0);
      await nav(page,"Projects").click();
      const status=projectCard(page,"slow-repo").locator(".project-clone-status");
      await expect(status).toContainText("%");
      const partial=()=>readdirSync(parent).filter(name=>name.startsWith("slow-repo.trebell-clone-"));
      expect(partial(),"git made the partial folder").toHaveLength(1);
      const held=[...sockets].map(socket=>new Promise(resolve=>socket.destroyed?resolve():socket.once("close",resolve)));
      await status.getByRole("button",{name:"Cancel"}).click();
      const cancelledAt=Date.now();
      await expect(status).toContainText("Clone cancelled",{timeout:6000});
      expect(Date.now()-cancelledAt).toBeLessThan(6000);
      await expect(status.getByRole("button",{name:"Retry"})).toBeVisible();
      await Promise.race([Promise.all(held),new Promise((_,reject)=>setTimeout(()=>reject(new Error("the remote still holds a connection from git")),2000))]);
      expect(partial(),"the partial folder is removed").toEqual([]);
      await shootModes(page,"clone-cancelled-retry");
    }finally{
      // The remote hangs up, so a git that is still there ends and lets go of the folder.
      for(const socket of sockets)socket.destroy();
      await new Promise(resolve=>remote.close(resolve));
      await expect.poll(async()=>(await listedProjects(request)).some(project=>["running","cancelling"].includes(project.cloneJob?.status)),{timeout:20_000}).toBe(false).catch(()=>{});
      try{rmSync(parent,{recursive:true,force:true,maxRetries:50,retryDelay:100})}catch{}
    }
  });

  // The banner over the chat while a project clones takes the mouse as the card's buttons do: the pointer is on Cancel and Retry
  // clone, not on the conversation area under them, and the conversation's first rows start below the banner, not under it.
  test("the clone banner's Cancel and Retry clone answer the mouse, and the conversation starts below the banner",async({page,request})=>{
    test.setTimeout(120_000);
    const parent=mkdtempSync(join(tmpdir(),"trebell-e2e-clone-banner-"));
    const sockets=new Set(),remote=createHttpServer(incoming=>{sockets.add(incoming.socket)});
    await new Promise((resolve,reject)=>remote.listen(0,"127.0.0.1",resolve).once("error",reject));
    const job=async()=>(await listedProjects(request)).find(project=>/banner-repo$/.test(project.path))?.cloneJob?.status||null;
    // What the pointer is over at the middle of an element: the button it is in, if any.
    const under=locator=>locator.evaluate(element=>{const box=element.getBoundingClientRect();const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return hit?.closest("button")?.textContent.trim()||hit?.className||hit?.tagName});
    try{
      await page.addInitScript(folder=>{window.trebellDesktop={pickDirectory:async()=>folder}},parent);
      await open(page,request);
      await nav(page,"Projects").click();
      const clone=page.locator(".clone-card");
      await clone.getByRole("textbox",{name:"Clone URL"}).click();
      await page.keyboard.type(`http://127.0.0.1:${remote.address().port}/team/banner-repo.git`,{delay:10});
      await clone.getByRole("button",{name:"Clone",exact:true}).click();
      const banner=page.getByTestId("clone-banner");
      await expect(banner).toBeVisible({timeout:20_000});
      await expect.poll(()=>sockets.size,{message:"git reached the remote",timeout:20_000}).toBeGreaterThan(0);
      // A message sent meanwhile waits for the repository; when the clone is cancelled the conversation says so under the banner.
      await page.getByTestId("composer").click();
      await page.keyboard.type("List the scripts once the repository is here.",{delay:5});
      await page.keyboard.press("Enter");
      const cancel=banner.getByRole("button",{name:"Cancel"});
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});expect(await under(cancel),`the pointer is on Cancel at ${width}`).toBe("Cancel")}
      await page.setViewportSize({width:1280,height:800});
      await cancel.hover();
      expect(await cancel.evaluate(element=>element.matches(":hover"))).toBe(true);
      await shootModes(page,"clone-banner-running");
      await cancel.click();
      await expect(banner).toContainText("Clone cancelled",{timeout:10_000});
      const retry=banner.getByRole("button",{name:"Retry clone"});
      await expect(page.locator(".conversation-scroll")).toContainText("Repository clone cancelled.",{timeout:10_000});
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        expect(await under(retry),`the pointer is on Retry clone at ${width}`).toBe("Retry clone");
        const first=await page.locator(".conversation-scroll .conversation-column").evaluate(column=>Math.min(...[...column.children].map(child=>child.getBoundingClientRect()).filter(box=>box.height>0).map(box=>box.top)));
        const bannerBox=await banner.boundingBox();
        expect(first,`the conversation starts below the banner at ${width}`).toBeGreaterThanOrEqual(bannerBox.y+bannerBox.height);
      }
      await page.setViewportSize({width:1280,height:800});
      await shootModes(page,"clone-banner-cancelled");
      // Retry clone starts the clone again, and its Cancel ends it again, both with the mouse.
      await retry.click();
      await expect(banner).toContainText("You can keep writing",{timeout:10_000});
      await expect.poll(job,{timeout:10_000}).toBe("running");
      await cancel.click();
      await expect(banner).toContainText("Clone cancelled",{timeout:10_000});
    }finally{
      for(const socket of sockets)socket.destroy();
      await new Promise(resolve=>remote.close(resolve));
      await expect.poll(async()=>["running","cancelling"].includes(await job()),{timeout:20_000}).toBe(false).catch(()=>{});
      try{rmSync(parent,{recursive:true,force:true,maxRetries:50,retryDelay:100})}catch{}
    }
  });
});

// Files a person might pick for a project's icon: a real png, a text file named like one, and a bitmap the app does not keep.
async function iconFiles(page){
  const png=Buffer.from((await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=canvas.height=48;const pen=canvas.getContext("2d");pen.fillStyle="#2fb6a0";pen.fillRect(0,0,48,48);pen.fillStyle="#ffffff";pen.fillRect(14,14,20,20);return canvas.toDataURL("image/png")})).split(",")[1],"base64");
  const bmp=Buffer.from("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==","base64");
  return {png:{name:"logo.png",mimeType:"image/png",buffer:png},text:{name:"notes.png",mimeType:"image/png",buffer:Buffer.from("Release notes, not a picture.\n")},bmp:{name:"logo.bmp",mimeType:"image/bmp",buffer:bmp}};
}
// The card's Image button opens the file dialog, and the person picks the file in it.
async function pickIcon(page,card,file){
  const chooser=page.waitForEvent("filechooser");
  await card.locator(".project-image-button").click();
  await (await chooser).setFiles(file);
}

test.describe("A project's icon",()=>{
  test("a file that is not a png, jpeg, webp or gif the app can show is refused with a message and the icon stays",async({page,request})=>{
    const boot=await open(page,request);
    await openProjects(page);
    const card=page.locator(".project-card.active");
    await card.getByRole("button",{name:/Project identity/}).click();
    const files=await iconFiles(page),savedIcon=async()=>(await listedProjects(request)).find(project=>project.path===boot.cwd)?.icon||null;
    const tile=card.locator(".project-open .project-icon");
    await pickIcon(page,card,files.png);
    await expect.poll(async()=>(await savedIcon())?.kind).toBe("image");
    const icon=await savedIcon();
    await expect(tile.locator("img")).toHaveAttribute("src",icon.value);
    for(const file of [files.text,files.bmp]){
      await pickIcon(page,card,file);
      await expect(page.getByRole("alert").filter({hasText:`Could not use ${file.name} as the icon: choose a png, jpeg, webp or gif image.`})).toBeVisible();
      await page.waitForTimeout(300);
      expect(await savedIcon()).toEqual(icon);
      await expect(tile.locator("img")).toHaveAttribute("src",icon.value);
      expect(await tile.locator("img").evaluate(image=>image.complete&&image.naturalWidth>0),"the icon still shows the picture").toBe(true);
    }
    await shootModes(page,"icon-refused",{show:page.getByRole("alert").filter({hasText:"Could not use logo.bmp"})});
  });
});

// A failure of a card's own control is said by that control, in view, not at the top of the page above every card.
test.describe("A card's failures",()=>{
  test("a failed action save, a refused run and a too big icon are said in the card where the person is",async({page,request})=>{
    const boot=await open(page,request);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),actions=card.locator(".project-actions"),identity=card.locator(".project-identity-editor");
      const pageAlert=page.locator(".projects-page>.provider-status-error");
      await card.getByRole("button",{name:/Project identity/}).click();
      // The action editor, typed in; its first save fails.
      let failSave=true;
      await page.route(/\/api\/projects$/,route=>{
        if(route.request().method()!=="POST"||!route.request().postDataJSON()?.scripts||!failSave)return route.fallback();
        failSave=false;return json(route,{error:"Deliberate action save failure"},500);
      });
      await card.getByRole("button",{name:"Add action",exact:true}).click();
      await card.getByPlaceholder("Action name (e.g. Dev server)").click();await page.keyboard.type("Dev server",{delay:5});
      await card.getByPlaceholder("Command (e.g. npm run dev)").click();await page.keyboard.type("npm run dev",{delay:5});
      const save=card.getByRole("button",{name:"Save action",exact:true});
      await save.scrollIntoViewIfNeeded();await save.click();
      const saveFailure=actions.getByRole("alert").filter({hasText:"Deliberate action save failure"});
      await expect(saveFailure).toBeInViewport();
      await expect(save).toBeInViewport();
      await expect(card.getByPlaceholder("Command (e.g. npm run dev)")).toHaveValue("npm run dev");
      await expect(pageAlert).toHaveCount(0);
      await shootModes(page,"card-action-save-failed",{show:save});
      await save.click();
      await expect(actions.locator(".project-action-row")).toContainText("Dev server");
      await expect(card.locator(".project-action-editor")).toHaveCount(0);
      await expect(saveFailure).toHaveCount(0);
      // A refused change of the card's model is said under the card's own settings, across their row.
      await page.route(/\/api\/projects$/,route=>route.request().method()==="POST"&&"defaultModel" in (route.request().postDataJSON()||{})?json(route,{error:"Deliberate model save failure"},500):route.fallback());
      const model=card.getByRole("combobox",{name:"Model"});
      await model.scrollIntoViewIfNeeded();await model.selectOption({index:1});
      const modelFailure=card.locator(".project-overrides").getByRole("alert").filter({hasText:"Deliberate model save failure"});
      await expect(modelFailure).toBeInViewport();
      const [row,box]=[await card.locator(".project-overrides").boundingBox(),await modelFailure.boundingBox()];
      expect(box.width,"the message runs across the settings row").toBeGreaterThan(row.width-40);
      await expect(pageAlert).toHaveCount(0);
      await shootModes(page,"card-model-save-failed",{show:model});
      // The card's run of that action is refused.
      await page.route(/\/api\/project-script\/run$/,route=>json(route,{error:"Deliberate run refusal"},400));
      const run=actions.locator(".project-action-run").filter({hasText:"Dev server"});
      await run.scrollIntoViewIfNeeded();await run.click();
      await expect(actions.getByRole("alert").filter({hasText:"Deliberate run refusal"})).toBeInViewport();
      await expect(pageAlert).toHaveCount(0);
      // An icon over the size limit, picked from the Image button.
      const chooser=page.waitForEvent("filechooser");
      const image=card.locator(".project-image-button");await image.scrollIntoViewIfNeeded();await image.click();
      await (await chooser).setFiles({name:"huge.png",mimeType:"image/png",buffer:Buffer.alloc(1_500_000,1)});
      await expect(identity.getByRole("alert").filter({hasText:"Project icon images must be under 1.4 MB."})).toBeInViewport();
      await expect(actions.getByRole("alert")).toHaveCount(0);
      await expect(pageAlert).toHaveCount(0);
      await shootModes(page,"card-icon-too-big",{show:image});
    }finally{
      await request.post("/api/projects",{data:{path:boot.cwd,scripts:[]}});
    }
  });
  // Many actions (a package.json's scripts brought in with Import all): a refused Run of the first one is said under its row, in
  // view with the Run, not after the whole list; so is a delete of that action that fails. At 900 wide the first Run sits at the
  // bottom of the window, so its refusal is brought into view.
  test("a refused Run or delete of the first of many actions is said under that action",async({page,request})=>{
    const boot=await open(page,request,{width:900});
    const scripts=Array.from({length:20},(_,index)=>({id:"task-"+index,name:"Task "+(index+1),command:"npm run task-"+(index+1),previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false}));
    try{
      await request.post("/api/projects",{data:{path:boot.cwd,scripts,preferredScriptId:"task-0"}});
      await page.route(/\/api\/project-script\/run$/,route=>json(route,{error:"Deliberate run refusal"},400));
      await openProjects(page);
      const actions=page.locator(".project-card.active .project-actions"),row=actions.locator(".project-action-row").filter({has:page.locator("strong",{hasText:/^Task 1$/})}),run=row.locator(".project-action-run");
      await run.scrollIntoViewIfNeeded();await run.click();
      const refusal=actions.getByRole("alert").filter({hasText:"Deliberate run refusal"});
      await expect(refusal).toHaveCount(1);
      await expect(run).toBeInViewport({ratio:1});
      await expect(refusal).toBeInViewport({ratio:1});
      const [rowBox,refusalBox]=[await row.boundingBox(),await refusal.boundingBox()];
      expect(Math.round(refusalBox.y-(rowBox.y+rowBox.height)),"the refusal is right under the row (px)").toBeLessThanOrEqual(12);
      await shootModes(page,"card-run-refused-many-actions",{show:refusal});
      await page.route(/\/api\/projects$/,route=>route.request().method()==="POST"&&route.request().postDataJSON()?.scripts?json(route,{error:"Deliberate action delete failure"},500):route.fallback());
      await row.getByRole("button",{name:"Delete action",exact:true}).click();
      const deleteFailure=actions.getByRole("alert").filter({hasText:"Deliberate action delete failure"});
      await expect(deleteFailure).toBeInViewport();
      await expect(refusal).toHaveCount(0);
      await expect(row).toHaveCount(1);
    }finally{
      await request.post("/api/projects",{data:{path:boot.cwd,scripts:[]}});
    }
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

  // A card is drawn again, Name field and all, when Git answers and it moves into its repository's group. A name on its way when
  // that happens is still the field's name, so Escape and leaving the field keep it.
  test("a name on its way stays in the Name field when the card moves into its repository's group",async({page,request})=>{
    const boot=await open(page,request);
    const saves=[];
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST")return route.fallback();
      saves.push(route.request().postDataJSON()?.name);
      await new Promise(resolve=>setTimeout(resolve,800));
      return route.fallback();
    });
    let release;const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/git\/info/,async route=>{await held;return json(route,{isGit:true,branch:"main",remotes:[{name:"origin",kind:"fetch",url:"https://example.com/polish/workspace.git"}]})});
    await nav(page,"Projects").click();
    const card=page.locator(".project-card.active"),title=card.locator(".project-open strong");
    await expect(title).toHaveText(MAIN);
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    await name.fill("Renamed While Moving");
    await name.press("Enter");
    const field=await name.elementHandle();
    release();
    await expect(page.locator(".project-group-head").filter({hasText:"https://example.com/polish/workspace.git"})).toBeVisible();
    expect(await field.evaluate(node=>node.isConnected),"the card was drawn again").toBe(false);
    await expect(name,"the new field while the name is on its way").toHaveValue("Renamed While Moving");
    await card.locator(".project-identity-editor").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"project-name-on-its-way-redrawn-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"project-name-on-its-way-redrawn-light-1280.png"});
    await flipMode(page,"dark");
    await name.press("Escape");
    await expect(name).toHaveValue("Renamed While Moving");
    await expect(title).toHaveText("Renamed While Moving");
    await name.press("Tab");
    await page.waitForTimeout(1200);
    expect(saves).toEqual(["Renamed While Moving"]);
    expect((await listedProjects(request)).find(project=>project.path===boot.cwd&&!project.environmentId)?.name).toBe("Renamed While Moving");
  });

  // A rename begun straight away, before Enter or leaving the field, keeps its place when Git answers and the card is drawn again
  // in its repository's group: the field still has the keyboard, the text typed so far and the caret where it was. So does a field
  // of the card's action editor. Nothing is saved until the person saves it.
  for(const mode of MODES)test(`a field being typed in keeps its text, caret and focus when the card moves into its repository's group (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    const saves=[];
    page.on("request",item=>{if(item.method()==="POST"&&/\/api\/projects$/.test(item.url()))saves.push(item.postDataJSON())});
    let release=()=>{},held=Promise.resolve();
    const hold=()=>{held=new Promise(resolve=>{release=resolve})};
    await page.route(/\/api\/git\/info/,async route=>{await held;return json(route,{isGit:true,branch:"main",remotes:[{name:"origin",kind:"fetch",url:"https://example.com/polish/workspace.git"}]})});
    const group=page.locator(".project-group-head").filter({hasText:"https://example.com/polish/workspace.git"});
    const card=page.locator(".project-card.active"),title=card.locator(".project-open strong");
    const caret=field=>field.evaluate(node=>[node.selectionStart,node.selectionEnd]);
    hold();
    await nav(page,"Projects").click();
    await expect(title).toHaveText(MAIN);
    await card.getByRole("button",{name:/Project identity/}).click();
    const name=card.getByRole("textbox",{name:"Name"});
    await name.click();
    await name.press("ControlOrMeta+A");
    await name.pressSequentially("Renamed Wile Moving",{delay:15});
    for(let i=0;i<" Moving".length;i++)await name.press("ArrowLeft");
    expect(await caret(name)).toEqual([12,12]);
    const field=await name.elementHandle();
    release();
    await expect(group).toBeVisible();
    expect(await field.evaluate(node=>node.isConnected),"the card was drawn again").toBe(false);
    await expect(name,"the Name field drawn again has the keyboard").toBeFocused();
    await expect(name).toHaveValue("Renamed Wile Moving");
    expect(await caret(name),"the caret is where it was").toEqual([12,12]);
    await card.locator(".project-identity-editor").scrollIntoViewIfNeeded();
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:shots+`project-name-typing-redrawn-${mode}-${width}.png`})}
    await page.setViewportSize({width:1280,height:800});
    await page.waitForTimeout(300);
    expect(saves,"drawing the card again saves nothing").toEqual([]);
    // Typing carries on at the caret, and Enter saves the name once.
    await page.keyboard.press("ArrowLeft");await page.keyboard.press("ArrowLeft");await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("h");
    await expect(name).toHaveValue("Renamed While Moving");
    await page.keyboard.press("Enter");
    await expect(title).toHaveText("Renamed While Moving");
    expect(saves.map(body=>body.name)).toEqual(["Renamed While Moving"]);

    // A field of the action editor, which keeps its text on the page, keeps the keyboard and its caret too.
    hold();
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await nav(page,"Projects").click();
    await expect(title).toHaveText("Renamed While Moving");
    await card.getByRole("button",{name:"Add action",exact:true}).click();
    const command=card.getByPlaceholder("Command (e.g. npm run dev)");
    await command.click();
    await command.pressSequentially("npm run dve",{delay:15});
    await command.press("ArrowLeft");
    const before=await command.elementHandle();
    release();
    await expect(group).toBeVisible();
    expect(await before.evaluate(node=>node.isConnected),"the card was drawn again").toBe(false);
    await expect(command,"the command field drawn again has the keyboard").toBeFocused();
    expect(await caret(command)).toEqual([10,10]);
    await page.keyboard.press("Backspace");await page.keyboard.press("ArrowRight");await page.keyboard.type("v");
    await expect(command).toHaveValue("npm run dev");
    expect(saves.length,"nothing more was saved").toBe(1);
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

// The path line and the Git line under a project's name stay one line each and end in an ellipsis when they do not fit, so each
// carries its whole text as its tooltip, as the name does.
test.describe("A long project path",()=>{
  for(const mode of MODES)test(`and a long branch can be read in full on the card (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    const path=join(boot.cwd,"services","payments-gateway-with-a-very-long-folder-name","reconciliation","nightly-jobs-and-their-fixtures");
    const branch="feature/reconcile-the-nightly-payments-ledger-against-the-gateway-export-before-the-migration-and-backfill-the-missing-settlement-records-for-every-region";
    await request.post("/api/projects",{data:{path,name:"Deep Checkout"}});
    await page.route(/\/api\/git\/info/,route=>new URL(route.request().url()).searchParams.get("path")===path?json(route,{isGit:true,branch,remotes:[]}):route.fallback());
    await nav(page,"Projects").click();
    const card=projectCard(page,"Deep Checkout"),line=card.locator(".project-open>div>span"),detail=card.locator(".project-open>div>small");
    await expect(line).toHaveText("Local machine · "+path);
    await expect(detail).toContainText(branch);
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      await card.scrollIntoViewIfNeeded();
      for(const [what,text] of [["path",line],["Git line",detail]]){
        const shown=await text.evaluate(node=>({cut:node.scrollWidth>node.clientWidth+1,tooltip:node.getAttribute("title")||"",full:node.textContent}));
        expect(shown.cut,`the ${what} is cut at ${width} (so the test meets the ellipsis)`).toBe(true);
        expect(shown.tooltip,`the ${what}'s tooltip has its whole text at ${width}`).toBe(shown.full);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(1);
      await line.hover();
      await page.screenshot({animations:"disabled",path:shots+`project-long-path-${mode}-${width}.png`});
    }
  });
});

// The General chat card says Starting… while the General chat starts, not while the page is busy with something else, such as a
// project being removed; nor does Clone.
test.describe("The General chat card",()=>{
  for(const mode of MODES)test(`says Starting only while the General chat starts (${mode})`,async({page,request})=>{
    await page.route(/\/api\/environments$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      const body=await (await route.fetch()).json();
      return json(route,{...body,profiles:[SSH_PROFILE]});
    });
    const boot=await open(page,request,{mode});
    await request.post("/api/projects",{data:{path:join(boot.cwd,"docs"),name:"Neighbour Project"}});
    let releaseRemoval;const removal=new Promise(resolve=>{releaseRemoval=resolve});
    await page.route(/\/api\/projects\?id=/,async route=>{if(route.request().method()==="DELETE")await removal;return route.fallback()});
    await openProjects(page);
    const general=page.locator(".general-chat-card"),label=general.locator("em"),clone=page.locator(".clone-card").getByRole("button",{name:"Clone",exact:true});
    await expect(label).toHaveText("Start chat");
    await expect(clone).toBeVisible();
    const remove=page.getByRole("button",{name:"Remove Neighbour Project",exact:true});
    await remove.click();
    await expect(remove,"the removal is under way").toBeDisabled();
    await expect(label,"the General chat card while a project is removed").toHaveText("Start chat");
    await expect(clone,"Clone while a project is removed").toHaveText("Clone");
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await general.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`general-chat-during-removal-${mode}-${width}.png`})}
    await page.setViewportSize({width:1280,height:800});
    releaseRemoval();
    await expect(projectCard(page,"Neighbour Project")).toHaveCount(0);
    await expect(general).toBeEnabled();
    // Starting the General chat says so until it has started.
    let releaseStart;const start=new Promise(resolve=>{releaseStart=resolve});
    await page.route(/\/api\/general-workspace$/,async route=>{await start;return route.fallback()});
    await general.click();
    await expect(label).toHaveText("Starting…");
    await expect(clone,"Clone while the General chat starts").toHaveText("Clone");
    await page.screenshot({animations:"disabled",path:shots+`general-chat-starting-${mode}-1280.png`});
    releaseStart();
    await expect(page.locator(".projects-page")).toHaveCount(0);
  });
});
