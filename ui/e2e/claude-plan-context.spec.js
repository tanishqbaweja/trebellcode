import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// A Claude Code thread as a person reads it, on the real relay with Claude Code's SDK scripted.
// Claude's to-do list (TodoWrite) and task list (TaskCreate, TaskUpdate) show as the turn's plan and update as Claude works, and after
// a restart the list goes on from the one Claude Code keeps.
// The composer's meter says how full Claude's context window is: its latest request's prompt against the window Claude Code reports.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const TODOS=[{content:"Read the release checklist",status:"in_progress",activeForm:"Reading the release checklist"},{content:"Update the changelog",status:"pending",activeForm:"Updating the changelog"},{content:"Tag the release",status:"pending",activeForm:"Tagging the release"}];
const WINDOW={rawMaxTokens:200_000,maxTokens:200_000,totalTokens:20_000,percentage:10,isAutoCompactEnabled:true};

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}
const started=(id,usage)=>({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id,usage}}});
const toolCall=(id,name,input,text=null)=>({type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-"+id,content:[...(text?[{type:"text",text}]:[]),{type:"tool_use",id,name,input}]}});
const toolAnswer=(id,content,structured)=>({type:"user",parent_tool_use_id:null,message:{role:"user",content:[{type:"tool_result",tool_use_id:id,content}]},tool_use_result:structured});
const reply=(message,text,usage,cost)=>[
  {type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-"+randomUUID(),content:[{type:"text",text}]}},
  {type:"result",subtype:"success",is_error:false,result:text,user_message_uuid:message.uuid,total_cost_usd:cost,usage},
];
// A gate a scripted turn waits on until the test has seen what the turn showed so far.
function gate(){let open;const shut=new Promise(resolve=>{open=resolve});return {shut,open}}

test("Claude's to-do list and task list show as the turn's plan and update as Claude works through them",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const firstSeen=gate(),updateSeen=gate(),tasksSeen=gate();
  const harness=await startClaudeRelay({claudeHome:true,turn:async({message,index,emit})=>{
    if(index===0){
      emit(toolCall("toolu_todo_1","TodoWrite",{todos:TODOS},"Planning the release."));
      emit(toolAnswer("toolu_todo_1","Todos have been modified successfully.",{oldTodos:[],newTodos:TODOS}));
      await firstSeen.shut;
      const next=[{...TODOS[0],status:"completed"},{...TODOS[1],status:"in_progress"},TODOS[2]];
      emit(toolCall("toolu_todo_2","TodoWrite",{todos:next}));
      emit(toolAnswer("toolu_todo_2","Todos have been modified successfully.",{oldTodos:TODOS,newTodos:next}));
      await updateSeen.shut;
      for(const frame of reply(message,"The checklist is read; the changelog is next.",{input_tokens:3,output_tokens:1},0))emit(frame);
      return;
    }
    // Claude's Task tools keep the session's task list: two tasks, the first done and the second started.
    emit(toolCall("toolu_task_a","TaskCreate",{subject:"Write the migration",description:"Add the orders table migration."},"Tracking the migration as tasks."));
    emit(toolAnswer("toolu_task_a","Task #1 created successfully: Write the migration",{task:{id:"1",subject:"Write the migration"}}));
    emit(toolCall("toolu_task_b","TaskCreate",{subject:"Run the migration tests",description:"Run the migration's tests."}));
    emit(toolAnswer("toolu_task_b","Task #2 created successfully: Run the migration tests",{task:{id:"2",subject:"Run the migration tests"}}));
    emit(toolCall("toolu_task_c","TaskUpdate",{taskId:"1",status:"completed"}));
    emit(toolAnswer("toolu_task_c","Updated task #1 status",{success:true,taskId:"1",updatedFields:["status"],statusChange:{from:"pending",to:"completed"}}));
    emit(toolCall("toolu_task_d","TaskUpdate",{taskId:"2",status:"in_progress"}));
    emit(toolAnswer("toolu_task_d","Updated task #2 status",{success:true,taskId:"2",updatedFields:["status"],statusChange:{from:"pending",to:"in_progress"}}));
    await tasksSeen.shut;
    for(const frame of reply(message,"The migration is written; its tests run next.",{input_tokens:3,output_tokens:1},0))emit(frame);
  }});
  try{
    harness.seedThread("Release prep");
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Release prep");
    const plan=page.locator(".agent-block details.tool-event.kind-plan");
    const step=title=>plan.filter({has:page.locator("strong",{hasText:new RegExp("^"+title+"$")})});

    await send(page,"Prepare the release");
    await expect(page.getByText("Planning the release.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(plan).toHaveCount(3);
    await expect(step("Read the release checklist").locator("em")).toHaveText("running");
    await expect(step("Update the changelog").locator("em")).toHaveText("pending");
    await expect(step("Tag the release").locator("em")).toHaveText("pending");
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-plan-card-dark-1280x800.png`});

    // Claude's next list replaces it: the checklist done, the changelog started.
    firstSeen.open();
    await expect(step("Read the release checklist").locator("em")).toHaveText("done",{timeout:15_000});
    await expect(step("Update the changelog").locator("em")).toHaveText("running");
    await expect(step("Tag the release").locator("em")).toHaveText("pending");
    await expect(plan).toHaveCount(3);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-plan-updated-${mode}-1280x800.png`});
    }
    updateSeen.open();
    await expect(page.getByText("The checklist is read; the changelog is next.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});

    await send(page,"Track the migration as tasks");
    await expect(page.getByText("Tracking the migration as tasks.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(plan).toHaveCount(2);
    await expect(step("Write the migration").locator("em")).toHaveText("done");
    await expect(step("Run the migration tests").locator("em")).toHaveText("running");
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-task-list-plan-light-1280x800.png`});
    tasksSeen.open();
    await expect(page.getByText("The migration is written; its tests run next.",{exact:true})).toBeVisible({timeout:15_000});
  }finally{firstSeen.open();updateSeen.open();tasksSeen.open();await harness.close()}
});

test("after Trebell restarts, Claude's next change to its task list keeps the tasks Claude Code already has",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const planSeen=gate();
  const harness=await startClaudeRelay({claudeHome:true,turn:async({message,emit})=>{
    // Claude Code writes the change to its own list before the result comes, as its task tools do.
    writeFileSync(join(tasks,"2.json"),JSON.stringify({id:"2",subject:"Run the migration tests",description:"",status:"in_progress",blocks:[],blockedBy:["1"]}));
    emit(toolCall("toolu_task_go","TaskUpdate",{taskId:"2",status:"in_progress"},"Running the migration tests next."));
    emit(toolAnswer("toolu_task_go","Updated task #2 status",{success:true,taskId:"2",updatedFields:["status"],statusChange:{from:"pending",to:"in_progress"}}));
    await planSeen.shut;
    for(const frame of reply(message,"The migration tests are running.",{input_tokens:3,output_tokens:1},0))emit(frame);
  }});
  // The thread's Claude session made its list before the restart: Claude Code keeps it in its home, one file a task.
  const thread=harness.seedThread("Orders migration"),tasks=join(harness.claudeHome,"tasks",thread.providerSessionId);
  mkdirSync(tasks,{recursive:true});
  for(const task of [{id:"1",subject:"Write the migration",status:"completed"},{id:"2",subject:"Run the migration tests",status:"pending"},{id:"3",subject:"Tag the release",status:"pending"}])writeFileSync(join(tasks,task.id+".json"),JSON.stringify({description:"",blocks:[],blockedBy:[],...task}));
  try{
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Orders migration");
    const plan=page.locator(".agent-block details.tool-event.kind-plan");
    const step=title=>plan.filter({has:page.locator("strong",{hasText:new RegExp("^"+title+"$")})});
    await send(page,"Go on with the migration");
    await expect(page.getByText("Running the migration tests next.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(plan).toHaveCount(3);
    await expect(step("Write the migration").locator("em")).toHaveText("done");
    await expect(step("Run the migration tests").locator("em")).toHaveText("running");
    await expect(step("Tag the release").locator("em")).toHaveText("pending");
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-task-list-after-restart-dark-1280x800.png`});
    planSeen.open();
    await expect(page.getByText("The migration tests are running.",{exact:true})).toBeVisible({timeout:15_000});
  }finally{planSeen.open();await harness.close()}
});

test("the composer's meter says how full Claude's context window is: its latest request's prompt against the window Claude Code reports",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const firstSeen=gate(),secondSeen=gate(),compactedSeen=gate();
  const harness=await startClaudeRelay({
    control:{getContextUsage:()=>({...WINDOW})},
    turn:async({message,index,emit})=>{
      const delta=usage=>emit({type:"stream_event",parent_tool_use_id:null,event:{type:"message_delta",delta:{stop_reason:"tool_use"},usage}});
      if(index===0){
        emit(started("msg-ctx-1",{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:1}));
        emit({type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-ctx-1",content:[{type:"text",text:"Reading the repository."}]}});
        delta({output_tokens:240});
        await firstSeen.shut;
        emit(started("msg-ctx-2",{input_tokens:400,cache_creation_input_tokens:0,cache_read_input_tokens:149_600,output_tokens:1}));
        await secondSeen.shut;
        for(const frame of reply(message,"The repository has three packages.",{input_tokens:1600,cache_creation_input_tokens:2800,cache_read_input_tokens:269_600,output_tokens:420},0.42))emit(frame);
        return;
      }
      // Claude compacts the conversation on its own in the next turn: the meter shows what the compaction kept.
      emit({type:"system",subtype:"status",status:"compacting",session_id:"s",uuid:randomUUID()});
      emit({type:"system",subtype:"status",status:null,compact_result:"success",session_id:"s",uuid:randomUUID()});
      emit({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"auto",pre_tokens:150_000,post_tokens:30_000},session_id:"s",uuid:randomUUID()});
      await compactedSeen.shut;
      emit(started("msg-ctx-3",{input_tokens:500,cache_creation_input_tokens:31_500,cache_read_input_tokens:0,output_tokens:1}));
      for(const frame of reply(message,"Summarized the parser.",{input_tokens:500,cache_creation_input_tokens:31_500,cache_read_input_tokens:0,output_tokens:60},0.5))emit(frame);
    },
  });
  try{
    harness.seedThread("Repository tour");
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Repository tour");
    const meter=page.getByRole("meter",{name:"Context window used"}),context=page.locator(".composer-context");
    // The meter's numbers as the page writes them, in its own locale.
    const [k124,k150,k30,k32,k200]=await page.evaluate(values=>values.map(value=>value.toLocaleString()),[124_000,150_000,30_000,32_000,200_000]);

    await send(page,"Tour the repository");
    await expect(page.getByText("Reading the repository.",{exact:true})).toBeVisible({timeout:15_000});
    // 124,000 of the request's prompt (its input and cache tokens) against Claude Code's 200,000-token window.
    await expect(meter).toHaveAttribute("aria-valuenow","62");
    await expect(context).toContainText(`62% · ${k124}/${k200}`);
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-context-meter-dark-1280x800.png`});
    firstSeen.open();
    // The next request's prompt is the context now.
    await expect(meter).toHaveAttribute("aria-valuenow","75",{timeout:15_000});
    await expect(context).toContainText(`75% · ${k150}/${k200}`);
    secondSeen.open();
    // The turn's result brings its cost; the context stays its last request's.
    await expect(page.getByText("The repository has three packages.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(context).toContainText(`75% · ${k150}/${k200} · $0.42`);
    await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-context-meter-light-1280x800.png`});

    await send(page,"Summarize the parser");
    await expect(meter).toHaveAttribute("aria-valuenow","15",{timeout:15_000});
    await expect(context).toContainText(`15% · ${k30}/${k200}`);
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-context-meter-compacted-light-1280x800.png`});
    compactedSeen.open();
    await expect(page.getByText("Summarized the parser.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(context).toContainText(`16% · ${k32}/${k200} · $0.08`);
  }finally{firstSeen.open();secondSeen.open();compactedSeen.open();await harness.close()}
});
