import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Settings used the way a person uses it, with the server behind it: shortcuts typed into Settings > Shortcuts, two commands on
// one key, the section Settings comes back to, the Appearance choices, and the storage card when its requests fail.
const shots=fileURLToPath(new URL("../../visual-audit/polish/settings-shortcuts/",import.meta.url));mkdirSync(shots,{recursive:true});
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const section=(page,label)=>page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:new RegExp("^"+label.replace("&","\\&"))});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const saved=async request=>(await (await request.get("/api/state")).json()).settings;
const savedRule=async(request,command)=>((await saved(request)).keybindingRules||[]).find(rule=>rule.command===command);
const MAIN="Shortcuts Workspace";
const MODES=["dark","light"];
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai",followUpMode:"queue",keybindingRules:[],storageCleanup:{attachmentsAfterDays:null,terminalHistoryAfterDays:null},customThemes:[],environmentThemeSelections:{}};
// The harness list is a fixture, so Settings never probes this machine's real CLIs.
const RUNTIMES={selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[{id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true}]};

async function open(page,request,{mode="dark",width=1280,height=800,scripts=null}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,activate:true,...(scripts?{scripts}:{})}});
  await page.route(/\/api\/agent-runtimes$/,route=>json(route,RUNTIMES));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  return boot;
}
async function openShortcuts(page){
  await nav(page,"Settings").click();
  await section(page,"Shortcuts").click();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
}
const row=(page,label)=>page.locator(".keybinding-row").filter({has:page.locator("strong",{hasText:new RegExp("^"+label+"$")})});
const keyField=(page,label)=>row(page,label).locator("input").nth(0);
const whenField=(page,label)=>row(page,label).locator("input").nth(1);
// Typed the way a person types: click the field, select what is there, then type the new text key by key.
async function retype(field,text){await field.click();await field.press("ControlOrMeta+A");await field.pressSequentially(text,{delay:15})}
const sidebarCollapsed=async page=>/sidebar-collapsed/.test(await page.locator(".app-shell").getAttribute("class"));
const sideways=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
// Every keybinding save the page sends, in order.
function keybindingSaves(page){
  const saves=[];
  page.on("request",item=>{if(item.method()==="POST"&&/\/api\/settings$/.test(item.url())){const body=item.postDataJSON();if(body&&"keybindingRules" in body)saves.push(body.keybindingRules)}});
  return saves;
}

// The mock server keeps settings and projects for the whole run: each test leaves the defaults and a main project with no actions.
test.afterEach(async({request})=>{
  await request.post("/api/settings",{data:BASE});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,scripts:[]}});
});

