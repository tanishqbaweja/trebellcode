import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
const NO_REPOSITORY="General chats do not have Git or repository changes.";

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
