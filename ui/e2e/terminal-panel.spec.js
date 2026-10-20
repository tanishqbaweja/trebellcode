import { test,expect } from "@playwright/test";
import { EventEmitter } from "node:events";
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
// the page's terminal requests are answered by it and the terminal WebSocket is pointed at it. listDelay (ms) holds each answer to
// the page's list of terminals that long, as a slow server does. drop() ends every open terminal socket from the server's side, and
// while down is set the server refuses new ones (counted in refused), as one restarting does; the page counts the terminal sockets
// it saw close in window.__terminalSocketsClosed.
async function realTerminals(page){
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-e2e-"));
  const terminals=new TerminalManager({env:{...process.env,TREBELL_HOME:home,GH_TOKEN:"",GITHUB_TOKEN:""},persist:false});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),upgrades=new EventEmitter();
  const control={down:false,refused:0,drop(){for(const set of terminals.clients.values())for(const ws of set)ws.terminate()}};
  server.on("upgrade",(req,socket,head)=>{if(control.down){control.refused++;socket.destroy()}else upgrades.emit("upgrade",req,socket,head)});
  terminals.attachWebSocket(upgrades);
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  const shell=Object.assign(control,{terminals,listDelay:0,async close(){await terminals.shutdown().catch(()=>{});server.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{})}});
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,async route=>{
    const request=route.request(),url=new URL(request.url()),answer=(status,body)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    try{
      if(request.method()==="GET"){if(shell.listDelay)await new Promise(resolve=>setTimeout(resolve,shell.listDelay));return answer(200,{sessions:terminals.list(url.searchParams.get("environmentId")||null)})}
      if(request.method()==="POST"){const body=request.postDataJSON()||{};return answer(200,{session:await terminals.create({cwd:body.cwd||process.cwd(),cols:body.cols||120,rows:body.rows||32,name:body.name||null})})}
      if(request.method()==="DELETE"){await terminals.close(url.searchParams.get("id"));return answer(200,{ok:true})}
    }catch(error){return answer(400,{error:error.message})}
    return route.continue();
  });
  await page.addInitScript(port=>{
    window.__terminalSocketsClosed=0;
    window.WebSocket=new Proxy(window.WebSocket,{construct(target,[url,...rest]){
      const address=String(url),at=address.indexOf("/api/terminal/ws");
      const socket=Reflect.construct(target,[at>=0?"ws://127.0.0.1:"+port+address.slice(at):address,...rest]);
      if(at>=0)socket.addEventListener("close",()=>window.__terminalSocketsClosed++);
      return socket;
    }});
  },port);
  return shell;
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

