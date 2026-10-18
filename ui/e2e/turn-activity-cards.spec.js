import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { routeCodexApp, startCodexHarness } from "./codex-history-harness.js";
import { commandItem, fileChangeItem, replyItem, routeRelayApp, runCall, startRelayHarness, writeFileCall } from "./relay-history-harness.js";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/turn-activity-cards/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);
// Fit is checked at every width the layout changes around; screenshots are kept at two of them (and once at 900 wide).
const FIT_SIZES=[[900,800],[1180,800],[1280,800],[1600,980]],SHOT_SIZES=["1280x800","1600x980"];

async function openThreadRow(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
const cardOf=(page,turnId)=>page.locator(`.turn-card [data-testid=activity-card][data-turn-id="${turnId}"]`);
const pastCards=page=>page.locator(".turn-card [data-testid=activity-card]");
const liveCard=page=>page.locator(".agent-block [data-testid=activity-card]");
const reply=(page,text)=>page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:text});
// The reply text that holds text, wherever it shows: streaming under the live card, or in the conversation.
const replyText=(page,text)=>page.locator(".agent-block .assistant-answer, .history-assistant .assistant-message-text").filter({hasText:text});
const timesIn=(text,part)=>text.split(part).length-1;
// The socket frames the page has received, so a test knows a notification reached the window before the person goes on.
function socketFrames(page){const seen=[];page.on("websocket",socket=>socket.on("framereceived",frame=>seen.push(String(frame.payload||""))));return seen}
const userRow=(page,text)=>page.locator(".user-row").filter({hasText:text});
const headTop=card=>card.locator(".activity-card-head").evaluate(node=>node.getBoundingClientRect().top);
const distanceFromEnd=page=>page.locator(".conversation-scroll").evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
const box=async locator=>{const value=await locator.boundingBox();expect(value).toBeTruthy();return value};
// Whether the nodes come in this order in the document, whatever the layout shows.
async function inDocumentOrder(page,...locators){
  const handles=await Promise.all(locators.map(locator=>locator.elementHandle()));
  return page.evaluate(nodes=>nodes.every((node,index)=>!index||Boolean(nodes[index-1].compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)),handles);
}
// The pills of the replies on screen, read where they show: a virtual list does not mount every row.
const pillsInView=page=>page.locator(".conversation-scroll").evaluate(node=>{
  const view=node.getBoundingClientRect();
  return [...node.querySelectorAll(".history-assistant[data-message-id]")].filter(row=>{const rect=row.getBoundingClientRect();return rect.height&&rect.bottom>view.top&&rect.top<view.bottom}).map(row=>row.querySelector("[data-testid=turn-outcome]")?.textContent||"none");
});
async function expectDonePillsInView(page){
  const pills=await pillsInView(page);expect(pills.length).toBeGreaterThan(0);
  for(const pill of pills)expect(pill).toMatch(/^done(?: · \d[\d.]*m?s)?$/);
}

// Every card on screen reads whole: its head fits, the summary ends in an ellipsis when cut and its tooltip has all of it, the
// chevron is inside the card, the card starts where the replies' text does, a closed card is one 36px line, and the
// conversation never scrolls sideways.
function cardFit(page){
  return page.evaluate(()=>{
    const scroll=document.querySelector(".conversation-scroll"),view=scroll.getBoundingClientRect(),problems=[];
    if(scroll.scrollWidth>scroll.clientWidth+1)problems.push("the conversation scrolls sideways");
    const body=[...document.querySelectorAll(".history-assistant-body")].find(node=>node.getBoundingClientRect().width);
    for(const card of document.querySelectorAll("[data-testid=activity-card]")){
      const rect=card.getBoundingClientRect();if(!rect.height||rect.bottom<view.top||rect.top>view.bottom)continue;
      const name="card "+(card.dataset.turnId||"?"),head=card.querySelector(".activity-card-head"),summary=card.querySelector(".activity-card-summary"),chevron=card.querySelector(".activity-card-chevron").getBoundingClientRect();
      if(head.scrollWidth>head.clientWidth+1)problems.push(name+": the head is wider than the card");
      const style=getComputedStyle(summary);if(style.textOverflow!=="ellipsis"||style.whiteSpace!=="nowrap")problems.push(name+": the summary does not end in an ellipsis");
      if(summary.title!==summary.textContent)problems.push(name+": the summary's tooltip is not its text");
      if(chevron.left<rect.left||chevron.right>rect.right||chevron.top<rect.top||chevron.bottom>rect.bottom)problems.push(name+": the chevron is outside the card");
      if(card.dataset.state==="closed"&&Math.abs(rect.height-36)>1)problems.push(name+": a closed card is "+rect.height+"px tall");
      if(body&&Math.abs(body.getBoundingClientRect().left-rect.left)>1)problems.push(name+": starts at "+rect.left+", the replies at "+body.getBoundingClientRect().left);
    }
    return problems;
  });
}
// Checks the fit at every size (or the sizes given) in both modes with target in the middle of the view, and saves the state's
// screenshots.
async function auditCards(page,state,target,{once900=false,sizes=FIT_SIZES}={}){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});await frames(page,3);
      await target.evaluate(node=>node.scrollIntoView({block:"center"}));await frames(page,4);
      expect(await cardFit(page),`${state} ${mode} ${width}x${height}`).toEqual([]);
      const size=width+"x"+height;
      if(SHOT_SIZES.includes(size)||(once900&&mode==="dark"&&width===900))await page.screenshot({animations:"disabled",path:`${auditDir}${mode}-${size}-${state}.png`});
    }
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});await frames(page,3);
}

