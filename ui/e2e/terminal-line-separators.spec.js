import { test,expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "../../src/terminal-manager.mjs";

// A command typed with U+2028 (LINE SEPARATOR) in it, which JSON.stringify leaves raw: the terminal's input and output travel as
// JSON lines between the server and the terminal worker, which readline split there, so the command never reached the shell and
// its output was lost. Now both arrive whole.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const LS=String.fromCharCode(0x2028);
const PROMPT=/[A-Z]:\\[^\n]*>\s*$/;

// The mock server has no terminals, so this runs the real TerminalManager (the shell through node-pty) in the test process, as
// terminal-panel.spec.js does: the page's terminal requests are answered by it and the terminal WebSocket is pointed at it.
async function realTerminals(page){
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-separators-"));
  const terminals=new TerminalManager({env:{...process.env,TREBELL_HOME:home,GH_TOKEN:"",GITHUB_TOKEN:""},persist:false});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),upgrades=new EventEmitter();
  server.on("upgrade",(req,socket,head)=>upgrades.emit("upgrade",req,socket,head));
  terminals.attachWebSocket(upgrades);
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
  return {async close(){await terminals.shutdown().catch(()=>{});server.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{})}};
}

// Dark and light screenshots at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
async function shots(page,name){
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`});
    }
  }
  await page.setViewportSize({width:1280,height:800});
}

test("a command typed with a line separator in it runs in the terminal, and its output shows whole",async({page,request})=>{
  test.skip(process.platform!=="win32","the prompt and the echo are cmd.exe's");
  test.setTimeout(60_000);
  const shell=await realTerminals(page);
  try{
    await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
    const boot=await (await request.get("/api/bootstrap")).json();
    await request.post("/api/projects",{data:{path:boot.cwd,name:"Terminal Workspace",activate:true}});
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByTestId("terminal-toggle").click();
    const drawer=page.getByTestId("drawer");
    await drawer.getByRole("button",{name:"Create terminal"}).click();
    const pane=drawer.locator(".terminal-pane.active"),screen=pane.locator(".terminal-screen"),input=pane.locator(".terminal-command-line input");
    await expect(screen).toHaveText(PROMPT,{timeout:20_000});
    const marker="separated-"+Date.now();
    await input.click();await page.keyboard.type(`echo before${LS}after-${marker}`,{delay:8});await page.keyboard.press("Enter");
    // The program's own line starts with the text, as the shell's echo of the command does not.
    await expect(screen).toContainText(new RegExp("^before"+LS+"after-"+marker+"$","m"),{timeout:10_000});
    await expect(screen).toHaveText(PROMPT);
    await expect(input).toHaveValue("");
    await shots(page,"terminal-line-separators");
  }finally{await shell.close()}
});
