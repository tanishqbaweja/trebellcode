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
// A card is drawn before its Git details arrive. One whose repository has a checkout listed before it then moves into that
// checkout's group, which draws the card and its open fields again, so the tests that type into a card wait for that first.
async function openProjects(page){
  const git=page.waitForResponse(response=>response.url().includes("/api/git/info"));
  await nav(page,"Projects").click();
  const info=await (await git).json().catch(()=>null);
  const remote=info?.remotes?.find(item=>item.kind==="fetch")?.url;
  if(remote)await expect(page.locator(".project-group-head").filter({hasText:remote}).first()).toBeVisible();
}
// Another checkout of the main project's repository, opened after it so the list leads with it: when Git answers, the main
// project's card moves into this checkout's group and is drawn again there.
const leadingCheckout=(request,boot)=>request.post("/api/projects",{data:{path:join(boot.cwd,"docs"),name:"Neighbour Project"}});
// A door requests wait at until the test opens it, as on a slow server; once open, it lets every request through.
function gate(){let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}}
// The keyboard taken with Tab from where it is to target, as a person tabs to a button.
async function tabTo(page,target){
  for(let step=0;step<8&&!await target.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}
const frames=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
// A click with the mouse in the middle of target, as a person clicks a button that says it is busy (aria-disabled), which
// Playwright's own click would wait on.
async function clickAt(page,target){const box=await target.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2)}

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

  test("a project that is still cloning asks first in the app's own dialog, names what is lost, and Escape or Cancel keeps it",async({page,request})=>{
    const boot=await open(page,request);
    const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Cloning Project"}});
    // The list says this project is still cloning, as it does while a clone job runs.
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      const body=await (await route.fetch()).json();
      return json(route,{...body,projects:(body.projects||[]).map(project=>project.path===path?{...project,cloneJob:{id:"polish-clone",url:"https://github.com/owner/repo.git",status:"running",progress:40,phase:"Receiving objects",error:null,startedAt:Date.now(),completedAt:null}}:project)});
    });
    const deletes=[];page.on("request",request=>{if(request.method()==="DELETE"&&/\/api\/projects\?/.test(request.url()))deletes.push(request.url())});
    // Git has answered and the cards are in their repository's group before the person reaches for Remove.
    await openProjects(page);
    const card=page.locator(".project-card").filter({hasText:"Cloning Project"});
    await expect(card.locator(".project-clone-status")).toContainText("Receiving objects");
    const question=page.locator("dialog.inspector-text-prompt"),cancel=question.getByRole("button",{name:"Cancel",exact:true}),remove=card.getByRole("button",{name:"Remove Cloning Project",exact:true});
    for(const mode of MODES){
      if(mode==="light"){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await remove.click();
      await expect(question.locator("p")).toHaveText("Remove “Cloning Project” while it is still cloning? This cannot be undone: its saved actions, hooks and settings are lost. The clone keeps running.");
      await expect(cancel).toBeFocused();await expect(question.getByRole("button")).toHaveText(["Cancel","Remove project"]);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:shots+`project-remove-question-${mode}-${width}.png`})}
      await page.setViewportSize({width:1280,height:800});
      if(mode==="dark")await page.keyboard.press("Escape");else await cancel.click();
      await expect(question).toHaveCount(0);await expect(remove).toBeFocused();
    }
    await page.waitForTimeout(300);
    expect(deletes).toEqual([]);
    await expect(card).toBeVisible();
    // From the keyboard: Enter on Remove, Tab from Cancel to Remove project, Enter.
    await page.keyboard.press("Enter");await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Remove project",exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    expect(deletes.length).toBe(1);
    await expect(page.getByTestId("thread-undo-toast")).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
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
      // Counted as sent once the server has applied it: a removal that reached the server first had the save put the project back.
      const response=await route.fetch();sent=true;await held;await route.fulfill({response});answered=true;
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

  // The person types a new name and goes straight to Remove (leaving the field saves the name, so the save and the removal are on
  // their way together), then chooses Undo: the project comes back under the name they gave it, whichever reached the server first.
  test("Undo of a removal keeps the name typed just before Remove",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A"}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    const saves=[];page.on("requestfinished",item=>{if(item.method()==="POST"&&/\/api\/projects$/.test(item.url()))saves.push(item.postDataJSON()?.name??null)});
    await openProjects(page);
    const card=projectCard(page,"Project A");
    await card.getByRole("button",{name:/Project identity/}).click();
    await card.getByRole("textbox",{name:"Name"}).fill("Project B");
    await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
    const toast=page.getByTestId("thread-undo-toast");
    await expect(toast).toContainText("Project “Project B” removed");
    await expect.poll(()=>saves.includes("Project B"),{message:"the name was sent"}).toBe(true);
    await toast.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(toast).toHaveCount(0);
    await expect(projectCard(page,"Project B")).toBeVisible();
    await expect.poll(async()=>(await listedProjects(request)).filter(project=>project.path===path).map(project=>project.name).join(",")||"missing",{message:"the restored project's name on the server"}).toBe("Project B");
    await expect(projectCard(page,"Project A")).toHaveCount(0);
  });

  // The server has applied a Permissions change whose answer is slow when the person removes the project, then changes their mind:
  // Undo puts the project back as the server had it when it was removed, with that permission.
  test("Undo of a removal keeps a setting the server saved just before it",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",permissionMode:"edits"}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});let applied=false;
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST"||route.request().postDataJSON()?.permissionMode!=="supervised")return route.fallback();
      const response=await route.fetch();applied=true;await held;await route.fulfill({response});
    });
    try{
      await nav(page,"Projects").click();
      const card=projectCard(page,"Project A");
      await card.getByRole("combobox",{name:"Permissions"}).selectOption("supervised");
      await expect.poll(()=>applied).toBe(true);
      await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
      const toast=page.getByTestId("thread-undo-toast");
      await expect(toast).toContainText("Project “Project A” removed");
      release();
      await toast.getByRole("button",{name:"Undo",exact:true}).click();
      await expect(toast).toHaveCount(0);
      await expect(projectCard(page,"Project A")).toBeVisible();
      await expect.poll(async()=>(await listedProjects(request)).find(project=>project.path===path)?.permissionMode??"missing",{message:"the restored project's permission"}).toBe("supervised");
      await expect(projectCard(page,"Project A").getByRole("combobox",{name:"Permissions"})).toHaveValue("supervised");
    }finally{release();await page.unrouteAll({behavior:"ignoreErrors"})}
  });

  // A Permissions change is still on its way, not yet at the server (a slow connection), when the person removes the project. The
  // save that arrives after the removal is refused, so the project stays removed instead of coming back as a bare record named
  // after its folder; Undo then brings it back with the permission the person chose.
  test("a save still on its way when its project is removed leaves it removed, and Undo brings it back with that save",async({page,request})=>{
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",permissionMode:"edits",scripts:[{id:"a-tests",name:"A tests",command:"npm test"}]}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});let caught=false,answered=null,deletes=0;
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST"||route.request().postDataJSON()?.permissionMode!=="supervised")return route.fallback();
      caught=true;await held;await route.fallback();
    });
    page.on("requestfinished",async item=>{
      if(item.method()==="DELETE"&&/\/api\/projects\?id=/.test(item.url()))deletes++;
      if(item.method()==="POST"&&/\/api\/projects$/.test(item.url())&&item.postDataJSON()?.permissionMode==="supervised")answered=(await item.response())?.status()??null;
    });
    try{
      await nav(page,"Projects").click();
      const card=projectCard(page,"Project A");
      await card.getByRole("combobox",{name:"Permissions"}).selectOption("supervised");
      await expect.poll(()=>caught).toBe(true);
      await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
      const toast=page.getByTestId("thread-undo-toast");
      await expect(toast).toContainText("Project “Project A” removed");
      await expect.poll(()=>deletes).toBe(1);
      expect(await listedProjects(request).then(list=>list.filter(project=>project.path===path)),"removed on the server").toEqual([]);
      release();
      await expect.poll(()=>answered,{message:"the late save's answer"}).toBe(404);
      expect(await listedProjects(request).then(list=>list.filter(project=>project.path===path)),"the late save brought the project back").toEqual([]);
      await expect(projectCard(page,"ui")).toHaveCount(0);
      await expect(page.locator(".projects-page").getByRole("alert"),"the refused late save is not reported as a failure").toHaveCount(0);
      await toast.getByRole("button",{name:"Undo",exact:true}).click();
      await expect(toast).toHaveCount(0);
      await expect(projectCard(page,"Project A")).toBeVisible();
      await expect.poll(async()=>{const restored=(await listedProjects(request)).filter(project=>project.path===path);return restored.map(project=>[project.name,project.permissionMode,project.scripts.length].join(" ")).join(",")||"missing"},{message:"the restored project"}).toBe("Project A supervised 1");
      await page.reload();
      await expect(page.getByTestId("composer")).toBeVisible();
      await nav(page,"Projects").click();
      await expect(projectCard(page,"Project A").getByRole("combobox",{name:"Permissions"})).toHaveValue("supervised");
      await expect(projectCard(page,"ui")).toHaveCount(0);
    }finally{release();await page.unrouteAll({behavior:"ignoreErrors"})}
  });

  // A Permissions change never gets an answer (the server stopped answering it) when the person removes the project and chooses
  // Undo. Undo waits for it a few seconds, not for good: the project comes back as it was removed, and the card says the change
  // still saving is not in it. Undo from another page says so in the app's toast.
  test("Undo of a removal waits a few seconds at most for a save that never answers, and says it is not in the project",async({page,request})=>{
    test.setTimeout(60_000);
    const boot=await open(page,request);
    const path=join(boot.cwd,"ui");
    await request.post("/api/projects",{data:{path,name:"Project A",permissionMode:"edits"}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    // The save is taken and never answered. While lists are held, the page's reads of the project list wait until released.
    let held=0,holdLists=false,releaseLists=()=>{};const listsHeld=new Promise(resolve=>{releaseLists=resolve});
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()==="GET"&&holdLists){await listsHeld;return route.fallback()}
      if(route.request().method()!=="POST"||route.request().postDataJSON()?.permissionMode!=="supervised")return route.fallback();held++;
    });
    const toast=page.getByTestId("thread-undo-toast"),restored=async()=>(await listedProjects(request)).filter(project=>project.path===path).map(project=>project.permissionMode).join(",")||"missing";
    const note="Project restored, but a change still saving when it was removed (Permissions) did not answer in time and is not in it.";
    try{
      await openProjects(page);
      let card=projectCard(page,"Project A");
      await card.getByRole("combobox",{name:"Permissions"}).selectOption("supervised");
      await expect.poll(()=>held,{message:"the save was sent"}).toBe(1);
      await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
      await expect(toast).toContainText("Project “Project A” removed");
      // The removed card leaves once the page has read the list again; the card checked after Undo is then the restored one.
      await expect(card).toHaveCount(0);
      // The list read that follows the restore is held: the card comes back, and says what is missing, without waiting for it.
      holdLists=true;
      await toast.getByRole("button",{name:"Undo",exact:true}).click();
      const undoneAt=Date.now();
      card=projectCard(page,"Project A");
      await expect(card).toBeVisible({timeout:10_000});
      expect(Date.now()-undoneAt,"Undo went ahead within a few seconds").toBeLessThan(8000);
      await expect(card.getByRole("alert")).toHaveText(note);
      holdLists=false;releaseLists();
      await expect(card.getByRole("combobox",{name:"Permissions"})).toHaveValue("edits");
      await expect.poll(restored,{message:"the restored project's permission"}).toBe("edits");
      await shootModes(page,"project-undo-save-never-answered",{show:card.getByRole("alert")});
      // From another page the same Undo says so in the app's toast.
      await card.getByRole("combobox",{name:"Permissions"}).selectOption("supervised");
      await expect.poll(()=>held,{message:"the second save was sent"}).toBe(2);
      await card.getByRole("button",{name:"Remove Project A",exact:true}).click();
      await expect(toast).toContainText("Project “Project A” removed");
      await nav(page,"History").click();
      await toast.getByRole("button",{name:"Undo",exact:true}).click();
      await expect(page.getByTestId("app-action-error")).toContainText("Undo: "+note,{timeout:10_000});
      await expect.poll(restored,{message:"the project is back"}).toBe("edits");
      await page.screenshot({animations:"disabled",path:shots+"project-undo-save-never-answered-elsewhere-dark-1280.png"});
    }finally{releaseLists();await page.unrouteAll({behavior:"ignoreErrors"})}
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

  // Enter on Add environment adds what was typed and the form starts over. Enter pressed again, or held, once the environment is
  // listed lands on that empty Local form, which would only add a second "Local machine" under the host's own: it adds nothing.
  test("Add environment pressed again from the keyboard adds one environment, and an empty Local form adds none",async({page,request})=>{
    await open(page,request);
    const adds=[];page.on("request",sent=>{if(sent.method()==="POST"&&/\/api\/environments$/.test(sent.url()))adds.push(sent.postDataJSON()?.name)});
    await nav(page,"Environments").click();
    await hostDiscovered(page);
    const form=page.locator(".environment-create"),name=form.getByRole("textbox",{name:"Name",exact:true}),add=form.getByRole("button",{name:"Add environment",exact:true});
    const listed=page.locator(".environment-list>div strong"),refresh=page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true}),added=[];
    for(const [mode,box] of [["dark","Twice box"],["light","Held box"]]){
      await switchMode(page,mode);
      await name.click();await page.keyboard.type(box,{delay:15});
      await tabTo(page,add);
      if(mode==="dark")await page.keyboard.press("Enter");else await page.keyboard.down("Enter");
      // The environment is listed and the page is idle again: every button is disabled while an add runs.
      await expect(listed.filter({hasText:box})).toHaveCount(1);await expect(refresh).toBeEnabled();await frames(page);
      if(mode==="dark")await page.keyboard.press("Enter");
      else{for(let repeat=0;repeat<8;repeat++)await page.keyboard.down("Enter");await page.keyboard.up("Enter")}
      added.push(box);
      // Refresh waits for an add still running, then reads the list again.
      await refresh.click();
      await expect(listed).toHaveText(["Local machine",...added]);
      expect(adds,"environments sent to be added").toEqual(added);
      await expect(name).toHaveValue("");
      await expect(add,"an empty Local form adds nothing").toBeDisabled();
    }
    // A WSL environment needs nothing typed: its default distribution is a choice of its own.
    const type=form.getByRole("combobox",{name:"Type"});
    if(await type.locator("option[value=wsl]").isEnabled()){await type.selectOption("wsl");await expect(add).toBeEnabled();await type.selectOption("local");await expect(add).toBeDisabled()}
    expect((await listedEnvironments(request)).map(profile=>profile.name)).toEqual(added);
    await shootModes(page,"environment-added-once",{show:form});
  });

  // The person adds an environment while the server is slow, goes to Projects and comes back before it answers, and waits. The
  // page they come back to shows the form as it was sent and says it is adding it, and is busy with it as the one they left was, so
  // it cannot be added twice; it lists the environment once the add lands, without a Refresh, and the form starts over. The second
  // time they start the next environment in that form while the add is on its way: what they type there stays once it lands.
  test("an Add that lands after the person left Environments and came back is listed without Refresh, and the page says it is adding it until then",async({page,request})=>{
    await open(page,request);
    const hold={door:gate()},adds=[];
    await page.route(/\/api\/environments$/,async route=>{if(route.request().method()!=="POST")return route.fallback();adds.push(route.request().postDataJSON()?.name);await hold.door.promise;return route.fallback()});
    try{
      await nav(page,"Environments").click();
      await hostDiscovered(page);
      const form=page.locator(".environment-create"),name=form.getByRole("textbox",{name:"Name",exact:true}),cwd=form.getByRole("textbox",{name:"Working directory",exact:true}),add=form.getByRole("button",{name:"Add environment",exact:true});
      const listed=page.locator(".environment-list>div strong"),refresh=page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true}),status=page.locator(".environments-page>.inline-status");
      const leaveAndComeBack=async()=>{await nav(page,"Projects").click();await expect(page.locator(".projects-page")).toBeVisible();await nav(page,"Environments").click();await hostDiscovered(page)};
      await name.click();await page.keyboard.type("Slow box",{delay:15});
      await add.click();
      await expect.poll(()=>adds).toEqual(["Slow box"]);
      await expect.soft(status,"the page the add is sent from says it is adding it").toHaveText("Adding “Slow box”…");
      await leaveAndComeBack();
      await expect(listed,"the environment is not listed while its add is on its way").toHaveText(["Local machine"]);
      await expect(name,"the page come back to shows the form the add was sent with").toHaveValue("Slow box");
      await expect(status,"and says the add is on its way").toHaveText("Adding “Slow box”…");
      await expect(refresh,"Refresh while the add is on its way").toBeDisabled();
      await expect(add,"Add environment while the add is on its way").toBeDisabled();
      await shootModes(page,"environment-adding-after-return",{show:form});
      hold.door.open();
      await expect(listed,"the environment once its add has landed, with no Refresh").toHaveText(["Local machine","Slow box"]);
      await expect(refresh).toBeEnabled();await expect(status).toHaveCount(0);
      await expect(name,"the form starts over once the add lands, as it still holds what was sent").toHaveValue("");
      // The next one: back again while it is on its way, the person types the environment after it into the form it shows.
      hold.door=gate();
      await name.click();await page.keyboard.type("Second box",{delay:15});
      await add.click();
      await expect.poll(()=>adds).toEqual(["Slow box","Second box"]);
      await leaveAndComeBack();
      await expect(name).toHaveValue("Second box");await expect(status).toHaveText("Adding “Second box”…");
      await name.click();await page.keyboard.press("Control+A");await page.keyboard.type("Third box",{delay:15});
      await cwd.click();await page.keyboard.type("C:\\code\\third",{delay:15});
      hold.door.open();
      await expect(listed).toHaveText(["Local machine","Slow box","Second box"]);
      await expect(refresh).toBeEnabled();await expect(status).toHaveCount(0);
      await expect(name,"what was typed while the add was on its way stays once it lands").toHaveValue("Third box");
      await expect(cwd).toHaveValue("C:\\code\\third");
      await expect(add).toBeEnabled();
      expect(adds,"environments sent to be added").toEqual(["Slow box","Second box"]);
      expect((await listedEnvironments(request)).map(profile=>profile.name)).toEqual(["Slow box","Second box"]);
      await shootModes(page,"environment-added-after-return",{show:page.locator(".environment-list")});
    }finally{hold.door.open()}
  });

  // The person adds an environment while the server is slow and goes to Projects; the add fails while they are there. Back on
  // Environments the page says why, with the form that failed, so they can add it again.
  test("an Add that fails while the person is on another page is said when they come back, with the form that failed",async({page,request})=>{
    await open(page,request);
    const door=gate(),adds=[];
    await page.route(/\/api\/environments$/,async route=>{
      if(route.request().method()!=="POST")return route.fallback();
      adds.push(route.request().postDataJSON()?.name);await door.promise;
      return adds.length===1?json(route,{error:"Deliberate environment add failure"},500):route.fallback();
    });
    try{
      await nav(page,"Environments").click();
      await hostDiscovered(page);
      const form=page.locator(".environment-create"),name=form.getByRole("textbox",{name:"Name",exact:true}),cwd=form.getByRole("textbox",{name:"Working directory",exact:true}),add=form.getByRole("button",{name:"Add environment",exact:true});
      const listed=page.locator(".environment-list>div strong"),alert=page.locator(".environments-page>.inline-error");
      await name.click();await page.keyboard.type("Failing box",{delay:15});
      await cwd.click();await page.keyboard.type("C:\\code\\failing",{delay:15});
      await add.click();
      await expect.poll(()=>adds).toEqual(["Failing box"]);
      await nav(page,"Projects").click();await expect(page.locator(".projects-page")).toBeVisible();
      const failed=page.waitForResponse(response=>/\/api\/environments$/.test(response.url())&&response.request().method()==="POST");
      door.open();await failed;await frames(page);await page.waitForTimeout(300);
      await nav(page,"Environments").click();
      await hostDiscovered(page);
      await expect(alert,"the failure, on the page the person comes back to").toHaveText("Deliberate environment add failure");
      await expect(name,"the form that failed").toHaveValue("Failing box");await expect(cwd).toHaveValue("C:\\code\\failing");
      await expect(add).toBeEnabled();
      await shootModes(page,"environment-add-failed-while-away",{show:form});
      await add.click();
      await expect(listed).toHaveText(["Local machine","Failing box"]);await expect(alert).toHaveCount(0);
      await expect(name).toHaveValue("");
      expect(adds).toEqual(["Failing box","Failing box"]);
      expect((await listedEnvironments(request)).map(profile=>[profile.name,profile.cwd])).toEqual([["Failing box","C:\\code\\failing"]]);
    }finally{door.open()}
  });

  // Docker Desktop's own WSL distro runs its engine. Offline, host discovery answers as a fixed host whose wsl --list names one distro
  // beside Docker Desktop's (src/offline-e2e-host.mjs; with TREBELL_E2E_ALLOW_NETWORK=1 it asks this host), and Docker Desktop's
  // distro is neither listed as a WSL target nor offered in the Distribution picker.
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
    // The ssh client's words differ between OpenSSH builds (Windows' own says "banner exchange: Connection to UNKNOWN port -1:
    // Connection refused", Git for Windows' "ssh: connect to host 127.0.0.1 port N: Connection refused"); the reason is said one way,
    // with the host and port.
    await expect(alert).toHaveText(`Could not use Dead host for agents: ssh could not connect to 127.0.0.1 port ${port}: Connection refused.`);
    await expect(local.getByText("Active",{exact:true})).toBeVisible();
    await expect(dead.getByRole("button",{name:"Use for agent",exact:true})).toBeEnabled();
    await shootModes(page,"environment-unreachable-not-used");
    // Its Test button says it the same way.
    await dead.getByRole("button",{name:"Test",exact:true}).click();
    await expect(alert).toHaveText(`Probe failed · ssh could not connect to 127.0.0.1 port ${port}: Connection refused.`,{timeout:30_000});
    await shootModes(page,"environment-unreachable-test");
    await page.reload();
    await expect(page.getByTestId("composer").or(page.locator(".environments-page")).first()).toBeVisible();
    if(!await page.locator(".environments-page").count())await nav(page,"Environments").click();
    await expect(local.getByText("Active",{exact:true})).toBeVisible();
    await expect(dead.getByRole("button",{name:"Use for agent",exact:true})).toBeEnabled();
    await expect(dead.getByText("Agent active",{exact:true})).toHaveCount(0);
    expect(await server()).toBe(null);
  });
  // A host that takes the connection and never answers, where ssh waits 8 s before it gives up: the page says it is checking the
  // host from the click on, while every button waits, and then that it could not use it.
  test("Use for agent on a host that never answers says it is checking while the person waits",async({page,request})=>{
    test.setTimeout(60_000);
    const held=[],silent=createServer(socket=>{held.push(socket);socket.on("error",()=>{})});
    await new Promise((resolve,reject)=>silent.listen(0,"127.0.0.1",resolve).once("error",reject));
    try{
      await open(page,request);
      expect((await request.post("/api/environments",{data:{id:"polish-silent-host",type:"ssh",name:"Silent host",host:"127.0.0.1",port:silent.address().port,cwd:"/srv/app"}})).ok()).toBe(true);
      await nav(page,"Environments").click();
      const use=page.locator(".environment-list>div").filter({hasText:"Silent host"}).getByRole("button",{name:"Use for agent",exact:true});
      await use.click();
      const checking=page.locator(".environments-page").getByRole("status").filter({hasText:"Checking Silent host…"});
      await expect(checking).toBeVisible();
      await expect(use).toBeDisabled();
      await shootModes(page,"environment-checking-host");
      await expect(checking,"still checking while ssh waits for the host").toBeVisible();
      await expect(page.locator(".environments-page").getByRole("alert")).toContainText("Could not use Silent host for agents",{timeout:30_000});
      await expect(checking).toHaveCount(0);
      expect((await (await request.get("/api/environments")).json()).activeEnvironmentId).toBe(null);
    }finally{
      for(const socket of held)socket.destroy();
      await new Promise(resolve=>silent.close(resolve));
    }
  });
  // Keyboard only: Enter on Use for agent disables every button while the host is checked, which drops the keyboard; when the
  // switch is refused the keyboard is back on Use for agent, and the next Tab goes on to that row's Test.
  test("a refused Use for agent pressed with the keyboard leaves the keyboard on it",async({page,request})=>{
    test.setTimeout(60_000);
    await open(page,request);
    const port=await deadPort();
    expect((await request.post("/api/environments",{data:{id:"polish-dead-keys",type:"ssh",name:"Dead host",host:"127.0.0.1",port,cwd:"/srv/app"}})).ok()).toBe(true);
    await nav(page,"Environments").click();
    const row=page.locator(".environment-list>div").filter({hasText:"Dead host"}),use=row.getByRole("button",{name:"Use for agent",exact:true});
    // The person has tabbed to the button; Enter presses it.
    await use.focus();await expect(use).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".environments-page").getByRole("alert")).toContainText("Could not use Dead host for agents",{timeout:30_000});
    await expect(use).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button",{name:"Test",exact:true})).toBeFocused();
  });
});

