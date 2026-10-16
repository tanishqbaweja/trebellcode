import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
const NO_REPOSITORY="General chats do not have Git or repository changes.";
// Two frames on: the page has drawn what it was last given, and has done what React does once it is drawn (its effects).
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve)))));

async function prepare(page,request){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Right Panel Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeEnabled({timeout:10_000});
}

test("the header toggle and Ctrl+Alt+B both reopen the right panel on the tab it was closed on",async({page,request})=>{
  await prepare(page,request);
  const panel=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle").first(),browser=panel.getByRole("button",{name:"Browser",exact:true});
  await toggle.click();
  await expect(panel).toBeVisible();
  await browser.click();
  await expect(browser).toHaveClass(/active/);
  await toggle.click();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(browser,"reopened by the header toggle").toHaveClass(/active/);
  await page.keyboard.press("Control+Alt+B");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(browser,"closed by the shortcut, reopened by the header toggle").toHaveClass(/active/);
  await toggle.click();
  await page.keyboard.press("Control+Alt+B");
  await expect(browser,"closed by the header toggle, reopened by the shortcut").toHaveClass(/active/);
  // In each mode and width the panel is closed, the mode switched with the header toggle and the panel reopened from the header.
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light","dark"]){
      if(await panel.isVisible())await panel.getByRole("button",{name:"Close right panel"}).click();
      await expect(panel).toBeHidden();
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await toggle.click();
      await expect(browser).toHaveClass(/active/);
      await page.screenshot({animations:"disabled",path:auditDir+"right-panel-reopened-on-last-tab-"+mode+"-"+width+".png"});
    }
  }
});

test("in a General chat Changes and Git say once, beside the conversation, that there is no repository",async({page,request})=>{
  await prepare(page,request);
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.getByRole("button",{name:/No project · General chat/}).click();
  await expect(page.getByText("This is a General chat with no attached project.")).toBeVisible();
  await page.getByTestId("composer").click();
  for(let press=0;press<3;press++)await page.keyboard.press("Control+D");
  await page.keyboard.press("Control+Shift+G");
  const notice=page.getByTestId("app-action-error");
  await expect(notice).toContainText(NO_REPOSITORY);
  await expect(page.getByText(NO_REPOSITORY,{exact:false}),"said once").toHaveCount(1);
  await expect(page.getByText(/Trebell Agent Activity/i),"the conversation does not grow").toHaveCount(0);
  await expect(page.getByTestId("right-panel")).toBeHidden();
  // The notice goes after a few seconds, so each screenshot asks for Changes again: still one notice, still no rows.
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.getByTestId("composer").click();await page.keyboard.press("Control+D");
      await expect(notice).toContainText(NO_REPOSITORY);
      await page.screenshot({animations:"disabled",path:auditDir+"right-panel-general-chat-no-repository-"+mode+"-"+width+".png"});
    }
    await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
  }
  await expect(page.getByText(/Trebell Agent Activity/i)).toHaveCount(0);
  // The header toggle still opens the panel, on the tab the General chat left it on.
  await page.getByTestId("right-panel-toggle").first().click();
  await expect(page.getByTestId("right-panel").getByRole("button",{name:"Runtime",exact:true})).toHaveClass(/active/);
});

test("a slow Context search in the project just left lists nothing in the Context tab of the project opened",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const {project:neighbour}=await (await request.post("/api/projects",{data:{path:join(boot.cwd,"docs"),name:"Right Panel Neighbour"}})).json();
  // The symbol search, answered per project: the workspace's answer waits until it is let through (a slow index).
  const folder=path=>String(path||"").replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase();
  let letThrough=null;
  await page.route(/\/api\/context\/symbols\?/,async route=>{
    const params=new URL(route.request().url()).searchParams,workspace=folder(params.get("path"))===folder(boot.cwd);
    if(workspace)await new Promise(resolve=>{letThrough=resolve});
    const symbol=workspace?{path:"src/workspace-service.js",name:"WorkspaceService"}:{path:"neighbour-service.js",name:"NeighbourService"};
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({query:params.get("q"),indexedFiles:1,data:[{...symbol,kind:"class",line:1,signature:"export class "+symbol.name,parser:"babel",score:100}]})}).catch(()=>{});
  });
  try{
    await prepare(page,request);
    await page.getByTestId("right-panel-toggle").first().click();
    const panel=page.getByTestId("right-panel");
    await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Context",exact:true}).click();
    const explorer=panel.getByTestId("context-explorer"),box=explorer.getByLabel("Search repository symbols");
    // The person searches the workspace's symbols with Enter, and opens the neighbour project from Projects while it is on its way.
    await box.click();await page.keyboard.type("Service",{delay:15});await page.keyboard.press("Enter");
    await expect(explorer.getByRole("button",{name:"Searching…",exact:true})).toBeDisabled();
    await expect.poll(()=>Boolean(letThrough)).toBe(true);
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator("button.project-open").filter({hasText:"Right Panel Neighbour"}).click();
    await expect(page.locator(".workspace-header")).toContainText("Right Panel Neighbour");
    await expect(box).toHaveValue("");
    // The workspace's answer lands.
    const landed=page.waitForResponse(response=>response.url().includes("/api/context/symbols?"));
    letThrough();await (await landed).finished();await painted(page);
    await expect(explorer.getByRole("button",{name:/WorkspaceService/}),"the search in the project left listed its results in the project opened").toHaveCount(0);
    await expect(explorer.locator(".context-explorer-results,.context-explorer-empty,.context-explorer-error")).toHaveCount(0);
    await expect(explorer.getByRole("button",{name:"Search",exact:true})).toBeDisabled();
    // The theme button is pressed at 1280, as at 900 the open panel lies over the header.
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await explorer.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"right-panel-context-project-switch-"+mode+"-"+width+".png"})}
    }
    await page.setViewportSize({width:1280,height:800});
    await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    // A search of the neighbour's own lists its own symbol.
    await box.click();await page.keyboard.type("Service",{delay:15});await page.keyboard.press("Enter");
    await expect(explorer.getByRole("button",{name:/NeighbourService/})).toContainText("class · neighbour-service.js:1");
  }finally{letThrough?.();await request.delete("/api/projects?id="+encodeURIComponent(neighbour.id))}
});