// A screen at its end follows a running program through any resize of the window or the drawer. A narrower window re-wraps its long
// lines, and the browser's scroll anchoring then moved the screen, which took that for the person scrolling up: it stopped short of
// its end with its last line cut, and the program's later lines printed below the view until the person scrolled. A resize made a
// little each frame, as a person drags the window's edge or the sidebar animates open, did the same without the anchoring: the
// scroll that the screen's own move to its end sent came once the next step had re-wrapped its lines taller, so it found the screen
// short of its end. A screen the person scrolled up in stays scrolled up through a resize, made at once or a little each frame.
test("a screen at its end follows a running program's later lines while the window narrows or widens, at once or a little each frame, and the right panel or the sidebar opens or closes, and one scrolled up stays scrolled up",async({page,request})=>{
  test.setTimeout(300_000);
  const shell=await realTerminals(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    const {drawer,screen,input}=await openTerminal(page,request);
    const fromBottom=()=>screen.evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
    const top=()=>screen.evaluate(node=>Math.round(node.scrollTop));
    // How far the screen ends short of its end once it has come to rest (a frame or two after the last line printed).
    const restingGap=async()=>{let gap=await fromBottom();for(let turn=0;turn<20&&gap>2;turn++){await page.waitForTimeout(100);gap=await fromBottom()}return gap};
    // The drawer's edge dragged px further in each frame for steps frames (back out for a negative px), as a person drags the
    // window's edge: each move is made between two frames, after one frame's drawing and before the next one's.
    const drag=(px,steps=30)=>page.evaluate(({px,steps})=>new Promise(resolve=>{
      const node=document.querySelector("[data-testid='drawer']"),from=parseFloat(node.style.right)||0;let step=0;
      const move=()=>requestAnimationFrame(()=>setTimeout(()=>{node.style.right=Math.max(0,from+px*++step)+"px";if(step<steps)move();else requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))},0));
      move();
    }),{px,steps});
    // The person turns the wheel up until the newest lines are well below the view, and the view comes to rest.
    const scrollUp=async()=>{
      await screen.hover();
      for(let turn=0;turn<10&&await fromBottom()<=600;turn++)await page.mouse.wheel(0,-400);
      await expect.poll(async()=>{const before=await top();await page.waitForTimeout(250);return await top()-before},{message:"the view comes to rest"}).toBe(0);
    };
    // Whether the printed text shows whole inside the screen (its last time printed).
    const whole=text=>screen.evaluate((node,text)=>{
      const view=node.getBoundingClientRect(),walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let box=null;
      while(walker.nextNode()){const at=walker.currentNode.textContent.lastIndexOf(text);if(at<0)continue;const range=document.createRange();range.setStart(walker.currentNode,at);range.setEnd(walker.currentNode,at+text.length);box=range.getBoundingClientRect()}
      return Boolean(box)&&box.top>=view.top-0.5&&box.bottom<=view.bottom+0.5;
    },text);
    // A program that prints 20 lines wait ms (3 s) after it starts, and the resize made while it waits.
    const lateLines=async(tag,resize,wait=3000)=>{
      await input.click();
      await run(page,"node -e \"setTimeout(()=>{for(let i=1;i<=20;i++)console.log('"+tag+" '+i)},"+wait+")\"");
      await expect(screen).toContainText("console.log('"+tag+" '+i)");
      await resize();
      await expect(screen).toContainText(new RegExp("^"+tag+" 20 *$","m"),{timeout:20_000});
      await expect(screen).toHaveText(PROMPT);
    };
    await input.click();
    // Lines of many lengths up to 119 characters (the terminal is 120 wide), as prompts with a long path are: a narrower window
    // re-wraps some of them at any width, so each step of a resize made a little each frame makes the screen taller (ConPTY pads
    // the rows it redraws).
    await run(page,"node -e \"for(let i=1;i<=300;i++)console.log('wide line '+String(i).padStart(3,'0')+' '+'x'.repeat(42+(i*13&63)))\"");
    await expect(screen).toContainText(/^wide line 300 x+ *$/m,{timeout:30_000});
    await expect(screen).toHaveText(PROMPT);
    const panelToggle=page.getByTestId("right-panel-toggle").first(),panel=page.getByTestId("right-panel");
    // The sidebar opens as Settings' panel animations draw it at 300 ms (App sets this property from the setting): the main
    // column narrows a little each frame, by the 196px the sidebar takes at 900 wide.
    const openSidebarAnimated=async()=>{
      await page.evaluate(()=>document.documentElement.style.setProperty("--panel-animation-ms","300ms"));
      await page.getByRole("button",{name:"Open sidebar",exact:true}).first().click();
      await expect.poll(()=>drawer.evaluate(node=>Math.round(node.getBoundingClientRect().width)),{message:"the sidebar has opened"}).toBe(704);
      await page.evaluate(()=>document.documentElement.style.setProperty("--panel-animation-ms","0ms"));
    };
    for(const [tag,resize,before] of [
      ["narrowed-to-900",()=>page.setViewportSize({width:900,height:800})],
      ["narrowed-to-700",()=>page.setViewportSize({width:700,height:800})],
      ["widened-to-900",()=>page.setViewportSize({width:900,height:800})],
      ["widened-to-1280",()=>page.setViewportSize({width:1280,height:800})],
      ["panel-opened",async()=>{await panelToggle.click();await expect(panel).toBeVisible()}],
      ["panel-closed",async()=>{await panelToggle.click();await expect(panel).toHaveCount(0)}],
      ["dragged-narrower",()=>drag(12)],
      ["dragged-wider",()=>drag(-12)],
      ["sidebar-opened",openSidebarAnimated,async()=>{
        await page.setViewportSize({width:900,height:800});
        await page.getByRole("button",{name:"Collapse sidebar",exact:true}).click();
        await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
        await expect.poll(()=>drawer.evaluate(node=>Math.round(node.getBoundingClientRect().width))).toBe(900);
      }],
    ]){
      await before?.();
      await lateLines(tag,resize);
      // Each step is checked on its own (a screen that stopped following follows again once the next command is typed).
      const gap=await restingGap();console.log(tag+": the screen ends "+gap+" px short of its end");
      expect.soft(gap,tag+": the screen stays at its end").toBeLessThanOrEqual(2);
      expect.soft(await whole(tag+" 20"),tag+": the program's last line shows whole").toBe(true);
      if(tag==="narrowed-to-900")await shots(page,"terminal-follows-after-narrowing",[900]);
      if(tag==="dragged-narrower")await page.screenshot({animations:"disabled",path:auditDir+"terminal-follows-after-dragging-dark-1280.png"});
    }
    await shots(page,"terminal-follows-after-sidebar-opened",[900]);
    // Scrolled up by the person while a program waits to print, the screen stays where it is as the drawer's edge is dragged in
    // or the window narrows at once, and the program's lines print below the view.
    for(const [tag,resize] of [["scrolled-up-dragged",()=>drag(12,20)],["scrolled-up",()=>page.setViewportSize({width:900,height:800})]]){
      await page.setViewportSize({width:1280,height:800});await drawer.evaluate(node=>{node.style.right=""});
      await lateLines(tag,async()=>{await scrollUp();await resize()},4000);
      const away=await fromBottom();console.log(tag+": the screen stays "+away+" px above its end");
      expect.soft(away,tag+": the screen stays scrolled up").toBeGreaterThan(600);
      expect.soft(await whole(tag+" 20"),tag+": the program's lines print below the view").toBe(false);
    }
    await shots(page,"terminal-scrolled-up-through-narrowing",[900]);
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

// Whether a focused control shows its focus ring, as a person sees it: an outline drawn around it.
const ringShown=locator=>locator.evaluate(node=>{const style=getComputedStyle(node);return node===document.activeElement&&style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>0});

// Focus terminal (Ctrl+`) with no terminal running opens the drawer with the keyboard on what starts one, as the palette's Terminal
// does: Create terminal when there is none, New beside a stopped one, with its focus ring showing (the browser draws none for focus
// a script moves after a click in the composer and a shortcut with Ctrl). Enter there starts a terminal with the keyboard on its
// command line, and Ctrl+` goes back to the composer and into the terminal again.
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
    // None yet: from a click on the new-task screen, which leaves the keyboard on the page, and from the composer in each mode.
    const ways=[["dark","page"],["dark","composer"],["light","composer"]];
    for(const [index,[mode,from]] of ways.entries()){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      if(from==="page"){await page.getByRole("heading",{name:"What do you want to build?"}).click();await expect(composer).not.toBeFocused()}else await composer.click();
      await page.keyboard.press("Control+Backquote");
      await expect(drawer.getByText("No terminal session")).toBeVisible();await expect(create).toBeFocused();
      await expect.poll(()=>ringShown(create),{message:"Create terminal shows its focus ring ("+mode+", from the "+from+")"}).toBe(true);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(create).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"terminal-ctrl-backquote-create-"+from+"-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
      if(index<ways.length-1){await drawer.getByRole("button",{name:"Close terminal"}).click();await expect(drawer).toHaveCount(0)}
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
    await expect.poll(()=>ringShown(newButton),{message:"New shows its focus ring"}).toBe(true);
    await page.screenshot({animations:"disabled",path:auditDir+"terminal-ctrl-backquote-new-light-1280.png"});
    await page.keyboard.press("Enter");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(2);
    await expect(screen).toHaveText(PROMPT,{timeout:20_000});await expect(input).toBeEnabled();await expect(input).toBeFocused();
    await run(page,"echo second-after-ctrl-backquote");
    await expect(screen).toContainText(/^second-after-ctrl-backquote$/m);
  }finally{await shell.close()}
});

