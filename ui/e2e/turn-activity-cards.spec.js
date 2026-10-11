import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeCodexApp, startCodexHarness } from "./codex-history-harness.js";
import { commandItem, fileChangeItem, replyItem, routeRelayApp, runCall, startRelayHarness, writeFileCall } from "./relay-history-harness.js";

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
    // Each reply has its done pill: these turns finished within a second, so no time is shown.
    await expect(reply(page,"Both pass now").getByTestId("turn-outcome")).toHaveText("done");
    await expect(reply(page,"The parser test still fails").getByTestId("turn-outcome")).toHaveText("done");
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
