import { test,expect } from "@playwright/test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownReply } from "../../scripts/perf/lib/fake-openai.mjs";
import { NATIVE_REPLY_STREAM } from "../../src/native-agent-session.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { gate,live,startStreamingFixture } from "./native-stream-fixture.js";
import { commandItem,replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// Count budgets for the renderer (the perf plan's section 2): what the page does at idle and while a reply streams, measured as
// counts that do not depend on how busy the machine is. Each budget holds the line its fix reached, or the baseline until then.

// B15: CSS animations still running with an infinite iteration count once a page has settled. Any one of them keeps the
// compositor drawing a frame every vsync all day (about 4% of a core across the renderer, GPU and browser processes).
const B15_INFINITE_ANIMATIONS={chat:0,welcome:0,settings:0,projects:0};
const reply=(request,text)=>({id:"perf-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52}});

const infiniteAnimations=page=>page.evaluate(()=>document.getAnimations().filter(animation=>animation.playState==="running"&&animation.effect?.getTiming?.().iterations===Infinity).map(animation=>{const target=animation.effect?.target;return (animation.animationName||animation.constructor.name)+" on "+(target?String(target.className||target.tagName).slice(0,60):"?")}));
// Idle: the page has had time for its entrance animations and loading states to end, with the pointer parked away from it.
const settle=async page=>{await page.mouse.move(2,2);await page.waitForTimeout(1500)};

test("B15: no infinite animation runs at idle on a chat, a new chat, Settings or Projects",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startStreamingFixture(page);
  try{
    const found={};
    // A chat: the thread after one finished turn.
    fixture.script.push(async request=>reply(request,"The relay keeps each turn in order. **Nothing** changed."));
    await fixture.open("Native streaming");await fixture.send("Say how the relay orders turns. Do not change any files.");
    await expect(page.locator(".history-assistant .assistant-message-text")).toContainText("Nothing changed",{timeout:15_000});await settle(page);found.chat=await infiniteAnimations(page);
    await page.getByRole("button",{name:"New thread",exact:true}).click();await expect(page.locator(".welcome")).toBeVisible();await settle(page);found.welcome=await infiniteAnimations(page);
    await page.locator(".sidebar").getByRole("button",{name:"Settings",exact:true}).first().click();await expect(page.getByRole("textbox",{name:"Search settings"})).toBeVisible({timeout:10_000});await settle(page);found.settings=await infiniteAnimations(page);
    await page.getByRole("button",{name:"Projects",exact:true}).click();await expect(page.locator(".projects-page")).toBeVisible({timeout:10_000});await settle(page);found.projects=await infiniteAnimations(page);
    console.log("B15 running infinite animations:",JSON.stringify(found));
    for(const [view,list] of Object.entries(found))expect(list.length,view+": "+list.join(", ")).toBeLessThanOrEqual(B15_INFINITE_ANIMATIONS[view]);
  }finally{await fixture.close()}
});

// B16: while a 20 KB reply streams at 32 deltas a second, the React commits a second (through the DevTools hook React looks for as
// it loads), the Markdown parses of the whole reply so far (any parse over 4 KB, where a finished block or the open tail of this
// reply is under 1 KB) and the characters parsed in all.
const B16_STREAM={commitsPerSecond:16,wholeTextParses:0,charsParsed:200_000};
const countRenders=()=>{
  const perf=window.__trebellPerf={markdown:[],commits:0};
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__={renderers:new Map(),supportsFiber:true,isDisabled:false,checkDCE(){},inject(renderer){const id=this.renderers.size+1;this.renderers.set(id,renderer);return id},onScheduleFiberRoot(){},onCommitFiberRoot(){perf.commits++},onCommitFiberUnmount(){},onPostCommitFiberRoot(){}};
};
const renders=page=>page.evaluate(()=>({commits:window.__trebellPerf.commits,parses:window.__trebellPerf.markdown.length}));

test("B16: a 20 KB reply streams without the whole reply parsed again on every commit",async({page})=>{
  test.setTimeout(120_000);
  await page.addInitScript(countRenders);
  const fixture=await startStreamingFixture(page),text=markdownReply(20_000,{seed:3}),sent=gate(),finish=gate();
  try{
    fixture.script.push(async(request,hook)=>{
      // 24 characters a delta, 32 a second, on a schedule so the pace does not depend on the timer resolution.
      const start=Date.now();
      for(let index=0;index*24<text.length;index++){const wait=start+index*1000/32-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));hook({type:"text",delta:text.slice(index*24,index*24+24)})}
      sent.open();await finish.promise;return reply(request,text);
    });
    await fixture.open("Native streaming");
    const before=await renders(page),startedAt=Date.now();
    await fixture.send("Explain how the relay streams a long reply. Do not change any files.");
    await sent.promise;
    // The last delta is on screen once the live text stops growing (the relay sends every 50 ms and the page draws on the next frame).
    let shown=-1;await expect.poll(async()=>{const length=((await live(page).textContent())||"").length,steady=length===shown;shown=length;return steady},{intervals:[300],timeout:10_000}).toBe(true);
    const seconds=(Date.now()-startedAt)/1000,after=await renders(page);
    const parsed=await page.evaluate(([from,to])=>window.__trebellPerf.markdown.slice(from,to),[before.parses,after.parses]);
    const streamedHtml=await live(page).innerHTML();
    finish.open();
    const finished=page.locator(".history-assistant .assistant-message-text");await expect(finished).toHaveCount(1,{timeout:15_000});
    // The finished reply is one render of the whole text, and the stream showed the same thing last.
    expect(await finished.innerHTML()).toBe(streamedHtml);
    const commits=after.commits-before.commits,commitsPerSecond=Number((commits/seconds).toFixed(1)),wholeTextParses=parsed.filter(chars=>chars>4096).length,charsParsed=parsed.reduce((sum,chars)=>sum+chars,0);
    console.log("B16 a 20 KB reply streaming:",JSON.stringify({seconds,commits,commitsPerSecond,parses:parsed.length,wholeTextParses,charsParsed}));
    expect(commitsPerSecond).toBeLessThanOrEqual(B16_STREAM.commitsPerSecond);
    expect(wholeTextParses).toBeLessThanOrEqual(B16_STREAM.wholeTextParses);
    expect(charsParsed).toBeLessThanOrEqual(B16_STREAM.charsParsed);
  }finally{finish.open();await fixture.close()}
});