// Ctrl+` with the drawer closed opens it on terminals still to be listed (here the list answers slowly): the keyboard goes to what
// the list shows, never to Create terminal on the way, which would go as the terminals show (and an Enter typed meanwhile would start
// one more). Beside a stopped terminal that is New, as after a restart (saved terminals come back stopped) or a reload; with one
// running, its command line.
test("Ctrl+` with the drawer closed puts the keyboard on New beside a stopped terminal, or on a running one's command line, once the terminals are listed",async({page,request})=>{
  test.setTimeout(120_000);
  const shell=await realTerminals(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    const {drawer,screen,input}=await openTerminal(page,request);
    const composer=page.getByTestId("composer"),newButton=drawer.locator(".terminal-new"),closeDrawer=drawer.getByRole("button",{name:"Close terminal",exact:true});
    // The controls the keyboard went to since watchFocus, by their text.
    const watchFocus=()=>page.evaluate(()=>{window.__focused=[];document.addEventListener("focusin",event=>window.__focused.push((event.target.textContent||"").trim()||event.target.tagName),true)});
    const focused=()=>page.evaluate(()=>window.__focused||[]);
    await input.click();await run(page,"exit");await expect(input).toBeDisabled({timeout:20_000});
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      await closeDrawer.click();await expect(drawer).toHaveCount(0);
      shell.listDelay=600;await watchFocus();
      await composer.click();await page.keyboard.press("Control+Backquote");
      await expect(newButton).toBeFocused();await expect(input).toBeDisabled();
      await page.waitForTimeout(400);await expect(newButton).toBeFocused();
      expect(await focused(),"Create terminal never took the keyboard").not.toContain("Create terminal");
      await expect.poll(()=>ringShown(newButton)).toBe(true);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(newButton).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"terminal-ctrl-backquote-closed-stopped-"+mode+"-"+width+".png"})}
      await page.setViewportSize({width:1280,height:800});
    }
    // Reloaded, the stopped terminal is listed again when the drawer opens.
    await page.reload();await expect(composer).toBeVisible();await expect(drawer).toHaveCount(0);await watchFocus();
    await composer.click();await page.keyboard.press("Control+Backquote");
    await expect(newButton).toBeFocused();await page.waitForTimeout(400);await expect(newButton).toBeFocused();
    expect(await focused(),"Create terminal never took the keyboard").not.toContain("Create terminal");
    // Enter starts a terminal to type in. With it running and the drawer closed, Ctrl+` lands on its command line.
    shell.listDelay=0;
    await page.keyboard.press("Enter");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(2);
    await expect(screen).toHaveText(PROMPT,{timeout:20_000});await expect(input).toBeEnabled();await expect(input).toBeFocused();
    await closeDrawer.click();await expect(drawer).toHaveCount(0);
    shell.listDelay=600;await watchFocus();
    await composer.click();await page.keyboard.press("Control+Backquote");
    await expect(input).toBeFocused();await expect(drawer.locator(".terminal-tab")).toHaveCount(2);
    expect(await focused(),"Create terminal never took the keyboard").not.toContain("Create terminal");
    await run(page,"echo typed-after-closed-drawer");
    await expect(screen).toContainText(/^typed-after-closed-drawer$/m);
    expect(shell.terminals.list(null)).toHaveLength(2);
  }finally{await shell.close()}
});