test.describe("Switching an environment off and on",()=>{
  // The person tabs to an environment's Switch off and holds Enter a moment. Every button waits while the save runs, and the keyboard
  // goes back to the button once it is in, where it says Switch on, so each repeat of the key after a save saved the other way: one
  // held press saved again and again and left the environment wherever its last save landed. The press switches it off once and the
  // keyboard stays on the button; a press of its own switches it on again, and a double click's second click, which comes once the
  // first click's save is in, switches nothing.
  test("Enter held on Switch off switches the environment off once, and a double click switches it once",async({page,request})=>{
    await open(page,request);
    for(const data of [{...SSH_PROFILE,id:"polish-first-box",name:"First box",host:"first.example.com"},{...SSH_PROFILE,id:"polish-held-box",name:"Held box",host:"held.example.com"}])expect((await request.post("/api/environments",{data})).ok()).toBe(true);
    const saves=[];page.on("request",sent=>{if(sent.method()==="POST"&&/\/api\/environment\/enabled$/.test(sent.url()))saves.push(sent.postDataJSON()?.enabled)});
    await nav(page,"Environments").click();
    const row=page.locator(".environment-list>div").filter({hasText:"Held box"}),off=row.getByRole("button",{name:"Switch off",exact:true}),on=row.getByRole("button",{name:"Switch on",exact:true});
    const status=page.locator(".environments-page").getByRole("status"),refresh=page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true});
    const saved=async()=>(await listedEnvironments(request)).find(profile=>profile.id==="polish-held-box")?.enabled;
    await expect(off).toBeEnabled();
    // Enter goes down on Switch off and stays down: the save goes in, the keyboard is back on the button, and the key goes on repeating.
    await off.focus();await page.keyboard.down("Enter");
    await expect(on).toBeFocused();
    for(let repeat=0;repeat<6;repeat++){await page.keyboard.down("Enter");await frames(page)}
    await page.keyboard.up("Enter");
    await expect(refresh,"no save is running").toBeEnabled();
    expect(saves,"one held press saves once").toEqual([false]);
    await expect(on,"the keyboard stays on the button, which says Switch on").toBeFocused();
    await expect(row).toContainText("switched off");
    await expect(status).toHaveText("Environment switched off. Its configuration is still saved.");
    expect(await saved()).toBe(false);
    // A press of its own switches it on again.
    await page.keyboard.press("Enter");
    await expect(off).toBeFocused();await expect(status).toHaveText("Environment switched on.");
    expect(saves).toEqual([false,true]);
    // A double click on Switch off: its second click comes once the first click's save is in, on the button that says Switch on.
    const box=await off.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.mouse.up();
    await expect(on).toBeEnabled();await expect(on).toBeFocused();
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
    await frames(page);await expect(refresh).toBeEnabled();
    expect(saves,"a double click saves once").toEqual([false,true,false]);
    await expect(row).toContainText("switched off");await expect(on).toBeFocused();
    await expect(status).toHaveText("Environment switched off. Its configuration is still saved.");
    expect(await saved()).toBe(false);
    await shootModes(page,"environment-switched-off-once",{show:row});
  });

  // The person switches First box off and points at the page's buttons while its save runs: every one waits, half faded, with the
  // default arrow, as Refresh does. Switched off, First box's Use for agent and Test show the arrow too, in dark and light, wide and
  // narrow, as Add environment does with nothing typed, while the buttons that work keep the hand. On 86c4fdb8 every disabled button
  // but Refresh kept the hand: the rule for the page's buttons outweighed the one for disabled buttons, which kept only its fading.
  test("a button that waits shows the default arrow, not the hand, while a switch saves and once the environment is off",async({page,request})=>{
    await open(page,request);
    for(const data of [{...SSH_PROFILE,id:"polish-first-box",name:"First box",host:"first.example.com"},{...SSH_PROFILE,id:"polish-other-box",name:"Other box",host:"other.example.com"}])expect((await request.post("/api/environments",{data})).ok()).toBe(true);
    const held=gate();
    await page.route(/\/api\/environment\/enabled$/,async route=>{await held.promise;return route.fallback()});
    await nav(page,"Environments").click();
    const environments=page.locator(".environments-page"),row=environments.locator(".environment-list>div").filter({hasText:"First box"});
    const off=row.getByRole("button",{name:"Switch off",exact:true}),add=environments.getByRole("button",{name:"Add environment",exact:true});
    // The mouse on a button, as a person points at it: the pointer shown there and how faded the button is.
    const pointed=async button=>{await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);return button.evaluate(node=>getComputedStyle(node).cursor+" "+getComputedStyle(node).opacity)};
    await expect(off).toBeEnabled();
    for(const label of ["Use for agent","Test","Switch off","Remove First box"])expect(await pointed(row.getByRole("button",{name:label,exact:true})),label+" at rest").toBe("pointer 1");
    // Switch off clicked, its save held: every button on the page waits, with the arrow.
    await off.click();
    await expect(environments.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeDisabled();
    const waiting=[];
    for(const button of await environments.getByRole("button").all()){await expect(button).toBeDisabled();waiting.push(await button.evaluate(node=>node.getAttribute("aria-label")||node.textContent.trim())+" "+await pointed(button))}
    expect(waiting,"each button while the switch saves").toEqual(["Refresh","Use for agent","Test","Switch off","Remove First box","Use for agent","Test","Switch off","Remove Other box","Add environment"].map(label=>label+" default 0.5"));
    held.open();
    await expect(row).toContainText("switched off");
    await expect(row.getByRole("button",{name:"Switch on",exact:true})).toBeEnabled();
    // Switched off, First box's Use for agent and Test wait for Switch on, with the arrow; Switch on and Remove keep the hand.
    for(const mode of MODES){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        for(const label of ["Use for agent","Test"]){const button=row.getByRole("button",{name:label,exact:true});await expect(button).toBeDisabled();expect(await pointed(button),`${label} switched off (${mode} ${width})`).toBe("default 0.5")}
        for(const label of ["Switch on","Remove First box"])expect(await pointed(row.getByRole("button",{name:label,exact:true})),`${label} (${mode} ${width})`).toBe("pointer 1");
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    // Add environment waits for the form, with the arrow, and takes the hand once a name is typed.
    const name=environments.locator(".environment-create").getByRole("textbox",{name:"Name",exact:true});
    await expect(add).toBeDisabled();expect(await pointed(add),"Add environment with nothing typed").toBe("default 0.5");
    await name.click();await page.keyboard.type("Typed box",{delay:15});
    await expect(add).toBeEnabled();expect(await pointed(add),"Add environment with a name typed").toBe("pointer 1");
    await name.click();await page.keyboard.press("ControlOrMeta+A");await page.keyboard.press("Backspace");
    await expect(add).toBeDisabled();
    await shootModes(page,"environment-switched-off-arrow",{show:row});
  });
});