// F4(c): a send asks for the context packet while it makes its file checkpoint (the packet only reads files), and uses the packet
// where it did before: a checkpoint that fails still shows its notice above the packet's.
test("F4(c): the context packet is asked for while the checkpoint is made, and its notice follows the checkpoint's",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startStreamingFixture(page),asked=gate(),shown=gate(),finish=gate(),log=[];
  try{
    // The checkpoint fails 0.4 s after the packet has been asked for (so the packet's answer comes first), or after 3 s.
    await page.route(/\/api\/checkpoints$/,async route=>{
      if(route.request().method()!=="POST")return route.fallback();
      log.push("checkpoint asked");await Promise.race([asked.promise,new Promise(resolve=>setTimeout(resolve,3000))]);await new Promise(resolve=>setTimeout(resolve,400));log.push("checkpoint answered");
      await route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate checkpoint failure"})});
    });
    await page.route(/\/api\/context\/packet$/,route=>{log.push("packet asked");asked.open();return route.fallback()});
    const head="## The relay\n\nIt keeps each turn **in order** and writes `item/completed` once, after the call returns, so a reader sees the same history after a reload as while the turn runs.\n\n";
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:head});shown.open();await finish.promise;return reply(request,head+"Done.")});
    await fixture.open("Native streaming");await fixture.send("Say how the relay orders turns. Do not change any files.");await shown.promise;
    const notices=page.locator(".tool-event");
    await expect(notices.filter({hasText:"Trebell context skipped"})).toHaveCount(1,{timeout:10_000});
    const texts=await notices.allTextContents(),checkpointAt=texts.findIndex(text=>text.includes("Could not create file checkpoint")),packetAt=texts.findIndex(text=>text.includes("Trebell context skipped"));
    console.log("F4(c) send:",JSON.stringify({log,checkpointAt,packetAt}));
    expect(log.indexOf("packet asked"),log.join(", ")).toBeLessThan(log.indexOf("checkpoint answered"));
    expect(checkpointAt).toBeGreaterThanOrEqual(0);expect(packetAt).toBeGreaterThan(checkpointAt);
    finish.open();await expect(page.locator(".history-assistant .assistant-message-text")).toContainText("Done.",{timeout:15_000});
  }finally{finish.open();await fixture.close()}
});