// Codex fixtures: a stored turn, and a command and a reply as a running turn sends them.
const codexTurn=(index,{user="",commands=[],reply=""}={})=>({id:"codex-turn-"+index,status:"completed",startedAt:Math.floor(Date.now()/1000)-4000+index*10,completedAt:Math.floor(Date.now()/1000)-4000+index*10+2,durationMs:2100,error:null,items:[
  ...(user?[{id:"user-codex-turn-"+index,type:"userMessage",content:[{type:"text",text:user}]}]:[]),
  ...commands.map((command,step)=>({id:`cmd-${index}-${step+1}`,type:"commandExecution",command,cwd:process.cwd(),status:"completed",aggregatedOutput:"ok\n",exitCode:0})),
  ...(reply?[{id:"agent-codex-turn-"+index,type:"agentMessage",text:reply}]:[]),
]});
const codexThread=(id,name)=>({id,name,preview:name,cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-5000,updatedAt:Date.now()/1000,turns:[]});
function codexCommand(turn,{emit,threadId},id,command){
  const item={id,type:"commandExecution",command,cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null};turn.items.push(item);
  emit({method:"item/started",params:{threadId,turnId:turn.id,item:{...item}}});
  Object.assign(item,{status:"completed",aggregatedOutput:"ok\n",exitCode:0});emit({method:"item/completed",params:{threadId,turnId:turn.id,item:{...item}}});
}
function codexReply(turn,{emit,threadId},text){const answer={id:"agent-"+turn.id,type:"agentMessage",text};turn.items.push(answer);emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}})}
const long=label=>Array.from({length:16},(_,index)=>`${label} note ${index+1}: the change is in place and its check passed.`).join("\n\n");
// A Native step that runs for ms before it prints "slow-done", with room to spare under its time limit.
const slowRunCall=(id,ms)=>({id,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e",`setTimeout(()=>console.log('slow-done'),${ms})`],cwd:".",timeout_ms:30_000})});
// Holds the page's turn/start requests back by window.__holdTurnStartMs, as a harness slow to start a turn does.
async function holdTurnStart(page){
  await page.addInitScript(()=>{
    const send=WebSocket.prototype.send;window.__holdTurnStartMs=0;
    WebSocket.prototype.send=function(data){
      const hold=window.__holdTurnStartMs;
      if(hold&&typeof data==="string"&&data.includes('"method":"turn/start"')){setTimeout(()=>send.call(this,data),hold);return}
      return send.call(this,data);
    };
  });
}
// Records in every frame, once a user row with text shows, which turn the live card names and whether it is open.
const watchLiveCard=(page,text)=>page.evaluate(sent=>{
  window.__liveFrames=[];window.__watching=true;
  const tick=()=>{
    if(!window.__watching)return;
    const card=document.querySelector(".agent-block [data-testid=activity-card]");
    if(card&&[...document.querySelectorAll(".user-row")].some(node=>node.textContent.includes(sent)))window.__liveFrames.push({turn:card.dataset.turnId||"",state:card.dataset.state});
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
},text);
const liveCardFrames=page=>page.evaluate(()=>{window.__watching=false;return window.__liveFrames});

test("a relay turn's steps move to a closed card of their own when the next turn starts, toggle in place and return after a reload",async({page})=>{
  test.setTimeout(150_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("card-write-1","notes.txt","first\n")]},
    {toolCalls:[runCall("card-run-1","console.log('first-check')")]},
    {text:"First turn answer.\n\n"+long("First")},
    {toolCalls:[runCall("card-run-2","console.log('second-check')")]},
    {text:"Second turn answer.\n\n"+long("Second")},
  ]});
  const thread=harness.seedThread("Relay cards live");
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay cards live");
    const composer=page.getByTestId("composer");
    await composer.fill("First request: write the notes and check them");await page.getByTestId("send").click();
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});
    // While it is the live card's turn, the steps show there, open, and nowhere else. The live card also lists the notice the
    // send added (the repository context, skipped here), and counts it: a notice is live-only, so the past card will not.
    await expect(liveCard(page)).toHaveAttribute("data-state","open");
    await expect(liveCard(page).locator(".activity-card-summary")).toHaveText("3 steps");
    await expect(liveCard(page).locator(".tool-event")).toHaveCount(3);await expect(liveCard(page).locator(".tool-event.kind-context")).toHaveCount(1);
    await expect(pastCards(page)).toHaveCount(0);
    await auditCards(page,"live-card",liveCard(page));
    const [first]=harness.turns(thread);

    await composer.fill("Second request: check again");await page.getByTestId("send").click();
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:20_000});
    // Turn 1's steps are its own closed card now, between its message and its reply, and only there.
    const past=cardOf(page,first.id);
    await expect(past).toHaveAttribute("data-state","closed");await expect(past.locator(".tool-event")).toHaveCount(0);
    await expect(past.locator(".activity-card-summary")).toHaveText("2 steps");
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${first.id}"]`)).toHaveCount(1);
    expect(await inDocumentOrder(page,userRow(page,"First request"),past,reply(page,"First turn answer."))).toBe(true);
    // The live block lists turn 2 alone.
    const liveSteps=page.locator(".agent-block .tool-event");
    await expect(liveSteps.filter({hasText:"second-check"})).toHaveCount(1);
    await expect(liveSteps.filter({hasText:"first-check"})).toHaveCount(0);await expect(liveSteps.filter({hasText:"notes.txt"})).toHaveCount(0);

    // Scrolled away from the end, the head stays where it was clicked, opening and closing; Enter and Space work it too.
    const head=past.locator(".activity-card-head");
    await past.evaluate(node=>node.scrollIntoView({block:"center"}));await frames(page,4);
    expect(await distanceFromEnd(page)).toBeGreaterThan(200);
    const top=await headTop(past);
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded","true");await expect(past.locator(".tool-event")).toHaveCount(2);
    await expect(page.locator("#"+await head.getAttribute("aria-controls"))).toHaveCount(1);
    await frames(page,3);expect(Math.abs(await headTop(past)-top)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Enter");
    await expect(head).toHaveAttribute("aria-expanded","false");await expect(past.locator(".tool-event")).toHaveCount(0);await expect(head).not.toHaveAttribute("aria-controls",/./);
    await frames(page,3);expect(Math.abs(await headTop(past)-top)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Space");
    await expect(head).toHaveAttribute("aria-expanded","true");await expect(past.locator(".tool-event")).toHaveCount(2);
    await frames(page,3);expect(Math.abs(await headTop(past)-top)).toBeLessThanOrEqual(1);
    await expect(head).toBeFocused();expect(await head.evaluate(node=>node.matches(":focus-visible"))).toBe(true);
    await auditCards(page,"focus-ring",past);

    // After a reload the newest turn's card is open and the older one closed, each with the steps its turn stored.
    await page.reload();await openThreadRow(page,"Relay cards live");
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:10_000});
    const [,second]=harness.turns(thread);
    await expect(pastCards(page)).toHaveCount(2);
    expect(new Set(await pastCards(page).evaluateAll(nodes=>nodes.map(node=>node.dataset.turnId))).size).toBe(2);
    await expect(cardOf(page,second.id)).toHaveAttribute("data-state","open");await expect(cardOf(page,first.id)).toHaveAttribute("data-state","closed");
    await expect(cardOf(page,second.id).locator(".tool-event")).toHaveCount(1);
    await cardOf(page,first.id).locator(".activity-card-head").click();await expect(cardOf(page,first.id).locator(".tool-event")).toHaveCount(2);
    for(const text of ["First turn answer.","Second turn answer."]){await reply(page,text).evaluate(node=>node.scrollIntoView({block:"end"}));await frames(page,3);await expectDonePillsInView(page)}
  }finally{await harness.close()}
});

test("stored relay turns open on their cards: the newest open, older ones closed with their failures counted, every reply done",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startRelayHarness();
  harness.seedThread("Relay cards stored",[
    {user:"Fix the failing parser test",items:[fileChangeItem("stored-edit-1","src/parser.js"),commandItem("stored-test-1","npm test -- parser",{output:"1 failing\n  parser handles empty input\n",exitCode:1}),replyItem("stored-answer-1","The parser test still fails: the fixture needs the empty case.")]},
    {user:"Add the empty case to the fixture and run everything again",items:[fileChangeItem("stored-edit-2","test/fixtures/parser-empty.json"),commandItem("stored-test-2","npm test"),commandItem("stored-lint-2","npm run lint"),replyItem("stored-answer-2","Both pass now: the fixture has the empty case.")]},
  ]);
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay cards stored");
    await expect(reply(page,"Both pass now")).toBeVisible({timeout:10_000});
    await expect(pastCards(page)).toHaveCount(2);
    const [older,newest]=harness.turns(harness.threads[0]);
    await expect(cardOf(page,newest.id)).toHaveAttribute("data-state","open");await expect(cardOf(page,newest.id).locator(".tool-event")).toHaveCount(3);
    await expect(cardOf(page,newest.id).locator(".activity-card-summary")).toHaveText("3 steps");
    // The older card is closed and says how many of its steps failed.
    await expect(cardOf(page,older.id)).toHaveAttribute("data-state","closed");
    await expect(cardOf(page,older.id).locator(".activity-card-summary")).toHaveText("2 steps");await expect(cardOf(page,older.id).locator(".activity-card-failed")).toHaveText("1 failed");
    // Each reply has its done pill. These turns ran for milliseconds, but the relay stores whole seconds, so one seeded across a
    // second boundary reads 1.0s; no longer time is ever shown.
    await expect(reply(page,"Both pass now").getByTestId("turn-outcome")).toHaveText(/^done(?: · 1\.0s)?$/);
    await expect(reply(page,"The parser test still fails").getByTestId("turn-outcome")).toHaveText(/^done(?: · 1\.0s)?$/);
    await auditCards(page,"past-cards",cardOf(page,older.id),{once900:true});
    // Opened, the older card lists the failed step as failed.
    await cardOf(page,older.id).locator(".activity-card-head").click();
    await expect(cardOf(page,older.id).locator(".tool-event.status-error")).toHaveCount(1);
    await auditCards(page,"open-past-card",cardOf(page,older.id));
  }finally{await harness.close()}
});

test("a Codex turn that finished without a reply says so under its card, live, after the next turn and after a reload",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-no-reply","Codex no reply");
  const harness=await startCodexHarness(thread,[
    (turn,tools)=>{tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});codexCommand(turn,tools,"cmd-"+turn.id,"npm run format");tools.finish("completed")},
    (turn,tools)=>{tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});codexReply(turn,tools,"Second turn answer.");tools.finish("completed")},
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex no reply");
    const composer=page.getByTestId("composer"),row=page.locator('[data-testid=turn-outcome-row][data-turn-id="codex-turn-1"]');
    await composer.fill("Format the code");await page.getByTestId("send").click();
    await expect(row).toBeVisible({timeout:10_000});
    await expect(row.getByTestId("turn-outcome")).toHaveText(/^done/);await expect(row.locator(".turn-outcome-message")).toHaveText("Finished without a reply.");
    // Live, the row reads below the card that lists the turn's step.
    const [cardBox,rowBox]=[await box(liveCard(page)),await box(row)];expect(rowBox.y).toBeGreaterThanOrEqual(cardBox.y+cardBox.height-1);

    await composer.fill("Anything else?");await page.getByTestId("send").click();
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:10_000});
    const expectRowUnderClosedCard=async()=>{
      await expect(row.locator(".turn-outcome-message")).toHaveText("Finished without a reply.");
      const card=cardOf(page,"codex-turn-1");await expect(card).toHaveAttribute("data-state","closed");
      const [above,below]=[await box(card),await box(row)];expect(below.y).toBeGreaterThanOrEqual(above.y+above.height-1);
      expect(await inDocumentOrder(page,userRow(page,"Format the code"),card,row)).toBe(true);
    };
    await expectRowUnderClosedCard();
    await page.reload();await openThreadRow(page,"Codex no reply");
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:10_000});
    await expect(row.getByTestId("turn-outcome")).toHaveText("done · 2.1s");await expectRowUnderClosedCard();
    await auditCards(page,"no-reply-row",row);
  }finally{await harness.close()}
});