// New terminal and Split given a condition that holds outside the drawer (Settings lets a shortcut's condition be changed) start a
// terminal from the composer with the keyboard on its command line, as they do from inside the drawer.
test("New terminal and Split pressed in the composer, where their condition lets them run, put the keyboard on the terminal they start",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    await request.post("/api/settings",{data:{keybindingRules:[{command:"terminalNew",key:"Ctrl+Alt+N",when:"terminalOpen && !modalOpen"},{command:"terminalSplit",key:"Ctrl+Alt+D",when:"terminalOpen && !modalOpen"}]}});
    await page.setViewportSize({width:1280,height:800});
    const {drawer}=await openTerminal(page,request);
    const composer=page.getByTestId("composer"),active=drawer.locator(".terminal-pane.active"),input=active.locator(".terminal-command-line input");
    await composer.click();await page.keyboard.press("Control+Alt+KeyN");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(2);await expect(active.locator(".terminal-screen")).toHaveText(PROMPT,{timeout:20_000});
    await expect(input,"New terminal's command line takes the keyboard").toBeFocused();
    await composer.click();await page.keyboard.press("Control+Alt+KeyD");
    await expect(drawer.locator(".terminal-pane")).toHaveCount(2);await expect(active.locator(".terminal-screen")).toHaveText(PROMPT,{timeout:20_000});
    await expect(input,"the split's command line takes the keyboard").toBeFocused();
    expect(shell.terminals.list(null)).toHaveLength(3);
  }finally{await shell.close();await request.post("/api/settings",{data:{keybindingRules:[]}})}
});

// The terminal worker can die under an open terminal (it crashed, or something ended it), and the terminal's shell ends with it. The
// terminal then shows it stopped, and New starts a new worker: the command line used to take input that vanished, and New failed
// after 15 s with "Terminal worker timed out" until the app restarted. The test ends only the worker its own manager started.
test("after the terminal worker dies its terminal shows it stopped, and New opens a terminal that runs commands",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    const {drawer,pane,input}=await openTerminal(page,request);
    const worker=shell.terminals.child;
    worker.kill();
    await expect(input,"the ended terminal's command line takes no input").toBeDisabled();
    await expect(input).toHaveAttribute("placeholder","Stopped terminal history");
    await expect(pane.getByRole("button",{name:"Send",exact:true})).toBeDisabled();
    await shots(page,"terminal-worker-died");
    await drawer.getByRole("button",{name:"New",exact:true}).click();
    // Its tab shows once a new worker has started (Node, node-pty, a console host), which gets the 20 s the first terminal's start
    // gets: on a loaded host the 5 s default can run out while the terminal is on its way.
    await expect(drawer.locator(".terminal-tab")).toHaveCount(2,{timeout:20_000});
    const next=drawer.locator(".terminal-pane.active");
    await expect(next.locator(".terminal-screen")).toHaveText(PROMPT,{timeout:20_000});
    await next.locator(".terminal-command-line input").click();
    await run(page,"echo new-worker-runs");
    await expect(next.locator(".terminal-screen")).toContainText(/^new-worker-runs$/m);
    await expect(drawer.locator(".terminal-error")).toHaveCount(0);
    expect(shell.terminals.child,"a new worker runs it").not.toBe(worker);
    await shots(page,"terminal-new-worker");
  }finally{await shell.close()}
});

