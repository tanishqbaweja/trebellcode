import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "../../src/terminal-manager.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
const PROMPT=/[A-Z]:\\[^\n]*>\s*$/;

// The mock server has no terminals, so these tests run the real TerminalManager (the shell through node-pty) in the test process:
// the page's terminal requests are answered by it and the terminal WebSocket is pointed at it.
async function realTerminals(page){
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-e2e-"));
  const terminals=new TerminalManager({env:{...process.env,TREBELL_HOME:home,GH_TOKEN:"",GITHUB_TOKEN:""},persist:false});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  terminals.attachWebSocket(server);
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,async route=>{
    const request=route.request(),url=new URL(request.url()),answer=(status,body)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    try{
      if(request.method()==="GET")return answer(200,{sessions:terminals.list(url.searchParams.get("environmentId")||null)});
      if(request.method()==="POST"){const body=request.postDataJSON()||{};return answer(200,{session:await terminals.create({cwd:body.cwd||process.cwd(),cols:body.cols||120,rows:body.rows||32,name:body.name||null})})}
      if(request.method()==="DELETE"){await terminals.close(url.searchParams.get("id"));return answer(200,{ok:true})}
    }catch(error){return answer(400,{error:error.message})}
    return route.continue();
  });
  await page.addInitScript(port=>{
    window.WebSocket=new Proxy(window.WebSocket,{construct(target,[url,...rest]){
      const address=String(url),at=address.indexOf("/api/terminal/ws");
      return Reflect.construct(target,[at>=0?"ws://127.0.0.1:"+port+address.slice(at):address,...rest]);
    }});
  },port);
  return {terminals,async close(){await terminals.shutdown().catch(()=>{});server.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{})}};
}

async function openTerminal(page,request){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Terminal Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("terminal-toggle").click();
  const drawer=page.getByTestId("drawer");
  await drawer.getByRole("button",{name:"Create terminal"}).click();
  const pane=drawer.locator(".terminal-pane.active"),screen=pane.locator(".terminal-screen"),input=pane.locator(".terminal-command-line input");
  await expect(screen).toHaveText(PROMPT,{timeout:20_000});
  return {drawer,pane,screen,input};
}

// Dark and light screenshots at 1280x800 and 900 wide, switched with the header's appearance toggle as a person switches them.
async function shots(page,name){
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+".png"});
    }
    await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
  }
}

// Types a command on the focused command line as a person does and presses Enter.
async function run(page,command){await page.keyboard.type(command,{delay:8});await page.keyboard.press("Enter")}

test("an empty Enter on the command line reaches the program, so a prompt waiting for Enter takes its default",async({page,request})=>{
  test.setTimeout(60_000);
  const shell=await realTerminals(page);
  try{
    const {screen,input}=await openTerminal(page,request);
    await input.click();
    await run(page,'set "answer=kept"');
    await run(page,'set /p "answer=Press Enter to keep it: "');
    await expect(screen).toHaveText(/Press Enter to keep it: $/);
    await page.keyboard.press("Enter");
    await expect(screen).toHaveText(PROMPT);
    await run(page,"echo answer is %answer%");
    await expect(screen).toContainText(/^answer is kept$/m);
    await shots(page,"terminal-empty-enter");
  }finally{await shell.close()}
});
