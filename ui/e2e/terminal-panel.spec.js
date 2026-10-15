import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "../../src/terminal-manager.mjs";
import { TERMINAL_SCROLLBACK_CHARS } from "../src/terminal-screen.js";

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

// A clipboard of the page's own: Ctrl+V is kept from the machine's clipboard, and the paste event the browser would send is sent with
// the text the test put there, which the page then takes as from a paste (a paste no handler takes goes in at the caret). Nothing is
// read from or written to the machine's clipboard: nativePastes counts the pastes the browser itself sent.
async function pageClipboard(page){
  await page.addInitScript(()=>{
    window.__clipboard={text:"",nativePastes:0};
    document.addEventListener("paste",event=>{if(event.isTrusted)window.__clipboard.nativePastes++},true);
    document.addEventListener("keydown",event=>{
      if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=="v")return;
      event.preventDefault();
      const data=new DataTransfer(),text=window.__clipboard.text;data.setData("text/plain",text);
      if((document.activeElement||document.body).dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true,composed:true})))document.execCommand("insertText",false,text);
    },true);
  });
  return {copy:text=>page.evaluate(value=>{window.__clipboard.text=value},text),nativePastes:()=>page.evaluate(()=>window.__clipboard.nativePastes)};
}

test("a paste of several lines runs each finished line and leaves the last one on the command line, as a terminal does",async({page,request})=>{
  test.setTimeout(60_000);
  const shell=await realTerminals(page);
  try{
    const clipboard=await pageClipboard(page);
    const {screen,input}=await openTerminal(page,request);
    await input.click();
    await page.keyboard.type("echo ",{delay:8});
    await clipboard.copy("pasted-one\r\necho pasted-two\necho pasted-three");
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
    await clipboard.copy("1\r\n2");
    await page.keyboard.press("Control+V");
    await expect(screen).toContainText(/^A1B$/m);
    await expect(input).toHaveValue("2");
    await shots(page,"terminal-paste-inside-command");
    expect(await clipboard.nativePastes(),"pastes from the machine's clipboard").toBe(0);
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
    await expect(pane.getByText("Earlier output was dropped",{exact:false})).toBeVisible();
    // Scrolled back to the top, the screen says where its first lines went.
    await screen.hover();
    for(let turn=0;turn<60&&await screen.evaluate(node=>node.scrollTop>0);turn++)await page.mouse.wheel(0,-20_000);
    await expect.poll(()=>screen.evaluate(node=>node.scrollTop)).toBe(0);
    await shots(page,"terminal-long-output");
  }finally{await shell.close()}
});

test("a screen scrolled up stays where it is while output streams, and follows the latest output again once scrolled back down or sent a command",async({page,request})=>{
  test.setTimeout(120_000);
  const shell=await realTerminals(page);
  try{
    const {screen,input}=await openTerminal(page,request);
    const latest=()=>screen.evaluate(node=>Number((node.textContent.match(/^late (\d+)$/gm)||["late 0"]).pop().slice(5)));
    const fromBottom=()=>screen.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
    const top=()=>screen.evaluate(node=>Math.round(node.scrollTop));
    // The person turns the wheel up until the newest lines are well below the view, and the view comes to rest.
    const scrollUp=async()=>{
      await screen.hover();
      for(let turn=0;turn<10&&await fromBottom()<=600;turn++)await page.mouse.wheel(0,-400);
      await expect.poll(async()=>{const before=await top();await page.waitForTimeout(250);return await top()-before},{message:"the view comes to rest"}).toBe(0);
    };
    await input.click();
    // A fast stream while the person types the next command: each keystroke redraws the screen, and it still ends at the prompt.
    await run(page,"for /L %i in (1,1,4000) do @echo early %i");
    await page.keyboard.type("node -e \"let i=0;const t=setInterval(()=>{console.log('late '+(++i));if(i===150)clearInterval(t)},100)\"",{delay:25});
    await expect(screen).toContainText(/^early 4000$/m,{timeout:60_000});
    await expect(screen).toHaveText(PROMPT);
    await expect.poll(fromBottom,{message:"the screen ends at the prompt"}).toBeLessThanOrEqual(8);
    // The typed program prints a line every 100 ms for about fifteen seconds.
    await page.keyboard.press("Enter");
    await expect(screen).toContainText(/^late 3$/m,{timeout:20_000});
    // The person scrolls up to read the earlier lines: the lines that keep arriving below leave the view where it is.
    await scrollUp();
    const held=await top(),seen=await latest();
    await expect.poll(latest,{timeout:10_000}).toBeGreaterThan(seen+5);
    expect(await top(),"the view the person scrolled to").toBe(held);
    expect(await fromBottom(),"the newest lines are below the view").toBeGreaterThan(600);
    await shots(page,"terminal-scrolled-up-while-streaming");
    // Scrolled back down to the end, the screen follows the output again.
    await screen.hover();
    for(let turn=0;turn<20&&await fromBottom()>8;turn++)await page.mouse.wheel(0,2000);
    const resumed=await latest();
    await expect.poll(latest,{timeout:10_000}).toBeGreaterThan(resumed+3);
    await expect.poll(fromBottom,{message:"following the output"}).toBeLessThanOrEqual(8);
    // Scrolled up again once the program is done, a command sent from the command line brings the screen back to its answer.
    await expect(screen).toContainText(/^late 150$/m,{timeout:30_000});
    await expect(screen).toHaveText(PROMPT);
    await scrollUp();
    await input.click();await run(page,"echo answer-shown");
    await expect(screen).toContainText(/^answer-shown$/m);
    await expect.poll(fromBottom).toBeLessThanOrEqual(8);
  }finally{await shell.close()}
});

