import { test,expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

// A local site whose pages name their path, so a test can read which page the preview frame shows.
async function startSite(port=0){
  const server=createServer((req,res)=>{const path=new URL(req.url,"http://site").pathname;res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(`<!doctype html><title>Page ${path}</title><h1>Page ${path}</h1>`)});
  await new Promise((resolve,reject)=>server.listen(port,"127.0.0.1",resolve).once("error",reject));
  const address=server.address();
  return {url:"http://127.0.0.1:"+address.port,port:address.port,close:()=>new Promise(resolve=>server.close(resolve))};
}

// The desktop bridge as desktop/preload.cjs gives it, scripted: an agent browser with a history of its own that reports its state
// after each move, as desktop/main.mjs does, and notes the calls the panel makes (and the sizes it is set to, and how many snapshots
// it took). Its page has two elements to inspect. window.closeAgentWindow() closes its window as a person does outside the panel,
// which the shell reports with its state; the window opened next is another, which its state and its snapshots name (windowId), as
// the shell's do. The window it grants a recording is a canvas that keeps drawing, so the recorder encodes real frames, and
// window.displayMediaCalls counts the recordings of it started.
function scriptedAgentBrowser(){
  const pages=[],listeners=new Set();let at=-1,windowId=1,size={width:1280,height:800};window.agentBrowserCalls=[];window.agentBrowserSizes=[];window.agentSnapshots=0;window.displayMediaCalls=0;
  const current=()=>({open:at>=0,...(at>=0?{windowId}:{}),url:pages[at]||"",title:"",canGoBack:at>0,canGoForward:at>=0&&at<pages.length-1,loading:false,...size});
  const report=()=>{for(const listener of listeners)listener(current())};
  const call=(name,move=()=>{})=>async(...args)=>{window.agentBrowserCalls.push(name);move(...args);report();return current()};
  window.closeAgentWindow=()=>{pages.length=0;at=-1;windowId++;report()};
  Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{
    state:async()=>current(),
    onState:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    navigate:call("navigate",url=>{pages.splice(at+1);pages.push(url);at=pages.length-1}),
    back:call("back",()=>{if(at>0)at--}),
    forward:call("forward",()=>{if(at<pages.length-1)at++}),
    reload:call("reload"),
    snapshot:async()=>{window.agentSnapshots++;return {windowId,url:pages[at]||"",title:"",elements:at<0?[]:[{ref:"e1",tag:"button",text:"Save profile",href:""},{ref:"e2",tag:"a",text:"Docs",href:pages[at]+"/docs"}]}},
    setViewport:call("setViewport",(width,height)=>{size={width,height};window.agentBrowserSizes.push([width,height])}),
    armRecording:async()=>({ok:true,expiresAt:Date.now()+5000,sourceId:"window:1:0"}),
  }}});
  if(navigator.mediaDevices)navigator.mediaDevices.getDisplayMedia=async()=>{
    window.displayMediaCalls++;
    const canvas=document.createElement("canvas");canvas.width=320;canvas.height=200;const context=canvas.getContext("2d");let frame=0;
    const draw=()=>{context.fillStyle=`hsl(${frame++*7%360} 60% 50%)`;context.fillRect(0,0,320,200)};draw();setInterval(draw,33);
    return canvas.captureStream(30);
  };
}

async function openBrowserPanel(page,request){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Preview Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeEnabled({timeout:10_000});
  await page.getByTestId("right-panel-toggle").first().click();
  const panel=page.getByTestId("right-panel");
  await panel.getByRole("button",{name:"Browser",exact:true}).click();
  const address=panel.getByRole("textbox",{name:"Page address"});
  await expect(address).toBeVisible();
  return {panel,address,frame:page.frameLocator('iframe[title="Trebell preview"]')};
}

// Types an address over the one in the bar (or a size over the one in a device toolbar field), as a person does.
async function typeAddress(page,address,value){await address.click();await page.keyboard.press("Control+A");await page.keyboard.type(value,{delay:8})}

// Dark and light screenshots at 1280x800 and 900 wide, each with show (the part of the panel the shot is for) scrolled into view. The
// mode is switched with the header's appearance toggle at 1280: at 900 the open right panel lies over the header and its appearance
// toggle, so a person widens the window to reach it.
async function shots(page,name,show=null){
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await show?.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+".png"})}
  }
  await page.setViewportSize({width:1280,height:800});
  await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
}

test("Back and Forward step through the pages the preview showed, and leave the agent browser's history alone",async({page,request})=>{
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address,frame}=await openBrowserPanel(page,request);
    const back=panel.getByTitle("Back"),forward=panel.getByTitle("Forward"),heading=frame.locator("h1");
    await expect(back).toBeDisabled();
    // The agent browser opens /a and then /b, and the preview shows each; then an address typed in the bar is previewed.
    await typeAddress(page,address,site.url+"/a");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await expect(heading).toHaveText("Page /a");
    await typeAddress(page,address,site.url+"/b");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await expect(heading).toHaveText("Page /b");
    await typeAddress(page,address,site.url+"/c");await page.keyboard.press("Enter");
    await expect(heading).toHaveText("Page /c");
    await back.click();
    await expect(heading,"Back shows the page the preview showed before the typed one").toHaveText("Page /b");
    await expect(address).toHaveValue(site.url+"/b");
    await shots(page,"preview-back-to-previous-page");
    await back.click();
    await expect(heading).toHaveText("Page /a");
    await expect(back).toBeDisabled();
    await forward.click();
    await expect(heading).toHaveText("Page /b");
    await forward.click();
    await expect(heading).toHaveText("Page /c");
    await expect(address).toHaveValue(site.url+"/c");
    await expect(forward).toBeDisabled();
    expect(await page.evaluate(()=>window.agentBrowserCalls),"the agent browser was only asked to open its two pages").toEqual(["navigate","navigate"]);
  }finally{await site.close()}
});

