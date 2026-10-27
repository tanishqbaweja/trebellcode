import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// The Usage page's records of Claude Code turns as a person reads them, on the real relay with Claude Code's SDK scripted and the
// records the relay keeps. A turn that fails before a request of its own (Claude compacted on its own, then its request failed)
// counts only what it cost itself, never the tokens of the turn before it again, which the composer's meter still shows until the
// turn's first request.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const status=(fields={})=>({type:"system",subtype:"status",session_id:"s",uuid:randomUUID(),...fields});

test("a Claude turn that fails after Claude compacted on its own counts only its own cost on the Usage page, not the turn before's tokens again",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({turn:async({message,index,emit})=>{
    if(index===0){
      // 124,030 tokens and $0.12: 1,200 input, 2,800 cache writes, 120,000 cache reads and 30 output.
      emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id:"msg-usage-1",usage:{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:1}}}});
      emit({type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-usage-1",content:[{type:"text",text:"The repository has three packages."}]}});
      emit({type:"result",subtype:"success",is_error:false,result:"The repository has three packages.",user_message_uuid:message.uuid,total_cost_usd:0.12,usage:{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:30}});
      return;
    }
    // Claude compacts on its own as the turn starts ($0.03 of its own), and the request after it fails: Claude's API is overloaded.
    emit(status({status:"compacting"}));emit(status({status:null,compact_result:"success"}));
    emit({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"auto",pre_tokens:150_000,post_tokens:30_000},session_id:"s",uuid:randomUUID()});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:529,result:"API Error: 529 Overloaded",user_message_uuid:message.uuid,total_cost_usd:0.15,usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}});
  }});
  try{
    harness.seedThread("Repository summary",{permissionProfile:"supervised"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    // The Usage page reads the records the relay kept, as gui-server.mjs answers /api/usage from its state.
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>{
      const url=new URL(route.request().url()),environmentIds=url.searchParams.getAll("environmentId");
      return json(route,harness.state.usage({days:Number(url.searchParams.get("days")||30),limit:Number(url.searchParams.get("limit")||1000),environmentIds:environmentIds.length?environmentIds.map(value=>!value||value==="local"?null:value):undefined}));
    });
    await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,route=>json(route,{runtime:"claude",instanceId:"claude-default",environmentId:null,checkedAt:new Date().toISOString(),windows:[]}));
    await page.goto("/");await openThread(page,"Repository summary");
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await send(page,"Summarize the repository");
    await expect(page.getByText("The repository has three packages.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop).toHaveCount(0,{timeout:15_000});
    await send(page,"Go on");
    await expect(stop).toHaveCount(0,{timeout:15_000});
    await expect(page.locator(".agent-block .tool-event.kind-error").filter({hasText:"529"})).toBeVisible({timeout:15_000});

    await page.getByRole("button",{name:"Usage",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
    const rows=page.locator(".usage-recent .usage-table > div:not(.usage-table-head)"),cells=row=>row.locator("span");
    await expect(rows).toHaveCount(2,{timeout:15_000});
    // The failed turn: what its compaction cost, and none of the turn before's tokens.
    const failed=rows.filter({hasText:"$0.0300"}),answered=rows.filter({hasText:"$0.1200"});
    await expect(cells(failed).nth(4)).toHaveText("0");
    await expect(cells(answered).nth(4)).toHaveText("124K");
    // The totals count the turn before's tokens once.
    const total=page.locator(".usage-summary > div").first();
    await expect(total.locator("strong")).toHaveText("124K");await expect(total.locator("small")).toHaveText("2 recorded turns");
    await expect(page.locator(".usage-summary > div").nth(3).locator("strong")).toHaveText("$0.1500");
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.locator(".usage-recent").scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-usage-after-compaction-failure-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
