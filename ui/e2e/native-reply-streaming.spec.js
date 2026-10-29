import { test,expect } from "@playwright/test";
import { assertNoHorizontalScroll,auditDir,gate,live,startStreamingFixture,stop,watchLiveReply } from "./native-stream-fixture.js";

// Trebell Native showing a reply while its provider call streams. The real agent relay runs the real Native session; only the
// provider is faked: each scripted call gets the session's stream hook and is driven by the test, as native-queue.spec.js does.
const untilAborted=signal=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted"),{name:"AbortError"})),{once:true}));
const reply=(request,text,extra={})=>({id:"stream-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52},...extra});
const searchCall=id=>({id,namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'});

const ANSWER_HEAD="Trebell Native answers with the model its thread names. When you start a thread, the composer's model and provider are stored with it, and every turn sends its request to that pair.\n\n";
const ANSWER_TAIL="Changing the model in the composer changes the next request only. Replies already written stay as they were, and the thread keeps the new choice for the turns after it.";
const PREAMBLE="I'll start by searching the repository for the SessionManager class, since the question is where it is defined and how it is used.\n\nThen I will read the file that defines it and summarise what it does.";
const SENTINEL="SENTINEL-7f3a: this first attempt streams a reply that the provider then abandons with an HTTP 503 error.\n\nIt must not stay on screen once the attempt fails, because the retry writes its own answer from the start.";
const RETRIED="The retried attempt answered on its own. The provider failed once with a 503 and Trebell Native retried the call.\n\nOnly this second answer is shown, streamed again from its first character.";
const ALPHA_ONE="ALPHA-ONE: the alpha thread starts its answer while you are looking at it, and this first part is long enough to show as a draft.\n\nIt goes on for a second paragraph before the next part.";
const ALPHA_TWO="ALPHA-TWO: this part arrives while another thread is open, so the alpha thread never received it on screen.";
const ALPHA_THREE=" ALPHA-THREE: this part arrives while the alpha thread opens again, after its draft began, so it cannot be placed.";
const ALPHA_FINAL="ALPHA-FINAL: after its search the alpha thread writes its answer again from the first character.\n\nThis is the reply the thread keeps, and nothing of the first draft is left in front of it.";
const STEER_ONE="STEER-ONE: the first call starts answering the original question and streams this draft.\n\nSteering stops this call, so the draft goes before the steered call answers.";
const STEER_TWO="STEER-TWO: the steered call answers the redirected question from its first character.\n\nOnly this answer stays on screen, and it is the message the turn keeps once the call ends.";


for(const mode of ["dark","light"]){
  test(`a Native reply shows while its provider call streams and becomes the finished message once (${mode})`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode});const tail=gate(),finish=gate(),streamed=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:ANSWER_HEAD});streamed.open();await tail.promise;for(const word of ANSWER_TAIL.split(/(?<= )/))hook({type:"text",delta:word});await finish.promise;return reply(request,ANSWER_HEAD+ANSWER_TAIL)});
    try{
      await fixture.open("Native streaming");await fixture.send("Explain how a Native thread picks the model it answers with. Do not change any files.");await streamed.promise;
      // The head of the reply is on screen while the call is still running.
      await expect(live(page)).toContainText("Trebell Native answers with the model its thread names.");await expect(stop(page)).toBeVisible();
      await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-mid-${mode}-1280x800.png`});
      tail.open();await expect(live(page)).toContainText("the thread keeps the new choice for the turns after it.");await expect(stop(page)).toBeVisible();
      await page.setViewportSize({width:390,height:844});await expect(live(page)).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-mid-${mode}-390x844.png`});
      await page.setViewportSize({width:1280,height:800});
      finish.open();
      const message=page.locator(".history-assistant").filter({hasText:"Trebell Native answers with the model its thread names."});
      await expect(message).toHaveCount(1,{timeout:10_000});await expect(message).toContainText("the thread keeps the new choice for the turns after it.");
      await expect(live(page)).toHaveCount(0);await expect(stop(page)).toHaveCount(0);
      await expect(page.getByText("Changing the model in the composer changes the next request only.",{exact:false})).toHaveCount(1);
      expect(fixture.requests).toEqual([{hooked:true,gate:false}]);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-final-${mode}-1280x800.png`});
    }finally{tail.open();finish.open();await fixture.close()}
  });
}

test("a Native draft that goes another way leaves the screen: a tool call, a failed attempt and a short preamble",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page);
  try{
    await fixture.open("Native streaming");
    // A preamble long enough to show, then a tool call: the preamble goes, the tool row shows and the reply is the final one.
    const preambleShown=gate(),toTool=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:PREAMBLE});preambleShown.open();await toTool.promise;hook({type:"tool_call"});return reply(request,"",{toolCalls:[searchCall("stream-search-1")],finishReason:"tool_calls"})},
      async request=>reply(request,"SessionManager is defined in session.js, where refresh() returns true."));
    await fixture.send("Where is SessionManager defined? Do not change any files.");await preambleShown.promise;
    await expect(live(page)).toContainText("searching the repository for the SessionManager class");
    toTool.open();
    await expect(page.locator(".history-assistant").filter({hasText:"SessionManager is defined in session.js"})).toHaveCount(1,{timeout:10_000});
    await expect(page.locator(".tool-event").filter({hasText:"Searched SessionManager"}).first()).toBeVisible();
    await expect(page.getByText("searching the repository for the SessionManager class",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);

    // A failed attempt: its sentinel draft is cleared and the reply is the retry's.
    const sentinelShown=gate(),fail=gate();
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:SENTINEL});sentinelShown.open();await fail.promise;throw Object.assign(new Error("HTTP 503: upstream unavailable"),{status:503,retryable:true})},
      async(request,hook)=>{hook({type:"text",delta:RETRIED});return reply(request,RETRIED)});
    await fixture.send("Explain why the retry happened.");await sentinelShown.promise;
    await expect(live(page)).toContainText("SENTINEL-7f3a");
    const seenRetry=await watchLiveReply(page);fail.open();
    await expect(page.locator(".history-assistant").filter({hasText:"The retried attempt answered on its own."})).toHaveCount(1,{timeout:10_000});
    await expect(page.getByText("SENTINEL-7f3a",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);
    const retrySeen=await seenRetry();expect(retrySeen.some(text=>text.includes("SENTINEL-7f3a")&&text.includes("retried attempt")),JSON.stringify(retrySeen)).toBe(false);

    // A short preamble before a tool call never shows.
    const seenShort=await watchLiveReply(page);
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:"Let me look at the session file first."});hook({type:"tool_call"});return reply(request,"",{toolCalls:[searchCall("stream-search-2")],finishReason:"tool_calls"})},
      async request=>reply(request,"session.js exports SessionManager."));
    await fixture.send("Explain session.js in one paragraph.");
    await expect(page.locator(".history-assistant").filter({hasText:"session.js exports SessionManager."})).toHaveCount(1,{timeout:10_000});
    const shortSeen=await seenShort();expect(shortSeen.filter(text=>text.includes("Let me look")),JSON.stringify(shortSeen)).toEqual([]);
    expect(shortSeen.every(text=>"session.js exports SessionManager.".startsWith(text.trim())),JSON.stringify(shortSeen)).toBe(true);
    expect(fixture.script).toHaveLength(0);
  }finally{await fixture.close()}
});

test("Stop clears a streaming Native draft and the turn shows as stopped without a reply",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page),streamed=gate();
  fixture.script.push(async(request,hook)=>{hook({type:"text",delta:ANSWER_HEAD});streamed.open();await untilAborted(request.signal)});
  try{
    await fixture.open("Native streaming");await fixture.send("Explain what happens when I press Stop.");await streamed.promise;
    await expect(live(page)).toContainText("Trebell Native answers with the model its thread names.");
    await stop(page).click();
    await expect(page.getByTestId("turn-outcome").last()).toContainText("stopped",{timeout:10_000});
    await expect(live(page)).toHaveCount(0);
    await expect(page.locator(".history-assistant:not(.turn-outcome-row)").filter({hasText:"Trebell Native answers with the model its thread names."})).toHaveCount(0);
    await expect(page.getByText("Trebell Native answers with the model its thread names.",{exact:false})).toHaveCount(0);
  }finally{await fixture.close()}
});

// Native runs without the semantic completion gate (src/native-configuration.mjs, the benchmarked configuration), so a coding prompt's
// answer streams like any other: the edit call's preamble (commentary, held) never shows, and the answer is the turn's last request.
test("a coding prompt's answer streams, with no completion gate after it",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page);
  // Long enough to show as a draft (160 characters with a paragraph break, native-agent-session.mjs).
  const FIXED="refresh() in session.js now returns false.\n\nThe method's only caller already treats a false refresh as an expired session and signs the user in again, so nothing else needed to change for the fix to take effect.";
  const streamed=gate(),finish=gate();
  fixture.script.push(
    async(request,hook)=>{hook({type:"text",delta:PREAMBLE,hold:true});hook({type:"tool_call"});return reply(request,"",{toolCalls:[{id:"stream-edit",namespace:"trebell_workspace",name:"replace_text",arguments:JSON.stringify({path:"session.js",old_text:"return true",new_text:"return false"})}],finishReason:"tool_calls"})},
    async(request,hook)=>{for(const part of FIXED.split(/(?<=\n\n)/))hook({type:"text",delta:part});streamed.open();await finish.promise;return reply(request,FIXED)},
  );
  try{
    await fixture.open("Native streaming");const seen=await watchLiveReply(page);
    await fixture.send("Fix the bug in session.js so refresh returns false.");
    // The answer shows while its call still runs, as any other reply does.
    await streamed.promise;await expect(live(page)).toContainText("refresh() in session.js now returns false.");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"refresh() in session.js now returns false."})).toHaveCount(1,{timeout:15_000});
    expect(fixture.requests,JSON.stringify(fixture.requests)).toEqual([{hooked:true,gate:false},{hooked:true,gate:false}]);
    const shown=await seen();expect(shown.length).toBeGreaterThan(0);expect(shown.every(text=>FIXED.replace(/\s+/g," ").startsWith(text.replace(/\s+/g," ").trim())),JSON.stringify(shown)).toBe(true);
    await expect(page.getByText("searching the repository for the SessionManager class",{exact:false})).toHaveCount(0);
  }finally{await fixture.close()}
});

test("a Native thread left and reopened mid-stream shows no stale draft, replays a draft that began while it opened, and keeps the final reply",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Alpha stream",preview:"Alpha"},{name:"Beta quiet",preview:"Beta"}]});
  const oneShown=gate(),toTwo=gate(),twoSent=gate(),toThree=gate(),threeSent=gate(),toTool=gate(),finalSent=gate(),finish=gate();
  fixture.script.push(
    async(request,hook)=>{
      hook({type:"text",delta:ALPHA_ONE});oneShown.open();await toTwo.promise;hook({type:"text",delta:ALPHA_TWO});twoSent.open();
      await toThree.promise;hook({type:"text",delta:ALPHA_THREE});threeSent.open();await toTool.promise;hook({type:"tool_call"});
      return reply(request,"",{toolCalls:[searchCall("alpha-search")],finishReason:"tool_calls"});
    },
    async(request,hook)=>{hook({type:"text",delta:ALPHA_FINAL});finalSent.open();await finish.promise;return reply(request,ALPHA_FINAL)},
  );
  try{
    await fixture.open("Alpha stream");await fixture.send("Explain how the alpha thread answers.");await oneShown.promise;
    await expect(live(page)).toContainText("ALPHA-ONE");
    // Away to the other thread: the alpha draft goes with it, and its next part arrives while beta is open.
    await fixture.open("Beta quiet");await expect(live(page)).toHaveCount(0);
    toTwo.open();await twoSent.promise;await page.waitForTimeout(150);await expect(page.getByText("ALPHA-TWO",{exact:false})).toHaveCount(0);
    // Back to alpha while the relay holds its history. During the hold the old draft goes on (it began before the hold, so
    // its frames cannot be placed), then the call turns to its search and the next call's draft begins; all of it replays.
    const release=fixture.holdOpening(fixture.threads[0].id);
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Alpha stream"]')});await row.locator(".thread-main").click();
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Opening thread…",{timeout:10_000});
    const seen=await watchLiveReply(page);
    toThree.open();await threeSent.promise;toTool.open();await finalSent.promise;await page.waitForTimeout(150);
    await expect(page.getByText("ALPHA-FINAL",{exact:false})).toHaveCount(0);
    release();
    await expect(live(page)).toContainText("ALPHA-FINAL",{timeout:10_000});await expect(live(page)).not.toContainText("ALPHA-ONE");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"ALPHA-FINAL"})).toHaveCount(1,{timeout:10_000});await expect(live(page)).toHaveCount(0);
    const shown=await seen();expect(shown.filter(text=>/ALPHA-(?:ONE|TWO|THREE)/.test(text)),JSON.stringify(shown)).toEqual([]);
    for(const marker of ["ALPHA-ONE","ALPHA-TWO","ALPHA-THREE"])await expect(page.getByText(marker,{exact:false})).toHaveCount(0);
  }finally{toTwo.open();toThree.open();toTool.open();finish.open();await fixture.close()}
});

test("steering a streaming Native turn withdraws its draft and the steered call streams from its first character",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page),oneShown=gate(),twoShown=gate(),finish=gate();
  fixture.script.push(
    async(request,hook)=>{hook({type:"text",delta:STEER_ONE});oneShown.open();await untilAborted(request.signal)},
    async(request,hook)=>{hook({type:"text",delta:STEER_TWO});twoShown.open();await finish.promise;return reply(request,STEER_TWO)},
  );
  try{
    await fixture.open("Native streaming");await fixture.send("Describe how a steered turn continues.");await oneShown.promise;
    await expect(live(page)).toContainText("STEER-ONE");
    const thread=fixture.threads[0],turnId=fixture.threadStore.get(thread.id).turns.at(-1).id;
    const steered=await fixture.rpc("turn/steer",{threadId:thread.id,expectedTurnId:turnId,input:[{type:"text",text:"Answer the redirected question instead."}]});expect(steered.accepted).toBe(true);
    await twoShown.promise;
    await expect(live(page)).toContainText("STEER-TWO");await expect(live(page)).not.toContainText("STEER-ONE");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"STEER-TWO"})).toHaveCount(1,{timeout:10_000});
    await expect(page.getByText("STEER-ONE",{exact:false})).toHaveCount(0);await expect(live(page)).toHaveCount(0);
  }finally{finish.open();await fixture.close()}
});

// A finished block of a streaming reply renders on its own (markdown-blocks.js), so it must render as one render of the whole text
// does: a list item whose last line is a lone <br>, and an ordered list from 2 after indented code. The live reply, held open after
// its last delta, is the finished message element for element; dark and light come from the header's own toggle.
const BLOCKS_REPLY="## Install\n\nInstall the command line tool first, then sign in with it, so the relay can start the harness for this project without asking again.\n\n- Install the CLI\n<br>\n\nThen sign in with the CLI.\n\nRun this first:\n\n    npm install\n\n2. Start the server.\n3. Open the page.\n\nDone.";
test("a streaming reply's finished blocks show as the finished reply does: a lone <br> after a list item, a list after indented code",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await startStreamingFixture(page),sent=gate(),finish=gate();
  // The toggle saves the setting; the fixture's mocked settings are what the page keeps.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...route.request().postDataJSON(),onboardingComplete:true})}):route.fallback());
  let mode="dark";
  const toggle=async()=>{mode=mode==="dark"?"light":"dark";await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await page.waitForTimeout(300)};
  const shoot=async name=>{for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.waitForTimeout(250);await page.screenshot({animations:"disabled",path:auditDir+`native-reply-${name}-${mode}-${width}x800.png`});await toggle();await page.screenshot({animations:"disabled",path:auditDir+`native-reply-${name}-${mode}-${width}x800.png`})}await page.setViewportSize({width:1280,height:800})};
  try{
    fixture.script.push(async(request,hook)=>{
      for(let index=0;index*7<BLOCKS_REPLY.length;index++){hook({type:"text",delta:BLOCKS_REPLY.slice(index*7,index*7+7)});await new Promise(resolve=>setTimeout(resolve,40))}
      sent.open();await finish.promise;return reply(request,BLOCKS_REPLY);
    });
    await fixture.open("Native streaming");await fixture.send("Say how to install the CLI. Do not change any files.");await sent.promise;
    await expect(live(page)).toContainText("Done.");
    const streamed=await live(page).innerHTML();
    await shoot("blocks-streaming");
    finish.open();
    const finished=page.locator(".history-assistant .assistant-message-text");await expect(finished).toHaveCount(1,{timeout:15_000});await expect(live(page)).toHaveCount(0);
    await shoot("blocks-finished");
    expect(streamed,"the last streamed frame is what the finished reply shows").toBe(await finished.innerHTML());
    await expect(finished.locator("li").first()).toContainText("Install the CLI <br>");await expect(finished.locator("ol")).toHaveCount(0);
  }finally{finish.open();await fixture.close()}
});