// The drawer's terminal tabs: tab(name) is the button that selects one, startNew(count) presses New and waits for its prompt,
// ended(name,mark,label) waits for a tab's mark of how its terminal ended, and inView(name) says whether that tab's box shows
// whole inside the tab row, which scrolls when the tabs overflow it.
function terminalTabs(page,drawer){
  const tab=name=>drawer.locator(".terminal-tab-select").filter({has:page.getByText(name,{exact:true})});
  return {
    tab,
    async startNew(count){
      await drawer.getByRole("button",{name:"New",exact:true}).click();
      await expect(drawer.locator(".terminal-tab")).toHaveCount(count,{timeout:20_000});
      await expect(drawer.locator(".terminal-pane.active .terminal-screen")).toHaveText(PROMPT,{timeout:20_000});
    },
    // Its mark says how the terminal ended, to a hover (its title) and to a screen reader (the tab's name).
    async ended(name,mark,label){
      await expect(tab(name).locator("em"),name+"'s tab says it ended").toHaveText(mark,{timeout:15_000});
      await expect(tab(name).locator("em")).toBeVisible();
      await expect(tab(name).locator("em")).toHaveAttribute("title",label);
      await expect(tab(name)).toHaveAccessibleName(name+" "+label);
    },
    inView:name=>tab(name).evaluate(node=>{const box=node.parentElement.getBoundingClientRect(),row=node.closest(".terminal-tab-list").getBoundingClientRect();return box.left>=row.left-1&&box.right<=row.right+1}),
  };
}

// Every terminal that ends says so on its own tab, the one shown and the others, without being selected: that it stopped (a terminal
// worker that dies leaves no exit code), or the exit code its shell ended with. After the worker died the shown tab's mark was empty,
// and a tab not shown said nothing until it was selected. A tab's mark makes it wider, and the shown tab stays in view as it does.
test("after the terminal worker dies each terminal's tab says it stopped, the one shown and the others, and a terminal not shown that exits shows its exit code, without being selected",async({page,request})=>{
  test.setTimeout(120_000);
  const shell=await realTerminals(page);
  try{
    const {drawer}=await openTerminal(page,request);
    const {tab,startNew,ended,inView}=terminalTabs(page,drawer);
    await startNew(2);
    shell.terminals.child.kill();
    await ended("Terminal 2","stopped","Stopped");
    await ended("Terminal 1","stopped","Stopped");
    await expect(tab("Terminal 2"),"the shown terminal stays the one shown").toHaveAttribute("aria-current","true");
    await expect(tab("Terminal 1")).not.toHaveAttribute("aria-current");
    await shots(page,"terminal-tabs-stopped-with-worker");
    // Terminal 3's shell exits while Terminal 4 is shown (the test writes its exit to it, as a script ending in exit 3 does), in the
    // 900 px window the shots end at, where the four tabs overflow the tab row and the shown one was scrolled into view as it opened.
    expect(await page.evaluate(()=>window.innerWidth)).toBe(900);
    await startNew(3);await startNew(4);
    await expect.poll(()=>inView("Terminal 4"),{message:"the new terminal's tab is in view"}).toBe(true);
    await expect(tab("Terminal 3").locator("em"),"a running terminal's tab has no mark").toHaveCount(0);
    await shell.terminals.write(shell.terminals.list(null).find(session=>session.name==="Terminal 3").id,"exit 3\r");
    await ended("Terminal 3","3","Exited with code 3");
    // Terminal 3's mark makes its tab wider, and the shown tab beside it stays in view without any resize of the window.
    await expect.poll(()=>inView("Terminal 4"),{message:"the shown terminal's tab stays in view as the tab before it gets its mark",timeout:3_000}).toBe(true);
    await expect(tab("Terminal 4")).toHaveAttribute("aria-current","true");
    await expect(tab("Terminal 4").locator("em")).toHaveCount(0);
    await expect(tab("Terminal 4")).toHaveAccessibleName("Terminal 4");
    await shots(page,"terminal-tab-exit-code-not-shown");
    await expect.poll(()=>inView("Terminal 4"),{message:"the shown terminal's tab is in view"}).toBe(true);
  }finally{await shell.close()}
});

// In a 900 px window four terminals overflow the tab row, and the last one, shown, was scrolled into view as it opened. When the
// terminal worker dies every tab gets its "stopped" mark at once, the shown one too, which moved the shown tab out of the row's view.
test("in a 900 px window with four terminals and the last one shown, the shown terminal's tab stays in view as every tab says it stopped when the worker dies",async({page,request})=>{
  test.setTimeout(120_000);
  const shell=await realTerminals(page);
  try{
    await page.setViewportSize({width:900,height:800});
    const {drawer}=await openTerminal(page,request);
    const {tab,startNew,ended,inView}=terminalTabs(page,drawer);
    await startNew(2);await startNew(3);await startNew(4);
    await expect(tab("Terminal 4")).toHaveAttribute("aria-current","true");
    await expect.poll(()=>inView("Terminal 4"),{message:"the new terminal's tab is in view"}).toBe(true);
    expect(await inView("Terminal 1"),"the four tabs overflow the tab row").toBe(false);
    shell.terminals.child.kill();
    for(const name of ["Terminal 4","Terminal 3","Terminal 2","Terminal 1"])await ended(name,"stopped","Stopped");
    await expect.poll(()=>inView("Terminal 4"),{message:"the shown terminal's tab stays in view as every tab gets its mark",timeout:3_000}).toBe(true);
    await expect(tab("Terminal 4")).toHaveAttribute("aria-current","true");
    await shots(page,"terminal-four-tabs-stopped",[900,1280]);
  }finally{await shell.close()}
});