test("an imported conversation never says a request finished without a reply",async({page})=>{
  test.setTimeout(60_000);
  const { claudeMessagesToTurns }=await import("../../src/agent-history-import.mjs");
  const harness=await startRelayHarness();
  // A Claude Code transcript: a request interrupted before any text (its tool call is not imported), the interrupt marker, and a
  // request answered. The import keeps the messages and calls every turn completed.
  const turns=claudeMessagesToTurns([
    {type:"user",uuid:"u1",message:{role:"user",content:"Refactor the parser"}},
    {type:"assistant",uuid:"a1",message:{role:"assistant",content:[{type:"tool_use",id:"t1",name:"Read",input:{file_path:"src/parser.js"}}]}},
    {type:"user",uuid:"u2",message:{role:"user",content:[{type:"text",text:"[Request interrupted by user]"}]}},
    {type:"user",uuid:"u3",message:{role:"user",content:"Just rename parse to parseInput"}},
    {type:"assistant",uuid:"a3",message:{role:"assistant",content:[{type:"text",text:"Renamed parse to parseInput everywhere."}]}},
  ],{createdAt:Date.now()-60_000});
  harness.threads.push(harness.threadStore.importHistory({runtime:"native",cwd:harness.repo,providerSessionId:"imported-claude",model:"gpt-5.6",name:"Imported conversation",preview:"Imported",turns,providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null,historyImport:{source:"claude",sourceId:"imported-claude",importedAt:Date.now()}}}));
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Imported conversation");
    const answered=reply(page,"Renamed parse to parseInput everywhere.");
    await expect(answered).toBeVisible({timeout:10_000});await expect(userRow(page,"[Request interrupted by user]")).toBeVisible();
    // The answer reads done; the turns without one claim nothing, as the import cannot tell them from interrupted ones.
    await expect(answered.getByTestId("turn-outcome")).toHaveText("done");
    await expect(page.getByTestId("turn-outcome-row")).toHaveCount(0);await expect(pastCards(page)).toHaveCount(0);
    await auditCards(page,"imported-no-reply",answered);
  }finally{await harness.close()}
});

test("a newest relay turn longer than the open page is completed with one request and keeps its steps when earlier messages load",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startRelayHarness();
  harness.seedThread("Relay long turn",[
    {user:"Set the project up",items:[replyItem("long-answer-1","Set up.")]},
    {user:"Run every check",items:[...Array.from({length:150},(_,index)=>commandItem("long-check-"+(index+1),"check "+(index+1))),replyItem("long-answer-2","All 150 checks passed.")]},
  ]);
  try{
    const {sent}=await routeRelayApp(page,harness);
    const [,newest]=harness.turns(harness.threads[0]);
    const turnCalls=()=>sent.filter(call=>call.method==="thread/items/list"&&call.params.turnId);
    await page.goto("/");await openThreadRow(page,"Relay long turn");
    await expect(reply(page,"All 150 checks passed.")).toBeVisible({timeout:10_000});
    const card=cardOf(page,newest.id);
    await expect(card.locator(".activity-card-summary")).toHaveText("150 steps");
    await expect(card.locator(".timeline-window-controls span")).toHaveText("31–150 of 150");
    expect(turnCalls().map(call=>({turnId:call.params.turnId,sortDirection:call.params.sortDirection,limit:call.params.limit}))).toEqual([{turnId:newest.id,sortDirection:"desc",limit:400}]);
    // Loading earlier messages brings the turn's message; its card keeps the same 150 steps, once each, with no new request.
    await page.locator(".conversation-scroll").evaluate(node=>{node.scrollTop=0});await frames(page,4);
    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(userRow(page,"Run every check")).toBeVisible({timeout:10_000});
    await expect(card.locator(".activity-card-summary")).toHaveText("150 steps");await expect(card.locator(".timeline-window-controls span")).toHaveText("31–150 of 150");
    const titles=await card.locator(".tool-event summary strong").allTextContents();
    expect(titles).toEqual(Array.from({length:120},(_,index)=>"check "+(index+31)));
    expect(turnCalls()).toHaveLength(1);
  }finally{await harness.close()}
});

test("a newest Codex turn whose steps could not all be read says some are not loaded",async({page})=>{
  test.setTimeout(60_000);
  const thread=codexThread("codex-cut-newest","Codex cut newest");
  const harness=await startCodexHarness(thread,[],{pageItems:100,failTurnItems:true,seed:[
    codexTurn(1,{user:"Set the project up",reply:"Set up."}),
    codexTurn(2,{user:"Run every check",commands:Array.from({length:150},(_,index)=>"check "+(index+1)),reply:"All 150 checks passed."}),
  ]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex cut newest");
    await expect(reply(page,"All 150 checks passed.")).toBeVisible({timeout:10_000});
    const card=cardOf(page,"codex-turn-2");
    await expect(card.locator(".activity-card-summary")).toHaveText("99 steps · some steps not loaded");
    await expect(card.locator(".activity-card-summary")).toHaveAttribute("title","99 steps · some steps not loaded");
    await expect(card.locator(".tool-event")).toHaveCount(99);
    expect(harness.calls.filter(call=>call.method==="thread/items/list"&&call.params.turnId)).toHaveLength(1);
    await auditCards(page,"incomplete-suffix",card.locator(".activity-card-head"));
  }finally{await harness.close()}
});

test("an older turn cut by the open page reads as not fully loaded until earlier messages load, and the view keeps its place",async({page})=>{
  test.setTimeout(60_000);
  const thread=codexThread("codex-cut-older","Codex cut older");
  const seed=Array.from({length:30},(_,index)=>codexTurn(index+1,{user:`Request ${index+1}`,commands:Array.from({length:5},(_,step)=>`step ${index+1}.${step+1}`),reply:`Answer ${index+1}.`}));
  const harness=await startCodexHarness(thread,[],{pageItems:100,seed});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex cut older");
    await expect(reply(page,"Answer 30.")).toBeVisible({timeout:10_000});
    // The open page ends inside turn 16: one of its five steps, its reply and none of its message.
    await expect(pastCards(page)).toHaveCount(15);
    await expect(cardOf(page,"codex-turn-16").locator(".activity-card-summary")).toHaveText("1 step · some steps not loaded");
    await expect(cardOf(page,"codex-turn-17").locator(".activity-card-summary")).toHaveText("5 steps");
    expect(harness.calls.filter(call=>call.method==="thread/items/list"&&call.params.turnId)).toHaveLength(0);
    const scroll=page.locator(".conversation-scroll");await scroll.evaluate(node=>{node.scrollTop=0});await frames(page,4);
    const firstInView=()=>scroll.evaluate(node=>{const top=node.getBoundingClientRect().top,row=[...node.querySelectorAll("[data-message-id]")].find(element=>element.getBoundingClientRect().bottom>top);return row?{id:row.dataset.messageId,top:row.getBoundingClientRect().top}:null});
    const before=await firstInView();expect(before).toBeTruthy();
    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(userRow(page,"Request 16")).toBeAttached({timeout:10_000});await frames(page,8);
    await expect(cardOf(page,"codex-turn-16").locator(".activity-card-summary")).toHaveText("5 steps");
    await expect(pastCards(page)).toHaveCount(29);await expect(cardOf(page,"codex-turn-15")).toHaveAttribute("data-state","closed");
    await expect(cardOf(page,"codex-turn-2").locator(".activity-card-summary")).toHaveText("3 steps · some steps not loaded");
    const after=await scroll.evaluate((node,id)=>node.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect().top??null,before.id);
    expect(Math.abs(after-before.top)).toBeLessThanOrEqual(1);
  }finally{await harness.close()}
});

test("a long turn find read from its start keeps its steps in order as earlier messages bring the steps between",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startRelayHarness(),needle="zebra-needle-77";
  harness.seedThread("Relay find order",[
    {user:"Set the project up",items:[replyItem("order-answer-1","Set up.")]},
    {user:`Please remember ${needle} while running every check`,items:[...Array.from({length:300},(_,index)=>commandItem("order-check-"+(index+1),"check "+(index+1))),replyItem("order-answer-2","All 300 checks passed.")]},
    {user:"Latest request",items:[commandItem("order-latest-1","latest check"),replyItem("order-answer-3","Latest done.")]},
  ]);
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay find order");
    await expect(reply(page,"Latest done.")).toBeVisible({timeout:10_000});
    // The open page holds the long turn's last 96 steps; find reads its first 99, oldest first, up to the needle.
    const [,long]=harness.turns(harness.threads[0]),card=cardOf(page,long.id),summary=card.locator(".activity-card-summary");
    await expect(summary).toHaveText("96 steps · some steps not loaded");
    await page.keyboard.press("Control+f");await page.getByTestId("thread-find-input").fill(needle);
    await expect(page.getByTestId("thread-find-bar").locator(".thread-find-count")).toHaveText("1 / 1",{timeout:10_000});
    await expect(summary).toHaveText("195 steps · some steps not loaded");
    await page.keyboard.press("Escape");
    // The earlier messages bring the steps between, which read after the first ones and before the last ones.
    await page.locator(".conversation-scroll").evaluate(node=>{node.scrollTop=0});await frames(page,4);
    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(userRow(page,"Set the project up")).toBeAttached({timeout:10_000});
    await expect(summary).toHaveText("300 steps");
    await expect(card).toHaveAttribute("data-state","closed");await card.locator(".activity-card-head").click();
    await expect(card.locator(".timeline-window-controls span")).toHaveText("181–300 of 300");
    expect(await card.locator(".tool-event summary strong").allTextContents()).toEqual(Array.from({length:120},(_,index)=>"check "+(index+181)));
    // Not at 900 wide: a window narrowed below the column once rows were drawn wider scrolls sideways, cards or not (the rows keep
    // the width they last had while off screen), a fault apart from the cards.
    await auditCards(page,"find-order",card.locator(".activity-card-head"),{sizes:FIT_SIZES.filter(([width])=>width>900)});
  }finally{await harness.close()}
});

