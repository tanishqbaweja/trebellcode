import { test,expect } from "@playwright/test";
import { markdownReply } from "../../scripts/perf/lib/fake-openai.mjs";
import { gate,live,startStreamingFixture } from "./native-stream-fixture.js";

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
const B16_STREAM={commitsPerSecond:16,wholeTextParses:340,charsParsed:4_300_000};
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