// B14 (the page half) and B17: what a project thread left open does at idle, over 30 s with the window focused and 30 s without it:
// the requests the page sends the server (each git/info runs git there) and the page timers that fire, by kind and delay. The test
// switches the focus the page sees (document.hasFocus and the window's blur and focus events), so the run does not depend on the
// browser window's own focus. The only timers that fire are the idle polls': git (3.5 s with focus, 15 s for a remote workspace,
// 30 s without focus), branch reviews and settlements (30 s). Without focus that is git/info twice a minute and the branch reviews'
// own poll twice.
const B14_PAGE_REQUESTS_PER_MINUTE={focused:20,unfocused:4};
const B17_TIMER_FIRES_PER_30S={focused:10,unfocused:2};
const B17_IDLE_POLL_DELAYS=new Set([3500,15_000,30_000]);
const idleInstruments=()=>{
  let focused=true;Document.prototype.hasFocus=function(){return focused};
  window.__setFocus=value=>{focused=value;window.dispatchEvent(new Event(value?"focus":"blur"))};
  const fired=window.__timersFired={};
  for(const [kind,name] of [["timeout","setTimeout"],["interval","setInterval"]]){
    const original=window[name];
    window[name]=function(callback,ms,...rest){if(typeof callback!=="function")return original.call(this,callback,ms,...rest);const key=kind+" "+(Number(ms)||0);return original.call(this,function(...args){fired[key]=(fired[key]||0)+1;return callback.apply(this,args)},ms,...rest)};
  }
};

test("B14, B17: a project thread left open polls git every 3.5 s with focus, every 30 s without it, and at once when it comes back",async({page})=>{
  test.setTimeout(150_000);
  await page.addInitScript(idleInstruments);
  const fixture=await startStreamingFixture(page),requests=[];
  page.on("request",request=>{const url=new URL(request.url());if(url.pathname.startsWith("/api/"))requests.push({at:Date.now(),path:request.method()+" "+url.pathname})});
  try{
    await fixture.open("Native streaming");await page.mouse.move(2,2);await page.waitForTimeout(4000);
    const measure=async()=>{
      const from=Date.now(),before=await page.evaluate(()=>({...window.__timersFired}));await page.waitForTimeout(30_000);
      const after=await page.evaluate(()=>({...window.__timersFired})),to=Date.now(),inWindow=requests.filter(row=>row.at>=from&&row.at<to);
      const timers=Object.fromEntries(Object.entries(after).map(([key,value])=>[key,value-(before[key]||0)]).filter(([,value])=>value>0));
      return {requestsPerMinute:Number((inWindow.length*60_000/(to-from)).toFixed(1)),requests:inWindow.reduce((counts,row)=>({...counts,[row.path]:(counts[row.path]||0)+1}),{}),timerFires:Object.values(timers).reduce((sum,value)=>sum+value,0),timers};
    };
    const focused=await measure();
    // The poll already waiting when the focus goes keeps its time; the window starts after it.
    await page.evaluate(()=>window.__setFocus(false));await page.waitForTimeout(4000);
    const unfocused=await measure();
    const focusAt=Date.now();await page.evaluate(()=>window.__setFocus(true));
    await expect.poll(()=>requests.some(row=>row.at>=focusAt&&row.path==="GET /api/git/info"),{intervals:[100],timeout:5000}).toBe(true);
    const gitAfterFocusMs=requests.find(row=>row.at>=focusAt&&row.path==="GET /api/git/info").at-focusAt;
    console.log("B14/B17 idle on a project thread:",JSON.stringify({focused,unfocused,gitAfterFocusMs}));
    expect(gitAfterFocusMs).toBeLessThan(1000);
    for(const [name,row] of Object.entries({focused,unfocused})){
      expect(row.requestsPerMinute,name+" "+JSON.stringify(row.requests)).toBeLessThanOrEqual(B14_PAGE_REQUESTS_PER_MINUTE[name]);
      expect(row.timerFires,name+" "+JSON.stringify(row.timers)).toBeLessThanOrEqual(B17_TIMER_FIRES_PER_30S[name]);
      expect(Object.keys(row.timers).filter(key=>!B17_IDLE_POLL_DELAYS.has(Number(key.split(" ")[1]))),name).toEqual([]);
    }
  }finally{await fixture.close()}
});