test("an address where nothing answers says so instead of showing a blank frame, and shows its page once a server is up",async({page,request})=>{
  // A port that was just let go has nothing listening on it.
  const gone=await startSite();const port=gone.port;await gone.close();
  const {panel,address,frame}=await openBrowserPanel(page,request);
  const where="http://127.0.0.1:"+port+"/",notice=panel.getByRole("alert").filter({hasText:"Nothing answered"});
  await typeAddress(page,address,where);await page.keyboard.press("Enter");
  await expect(notice).toContainText("Nothing answered at "+where);
  await expect(panel.locator('iframe[title="Trebell preview"]')).toHaveCount(0);
  await shots(page,"preview-nothing-answered");
  // Once a server listens there, Preview asks again and the page shows.
  const site=await startSite(port);
  try{
    await panel.getByRole("button",{name:"Preview",exact:true}).click();
    await expect(frame.locator("h1")).toHaveText("Page /");
    await expect(notice).toHaveCount(0);
  }finally{await site.close()}
});

// A recording records the agent browser's window, not the panel, so it goes on while the person looks at another tab or closes the
// panel (with its X, opening it again with Ctrl+Alt+B, or with Escape in a narrow window), and Stop then saves it. A look at Files
// used to end it unsaved: back on Browser the button read Record, and nothing said so.
test("a recording goes on while the person looks at another tab or closes the panel, and Stop then saves it",async({page,request})=>{
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address,frame}=await openBrowserPanel(page,request);
    const tabs=panel.locator(".context-panel-tab-scroll"),record=panel.locator(".browser-device-toolbar button.recording"),saved=page.getByTestId("context-chip").filter({hasText:"Browser recording"});
    await typeAddress(page,address,site.url+"/rec");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await expect(frame.locator("h1")).toHaveText("Page /rec");
    await record.click();
    await expect(record).toHaveText(/Stop [1-9]\d*s/);
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(address).toHaveCount(0);
    await tabs.getByRole("button",{name:"Browser, recording",exact:true}).click();
    await expect(record,"back on Browser after a look at Files, the recording is still going").toHaveText(/Stop \d+s/);
    await panel.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await page.keyboard.press("Control+Alt+B");
    await expect(record,"after the panel was closed and opened again with Ctrl+Alt+B").toHaveText(/Stop \d+s/);
    // In a narrow window the panel lies over the conversation, and Escape closes it. Escape is pressed once the panel has taken focus,
    // as it does when the window makes it a drawer, by when the drawer listens for Escape: pressed as soon as the dimmed area showed,
    // it came before the drawer listened for it in one run of five or so, and the panel stayed open.
    await page.setViewportSize({width:900,height:800});
    await expect(page.getByTestId("inspector-scrim")).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>!!document.activeElement?.closest("[data-testid=right-panel]")),"the drawer takes focus").toBe(true);
    await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
    await page.getByTestId("right-panel-toggle").first().click();
    await expect(record,"after Escape closed the panel in a narrow window").toHaveText(/Stop \d+s/);
    await shots(page,"preview-recording-goes-on-after-files-tab");
    await expect(saved).toHaveCount(0);
    await record.click();
    await expect(saved,"Stop saves the recording once").toHaveCount(1);
    await expect(record).toHaveText(/Record/);
  }finally{await site.close()}
});

// A recording that goes on while the Browser panel is away had no sign of itself anywhere outside the panel: the tab strip, the
// sidebar and the header looked as with none, so a person who went on with other work kept recording the agent browser's window.
// The panel's Browser tab says so while another tab is shown, and the header button that opens the panel while it is closed (also
// on a page, and in a narrow window), each with a red mark and in its name, until the recording stops.
test("a recording that goes on while the Browser panel is away is said on the panel's Browser tab and on the header button that opens the panel, until it stops",async({page,request})=>{
  const site=await startSite();
  try{
    const {panel,record,saved}=await openRecorder(page,request,site);
    const tabs=panel.locator(".context-panel-tab-scroll"),browserTab=tabs.getByRole("button",{name:/^Browser/}),toggle=page.getByTestId("right-panel-toggle").first();
    const marked=async(button,name)=>{await expect(button).toHaveAccessibleName(name);await expect(button.locator(".recording-mark")).toBeVisible()};
    const unmarked=async(button,name)=>{await expect(button).toHaveAccessibleName(name);await expect(button.locator(".recording-mark")).toHaveCount(0)};
    await unmarked(browserTab,"Browser");await unmarked(toggle,"Open files and diff");
    await record.click();await expect(record).toHaveText(/Stop [1-9]\d*s/);
    // On another tab, the Browser tab says a recording is on.
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(record).toHaveCount(0);
    await marked(browserTab,"Browser, recording");await expect(browserTab).toHaveAttribute("title","Browser · Recording");
    await shots(page,"preview-recording-said-on-browser-tab",browserTab);
    // With the panel closed, the header button that opens it says so, on a page too.
    await panel.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await marked(toggle,"Open files and diff, browser recording on");await expect(toggle).toHaveAttribute("title","Toggle workspace panel · Browser recording on");
    await shots(page,"preview-recording-said-on-panel-button");
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Projects"}).click();
    await expect(page.getByTestId("page-topbar")).toBeVisible();
    await marked(page.getByTestId("page-topbar").getByTestId("right-panel-toggle"),"Open files and diff, browser recording on");
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();await expect(page.getByTestId("page-topbar")).toHaveCount(0);
    // In a narrow window the closed panel's button says so too; it opens the panel, whose Browser tab says so, and Browser there stops it.
    await page.setViewportSize({width:900,height:800});
    await marked(toggle,"Open files and diff, browser recording on");
    await toggle.click();await expect(panel).toBeVisible();
    await marked(browserTab,"Browser, recording");await browserTab.click();
    await expect(record).toHaveText(/Stop \d+s/);await record.click();
    await expect(saved,"Stop saves the recording once").toHaveCount(1);await expect(record).toHaveText(/Record/);
    // Once it is saved, neither says a recording is on.
    await unmarked(browserTab,"Browser");
    await page.setViewportSize({width:1280,height:800});
    await unmarked(toggle,"Open files and diff");
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await unmarked(browserTab,"Browser");
  }finally{await site.close()}
});

