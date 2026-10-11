import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The command palette from the keyboard: keys typed straight after Ctrl+K, and where focus goes after a command.
const shots=fileURLToPath(new URL("../../visual-audit/polish/palette-navigation/",import.meta.url));mkdirSync(shots,{recursive:true});
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai",keybindingRules:[]};
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const projectsHeading=page=>page.getByRole("heading",{name:"Projects",level:1});
const usageHeading=page=>page.getByRole("heading",{name:"Usage",exact:true});
const settingsHeading=page=>page.getByRole("heading",{name:"Settings",level:1});

async function open(page,request,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Palette Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  return boot;
}
test.afterEach(async({request})=>{await request.post("/api/settings",{data:BASE})});

// Holds the palette's code (or a page's) until release(), as a slow network would, so the keys typed meanwhile can be checked.
async function holdChunk(page,name){
  let release;const held=new Promise(resolve=>{release=resolve});
  await page.route(new RegExp("/assets/"+name+"-[^/]+\\.js$"),async route=>{await held;await route.continue()});
  return release;
}
const activeInfo=page=>page.evaluate(()=>{
  const el=document.activeElement;if(!el||el===document.body)return {tag:"body",text:"",inPage:false};
  return {tag:el.tagName.toLowerCase(),text:(el.getAttribute("aria-label")||el.textContent||"").trim().slice(0,40),inPage:Boolean(el.closest(".secondary-page")),testid:el.getAttribute("data-testid")||""};
});

test.describe("Command palette keys",()=>{
  test("keys typed straight after Ctrl+K in the composer land in the search, first open and later, and leave the draft alone",async({page,request})=>{
    await open(page,request);
    const composer=page.getByTestId("composer"),palette=page.getByTestId("command-palette");
    await composer.fill("my draft");
    const release=await holdChunk(page,"CommandPalette");
    const seen=[];
    for(const round of ["first open","later open"]){
      await composer.click();
      await page.keyboard.press("Control+K");
      if(round==="first open"){
        await page.keyboard.type("us",{delay:30});
        await expect(palette).toBeVisible();
        await page.screenshot({animations:"disabled",path:shots+"palette-loading-typed-dark-1280.png"});
        release();
        await page.keyboard.type("age",{delay:30});
      }else await page.keyboard.type("usage",{delay:30});
      await expect(palette.locator(".command-palette-item").first()).toBeVisible();
      await page.waitForTimeout(250);
      seen.push({round,query:await palette.getByRole("textbox").inputValue()});
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await expect(composer).toBeFocused();
      seen.push({round,composer:await composer.inputValue()});
    }
    expect(seen).toEqual([
      {round:"first open",query:"usage"},{round:"first open",composer:"my draft"},
      {round:"later open",query:"usage"},{round:"later open",composer:"my draft"},
    ]);
  });

  test("keys typed straight after Ctrl+K from the page body land in the search, first open and later",async({page,request})=>{
    await open(page,request);
    const palette=page.getByTestId("command-palette");
    await nav(page,"Projects").click();
    await expect(projectsHeading(page)).toBeVisible();
    const queries=[];
    for(let round=0;round<3;round++){
      await page.evaluate(()=>document.activeElement?.blur?.());
      await page.keyboard.press("Control+K");
      await page.keyboard.type("usage",{delay:30});
      await expect(palette).toBeVisible();
      await page.waitForTimeout(250);
      queries.push(await palette.getByRole("textbox").inputValue());
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await page.waitForTimeout(200);
    }
    expect(queries).toEqual(["usage","usage","usage"]);
  });

  test("the palette shown while its code loads looks like the palette, and Escape there closes it",async({page,request})=>{
    for(const [mode,width] of [["dark",1280],["light",1280],["dark",900],["light",900]]){
      await open(page,request,{mode,width});
      const release=await holdChunk(page,"CommandPalette");
      const composer=page.getByTestId("composer"),palette=page.getByTestId("command-palette");
      await composer.click();
      await page.keyboard.press("Control+K");
      await page.keyboard.type("us",{delay:30});
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("textbox")).toHaveValue("us");
      await expect(palette.getByRole("textbox")).toBeFocused();
      await expect(palette.getByRole("status")).toHaveText("Loading commands…");
      const box=await palette.locator(".command-palette").boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({animations:"disabled",path:shots+`palette-loading-${mode}-${width}.png`});
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("");
      release();
      await page.unroute(/\/assets\/CommandPalette-/);
    }
  });
});

test.describe("Focus after a palette command",()=>{
  test("a command that opens another page leaves focus on that page's heading, and Tab carries on inside the page",async({page,request})=>{
    await open(page,request);
    const palette=page.getByTestId("command-palette");
    await page.getByTestId("composer").click();
    await page.keyboard.press("Control+K");
    await expect(palette.locator(".command-palette-item").first()).toBeVisible();
    await page.keyboard.type("usage");
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(usageHeading(page)).toBeVisible();
    await expect(usageHeading(page)).toBeFocused();
    await page.screenshot({animations:"disabled",path:shots+"palette-command-usage-focus-dark-1280.png"});
    await page.keyboard.press("Tab");
    const next=await activeInfo(page);
    expect(next.inPage,"Tab after the command goes to a control in the Usage page: "+JSON.stringify(next)).toBe(true);
    await page.screenshot({animations:"disabled",path:shots+"palette-command-usage-next-tab-dark-1280.png"});
  });

  test("a command that opens a page with an App title focuses that title",async({page,request})=>{
    await open(page,request);
    const palette=page.getByTestId("command-palette");
    for(const [query,heading] of [["recent projects",projectsHeading(page)],["settings",settingsHeading(page)]]){
      await nav(page,"New task").click();
      await page.getByTestId("composer").click();
      await page.keyboard.press("Control+K");
      await expect(palette.locator(".command-palette-item").first()).toBeVisible();
      await page.keyboard.type(">"+query);
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();
      await expect(heading).toBeFocused();
    }
  });

  test("a page that is still loading gets focus on its heading once it shows",async({page,request})=>{
    await open(page,request,{mode:"light"});
    const palette=page.getByTestId("command-palette");
    await page.getByTestId("composer").click();
    await page.keyboard.press("Control+K");
    await expect(palette.locator(".command-palette-item").first()).toBeVisible();
    const release=await holdChunk(page,"UsagePage");
    await page.keyboard.type("usage");
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator(".secondary-page .surface-loading")).toBeVisible();
    await page.waitForTimeout(300);
    release();
    await expect(usageHeading(page)).toBeFocused();
    await page.screenshot({animations:"disabled",path:shots+"palette-command-usage-focus-light-1280.png"});
    await page.keyboard.press("Tab");
    expect((await activeInfo(page)).inPage).toBe(true);
    await page.screenshot({animations:"disabled",path:shots+"palette-command-usage-next-tab-light-1280.png"});
  });

  test("a command that keeps the view gives focus back to where it was",async({page,request})=>{
    await open(page,request);
    const composer=page.getByTestId("composer"),palette=page.getByTestId("command-palette");
    await composer.click();
    await page.keyboard.press("Control+K");
    await expect(palette.locator(".command-palette-item").first()).toBeVisible();
    await page.keyboard.type("appearance: dark");
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(composer).toBeFocused();
  });
});