test("a found turn joined through the history gap keeps its steps in order and reads whole once all are held",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startRelayHarness(),needle="okapi-needle-31";
  harness.seedThread("Relay gap order",[
    {user:`Please remember ${needle} and run the checks`,items:[...Array.from({length:150},(_,index)=>commandItem("gap-check-"+(index+1),"check "+(index+1))),replyItem("gap-answer-0","All 150 checks passed.")]},
    {user:"Middle one",items:[replyItem("gap-answer-1","Middle one done.")]},
    {user:"Middle two",items:[replyItem("gap-answer-2","Middle two done.")]},
    {user:"Middle three",items:[replyItem("gap-answer-3","Middle three done.")]},
    {user:"Newest request",items:[...Array.from({length:120},(_,index)=>commandItem("gap-new-"+(index+1),"newest "+(index+1))),replyItem("gap-answer-4","Newest done.")]},
  ]);
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay gap order");
    await expect(reply(page,"Newest done.")).toBeVisible({timeout:10_000});
    // The hit's turn leads the list apart from the newest pages, its card holding the first 99 steps find read.
    const [first]=harness.turns(harness.threads[0]),card=cardOf(page,first.id),summary=card.locator(".activity-card-summary");
    await page.keyboard.press("Control+f");await page.getByTestId("thread-find-input").fill(needle);
    await expect(page.getByTestId("thread-find-bar").locator(".thread-find-count")).toHaveText("1 / 1",{timeout:10_000});
    const gap=page.getByTestId("history-gap");await expect(gap).toBeVisible({timeout:10_000});
    await expect(summary).toHaveText("99 steps · some steps not loaded");
    await page.keyboard.press("Escape");
    // The page that joins the gap brings the turn's last steps after its first ones: every step is held and none is left to load.
    await gap.getByRole("button").click();await expect(gap).toHaveCount(0,{timeout:10_000});
    await expect(reply(page,"All 150 checks passed.")).toBeAttached();await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    await expect(summary).toHaveText("150 steps");
    await expect(card).toHaveAttribute("data-state","closed");await card.locator(".activity-card-head").click();
    await expect(card.locator(".timeline-window-controls span")).toHaveText("31–150 of 150");
    expect(await card.locator(".tool-event summary strong").allTextContents()).toEqual(Array.from({length:120},(_,index)=>"check "+(index+31)));
  }finally{await harness.close()}
});

test("a long virtualized thread keeps every turn's closed card, and one toggles in place",async({page})=>{
  test.setTimeout(60_000);
  const thread=codexThread("codex-long-cards","Codex long cards");
  const seed=Array.from({length:90},(_,index)=>codexTurn(index+1,{user:`Long request ${index+1}`,commands:[`build ${index+1}`],reply:`Long answer ${index+1}.`}));
  const harness=await startCodexHarness(thread,[],{seed});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex long cards");
    await expect(reply(page,"Long answer 90.")).toBeVisible({timeout:10_000});
    await expect(cardOf(page,"codex-turn-90")).toHaveAttribute("data-state","open");
    // 180 messages: the list is virtual, its oldest chunks not mounted until they come near the view.
    await expect(page.locator(".conversation-virtual-chunk.placeholder").first()).toBeAttached();await expect(cardOf(page,"codex-turn-1")).toHaveCount(0);
    const scroll=page.locator(".conversation-scroll");
    for(let step=0;step<6;step++){await scroll.evaluate(node=>{node.scrollTop=0});await frames(page,4)}
    await expect(reply(page,"Long answer 1.")).toBeVisible({timeout:10_000});
    for(const index of [1,2,3])await expect(cardOf(page,"codex-turn-"+index)).toHaveAttribute("data-state","closed");
    const card=cardOf(page,"codex-turn-3");await card.evaluate(node=>node.scrollIntoView({block:"center"}));await frames(page,4);
    const top=await headTop(card);
    await card.locator(".activity-card-head").click();await expect(card.locator(".tool-event")).toHaveCount(1);
    await frames(page,4);expect(Math.abs(await headTop(card)-top)).toBeLessThanOrEqual(1);
    await card.locator(".activity-card-head").click();await expect(card).toHaveAttribute("data-state","closed");
    await frames(page,4);expect(Math.abs(await headTop(card)-top)).toBeLessThanOrEqual(1);
    await expectDonePillsInView(page);
  }finally{await harness.close()}
});

test("Codex item pages with steps give every turn its card without the timeline",async({page})=>{
  test.setTimeout(60_000);
  const thread=codexThread("codex-paged-cards","Codex paged cards");
  const seed=[1,2,3].map(index=>codexTurn(index,{user:`Paged request ${index}`,commands:[`npm run task-${index}`],reply:`Paged answer ${index}.`}));
  const harness=await startCodexHarness(thread,[],{seed});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex paged cards");
    await expect(reply(page,"Paged answer 3.")).toBeVisible({timeout:10_000});
    await expect(pastCards(page)).toHaveCount(3);
    await expect(cardOf(page,"codex-turn-3")).toHaveAttribute("data-state","open");
    for(const index of [1,2])await expect(cardOf(page,"codex-turn-"+index)).toHaveAttribute("data-state","closed");
    await frames(page,8);expect(harness.calls.filter(call=>call.method==="thread/timeline/list")).toHaveLength(0);
    await expectDonePillsInView(page);
  }finally{await harness.close()}
});

test("Codex item pages without steps give the newest turn its card from the timeline",async({page})=>{
  test.setTimeout(60_000);
  const thread=codexThread("codex-timeline-card","Codex timeline card");
  const seed=[1,2,3].map(index=>codexTurn(index,{user:`Timeline request ${index}`,commands:[`npm run task-${index}`],reply:`Timeline answer ${index}.`}));
  const harness=await startCodexHarness(thread,[],{seed,messageOnlyPages:true,timeline:true});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex timeline card");
    await expect(reply(page,"Timeline answer 3.")).toBeVisible({timeout:10_000});
    await expect(cardOf(page,"codex-turn-3")).toHaveAttribute("data-state","open",{timeout:10_000});
    await expect(cardOf(page,"codex-turn-3").locator(".tool-event")).toHaveText([/npm run task-3/]);
    await expect(pastCards(page)).toHaveCount(1);
    expect(harness.calls.filter(call=>call.method==="thread/timeline/list")).toHaveLength(1);
  }finally{await harness.close()}
});

test("a goal going on in a turn of its own closes the previous card once and keeps the live block to the new turn",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-goal-cards","Codex goal cards");
  const harness=await startCodexHarness(thread,[
    (turn,tools)=>{
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      codexCommand(turn,tools,"cmd-"+turn.id,"npm test");codexReply(turn,tools,"The tests pass.");tools.finish("completed");
      setTimeout(()=>tools.startOwnTurn((own,ownTools)=>{codexCommand(own,ownTools,"cmd-"+own.id,"npm run build");codexReply(own,ownTools,"The build is done.");ownTools.finish("completed")}),200);
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex goal cards");
    await page.getByTestId("composer").fill("Test, then build");await page.getByTestId("send").click();
    await expect(reply(page,"The build is done.")).toBeVisible({timeout:10_000});
    await expect(cardOf(page,"codex-turn-1")).toHaveAttribute("data-state","closed");
    await expect(page.locator('[data-testid=activity-card][data-turn-id="codex-turn-1"]')).toHaveCount(1);
    const liveSteps=page.locator(".agent-block .tool-event");
    await expect(liveSteps).toHaveCount(1);await expect(liveSteps).toContainText("npm run build");
    await page.reload();await openThreadRow(page,"Codex goal cards");
    await expect(reply(page,"The build is done.")).toBeVisible({timeout:10_000});
    await expect(reply(page,"The tests pass.").getByTestId("turn-outcome")).toHaveText("done · 2.1s");
    await expect(reply(page,"The build is done.").getByTestId("turn-outcome")).toHaveText("done · 2.1s");
    await expect(cardOf(page,"codex-turn-2")).toHaveAttribute("data-state","open");await expect(cardOf(page,"codex-turn-1")).toHaveAttribute("data-state","closed");
  }finally{await harness.close()}
});

test("a turn Codex starts on its own leaves the previous turn's failure and diff with that turn",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-own-turn-rows","Codex own turn rows");
  const diff=(turn,{emit,threadId},file)=>emit({method:"turn/diff/updated",params:{threadId,turnId:turn.id,diff:`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`}});
  const harness=await startCodexHarness(thread,[
    // The first turn runs its tests and changes a file, then fails; Codex goes on at once with a turn of its own, as a goal does,
    // while the first turn's diff still waits to show.
    (turn,tools)=>{
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      codexCommand(turn,tools,"cmd-"+turn.id,"npm test");
      setTimeout(()=>{
        diff(turn,tools,"src/one.js");tools.finish("failed",{error:{message:"The model stream broke off."}});
        tools.startOwnTurn((own,ownTools)=>{codexCommand(own,ownTools,"cmd-"+own.id,"npm run build");diff(own,ownTools,"src/two.js");setTimeout(()=>{codexReply(own,ownTools,"The build is done.");ownTools.finish("completed")},400)});
      },400);
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex own turn rows");
    await page.getByTestId("composer").fill("Test, then build");await page.getByTestId("send").click();
    await expect(reply(page,"The build is done.")).toBeVisible({timeout:10_000});
    // The live card is the new turn's alone: its build step and its own diff, and no failure.
    const live=liveCard(page),steps=live.locator(".tool-event");
    await expect(live.locator(".activity-card-summary")).toHaveText("2 steps");await expect(live.locator(".activity-card-failed")).toHaveCount(0);
    await expect(steps).toHaveCount(2);await expect(steps.filter({hasText:"npm run build"})).toHaveCount(1);await expect(steps.filter({hasText:"Workspace diff updated"})).toHaveCount(1);
    // The failed turn says so once, under its own closed card.
    const first=cardOf(page,"codex-turn-1"),ended=page.locator('[data-testid=turn-outcome-row][data-turn-id="codex-turn-1"]');
    await expect(first).toHaveAttribute("data-state","closed");await expect(first.locator(".activity-card-summary")).toHaveText("1 step");
    await expect(ended).toHaveCount(1);await expect(ended.getByTestId("turn-outcome")).toHaveText(/^failed/);
    await expect(ended.locator(".turn-outcome-message")).toHaveText("The model stream broke off.");
    expect(await inDocumentOrder(page,userRow(page,"Test, then build"),first,ended)).toBe(true);
    await auditCards(page,"own-turn-rows",live.locator(".activity-card-head"));
  }finally{await harness.close()}
});

test("a new task's first turn keeps its own card once the person sends a follow-up",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("task-write-1","notes.txt","first\n")]},
    {text:"First turn answer."},
    {toolCalls:[runCall("task-run-2","console.log('second-check')")]},
    {text:"Second turn answer."},
  ]});
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");
    // No thread is open: the first send creates the task's thread.
    const composer=page.getByTestId("composer");await expect(composer).toBeVisible({timeout:10_000});
    await composer.fill("First request: write the notes");await page.getByTestId("send").click();
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});
    await expect(liveCard(page).locator(".tool-event").filter({hasText:"notes.txt"})).toHaveCount(1);
    const first=await liveCard(page).getAttribute("data-turn-id");expect(first).toBeTruthy();
    await composer.fill("Second request: check");await page.getByTestId("send").click();
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:20_000});
    // Turn 1's step is its own closed card between its message and its reply, as in a thread opened from the sidebar, and the
    // live block lists turn 2 alone.
    const past=cardOf(page,first);
    await expect(past).toHaveAttribute("data-state","closed");await expect(past.locator(".activity-card-summary")).toHaveText("1 step");
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${first}"]`)).toHaveCount(1);
    expect(await inDocumentOrder(page,userRow(page,"First request"),past,reply(page,"First turn answer."))).toBe(true);
    await expect(page.locator(".agent-block .tool-event").filter({hasText:"notes.txt"})).toHaveCount(0);
    await auditCards(page,"new-task-card",past);
  }finally{await harness.close()}
});

