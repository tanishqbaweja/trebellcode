import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";
import { keepThreadMeta } from "./test-home.js";
import { startStreamingFixture } from "./native-stream-fixture.js";

// The command palette from the keyboard (keys typed straight after Ctrl+K, where focus goes after a command) and moving between pages
// with the browser's Back and Forward beside the app's own Navigate back/forward shortcuts.
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
// The app's shortcuts act only while no text field has focus, as for a person who clicked away from the composer.
const pressShortcut=async(page,keys)=>{await page.evaluate(()=>document.activeElement?.blur?.());await page.keyboard.press(keys)};

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

  test("Enter typed straight after the search on a first open runs the command once the palette's code arrives",async({page,request})=>{
    for(const mode of ["dark","light"]){
      await open(page,request,{mode});
      const release=await holdChunk(page,"CommandPalette");
      const composer=page.getByTestId("composer"),palette=page.getByTestId("command-palette");
      await composer.click();
      await page.keyboard.press("Control+K");
      await page.keyboard.type("usage",{delay:30});
      await page.keyboard.press("Enter");
      await expect(palette.getByRole("status")).toHaveText("Loading commands…");
      await expect(palette.getByRole("textbox")).toHaveValue("usage");
      await page.screenshot({animations:"disabled",path:shots+`palette-loading-enter-${mode}-1280.png`});
      release();
      await expect(usageHeading(page),"the Enter pressed while the palette's code loaded was dropped").toBeVisible();
      await expect(palette).toBeHidden();
      await expect(usageHeading(page)).toBeFocused();
      await page.screenshot({animations:"disabled",path:shots+`palette-loading-enter-ran-${mode}-1280.png`});
      await page.unroute(/\/assets\/CommandPalette-/);
    }
  });

  test("arrow keys pressed while the palette's code loads pick the command Enter runs once it arrives",async({page,request})=>{
    await open(page,request);
    const release=await holdChunk(page,"CommandPalette");
    const palette=page.getByTestId("command-palette");
    await page.getByTestId("composer").click();
    await page.keyboard.press("Control+K");
    // Appearance: System, Light, Dark. Up at the first result stays there, as in the palette itself, so Down then picks Light.
    await page.keyboard.type("appearance",{delay:30});
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(palette.getByRole("status")).toHaveText("Loading commands…");
    release();
    await expect(palette).toBeHidden();
    await expect.poll(async()=>(await (await request.get("/api/state")).json()).settings?.appearanceMode).toBe("light");
    await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("light");
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

  // The terminal opens with none running here (the server's list answered empty), so its Create terminal button takes the focus.
  test("Terminal moves focus into the terminal it opened instead of back to where the palette was opened from",async({page,request})=>{
    await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({sessions:[]})}):route.fallback());
    await open(page,request);
    const palette=page.getByTestId("command-palette"),drawer=page.getByTestId("drawer");
    for(const mode of ["dark","light"]){
      const html=page.locator("html");if(await html.getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode)}
      await page.getByTestId("composer").click();
      await page.keyboard.press("Control+K");
      await expect(palette.locator(".command-palette-item").first()).toBeVisible();
      await page.keyboard.type(">terminal",{delay:25});
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();
      const create=drawer.getByRole("button",{name:"Create terminal"});
      await expect(create).toBeFocused();
      // It keeps the focus: nothing hands it back to the composer afterwards.
      await page.waitForTimeout(400);
      await expect(create).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(create).toBeInViewport();await page.screenshot({animations:"disabled",path:shots+"palette-command-terminal-focus-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
      await drawer.getByRole("button",{name:"Close terminal"}).click();
      await expect(drawer).toHaveCount(0);
    }
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

test.describe("Back and forward",()=>{
  const start=async page=>({url:page.url(),length:await page.evaluate(()=>history.length)});

  test("browser Back and Forward move through the pages visited",async({page,request})=>{
    await open(page,request);
    const before=await start(page);
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    await page.goBack();
    await expect(projectsHeading(page)).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.goForward();
    await expect(projectsHeading(page)).toBeVisible();
    await page.goForward();
    await expect(usageHeading(page)).toBeVisible();
    await page.screenshot({animations:"disabled",path:shots+"history-forward-usage-dark-1280.png"});
    expect(page.url()).toBe(before.url);
    expect(await page.evaluate(()=>history.length)).toBe(before.length+2);
  });

  test("the browser's buttons and the app's shortcuts move through one history, a step at a time",async({page,request})=>{
    await open(page,request);
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    await nav(page,"Settings").click();await expect(settingsHeading(page)).toBeVisible();
    const length=await page.evaluate(()=>history.length);
    await pressShortcut(page,"Control+BracketLeft");
    await expect(usageHeading(page)).toBeVisible();
    await page.goBack();
    await expect(projectsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketLeft");
    await expect(page.getByTestId("composer")).toBeVisible();
    // At the first page the shortcut stays in the app; the browser's own Back would leave it.
    await pressShortcut(page,"Control+BracketLeft");
    await page.waitForTimeout(400);
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.goForward();
    await expect(projectsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await expect(usageHeading(page)).toBeVisible();
    await page.goForward();
    await expect(settingsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await page.waitForTimeout(400);
    await expect(settingsHeading(page)).toBeVisible();
    // Moving back and forward added no entries, and the browser is where the app is: one more Back is Usage.
    expect(await page.evaluate(()=>history.length)).toBe(length);
    await page.goBack();
    await expect(usageHeading(page)).toBeVisible();
  });

  test("a page opened after going back drops the pages ahead in both",async({page,request})=>{
    await open(page,request);
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    await page.goBack();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Settings").click();await expect(settingsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await page.waitForTimeout(400);
    await expect(settingsHeading(page)).toBeVisible();
    await page.goForward().catch(()=>{});
    await page.waitForTimeout(400);
    await expect(settingsHeading(page)).toBeVisible();
    await page.goBack();await expect(projectsHeading(page)).toBeVisible();
    await page.goBack();await expect(page.getByTestId("composer")).toBeVisible();
  });

  test("a reload opens the app as usual, and Back and the shortcuts still move through the pages before it",async({page,request})=>{
    await open(page,request,{mode:"light"});
    const url=page.url();
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.locator(".secondary-page")).toHaveCount(0);
    expect(page.url()).toBe(url);
    // The reloaded entry names the page the app opened on once its history is set up (a Back that comes sooner is tested below).
    await expect.poll(()=>page.evaluate(()=>history.state?.trebellNav?.section)).toBe("chat");
    await page.goBack();
    await expect(projectsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await expect(page.getByTestId("composer")).toBeVisible();
    await pressShortcut(page,"Control+BracketLeft");
    await expect(projectsHeading(page)).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.screenshot({animations:"disabled",path:shots+"history-after-reload-back-light-1280.png"});
  });

  test("Forward after a reload and a quick Back lands on the page the reload opened, however soon Back came",async({page,request})=>{
    const outcomes={};
    for(const [timing,mode] of [["after the app started","dark"],["while the app was starting","light"]]){
      await open(page,request,{mode});
      await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
      await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
      // Holding the themes keeps the app starting, so Back comes before its history is set up.
      let release=()=>{};
      const starting=timing==="while the app was starting";
      if(starting){const held=new Promise(resolve=>{release=resolve});await page.route(/\/api\/environment\/themes$/,async route=>{await held;await route.continue()})}
      await page.reload();
      await expect(page.getByTestId("composer")).toBeVisible();
      if(!starting)await expect.poll(()=>page.evaluate(()=>history.state?.trebellNav?.section)).toBe("chat");
      await page.goBack();
      release();
      await expect(projectsHeading(page)).toBeVisible();
      await page.waitForTimeout(300);
      await pressShortcut(page,"Control+BracketRight");
      await expect(projectsHeading(page)).toHaveCount(0);
      await page.waitForTimeout(400);
      outcomes[timing]=(await usageHeading(page).isVisible())?"usage":(await page.getByTestId("composer").isVisible())?"chat":"other";
      await page.screenshot({animations:"disabled",path:shots+`history-reload-back-forward-${starting?"starting":"started"}-${mode}-1280.png`});
      await page.unroute(/\/api\/environment\/themes$/);
    }
    expect(outcomes).toEqual({"after the app started":"chat","while the app was starting":"chat"});
  });

  // The Browser panel's preview is a frame of its own: the pages it moves through are in the tab's history too, but they are not the
  // app's, so the app's own Navigate back and forward step over them.
  test("Navigate back goes to the page before the Browser panel after the preview moved between two addresses",async({page,request})=>{
    await open(page,request);
    await page.route(/^http:\/\/localhost:4599\//,route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({status:200,contentType:"text/html",body:`<!doctype html><title>${path}</title><h1>Preview ${path}</h1>`})});
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    await nav(page,"Browser").click();
    const address=page.getByRole("textbox",{name:"Page address"}),frame=page.locator('iframe[title="Trebell preview"]'),preview=page.frameLocator('iframe[title="Trebell preview"]');
    await address.fill("http://localhost:4599/a");await address.press("Enter");
    await expect(preview.locator("h1")).toHaveText("Preview /a");
    await address.fill("http://localhost:4599/b");await address.press("Enter");
    await expect(preview.locator("h1")).toHaveText("Preview /b");
    await page.screenshot({animations:"disabled",path:shots+"history-preview-moved-dark-1280.png"});
    await pressShortcut(page,"Control+BracketLeft");
    await expect(usageHeading(page),"Navigate back stepped the preview back instead of the app").toBeVisible();
    if(await frame.count())await expect(preview.locator("h1")).toHaveText("Preview /b");
    await expect.poll(()=>page.evaluate(()=>history.state?.trebellNav?.section)).toBe("usage");
    await page.screenshot({animations:"disabled",path:shots+"history-preview-back-usage-dark-1280.png"});
    await pressShortcut(page,"Control+BracketLeft");
    await expect(projectsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await expect(usageHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await expect(address).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>Boolean(history.state?.trebellNav?.rightPanelOpen))).toBe(true);
  });

  test("Navigate back goes to the page before the Browser panel after a click inside a previewed single-page app",async({page,request})=>{
    await open(page,request,{mode:"light"});
    const spa=`<!doctype html><title>SPA</title><h1 id=title>Home</h1><button id=go onclick="history.pushState({},'', '/spa/about');document.getElementById('title').textContent='About'">About</button><script>addEventListener('popstate',()=>{document.getElementById('title').textContent=location.pathname==='/spa/about'?'About':'Home'})</script>`;
    await page.route(/^http:\/\/localhost:4599\//,route=>route.fulfill({status:200,contentType:"text/html",body:spa}));
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Browser").click();
    const address=page.getByRole("textbox",{name:"Page address"}),frame=page.locator('iframe[title="Trebell preview"]'),preview=page.frameLocator('iframe[title="Trebell preview"]');
    await address.fill("http://localhost:4599/spa");await address.press("Enter");
    await expect(preview.locator("h1")).toHaveText("Home");
    await preview.getByRole("button",{name:"About"}).click();
    await expect(preview.locator("h1")).toHaveText("About");
    await page.screenshot({animations:"disabled",path:shots+"history-preview-app-moved-light-1280.png"});
    await pressShortcut(page,"Control+BracketLeft");
    await expect(projectsHeading(page),"Navigate back stepped the previewed app back instead of the app").toBeVisible();
    if(await frame.count())await expect(preview.locator("h1")).toHaveText("About");
    await page.screenshot({animations:"disabled",path:shots+"history-preview-app-back-projects-light-1280.png"});
  });

  test("the desktop window keeps its history to itself and its shortcuts still work",async({page,request})=>{
    await page.addInitScript(()=>{Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{}})});
    await open(page,request);
    const length=await page.evaluate(()=>history.length);
    await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
    await nav(page,"Usage").click();await expect(usageHeading(page)).toBeVisible();
    expect(await page.evaluate(()=>history.length)).toBe(length);
    await pressShortcut(page,"Control+BracketLeft");
    await expect(projectsHeading(page)).toBeVisible();
    await pressShortcut(page,"Control+BracketRight");
    await expect(usageHeading(page)).toBeVisible();
    expect(await page.evaluate(()=>history.length)).toBe(length);
  });
});

// ============ Back and Forward to threads, behind a fake Codex app-server ============
// The app-server answers what the app asks at start; delays holds a thread's resume (by id, in ms) or the thread list (list). older
// is the list's next page (History's Load older threads reads it); a thread on neither page is one the harness does not have.
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
function fixtureThreads(names){const now=Date.now()/1000;return names.map((name,i)=>({id:"navigation-thread-"+i,name,preview:"Preview of "+name,cwd:process.cwd(),createdAt:now-1000-i*60,updatedAt:now-i*60,turns:[]}))}
const EMPTY_LISTS=["threadSection/list","thread/loaded/list","thread/attachment/list","thread/queue/list","app/list","permissionProfile/list","hooks/list","experimentalFeature/list","plugin/share/list","collaborationMode/list","skills/list"];
async function startCodex(threads,delays={},older=[]){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",async data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const m=message.method;let result={};
      if(m==="thread/list"){if(delays.list)await new Promise(resolve=>setTimeout(resolve,delays.list));result=message.params?.cursor==="older"?{data:older,nextCursor:null}:{data:threads,nextCursor:older.length?"older":null}}
      else if(m==="thread/resume"||m==="thread/read"){
        const id=message.params?.threadId,thread=[...threads,...older].find(t=>t.id===id);if(delays[id])await new Promise(resolve=>setTimeout(resolve,delays[id]));
        if(!thread){try{ws.send(JSON.stringify({id:message.id,error:{code:-32600,message:"thread not found: "+id}}))}catch{}return}
        result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      }
      else if(m==="initialize")result={userAgent:"navigation-fixture"};
      else if(EMPTY_LISTS.includes(m))result={data:[],nextCursor:null};
      else if(m==="thread/goal/get")result={goal:null};
      else if(m==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(m==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(m==="mcpServerStatus/list")result={data:[]};
      else if(m==="plugin/list")result={marketplaces:[]};
      else if(m==="app/installed")result={apps:[]};
      else if(m==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(m==="account/rateLimits/read")result={rateLimits:{}};
      else if(m==="config/read")result={config:{},layers:[]};
      else if(m==="thread/unsubscribe")result={status:"unsubscribed"};
      try{ws.send(JSON.stringify({id:message.id,result}))}catch{}
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {port,older,meta:{},async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
async function openCodex(page,fixture,threads,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${fixture.port}`,cwd:process.cwd(),platform:process.platform,version:"navigation-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:Object.fromEntries([...threads,...fixture.older].map(t=>[t.id,{projectless:true,environmentId:null,...fixture.meta[t.id]}]))}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/agent-runtimes$/,route=>json(route,{selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true}],statuses:[{id:"codex-default",kind:"codex",name:"Codex",available:true,installed:true,authenticated:true,version:"fixture"}]}));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.locator(".thread-row")).toHaveCount(threads.length);
}
const headerTitle=page=>page.locator(".workspace-header .thread-title-button strong");
const threadRow=(page,thread)=>page.locator(`.thread-row[data-thread-id="${thread.id}"]`);
const shownEntry=page=>page.evaluate(()=>{const entry=history.state?.trebellNav;return entry?entry.section+":"+(entry.threadId||""):null});

test.describe("Back and forward to a thread",()=>{
  // A page the person picks while the thread a Back or Forward went to is still opening is theirs: it stays, and it is the entry after
  // that thread's, as when the thread had opened at once.
  for(const [way,mode] of [["the browser's Back","dark"],["Ctrl+[","light"]]){
    test(`${way} to a thread that is slow to open, then Projects: Projects stays and is the next entry (${mode})`,async({page})=>{
      const threads=fixtureThreads(["Alpha thread","Beta thread"]),delays={},fixture=await startCodex(threads,delays);
      try{
        await openCodex(page,fixture,threads,{mode});
        await threadRow(page,threads[0]).click();await expect(headerTitle(page)).toHaveText("Alpha thread");
        await expect.poll(()=>shownEntry(page)).toBe("chat:"+threads[0].id);
        await threadRow(page,threads[1]).click();await expect(headerTitle(page)).toHaveText("Beta thread");
        await expect.poll(()=>shownEntry(page)).toBe("chat:"+threads[1].id);
        // Alpha's resume (asked twice by this fixture) now takes 2 s each time.
        delays[threads[0].id]=2000;
        if(way==="Ctrl+[")await pressShortcut(page,"Control+BracketLeft");else await page.goBack();
        await page.waitForTimeout(150);
        await nav(page,"Projects").click();
        await expect(projectsHeading(page)).toBeVisible();
        await expect.poll(()=>shownEntry(page),{message:"the Projects visit is not an entry once Alpha has opened",timeout:12000}).toBe("projects:"+threads[0].id);
        await page.waitForTimeout(400);
        await expect(projectsHeading(page),"Alpha opening took the person off the Projects page they picked after it").toBeVisible();
        await page.screenshot({animations:"disabled",path:shots+`history-slow-thread-projects-${mode}-1280.png`});
        await page.goBack();
        await expect(page.getByTestId("composer")).toBeVisible();
        await expect(headerTitle(page)).toHaveText("Alpha thread");
        await expect(projectsHeading(page)).toHaveCount(0);
        await page.screenshot({animations:"disabled",path:shots+`history-slow-thread-back-${mode}-1280.png`});
      }finally{await fixture.close()}
    });
  }

  // Back comes after the app has started (dark) or while it is still starting (light, the themes held), each before the thread list.
  for(const [mode,starting] of [["dark",false],["light",true]])test(`Back to a thread right after a reload, before the thread list has come, opens that thread and keeps its entry (${starting?"while the app starts":"once the app has started"}, ${mode})`,async({page})=>{
    const threads=fixtureThreads(["Alpha thread","Beta thread"]),delays={},fixture=await startCodex(threads,delays);
    try{
      await openCodex(page,fixture,threads,{mode});
      await threadRow(page,threads[0]).click();await expect(headerTitle(page)).toHaveText("Alpha thread");
      await expect.poll(()=>shownEntry(page)).toBe("chat:"+threads[0].id);
      await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
      await expect.poll(()=>shownEntry(page)).toBe("projects:"+threads[0].id);
      delays.list=2500;
      let release=()=>{};
      if(starting){const held=new Promise(resolve=>{release=resolve});await page.route(/\/api\/environment\/themes$/,async route=>{await held;await route.fallback()})}
      await page.reload();
      await expect(page.getByTestId("composer")).toBeVisible();
      if(!starting)await expect.poll(()=>shownEntry(page)).toBe("chat:");
      await page.goBack();
      release();
      await expect(headerTitle(page),"Back before the thread list came did not open the thread it went back to").toHaveText("Alpha thread",{timeout:10000});
      await expect.poll(()=>shownEntry(page)).toBe("chat:"+threads[0].id);
      await page.screenshot({animations:"disabled",path:shots+`history-reload-back-thread-${mode}-1280.png`});
      // The entry still names the thread, so Back from the page after it reaches it again.
      await page.goForward();
      await expect.poll(()=>shownEntry(page)).toBe("chat:");
      await page.goBack();
      await expect(headerTitle(page)).toHaveText("Alpha thread");
      await expect.poll(()=>shownEntry(page)).toBe("chat:"+threads[0].id);
    }finally{await fixture.close()}
  });

  // Threads past the list's first page, opened from History. After a reload the list holds only its first page again.
  const olderThreads=names=>fixtureThreads(names).map((thread,i)=>({...thread,id:"navigation-older-"+i,updatedAt:thread.updatedAt-30*86400,createdAt:thread.createdAt-30*86400}));
  async function openFromHistory(page,title,{loadOlder=false}={}){
    await nav(page,"History").click();
    if(loadOlder)await page.getByRole("button",{name:"Load older threads"}).click();
    await page.locator(".history-thread-row").filter({hasText:title}).click();
    await expect(headerTitle(page)).toHaveText(title);
  }
  for(const mode of ["dark","light"])test(`Back after a reload to a thread older than the thread list's first page opens it, as History would (${mode})`,async({page})=>{
    const threads=fixtureThreads(["Alpha thread","Beta thread"]),older=olderThreads(["Old thread"]),fixture=await startCodex(threads,{},older);
    try{
      await openCodex(page,fixture,threads,{mode});
      await openFromHistory(page,"Old thread",{loadOlder:true});
      await expect.poll(()=>shownEntry(page)).toBe("chat:"+older[0].id);
      await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
      await expect.poll(()=>shownEntry(page)).toBe("projects:"+older[0].id);
      await page.reload();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.locator(".thread-row")).toHaveCount(threads.length);
      await expect.poll(()=>shownEntry(page)).toBe("chat:");
      await page.goBack();
      await expect(headerTitle(page),"Back to a thread the list's first page does not hold did not open it").toHaveText("Old thread",{timeout:10000});
      await expect.poll(()=>shownEntry(page),{message:"the entry was rewritten as if its thread were gone"}).toBe("chat:"+older[0].id);
      await expect(threadRow(page,older[0])).toHaveClass(/active/);
      await page.screenshot({animations:"disabled",path:shots+`history-reload-back-older-thread-${mode}-1280.png`});
      await page.setViewportSize({width:900,height:800});
      await expect(headerTitle(page)).toHaveText("Old thread");
      await page.screenshot({animations:"disabled",path:shots+`history-reload-back-older-thread-${mode}-900.png`});
      // The entry still names the thread: Forward and Back again reach it.
      await page.goForward();
      await expect.poll(()=>shownEntry(page)).toBe("chat:");
      await page.goBack();
      await expect(headerTitle(page)).toHaveText("Old thread");
      await expect.poll(()=>shownEntry(page)).toBe("chat:"+older[0].id);
    }finally{await fixture.close()}
  });

  // A thread archived since, or one the harness no longer has, is gone: Back shows the page without it and its entry says so.
  test("Back after a reload to an older thread that was archived or deleted since settles on the page without it",async({page})=>{
    const threads=fixtureThreads(["Alpha thread","Beta thread"]),older=olderThreads(["Archived thread","Deleted thread"]),fixture=await startCodex(threads,{},older);
    const [archived,deleted]=older;
    try{
      await openCodex(page,fixture,threads);
      await openFromHistory(page,"Archived thread",{loadOlder:true});
      await openFromHistory(page,"Deleted thread");
      await nav(page,"Projects").click();await expect(projectsHeading(page)).toBeVisible();
      await expect.poll(()=>shownEntry(page)).toBe("projects:"+deleted.id);
      fixture.meta[archived.id]={archived:true};older.splice(older.indexOf(deleted),1);
      await page.reload();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect.poll(()=>shownEntry(page)).toBe("chat:");
      await page.goBack();
      await expect.poll(()=>shownEntry(page),{message:"the deleted thread's entry"}).toBe("chat:");
      await expect(page.getByTestId("composer")).toBeVisible();
      await page.goBack();
      await expect(page.locator(".history-page")).toBeVisible();
      await expect.poll(()=>shownEntry(page),{message:"the History entry the archived thread was open behind"}).toBe("history:");
      await page.goBack();
      await expect.poll(()=>shownEntry(page),{message:"the archived thread's entry"}).toBe("chat:");
      await expect(page.getByTestId("composer")).toBeVisible();
      for(const title of ["Archived thread","Deleted thread"])await expect(headerTitle(page)).not.toHaveText(title);
      await expect(page.locator(".thread-row")).toHaveCount(threads.length);
    }finally{await fixture.close()}
  });
});

// ============ Threads the palette's search finds beyond the loaded list, on Trebell Native's relay ============
// 130 threads a minute apart, newest first: the sidebar lists the newest 100, and Trebell keeps a note of every thread without its
// name. The appearance setting stays in the page.
async function openOlderThreads(page){
  const harness=await startRelayHarness(),now=Math.floor(Date.now()/1000);
  const providerMeta={runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null};
  for(let index=0;index<130;index++){const name="Old task "+String(index).padStart(3,"0");harness.threads.push(harness.threadStore.importHistory({runtime:"native",cwd:harness.repo,providerSessionId:"palette-older-"+index,model:"gpt-5.6",name,preview:name,providerMeta,createdAt:now-600-index*60,updatedAt:now-index*60}))}
  await routeRelayApp(page,harness);
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.locator('.thread-main[title="Old task 000"]')).toBeVisible();
  return harness;
}

test("a thread the palette's search finds beyond the loaded list shows by its name, and Enter opens it",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openOlderThreads(page);
  try{
    const palette=page.getByTestId("command-palette"),composer=page.getByTestId("composer");
    const found=palette.locator(".command-palette-item.kind-thread");
    for(const mode of ["dark","light"]){
      const html=page.locator("html");if(await html.getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode)}
      await composer.click();await page.keyboard.press("Control+K");
      await expect(palette.locator(".command-palette-item").first()).toBeVisible();
      await page.keyboard.type("Old task 120",{delay:25});
      await expect(found).toHaveCount(1);
      await expect(found.locator("strong")).toHaveText("Old task 120");
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(found).toBeInViewport();await page.screenshot({animations:"disabled",path:shots+"palette-older-thread-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
      if(mode==="dark"){await page.keyboard.press("Escape");await expect(palette).toBeHidden()}
    }
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator(".workspace-header .thread-title-button strong")).toHaveText("Old task 120");
  }finally{await harness.close()}
});

test("Link pull request refuses a URL that is not a pull request plainly, with the palette open to try again",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  // The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Review the release",preview:"Release"}]});
  // The URL is asked in the app's own question: a browser dialog is noted (and dismissed), as the app asks in its own.
  const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
  try{
    await fixture.open("Review the release");
    const palette=page.locator(".command-palette"),question=page.locator("dialog.inspector-text-prompt");
    for(const pass of ["dark","light"]){
      if(pass==="light"){
        const direct=page.locator("[data-testid=appearance-toggle]:visible").first();await direct.click();
        await expect(page.locator("html")).toHaveAttribute("data-mode","light");
      }
      await pressShortcut(page,"Control+K");await expect(palette).toBeVisible();
      await page.keyboard.type("Link pull request",{delay:8});
      await page.keyboard.press("Enter");
      await expect(question.getByRole("textbox",{name:"Pull request URL"})).toBeFocused();
      await page.keyboard.type("not a url",{delay:8});
      await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);
      await expect(palette.getByRole("alert")).toHaveText("Not a pull request URL");
      await expect(palette.locator("input")).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:`${shots}link-pr-not-a-pr-url-${pass}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
      await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
    }
    expect(nativeDialogs).toEqual([]);
  }finally{await fixture.close()}
});

test("Opening an older thread keeps its place in the thread list and its age, after a reload too",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Refactor payment flow",preview:"Payment"},{name:"Tidy the changelog",preview:"Changelog"},{name:"Fix login redirect",preview:"Login"}]});
  try{
    // The threads were last active 32, 22 and 12 minutes ago.
    const now=Math.floor(Date.now()/1000);
    fixture.threads.forEach((thread,index)=>fixture.threadStore.update(thread.id,{updatedAt:now-1920+index*600},{touch:false}));
    await page.reload();
    const order=()=>page.locator(".thread-row .thread-main").evaluateAll(list=>list.map(node=>node.getAttribute("title")));
    const expected=["Fix login redirect","Tidy the changelog","Refactor payment flow"];
    const oldest=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Refactor payment flow"]')});
    await expect.poll(order).toEqual(expected);await expect(oldest).toContainText("32m");
    await fixture.open("Refactor payment flow");
    await expect(oldest).toHaveClass(/active/);
    await expect.poll(order).toEqual(expected);await expect(oldest).toContainText("32m");
    // The list as the relay keeps it: a reload reads it again.
    await page.reload();
    await expect.poll(order).toEqual(expected);await expect(oldest).toContainText("32m");
    await fixture.open("Refactor payment flow");await expect(oldest).toHaveClass(/active/);
    await expect.poll(order).toEqual(expected);await expect(oldest).toContainText("32m");
    for(const pass of ["dark","light"]){
      if(pass==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:`${shots}open-keeps-thread-place-${pass}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await fixture.close()}
});

// The sidebar names Ctrl+N's destination New task: typed in the palette, that name finds its command (it said "No matching command or
// thread."), as the command's own name does, and Enter on it opens a new task.
test("the palette finds the command for Ctrl+N by New task, the sidebar's name for it, and Enter on it opens a new task",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Review the release",preview:"Release"}]});
  try{
    await fixture.open("Review the release");
    const palette=page.locator(".command-palette"),items=palette.locator(".command-palette-item"),header=page.locator(".workspace-header");
    await expect(nav(page,"New task").locator("kbd")).toHaveText("Ctrl+N");
    for(const pass of ["dark","light"]){
      if(pass==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await pressShortcut(page,"Control+K");await expect(palette).toBeVisible();
      await page.keyboard.type("New task",{delay:25});
      await expect(palette.getByText("No matching command or thread.")).toHaveCount(0);
      await expect(items,"the commands New task finds").toHaveCount(1);
      await expect(items.first()).toHaveClass(/selected/);await expect(items.first().locator("kbd")).toHaveText("Ctrl+N");
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(items.first()).toBeInViewport();await page.screenshot({animations:"disabled",path:`${shots}palette-new-task-${pass}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
      if(pass==="dark"){await page.keyboard.press("Escape");await expect(palette).toHaveCount(0)}
    }
    // Enter runs it: the new task replaces the open thread, with the keyboard in its composer.
    await expect(header).toContainText("Review the release");
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(header).toContainText("New Trebell task");await expect(page.getByTestId("composer")).toBeFocused();
    // The command's own name finds it as before.
    await pressShortcut(page,"Control+K");await expect(palette).toBeVisible();
    await page.keyboard.type("New thread",{delay:25});
    await expect(items).toHaveCount(1);await expect(items.first().locator("kbd")).toHaveText("Ctrl+N");
    await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
  }finally{await fixture.close()}
});

// A Native thread with a reply, in a Git project with a project action, has 25 commands in a browser and 26 in the desktop app (Open
// workspace folder). The palette's list stopped at 24 entries, typed or not, so before anything was typed it never showed Copy
// conversation, nor Settings in the desktop app, and nothing said that more were found by typing.
const ACTION_THREAD_COMMANDS=["New thread","New general chat","Open workspace folder","Recent projects","Files","Changes","Source control","Trebell context","Link pull request","Terminal","Run Start the dev server","Browser","Agents & collaboration","Thread goal","Review changes","Environments","Usage","Open source licenses","Appearance: System","Appearance: Light","Appearance: Dark","Theme: Trebell","Theme: Midnight","Theme: Black","Settings","Copy conversation"];
for(const shell of ["desktop app","browser"]){
  test(`the palette's list before anything is typed holds every command, Settings and Copy conversation among them, to its end by wheel and by keys, in the ${shell}`,async({page})=>{
    test.setTimeout(90_000);
    const desktop=shell==="desktop app",json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    if(desktop)await page.addInitScript(()=>{Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{pickDirectory:async()=>null}})});
    const harness=await startRelayHarness();
    harness.seedThread("Tidy the ledger export",[{user:"Tidy the ledger export",items:[replyItem("reply-ledger","The ledger export is tidy.")]}]);
    await routeRelayApp(page,harness);
    const project={id:"relay-history-project",name:"Relay History Project",path:harness.repo,environmentId:null,effectiveSettings:{},scripts:[{id:"dev",name:"Start the dev server",command:"npm run dev"}]};
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:harness.repo,root:harness.repo,branch:"main",branches:["main"],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    try{
      await page.setViewportSize({width:1280,height:800});
      await page.goto("/");
      await page.locator('.thread-main[title="Tidy the ledger export"]').click();
      await expect(page.locator(".assistant-message-text").last()).toContainText("The ledger export is tidy.");
      await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
      const palette=page.getByTestId("command-palette"),items=palette.locator(".command-palette-item"),results=palette.locator(".command-palette-results"),chosen=palette.locator(".command-palette-item.selected strong");
      const commands=ACTION_THREAD_COMMANDS.filter(label=>desktop||label!=="Open workspace folder");
      // Opened from the composer with Ctrl+K in the desktop app, with Search or jump to in the browser.
      if(desktop){await page.getByTestId("composer").click();await page.keyboard.press("Control+K")}
      else await page.getByRole("button",{name:"Search or jump to"}).click();
      await expect(items.first()).toBeVisible();
      await expect.poll(()=>items.locator("strong").allTextContents(),{message:"the list before anything is typed"}).toEqual(commands);
      // The wheel over the list scrolls it to its end, Copy conversation, whole in view.
      const box=await results.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      for(let turn=0;turn<6;turn++)await page.mouse.wheel(0,500);
      await expect.poll(()=>results.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop)),{message:"how far the list goes on below its view"}).toBeLessThanOrEqual(1);
      await expect(items.last()).toHaveText(/^Copy conversation/);await expect(items.last()).toBeInViewport({ratio:1});
      for(const mode of ["dark","light"]){
        await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
        await page.screenshot({animations:"disabled",path:shots+`palette-every-command-${desktop?"desktop":"browser"}-${mode}-1280.png`});
      }
      await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
      // ArrowDown held from the search box goes down to the last command, in view, in a narrow window too.
      if(!desktop)await page.setViewportSize({width:700,height:800});
      await expect(palette.getByRole("textbox")).toBeFocused();
      for(let press=0;press<commands.length+4;press++)await page.keyboard.press("ArrowDown");
      await expect(chosen).toHaveText("Copy conversation");await expect(chosen).toBeInViewport({ratio:1});
      if(!desktop)await page.screenshot({animations:"disabled",path:shots+"palette-every-command-browser-dark-700.png"});
      // Settings runs from the list as it stands: with ArrowUp and Enter in the desktop app, with a click in the browser.
      if(desktop){await page.keyboard.press("ArrowUp");await expect(chosen).toHaveText("Settings");await page.keyboard.press("Enter")}
      else await items.filter({hasText:/^Settings/}).click();
      await expect(palette).toBeHidden();
      await expect(settingsHeading(page)).toBeVisible();
    }finally{await harness.close()}
  });
}