test("one very long line of output (a minified file printed) keeps the page responsive and the screen near its character cap",async({page,request})=>{
  test.setTimeout(120_000);
  const shell=await realTerminals(page);
  try{
    const {pane,screen,input}=await openTerminal(page,request);
    await input.click();
    // 3,000,000 characters on one line, then a line of its own.
    await run(page,"node -e \"process.stdout.write('x'.repeat(3000000)+String.fromCharCode(10)+'long-line-done'+String.fromCharCode(10))\"");
    const waits=[],started=Date.now();
    for(;;){
      const asked=Date.now();const tail=await screen.evaluate(node=>node.textContent.slice(-200));waits.push(Date.now()-asked);
      if(/long-line-done\s[\s\S]*>\s*$/.test(tail))break;
      expect(Date.now()-started,"the long line finishes").toBeLessThan(100_000);
      await page.waitForTimeout(100);
    }
    const sorted=[...waits].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)],worst=sorted[sorted.length-1];
    const size=await screen.evaluate(node=>node.textContent.length);
    console.log(`3,000,000 characters in ${Date.now()-started} ms; page answered in ${median} ms at the median and ${worst} ms at worst over ${waits.length} samples; the screen holds ${size} characters`);
    // Before the cap the page answered in 3 s at the median and 5 s at worst, holding all 3,000,000 characters.
    expect(median,"the median wait while output streams").toBeLessThan(1_000);
    expect(worst,"the longest wait while output streams").toBeLessThan(3_000);
    expect(size,"the screen keeps the line's end, near its character cap").toBeLessThan(TERMINAL_SCROLLBACK_CHARS*1.1+1000);
    expect(await screen.evaluate(node=>/x{1000}\n+long-line-done\n/.test(node.textContent)),"the line's end is kept").toBe(true);
    await expect(pane.getByText("Earlier output was dropped",{exact:false})).toBeVisible();
    // Typing goes in at once after it.
    await page.keyboard.type("echo next",{delay:10});await expect(input).toHaveValue("echo next");
    await screen.hover();
    for(let turn=0;turn<60&&await screen.evaluate(node=>node.scrollTop>0);turn++)await page.mouse.wheel(0,-20_000);
    await expect.poll(()=>screen.evaluate(node=>node.scrollTop)).toBe(0);
    await shots(page,"terminal-long-line");
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

test("a terminal's close button is reached with Tab and named for it, and Enter, a click or Delete on the tab closes that terminal, with focus on the one left",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    const {drawer}=await openTerminal(page,request);
    const tabs=drawer.locator(".terminal-tab"),activeInput=drawer.locator(".terminal-pane.active .terminal-command-line input");
    // A tab's name, as its select button shows it (the app numbers new terminals).
    const nameOf=async tab=>(await tab.locator(".terminal-tab-select bdi").textContent()).trim();
    const second=async()=>{await drawer.locator(".terminal-new").click();await expect(tabs).toHaveCount(2);await expect(drawer.locator(".terminal-pane.active .terminal-screen")).toHaveText(PROMPT,{timeout:20_000})};
    await second();
    // From the keyboard: Tab goes from the tab to its close button, which says what it closes.
    const first=tabs.nth(0),firstName=await nameOf(first),close=first.getByRole("button",{name:"Close "+firstName,exact:true});
    expect(firstName).toMatch(/^Terminal \d+$/);
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      await first.getByRole("button",{name:firstName,exact:true}).focus();await page.keyboard.press("Tab");
      await expect(close).toBeFocused();await expect(close).toHaveAttribute("title","Close "+firstName);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"terminal-tab-close-focused-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
    }
    await page.keyboard.press("Enter");
    await expect(tabs).toHaveCount(1);await expect(activeInput).toBeFocused();
    expect(shell.terminals.list(null)).toHaveLength(1);
    // By mouse, the active tab's close button.
    await second();
    await tabs.nth(1).getByRole("button",{name:"Close "+await nameOf(tabs.nth(1)),exact:true}).click();
    await expect(tabs).toHaveCount(1);await expect(activeInput).toBeFocused();
    expect(shell.terminals.list(null)).toHaveLength(1);
    // Delete on the tab itself still closes it, the last one too.
    await tabs.nth(0).getByRole("button",{name:await nameOf(tabs.nth(0)),exact:true}).focus();await page.keyboard.press("Delete");
    await expect(tabs).toHaveCount(0);await expect(drawer.getByText("No terminal session")).toBeVisible();
    expect(shell.terminals.list(null)).toHaveLength(0);
  }finally{await shell.close()}
});

