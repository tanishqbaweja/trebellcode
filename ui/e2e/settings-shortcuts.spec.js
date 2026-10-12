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
const flipMode=(page,mode)=>page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
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
    // The red line stays under the pointer, and back in the field from the keyboard the field shows it has focus: its line and ring
    // are not the ones it has when left. Fields ease between looks, so each look is read once it has settled.
    const look=async()=>{
      let last="";
      await expect.poll(async()=>{const now=await field.evaluate(node=>{const style=getComputedStyle(node);return style.borderColor+" | "+style.boxShadow});const same=now===last;last=now;return same},{intervals:[250]}).toBe(true);
      return last;
    };
    await page.mouse.move(1,1);
    const leftLook=await look();
    await field.hover();
    expect(await look(),"the pointer takes the red line away").toBe(leftLook);
    await page.keyboard.press("Shift+Tab");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid","true");
    expect(await look(),"an invalid field looks the same with and without focus").not.toBe(leftLook);
    await sidebarRow.screenshot({animations:"disabled",path:shots+`shortcut-unfinished-focused-${mode}-1280.png`});
    await page.keyboard.press("Tab");
    await expect(message).toHaveText("Add a key after “Ctrl+”. Until then the shortcut stays Ctrl+B.");
    expect(saves,"leaving the unfinished shortcut again saves nothing").toEqual([]);

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

  // The matcher reads the key as the browser names it (ArrowUp, Delete, Enter), so "Ctrl+Up" would never fire.
  test("a key name the app never sees is refused with the name that works, and the saved shortcut keeps working",async({page,request})=>{
    await open(page,request);
    const saves=keybindingSaves(page);
    await openShortcuts(page);
    const sidebarRow=row(page,"Toggle main sidebar"),field=keyField(page,"Toggle main sidebar"),message=sidebarRow.getByRole("alert");
    await retype(field,"Ctrl+Up");
    await field.press("Tab");
    await expect(message).toHaveText("“Up” is not a key name. Use ArrowUp. Until then the shortcut stays Ctrl+B.");
    await expect(field).toHaveAttribute("aria-invalid","true");
    await expect(field).toHaveAccessibleDescription(/“Up” is not a key name/);
    expect(saves,"a shortcut naming a key the app never sees is never saved").toEqual([]);
    await sidebarRow.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"shortcut-key-name-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"shortcut-key-name-light-1280.png"});
    await page.setViewportSize({width:900,height:800});
    await sidebarRow.scrollIntoViewIfNeeded();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.screenshot({animations:"disabled",path:shots+"shortcut-key-name-light-900.png"});
    await flipMode(page,"dark");
    await page.screenshot({animations:"disabled",path:shots+"shortcut-key-name-dark-900.png"});
    await page.setViewportSize({width:1280,height:800});
    // Ctrl+B still toggles the sidebar.
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);
    // A name that is no key at all.
    await retype(field,"Ctrl+Uo");
    await field.press("Tab");
    await expect(message).toHaveText("“Uo” is not a key name. Use a letter, a digit or a name such as F2, Enter or ArrowUp. Until then the shortcut stays Ctrl+B.");
    expect(saves).toEqual([]);
    // The name that works is saved and works.
    await retype(field,"Ctrl+ArrowUp");
    await expect(message).toHaveCount(0);
    await field.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"sidebarToggle"))?.key).toBe("Ctrl+ArrowUp");
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+ArrowUp");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+ArrowUp");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);
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

  // A name that is not a context reads as false for ever, so the shortcut would stop working. "Always" is the word an empty When
  // field shows.
  test("a condition naming a context that does not exist is refused, and the saved one keeps working",async({page,request})=>{
    await open(page,request);
    const saves=keybindingSaves(page);
    await openShortcuts(page);
    const sidebarRow=row(page,"Toggle main sidebar"),field=whenField(page,"Toggle main sidebar"),message=sidebarRow.getByRole("alert");
    await expect(whenField(page,"Command palette")).toHaveAttribute("placeholder","Always");
    await retype(field,"Always");
    await field.press("Tab");
    await expect(message).toHaveText("“Always” is not a context. Leave When empty to use the shortcut everywhere. Until then the saved condition is used.");
    await expect(field).toHaveAttribute("aria-invalid","true");
    expect(saves,"a condition naming no context is never saved").toEqual([]);
    await sidebarRow.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"condition-unknown-context-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"condition-unknown-context-light-1280.png"});
    await flipMode(page,"dark");
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+B");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);
    // A misspelt context names the one meant.
    await retype(field,"!modalOpen && projectopen");
    await field.press("Tab");
    await expect(message).toHaveText("“projectopen” is not a context. Use projectOpen. Until then the saved condition is used.");
    await retype(field,"threadOpn && !modalOpen");
    await field.press("Tab");
    await expect(message).toHaveText("“threadOpn” is not a context. Use threadOpen. Until then the saved condition is used.");
    await retype(field,"!modalOpen && somewhere");
    await field.press("Tab");
    await expect(message).toHaveText("“somewhere” is not a context. Use one from Available contexts below. Until then the saved condition is used.");
    expect(saves).toEqual([]);
    // Every context the list below names can be saved.
    const note=page.locator(".keybindings-settings .provider-note").filter({hasText:"Available contexts"});
    const listed=(await note.innerText()).match(/Available contexts: ([^.]+)\./)[1].split(", ");
    expect(listed).toContain("undoAvailable");
    await note.scrollIntoViewIfNeeded();
    for(const mode of MODES){await flipMode(page,mode);await page.screenshot({animations:"disabled",path:shots+`available-contexts-${mode}-1280.png`})}
    await retype(field,"!modalOpen && ("+listed.join(" || ")+")");
    await field.press("Enter");
    await expect(message).toHaveCount(0);
    await expect.poll(()=>saves.length).toBe(1);
  });

  // A shortcut or condition saved before these checks came in, which they would now refuse, never works. It is flagged where it is
  // listed, as a typed one is, and stays saved as it is until the person changes it.
  for(const mode of MODES)test(`a saved shortcut or condition the checks refuse is flagged where it is listed (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const rules=[{command:"sidebarToggle",key:"Ctrl+Up",when:"!modalOpen"},{command:"terminal",key:"Ctrl+Shift+T",when:"Always"}];
    await request.post("/api/settings",{data:{keybindingRules:rules}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    const saves=keybindingSaves(page);
    await openShortcuts(page);
    const sidebarRow=row(page,"Toggle main sidebar"),key=keyField(page,"Toggle main sidebar"),keyMessage=sidebarRow.getByRole("alert");
    const terminalRow=row(page,"Toggle terminal"),when=whenField(page,"Toggle terminal"),whenMessage=terminalRow.getByRole("alert");
    const keyText="“Up” is not a key name. Use ArrowUp. Until then the saved shortcut does not work.";
    const whenText="“Always” is not a context. Leave When empty to use the shortcut everywhere. Until then the saved condition does not work.";
    await expect(keyMessage).toHaveText(keyText);
    await expect(key).toHaveValue("Ctrl+Up");
    await expect(key).toHaveAttribute("aria-invalid","true");
    await expect(key).toHaveAccessibleDescription(keyText);
    await expect(whenMessage).toHaveText(whenText);
    await expect(when).toHaveValue("Always");
    await expect(when).toHaveAttribute("aria-invalid","true");
    await expect(when).toHaveAccessibleDescription(whenText);
    await expect(whenField(page,"Toggle main sidebar")).not.toHaveAttribute("aria-invalid","true");
    await expect(page.locator(".keybindings-settings").getByRole("alert"),"only the two that cannot work are flagged").toHaveCount(2);
    await sidebarRow.scrollIntoViewIfNeeded();
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      await sidebarRow.scrollIntoViewIfNeeded();
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      await page.screenshot({animations:"disabled",path:shots+`saved-shortcut-refused-${mode}-${width}.png`});
      await terminalRow.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`saved-condition-refused-${mode}-${width}.png`});
    }
    await page.setViewportSize({width:1280,height:800});
    // Reading the page changed nothing: the saved rules are as they were.
    await key.click();await key.press("Tab");
    await when.click();await when.press("Tab");
    await expect(keyMessage).toHaveText(keyText);
    await expect(whenMessage).toHaveText(whenText);
    expect(saves,"listing a saved shortcut the checks refuse saves nothing").toEqual([]);
    expect((await saved(request)).keybindingRules).toEqual(rules);
    // Typing follows it as it does a refused one: the flag goes once the text can work, and Escape gives the saved one back, flagged.
    await retype(when,"!modalOpen");
    await expect(whenMessage).toHaveCount(0);
    await when.press("Escape");
    await expect(when).toHaveValue("Always");
    await expect(whenMessage).toHaveText(whenText);
    // A refused edit says the saved condition does not work either, rather than that it is used meanwhile.
    await retype(when,"!modalOpen &&");
    await when.press("Tab");
    await expect(whenMessage).toHaveText("Add a context after “&&”. Until then the saved condition does not work.");
    expect(saves).toEqual([]);
    // The name that works is saved and works, and the row is no longer flagged.
    await retype(key,"Ctrl+ArrowUp");
    await expect(keyMessage).toHaveCount(0);
    await key.press("Enter");
    await expect.poll(async()=>(await savedRule(request,"sidebarToggle"))?.key).toBe("Ctrl+ArrowUp");
    await expect(key).not.toHaveAttribute("aria-invalid","true");
    await sidebarRow.locator("strong").click();
    await page.keyboard.press("Control+ArrowUp");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(true);
    await page.keyboard.press("Control+ArrowUp");
    await expect.poll(()=>sidebarCollapsed(page)).toBe(false);
    expect(saves.length).toBe(1);
  });
});

test.describe("Two commands on one key",()=>{
  test("the shipped shortcuts show no clash",async({page,request})=>{
    await open(page,request);
    await openShortcuts(page);
    await expect(page.locator(".keybinding-row")).toHaveCount(61);
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(0);
    await expect(page.locator(".keybindings-settings").getByRole("alert"),"a shipped shortcut or condition is flagged").toHaveCount(0);
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

  // The palette names the keys Settings has, like the sidebar: a moved key moves there too, and a key another command takes goes.
  test("the command palette shows each command's key as Settings has it",async({page,request})=>{
    await open(page,request);
    await openShortcuts(page);
    const palette=page.getByTestId("command-palette");
    const paletteKey=async(label,openWith="Control+K")=>{
      await row(page,"New thread").locator("strong").click();
      await page.keyboard.press(openWith);
      await expect(palette).toBeVisible();
      await palette.locator("input").fill(label);
      const item=palette.locator(".command-palette-item").filter({has:page.locator("strong",{hasText:new RegExp("^"+label+"$")})}).first();
      await expect(item).toBeVisible();
      const keys=await item.locator("kbd").allInnerTexts();
      return {item,key:keys.join(" ")};
    };
    const close=async()=>{await page.keyboard.press("Escape");await expect(palette).toBeHidden()};
    expect((await paletteKey("New thread")).key).toBe("Ctrl+N");
    await close();
    // Keys of their own.
    await retype(keyField(page,"New thread"),"Ctrl+Alt+N");
    await keyField(page,"New thread").press("Enter");
    await retype(keyField(page,"Toggle terminal"),"Ctrl+Alt+T");
    await keyField(page,"Toggle terminal").press("Enter");
    await expect.poll(async()=>(await savedRule(request,"terminal"))?.key).toBe("Ctrl+Alt+T");
    await expect(page.getByRole("button",{name:"New task",exact:true}).locator("kbd")).toHaveText("Ctrl+Alt+N");
    const moved=await paletteKey("New thread");
    expect(moved.key,"New thread's key in the palette").toBe("Ctrl+Alt+N");
    await page.screenshot({animations:"disabled",path:shots+"palette-new-thread-key-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"palette-new-thread-key-light-1280.png"});
    await flipMode(page,"dark");
    await close();
    expect((await paletteKey("Terminal")).key,"Terminal's key in the palette").toBe("Ctrl+Alt+T");
    await close();
    // Command palette on Mod+N takes Ctrl+N from New thread: the palette, opened with Ctrl+N, offers no key for New thread.
    await retype(keyField(page,"New thread"),"Ctrl+N");
    await keyField(page,"New thread").press("Enter");
    await retype(keyField(page,"Command palette"),"Mod+N");
    await keyField(page,"Command palette").press("Enter");
    await expect.poll(async()=>(await savedRule(request,"commandPalette"))?.key).toBe("Mod+N");
    await expect(row(page,"New thread").getByRole("status")).toHaveText("Command palette and New terminal also use Ctrl+N and run instead.");
    await expect(page.getByRole("button",{name:"New task",exact:true}).locator("kbd")).toHaveCount(0);
    const taken=await paletteKey("New thread","Control+N");
    await expect(taken.item.locator("kbd"),"the palette offers Ctrl+N for New thread while Ctrl+N opens the palette").toHaveCount(0);
    await close();
  });

  // Cycle appearance mode and Cycle theme step on to the next choice, whatever it is: they run no single row of the palette, so
  // "Appearance: System" and "Theme: Trebell" offer no key, while a row whose command the key does run still shows it.
  for(const mode of MODES)test(`the palette offers the appearance and theme cycle keys on no row they do not run (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    const palette=page.getByTestId("command-palette"),search=palette.locator("input"),rows=palette.locator(".command-palette-item");
    const label=text=>rows.filter({has:page.locator("strong",{hasText:new RegExp("^"+text+"$")})});
    await page.keyboard.press("Control+K");
    await expect(palette).toBeVisible();
    await search.fill("Appearance:");
    await expect(rows).toHaveCount(3);
    await expect(label("Appearance: System")).toBeVisible();
    await expect(rows.locator("kbd"),"an appearance row offers the key that cycles the modes").toHaveCount(0);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:shots+`palette-appearance-rows-${mode}-${width}.png`})}
    await search.fill("Theme:");
    await expect(rows).toHaveCount(3);
    await expect(label("Theme: Trebell")).toBeVisible();
    await expect(rows.locator("kbd"),"a theme row offers the key that cycles the themes").toHaveCount(0);
    for(const width of [900,1280]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:shots+`palette-theme-rows-${mode}-${width}.png`})}
    await search.fill("New thread");
    await expect(label("New thread").locator("kbd")).toHaveText("Ctrl+N");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    // The keys step on from the current choice: Dark goes on to System but Light to Dark, and Trebell to Midnight.
    await page.keyboard.press("Control+Alt+Shift+A");
    await expect.poll(async()=>(await saved(request)).appearanceMode).toBe(mode==="dark"?"system":"dark");
    await page.keyboard.press("Control+Alt+A");
    await expect.poll(async()=>(await saved(request)).appearance).toBe("midnight");
  });

  // Shortcuts for project actions are saved for every project, but an action exists only in its own project. Elsewhere its key
  // stays with the command it would take, instead of running nothing.
  test("a key saved for an action this project does not have stays with the command it would take",async({page,request})=>{
    const boot=await open(page,request);
    await request.post("/api/settings",{data:{keybindingRules:[{command:"script.other-dev.run",key:"Ctrl+P",when:"projectOpen && !modalOpen"}]}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await openShortcuts(page);
    await expect(row(page,"Workspace files").getByRole("status"),"a note about an action this project does not have").toHaveCount(0);
    await expect(page.locator(".keybindings-settings").getByRole("status")).toHaveCount(0);
    await row(page,"Workspace files").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"other-project-action-key-dark-1280.png"});
    await flipMode(page,"light");
    await page.screenshot({animations:"disabled",path:shots+"other-project-action-key-light-1280.png"});
    await flipMode(page,"dark");
    // Ctrl+P opens Workspace files here.
    await row(page,"Workspace files").locator("strong").click();
    await page.keyboard.press("Control+P");
    await expect(page.getByTestId("right-panel"),"Ctrl+P opens the files panel").toBeVisible();
    // In a project that has the action, the action takes the key, and Settings says so on both rows.
    await request.post("/api/projects",{data:{path:boot.cwd,name:MAIN,scripts:[{id:"other-dev",name:"Dev server",command:"npm run dev"}]}});
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await openShortcuts(page);
    await expect(row(page,"Workspace files").getByRole("status")).toHaveText("Run Dev server also uses Ctrl+P and runs instead.");
    await expect(row(page,"Run Dev server").getByRole("status")).toHaveText("Takes Ctrl+P from Workspace files.");
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

test.describe("Appearance choices",()=>{
  for(const mode of MODES)test(`the Mode and Theme buttons say which one is chosen (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await nav(page,"Settings").click();
    await section(page,"Appearance").click();
    const modes=page.getByRole("group",{name:"Mode"}),themes=page.getByRole("group",{name:"Theme"});
    await expect(modes.getByRole("button",{pressed:true})).toHaveText([mode]);
    await expect(modes.getByRole("button",{pressed:false})).toHaveCount(2);
    await expect(themes.getByRole("button",{pressed:true})).toHaveText(["Trebell"]);
    await expect(themes.getByRole("button",{pressed:false})).toHaveCount(2);
    const other=mode==="dark"?"light":"dark";
    await modes.getByRole("button",{name:other,exact:true}).click();
    await themes.getByRole("button",{name:"Midnight",exact:true}).click();
    await expect(modes.getByRole("button",{pressed:true})).toHaveText([other]);
    await expect(themes.getByRole("button",{pressed:true})).toHaveText(["Midnight"]);
    await expect.poll(async()=>(await saved(request)).appearance).toBe("midnight");
    // A custom theme is one of the choices once it is saved and applied.
    await page.getByRole("button",{name:"Create theme"}).click();
    await page.locator(".theme-editor").getByRole("textbox",{name:"Name"}).fill("Harbor");
    await page.getByRole("button",{name:"Save & apply"}).click();
    await expect(themes.getByRole("button",{pressed:true})).toHaveText(["Harbor"]);
    await expect(themes.getByRole("button",{name:"Midnight",exact:true})).toHaveAttribute("aria-pressed","false");
    await page.getByRole("button",{name:"Close editor"}).click();
    await modes.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+`appearance-chosen-${other}-1280.png`});
    // The choice is still shown after a reload.
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await nav(page,"Settings").click();
    await section(page,"Appearance").click();
    await expect(modes.getByRole("button",{pressed:true})).toHaveText([other]);
    await expect(themes.getByRole("button",{pressed:true})).toHaveText(["Harbor"]);
  });

  for(const mode of MODES)test(`following a published theme marks it chosen and the built-in themes as not in use (${mode})`,async({page,request})=>{
    const catalog={environmentKey:"local",environmentName:"Local machine",directory:"themes",themes:[{id:"fixture-published",name:"Fixture published theme",appearance:"dark",canvas:"#11131a",accent:"#8f6bd8"}]};
    await page.route(/\/api\/environment\/themes$/,route=>json(route,catalog));
    await open(page,request,{mode});
    await nav(page,"Settings").click();
    await section(page,"Appearance").click();
    const themes=page.getByRole("group",{name:"Theme"});
    const published=page.getByRole("button",{name:"Fixture published theme",exact:true});
    await expect(published).toHaveAttribute("aria-pressed","false");
    await published.click();
    await expect(published).toHaveAttribute("aria-pressed","true");
    await expect(themes.getByRole("button",{pressed:true})).toHaveCount(0);
    await expect(themes.locator("button.active")).toHaveCount(0);
    // The user's own theme stays outlined, as the one "Use my normal theme" goes back to.
    await expect(themes.getByRole("button",{name:"Trebell",exact:true})).toHaveClass(/underneath/);
    await page.screenshot({animations:"disabled",path:shots+`appearance-published-theme-${mode}-1280.png`});
    await page.getByRole("button",{name:"Use my normal theme"}).click();
    await expect(published).toHaveAttribute("aria-pressed","false");
    await expect(themes.getByRole("button",{pressed:true})).toHaveText(["Trebell"]);
  });
});

const LONG_THEME="Explore theme with a long name that keeps going for the layout check";
for(const [mode,width] of [["dark",1280],["light",1280],["dark",900],["light",900]])test(`a long theme name stays inside the Appearance card (${mode} ${width})`,async({page,request})=>{
  await open(page,request,{mode,width});
  await nav(page,"Settings").click();
  await section(page,"Appearance").click();
  await page.getByRole("button",{name:"Create theme"}).click();
  await page.locator(".theme-editor").getByRole("textbox",{name:"Name"}).fill(LONG_THEME);
  await page.getByRole("button",{name:"Save & apply"}).click();
  await expect.poll(async()=>((await saved(request)).customThemes||[]).length).toBe(1);
  const pill=page.getByRole("group",{name:"Theme"}).getByRole("button",{name:LONG_THEME,exact:true});
  await expect(pill).toBeVisible();
  await pill.scrollIntoViewIfNeeded();
  const fit=await pill.evaluate(node=>{
    const card=node.closest(".settings-card"),control=node.closest(".appearance-options");
    const box=element=>element.getBoundingClientRect();
    return {pill:Math.round(box(node).right),control:Math.round(box(control).right),content:Math.round(box(card).right-parseFloat(getComputedStyle(card).paddingRight)),cut:node.scrollWidth>node.clientWidth+1,title:node.getAttribute("title")};
  });
  expect(fit.control,"the Theme control ends inside the card: "+JSON.stringify(fit)).toBeLessThanOrEqual(fit.content);
  expect(fit.pill,"the theme button ends inside the Theme control: "+JSON.stringify(fit)).toBeLessThanOrEqual(fit.control);
  if(fit.cut)expect(fit.title,"a shortened name shows in full on hover").toBe(LONG_THEME);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await page.screenshot({animations:"disabled",path:shots+`theme-long-name-${mode}-${width}.png`});
  await page.locator(".theme-settings").screenshot({animations:"disabled",path:shots+`theme-long-name-card-${mode}-${width}.png`});
});

for(const mode of MODES)test(`storage requests that fail say what failed and are announced (${mode})`,async({page,request})=>{
  let readFails=true;
  await page.route(/\/api\/storage-cleanup$/,route=>route.request().method()==="POST"
    ?json(route,{error:"Deliberate cleanup failure"},500)
    :readFails?json(route,{error:"Deliberate storage read failure"},500):route.fallback());
  await open(page,request,{mode});
  await nav(page,"Settings").click();
  await section(page,"Workspace").click();
  const card=page.locator(".storage-settings");
  const readError=card.getByRole("alert").filter({hasText:"storage use"});
  await expect(readError).toHaveText("Could not read storage use: Deliberate storage read failure");
  await expect(card).not.toContainText("0 cached attachments");
  const cleanup=card.getByRole("button",{name:"Clean up storage now"});
  await cleanup.scrollIntoViewIfNeeded();
  await cleanup.click();
  const cleanupError=card.getByRole("alert").filter({hasText:"clean up"});
  await expect(cleanupError).toHaveText("Could not clean up storage: Deliberate cleanup failure");
  await expect(cleanup).toBeEnabled();
  await page.screenshot({animations:"disabled",path:shots+`storage-failed-${mode}-1280.png`});
  await page.setViewportSize({width:900,height:800});
  await cleanupError.scrollIntoViewIfNeeded();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await page.screenshot({animations:"disabled",path:shots+`storage-failed-${mode}-900.png`});
  await page.setViewportSize({width:1280,height:800});
  // Once a read works, the numbers replace the failure.
  readFails=false;
  await card.getByRole("button",{name:"Refresh storage"}).click();
  await expect(card.locator(".provider-note").filter({hasText:"cached attachment"})).toBeVisible();
  await expect(readError).toHaveCount(0);
  // A refresh that fails later keeps the numbers and says the refresh failed.
  readFails=true;
  await card.getByRole("button",{name:"Refresh storage"}).click();
  await expect(card.getByRole("alert").filter({hasText:"refresh"})).toHaveText("Could not refresh storage use: Deliberate storage read failure");
  await expect(card.locator(".provider-note").filter({hasText:"cached attachment"})).toBeVisible();
  await page.screenshot({animations:"disabled",path:shots+`storage-refresh-failed-${mode}-1280.png`});
});

// A read that fails again reads differently and is a new alert, so it is seen and said again, before numbers came and after.
test("a storage read that fails again says it still could not read it",async({page,request})=>{
  let readFails=true;
  await page.route(/\/api\/storage-cleanup$/,route=>route.request().method()==="GET"&&readFails?json(route,{error:"Deliberate storage read failure"},500):route.fallback());
  await open(page,request);
  await nav(page,"Settings").click();
  await section(page,"Workspace").click();
  const card=page.locator(".storage-settings"),alert=card.getByRole("alert"),refresh=card.getByRole("button",{name:"Refresh storage"});
  await expect(alert).toHaveText("Could not read storage use: Deliberate storage read failure");
  let shown=await alert.elementHandle();
  await refresh.click();
  await expect(alert).toHaveText("Still could not read storage use: Deliberate storage read failure");
  expect(await shown.evaluate(node=>node.isConnected),"the failure is a new alert, so it is said again").toBe(false);
  await refresh.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:shots+"storage-read-failed-again-dark-1280.png"});
  await flipMode(page,"light");
  await page.screenshot({animations:"disabled",path:shots+"storage-read-failed-again-light-1280.png"});
  await flipMode(page,"dark");
  shown=await alert.elementHandle();
  await refresh.click();
  await expect.poll(()=>shown.evaluate(node=>node.isConnected)).toBe(false);
  await expect(alert).toHaveText("Still could not read storage use: Deliberate storage read failure");
  // Once numbers came, a refresh that fails twice says so the same way, and the numbers stay.
  readFails=false;
  await refresh.click();
  await expect(card.locator(".provider-note").filter({hasText:"cached attachment"})).toBeVisible();
  await expect(alert).toHaveCount(0);
  readFails=true;
  await refresh.click();
  await expect(alert).toHaveText("Could not refresh storage use: Deliberate storage read failure");
  shown=await alert.elementHandle();
  await refresh.click();
  await expect(alert).toHaveText("Still could not refresh storage use: Deliberate storage read failure");
  expect(await shown.evaluate(node=>node.isConnected)).toBe(false);
  await expect(card.locator(".provider-note").filter({hasText:"cached attachment"})).toBeVisible();
});

for(const mode of MODES)test(`storage use reads as loading until it comes, not as zeros (${mode})`,async({page,request})=>{
  let release;const held=new Promise(resolve=>{release=resolve});
  await page.route(/\/api\/storage-cleanup$/,async route=>{if(route.request().method()==="GET")await held;await route.fallback()});
  await open(page,request,{mode});
  await nav(page,"Settings").click();
  await section(page,"Workspace").click();
  const card=page.locator(".storage-settings");
  await expect(card.locator(".provider-note").filter({hasText:"Reading storage use…"})).toBeVisible();
  await expect(card).not.toContainText("cached attachment");
  await card.getByRole("button",{name:"Refresh storage"}).scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:shots+`storage-reading-${mode}-1280.png`});
  release();
  await expect(card.locator(".provider-note").filter({hasText:"cached attachment"})).toBeVisible();
  await expect(card).not.toContainText("Reading storage use…");
});
