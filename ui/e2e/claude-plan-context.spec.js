import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// A Claude Code thread as a person reads it, on the real relay with Claude Code's SDK scripted.
// Claude's to-do list (TodoWrite) and task list (TaskCreate, TaskUpdate) show as the turn's plan and update as Claude works, and after
// a restart the list goes on from the one Claude Code keeps.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const TODOS=[{content:"Read the release checklist",status:"in_progress",activeForm:"Reading the release checklist"},{content:"Update the changelog",status:"pending",activeForm:"Updating the changelog"},{content:"Tag the release",status:"pending",activeForm:"Tagging the release"}];

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}
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