// The server is slow to store what the page attaches ("text" or "blob"), or only the text whose file name ends so (an element's own,
// "-e1.txt"), until store() is called, as one slow to answer is (an SSH or WSL environment's copy); store.reached settles once the
// page has asked it to store something, and store.asked() says whether it has, so a check that the page sends what it attaches can
// wait for that with a message of its own and the expect timeout: an attach the page never sends leaves store.reached unsettled
// until the test times out, naming nothing.
async function slowStore(page,kind,named=""){let store=()=>{},reach=()=>{},asked=false;const stored=new Promise(resolve=>{store=resolve}),reached=new Promise(resolve=>{reach=resolve});await page.route("**/api/attachments/"+kind,async route=>{if(named&&!route.request().postDataJSON()?.name?.endsWith(named))return route.fallback();asked=true;reach();await stored;await route.continue()});return Object.assign(()=>store(),{reached,asked:()=>asked})}

// Opens the agent browser on the site's /rec page, with Record in the device toolbar.
async function openRecorder(page,request,site){
  await page.addInitScript(scriptedAgentBrowser);
  const {panel,address,frame}=await openBrowserPanel(page,request);
  await typeAddress(page,address,site.url+"/rec");await panel.getByRole("button",{name:"Open agent browser"}).click();
  await expect(frame.locator("h1")).toHaveText("Page /rec");
  return {panel,record:panel.locator(".browser-device-toolbar button.recording"),saved:page.getByTestId("context-chip").filter({hasText:"Browser recording"})};
}

