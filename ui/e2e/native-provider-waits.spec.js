import { test,expect } from "@playwright/test";
import { assertNoHorizontalScroll,auditDir,gate,startStreamingFixture,stop } from "./native-stream-fixture.js";

// Tour lane L10 (2026-11-02, live on main d33f4f13). A turn on HCNSec.cn waited 150 s for an answer that never came with nothing
// on screen but its context step and Stop (L10-21), and a provider's refusal showed its raw JSON body (L10-16: JustWorker.icu's
// Cloudflare 522 page, Meta's {"error":{...}}). The real agent relay runs the real Native session; only the provider is faked.
const REPLY="The provider answered after its wait, and this is the turn's reply.";
const WAITING="Still waiting for OpenAI API to answer.";

for(const mode of ["dark","light"]){
  test(`a Native request its provider has not answered yet says the turn is still waiting for that provider, then that it answered (${mode})`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode,relayOptions:{nativeProviderWaitNoticeMs:1500}}),back=gate();
    fixture.script.push(async request=>{await back.promise;return {id:"after-wait",provider:request.provider,model:request.model,text:REPLY,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:14,totalTokens:26}}});
    try{
      await fixture.open("Native streaming");await fixture.send("Say hello. Do not change any files.");
      const row=page.locator(".tool-event.kind-retry"),card=page.getByTestId("activity-card").filter({has:row});
      await expect(row).toBeVisible({timeout:20_000});
      await expect(row.locator("summary strong")).toHaveText(WAITING);await expect(row.locator("summary em")).toHaveText("waiting");
      await expect(row).toHaveClass(/status-running/);await expect(card).not.toContainText("Retrying");
      await expect(card.locator(".activity-card-failed")).toHaveCount(0);await expect(stop(page)).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-waiting-${mode}-1280x800.png`});
      await page.setViewportSize({width:390,height:844});await expect(row).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-waiting-${mode}-390x844.png`});
      await page.setViewportSize({width:1280,height:800});
      back.open();
      await expect(page.locator(".history-assistant").filter({hasText:REPLY})).toHaveCount(1,{timeout:30_000});await expect(stop(page)).toHaveCount(0);
      await expect(row.locator("summary strong")).toHaveText("Answered after a wait");await expect(row.locator("summary em")).toHaveText("answered");
      await expect(row).toHaveClass(/status-done/);await expect(card).not.toContainText("Recovered after retrying");
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-answered-${mode}-1280x800.png`});
    }finally{back.open();await fixture.close()}
  });

  // The review of L10-21: a request the provider refused at once with a retryable 503, whose retry it then left unanswered, showed
  // nothing again, as the retry ended the wait.
  test(`a Native request sent again after a retryable refusal says the turn is still waiting when the retry goes unanswered (${mode})`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode,relayOptions:{nativeProviderWaitNoticeMs:1500}}),back=gate();let calls=0;
    fixture.script.push(async()=>{calls++;throw Object.assign(new Error("OpenAI API HTTP 503: busy"),{status:503,retryable:true})});
    fixture.script.push(async request=>{calls++;await back.promise;return {id:"after-retry-wait",provider:request.provider,model:request.model,text:REPLY,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:14,totalTokens:26}}});
    try{
      await fixture.open("Native streaming");await fixture.send("Say hello. Do not change any files.");
      const row=page.locator(".tool-event.kind-retry"),card=page.getByTestId("activity-card").filter({has:row});
      await expect(row).toBeVisible({timeout:20_000});
      await expect(row.locator("summary strong")).toHaveText(WAITING);await expect(row.locator("summary em")).toHaveText("waiting");
      expect(calls).toBe(2);
      await expect(card.locator(".activity-card-failed")).toHaveCount(0);await expect(stop(page)).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-retry-waiting-${mode}-1280x800.png`});
      back.open();
      await expect(page.locator(".history-assistant").filter({hasText:REPLY})).toHaveCount(1,{timeout:30_000});await expect(stop(page)).toHaveCount(0);
      await expect(row.locator("summary strong")).toHaveText("Answered after a wait");await expect(row).toHaveClass(/status-done/);
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-retry-answered-${mode}-1280x800.png`});
    }finally{back.open();await fixture.close()}
  });

  test(`a Native turn its provider refused ends with plain words and the provider's reason, never the raw JSON body (${mode})`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode});
    const body=JSON.stringify({error:{code:null,message:"Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output",param:null,type:"invalid_request_error"}});
    fixture.script.push(async()=>{throw Object.assign(new Error("OpenAI API HTTP 400: "+body),{status:400,retryable:false})});
    try{
      await fixture.open("Native streaming");await fixture.send("Say hello. Do not change any files.");
      const failure=page.locator(".tool-event.kind-error").last();
      await expect(failure).toBeVisible({timeout:20_000});
      await expect(failure).toContainText("OpenAI API refused the request (HTTP 400): Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output.");
      const card=page.getByTestId("activity-card").filter({has:failure});
      await expect(card).not.toContainText("{");await expect(card).not.toContainText("invalid_request_error");
      await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`l10-native-provider-refusal-${mode}-1280x800.png`});
    }finally{await fixture.close()}
  });
}
