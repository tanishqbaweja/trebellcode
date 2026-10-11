import { test,expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_REPLY_STREAM } from "../../src/native-agent-session.mjs";
import { nativeStreamOptions } from "../../src/native-reply-streaming.mjs";
import { ProviderManager } from "../../src/provider-manager.mjs";
import { assertNoHorizontalScroll,auditDir,live,startStreamingFixture,stop,watchLiveReply } from "./native-stream-fixture.js";

// Native reply streaming against OpenAI, as the GUI server wires it (gui-server nativeProviderTurn). Off unless
// TREBELL_LIVE_NATIVE_STREAMING=1; TREBELL_LIVE_ENV_FILE names the .env file the OpenAI key is read from, and only that key
// is read. TREBELL_LIVE_STREAM_ROOT is where the run keeps its files. Each test makes a few small calls.
const LIVE=process.env.TREBELL_LIVE_NATIVE_STREAMING==="1";
const MODEL=String(process.env.TREBELL_LIVE_NATIVE_MODEL||"gpt-5.6-terra").trim();
function openAiKey(){
  const file=String(process.env.TREBELL_LIVE_ENV_FILE||"").trim();if(!file)return String(process.env.OPENAI_API_KEY||"").trim();
  const line=readFileSync(file,"utf8").split(/\r?\n/).find(item=>/^\s*OPENAI_API_KEY\s*=/.test(item))||"";
  return line.replace(/^\s*OPENAI_API_KEY\s*=\s*/,"").trim().replace(/^(["'])(.*)\1$/,"$2");
}
const rootDir=String(process.env.TREBELL_LIVE_STREAM_ROOT||"").trim()||tmpdir();

test.skip(!LIVE,"Set TREBELL_LIVE_NATIVE_STREAMING=1 to run Native reply streaming against OpenAI.");

// The GUI server's provider call: the hook comes off the request and rides in the turn options.
function liveProvider(requests){
  const providers=new ProviderManager({env:{OPENAI_API_KEY:openAiKey(),TREBELL_HOME:join(rootDir,"live-provider-home")},requestTimeoutMs:180_000});
  return {
    providers,
    turn:async request=>{
      const hooked=typeof request[NATIVE_REPLY_STREAM]==="function";requests.push({hooked,gate:request.metadata?.completionGate===true,returned:false});const entry=requests.at(-1);
      try{
        if(!hooked)return await providers.turn("openai",request,{signal:request.signal,promptCaching:false,streamResponses:true});
        const {[NATIVE_REPLY_STREAM]:onStream,...providerRequest}=request;
        return await providers.turn("openai",providerRequest,{signal:request.signal,promptCaching:false,streamResponses:true,...nativeStreamOptions("openai",onStream)});
      }finally{entry.returned=true}
    },
  };
}

for(const mode of ["dark","light"]){
  test(`live: a question to Trebell Native on OpenAI shows its reply before the turn ends (${mode})`,async({page})=>{
    test.setTimeout(240_000);
    await page.setViewportSize({width:1280,height:800});
    const requests=[],provider=liveProvider(requests);
    const fixture=await startStreamingFixture(page,{mode,model:MODEL,providerTurn:provider.turn,rootDir});
    try{
      await fixture.open("Native streaming");
      await fixture.send("Without using any tools, explain in three short paragraphs how a half-open range like range(start, end) works and why slice uses it. Do not change any files.");
      await expect(live(page)).toBeVisible({timeout:180_000});
      // The reply is on screen while the turn still runs.
      await expect(stop(page)).toBeVisible();expect(requests.at(-1)?.returned).toBe(false);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-live-mid-${mode}-1280x800.png`});
      await assertNoHorizontalScroll(page);
      await expect(stop(page)).toHaveCount(0,{timeout:180_000});
      await expect(live(page)).toHaveCount(0);await expect(page.locator(".history-assistant").last()).toContainText(/range/i);
      expect(requests.some(request=>request.hooked)).toBe(true);
      await page.screenshot({animations:"disabled",path:auditDir+`native-reply-streaming-live-final-${mode}-1280x800.png`});
    }finally{provider.providers.close?.();await fixture.close()}
  });
}

test("live: a coding prompt to Trebell Native on OpenAI is not streamed",async({page})=>{
  test.setTimeout(240_000);
  await page.setViewportSize({width:1280,height:800});
  const requests=[],provider=liveProvider(requests);
  const fixture=await startStreamingFixture(page,{model:MODEL,providerTurn:provider.turn,rootDir});
  try{
    await fixture.open("Native streaming");const seen=await watchLiveReply(page);
    await fixture.send("Fix the bug in session.js so refresh returns false.");
    // One provider call is enough to see the hook is absent; the turn is stopped after it to keep the run small.
    await expect.poll(()=>requests.filter(request=>request.returned).length,{timeout:180_000}).toBeGreaterThan(0);
    await stop(page).click();await expect(stop(page)).toHaveCount(0,{timeout:60_000});
    expect(requests.length).toBeGreaterThan(0);expect(requests.every(request=>!request.hooked),JSON.stringify(requests)).toBe(true);
    expect(await seen()).toEqual([]);
  }finally{provider.providers.close?.();await fixture.close()}
});
