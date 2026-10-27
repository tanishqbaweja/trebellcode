import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importClaudeHistory } from "../../src/agent-history-import.mjs";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// A long Claude Code session copied into Trebell, as a person opens it afterwards on a Claude Code window on the real relay. The copy
// is the server's own (importClaudeHistory, as /api/history-import runs it), reading the session through the Claude Agent SDK, which
// is answered here as it answers: 2,000 messages, most of them tool calls and their results, cut from the start by offset and limit.
// The thread opens on the session's last request and its answer, where Claude Code resumes it, not on the session's opening.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

// requests turns of 8 messages: the request, three tool calls with their results (the first after a line of text), the answer.
function longSession(requests){
  const messages=[],user=(uuid,content)=>({type:"user",uuid,session_id:"long-session",parent_tool_use_id:null,message:{role:"user",content}});
  const assistant=(uuid,content)=>({type:"assistant",uuid,session_id:"long-session",parent_tool_use_id:null,message:{role:"assistant",content}});
  for(let n=1;n<=requests;n++){
    messages.push(user("u"+n,"Request "+n+": tidy the parser module"));
    for(let step=1;step<=3;step++){
      const id=`toolu_${n}_${step}`;
      messages.push(assistant(`t${n}-${step}`,[...(step===1?[{type:"text",text:"Looking into request "+n+"."}]:[]),{type:"tool_use",id,name:"Bash",input:{command:"npm test"}}]));
      messages.push(user(`r${n}-${step}`,[{type:"tool_result",tool_use_id:id,content:"ok"}]));
    }
    messages.push(assistant("a"+n,[{type:"text",text:"Answer "+n+": the parser module is tidy and its tests pass."}]));
  }
  return messages;
}
const sdkSessionMessages=messages=>async(_sessionId,options={})=>{
  const offset=options.offset??0;
  return options.limit!==undefined&&options.limit>0?messages.slice(offset,offset+options.limit):messages.slice(offset);
};
async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
const userRow=(page,text)=>page.locator(".user-row").filter({hasText:text});
const reply=(page,text)=>page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:text});

test("an imported long Claude Code session opens on its last request and answer",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({turn:async()=>{}});
  try{
    const messages=longSession(250),now=Date.now();expect(messages).toHaveLength(2000);
    const candidate={id:"claude-long-session",source:"claude",providerSessionId:randomUUID(),cwd:harness.repo,title:"Parser module cleanup",preview:"Request 1: tidy the parser module",createdAt:now-6*3600_000,updatedAt:now-60_000};
    const {status,thread}=await importClaudeHistory(harness.threadStore,candidate,{getSessionMessagesFn:sdkSessionMessages(messages)});
    expect(status).toBe("imported");harness.threads.push(thread);
    await routeClaudeApp(page,harness);
    await page.goto("/");await openThread(page,"Parser module cleanup");
    const last=userRow(page,"Request 250: tidy the parser module"),answer=reply(page,"Answer 250: the parser module is tidy and its tests pass.");
    await expect(last).toBeVisible({timeout:15_000});await expect(answer).toBeVisible();
    await expect(reply(page,"Looking into request 250.")).toBeVisible();
    // The copy holds the session's latest 120 requests, from request 131, and none of its tool records.
    const turns=harness.threadStore.get(thread.id).turns;
    expect(turns).toHaveLength(120);
    expect(turns[0].items[0].content[0].text).toBe("Request 131: tidy the parser module");
    expect(turns.every(turn=>turn.items.map(item=>item.type).join()==="userMessage,agentMessage,agentMessage")).toBe(true);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await answer.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-history-import-latest-turns-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