test.describe("An environment list that is still loading or failed",()=>{
  const card=page=>page.locator(".capability-card").filter({has:page.getByText("Configured environments",{exact:true})});
  // What the card would claim from its starting values, before the list is read: a count, Local machine active, none saved.
  async function claimsNothing(page){
    await expect(card(page).getByText("No saved remote environments",{exact:false})).toHaveCount(0);
    await expect(card(page).getByText("Active",{exact:true})).toHaveCount(0);
    await expect(card(page).locator(".capability-card-head em")).toHaveCount(0);
    await expect(card(page).getByRole("button",{name:"Use for agent"})).toHaveCount(0);
  }
  // Two environments are saved and the agent runs in one of them (Use for agent on Lane local box), and host discovery keeps the
  // first read out for seconds, as on a busy host: until it answers the card says it is loading, as Host capabilities says it is
  // checking, instead of a count of 1, "Local machine · Active" and "No saved remote environments".
  test("while the first read is out, Configured environments says it is loading and calls no environment active",async({page,request})=>{
    await open(page,request);
    for(const data of [{id:"lane-local-box",type:"local",name:"Lane local box",cwd:process.cwd()},SSH_PROFILE])expect((await request.post("/api/environments",{data})).ok()).toBe(true);
    const held=gate();
    await page.route(/\/api\/environments$/,async route=>{
      if(route.request().method()!=="GET")return route.fallback();
      await held.promise;
      const body=await (await route.fetch()).json();
      return json(route,{...body,activeEnvironmentId:"lane-local-box",activeEnvironment:(body.profiles||[]).find(profile=>profile.id==="lane-local-box")||null});
    });
    await nav(page,"Environments").click();
    await expect(page.getByTestId("host-discovery-pending")).toBeVisible();
    await claimsNothing(page);
    await expect(card(page).getByRole("status")).toHaveText("Loading environments…");
    await shootModes(page,"environments-first-read-loading");
    held.open();
    const rows=page.locator(".environment-list>div");
    await expect(rows.filter({hasText:"Lane local box"}).getByText("Agent active",{exact:true})).toBeVisible();
    await expect(rows.filter({hasText:"Local machine"}).getByRole("button",{name:"Use for agent",exact:true})).toBeVisible();
    await expect(rows.filter({hasText:"Build box"})).toBeVisible();
    await expect(card(page).locator(".capability-card-head em")).toHaveText("3");
    await expect(card(page).getByRole("status")).toHaveCount(0);
    await expect(card(page).getByText("No saved remote environments",{exact:false})).toHaveCount(0);
  });

  // A first read that fails says so at the top, and the card says its list is not loaded rather than claim Local machine is the only
  // one; Refresh, pressed from the keyboard, lists the saved environment.
  test("a failed first read says the environments are not loaded, and Refresh lists them",async({page,request})=>{
    await open(page,request);
    expect((await request.post("/api/environments",{data:SSH_PROFILE})).ok()).toBe(true);
    let fail=true;
    await page.route(/\/api\/environments$/,route=>route.request().method()==="GET"&&fail?json(route,{error:"Deliberate environments failure"},500):route.fallback());
    await nav(page,"Environments").click();
    await expect(page.locator(".environments-page").getByRole("alert")).toHaveText("Could not refresh environments: Deliberate environments failure");
    await claimsNothing(page);
    await expect(card(page).getByRole("status")).toHaveText("Not loaded: the environments could not be read.");
    await shootModes(page,"environments-first-read-failed");
    fail=false;
    const refresh=page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true});
    await refresh.focus();await page.keyboard.press("Enter");
    await expect(page.locator(".environment-list>div").filter({hasText:"Build box"})).toBeVisible();
    await expect(card(page).locator(".capability-card-head em")).toHaveText("2");
    await expect(card(page).getByRole("status")).toHaveCount(0);
    await expect(page.locator(".environments-page").getByRole("alert")).toHaveCount(0);
    await expect(refresh).toBeFocused();
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

  // A double click on the card's Cancel or Retry, and Enter pressed twice on Cancel: each cancel or retry waits at a door until the
  // presses are in, as on a slow server, so the second press comes while the first one's request is on its way. It sends nothing.
  test("a double click on a cloning card's Cancel or Retry, or Enter pressed twice on Cancel, sends one request",async({page,request})=>{
    test.setTimeout(120_000);
    const parent=mkdtempSync(join(tmpdir(),"trebell-e2e-clone-twice-"));
    const sockets=new Set(),remote=createHttpServer(incoming=>{sockets.add(incoming.socket)});
    await new Promise((resolve,reject)=>remote.listen(0,"127.0.0.1",resolve).once("error",reject));
    const hold={door:gate(),sent:[]};
    await page.route(/\/api\/clone-jobs$/,async route=>{
      const action=route.request().method()==="POST"?route.request().postDataJSON()?.action:null;
      if(!["cancel","retry"].includes(action))return route.fallback();
      hold.sent.push(action);await hold.door.promise;return route.fallback();
    });
    try{
      await page.addInitScript(folder=>{window.trebellDesktop={pickDirectory:async()=>folder}},parent);
      await open(page,request);
      await nav(page,"Projects").click();
      const clone=page.locator(".clone-card");
      await clone.getByRole("textbox",{name:"Clone URL"}).click();
      await page.keyboard.type(`http://127.0.0.1:${remote.address().port}/team/twice-repo.git`,{delay:10});
      await clone.getByRole("button",{name:"Clone",exact:true}).click();
      await expect(page.getByTestId("clone-banner")).toBeVisible({timeout:20_000});
      await expect.poll(()=>sockets.size,{message:"git reached the remote",timeout:20_000}).toBeGreaterThan(0);
      await nav(page,"Projects").click();
      const status=projectCard(page,"twice-repo").locator(".project-clone-status"),cancel=status.getByRole("button",{name:"Cancel"}),retry=status.getByRole("button",{name:"Retry"});
      await expect(status).toContainText("%");
      await cancel.dblclick();
      await expect.poll(()=>hold.sent.length).toBeGreaterThan(0);
      hold.door.open();
      await expect(status).toContainText("Clone cancelled",{timeout:10_000});
      expect(hold.sent,"requests sent for a double click on Cancel").toEqual(["cancel"]);
      // A double click on Retry starts the clone once, and git reaches the remote again.
      hold.door=gate();const reached=sockets.size;
      await retry.dblclick();
      await expect.poll(()=>hold.sent.length).toBeGreaterThan(1);
      hold.door.open();
      await expect(cancel).toBeVisible({timeout:10_000});
      await expect.poll(()=>sockets.size,{message:"git reached the remote again",timeout:20_000}).toBeGreaterThan(reached);
      expect(hold.sent,"requests sent for a double click on Retry").toEqual(["cancel","retry"]);
      // Enter pressed twice on Cancel.
      hold.door=gate();
      await cancel.focus();await page.keyboard.press("Enter");
      await expect.poll(()=>hold.sent.length).toBeGreaterThan(2);
      await page.keyboard.press("Enter");
      hold.door.open();
      await expect(status).toContainText("Clone cancelled",{timeout:10_000});
      expect(hold.sent,"requests sent for Enter pressed twice on Cancel").toEqual(["cancel","retry","cancel"]);
      await expect(status.getByRole("alert")).toHaveCount(0);
      await shootModes(page,"clone-card-cancelled-once",{show:status});
      // A double click on Retry on a quick host: the retry goes through at once, and the list shows the new clone running, with its
      // Cancel where Retry was, before the second click comes. That click starts nothing and cancels nothing: the clone goes on.
      hold.door=gate();hold.door.open();const before=hold.sent.length,again=sockets.size;
      const box=await retry.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
      await page.mouse.click(x,y);
      await expect(cancel).toBeVisible({timeout:10_000});
      const under=await cancel.boundingBox();
      expect(x>=under.x&&x<=under.x+under.width&&y>=under.y&&y<=under.y+under.height,"Cancel is under the pointer where Retry was").toBe(true);
      await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
      await frames(page);await page.waitForTimeout(600);
      expect(hold.sent.slice(before),"requests sent for a double click on Retry whose second click lands on the new clone's Cancel").toEqual(["retry"]);
      await expect(status).not.toContainText("Clone cancelled");await expect(cancel).toBeVisible();
      await expect.poll(()=>sockets.size,{message:"the clone retried goes on, and git reaches the remote again",timeout:20_000}).toBeGreaterThan(again);
      await shootModes(page,"clone-card-retried-once",{show:status});
    }finally{
      hold.door.open();
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
      // The clone's progress cannot be read for a while (the server is busy or restarting): the banner says so under its text, and
      // the conversation still starts below the banner, which has grown by that line (two lines at 900 wide).
      await page.route(/\/api\/clone-jobs\?id=/,route=>route.request().method()==="GET"?json(route,{error:"Deliberate clone progress failure while the server restarts"},500):route.fallback());
      await expect(banner).toContainText("Could not refresh clone progress",{timeout:10_000});
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        const first=await page.locator(".conversation-scroll .conversation-column").evaluate(column=>Math.min(...[...column.children].map(child=>child.getBoundingClientRect()).filter(box=>box.height>0).map(box=>box.top)));
        const bannerBox=await banner.boundingBox();
        expect(first,`the conversation starts below the banner with its refresh error at ${width}`).toBeGreaterThanOrEqual(bannerBox.y+bannerBox.height);
      }
      await page.setViewportSize({width:1280,height:800});
      await shootModes(page,"clone-banner-refresh-error");
      await page.unroute(/\/api\/clone-jobs\?id=/);
      await cancel.click();
      await expect(banner).toContainText("Clone cancelled",{timeout:10_000});
    }finally{
      for(const socket of sockets)socket.destroy();
      await new Promise(resolve=>remote.close(resolve));
      await expect.poll(async()=>["running","cancelling"].includes(await job()),{timeout:20_000}).toBe(false).catch(()=>{});
      try{rmSync(parent,{recursive:true,force:true,maxRetries:50,retryDelay:100})}catch{}
    }
  });

  // Cancel on the banner of a clone still at 0%: while the clone stops, the banner says so instead of a progress that no longer
  // moves, and once it has stopped it says the clone was cancelled, with Retry clone. It never reads 0% after the Cancel. The
  // clone's progress reads are held while it stops, as on a busy server, so the stopping state can be seen.
  test("after Cancel the clone banner says the clone is stopping, then cancelled, never a stuck 0%",async({page,request})=>{
    await request.post("/api/settings",{data:BASE});
    let job={id:"clone-cancel-banner",url:"https://example.invalid/team/held-repo.git",status:"running",phase:"Cloning",progress:0,error:null,startedAt:Date.now(),completedAt:null};
    const project=()=>({id:"clone-cancel-project",name:"held-repo",path:process.cwd(),environmentId:null,scripts:[],cloneJob:job});
    let releaseReads=()=>{};const readsHeld=new Promise(resolve=>{releaseReads=resolve});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"clone-cancel-banner-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{...BASE,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:"clone-cancel-project"},projects:[project()],threadMeta:{}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[project()],project:project()}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:false,status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/clone-jobs\?id=/,async route=>{if(job.status!=="running")await readsHeld;return json(route,{job,project:project()})});
    const cancels=[];
    await page.route(/\/api\/clone-jobs$/,route=>{
      const body=route.request().postDataJSON()||{};
      if(body.action!=="cancel")return route.fallback();
      cancels.push(body.id);job={...job,status:"cancelling",phase:"Cancelling"};
      return json(route,{ok:true,job,project:project()});
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const banner=page.getByTestId("clone-banner");
    await expect(banner).toContainText("You can keep writing");
    await expect(banner.locator("em"),"a running clone shows its progress").toHaveText("0%");
    await banner.getByRole("button",{name:"Cancel"}).click();
    await expect(banner).toContainText("Stopping the clone…");
    await expect(banner).not.toContainText("%");
    await expect(banner).not.toContainText("You can keep writing");
    expect(cancels).toEqual(["clone-cancel-banner"]);
    await shootModes(page,"clone-banner-stopping");
    // The clone has stopped.
    job={...job,status:"cancelled",phase:"Cancelled",completedAt:Date.now()};releaseReads();
    await expect(banner).toContainText("Clone cancelled");
    await expect(banner).not.toContainText("%");
    await expect(banner.getByRole("button",{name:"Retry clone"})).toBeVisible();
    await shootModes(page,"clone-banner-cancelled-no-percent");
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
  // Keyboard only: Tab goes on from Monogram to Image, and Enter on Image opens the file chooser, as Import JSON does in Settings.
  test("the Image control is reached with Tab and Enter on it opens the file chooser",async({page,request})=>{
    const boot=await open(page,request);
    await openProjects(page);
    const card=page.locator(".project-card.active");
    await card.getByRole("button",{name:/Project identity/}).click();
    const monogram=card.getByRole("button",{name:"Monogram",exact:true}),image=card.getByRole("button",{name:"Image",exact:true});
    await monogram.focus();await expect(monogram).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(image).toBeFocused();
    const files=await iconFiles(page),chooser=page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles(files.png);
    await expect.poll(async()=>(await listedProjects(request)).find(project=>project.path===boot.cwd)?.icon?.kind).toBe("image");
    await expect(image).toBeFocused();
    // Shown with the keyboard on Image in both modes: the header's mode button takes focus, so Tab brings it back each time.
    for(const mode of MODES){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      await monogram.focus();await page.keyboard.press("Tab");await expect(image).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await image.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`icon-image-keyboard-${mode}-${width}.png`})}
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
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
      await page.locator("dialog.inspector-text-prompt").getByRole("button",{name:"Delete action",exact:true}).click();
      const deleteFailure=actions.getByRole("alert").filter({hasText:"Deliberate action delete failure"});
      await expect(deleteFailure).toBeInViewport();
      await expect(refusal).toHaveCount(0);
      await expect(row).toHaveCount(1);
    }finally{
      await request.post("/api/projects",{data:{path:boot.cwd,scripts:[]}});
    }
  });
  // The card's own trash button, on a card further down the list: a removal that fails is said in that card under its header, by
  // the button, not at the top of the page.
  test("a failed removal of a project further down the list is said in its card",async({page,request})=>{
    const root=mkdtempSync(join(tmpdir(),"trebell-polish-remove-"));
    try{
      await open(page,request);
      for(let index=1;index<=6;index++){const path=join(root,"service-"+index);mkdirSync(path);await request.post("/api/projects",{data:{path,name:"Service "+index}})}
      await page.route(/\/api\/projects\?id=/,route=>route.request().method()==="DELETE"?json(route,{error:"Deliberate removal failure"},500):route.fallback());
      await openProjects(page);
      const card=projectCard(page,"Service 1"),trash=card.getByRole("button",{name:"Remove Service 1",exact:true});
      await trash.scrollIntoViewIfNeeded();await trash.click();
      const failure=card.getByRole("alert").filter({hasText:"Could not remove project: Deliberate removal failure"});
      await expect(failure).toBeInViewport({ratio:1});
      await expect(trash).toBeInViewport({ratio:1});
      await expect(card).toHaveCount(1);
      await expect(page.locator(".projects-page>.provider-status-error")).toHaveCount(0);
      await shootModes(page,"card-remove-failed",{show:failure});
    }finally{
      try{rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}catch{}
    }
  });
});