// The tab row shows it holds more tabs than it shows: an edge with tabs past it fades, that edge only, as the row scrolls, as the
// drawer narrows and as the tabs grow, and a row whose tabs all fit has none. A tab brought into view, the shown one or one the
// keyboard reaches, stops clear of the fade, with the close button of the tab cut before it in the fade's fainter half, and a double
// click on a cut tab closes nothing. The row cut a tab at its edge and said nothing of the tabs past it: beside the Terminal heading
// the cut tab could be a lone x.
test("the terminal tab row fades at each edge with tabs past it as it scrolls, as the drawer narrows and as the tabs grow, at neither when they all fit, and Tab or a click brings a cut tab into view clear of the fade",async({page,request})=>{
  test.setTimeout(150_000);
  const shell=await realTerminals(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    const {drawer,input}=await openTerminal(page,request);
    const {tab,startNew,ended,inView}=terminalTabs(page,drawer);
    const row=drawer.locator(".terminal-tab-list"),panelToggle=page.getByTestId("right-panel-toggle");
    // How far in from each edge of the row its mask fades it, 0 where it does not, and how far in that fade shows nothing at all
    // (startClear, endClear): the mask is a gradient from the row's start to its end, clear up to a stop at an edge that fades and
    // opaque from the stop beside it.
    const fades=()=>row.evaluate(node=>{
      const stops=getComputedStyle(node).maskImage.match(/rgba?\([^)]*\)[^,]*/g)||[],px=stop=>Number(/([\d.]+)px/.exec(stop)[1]);
      const fade=(edge,next)=>/rgba\(0, 0, 0, 0\)/.test(edge||"")?[px(edge),px(next)]:[0,0];
      const [startClear,start]=fade(stops[0],stops[1]),[endClear,end]=fade(stops.at(-1),stops.at(-2));
      return {start,end,startClear,endClear};
    });
    const edges=async()=>{const {start,end}=await fades();return [start&&"start",end&&"end"].filter(Boolean).join(" ")};
    // Whether a tab's box shows whole in the row and clear of its fades.
    const clear=async name=>tab(name).evaluate((node,fade)=>{const box=node.parentElement.getBoundingClientRect(),row=node.closest(".terminal-tab-list").getBoundingClientRect();return box.left>=row.left+fade.start-1&&box.right<=row.right-fade.end+1},await fades());
    const focused=name=>tab(name).evaluate(node=>node===document.activeElement);
    // walk(key,name) presses key until name's tab has the keyboard, and each button of the row it reaches on the way, a tab or its
    // close button, comes whole into view clear of the fade: hidden() names the focused button and where it is when it does not.
    const hidden=async()=>page.evaluate(fade=>{
      const node=document.activeElement,list=node.closest(".terminal-tab-list");if(!list)return "";
      const box=node.getBoundingClientRect(),row=list.getBoundingClientRect();
      return box.left>=row.left+fade.start-1&&box.right<=row.right-fade.end+1?"":(node.getAttribute("aria-label")||node.textContent)+" at "+Math.round(box.left-row.left)+" to "+Math.round(box.right-row.left)+" of "+Math.round(row.width);
    },await fades());
    const walk=async(key,name)=>{for(let press=0;press<8&&!await focused(name);press++){await page.keyboard.press(key);await expect.poll(hidden,{message:key+" brings the button it reaches whole into view, clear of the fade"}).toBe("")}};
    await startNew(2);await startNew(3);await startNew(4);
    // At 1280 the four tabs fit the row, which fades at neither edge.
    for(const name of ["Terminal 1","Terminal 2","Terminal 3","Terminal 4"])expect(await inView(name),name+"'s tab shows").toBe(true);
    expect(await edges(),"a row whose tabs all fit does not fade").toBe("");
    // The right panel opens and the drawer narrows: the tabs overflow the row, and the shown one, the last, is kept in view at the
    // row's end, so the row fades at its start, where the first tabs are hidden beside the Terminal heading, and not at its end.
    await panelToggle.click();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect.poll(()=>inView("Terminal 1"),{message:"the four tabs overflow the narrower row"}).toBe(false);
    await expect.poll(edges,{message:"the row fades at its start, where tabs are hidden, and not at its end"}).toBe("start");
    expect((await fades()).start,"the fade reaches past a cut tab's close button, with the tab's padding and border").toBeGreaterThanOrEqual(26);
    expect(await clear("Terminal 4"),"the shown tab stands clear of the fade").toBe(true);
    await shots(page,"terminal-tab-row-fade-start",[1280]);
    // The wheel over the row scrolls it to its start: its end fades now, and its start does not.
    const box=await row.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,-1000);
    await expect.poll(edges,{message:"scrolled to its start the row fades at its end only"}).toBe("end");
    expect(await inView("Terminal 1")).toBe(true);
    await shots(page,"terminal-tab-row-fade-end",[1280]);
    // Wheeled on until the first tab shows only its close button beside the heading: both edges fade, and that x is in the fade.
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,Math.round(await tab("Terminal 1").evaluate(node=>node.parentElement.getBoundingClientRect().right-node.closest(".terminal-tab-list").getBoundingClientRect().left-26)));
    await expect.poll(edges,{message:"with tabs past both edges the row fades at both"}).toBe("start end");
    const loneX=await drawer.getByRole("button",{name:"Close Terminal 1"}).evaluate((node,fade)=>{const box=node.getBoundingClientRect(),row=node.closest(".terminal-tab-list").getBoundingClientRect();return {left:box.left-row.left,right:box.right-row.left,fade:fade.start}},await fades());
    expect(loneX.left>=0&&loneX.right<=loneX.fade,"the cut tab's close button beside the heading lies in the fade: "+JSON.stringify(loneX)).toBe(true);
    await shots(page,"terminal-tab-row-fade-cut-tab",[1280]);
    // Shift+Tab from the shown terminal's command line onto the tabs: the last tab, hidden past the row's end, comes into view
    // clear of the fade, and the row fades at its start. On back to the first tab, hidden past the start, through the tabs between,
    // each brought clear of the start's fade as it is reached: the row fades at its end. Then Tab forward to the last tab, hidden
    // past the end again, each tab on the way brought clear of the end's fade.
    await input.click();
    await walk("Shift+Tab","Terminal 4");
    await expect(tab("Terminal 4")).toBeFocused();
    await expect.poll(()=>clear("Terminal 4"),{message:"Shift+Tab brings the last tab whole into view, clear of the fade"}).toBe(true);
    await expect.poll(edges).toBe("start");
    await walk("Shift+Tab","Terminal 1");
    await expect(tab("Terminal 1")).toBeFocused();
    await expect.poll(()=>clear("Terminal 1"),{message:"Shift+Tab brings the first tab whole into view, clear of the fade"}).toBe(true);
    await expect.poll(edges).toBe("end");
    await walk("Tab","Terminal 4");
    await expect(tab("Terminal 4")).toBeFocused();
    await expect.poll(()=>clear("Terminal 4"),{message:"Tab brings the last tab whole into view, clear of the fade"}).toBe(true);
    await expect.poll(edges).toBe("start");
    await shots(page,"terminal-tab-row-fade-keyboard",[1280]);
    // A click on what shows of Terminal 2's name, cut at the row's start, shows that terminal: its tab comes whole into view clear of
    // the fade, and the close button of Terminal 1, cut before it beside the heading, is left in the fade's fainter half. Then a click
    // on the last tab shows that terminal again, at the row's end.
    const second=await tab("Terminal 2").boundingBox(),shown=box.x+(await fades()).start;
    expect(second.x+second.width,"the end of Terminal 2's name shows past the fade").toBeGreaterThan(shown+8);
    await page.mouse.click((Math.max(second.x,shown)+second.x+second.width)/2,second.y+second.height/2);
    await expect(tab("Terminal 2")).toHaveAttribute("aria-current","true");
    await expect.poll(()=>clear("Terminal 2"),{message:"the clicked tab comes whole into view, clear of the fade"}).toBe(true);
    await expect.poll(async()=>(await fades()).start,{message:"Terminal 1 stays cut at the row's start"}).toBeGreaterThan(0);
    const cut=await drawer.getByRole("button",{name:"Close Terminal 1"}).evaluate((node,fade)=>{const box=node.getBoundingClientRect();return {middle:Math.round((box.left+box.right)/2-node.closest(".terminal-tab-list").getBoundingClientRect().left),fade}},await fades());
    expect(cut.middle<=(cut.fade.startClear+cut.fade.start)/2,"Terminal 1's close button lies in the fainter half of the fade: "+JSON.stringify(cut)).toBe(true);
    await shots(page,"terminal-tab-row-fade-shown-tab",[1280]);
    await tab("Terminal 4").click();
    await expect(tab("Terminal 4")).toHaveAttribute("aria-current","true");
    await expect.poll(edges,{message:"with the last terminal shown again the row fades at its start"}).toBe("start");
    // A double click on Terminal 2 where its first click, which brings it in, leaves Terminal 1's close button under the pointer: it
    // shows Terminal 2 and closes nothing, as the second click does nothing. Then the last terminal is shown again.
    const again=await tab("Terminal 2").boundingBox(),point=box.x+cut.middle,closes=[],onClose=sent=>sent.method()==="DELETE"&&closes.push(sent.url());
    expect(again.x<point&&again.x+again.width>point,"the double click lands on what shows of Terminal 2").toBe(true);
    page.on("request",onClose);
    await page.mouse.dblclick(point,again.y+again.height/2);
    await expect(tab("Terminal 2")).toHaveAttribute("aria-current","true");
    await expect.poll(()=>clear("Terminal 2"),{message:"the double clicked tab comes whole into view, clear of the fade"}).toBe(true);
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    page.off("request",onClose);
    expect(closes,"the second click closes no terminal").toEqual([]);
    await expect(drawer.locator(".terminal-tab")).toHaveCount(4);
    await tab("Terminal 4").click();
    await expect(tab("Terminal 4")).toHaveAttribute("aria-current","true");
    await expect.poll(edges).toBe("start");
    // The right panel closes: the four tabs fit again and the row does not fade. In a 900 px window they overflow it again, and the
    // shown one, the last, is kept in view at the row's end, which fades at its start.
    await panelToggle.click();
    await expect(page.getByTestId("right-panel")).toBeHidden();
    await expect.poll(edges,{message:"with every tab shown again the row does not fade"}).toBe("");
    await page.setViewportSize({width:900,height:800});
    await expect.poll(edges,{message:"the narrower window's row fades at its start"}).toBe("start");
    expect(await clear("Terminal 4")).toBe(true);
    await shots(page,"terminal-tab-row-fade-window",[900]);
    // Three tabs fit the row at 900. Then the terminal worker dies and each tab grows by its "stopped" mark: the tabs overflow the
    // row, and the shown one, the first, keeps its place, so the row fades at its end, and not at its start.
    await drawer.getByRole("button",{name:"Close Terminal 4"}).click();
    await expect(drawer.locator(".terminal-tab")).toHaveCount(3);
    await expect(tab("Terminal 1")).toHaveAttribute("aria-current","true");
    await expect.poll(edges,{message:"the three tabs fit the row at 900"}).toBe("");
    shell.terminals.child.kill();
    for(const name of ["Terminal 1","Terminal 2","Terminal 3"])await ended(name,"stopped","Stopped");
    await expect.poll(edges,{message:"the tabs grown by their marks overflow the row, which fades at its end"}).toBe("end");
    expect(await clear("Terminal 1")).toBe(true);
    await shots(page,"terminal-tab-row-fade-grown",[900,1280]);
  }finally{await shell.close()}
});