// Focus terminal (Ctrl+`) with no terminal running opens the drawer with the keyboard on what starts one, as the palette's Terminal
// does: Create terminal when there is none, New beside a stopped one. Enter there starts a terminal with the keyboard on its command
// line, and Ctrl+` goes back to the composer and into the terminal again.
test("Ctrl+` with no terminal running puts the keyboard on Create terminal, or on New beside a stopped one, and Enter starts a terminal to type in",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
    const boot=await (await request.get("/api/bootstrap")).json();
    await request.post("/api/projects",{data:{path:boot.cwd,name:"Terminal Workspace",activate:true}});
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const composer=page.getByTestId("composer"),drawer=page.getByTestId("drawer");
    const create=drawer.getByRole("button",{name:"Create terminal",exact:true}),screen=drawer.locator(".terminal-pane.active .terminal-screen"),input=drawer.locator(".terminal-pane.active .terminal-command-line input");
    await expect(composer).toBeVisible();
    // None yet: from a click on the new-task screen, which leaves the keyboard on the page, and from the composer, in each mode.
    for(const [mode,from] of [["dark","page"],["light","composer"]]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      if(from==="page"){await page.getByRole("heading",{name:"What do you want to build?"}).click();await expect(composer).not.toBeFocused()}else await composer.click();
      await page.keyboard.press("Control+Backquote");
      await expect(drawer.getByText("No terminal session")).toBeVisible();await expect(create).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(create).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"terminal-ctrl-backquote-create-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
      if(mode==="dark"){await drawer.getByRole("button",{name:"Close terminal"}).click();await expect(drawer).toHaveCount(0)}
    }
    // Enter starts one with the keyboard on its command line; Ctrl+` goes to the composer and back into the terminal.
    await page.keyboard.press("Enter");
    await expect(screen).toHaveText(PROMPT,{timeout:20_000});await expect(input).toBeFocused();
    expect(shell.terminals.list(null)).toHaveLength(1);
    await run(page,"echo typed-after-ctrl-backquote");
    await expect(screen).toContainText(/^typed-after-ctrl-backquote$/m);
    await page.keyboard.press("Control+Backquote");await expect(composer).toBeFocused();
    await page.keyboard.press("Control+Backquote");await expect(input).toBeFocused();
    // Beside a stopped terminal the keyboard goes to New, and Enter starts another to type in.
    await run(page,"exit");await expect(input).toBeDisabled({timeout:20_000});
    await composer.click();await page.keyboard.press("Control+Backquote");
    const newButton=drawer.locator(".terminal-new");await expect(newButton).toBeFocused();
    await page.screenshot({animations:"disabled",path:auditDir+"terminal-ctrl-backquote-new-light-1280.png"});
    await page.keyboard.press("Enter");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(2);
    await expect(screen).toHaveText(PROMPT,{timeout:20_000});await expect(input).toBeEnabled();await expect(input).toBeFocused();
    await run(page,"echo second-after-ctrl-backquote");
    await expect(screen).toContainText(/^second-after-ctrl-backquote$/m);
  }finally{await shell.close()}
});