// A double click on Stop, or Enter pressed twice or held on it, saves the recording once and says nothing went wrong: the second
// press came while the first was saving it (Enter pressed twice while the server was slow to store it), and saved it again or, when
// the first had taken what was recorded, said the recording produced no video; and the repeats of Enter held came once it was saved,
// on Record, and started another. Each check of what a stop did waits for the next recording to run a second, so a second save has
// landed.
test("a double click on Stop, or Enter pressed twice or held on it, saves the recording once",async({page,request})=>{
  test.setTimeout(60_000);
  const site=await startSite();
  try{
    const {panel,record,saved}=await openRecorder(page,request,site);
    const presses=["double click","Enter pressed twice","Enter held"],status=panel.locator('[data-testid="browser-cookie-status"], .browser-action-error');
    for(const [index,how] of [...presses,"click"].entries()){
      await record.click();
      await expect(record,index?"after the "+presses[index-1]+" on Stop, Record starts a recording":undefined).toHaveText(/Stop [1-9]\d*s/);
      await expect(saved,index?"the "+presses[index-1]+" on Stop saved the recording once":undefined).toHaveCount(index);
      await expect(status,index?"the "+presses[index-1]+" on Stop says nothing went wrong":undefined).toHaveCount(0);
      if(how==="double click")await record.dblclick({delay:60});
      else if(how==="Enter pressed twice"){const store=await slowStore(page,"blob");await record.focus();await page.keyboard.press("Enter");await page.keyboard.press("Enter");store()}
      else if(how==="Enter held"){await record.focus();await page.keyboard.down("Enter");await expect(record).toHaveText(/Record/);await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter")}
      else await record.click();
      await expect(record).toHaveText(/Record/);
      if(!index)await shots(page,"preview-stop-double-click-saves-once");
    }
    await expect(saved).toHaveCount(presses.length+1);await expect(status).toHaveCount(0);
  }finally{await site.close()}
});

// A double click on Record starts one recording, which goes on: once the shell had armed it, the second click landed on Stop, which
// stopped it at once and attached a recording of no length.
test("a double click on Record starts one recording that goes on",async({page,request})=>{
  test.setTimeout(60_000);
  const site=await startSite();
  try{
    const {panel,record,saved}=await openRecorder(page,request,site);
    // The shell arms the recording in 30 ms, before the second click comes.
    await page.evaluate(()=>{const browser=window.trebellDesktop.browser,arm=browser.armRecording;browser.armRecording=async()=>{await new Promise(resolve=>setTimeout(resolve,30));return arm()}});
    await record.dblclick({delay:120});
    await expect(record,"the double click on Record started a recording that goes on").toHaveText(/Stop [1-9]\d*s/);
    await expect(saved).toHaveCount(0);await expect(panel.getByTestId("browser-cookie-status")).toHaveCount(0);await expect(panel.locator(".browser-action-error")).toHaveCount(0);
    await shots(page,"preview-record-double-click-goes-on");
    await record.click();await expect(record).toHaveText(/Record/);await expect(saved).toHaveCount(1);
  }finally{await site.close()}
});

// A panel opened again while a recording is starting (the shell takes its time to arm it) offers no second Record, and shows the
// recording once it has started. It read Record, and a press there started a second recording of the window, whose frames went
// into the first one's file.
test("a Browser panel opened again while a recording is starting offers no second Record, and shows the recording once it has started",async({page,request})=>{
  test.setTimeout(60_000);
  const site=await startSite();
  try{
    const {panel,record,saved}=await openRecorder(page,request,site),tabs=panel.locator(".context-panel-tab-scroll");
    await page.evaluate(()=>{const browser=window.trebellDesktop.browser,arm=browser.armRecording;browser.armRecording=async()=>{await new Promise(resolve=>{window.armRecordingNow=resolve});return arm()}});
    await record.click();await expect(record).toBeDisabled();
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(record).toHaveCount(0);
    await tabs.getByRole("button",{name:"Browser",exact:true}).click();
    await expect(record,"the panel opened again while the recording starts offers no second Record").toBeDisabled();
    await expect(record).toHaveText(/Record/);
    await page.evaluate(()=>window.armRecordingNow());
    await expect(record,"the panel opened again shows the recording once it has started").toHaveText(/Stop [1-9]\d*s/);
    await shots(page,"preview-recording-started-while-away");
    await record.click();await expect(saved).toHaveCount(1);await expect(record).toHaveText(/Record/);
    expect(await page.evaluate(()=>window.displayMediaCalls),"one recording of the window was started").toBe(1);
  }finally{await site.close()}
});

// A panel opened again while a recording is being saved (the server is slow to store it) says so and offers no Stop, and reads
// Record once it is saved. It read Stop: a press there saved the recording again or did nothing, and it read Stop until the panel
// was opened once more.
test("a Browser panel opened again while a recording is being saved says so, saves nothing more, and reads Record once it is saved",async({page,request})=>{
  test.setTimeout(60_000);
  const site=await startSite();
  try{
    const {panel,record,saved}=await openRecorder(page,request,site),tabs=panel.locator(".context-panel-tab-scroll");
    await record.click();await expect(record).toHaveText(/Stop [1-9]\d*s/);
    const store=await slowStore(page,"blob");
    await record.click();await store.reached;
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(record).toHaveCount(0);
    await tabs.getByRole("button",{name:"Browser",exact:true}).click();
    await expect.soft(record,"the panel opened again while the recording is saved says so").toHaveText(/Saving/);
    await expect.soft(record,"the panel opened again while the recording is saved offers no Stop").toBeDisabled();
    await shots(page,"preview-recording-saved-while-away");
    store();
    await expect(saved,"the recording is saved once").toHaveCount(1);
    await expect(record,"the panel opened again reads Record once the recording is saved").toHaveText(/Record/);
    await expect(record).toBeEnabled();
  }finally{await site.close()}
});

// What the Browser panel shows stays while the person looks at another tab or closes the panel, and comes back as it was left: the
// address as typed, the page previewed with Back to the one before, the agent browser's elements with the one chosen and the note
// begun on it, and the zoom. It used to come back as at first (http://localhost:3000, No preview open) while the agent browser still
// showed the page.
test("the Browser panel comes back as it was left after a look at another tab or with the panel closed and opened again",async({page,request})=>{
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address,frame}=await openBrowserPanel(page,request);
    const tabs=panel.locator(".context-panel-tab-scroll"),elements=panel.locator(".browser-elements button"),annotation=panel.getByTestId("preview-annotation"),note=annotation.getByRole("textbox");
    await typeAddress(page,address,site.url+"/first");await page.keyboard.press("Enter");
    await expect(frame.locator("h1")).toHaveText("Page /first");
    await typeAddress(page,address,site.url+"/second");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await expect(frame.locator("h1")).toHaveText("Page /second");
    await panel.getByRole("button",{name:"Inspect elements"}).click();
    await elements.filter({hasText:"Save profile"}).click();
    await page.keyboard.press("Control+Equal");
    await expect(address).toHaveAttribute("title","Preview zoom 110%");
    await note.click();await page.keyboard.type("Make this say Save changes.",{delay:8});
    await typeAddress(page,address,site.url+"/typed-not-sent");
    const asLeft=async how=>{
      await expect(address,how).toHaveValue(site.url+"/typed-not-sent");
      await expect(address).toHaveAttribute("title","Preview zoom 110%");
      await expect(frame.locator("h1")).toHaveText("Page /second");
      await expect(panel.getByTitle("Back",{exact:true})).toBeEnabled();
      await expect(panel.getByRole("button",{name:"Open in browser"})).toBeVisible();
      await expect(elements).toHaveCount(2);
      await expect(annotation).toContainText("Annotate e1");
      await expect(note).toHaveValue("Make this say Save changes.");
    };
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(address).toHaveCount(0);
    await tabs.getByRole("button",{name:"Browser",exact:true}).click();
    await asLeft("after a look at Files");
    await panel.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await page.getByTestId("right-panel-toggle").first().click();
    await asLeft("after the panel was closed and opened again");
    await shots(page,"preview-panel-as-left-after-files-tab");
  }finally{await site.close()}
});

// An agent browser whose window closes outside the panel (the person closes it, which the shell reports with its state) takes its
// page's elements with it, as the panel's own Close does, so Attach context can no longer attach one; so does one that closes while
// the panel is on another tab. They used to stay listed, and Attach context attached the gone page's element.
test("an agent browser closed outside the panel takes its page's elements with it, so none of them can be attached",async({page,request})=>{
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address}=await openBrowserPanel(page,request);
    const tabs=panel.locator(".context-panel-tab-scroll"),elements=panel.locator(".browser-elements button"),attach=panel.getByRole("button",{name:"Attach context",exact:true});
    const none=panel.getByText("Open the agent browser and inspect the page to see model-addressable elements.");
    const chooseElement=async()=>{
      await panel.getByRole("button",{name:"Open agent browser"}).click();await panel.getByRole("button",{name:"Inspect elements"}).click();
      await elements.filter({hasText:"Save profile"}).click();await expect(attach).toBeVisible();
    };
    await typeAddress(page,address,site.url+"/rec");
    await chooseElement();
    await page.evaluate(()=>window.closeAgentWindow());
    await expect(elements,"the gone page's elements are no longer listed").toHaveCount(0);
    await expect(attach).toHaveCount(0);await expect(none).toBeVisible();
    await expect(page.getByTestId("context-chip").filter({hasText:"Browser e1"})).toHaveCount(0);
    await shots(page,"preview-agent-window-closed-outside");
    // The window closes while the panel is on Files.
    await chooseElement();
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(address).toHaveCount(0);
    await page.evaluate(()=>window.closeAgentWindow());
    await tabs.getByRole("button",{name:"Browser",exact:true}).click();
    await expect(none,"closed while the panel was on Files").toBeVisible();await expect(elements).toHaveCount(0);await expect(attach).toHaveCount(0);
  }finally{await site.close()}
});