// A terminal's socket can drop under it (the server restarted, the machine slept). Input while it is away is refused with a notice
// that it is reconnecting, and the socket comes back by itself, trying less and less often while the server stays away: it never
// came back, so every later paste or command was refused the same way until the drawer was closed and opened again.
test("a terminal whose socket drops reconnects by itself, so a paste refused while it was away runs once it is back, and the screen shows what was printed meanwhile",async({page,request})=>{
  test.setTimeout(90_000);
  const shell=await realTerminals(page);
  try{
    const clipboard=await pageClipboard(page);
    const {drawer,screen,input}=await openTerminal(page,request);
    const notice=drawer.locator(".terminal-error"),closed=()=>page.evaluate(()=>window.__terminalSocketsClosed);
    await input.click();
    // A program that prints a line a few seconds after it starts, so the line comes while the socket is away.
    await run(page,"node -e \"setTimeout(()=>console.log('printed-'+'while-away'),4000)\"");
    await expect(screen).toContainText("console.log('printed-'+'while-away')");
    const before=await closed();shell.down=true;shell.drop();
    await expect.poll(closed,{message:"the page sees its terminal socket close"}).toBeGreaterThan(before);
    await clipboard.copy("echo pasted-one\r\necho pasted-two\r\nkeep-this");
    await page.keyboard.press("Control+V");
    await expect(notice).toHaveText("Terminal is reconnecting. Try again in a moment.");
    await shots(page,"terminal-socket-away");
    await expect.poll(()=>shell.terminals.list(null)[0]?.buffer||"",{message:"the program prints while the socket is away",timeout:20_000}).toContain("printed-while-away");
    // The server is back: the terminal reconnects by itself, its screen shows the line printed meanwhile, and its notice goes.
    const tries=shell.refused;shell.down=false;
    await expect(screen,"the terminal reconnects and shows what was printed while it was away").toContainText(/^printed-while-away$/m,{timeout:15_000});
    await expect(notice,"the reconnecting notice goes once the terminal is back").toBeHidden();
    expect(tries,"the page tried again by itself while the server was away").toBeGreaterThan(0);
    expect(tries,"less and less often, not in a loop").toBeLessThanOrEqual(8);
    await input.click();
    await page.keyboard.press("Control+V");
    await expect(screen).toContainText(/^pasted-one$/m);
    await expect(screen).toContainText(/^pasted-two$/m);
    await expect(input).toHaveValue("keep-this");
    expect((await screen.textContent()).match(/^pasted-one$/gm),"one socket writes to the screen").toHaveLength(1);
    await shots(page,"terminal-socket-back");
  }finally{await shell.close()}
});