test("a relay turn still running when a reload opens its thread again keeps its steps on the live card, once each, through its end",async({page})=>{
  test.setTimeout(150_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("reload-write-1","notes.txt","first\n")]},
    {toolCalls:[slowRunCall("reload-slow-1",6000)]},
    {toolCalls:[runCall("reload-run-1","console.log('after-reload')")]},
    {text:"First turn answer."},
    {text:"Second turn answer."},
  ]});
  const thread=harness.seedThread("Relay reload running");
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay reload running");
    const composer=page.getByTestId("composer");
    await composer.fill("First request");await page.getByTestId("send").click();
    await expect(liveCard(page).locator(".tool-event.status-running").filter({hasText:"slow-done"})).toHaveCount(1,{timeout:20_000});
    // The slow step still runs: the page reloads and the thread opens again.
    await page.reload();await openThreadRow(page,"Relay reload running");
    await expect(page.getByRole("button",{name:"Stop"})).toBeVisible({timeout:10_000});
    const [first]=harness.turns(thread),live=liveCard(page);
    // The steps stored so far start the live card, named for the running turn, the slow one still running; no other card has them.
    await expect(live).toHaveAttribute("data-turn-id",first.id);
    await expect(live.locator(".tool-event").filter({hasText:"notes.txt"})).toHaveCount(1);
    await expect(live.locator(".tool-event.status-running").filter({hasText:"slow-done"})).toHaveCount(1);
    await expect(pastCards(page)).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"dark-1600x980-reopened-running-relay.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await frames(page,3);
    await page.screenshot({animations:"disabled",path:auditDir+"light-1600x980-reopened-running-relay.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // When the turn ends, each step shows once, all on the one card of the turn.
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});await frames(page,4);
    for(const text of ["notes.txt","slow-done","after-reload"])await expect(page.locator("[data-testid=activity-card] .tool-event").filter({hasText:text}),text).toHaveCount(1);
    await expect(page.locator("[data-testid=activity-card]")).toHaveCount(1);await expect(live.locator(".activity-card-summary")).toHaveText("3 steps");
    await auditCards(page,"reopened-turn-ended",live);
    // The next send leaves turn 1 its own card, holding the three steps once each.
    await composer.fill("Second request");await page.getByTestId("send").click();
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:20_000});
    await expect(cardOf(page,first.id).locator(".activity-card-summary")).toHaveText("3 steps");
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${first.id}"]`)).toHaveCount(1);
  }finally{await harness.close()}
});

test("a relay turn still running when its thread is opened again from another keeps its steps on one card",async({page})=>{
  test.setTimeout(150_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("switch-write-1","notes.txt","first\n")]},
    {toolCalls:[slowRunCall("switch-slow-1",6000)]},
    {toolCalls:[runCall("switch-run-1","console.log('after-return')")]},
    {text:"First turn answer."},
  ]});
  const thread=harness.seedThread("Relay switch running");
  harness.seedThread("Relay other thread",[{user:"Lint the project",items:[commandItem("other-lint-1","npm run lint"),replyItem("other-answer-1","Lint is clean.")]}]);
  try{
    await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay switch running");
    await page.getByTestId("composer").fill("First request");await page.getByTestId("send").click();
    await expect(liveCard(page).locator(".tool-event.status-running").filter({hasText:"slow-done"})).toHaveCount(1,{timeout:20_000});
    // While the slow step runs, the person reads another thread and comes back.
    await openThreadRow(page,"Relay other thread");await expect(reply(page,"Lint is clean.")).toBeVisible({timeout:10_000});
    await openThreadRow(page,"Relay switch running");
    const [first]=harness.turns(thread),live=liveCard(page);
    await expect(live).toHaveAttribute("data-turn-id",first.id,{timeout:10_000});
    await expect(live.locator(".tool-event.status-running").filter({hasText:"slow-done"})).toHaveCount(1);await expect(pastCards(page)).toHaveCount(0);
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});await frames(page,4);
    for(const text of ["notes.txt","slow-done","after-return"])await expect(page.locator("[data-testid=activity-card] .tool-event").filter({hasText:text}),text).toHaveCount(1);
    await expect(page.locator("[data-testid=activity-card]")).toHaveCount(1);
  }finally{await harness.close()}
});

test("a Codex thread opened while its turn runs shows the running step running on the live card, and nowhere as done",async({page})=>{
  test.setTimeout(60_000);
  const thread={...codexThread("codex-open-running","Codex open running"),status:{type:"active",activeFlags:[]}};
  const running={...codexTurn(2,{user:"Run the long build"}),status:"inProgress",completedAt:null,durationMs:null};
  running.items.push({id:"cmd-2-1",type:"commandExecution",command:"npm run build",cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null});
  const harness=await startCodexHarness(thread,[],{seed:[codexTurn(1,{user:"Set the project up",commands:["npm install"],reply:"Set up."}),running]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex open running");
    await expect(userRow(page,"Run the long build")).toBeVisible({timeout:10_000});
    await expect(page.getByRole("button",{name:"Stop"})).toBeVisible();
    const live=liveCard(page),build=live.locator(".tool-event").filter({hasText:"npm run build"});
    await expect(live).toHaveAttribute("data-turn-id","codex-turn-2",{timeout:10_000});
    await expect(build).toHaveCount(1);await expect(build.locator("summary em")).toHaveText("running");
    await expect(page.locator("[data-testid=activity-card] .tool-event").filter({hasText:"npm run build"})).toHaveCount(1);
    await expect(cardOf(page,"codex-turn-2")).toHaveCount(0);await expect(cardOf(page,"codex-turn-1")).toHaveAttribute("data-state","closed");
    await auditCards(page,"reopened-running",live);
  }finally{await harness.close()}
});

test("a Codex thread left while its turn runs shows, back on it, the MCP progress and the turn's diff that came meanwhile",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-away-progress","Build and test"),other=codexThread("codex-away-other","Docs review"),turnDiff=line=>`diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old line\n+${line}\n`;
  let live=null;
  const harness=await startCodexHarness(thread,[
    // The turn browses with an MCP tool that reports its progress, and changes a file; it runs on until the test ends it.
    (turn,tools)=>{
      const emit=(method,params)=>tools.emit({method,params:{threadId:tools.threadId,turnId:turn.id,...params}}),browse={id:"mcp-"+turn.id,type:"mcpToolCall",server:"browser",tool:"navigate",status:"inProgress"};
      live={turn,tools,emit,browse};thread.status={type:"active",activeFlags:[]};turn.items.push(browse);
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      emit("item/started",{item:{...browse}});emit("item/mcpToolCall/progress",{itemId:browse.id,message:"Browser progress 1/4"});emit("turn/diff/updated",{diff:turnDiff("first change")});
    },
  ],{others:[other]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Build and test");
    await page.getByTestId("composer").fill("Build and test the app");await page.getByTestId("send").click();
    const card=liveCard(page),browsing=card.locator(".tool-event.kind-mcpToolCall"),diff=card.locator(".tool-event.kind-fileChange");
    await expect(browsing.locator("summary strong")).toHaveText("Browser progress 1/4",{timeout:10_000});await expect(diff).toHaveCount(1);
    // The person reads another thread. Meanwhile the browsing goes on, the diff grows, and Codex names the thread, whose row takes
    // the name once all of it has come.
    await openThreadRow(page,"Docs review");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    for(const step of [2,3,4])live.emit("item/mcpToolCall/progress",{itemId:live.browse.id,message:`Browser progress ${step}/4`});
    live.emit("turn/diff/updated",{diff:turnDiff("second change while away")});
    thread.name="Build and test the app";live.tools.emit({method:"thread/name/updated",params:{threadId:thread.id,name:thread.name}});
    // Back on it, the live card shows the newest progress and the newest diff, each on one row.
    await openThreadRow(page,"Build and test the app");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible();
    await expect.poll(async()=>({progress:await browsing.locator("summary strong").allTextContents(),diffs:await diff.count()})).toEqual({progress:["Browser progress 4/4"],diffs:1});
    await diff.locator("summary").click();await expect(diff).toContainText("second change while away");
    await auditCards(page,"returned-running-progress",card.locator(".activity-card-head"));
    // The turn goes on as before: the next progress shows on the same row, and its end settles it.
    live.emit("item/mcpToolCall/progress",{itemId:live.browse.id,message:"Browser progress 5/5"});await expect(browsing.locator("summary strong")).toHaveText("Browser progress 5/5");
    live.emit("item/completed",{item:{...live.browse,status:"completed"}});thread.status={type:"idle"};live.tools.finish("completed");
    await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);await expect(browsing).toHaveCount(1);await expect(browsing.locator("summary em")).toHaveText("done");
  }finally{await harness.close()}
});