// The agent browser's elements the panel keeps are those of the page they were read on, in that window. A page it no longer shows
// takes them with it: its window closed while the panel was on Files and opened again on the same address before the panel came
// back (the agent's open, or the tray's Open Agent Browser, which no panel hears), a page the agent opened while the panel was on
// Files, and one it opens while the panel is open. They came back, and Attach context attached the gone page's element, whose ref
// the next snapshot gives to another element. A page the panel's own Open agent browser opens while the panel is on Files comes
// back with that page and its elements: the panel came back on the page before, listing its elements.
test("the agent browser's elements go with the page they were read on, also while the panel is away",async({page,request})=>{
  test.setTimeout(120_000);
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address,frame}=await openBrowserPanel(page,request);
    const tabs=panel.locator(".context-panel-tab-scroll"),elements=panel.locator(".browser-elements button"),attach=panel.getByRole("button",{name:"Attach context",exact:true});
    const none=panel.getByText("Open the agent browser and inspect the page to see model-addressable elements.");
    const agentOpens=to=>page.evaluate(url=>window.trebellDesktop.browser.navigate(url),site.url+to);
    const chooseElement=async()=>{await panel.getByRole("button",{name:"Inspect elements"}).click();await elements.filter({hasText:"Save profile"}).click();await expect(attach).toBeVisible()};
    const toFiles=async()=>{await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(address).toHaveCount(0)};
    const toBrowser=async()=>{await tabs.getByRole("button",{name:"Browser",exact:true}).click();await expect(address).toBeVisible()};
    const gone=async how=>{await expect.soft(none,how).toBeVisible();await expect.soft(elements,how).toHaveCount(0);await expect.soft(attach,how).toHaveCount(0)};
    await typeAddress(page,address,site.url+"/rec");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await expect(frame.locator("h1")).toHaveText("Page /rec");
    await chooseElement();await toFiles();
    await page.evaluate(()=>window.closeAgentWindow());await agentOpens("/rec");
    await toBrowser();
    await gone("the window closed and opened again on the same address while the panel was on Files");
    await shots(page,"preview-agent-page-gone-while-away");
    await chooseElement();await toFiles();
    await agentOpens("/next");
    await toBrowser();
    await gone("the agent opened another page while the panel was on Files");
    await chooseElement();
    await agentOpens("/later");
    await gone("the agent opened another page while the panel was open");
    // Open agent browser is pressed for /b, and Files is clicked before /b has loaded; /b loads, and its elements are read, while
    // the panel is on Files.
    await chooseElement();
    await page.evaluate(()=>{const browser=window.trebellDesktop.browser,navigate=browser.navigate;browser.navigate=async(...args)=>{await new Promise(resolve=>{window.loadNow=resolve});browser.navigate=navigate;return navigate(...args)}});
    await typeAddress(page,address,site.url+"/b");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await toFiles();
    const snapshots=await page.evaluate(()=>window.agentSnapshots);
    await page.evaluate(()=>window.loadNow());
    await expect.poll(()=>page.evaluate(()=>window.agentSnapshots)).toBe(snapshots+1);
    await toBrowser();
    await expect.soft(frame.locator("h1"),"the page Open agent browser opened while the panel was on Files is previewed").toHaveText("Page /b");
    await expect.soft(panel.locator(".browser-inspector p span"),"and its elements are listed").toHaveText(site.url+"/b");
    await expect(elements).toHaveCount(2);
    await expect.soft(panel.getByTestId("preview-annotation"),"the element chosen on the page before is not chosen on /b").toHaveCount(0);
    await shots(page,"preview-agent-page-opened-while-away");
  }finally{await site.close()}
});