// B11's risk: ChatMarkdown loads after the first paint, so a reply rendered before it arrives shows as its plain text. The first
// reply after a load is already Markdown, live and finished: no reply ever shows as plain text.
const watchPlainText=()=>{const shown=window.__plainTextShown=[];new MutationObserver(()=>{for(const node of document.querySelectorAll(".chat-markdown > p[style]"))if(!shown.includes(node.textContent))shown.push(node.textContent)}).observe(document,{subtree:true,childList:true})};

test("B11: the first reply after a load renders as Markdown, never as its plain text",async({page})=>{
  test.setTimeout(60_000);
  await page.addInitScript(watchPlainText);
  const fixture=await startStreamingFixture(page),shown=gate(),finish=gate();
  // The live draft shows from 160 characters and a blank line on.
  const head="## The relay\n\nIt keeps each turn **in order** and writes `item/completed` once, after the call returns, so a reader sees the same history after a reload as while the turn runs.\n\n";
  try{
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:head});shown.open();await finish.promise;return reply(request,head+"- one\n- two\n\n```js\nconst value = 1;\n```")});
    await fixture.open("Native streaming");await fixture.send("Say how the relay orders turns. Do not change any files.");await shown.promise;
    await expect(live(page).locator("h2")).toHaveText("The relay");await expect(live(page).locator("strong")).toHaveText("in order");
    finish.open();await expect(page.locator(".history-assistant .assistant-message-text pre")).toContainText("const value = 1;",{timeout:15_000});
    expect(await page.evaluate(()=>window.__plainTextShown)).toEqual([]);
  }finally{finish.open();await fixture.close()}
});

// B12: what a load asks the server for once the server holds the catalog of every thread it lists. The page compared its own
// snapshot with the server's compacted copy, which never matched, so every load posted every listed thread again (100 POSTs per
// load on the perf home, scripts/perf/reload.mjs). The server had made those posts write nothing, but they were all still sent.
const B12_RELOAD={apiRequests:20,threadMetaPosts:1};