// A turn that ends while its thread is not shown keeps the diff row it had, with its last diff, as one watched to its end does:
// back on the thread its own card lists it beside its steps, also when the person leaves and comes back once more.
test("a Codex turn that ends while another thread is shown keeps its diff row with the last diff on its card, back on its thread",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-away-ended","Build and test"),other=codexThread("codex-away-ended-other","Docs review"),seen=socketFrames(page),turnDiff=line=>`diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old line\n+${line}\n`;
  let live=null;
  const harness=await startCodexHarness(thread,[
    // The turn builds, browses with an MCP tool and changes a file; it runs on until the test ends it.
    (turn,tools)=>{
      const emit=(method,params)=>tools.emit({method,params:{threadId:tools.threadId,turnId:turn.id,...params}});
      const build={id:"cmd-"+turn.id,type:"commandExecution",command:"npm run build",cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null},browse={id:"mcp-"+turn.id,type:"mcpToolCall",server:"browser",tool:"navigate",status:"inProgress"};
      live={turn,tools,emit,build,browse};thread.status={type:"active",activeFlags:[]};turn.items.push(build,browse);
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      emit("item/started",{item:{...build}});emit("item/started",{item:{...browse}});emit("item/mcpToolCall/progress",{itemId:browse.id,message:"Browser progress 1/4"});emit("turn/diff/updated",{diff:turnDiff("first change")});
    },
  ],{others:[other]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Build and test");
    await page.getByTestId("composer").fill("Build and test the app");await page.getByTestId("send").click();
    await expect(liveCard(page).locator(".tool-event.kind-fileChange")).toHaveCount(1,{timeout:10_000});
    // The person reads another thread. Meanwhile the diff changes again, both steps end, the reply comes and the turn ends.
    await openThreadRow(page,"Docs review");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    live.emit("turn/diff/updated",{diff:turnDiff("second change while away")});
    Object.assign(live.build,{status:"completed",aggregatedOutput:"build ok\n",exitCode:0});live.emit("item/completed",{item:{...live.build}});
    live.browse.status="completed";live.emit("item/completed",{item:{...live.browse}});
    codexReply(live.turn,live.tools,"Built and tested.");thread.status={type:"idle"};live.tools.finish("completed");
    await expect.poll(()=>seen.some(frame=>frame.includes('"turn/completed"'))).toBe(true);
    for(const round of ["back","back again"]){
      // Back on it, the finished turn's card lists its two steps done and the diff row with the last diff.
      await openThreadRow(page,"Build and test");await expect(reply(page,"Built and tested.")).toBeVisible({timeout:10_000});
      await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
      const card=cardOf(page,live.turn.id),diff=card.locator(".tool-event.kind-fileChange");
      await expect(card.locator(".activity-card-summary"),round).toHaveText("3 steps");await expect(card.locator(".tool-event.status-done"),round).toHaveCount(3);
      await expect(diff,round).toHaveCount(1);await diff.locator("summary").click();
      await expect(diff).toContainText("second change while away");await expect(diff).not.toContainText("first change");
      if(round==="back"){await auditCards(page,"returned-turn-ended-diff",card);await openThreadRow(page,"Docs review")}
    }
  }finally{await harness.close()}
});

// What a turn that ends while another thread is shown keeps of its diff, until the thread runs its next turn, is the row its card
// shows, not the whole diff: a diff of many megabytes (a lockfile rewritten) leaves the window's memory once the turn ends, and back
// on the thread the turn's card still lists the diff row, which reads from the diff's start.
test("a Codex turn that ends while another thread is shown keeps only the diff row its card shows, not the whole diff",async({page})=>{
  test.setTimeout(120_000);
  const thread=codexThread("codex-away-big-diff","Rewrite the lockfile"),other=codexThread("codex-away-big-diff-other","Docs review");
  let live=null,completed=false;
  page.on("websocket",socket=>socket.on("framereceived",frame=>{const text=typeof frame.payload==="string"&&frame.payload.length<100_000?frame.payload:"";if(text.includes('"turn/completed"'))completed=true}));
  const head="diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n";
  const harness=await startCodexHarness(thread,[
    // The turn changes the lockfile a little first; it runs on until the test ends it.
    (turn,tools)=>{
      const emit=(method,params)=>tools.emit({method,params:{threadId:tools.threadId,turnId:turn.id,...params}});
      live={turn,tools,emit};thread.status={type:"active",activeFlags:[]};
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      emit("turn/diff/updated",{diff:head+"@@ -1 +1 @@\n-old\n+first change\n"});
    },
  ],{others:[other]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Rewrite the lockfile");
    await page.getByTestId("composer").fill("Rewrite the lockfile");await page.getByTestId("send").click();
    await expect(liveCard(page).locator(".tool-event.kind-fileChange")).toHaveCount(1,{timeout:10_000});
    await openThreadRow(page,"Docs review");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    const cdp=await page.context().newCDPSession(page);
    const heap=async()=>{await cdp.send("HeapProfiler.collectGarbage");await cdp.send("HeapProfiler.collectGarbage");return (await cdp.send("Runtime.getHeapUsage")).usedSize};
    const before=await heap();
    // While the person reads the other thread the whole lockfile is rewritten (a diff of about 24 MB), the reply comes and the turn ends.
    const lines=Array.from({length:600_000},(_,index)=>`+    "node_modules/pkg-${index}": "1.0.${index%10}",`);
    live.emit("turn/diff/updated",{diff:head+"@@ -1,600000 +1,600000 @@\n"+lines.join("\n")+"\n"});
    codexReply(live.turn,live.tools,"Rewrote the lockfile.");thread.status={type:"idle"};live.tools.finish("completed");
    await expect.poll(()=>completed,{timeout:20_000}).toBe(true);await page.waitForTimeout(500);
    const grown=await heap()-before;
    expect(grown,`the window holds ${Math.round(grown/1024/1024)} MB more once the turn has ended`).toBeLessThan(8*1024*1024);
    // Back on the thread, the turn's card lists the diff row, which reads from the diff's start.
    await openThreadRow(page,"Rewrite the lockfile");await expect(reply(page,"Rewrote the lockfile.")).toBeVisible({timeout:10_000});
    const card=cardOf(page,live.turn.id),diff=card.locator(".tool-event.kind-fileChange");
    await expect(diff).toHaveCount(1);await diff.locator("summary").click();
    await expect(diff).toContainText('"node_modules/pkg-0"');await expect(diff).not.toContainText("first change");
    await auditCards(page,"returned-turn-ended-big-diff",card,{sizes:[[1280,800]]});
  }finally{await harness.close()}
});

// A Codex reply streams on while the person reads another thread; Codex's history lists the reply in progress as it stands, or
// only finished items. Back on the thread the reply reads from its start, with what came meanwhile and after, once and in order,
// and once the turn ends it reads whole, once. Listed, it also opens that way after a reload while it streams.
for(const listed of [false,true])test(`a Codex reply left streaming reads from its start back on its thread, once and in order, and whole once its turn ends (${listed?"listed":"not listed"} in its history)`,async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-away-reply","Write the notes"),other=codexThread("codex-away-reply-other","Other notes"),seen=socketFrames(page);
  let live=null;
  const harness=await startCodexHarness(thread,[
    // The reply streams on until the test ends the turn.
    (turn,tools)=>{
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:""};thread.status={type:"active",activeFlags:[]};if(listed)turn.items.push(answer);
      const say=delta=>{answer.text+=delta;tools.emit({method:"item/agentMessage/delta",params:{threadId:tools.threadId,turnId:turn.id,itemId:answer.id,delta}})};
      live={turn,tools,answer,say};
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      tools.emit({method:"item/started",params:{threadId:tools.threadId,turnId:turn.id,item:{...answer}}});say("First part of the notes. ");
    },
  ],{others:[other]});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Write the notes");
    await page.getByTestId("composer").fill("Write the release notes.");await page.getByTestId("send").click();
    await expect(replyText(page,"First part")).toHaveText("First part of the notes.",{timeout:10_000});
    // The person reads another thread while the reply goes on.
    await openThreadRow(page,"Other notes");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    live.say("Second part, sent while away. ");await expect.poll(()=>seen.some(frame=>frame.includes("Second part, sent while away."))).toBe(true);
    // Back on it, the reply reads from its start, with what came meanwhile, and goes on in the same place.
    await openThreadRow(page,"Write the notes");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible();
    let full="First part of the notes. Second part, sent while away.";
    await expect(replyText(page,"Second part")).toHaveText(full);
    live.say("Third part, after the return. ");full+=" Third part, after the return.";
    await expect(replyText(page,"Third part")).toHaveText(full);await expect(replyText(page,"First part")).toHaveCount(1);
    await auditCards(page,"returned-reply-"+(listed?"listed":"not-listed"),replyText(page,"Third part"),{sizes:[[1280,800]]});
    // A reload while it streams: the thread opens with the reply as its history lists it, and what comes next goes on from there,
    // whether it comes while the thread shows or while the person reads the other thread.
    if(listed)for(const away of [false,true]){
      await page.reload();await openThreadRow(page,"Write the notes");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible({timeout:10_000});
      await expect(replyText(page,"Third part")).toHaveText(full);
      if(away){await openThreadRow(page,"Other notes");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0)}
      const part=away?"Fifth part, sent while away again.":"Fourth part, after the reload.";live.say(part+" ");full+=" "+part;
      if(away){await expect.poll(()=>seen.some(frame=>frame.includes(part))).toBe(true);await openThreadRow(page,"Write the notes");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible()}
      await expect(replyText(page,part)).toHaveText(full);await expect(replyText(page,"First part")).toHaveCount(1);
    }
    // The turn ends: the reply reads whole, once.
    live.answer.text=full+" The end.";if(!listed)live.turn.items.push(live.answer);
    live.tools.emit({method:"item/completed",params:{threadId:live.tools.threadId,turnId:live.turn.id,item:{...live.answer}}});thread.status={type:"idle"};live.tools.finish("completed");
    await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    await expect(replyText(page,"The end.")).toHaveText(full+" The end.");
    expect(timesIn(await page.locator(".conversation-column").innerText(),"First part of the notes.")).toBe(1);
  }finally{await harness.close()}
});