test.describe("Typing a shortcut",()=>{
  for(const mode of MODES)test(`an unfinished shortcut is refused and the saved one keeps working (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const saves=keybindingSaves(page);
    await openShortcuts(page);
    const sidebarRow=row(page,"Toggle main sidebar");
    const field=keyField(page,"Toggle main sidebar");
    // Ctrl+B toggles the sidebar before anything is changed.
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);

    await retype(field,"Ctrl+");
    expect(saves,"nothing is saved while a shortcut is being typed").toEqual([]);
    await field.press("Tab");
    const message=sidebarRow.getByRole("alert");
    await expect(message).toHaveText("Add a key after “Ctrl+”. Until then the shortcut stays Ctrl+B.");
    await expect(field).toHaveAttribute("aria-invalid","true");
    await expect(field).toHaveAccessibleDescription(/Add a key after “Ctrl\+”/);
    await expect(field).toHaveValue("Ctrl+");
    expect(saves,"an unfinished shortcut is never saved").toEqual([]);
    expect((await savedRule(request,"sidebarToggle"))?.key??"Ctrl+B").toBe("Ctrl+B");
    await page.screenshot({animations:"disabled",path:shots+`shortcut-unfinished-${mode}-1280.png`});
    await page.setViewportSize({width:900,height:800});
    await sidebarRow.scrollIntoViewIfNeeded();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.screenshot({animations:"disabled",path:shots+`shortcut-unfinished-${mode}-900.png`});
    await page.setViewportSize({width:1280,height:800});

    // The saved Ctrl+B still works.
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);

    // A modifier that does not exist is refused too: the matcher would drop it and answer to a bare B.
    await retype(field,"Ctlr+B");
    await field.press("Tab");
    await expect(message).toHaveText("“Ctlr” is not a modifier key. Use Ctrl, Alt, Shift or Mod. Until then the shortcut stays Ctrl+B.");
    expect(saves).toEqual([]);

    // A finished shortcut saves once, on Enter, and works at once.
    await retype(field,"Ctrl+Shift+B");
    await expect(message,"the message goes as soon as the shortcut is fixed").toHaveCount(0);
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"sidebarToggle"))?.key).toBe("Ctrl+Shift+B");
    await expect(field).not.toHaveAttribute("aria-invalid","true");
    expect(saves.length,"one save for the finished shortcut").toBe(1);
    await sidebarRow.locator("strong").click();
    await expect(field).toHaveValue("Ctrl+Shift+B");
    await page.keyboard.press("Control+Shift+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+Shift+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);

    // Escape gives up an edit and shows the saved shortcut again; leaving the field then saves nothing.
    await retype(field,"Ctrl+");
    await field.press("Escape");
    await expect(field).toHaveValue("Ctrl+Shift+B");
    await field.press("Tab");
    await expect(field).not.toHaveAttribute("aria-invalid","true");
    await expect(message).toHaveCount(0);
    expect(saves.length).toBe(1);
  });

  for(const mode of MODES)test(`an unfinished condition is refused and the shortcut keeps working (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const saves=keybindingSaves(page);
    await openShortcuts(page);
    const sidebarRow=row(page,"Toggle main sidebar");
    const field=whenField(page,"Toggle main sidebar");
    await retype(field,"!modalOpen &&");
    await field.press("Tab");
    const message=sidebarRow.getByRole("alert");
    await expect(message).toHaveText("Add a context after “&&”. Until then the saved condition is used.");
    await expect(field).toHaveAttribute("aria-invalid","true");
    await expect(field).toHaveAccessibleDescription(/Add a context after “&&”/);
    expect(saves,"an unfinished condition is never saved").toEqual([]);
    await page.screenshot({animations:"disabled",path:shots+`condition-unfinished-${mode}-1280.png`});
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);

    await retype(field,"!modalOpen && (projectOpen");
    await field.press("Tab");
    await expect(message).toHaveText("Add a “)” to close the condition. Until then the saved condition is used.");
    expect(saves).toEqual([]);

    // A finished condition saves once.
    await retype(field,"!modalOpen && projectOpen");
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"sidebarToggle"))?.when).toBe("!modalOpen && projectOpen");
    await expect(field).not.toHaveAttribute("aria-invalid","true");
    await expect(message).toHaveCount(0);
    expect(saves.length).toBe(1);
  });
});