test.describe("Saving an action or a hook",()=>{
  // Every save of a card's actions or hooks waits at a door until the test opens it, so a press made while a save is on its way
  // is told apart from one made after it lands. saves lists what each save sent was for: "actions" or "hooks".
  async function holdCardSaves(page){
    const hold={door:gate(),saves:[]};
    await page.route(/\/api\/projects$/,async route=>{
      const body=route.request().method()==="POST"?route.request().postDataJSON():null;
      if(!body?.scripts&&!body?.hooks)return route.fallback();
      hold.saves.push(body.scripts?"actions":"hooks");await hold.door.promise;return route.fallback();
    });
    return hold;
  }
  const savedNames=async(request,boot,kind)=>((await listedProjects(request)).find(project=>project.path===boot.cwd)?.[kind]||[]).map(item=>item.name);

  test("Save action pressed again while it saves, from the keyboard or with a double click, saves one action, and the next one's editor keeps what is typed",async({page,request})=>{
    const boot=await open(page,request);
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),editor=card.locator(".project-action-editor"),rows=card.locator(".project-action-row strong");
      const name=editor.getByPlaceholder("Action name (e.g. Dev server)"),command=editor.getByPlaceholder("Command (e.g. npm run dev)"),save=editor.getByRole("button",{name:"Save action",exact:true});
      const addAction=async(label,run)=>{await card.getByRole("button",{name:"Add action",exact:true}).click();await name.click();await page.keyboard.type(label,{delay:10});await command.click();await page.keyboard.type(run,{delay:10})};
      // Enter on Save action, Enter again, then Enter held: all while the first save is on its way.
      await addAction("First action","node first.js");
      await tabTo(page,save);
      await page.keyboard.press("Enter");
      await expect.poll(()=>hold.saves.length).toBeGreaterThan(0);
      await page.keyboard.press("Enter");
      await page.keyboard.down("Enter");for(let repeat=0;repeat<5;repeat++)await page.keyboard.down("Enter");await page.keyboard.up("Enter");
      hold.door.open();
      await expect(editor).toHaveCount(0);
      expect(hold.saves,"saves sent for Save action pressed again while it saved").toEqual(["actions"]);
      await expect(rows).toHaveText(["First action"]);
      // The person goes straight on to the next action, and double-clicks its Save action.
      hold.door=gate();
      await addAction("Second action","node second.js");
      await expect(name).toHaveValue("Second action");
      await save.dblclick();
      await expect.poll(()=>hold.saves.length).toBeGreaterThan(1);
      hold.door.open();
      await expect(editor).toHaveCount(0);
      expect(hold.saves,"saves sent for a double click on Save action").toEqual(["actions","actions"]);
      await expect(rows).toHaveText(["First action","Second action"]);
      expect(await savedNames(request,boot,"scripts")).toEqual(["First action","Second action"]);
      await shootModes(page,"card-action-saved-once",{show:card.locator(".project-actions")});
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,scripts:[]}});
    }
  });

  test("Enter held on Save hook saves one hook",async({page,request})=>{
    const boot=await open(page,request);
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),editor=card.locator(".project-hook-editor"),save=editor.getByRole("button",{name:"Save hook",exact:true});
      await card.getByRole("button",{name:"Add hook",exact:true}).click();
      await editor.getByPlaceholder("Hook name (e.g. Lint gate)").click();await page.keyboard.type("Held hook",{delay:10});
      await editor.getByPlaceholder("Command (e.g. npm run lint)").click();await page.keyboard.type("npm run held",{delay:10});
      await tabTo(page,save);
      await page.keyboard.down("Enter");
      await expect.poll(()=>hold.saves.length).toBeGreaterThan(0);
      for(let repeat=0;repeat<8;repeat++)await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      hold.door.open();
      await expect(editor).toHaveCount(0);
      expect(hold.saves,"saves sent for Enter held on Save hook").toEqual(["hooks"]);
      await expect(card.locator(".project-hook-row strong")).toHaveText(["Held hook"]);
      expect(await savedNames(request,boot,"hooks")).toEqual(["Held hook"]);
      await shootModes(page,"card-hook-saved-once",{show:card.locator(".project-hooks")});
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,hooks:[]}});
    }
  });

  // Save, then Cancel while the save is on its way, and Add again for the next one: the save that lands closes nothing, and the
  // editor opened since keeps what the person types in it.
  test("a save that lands after its editor was cancelled leaves the editor opened since open with what was typed",async({page,request})=>{
    const boot=await open(page,request);
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active");
      for(const [kind,placeholder,command] of [["action","Action name (e.g. Dev server)","Command (e.g. npm run dev)"],["hook","Hook name (e.g. Lint gate)","Command (e.g. npm run lint)"]]){
        const editor=card.locator(`.project-${kind}-editor`),name=editor.getByPlaceholder(placeholder),add=card.getByRole("button",{name:"Add "+kind,exact:true});
        hold.door=gate();const sent=hold.saves.length;
        await add.click();await name.click();await page.keyboard.type("Saved "+kind,{delay:10});
        await editor.getByPlaceholder(command).click();await page.keyboard.type("npm run saved",{delay:10});
        await editor.getByRole("button",{name:"Save "+kind,exact:true}).click();
        await expect.poll(()=>hold.saves.length).toBe(sent+1);
        await editor.getByRole("button",{name:"Cancel",exact:true}).click();await expect(editor).toHaveCount(0);
        await add.click();await name.click();await page.keyboard.type("Next "+kind,{delay:10});
        hold.door.open();
        await expect(card.locator(`.project-${kind}-row strong`).filter({hasText:"Saved "+kind})).toHaveCount(1);
        // The person refreshes the list. Refresh reads it after the save has, so what the save did as it ended is on screen by then.
        const listed=page.waitForResponse(response=>/\/api\/projects$/.test(response.url())&&response.request().method()==="GET");
        await page.getByRole("button",{name:"Refresh projects",exact:true}).click();await listed;await frames(page);
        await expect(editor,`the ${kind} editor opened after Cancel stays open`).toHaveCount(1);
        await expect(name).toHaveValue("Next "+kind);
        await editor.scrollIntoViewIfNeeded();
        await shootModes(page,`card-${kind}-editor-kept`,{show:editor});
        await editor.getByRole("button",{name:"Cancel",exact:true}).click();
      }
      expect(await savedNames(request,boot,"scripts")).toEqual(["Saved action"]);
      expect(await savedNames(request,boot,"hooks")).toEqual(["Saved hook"]);
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],hooks:[]}});
    }
  });

  // Timeout (seconds) takes 1 to 300: what is typed beyond them is held to the nearer one once the field is left, 0 as -5 is.
  test("a hook Timeout of 0 is held to the 1 s minimum, as -5 is held to 1 and 999 to 300, and the hook saves 1 s",async({page,request})=>{
    const boot=await open(page,request);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),editor=card.locator(".project-hook-editor"),timeout=editor.getByRole("spinbutton",{name:"Timeout (seconds)"});
      await card.getByRole("button",{name:"Add hook",exact:true}).click();
      await editor.getByPlaceholder("Hook name (e.g. Lint gate)").click();await page.keyboard.type("Quick hook",{delay:10});
      await editor.getByPlaceholder("Command (e.g. npm run lint)").click();await page.keyboard.type("npm run quick",{delay:10});
      for(const [typed,held] of [["-5","1"],["999","300"],["0","1"]]){
        await timeout.click();await page.keyboard.press("Control+A");await page.keyboard.type(typed,{delay:10});await page.keyboard.press("Tab");
        await expect(timeout,`Timeout (seconds) after ${typed} is typed and the field is left`).toHaveValue(held);
      }
      await shootModes(page,"card-hook-timeout-zero",{show:editor});
      await editor.getByRole("button",{name:"Save hook",exact:true}).click();
      await expect(editor).toHaveCount(0);
      const saved=async()=>((await listedProjects(request)).find(project=>project.path===boot.cwd)?.hooks||[]).map(hook=>[hook.name,hook.timeoutMs]);
      expect(await saved()).toEqual([["Quick hook",1000]]);
      // A 0 typed and Save hook clicked straight from the field saves 1 s too; the saved hook's editor shows it.
      await card.locator(".project-hook-row").getByRole("button",{name:"Edit hook",exact:true}).click();
      await expect(timeout).toHaveValue("1");
      await timeout.click();await page.keyboard.press("Control+A");await page.keyboard.type("30",{delay:10});await page.keyboard.press("Tab");
      await editor.getByRole("button",{name:"Save hook",exact:true}).click();await expect(editor).toHaveCount(0);
      await expect.poll(saved).toEqual([["Quick hook",30000]]);
      await card.locator(".project-hook-row").getByRole("button",{name:"Edit hook",exact:true}).click();
      await timeout.click();await page.keyboard.press("Control+A");await page.keyboard.type("0",{delay:10});
      await editor.getByRole("button",{name:"Save hook",exact:true}).click();await expect(editor).toHaveCount(0);
      await expect.poll(saved).toEqual([["Quick hook",1000]]);
    }finally{
      await request.post("/api/projects",{data:{path:boot.cwd,hooks:[]}});
    }
  });

  // The person saves a hook while the server is slow, goes to Usage and comes back before it answers, and waits. The page they come
  // back to shows the hook's editor still saving, as the one they left did, so Save hook pressed again sends nothing; once the save
  // lands, the editor closes and the card lists the hook, without a Refresh.
  test("a hook save that lands after the person left Projects and came back is listed on the card without Refresh, and its editor shows until then",async({page,request})=>{
    const boot=await open(page,request);
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),editor=card.locator(".project-hook-editor"),rows=card.locator(".project-hook-row strong");
      const name=editor.getByPlaceholder("Hook name (e.g. Lint gate)"),save=editor.getByRole("button",{name:"Save hook",exact:true}),saving=editor.locator("button.primary");
      await card.getByRole("button",{name:"Add hook",exact:true}).click();
      await name.click();await page.keyboard.type("Slow hook",{delay:10});
      await editor.getByPlaceholder("Command (e.g. npm run lint)").click();await page.keyboard.type("npm run slow",{delay:10});
      await save.click();
      await expect.poll(()=>hold.saves).toEqual(["hooks"]);
      await nav(page,"Usage").click();await expect(page.locator(".usage-page")).toBeVisible();
      const listed=page.waitForResponse(response=>/\/api\/projects$/.test(response.url())&&response.request().method()==="GET");
      await nav(page,"Projects").click();await listed;
      await expect(card).toBeVisible();await expect(rows,"the hook is not listed while its save is on its way").toHaveCount(0);
      await expect.soft(name,"the editor of the save on its way, with what was typed").toHaveValue("Slow hook");
      // Save hook says the save is on its way, as on the page it was pressed on, and pressed again it sends nothing.
      await expect(saving,"Save hook on the page come back to, while its save is on its way").toHaveText(/^\s*Saving…\s*$/);
      await expect(saving).toHaveAttribute("aria-disabled","true");
      await shootModes(page,"card-hook-saving-after-return",{show:editor});
      await saving.scrollIntoViewIfNeeded();await clickAt(page,saving);
      hold.door.open();
      await expect(rows,"the hook once its save has landed, with no Refresh").toHaveText(["Slow hook"]);
      await expect(editor,"the editor once its save has landed").toHaveCount(0);
      expect(await savedNames(request,boot,"hooks")).toEqual(["Slow hook"]);
      expect(hold.saves,"saves sent").toEqual(["hooks"]);
      await expect(page.locator(".projects-page").getByRole("alert")).toHaveCount(0);
      await shootModes(page,"card-hook-saved-after-return",{show:card.locator(".project-hooks")});
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,hooks:[]}});
    }
  });

  // The person saves a new action, sees a typo while the save is on its way and fixes it. Save action says it is saving, and pressed
  // then it sends nothing; once the first save lands the editor stays open with the fix, and Save then saves the fix into the action
  // the first save added, not a second one. The same for a hook.
  test("an action or hook changed while its save is on its way stays open with the change, and Save then updates what was saved",async({page,request})=>{
    const boot=await open(page,request);
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active");
      for(const [kind,listKey,placeholder,typo,fixed] of [["action","scripts","Action name (e.g. Dev server)","npm run dve","npm run dev"],["hook","hooks","Hook name (e.g. Lint gate)","npm run lnit","npm run lint"]]){
        const editor=card.locator(`.project-${kind}-editor`),rows=card.locator(`.project-${kind}-row strong`),save=editor.locator("button.primary");
        const name=editor.getByPlaceholder(placeholder),command=editor.getByPlaceholder(kind==="action"?"Command (e.g. npm run dev)":"Command (e.g. npm run lint)");
        hold.door=gate();const sent=hold.saves.length,label=kind==="action"?"Dev server":"Lint gate";
        await card.getByRole("button",{name:"Add "+kind,exact:true}).click();
        await name.click();await page.keyboard.type(label,{delay:10});
        await command.click();await page.keyboard.type(typo,{delay:10});
        await save.click();
        await expect.poll(()=>hold.saves.length).toBe(sent+1);
        // The fix, typed while the save is on its way: Save says it is saving and sends nothing.
        await command.click();await page.keyboard.press("Control+A");await page.keyboard.type(fixed,{delay:10});
        await expect.soft(save,`Save ${kind} while its save is on its way`).toHaveText(/^\s*Saving…\s*$/);
        await expect.soft(save).toHaveAttribute("aria-disabled","true");
        if(kind==="action")await shootModes(page,"card-action-saving-changed",{show:editor});
        await clickAt(page,save);
        hold.door.open();
        // The save has landed once the card lists it, and what it did to its editor is drawn a frame or two later.
        await expect(rows).toHaveText([label]);await frames(page);await frames(page);
        await expect(editor,`the ${kind} editor of a save that lands after it was changed`).toHaveCount(1);
        await expect(command,"the fix typed while it saved").toHaveValue(fixed);
        await expect(save).toHaveText(new RegExp(`^\\s*Save ${kind}\\s*$`));await expect(save).not.toHaveAttribute("aria-disabled","true");
        expect(hold.saves.length,"saves sent while the first was on its way").toBe(sent+1);
        await save.click();
        await expect(editor).toHaveCount(0);
        expect(hold.saves.length).toBe(sent+2);
        await expect(rows).toHaveText([label]);
        await expect.poll(async()=>((await listedProjects(request)).find(project=>project.path===boot.cwd)?.[listKey]||[]).map(item=>[item.name,item.command]),{message:`one ${kind}, with the fix`}).toEqual([[label,fixed]]);
      }
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],hooks:[]}});
    }
  });

  // An action and a hook already saved: Edit, a new command, Save; while that save is on its way, Cancel and Edit again on the same
  // row, whose editor shows the command from before the save, and only the name is changed there. Once the save lands that editor
  // shows the command saved, and saving it keeps that command instead of putting the old one back.
  test("an editor opened again on an action or hook while its save is on its way takes what was saved, so saving it keeps that change",async({page,request})=>{
    const boot=await open(page,request);
    await request.post("/api/projects",{data:{path:boot.cwd,scripts:[{id:"dev-action",name:"Dev",command:"npm run dev",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false}],preferredScriptId:"dev-action",hooks:[{id:"lint-hook",name:"Lint",event:"verification.required",command:"npm run lint",enabled:true,failureMode:"block",timeoutMs:30000,actions:[]}]}});
    const hold=await holdCardSaves(page);
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active");
      for(const [kind,listKey,placeholder,before,after,renamed] of [["action","scripts","Action name (e.g. Dev server)","npm run dev","npm run dev:fast","Dev fast"],["hook","hooks","Hook name (e.g. Lint gate)","npm run lint","npm run lint:strict","Lint strict"]]){
        const editor=card.locator(`.project-${kind}-editor`),row=card.locator(`.project-${kind}-row`).first(),edit=row.getByRole("button",{name:"Edit "+kind,exact:true}),save=editor.locator("button.primary");
        const name=editor.getByPlaceholder(placeholder),command=editor.getByPlaceholder(kind==="action"?"Command (e.g. npm run dev)":"Command (e.g. npm run lint)");
        hold.door=gate();const sent=hold.saves.length;
        await edit.click();await expect(command).toHaveValue(before);
        await command.click();await page.keyboard.press("Control+A");await page.keyboard.type(after,{delay:10});
        await save.click();
        await expect.poll(()=>hold.saves.length).toBe(sent+1);
        await editor.getByRole("button",{name:"Cancel",exact:true}).click();await expect(editor).toHaveCount(0);
        await edit.click();
        await expect(command,"the editor opened again shows the row as listed before the save lands").toHaveValue(before);
        await name.click();await page.keyboard.press("Control+A");await page.keyboard.type(renamed,{delay:10});
        hold.door.open();
        await expect(row,"the row once the save has landed").toContainText(after);
        await expect(command,`the ${kind} editor opened again takes the command saved`).toHaveValue(after);
        await expect(name,"and keeps the name typed in it").toHaveValue(renamed);
        if(kind==="action")await shootModes(page,"card-action-reopened-editor-rebased",{show:editor});
        await save.click();await expect(editor).toHaveCount(0);
        expect(hold.saves.length).toBe(sent+2);
        await expect.poll(async()=>((await listedProjects(request)).find(project=>project.path===boot.cwd)?.[listKey]||[]).map(item=>[item.name,item.command]),{message:`the ${kind} saved from the editor opened again`}).toEqual([[renamed,after]]);
      }
    }finally{
      hold.door.open();await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],hooks:[]}});
    }
  });

  // The person saves a hook while the server is slow and goes to Usage; the save fails while they are there. Back on Projects the card
  // says why, beside the hook's editor with what was typed, so the hook can be saved again.
  test("a hook save that fails while the person is on another page is said on the card when they come back, beside its editor",async({page,request})=>{
    const boot=await open(page,request);
    const door=gate(),saves=[];
    await page.route(/\/api\/projects$/,async route=>{
      const body=route.request().method()==="POST"?route.request().postDataJSON():null;
      if(!body?.hooks)return route.fallback();
      saves.push(body.hooks.map(hook=>hook.name));await door.promise;
      return saves.length===1?json(route,{error:"Deliberate hook save failure"},500):route.fallback();
    });
    try{
      await openProjects(page);
      const card=page.locator(".project-card.active"),editor=card.locator(".project-hook-editor"),rows=card.locator(".project-hook-row strong"),alert=card.locator(".project-hooks").getByRole("alert");
      const name=editor.getByPlaceholder("Hook name (e.g. Lint gate)"),command=editor.getByPlaceholder("Command (e.g. npm run lint)"),save=editor.locator("button.primary");
      await card.getByRole("button",{name:"Add hook",exact:true}).click();
      await name.click();await page.keyboard.type("Failing hook",{delay:10});
      await command.click();await page.keyboard.type("npm run failing",{delay:10});
      await save.click();
      await expect.poll(()=>saves.length).toBe(1);
      await nav(page,"Usage").click();await expect(page.locator(".usage-page")).toBeVisible();
      const failed=page.waitForResponse(response=>/\/api\/projects$/.test(response.url())&&response.request().method()==="POST");
      door.open();await failed;await frames(page);await page.waitForTimeout(300);
      await nav(page,"Projects").click();
      await expect(alert,"the failure, on the card the person comes back to").toHaveText("Deliberate hook save failure");
      await expect(name,"the hook's editor, with what was typed").toHaveValue("Failing hook");await expect(command).toHaveValue("npm run failing");
      await expect(save).toHaveText(/^\s*Save hook\s*$/);await expect(save).not.toHaveAttribute("aria-disabled","true");
      await expect(rows).toHaveCount(0);
      await shootModes(page,"card-hook-failed-while-away",{show:editor});
      await save.click();
      await expect(rows).toHaveText(["Failing hook"]);await expect(editor).toHaveCount(0);await expect(alert).toHaveCount(0);
      expect(saves).toEqual([["Failing hook"],["Failing hook"]]);
    }finally{door.open();await request.post("/api/projects",{data:{path:boot.cwd,hooks:[]}})}
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

  // A card is drawn again, Name field and all, when Git answers and it moves into its repository's group, led by a checkout listed
  // before it. A name on its way when that happens is still the field's name, so Escape and leaving the field keep it.
  test("a name on its way stays in the Name field when the card moves into its repository's group",async({page,request})=>{
    const boot=await open(page,request);
    await leadingCheckout(request,boot);
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
  // in its repository's group, led by a checkout listed before it: the field still has the keyboard, the text typed so far and the
  // caret where it was. So does a field of the card's action editor. Nothing is saved until the person saves it.
  for(const mode of MODES)test(`a field being typed in keeps its text, caret and focus when the card moves into its repository's group (${mode})`,async({page,request})=>{
    const boot=await open(page,request,{mode});
    await leadingCheckout(request,boot);
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

    // A field of the action editor, which keeps its text on the page, keeps the keyboard and its caret too. The rename made the main
    // project the one opened last, so the other checkout is opened again to lead the list.
    hold();
    await leadingCheckout(request,boot);
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
    expect(await general.evaluate(node=>getComputedStyle(node).cursor),"the starting card keeps its progress pointer, not a disabled button's arrow").toBe("progress");
    await expect(clone,"Clone while the General chat starts").toHaveText("Clone");
    await page.screenshot({animations:"disabled",path:shots+`general-chat-starting-${mode}-1280.png`});
    releaseStart();
    await expect(page.locator(".projects-page")).toHaveCount(0);
  });
});

test.describe("A choice made while Trebell is still starting",()=>{
  // Trebell's first read of its saved state is held back, as on a slow start, while the person makes a choice: that read names
  // the project open before, and once it lands the choice the person made stays.
  async function startHeld(page,request){
    await page.setViewportSize({width:1280,height:800});
    await request.post("/api/settings",{data:BASE});
    const boot=await (await request.get("/api/bootstrap")).json();
    await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,activate:true}});
    let release;const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/state$/,async route=>{const response=await route.fetch();await held;return route.fulfill({response})},{times:1});
    return {boot,release};
  }
  const crumbOf=page=>page.locator("header.workspace-header").first().locator(".project-crumb:not(.sidebar-reopen) span");
  // Dark and light at 1280 and 900 wide, switched with the header's appearance toggle as a person switches them.
  async function toggledShots(page,name){
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      for(const mode of MODES){
        if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
        await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
        await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-${width}.png`});
      }
    }
    await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    await page.setViewportSize({width:1280,height:800});
  }

  test("a project opened before the start-up lands stays open",async({page,request})=>{
    const {boot,release}=await startHeld(page,request);
    await request.post("/api/projects",{data:{path:join(boot.cwd,"ui"),name:"Picked Project"}});
    await page.goto("/");
    const composer=page.getByTestId("composer"),crumb=crumbOf(page);
    await expect(composer).toHaveAttribute("placeholder","Starting Trebell Code…");
    await openProjects(page);
    await projectCard(page,"Picked Project").locator(".project-open").click();
    await expect(crumb).toHaveText("Picked Project");
    await expect(composer,"Trebell is still starting").toHaveAttribute("placeholder","Starting Trebell Code…");
    release();
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await expect(crumb,"the project the person opened").toHaveText("Picked Project");
    expect(await nextStartProject(request),"the project the next start opens").toBe("Picked Project");
    await toggledShots(page,"project-opened-while-starting");
  });

  test("a project whose open is still on its way when the start-up lands is the one left open",async({page,request})=>{
    const {boot,release}=await startHeld(page,request);
    await request.post("/api/projects",{data:{path:join(boot.cwd,"ui"),name:"Picked Project"}});
    // The open's own request is held as well, before it reaches Trebell: the start-up lands first, with the project its state names,
    // and the person's open answers after it.
    let answer;const answered=new Promise(resolve=>{answer=resolve});const opens=[];
    await page.route(/\/api\/projects$/,async route=>{
      if(route.request().method()!=="POST"||opens.length)return route.fallback();
      opens.push(route.request().postDataJSON());await answered;return route.fallback();
    });
    await page.goto("/");
    const composer=page.getByTestId("composer"),crumb=crumbOf(page);
    await expect(composer).toHaveAttribute("placeholder","Starting Trebell Code…");
    await openProjects(page);
    await projectCard(page,"Picked Project").locator(".project-open").click();
    await expect.poll(()=>opens.length,{message:"the open was sent"}).toBe(1);
    expect(opens[0]).toMatchObject({path:join(boot.cwd,"ui"),activate:true});
    release();
    await expect(projectCard(page,MAIN),"the start-up landed with the project its state names").toHaveClass(/\bactive\b/);
    answer();
    await expect(crumb,"the project the person opened").toHaveText("Picked Project");
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await page.waitForTimeout(300);
    await expect(crumb,"still the project the person opened").toHaveText("Picked Project");
    await nav(page,"Projects").click();
    await expect(projectCard(page,"Picked Project"),"the open project's card").toHaveClass(/\bactive\b/);
    await expect(projectCard(page,MAIN)).not.toHaveClass(/\bactive\b/);
    expect(await nextStartProject(request),"the project the next start opens").toBe("Picked Project");
    await nav(page,"New task").click();
    await toggledShots(page,"project-open-answered-after-start-up");
  });

  test("a project removed before the start-up lands stays removed, and the window opens the project left",async({page,request})=>{
    const {boot,release}=await startHeld(page,request);
    await request.post("/api/projects",{data:{path:join(boot.cwd,"ui"),name:"Kept Project"}});
    await page.goto("/");
    const composer=page.getByTestId("composer"),crumb=crumbOf(page);
    await expect(composer).toHaveAttribute("placeholder","Starting Trebell Code…");
    await openProjects(page);
    await page.getByRole("button",{name:"Remove "+MAIN,exact:true}).click();
    await expect(projectCard(page,MAIN)).toHaveCount(0);
    await expect.poll(async()=>(await listedProjects(request)).some(project=>project.name===MAIN),{message:"the server removed it"}).toBe(false);
    release();
    await nav(page,"New task").click();
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await expect(crumb,"the project the window opens").toHaveText("Kept Project");
    await nav(page,"Projects").click();
    await expect(projectCard(page,"Kept Project")).toBeVisible();
    await expect(projectCard(page,MAIN),"the removed project's card").toHaveCount(0);
    await toggledShots(page,"project-removed-while-starting");
  });

  test("the mode switched with the header's button before the start-up lands stays, in the window and saved",async({page,request})=>{
    const {release}=await startHeld(page,request);
    await page.goto("/");
    const html=page.locator("html");
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Starting Trebell Code…");
    await expect(html).toHaveAttribute("data-mode","dark");
    await page.getByTestId("appearance-toggle").first().click();
    await expect(html).toHaveAttribute("data-mode","light");
    await expect.poll(async()=>(await (await request.get("/api/settings")).json()).appearanceMode,{message:"the mode saved"}).toBe("light");
    release();
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await page.waitForTimeout(300);
    await expect(html,"the mode the person chose").toHaveAttribute("data-mode","light");
    await toggledShots(page,"mode-switched-while-starting");
  });

  test("the permission and workspace modes picked in the composer before the start-up lands stay",async({page,request})=>{
    const {release}=await startHeld(page,request);
    await page.goto("/");
    const composer=page.getByTestId("composer"),permission=page.locator("select.permission-picker").first(),workspace=page.locator("select.workspace-mode");
    await expect(composer).toHaveAttribute("placeholder","Starting Trebell Code…");
    await expect(permission).toHaveValue("supervised");await expect(workspace).toHaveValue("current");
    await permission.selectOption({label:"Read only"});await workspace.selectOption({label:"New worktree"});
    release();
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await page.waitForTimeout(300);
    await expect(permission,"the permission mode the person picked").toHaveValue("read-only");
    await expect(workspace,"the workspace mode the person picked").toHaveValue("worktree");
    await toggledShots(page,"modes-picked-while-starting");
  });

  test("a General chat started before the start-up lands keeps its own folder",async({page,request})=>{
    const {release}=await startHeld(page,request);
    await page.goto("/");
    const composer=page.getByTestId("composer"),crumb=crumbOf(page);
    await expect(composer).toHaveAttribute("placeholder","Starting Trebell Code…");
    await openProjects(page);
    const started=page.waitForResponse(response=>response.url().endsWith("/api/general-workspace")&&response.request().method()==="POST");
    await page.locator(".general-chat-card").click();
    const folder=(await (await started).json()).path;
    await expect(crumb).toHaveText("No project");
    release();
    await expect(page.getByTestId("model-picker"),"the start-up has landed").toBeEnabled({timeout:15_000});
    await expect(crumb).toHaveText("No project");
    // A terminal opened now starts in the General chat's folder (the mock server has none, so the page's requests are answered here).
    await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>{
      if(route.request().method()!=="POST")return json(route,{sessions:[]});
      const {cwd}=route.request().postDataJSON()||{};
      return json(route,{session:{id:"general-terminal",name:"Terminal 1",cwd,running:true,createdAt:Date.now()}});
    });
    await page.getByTestId("terminal-toggle").click();
    const drawer=page.getByTestId("drawer");
    await drawer.getByRole("button",{name:"Create terminal"}).click();
    await expect(drawer.locator(".terminal-foot"),"the terminal's folder").toContainText(folder);
  });
});

test.describe("A project default changed while the project is open",()=>{
  // The person is in the project, changes its Permissions and Workspace on Projects, then starts a New task: the new task uses them
  // at once, as a project opened after the change does, with no reload. Inherit gives the defaults back the same way, and a change
  // that is not a default (the icon) leaves a mode the person picked in the composer.
  test("reaches New task at once, and Inherit gives the default back",async({page,request})=>{
    await page.setViewportSize({width:1280,height:800});
    await request.post("/api/settings",{data:{...BASE,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"}});
    const boot=await (await request.get("/api/bootstrap")).json();
    await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,activate:true,permissionMode:null,workspaceMode:null}});
    try{
      await page.goto("/");
      await expect(page.getByTestId("composer")).toBeVisible();
      const permission=page.locator(".composer-wrap select.permission-picker").filter({has:page.locator("option[value='read-only']")}),workspace=page.locator(".composer-wrap select.workspace-mode");
      await expect(permission).toHaveValue("supervised");
      await expect(workspace).toHaveValue("current");
      const card=page.locator(".project-card.active");
      const saved=()=>page.waitForResponse(response=>response.url().endsWith("/api/projects")&&response.request().method()==="POST");
      const choose=async(name,value)=>{const answer=saved();await card.getByRole("combobox",{name}).selectOption(value);await answer;await expect(card.getByRole("combobox",{name})).toHaveValue(value)};
      const model=page.getByTestId("model-picker");
      await expect(model).toContainText(/coding.fast/i);
      await openProjects(page);
      await choose("Permissions","read-only");
      await choose("Workspace","worktree");
      await choose("Model","test/coding-large");
      await nav(page,"New task").click();
      await expect(permission,"the new task's permissions").toHaveValue("read-only");
      await expect(workspace,"the new task's workspace").toHaveValue("worktree");
      await expect(model,"the new task's model").toContainText(/coding.large/i);
      await shootModes(page,"project-default-reaches-new-task",{show:permission});
      // A mode picked in the composer stays when the project changes something else.
      await permission.selectOption("edits");
      await openProjects(page);
      await card.getByRole("button",{name:/Project identity/}).click();
      const iconSaved=saved();await card.getByRole("button",{name:"Automatic",exact:true}).click();await iconSaved;
      await nav(page,"New task").click();
      await expect(permission,"a pick in the composer stays after an icon change").toHaveValue("edits");
      // Inherit takes the overrides away: the defaults come back for the next new task.
      await openProjects(page);
      await choose("Permissions","");
      await choose("Workspace","");
      await nav(page,"New task").click();
      await expect(permission).toHaveValue("supervised");
      await expect(workspace).toHaveValue("current");
    }finally{
      await request.post("/api/projects",{data:{path:boot.cwd,permissionMode:null,workspaceMode:null,defaultModel:null}});
    }
  });
});