// A reply the window follows only from partway, as after the connection dropped while another thread was shown (the thread is
// followed again on the new connection, the reply's start gone with the old one), gives way back on its thread to the copy Codex's
// history lists of it, which holds its start: the reply reads from its start, with what came after, once and in order, and whole,
// once, when its turn ends.
test("a Codex reply kept from partway after the connection dropped reads from its start back on its thread when its history lists it",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-dropped-reply","Write the notes"),other=codexThread("codex-dropped-reply-other","Other notes"),seen=socketFrames(page);
  let live=null;
  const harness=await startCodexHarness(thread,[
    // The reply streams on until the test ends the turn; Codex's history lists it as it stands.
    (turn,tools)=>{
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:""};thread.status={type:"active",activeFlags:[]};turn.items.push(answer);
      const say=delta=>{answer.text+=delta;tools.emit({method:"item/agentMessage/delta",params:{threadId:tools.threadId,turnId:turn.id,itemId:answer.id,delta}})};
      live={turn,tools,answer,say};
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      tools.emit({method:"item/started",params:{threadId:tools.threadId,turnId:turn.id,item:{...answer}}});say("First part of the notes. ");
    },
  ],{others:[other]});
  const resumes=()=>harness.calls.filter(call=>call.method==="thread/resume"&&call.params.threadId===thread.id).length;
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Write the notes");
    await page.getByTestId("composer").fill("Write the release notes.");await page.getByTestId("send").click();
    await expect(replyText(page,"First part")).toHaveText("First part of the notes.",{timeout:10_000});
    // The person reads another thread while the reply goes on.
    await openThreadRow(page,"Other notes");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    live.say("Second part, sent while away. ");await expect.poll(()=>seen.some(frame=>frame.includes("Second part, sent while away."))).toBe(true);
    // The connection drops; on the new one the window follows the thread again, and the reply goes on.
    const before=resumes();harness.drop();
    await expect.poll(resumes,{timeout:20_000}).toBe(before+1);
    live.say("Third part, after the reconnect. ");await expect.poll(()=>seen.some(frame=>frame.includes("Third part, after the reconnect."))).toBe(true);
    // Back on it, the reply reads from its start, and goes on in the same place.
    await openThreadRow(page,"Write the notes");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible({timeout:10_000});
    let full="First part of the notes. Second part, sent while away. Third part, after the reconnect.";
    await expect(replyText(page,"Third part"),"the reply back on its thread").toHaveText(full);
    live.say("Fourth part, after the return. ");full+=" Fourth part, after the return.";
    await expect(replyText(page,"Fourth part")).toHaveText(full);await expect(replyText(page,"First part")).toHaveCount(1);
    await auditCards(page,"returned-reply-after-reconnect",replyText(page,"Fourth part"),{sizes:[[1280,800]]});
    // The turn ends: the reply reads whole, once.
    live.answer.text=full+" The end.";
    live.tools.emit({method:"item/completed",params:{threadId:live.tools.threadId,turnId:live.turn.id,item:{...live.answer}}});thread.status={type:"idle"};live.tools.finish("completed");
    await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    await expect(replyText(page,"The end.")).toHaveText(full+" The end.");
    expect(timesIn(await page.locator(".conversation-column").innerText(),"First part of the notes.")).toBe(1);
  }finally{await harness.close()}
});

