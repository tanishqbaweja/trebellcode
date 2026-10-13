import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
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
// after each move, as desktop/main.mjs does, and notes the calls the panel makes.
function scriptedAgentBrowser(){
  const pages=[],listeners=new Set();let at=-1;window.agentBrowserCalls=[];
  const current=()=>({open:at>=0,url:pages[at]||"",title:"",canGoBack:at>0,canGoForward:at>=0&&at<pages.length-1,loading:false,width:1280,height:800});
  const call=(name,move=()=>{})=>async(...args)=>{window.agentBrowserCalls.push(name);move(...args);for(const listener of listeners)listener(current());return current()};
  Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{
    state:async()=>current(),
    onState:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    navigate:call("navigate",url=>{pages.splice(at+1);pages.push(url);at=pages.length-1}),
    back:call("back",()=>{if(at>0)at--}),
    forward:call("forward",()=>{if(at<pages.length-1)at++}),
    reload:call("reload"),
    snapshot:async()=>({url:pages[at]||"",title:"",elements:[]}),
  }}});
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

// Types an address over the one in the bar, as a person does.
async function typeAddress(page,address,value){await address.click();await page.keyboard.press("Control+A");await page.keyboard.type(value,{delay:8})}

// Dark and light screenshots at 1280x800 and 900 wide. The mode is switched with the header's appearance toggle at 1280: at 900 the
// open right panel lies over the header, and closing the panel would drop the preview, so a person widens the window to reach it.
async function shots(page,name){
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+".png"})}
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