// A double click on Attach context attaches the element once, as do a double click on Attach annotation and Enter pressed twice on
// Attach context while the server is slow to store the first attach (so the second press comes while it is on its way, at a button
// still enabled), and Enter held on Attach context, whose repeats come once the first attach has landed: each attached it again.
// Each count is read once the next attach has landed, as a second would have, and each is a check of its own, so a run on a build
// that attaches twice says which of them did.
test("a double click on Attach context, or Enter pressed twice or held on it, attaches the element once",async({page,request})=>{
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address}=await openBrowserPanel(page,request);
    const elements=panel.locator(".browser-elements button"),annotation=panel.getByTestId("preview-annotation"),note=annotation.getByRole("textbox");
    const attach=annotation.getByRole("button",{name:"Attach context",exact:true}),attachNote=annotation.getByRole("button",{name:"Attach annotation",exact:true});
    const attached=label=>page.getByTestId("context-chip").filter({hasText:label}),status=annotation.locator(".annotation-actions span");
    await typeAddress(page,address,site.url+"/rec");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await panel.getByRole("button",{name:"Inspect elements"}).click();
    await elements.filter({hasText:"Save profile"}).click();
    await attach.dblclick({delay:60});
    await expect(status).toHaveText("Element context attached");
    await elements.filter({hasText:"Docs"}).click();
    await note.click();await page.keyboard.type("Point this at the API docs.",{delay:8});
    let store=await slowStore(page,"text");
    await attachNote.dblclick({delay:60});store();
    await expect(note).toHaveValue("");await expect(status).toHaveText("Annotation attached");
    await expect.soft(attached("Browser e1"),"the double click on Attach context attached e1 once").toHaveCount(1);
    await shots(page,"preview-attach-context-double-click-once");
    store=await slowStore(page,"text");
    await attach.focus();await page.keyboard.press("Enter");await page.keyboard.press("Enter");store();
    await expect(status).toHaveText("Element context attached");
    await expect.soft(attached("Annotated e2"),"the double click on Attach annotation attached the note once").toHaveCount(1);
    // Enter held on Attach context for e1: its repeats come once the first attach has landed.
    await elements.filter({hasText:"Save profile"}).click();await expect(status).toHaveCount(0);
    const e1=await attached("Browser e1").count();
    await attach.focus();await page.keyboard.down("Enter");await expect(status).toHaveText("Element context attached");
    await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");
    await expect.soft(attached("Browser e2"),"Enter pressed twice on Attach context attached e2 once").toHaveCount(1);
    const e2=await attached("Browser e2").count();
    await elements.filter({hasText:"Docs"}).click();await attach.click();
    await expect(attached("Browser e2")).toHaveCount(e2+1);
    await expect.soft(attached("Browser e1"),"Enter held on Attach context attached e1 once more").toHaveCount(e1+1);
  }finally{await site.close()}
});

// An element attached while another's attach is still on its way (the server is slow to store it) is attached too, and the two
// land one at a time, in each order: the one that lands first says so only under its own element, the other's landing after it
// leaves its notice, and the note typed for the element chosen since stays. One guard for every attach left the second undone, the
// first one's notice read as the second's, and the first one's note emptied the second's; and one notice for every element went to
// whichever attach landed last, so e1's landing after e2's took away the notice under e2.
test("an element attached while another's attach is on its way is attached too, and the other's landing, before or after its own, neither says it was attached nor takes away its notice or empties its note",async({page,request})=>{
  test.setTimeout(60_000);
  const site=await startSite();
  try{
    await page.addInitScript(scriptedAgentBrowser);
    const {panel,address}=await openBrowserPanel(page,request);
    const elements=panel.locator(".browser-elements button"),annotation=panel.getByTestId("preview-annotation"),note=annotation.getByRole("textbox");
    const attach=annotation.getByRole("button",{name:"Attach context",exact:true}),attachNote=annotation.getByRole("button",{name:"Attach annotation",exact:true});
    const attached=label=>page.getByTestId("context-chip").filter({hasText:label}),status=annotation.locator(".annotation-actions span"),choose=text=>elements.filter({hasText:text}).click();
    await typeAddress(page,address,site.url+"/rec");await panel.getByRole("button",{name:"Open agent browser"}).click();
    await panel.getByRole("button",{name:"Inspect elements"}).click();
    // e1's attach is on its way when e2 is chosen and attached; e1's lands first, and the next time e2's does.
    for(const [round,[first,second]] of [["e1","e2"],["e2","e1"]].entries()){
      const held={e1:await slowStore(page,"text","-e1.txt"),e2:await slowStore(page,"text","-e2.txt")};
      const land=ref=>{held[ref]();return expect(attached("Browser "+ref),ref+" is attached").toHaveCount(round+1)};
      await choose("Save profile");await attach.click();await expect.poll(held.e1.asked,"e1's attach is on its way").toBe(true);
      await choose("Docs");await attach.click();await expect.poll(held.e2.asked,"e2, attached while e1's attach is on its way, is attached too").toBe(true);
      await land(first);
      if(first==="e1")await expect.soft(status,"e1's attach landing says nothing under e2, whose attach is on its way").toHaveCount(0);
      else await expect(status,"e2's attach landing says so under e2").toHaveText("Element context attached");
      await land(second);
      await expect.soft(status,`e2 reads that it was attached once ${second}'s attach has landed after ${first}'s`).toHaveText("Element context attached");
      if(first==="e2")await shots(page,"preview-attach-landing-after-another-keeps-its-notice",annotation);
    }
    // e1's attach lands while e2 is chosen and not attached.
    let store=await slowStore(page,"text");
    await choose("Save profile");await attach.click();await store.reached;
    await choose("Docs");store();
    await expect(attached("Browser e1")).toHaveCount(3);
    await expect.soft(status,"e1's attach landing says nothing under e2").toHaveCount(0);
    await shots(page,"preview-attach-while-another-on-its-way",annotation);
    // e1's note is on its way when e2 is chosen and a note of its own is typed.
    store=await slowStore(page,"text");
    await choose("Save profile");await typeAddress(page,note,"Make this say Save changes.");await attachNote.click();await store.reached;
    await choose("Docs");await typeAddress(page,note,"Point this at the API docs.");store();
    await expect(attached("Annotated e1")).toHaveCount(1);
    await expect.soft(note,"e1's note landing leaves the note typed for e2").toHaveValue("Point this at the API docs.");
    await expect(attachNote).toBeEnabled();
  }finally{await site.close()}
});