test("B12: a reload posts none of the thread catalogs the server already holds",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startRelayHarness(),metaHome=await mkdtemp(join(tmpdir(),"trebell-b12-meta-")),metaStore=new TrebellStateStore({...process.env,TREBELL_HOME:metaHome});
  try{
    for(let index=1;index<=30;index++){
      const thread=harness.seedThread("Catalog thread "+index);
      metaStore.updateThreadMeta(thread.id,{projectless:false,environmentId:null,cwd:harness.repo,runtime:"native",runtimeInstanceId:"native-default"});
    }
    await routeRelayApp(page,harness,{metaStore});
    const requests=[];page.on("request",request=>{const url=new URL(request.url());if(url.pathname.startsWith("/api/"))requests.push({at:Date.now(),path:request.method()+" "+url.pathname})});
    const posts=(from=0)=>requests.filter(row=>row.at>=from&&row.path==="POST /api/thread-meta").length;
    // The first load stores each listed thread's catalog, which the server did not hold yet; it is done once the posts stop.
    await page.goto("/");await expect(page.locator(".thread-row").first()).toBeVisible({timeout:15_000});
    let last=-1;await expect.poll(()=>{const now=posts(),steady=now>0&&now===last;last=now;return steady},{intervals:[1000],timeout:20_000}).toBe(true);
    const reloadAt=Date.now();await page.reload();await expect(page.locator(".thread-row").first()).toBeVisible({timeout:15_000});
    await page.waitForTimeout(Math.max(0,reloadAt+4000-Date.now()));
    const loaded=requests.filter(row=>row.at>=reloadAt&&row.at<reloadAt+4000);
    console.log("B12 a reload:",JSON.stringify({firstLoadPosts:posts()-posts(reloadAt),apiRequests:loaded.length,threadMetaPosts:posts(reloadAt),requests:loaded.reduce((counts,row)=>({...counts,[row.path]:(counts[row.path]||0)+1}),{})}));
    expect(posts(reloadAt)).toBeLessThanOrEqual(B12_RELOAD.threadMetaPosts);
    expect(loaded.length).toBeLessThanOrEqual(B12_RELOAD.apiRequests);
  }finally{await harness.close();await rm(metaHome,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

// B13: the HTTP requests opening a short thread sends the server, from the click until its history shows and the page settles
// (the thread itself comes over the relay's socket, which is not counted). The idle git poll can fall inside the window, so it is
// listed apart, and only the git info the open asks for is held to its own line.
const B13_OPEN={requests:5,gitInfo:2};
const IDLE_POLLS=new Set(["GET /api/git/info","GET /api/source-control/branch-reviews"]);

test("B13: opening a short thread sends the server at most 5 requests",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startRelayHarness(),metaHome=await mkdtemp(join(tmpdir(),"trebell-b13-meta-")),metaStore=new TrebellStateStore({...process.env,TREBELL_HOME:metaHome});
  try{
    for(const name of ["Open budget first","Open budget second"]){
      const thread=harness.seedThread(name,[{user:"Say how the relay orders turns",items:[replyItem("b13-reply-"+harness.threads.length,name+": each turn in order.")]}]);
      metaStore.updateThreadMeta(thread.id,{projectless:false,environmentId:null,cwd:harness.repo,runtime:"native",runtimeInstanceId:"native-default"});
    }
    await routeRelayApp(page,harness,{metaStore});
    const requests=[];page.on("request",request=>{const url=new URL(request.url());if(url.pathname.startsWith("/api/"))requests.push({at:Date.now(),path:request.method()+" "+url.pathname})});
    const row=name=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
    await page.goto("/");await expect(row("Open budget second")).toBeVisible({timeout:15_000});
    // Settled: the first load's catalog posts are done and nothing has been asked for a second.
    let last=-1;await expect.poll(()=>{const now=requests.length,steady=now===last;last=now;return steady},{intervals:[1000],timeout:20_000}).toBe(true);
    const openAt=Date.now();await row("Open budget second").locator(".thread-main").click();
    await expect(page.locator(".assistant-message-text").filter({hasText:"Open budget second: each turn in order."})).toBeVisible({timeout:15_000});
    await page.waitForTimeout(1500);
    const sent=requests.filter(item=>item.at>=openAt),counted=sent.filter(item=>!IDLE_POLLS.has(item.path));
    const byPath=list=>list.reduce((counts,item)=>({...counts,[item.path]:(counts[item.path]||0)+1}),{});
    console.log("B13 a thread open:",JSON.stringify({requests:counted.length,counted:byPath(counted),idlePolls:byPath(sent.filter(item=>IDLE_POLLS.has(item.path)))}));
    expect(counted.length,JSON.stringify(byPath(counted))).toBeLessThanOrEqual(B13_OPEN.requests);
    expect(sent.filter(item=>item.path==="GET /api/git/info").length,"git/info around the open").toBeLessThanOrEqual(B13_OPEN.gitInfo);
  }finally{await harness.close();await rm(metaHome,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

// B20: the elements Chrome restyles for each key typed in the composer, from a trace's style recalculations (their elementCount)
// over a thread of 40 turns. A :has() rule on the chat workspace had every key restyle the whole workspace, the conversation with it:
// React rewrites the composer's text on each key, and Chrome takes that for a change under every :has() rule's element above it (884
// elements a key, 2.7 s of style work per 200 keys, on the perf run's 1000-turn thread).
const B20_TYPING={elementsPerKey:12};

test("B20: a key typed in the composer restyles the composer, not the conversation above it",async({page,browser})=>{
  test.setTimeout(60_000);
  const harness=await startRelayHarness();
  try{
    harness.seedThread("Typing budget",Array.from({length:40},(_,index)=>({user:"Turn "+index+": say how the relay keeps the order of items.",items:[commandItem("b20-command-"+index,"npm test",{output:"ok "+index+"\n"}),replyItem("b20-reply-"+index,"The relay keeps **turn "+index+"** in order.\n\n- It writes `item/completed` once.\n- A reload reads the same history.")]})));
    await routeRelayApp(page,harness);
    await page.goto("/");await page.locator('.thread-row .thread-main[title="Typing budget"]').click();
    await expect(page.locator(".assistant-message-text").filter({hasText:"turn 39 in order"})).toBeVisible({timeout:15_000});
    const composer=page.getByTestId("composer");await composer.click();await page.waitForTimeout(500);
    const workspaceElements=await page.locator(".chat-workspace").evaluate(node=>node.getElementsByTagName("*").length);
    const cdp=await page.context().newCDPSession(page),{frameTree}=await cdp.send("Page.getFrameTree");
    const typed="Refactor the relay so each chunk updates the live turn";
    await browser.startTracing(page,{categories:["devtools.timeline"]});
    await page.keyboard.type(typed,{delay:20});await page.waitForTimeout(300);
    const trace=JSON.parse((await browser.stopTracing()).toString("utf8"));
    await expect(composer).toHaveValue(typed);
    const recalcs=(trace.traceEvents||trace).filter(event=>event.name==="UpdateLayoutTree"&&event.args?.beginData?.frame===frameTree.frame.id).map(event=>event.args.elementCount||0);
    const elements=recalcs.reduce((sum,count)=>sum+count,0),elementsPerKey=Number((elements/typed.length).toFixed(1));
    console.log("B20 typing:",JSON.stringify({keys:typed.length,workspaceElements,recalcs:recalcs.length,elements,elementsPerKey,largest:Math.max(0,...recalcs)}));
    expect(workspaceElements,"a conversation large enough to show a restyle of the whole workspace").toBeGreaterThan(300);
    expect(recalcs.length,"the trace has the page's style recalculations").toBeGreaterThanOrEqual(typed.length);
    expect(elementsPerKey).toBeLessThanOrEqual(B20_TYPING.elementsPerKey);
  }finally{await harness.close()}
});

// B23: the elements Chrome restyles for each delta of a reply streaming into a thread of 40 turns, from a trace's style
// recalculations (their elementCount) over 4 s of the stream, at 24 characters a delta and 32 deltas a second as in B16, then over
// 2.5 s with the undo toast of another thread archived meanwhile. The latest turn's reading order was set by :has() rules on the
// conversation column, and the undo toast's place by a :has() on the app shell over all it holds: Chrome restyled the whole
// conversation for each element the reply added, and the whole app with the toast up (110.1 and 169 elements a delta, up to 459 and
// 757 at once). App now names the live block in the column's class (with-agent-block), and the toast's :has() looks only at the
// app shell's children.
const B23_STREAM={elementsPerDelta:40};

test("B23: a streamed delta restyles the reply it grows, not the conversation around it",async({page,browser})=>{
  test.setTimeout(90_000);
  const text=markdownReply(14_000,{seed:3}),finish=gate();let deltas=0;
  const harness=await startRelayHarness({replies:[async request=>{
    const hook=request[NATIVE_REPLY_STREAM],start=Date.now();
    for(let index=0;index*24<text.length;index++){const wait=start+index*1000/32-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));hook({type:"text",delta:text.slice(index*24,index*24+24)});deltas++}
    await finish.promise;return {text};
  }]});
  try{
    harness.seedThread("Archived while streaming",[{user:"Say hello.",items:[replyItem("b23-other-reply","Hello.")]}]);
    harness.seedThread("Streaming budget",Array.from({length:40},(_,index)=>({user:"Turn "+index+": say how the relay keeps the order of items.",items:[commandItem("b23-command-"+index,"npm test",{output:"ok "+index+"\n"}),replyItem("b23-reply-"+index,"The relay keeps **turn "+index+"** in order.\n\n- It writes `item/completed` once.\n- A reload reads the same history.")]})));
    await routeRelayApp(page,harness);
    await page.goto("/");await page.locator('.thread-row .thread-main[title="Streaming budget"]').click();
    await expect(page.locator(".assistant-message-text").filter({hasText:"turn 39 in order"})).toBeVisible({timeout:15_000});
    await page.getByTestId("composer").fill("Explain how the relay streams a long reply. Do not change any files.");await page.getByTestId("send").click();
    await expect(live(page).locator("h2").first()).toBeVisible({timeout:15_000});await page.waitForTimeout(1000);
    const cdp=await page.context().newCDPSession(page),{frameTree}=await cdp.send("Page.getFrameTree");
    const conversationElements=await page.locator(".conversation-column").evaluate(node=>node.getElementsByTagName("*").length);
    expect(conversationElements,"a conversation large enough to show a restyle of the whole conversation").toBeGreaterThan(1000);
    const traceStream=async(name,ms)=>{
      await browser.startTracing(page,{categories:["devtools.timeline"]});
      const from=deltas;await page.waitForTimeout(ms);const streamed=deltas-from,toasts=await page.getByTestId("thread-undo-toast").count();
      const trace=JSON.parse((await browser.stopTracing()).toString("utf8"));
      const recalcs=(trace.traceEvents||trace).filter(event=>event.name==="UpdateLayoutTree"&&event.args?.beginData?.frame===frameTree.frame.id).map(event=>event.args.elementCount||0);
      const elements=recalcs.reduce((sum,count)=>sum+count,0),elementsPerDelta=Number((elements/Math.max(1,streamed)).toFixed(1));
      console.log("B23 "+name+":",JSON.stringify({deltas:streamed,conversationElements,toasts,recalcs:recalcs.length,elements,elementsPerDelta,largest:Math.max(0,...recalcs)}));
      expect(streamed,name+": deltas streamed while traced").toBeGreaterThanOrEqual(ms/40);
      expect(recalcs.length,name+": the trace has the page's style recalculations").toBeGreaterThanOrEqual(ms/150);
      return {elementsPerDelta,toasts};
    };
    const streaming=await traceStream("a reply streaming",4000);
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Archived while streaming"]')});
    await row.hover();await row.locator("summary[title='Thread actions']").click();await row.getByRole("button",{name:"Archive",exact:true}).click();
    await expect(page.getByTestId("thread-undo-toast")).toBeVisible({timeout:5000});await page.waitForTimeout(300);
    const withToast=await traceStream("with the undo toast up",2500);
    expect(withToast.toasts,"the undo toast showed all through the trace").toBe(1);
    expect(streaming.elementsPerDelta,"elements restyled per delta").toBeLessThanOrEqual(B23_STREAM.elementsPerDelta);
    expect(withToast.elementsPerDelta,"elements restyled per delta with the undo toast up").toBeLessThanOrEqual(B23_STREAM.elementsPerDelta);
    finish.open();await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeHidden({timeout:30_000});
  }finally{finish.open();await harness.close()}
});
