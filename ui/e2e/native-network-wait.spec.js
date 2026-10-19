import { test,expect } from "@playwright/test";
import { assertNoHorizontalScroll,auditDir,gate,startStreamingFixture,stop } from "./native-stream-fixture.js";

// Trebell Native waiting for the network. The provider's name does not resolve (the failure of the 2026-10-19 outage), so the
// turn goes on, its retry row says it is waiting for the network and when it tries again, and the reply comes once the request
// gets through. The real agent relay runs the real Native session; only the provider is faked.
const unresolved=()=>Object.assign(new TypeError("fetch failed"),{cause:Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"),{code:"ENOTFOUND"})});
const WAITING="Waiting for the network (getaddrinfo ENOTFOUND api.openai.com). Trying again in 15 s.";
const REPLY="The request went through once the network came back, and this reply is the turn's answer.";

for(const mode of ["dark","light"]){
  test(`a Native turn waits for the network on its retry row and answers once the request gets through (${mode})`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const fixture=await startStreamingFixture(page,{mode});const back=gate();
    // The two quick retries and the first two network waits (2 and 5 s) pass unannounced; the third wait, 15 s, is announced.
    for(let index=0;index<5;index++)fixture.script.push(async()=>{throw unresolved()});
    fixture.script.push(async request=>{await back.promise;return {id:"after-outage",provider:request.provider,model:request.model,text:REPLY,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:16,totalTokens:28}}});
    try{
      await fixture.open("Native streaming");await fixture.send("Say hello once the network is back. Do not change any files.");
      const row=page.locator(".tool-event.kind-error").filter({hasText:WAITING});
      await expect(row).toBeVisible({timeout:20_000});await expect(row).toContainText("Retrying: "+WAITING);
      await expect(stop(page)).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-network-wait-${mode}-1280x800.png`});
      await page.setViewportSize({width:390,height:844});await expect(row).toBeVisible();await assertNoHorizontalScroll(page);
      await page.screenshot({animations:"disabled",path:auditDir+`native-network-wait-${mode}-390x844.png`});
      await page.setViewportSize({width:1280,height:800});
      back.open();
      const message=page.locator(".history-assistant").filter({hasText:REPLY});
      // The request is sent again when the 15 s wait ends, and it gets through.
      await expect(message).toHaveCount(1,{timeout:30_000});await expect(stop(page)).toHaveCount(0);
      expect(fixture.requests.length).toBe(6);
      await page.screenshot({animations:"disabled",path:auditDir+`native-network-wait-answered-${mode}-1280x800.png`});
    }finally{back.open();await fixture.close()}
  });
}