// A width or height typed in the device toolbar applies when Enter is pressed, as the address bar's Enter opens the address and as
// leaving the field does: Enter did nothing, and the size waited for the field to be left.
test("Enter in the viewport width or height field sizes the agent browser, as leaving the field does",async({page,request})=>{
  await page.addInitScript(scriptedAgentBrowser);
  const {panel}=await openBrowserPanel(page,request);
  const width=panel.getByRole("spinbutton",{name:"Viewport width"}),height=panel.getByRole("spinbutton",{name:"Viewport height"}),preset=panel.getByRole("combobox",{name:"Viewport preset"});
  const size=()=>page.evaluate(()=>window.agentBrowserSizes.at(-1)||null);
  await typeAddress(page,width,"390");await page.keyboard.press("Enter");
  await expect.poll(size,"Enter in the width field sizes the agent browser").toEqual([390,800]);
  await expect(width).toBeFocused();
  await typeAddress(page,height,"844");await page.keyboard.press("Enter");
  await expect.poll(size,"Enter in the height field sizes the agent browser").toEqual([390,844]);
  await expect(preset,"the size typed is the Mobile preset's").toHaveValue("mobile");
  // A width under the least the agent browser takes is raised to it, which the field shows.
  await typeAddress(page,width,"50");await page.keyboard.press("Enter");
  await expect(width).toHaveValue("320");await expect(preset).toHaveValue("custom");
  await expect.poll(size).toEqual([320,844]);
  await shots(page,"preview-viewport-width-enter");
  // Leaving the field still applies what was typed.
  await typeAddress(page,height,"700");await page.keyboard.press("Tab");
  await expect.poll(size,"leaving the height field sizes the agent browser").toEqual([320,700]);
});

// The address bar draws an address as it was typed: JetBrains Mono's ligatures, with the Inter features the body sets, drew http://
// as http: / in every address, in dark and in light. The bar is shot as the person sees it and again with the font's ligatures
// turned off on the field, which draws each character as it is: the two must be the same.
test("the address bar draws each address as typed, with both slashes of http://",async({page,request})=>{
  test.setTimeout(60_000);
  const {address}=await openBrowserPanel(page,request);
  await page.evaluate(()=>document.fonts.load('11.5px "JetBrains Mono Variable"',"http://"));
  for(const mode of ["dark","light"]){
    if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const typed of ["http://127.0.0.1:5173/app","http://localhost:5173/app","https://example.com/docs","http://192.168.1.20:8080/"]){
      await typeAddress(page,address,typed);await page.keyboard.press("Tab");await expect(address).not.toBeFocused();
      const drawn=await address.screenshot({animations:"disabled"});
      await address.evaluate(field=>{field.style.fontVariantLigatures="none"});
      const asTyped=await address.screenshot({animations:"disabled"});
      await address.evaluate(field=>{field.style.fontVariantLigatures=""});
      if(!drawn.equals(asTyped))for(const [shown,body] of [["drawn",drawn],["as-typed",asTyped]])writeFileSync(test.info().outputPath(mode+"-"+shown+".png"),body);
      expect(drawn.equals(asTyped),typed+" is drawn as typed in "+mode).toBe(true);
    }
  }
  await shots(page,"preview-address-drawn-as-typed");
});

// An action's preview address opens the Browser on its page the first time the panel is drawn, whose part only loads then: from Open
// preview on the action's card, and from the header button of an action set to open its preview when it runs. The page also tells
// a frame that loaded the address from the default one, which shows nothing.
async function openWithPreviewAction(page,request,site,{autoOpenPreview}){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  const script={id:"dev-server",name:"Dev server",command:"npm run dev",previewUrl:site.url+"/dev",autoOpenPreview,runOnWorktreeCreate:false,waitForSetup:false};
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Preview Workspace",activate:true,scripts:[script],preferredScriptId:script.id}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  return boot;
}
async function expectActionPreview(page,site){
  const panel=page.getByTestId("right-panel");
  await expect(panel.getByRole("textbox",{name:"Page address"})).toHaveValue(site.url+"/dev");
  await expect(page.frameLocator('iframe[title="Trebell preview"]').locator("h1")).toHaveText("Page /dev");
  await expect(panel.getByText("No preview open",{exact:true})).toHaveCount(0);
}

test("Open preview on an action's card opens the Browser on the action's address the first time",async({page,request})=>{
  const site=await startSite();let boot=null;
  try{
    boot=await openWithPreviewAction(page,request,site,{autoOpenPreview:false});
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator(".project-action-row").filter({hasText:"Dev server"}).getByTitle("Open preview").click();
    await expectActionPreview(page,site);
    await page.screenshot({animations:"disabled",path:auditDir+"preview-action-card-first-open-dark.png"});
  }finally{if(boot)await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}});await site.close()}
});

test("an action set to open its preview when it runs opens the Browser on the action's address the first time, from the header",async({page,request})=>{
  const site=await startSite();let boot=null;
  try{
    boot=await openWithPreviewAction(page,request,site,{autoOpenPreview:true});
    await page.locator(".workspace-header").getByRole("button",{name:"Dev server",exact:true}).click();
    await expectActionPreview(page,site);
    await page.screenshot({animations:"disabled",path:auditDir+"preview-action-header-first-open-dark.png"});
  }finally{if(boot)await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}});await site.close()}
});

// The agent browser's imports as desktop/preload.cjs gives them, scripted: the first Import cookie JSON is given a file that is not
// JSON and fails with the shell's reason (desktop/main.mjs), the next imports, and Import profile skips and fails some cookies.
function scriptedBrowserImports(reason){
  window.__cookieImports=0;
  Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{
    state:async()=>({open:false,url:"",title:"",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800}),
    onState:()=>()=>{},
    snapshot:async()=>({url:"",title:"",elements:[]}),
    importCookies:async()=>{if(++window.__cookieImports===1)throw new Error(reason);return {ok:true,canceled:false,source:"file",imported:2,failed:0,errors:[]}},
    importSources:async()=>({platform:"win32",sources:[{id:"firefox",name:"Firefox",installed:true,running:false,profiles:[{id:"C:/Profiles/Work",name:"Work profile"}]}]}),
    importProfile:async(sourceId,profileId)=>({ok:true,sourceId,profileId,profileName:"Work profile for the staging dashboards",imported:41,failed:3,skipped:12}),
  }}});
}