test.describe("Two commands on one key",()=>{
  test("the shipped shortcuts show no clash",async({page,request})=>{
    await open(page,request);
    await openShortcuts(page);
    await expect(page.locator(".keybinding-row")).toHaveCount(61);
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(0);
    await expect(page.locator(".keybindings-settings")).not.toContainText("runs instead");
  });

  for(const mode of MODES)test(`a shortcut another command takes over says which one runs instead (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await openShortcuts(page);
    const chip=page.getByRole("button",{name:"New task",exact:true});
    await expect(chip.locator("kbd")).toHaveText("Ctrl+N");
    const field=keyField(page,"New thread");
    await retype(field,"Ctrl+K");
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"newChat"))?.key).toBe("Ctrl+K");
    const lost=row(page,"New thread").getByRole("status");
    await expect(lost).toHaveText("Command palette also uses Ctrl+K and runs instead.");
    await expect(field).toHaveAccessibleDescription("Command palette also uses Ctrl+K and runs instead.");
    await expect(row(page,"Command palette").getByRole("status")).toHaveText("Takes Ctrl+K from New thread.");
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(2);
    // The sidebar stops offering Ctrl+K for New task: Ctrl+K opens the command palette.
    await expect(chip.locator("kbd")).toHaveCount(0);
    await expect(chip).not.toHaveAttribute("aria-keyshortcuts",/./);
    await page.screenshot({animations:"disabled",path:shots+`shortcut-clash-${mode}-1280.png`});
    await page.setViewportSize({width:900,height:800});
    await row(page,"New thread").scrollIntoViewIfNeeded();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.screenshot({animations:"disabled",path:shots+`shortcut-clash-${mode}-900.png`});
    await page.setViewportSize({width:1280,height:800});
    await row(page,"New thread").locator("strong").click();
    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();

    // A key of its own clears both notes, and the sidebar shows it again.
    await retype(field,"Ctrl+Alt+N");
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"newChat"))?.key).toBe("Ctrl+Alt+N");
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(0);
    await expect(chip.locator("kbd")).toHaveText("Ctrl+Alt+N");
  });

  test("Mod is Ctrl here, so Command palette on Mod+N takes Ctrl+N from New thread",async({page,request})=>{
    await open(page,request);
    await openShortcuts(page);
    const field=keyField(page,"Command palette");
    await retype(field,"Mod+N");
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"commandPalette"))?.key).toBe("Mod+N");
    // In a focused terminal New terminal runs, everywhere else Command palette: New thread never does.
    await expect(row(page,"New thread").getByRole("status")).toHaveText("Command palette and New terminal also use Ctrl+N and run instead.");
    // Command palette and New terminal only meet in a focused terminal, where New terminal runs as it should: neither is flagged
    // as never running.
    await expect(row(page,"Command palette").getByRole("status")).toHaveText("Takes Ctrl+N from New thread.");
    await expect(row(page,"New terminal").getByRole("status")).toHaveText("Takes Ctrl+N from New thread.");
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(3);
  });
});

test("every shortcut field says which command it is for",async({page,request})=>{
  await open(page,request,{scripts:[{id:"dev-server",name:"Dev server",command:"npm run dev"}]});
  await openShortcuts(page);
  const rows=page.locator(".keybinding-row");
  await expect(rows.last().locator("strong")).toHaveText("Run Dev server");
  const count=await rows.count();
  // The names a screen reader reads for each field, from the accessibility tree.
  const tree=await page.locator(".keybindings-settings").ariaSnapshot();
  const names=[...tree.matchAll(/^\s*- textbox "([^"]*)"/gm)].map(match=>match[1]);
  expect(names.length).toBe(count*2);
  const unique=new Set(names);
  expect(unique.size,`${names.length} shortcut fields share ${unique.size} names: ${[...unique].slice(0,6).join(", ")}`).toBe(names.length);
  await expect(page.getByRole("textbox",{name:"New thread shortcut",exact:true})).toHaveValue("Ctrl+N");
  await expect(page.getByRole("textbox",{name:"New thread when",exact:true})).toHaveValue("!modalOpen");
  await expect(page.getByRole("textbox",{name:"Open thread 3 shortcut",exact:true})).toHaveValue("Ctrl+3");
  await expect(page.getByRole("textbox",{name:"Run Dev server shortcut",exact:true})).toHaveValue("");
  await expect(page.getByRole("textbox",{name:"Run Dev server when",exact:true})).toHaveValue("projectOpen && !modalOpen");
});

for(const mode of MODES)test(`coming back to Settings opens the section that was open (${mode})`,async({page,request})=>{
  await open(page,request,{mode});
  await nav(page,"Settings").click();
  await expect(page.getByRole("heading",{name:"General",level:2})).toBeVisible();
  await section(page,"Workspace").click();
  await expect(page.getByRole("heading",{name:"Workspace",level:2})).toBeVisible();
  await nav(page,"Usage").click();
  await expect(page.getByRole("heading",{name:"Usage"})).toBeVisible();
  await nav(page,"Settings").click();
  await expect(page.getByRole("heading",{name:"Workspace",level:2}),"Settings reopened on another section").toBeVisible();
  await expect(section(page,"Workspace")).toHaveAttribute("aria-current","page");
  await expect(page.locator(".page-crumb em")).toHaveText("Workspace");
  await page.screenshot({animations:"disabled",path:shots+`settings-reopened-workspace-${mode}-1280.png`});
  // The Settings shortcut comes back to it too.
  await section(page,"Shortcuts").click();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
  await nav(page,"Projects").click();
  await expect(page.getByRole("heading",{name:"Projects"}).first()).toBeVisible();
  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("heading",{name:"Shortcuts",level:2})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
  // Licenses opens from General, and Back to Settings returns there.
  await section(page,"General").click();
  await page.getByRole("button",{name:"View licenses"}).click();
  await page.getByRole("link",{name:"Back to Settings"}).click();
  await expect(page.getByRole("heading",{name:"General",level:2})).toBeVisible();
  // A fresh start opens General.
  await section(page,"Appearance").click();
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();
  await nav(page,"Settings").click();
  await expect(page.getByRole("heading",{name:"General",level:2})).toBeVisible();
});