// Gemini threads on the real agent relay, run by a fake ACP agent: a prompt runs a command step and streams its reply in parts, the
// next part once the test writes its name beside the agent ("two", "three", "four"); "finish" ends the step and the turn.
async function startAcpReplyHarness(page,names){
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-reply-")),agent=join(root,"fake-acp-reply.mjs");
  await writeFile(agent,String.raw`
import { existsSync } from "node:fs";
import readline from "node:readline";
let sessions=0;
const written=name=>new Promise(resolve=>{const check=()=>existsSync(new URL("./"+name,import.meta.url))?resolve():setTimeout(check,50);check()});
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
async function handle(message){
  if(!message.method||message.id==null)return;
  if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(message.method==="session/new"||message.method==="session/resume"||message.method==="session/load")return send({jsonrpc:"2.0",id:message.id,result:{sessionId:message.params?.sessionId||"fixture-session-"+(++sessions),models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
  if(message.method!=="session/prompt")return send({jsonrpc:"2.0",id:message.id,result:{}});
  const sessionId=message.params?.sessionId,update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
  const say=text=>update({sessionUpdate:"agent_message_chunk",content:{type:"text",text}}),build=(status,rawOutput)=>update({sessionUpdate:"tool_call_update",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status,rawOutput});
  update({sessionUpdate:"tool_call",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"in_progress",rawOutput:"phase one\n"});say("Starting the fixture build. ");
  await written("two");build("in_progress","phase one\nphase two\n");say("Phase two is out. ");
  await written("three");build("in_progress","phase one\nphase two\nphase three\n");say("Phase three is out. ");
  await written("four");say("Still building. ");
  await written("finish");build("completed","phase one\nphase two\nphase three\ndone\n");say("Fixture finished.");
  send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
}
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on("line",line=>{try{handle(JSON.parse(line)).catch(error=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:error.message}}))}catch{}});
lines.on("close",()=>process.exit(0));
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")},threadStore=new AgentThreadStore(env);
  const meta=new Map(names.map(name=>[threadStore.create({runtime:"gemini",cwd:root,providerSessionId:"",model:"fixture-model",name}).id,{projectless:true,environmentId:null}]));
  const instance={id:"gemini-default",kind:"gemini",displayName:"Fixture ACP",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"gemini",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[agent],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port,answer=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>answer(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>answer(route,{settings,projects:[],threadMeta:Object.fromEntries(meta)}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>answer(route,{models:["fixture-model"],metadata:{provider:"gemini",models:[{id:"fixture-model",name:"Fixture Model",provider:"gemini",agent:"Gemini"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>answer(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>answer(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>answer(route,{enabled:false,items:[]}));
  return {
    write:name=>writeFile(join(root,name),""),
    async close(){await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

// An ACP harness's reply streams on while the person reads another thread: back on the thread, and after a reload while it still
// streams, the reply reads from its start under its running step, once and in order, and once the turn ends it reads whole, once.
test("an ACP reply left streaming reads from its start back on its thread and after a reload, once and in order, and whole once its turn ends",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startAcpReplyHarness(page,["ACP other thread","ACP reply fixture"]),seen=socketFrames(page);
  const parts=["Starting the fixture build.","Phase two is out.","Phase three is out.","Still building."],soFar=count=>parts.slice(0,count).join(" ");
  try{
    await page.goto("/");await openThreadRow(page,"ACP reply fixture");
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled({timeout:15_000});
    await composer.fill("Run the fixture command");await page.getByTestId("send").click();
    await expect(replyText(page,parts[0])).toHaveText(soFar(1),{timeout:15_000});
    await harness.write("two");await expect(replyText(page,parts[1])).toHaveText(soFar(2));
    // The person reads another thread while the reply goes on.
    await openThreadRow(page,"ACP other thread");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    await harness.write("three");await expect.poll(()=>seen.some(frame=>frame.includes(parts[2])),{timeout:10_000}).toBe(true);
    // Back on it, the reply reads from its start under the running step, and goes on in the same place.
    await openThreadRow(page,"ACP reply fixture");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible({timeout:10_000});
    await expect(replyText(page,parts[2])).toHaveText(soFar(3));
    await expect(liveCard(page).locator(".tool-event.status-running").filter({hasText:"Fixture build"})).toHaveCount(1);
    await auditCards(page,"returned-acp-reply",liveCard(page),{sizes:[[1280,800]]});
    await harness.write("four");await expect(replyText(page,parts[3])).toHaveText(soFar(4));
    // A reload while it streams: the thread opens with the reply so far, from its start.
    await page.reload();await openThreadRow(page,"ACP reply fixture");await expect(page.getByRole("button",{name:"Stop"})).toBeVisible({timeout:10_000});
    await expect(replyText(page,parts[3])).toHaveText(soFar(4));
    // The turn ends: the reply reads whole, once.
    await harness.write("finish");await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0,{timeout:10_000});
    await expect(replyText(page,"Fixture finished.")).toHaveText(soFar(4)+" Fixture finished.");
    expect(timesIn(await page.locator(".conversation-column").innerText(),parts[0])).toBe(1);
  }finally{await harness.close()}
});

// A connection that drops loses what Codex sent meanwhile: an MCP step that ended while the window was not connected reads as it
// ended once the window is back on the thread, under its own name, never with the progress it had before the drop.
test("an MCP step that ends while the connection is down reads done once the window reconnects, not with its old progress",async({page})=>{
  test.setTimeout(90_000);
  const thread=codexThread("codex-drop-progress","Browse while offline");let live=null;
  const harness=await startCodexHarness(thread,[
    // The turn browses with an MCP tool that reports its progress; it runs on until the test ends.
    (turn,tools)=>{
      const emit=(method,params)=>tools.emit({method,params:{threadId:tools.threadId,turnId:turn.id,...params}}),browse={id:"mcp-"+turn.id,type:"mcpToolCall",server:"browser",tool:"navigate",status:"inProgress"};
      live={turn,tools,emit,browse};thread.status={type:"active",activeFlags:[]};turn.items.push(browse);
      tools.emit({method:"turn/started",params:{threadId:tools.threadId,turn:{...turn,items:[]}}});
      emit("item/started",{item:{...browse}});emit("item/mcpToolCall/progress",{itemId:browse.id,message:"Browser progress 2/4"});
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Browse while offline");
    await page.getByTestId("composer").fill("Browse the docs");await page.getByTestId("send").click();
    const card=liveCard(page),browsing=card.locator(".tool-event.kind-mcpToolCall");
    await expect(browsing.locator("summary strong")).toHaveText("Browser progress 2/4",{timeout:10_000});await expect(browsing.locator("summary em")).toHaveText("running");
    // The connection drops, and meanwhile the step ends while the turn runs on: none of it reaches the window.
    live.browse.status="completed";harness.drop();
    // On the new connection the thread opens again: the step reads done, under its own name, and the turn still runs.
    await expect(browsing.locator("summary em")).toHaveText("done",{timeout:15_000});
    await expect(browsing.locator("summary strong")).toHaveText("browser / navigate");await expect(browsing).toHaveCount(1);
    await expect(page.getByRole("button",{name:"Stop"})).toBeVisible();
    await auditCards(page,"reconnected-step-ended",card.locator(".activity-card-head"));
  }finally{await harness.close()}
});

test("a Codex turn running when its thread opens that fails while the thread opens shows each step and the failure once, nothing running",async({page})=>{
  test.setTimeout(60_000);
  const thread={...codexThread("codex-open-failing","Codex open failing"),status:{type:"active",activeFlags:[]}};
  const running={...codexTurn(2,{user:"Run the suites"}),status:"inProgress",completedAt:null,durationMs:null},e2e={id:"cmd-2-2",type:"commandExecution",command:"npm run e2e",cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null};
  running.items.push({id:"cmd-2-1",type:"commandExecution",command:"npm run build",cwd:process.cwd(),status:"completed",aggregatedOutput:"ok\n",exitCode:0},e2e);
  // The resume answers with the turn running; as the first item page is asked for, its last step fails and the turn ends with an
  // error, so the page already holds the end the app is sent while the thread opens.
  const onItemsPage=({emit,threadId,finish})=>{
    Object.assign(e2e,{status:"failed",aggregatedOutput:"1 failing\n",exitCode:1});emit({method:"item/completed",params:{threadId,turnId:running.id,item:{...e2e}}});
    thread.status={type:"idle"};finish("failed",{error:{message:"The model stream broke."}});
  };
  const harness=await startCodexHarness(thread,[],{seed:[codexTurn(1,{user:"Set the project up",commands:["npm install"],reply:"Set up."}),running],onItemsPage});
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex open failing");
    await expect(page.locator(".conversation-column").getByText("The model stream broke.")).toHaveCount(1,{timeout:10_000});await frames(page,4);
    for(const text of ["npm run build","npm run e2e"])await expect(page.locator("[data-testid=activity-card] .tool-event").filter({hasText:text}),text).toHaveCount(1);
    await expect(page.locator("[data-testid=activity-card] .tool-event.status-running")).toHaveCount(0);await expect(page.getByRole("button",{name:"Stop"})).toHaveCount(0);
    // One card, the turn's own: its two steps, the one that failed counted.
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${running.id}"]`)).toHaveCount(1);
    await expect(cardOf(page,running.id).locator(".activity-card-failed")).toHaveText("1 failed");
    await auditCards(page,"opened-turn-failed",cardOf(page,running.id));
  }finally{await harness.close()}
});

test("a person who closed a finished turn's card sends again: the new live card is open in every frame and never takes that turn's id",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("closed-write-1","notes.txt","first\n")]},
    {text:"First turn answer."},
    {toolCalls:[runCall("closed-run-2","console.log('second-check')")]},
    {text:"Second turn answer."},
  ]});
  const thread=harness.seedThread("Relay closed card");
  try{
    await holdTurnStart(page);await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay closed card");
    const composer=page.getByTestId("composer");
    await composer.fill("First request");await page.getByTestId("send").click();
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});
    const [first]=harness.turns(thread);
    // The person closes the finished turn's card and sends again; the next turn takes a moment to start.
    await liveCard(page).locator(".activity-card-head").click();await expect(liveCard(page)).toHaveAttribute("data-state","closed");
    await page.evaluate(()=>{window.__holdTurnStartMs=2500});
    await watchLiveCard(page,"Second request");
    await composer.fill("Second request");await page.getByTestId("send").click();
    // Until its turn starts, the send's live card lists the send's notice under no turn's name, open.
    await expect(liveCard(page)).toHaveAttribute("data-state","open");await expect(liveCard(page)).not.toHaveAttribute("data-turn-id",/./);
    await auditCards(page,"send-waiting",liveCard(page),{sizes:[[1280,800]]});
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:20_000});await frames(page,3);
    const seen=await liveCardFrames(page);
    // The person never closed this card: it is open in every frame from the send on, and never named for turn 1, whose own card
    // is on the page by then.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(frame=>frame.state!=="open")).toEqual([]);
    expect(seen.filter(frame=>frame.turn===first.id)).toEqual([]);
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${first.id}"]`)).toHaveCount(1);
  }finally{await harness.close()}
});

test("a person who closes the live card while its turn is still starting keeps it closed once the turn starts",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startRelayHarness({replies:[
    {toolCalls:[writeFileCall("early-write-1","notes.txt","first\n")]},
    {text:"First turn answer."},
    {toolCalls:[runCall("early-run-2","console.log('second-check')")]},
    {text:"Second turn answer."},
  ]});
  const thread=harness.seedThread("Relay early close");
  try{
    await holdTurnStart(page);await routeRelayApp(page,harness);
    await page.goto("/");await openThreadRow(page,"Relay early close");
    const composer=page.getByTestId("composer");
    await composer.fill("First request");await page.getByTestId("send").click();
    await expect(reply(page,"First turn answer.")).toBeVisible({timeout:20_000});
    await page.evaluate(()=>{window.__holdTurnStartMs=1500});
    await composer.fill("Second request");await page.getByTestId("send").click();
    // The send's live card shows before its turn has started; the person closes it.
    await expect(liveCard(page)).toHaveAttribute("data-state","open");await expect(liveCard(page)).not.toHaveAttribute("data-turn-id",/./);
    await liveCard(page).locator(".activity-card-head").click();await expect(liveCard(page)).toHaveAttribute("data-state","closed");
    // The choice is the new turn's: the card stays closed once the turn starts and ends, and turn 1's card keeps its own.
    await expect(reply(page,"Second turn answer.")).toBeVisible({timeout:20_000});await frames(page,4);
    const [first,second]=harness.turns(thread);
    await expect(liveCard(page)).toHaveAttribute("data-turn-id",second.id);await expect(liveCard(page)).toHaveAttribute("data-state","closed");
    await expect(cardOf(page,first.id)).toHaveAttribute("data-state","closed");await expect(cardOf(page,first.id).locator(".activity-card-summary")).toHaveText("1 step");
    await auditCards(page,"live-card-closed",liveCard(page));
  }finally{await harness.close()}
});