test("a cookie import that fails says why in full, in the error colour and as an alert, and a long import notice wraps instead of being cut",async({page,request})=>{
  const reason="cookies-exported-from-the-work-browser-profile-2026-10-15.json is not valid JSON.";
  await page.addInitScript(scriptedBrowserImports,reason);
  const {panel}=await openBrowserPanel(page,request);
  await panel.getByRole("button",{name:"Import cookie JSON"}).click();
  const failure=panel.getByText("Cookie import failed: "+reason,{exact:true});
  await expect(failure).toBeVisible();
  // All of it reads: the line wraps instead of cutting the reason off.
  expect(await failure.evaluate(node=>node.scrollWidth-node.clientWidth),"none of the reason is cut off").toBeLessThanOrEqual(1);
  // It is announced as the error it is, in the app's error colour in both modes.
  await expect(panel.getByRole("alert").filter({hasText:"Cookie import failed"})).toHaveText("Cookie import failed: "+reason);
  for(const mode of ["dark","light"]){
    if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    const colours=await failure.evaluate(node=>{const probe=document.createElement("span");probe.style.color="var(--err)";document.body.append(probe);const err=getComputedStyle(probe).color;probe.remove();return {shown:getComputedStyle(node).color,err}});
    expect(colours.shown,`the failure is in the error colour in ${mode} mode`).toBe(colours.err);
  }
  await shots(page,"browser-cookie-import-failed");
  // The next import that works replaces the failure with its notice.
  await panel.getByRole("button",{name:"Import cookie JSON"}).click();
  const notice=panel.getByTestId("browser-cookie-status");
  await expect(notice).toHaveText("Imported 2 cookies");
  await expect(notice).toHaveAttribute("role","status");
  await expect(failure).toHaveCount(0);
  // A notice too long for one line wraps, so all of it reads too.
  await panel.getByRole("button",{name:"Import profile"}).click();
  await panel.getByTestId("browser-profile-import").getByRole("button",{name:/Work profile/}).click();
  await expect(notice).toHaveText("Imported 41 cookies from Work profile for the staging dashboards · 12 encrypted/partitioned skipped · 3 failed");
  expect(await notice.evaluate(node=>node.scrollWidth-node.clientWidth),"none of the notice is cut off").toBeLessThanOrEqual(1);
  await shots(page,"browser-profile-import-notice");
});

// The shell answers an import whose every cookie it refused with counts, not a rejection (desktop/main.mjs importBrowserCookies and
// importBrowserProfile), and with each cookie's reason: the first Import cookie JSON is a JSON array of entries that are not cookies,
// the next sets some of its cookies, and Import profile sets none of the cookies it tries and skips encrypted ones.
function scriptedNoneImported(){
  window.__cookieImports=0;
  Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{
    state:async()=>({open:false,url:"",title:"",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800}),
    onState:()=>()=>{},
    snapshot:async()=>({url:"",title:"",elements:[]}),
    importCookies:async()=>++window.__cookieImports===1
      ?{ok:true,canceled:false,source:"file",imported:0,failed:3,errors:["Cookie name is required","Cookie name is required","Cookie needs a url or domain"]}
      :{ok:true,canceled:false,source:"file",imported:2,failed:1,errors:["Cookie needs a url or domain"]},
    importSources:async()=>({platform:"win32",sources:[{id:"firefox",name:"Firefox",installed:true,running:false,profiles:[{id:"C:/Profiles/Work",name:"Work profile"}]}]}),
    importProfile:async(sourceId,profileId)=>({ok:true,sourceId,profileId,profileName:"Work profile",imported:0,failed:2,skipped:5,errors:["Cookie needs a url or domain","Cookie needs a url or domain"]}),
  }}});
}

test("an import that brought in none of its cookies says why in the error line, as an alert in the error colour, and one that brought in some stays a notice",async({page,request})=>{
  await page.addInitScript(scriptedNoneImported);
  const {panel}=await openBrowserPanel(page,request);
  const notice=panel.getByTestId("browser-cookie-status");
  // A JSON array of entries that are not cookies: the shell set none of them.
  await panel.getByRole("button",{name:"Import cookie JSON"}).click();
  const cookieFailure=panel.getByRole("alert").filter({hasText:"Cookie import failed"});
  await expect(cookieFailure).toHaveText("Cookie import failed: none of the 3 cookies could be set (Cookie name is required).");
  await expect(notice).toHaveCount(0);
  for(const mode of ["dark","light"]){
    if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    const colours=await cookieFailure.evaluate(node=>{const probe=document.createElement("span");probe.style.color="var(--err)";document.body.append(probe);const err=getComputedStyle(probe).color;probe.remove();return {shown:getComputedStyle(node).color,err}});
    expect(colours.shown,`the failure is in the error colour in ${mode} mode`).toBe(colours.err);
  }
  await shots(page,"browser-cookie-import-none-set");
  // An import that set some of its cookies is a notice, and the failure before it is gone.
  await panel.getByRole("button",{name:"Import cookie JSON"}).click();
  await expect(notice).toHaveText("Imported 2 cookies · 1 failed");
  await expect(notice).toHaveAttribute("role","status");
  await expect(cookieFailure).toHaveCount(0);
  // A profile import that set none of the cookies it tried.
  await panel.getByRole("button",{name:"Import profile"}).click();
  await panel.getByTestId("browser-profile-import").getByRole("button",{name:/Work profile/}).click();
  await expect(panel.getByRole("alert").filter({hasText:"Profile import failed"})).toHaveText("Profile import failed: none of the 2 cookies from Work profile could be set (Cookie needs a url or domain); 5 encrypted or partitioned cookies were skipped.");
  await expect(notice).toHaveCount(0);
  await shots(page,"browser-profile-import-none-set");
});
