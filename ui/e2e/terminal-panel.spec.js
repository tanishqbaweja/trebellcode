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

// Dark and light screenshots at 1280x800 and 900 wide (and any other widths asked for), switched with the header's appearance
// toggle as a person switches them.
async function shots(page,name,widths=[1280,900]){
  for(const width of widths){
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

test("a paste of several lines runs each finished line and leaves the last one on the command line, as a terminal does",async({page,request,context})=>{
  test.setTimeout(60_000);
  const shell=await realTerminals(page);
  try{
    await context.grantPermissions(["clipboard-read","clipboard-write"]);
    const {screen,input}=await openTerminal(page,request);
    await input.click();
    await page.keyboard.type("echo ",{delay:8});
    await page.evaluate(()=>navigator.clipboard.writeText("pasted-one\r\necho pasted-two\necho pasted-three"));
    await page.keyboard.press("Control+V");
    await expect(screen).toContainText(/^pasted-one$/m);
    await expect(screen).toContainText(/^pasted-two$/m);
    await expect(input).toHaveValue("echo pasted-three");
    await expect(screen).not.toContainText("pasted-three");
    await shots(page,"terminal-multiline-paste");
    await input.click();
    await page.keyboard.press("Enter");
    await expect(screen).toContainText(/^pasted-three$/m);
    await expect(input).toHaveValue("");
    // Pasted with the caret inside a typed command, the first line goes in at the caret, and its Enter sends the whole command.
    await page.keyboard.type("echo AB",{delay:8});await page.keyboard.press("ArrowLeft");
    await page.evaluate(()=>navigator.clipboard.writeText("1\r\n2"));
    await page.keyboard.press("Control+V");
    await expect(screen).toContainText(/^A1B$/m);
    await expect(input).toHaveValue("2");
    await shots(page,"terminal-paste-inside-command");
  }finally{await shell.close()}
});

test("a long run of output keeps the page responsive and the screen at its last 5,000 lines, with a note that earlier lines were dropped",async({page,request})=>{
  test.setTimeout(240_000);
  const shell=await realTerminals(page);
  try{
    const {pane,screen,input}=await openTerminal(page,request);
    await input.click();
    await run(page,"for /L %i in (1,1,30000) do @echo line %i");
    // While the lines stream in, a trivial call into the page is timed: it waits only when the page's main thread is busy.
    const waits=[],started=Date.now();
    for(;;){
      const asked=Date.now();const tail=await screen.evaluate(node=>node.textContent.slice(-120));waits.push(Date.now()-asked);
      if(/line 30000\s[\s\S]*>\s*$/.test(tail))break;
      expect(Date.now()-started,"the 30,000 lines finish streaming").toBeLessThan(200_000);
      await page.waitForTimeout(250);
    }
    const sorted=[...waits].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)],worst=sorted[sorted.length-1];
    console.log(`30,000 lines in ${Date.now()-started} ms; page answered in ${median} ms at the median and ${worst} ms at worst over ${waits.length} samples`);
    expect(median,"the median wait while output streams").toBeLessThan(500);
    expect(worst,"the longest wait while output streams").toBeLessThan(3_000);
    const lines=await screen.evaluate(node=>node.textContent.split("\n").length);
    expect(lines,"the screen keeps a bounded scrollback").toBeLessThanOrEqual(5_002);
    await expect(screen).toContainText(/^line 30000$/m);
    await expect(screen).not.toContainText(/^line 1$/m);
    await expect(pane.getByText("Earlier lines were dropped",{exact:false})).toBeVisible();
    // Scrolled back to the top, the screen says where its first lines went.
    await screen.hover();
    for(let turn=0;turn<60&&await screen.evaluate(node=>node.scrollTop>0);turn++)await page.mouse.wheel(0,-20_000);
    await expect.poll(()=>screen.evaluate(node=>node.scrollTop)).toBe(0);
    await shots(page,"terminal-long-output");
  }finally{await shell.close()}
});

test("a line the terminal wraps at its edge reads as it was printed, without a repeated character at the wrap",async({page,request})=>{
  test.setTimeout(60_000);
  const shell=await realTerminals(page);
  try{
    const {screen,input}=await openTerminal(page,request);
    await input.click();
    // A full screen first: once the screen scrolls, ConPTY writes the character at a wrap twice.
    await run(page,"for /L %i in (1,1,40) do @echo filler %i");
    await expect(screen).toContainText(/^filler 40$/m);
    const token=Array.from({length:30},(_,index)=>"w"+String(index).padStart(3,"0")).join("-");
    await run(page,"echo "+token);
    await expect(screen).toContainText(new RegExp("^"+token+"$","m"));
    await expect(screen).toContainText(">echo "+token);
    await shots(page,"terminal-wrapped-line");
  }finally{await shell.close()}
});

test("four side-by-side panes keep a usable command line in a 700 px window, and the last one is reached by scrolling the panes",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    const {drawer}=await openTerminal(page,request);
    const split=drawer.getByTitle("Split horizontally"),panes=drawer.locator(".terminal-pane");
    for(let count=2;count<=4;count++){await split.click();await expect(panes).toHaveCount(count);await expect(panes.nth(count-1).locator(".terminal-screen")).toHaveText(PROMPT,{timeout:20_000})}
    await page.setViewportSize({width:700,height:800});
    // Each command field keeps room for about a dozen characters (it was down to three).
    for(let index=0;index<4;index++){
      const width=await panes.nth(index).locator(".terminal-command-line input").evaluate(node=>node.getBoundingClientRect().width);
      expect(width,"command field of pane "+(index+1)).toBeGreaterThanOrEqual(90);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth),"no sideways page scroll").toBeLessThanOrEqual(1);
    // The panes scroll sideways inside the drawer, so the last one is in reach of the wheel.
    const box=drawer.locator(".terminal-panes"),last=panes.nth(3),lastInput=last.locator(".terminal-command-line input");
    const inView=()=>lastInput.evaluate(node=>{const field=node.getBoundingClientRect(),view=node.closest(".terminal-panes").getBoundingClientRect();return field.left>=view.left&&field.right<=view.right+1});
    expect(await inView(),"the last pane starts out of view").toBe(false);
    await box.hover();
    for(let turn=0;turn<20&&await box.evaluate(node=>node.scrollLeft+node.clientWidth<node.scrollWidth-1);turn++)await page.mouse.wheel(400,0);
    expect(await inView(),"the last pane is in view after scrolling").toBe(true);
    await lastInput.click();
    await run(page,"echo pane-four");
    await expect(last.locator(".terminal-screen")).toContainText(/^pane-four$/m);
    await shots(page,"terminal-four-panes-narrow",[1280,900,700]);
  }finally{await shell.close()}
});
