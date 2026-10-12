import { test,expect } from "@playwright/test";
import { startStreamingFixture } from "./native-stream-fixture.js";

// Count budgets for the renderer (the perf plan's section 2): what the page does at idle and while a reply streams, measured as
// counts that do not depend on how busy the machine is. Each budget holds the line its fix reached, or the baseline until then.

// B15: CSS animations still running with an infinite iteration count once a page has settled. Any one of them keeps the
// compositor drawing a frame every vsync all day (about 4% of a core across the renderer, GPU and browser processes).
const B15_INFINITE_ANIMATIONS={chat:1,welcome:2,settings:1,projects:1};
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
