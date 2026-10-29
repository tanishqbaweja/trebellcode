import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// A Claude Code thread as a person reads it, on the real relay with Claude Code's SDK scripted.
// Claude's to-do list (TodoWrite) and task list (TaskCreate, TaskUpdate) show as the turn's plan and update as Claude works, and after
// a restart the list goes on from the one Claude Code keeps. A TodoWrite changes the plan only: no step says it edited files.
// The composer's meter says how full Claude's context window is: its latest request's prompt against the window Claude Code reports.
// A hook's reason for dropping the prompt shows once as a row of its turn instead of as the answer, and a Compact whose compaction
// failed says why instead of reading compacted.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const TODOS=[{content:"Read the release checklist",status:"in_progress",activeForm:"Reading the release checklist"},{content:"Update the changelog",status:"pending",activeForm:"Updating the changelog"},{content:"Tag the release",status:"pending",activeForm:"Tagging the release"}];
const REASON="Prompt dropped by a hook: Deploys are frozen until Monday.";
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

// A to-do list is no file: Claude's TodoWrite calls (the root's two lists and a subagent's own, which is never answered) change the plan
// and add no step that says files were edited, on the turn's card as the turn runs, once it ended, when the thread is opened again and
// after a reload, while Claude's edits (Edit, Write, MultiEdit, NotebookEdit) still show as edits that name their files. A TodoWrite
// that failed shows as the failed call it is.
test("Claude's to-do lists update the plan only, with no step saying files were edited, live and reopened, while its edits still name their files",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const listSeen=gate();
  const EDITS=[["toolu_edit","Edit",{file_path:"CHANGELOG.md",old_string:"## Unreleased",new_string:"## 2.0.0"}],["toolu_write","Write",{file_path:"RELEASE-NOTES.md",content:"# 2.0.0\n"}],["toolu_multi","MultiEdit",{file_path:"package.json",edits:[{old_string:"\"version\": \"1.9.0\"",new_string:"\"version\": \"2.0.0\""}]}],["toolu_notebook","NotebookEdit",{notebook_path:"release-checks.ipynb",new_source:"print(\"2.0.0\")"}]];
  const FILES=EDITS.map(([,,input])=>input.file_path||input.notebook_path);
  const harness=await startClaudeRelay({turn:async({message,emit})=>{
    emit(toolCall("toolu_todo_1","TodoWrite",{todos:TODOS},"Planning the release."));
    emit(toolAnswer("toolu_todo_1","Todos have been modified successfully.",{oldTodos:[],newTodos:TODOS}));
    for(const [id,name,input] of EDITS){emit(toolCall(id,name,input));emit(toolAnswer(id,"The file was updated."))}
    emit(toolCall("agent-1","Agent",{description:"Check the release notes",prompt:"Check that the release notes name every change."}));
    emit({...toolCall("toolu_todo_sub","TodoWrite",{todos:[{content:"A subagent's own step",status:"pending",activeForm:"Taking its own step"}]}),parent_tool_use_id:"agent-1"});
    emit({...toolCall("toolu_todo_bad","TodoWrite",{todos:[{content:"A subagent's next step"}]}),parent_tool_use_id:"agent-1"});
    emit({type:"user",parent_tool_use_id:"agent-1",message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_todo_bad",is_error:true,content:"<tool_use_error>InputValidationError: The required parameter `todos[0].status` is missing</tool_use_error>"}]}});
    const next=[{...TODOS[0],status:"completed"},{...TODOS[1],status:"in_progress"},TODOS[2]];
    emit(toolCall("toolu_todo_2","TodoWrite",{todos:next}));
    emit(toolAnswer("toolu_todo_2","Todos have been modified successfully.",{oldTodos:TODOS,newTodos:next}));
    await listSeen.shut;
    emit(toolAnswer("agent-1","The release notes name every change."));
    for(const frame of reply(message,"The checklist is read; the changelog is next.",{input_tokens:3,output_tokens:1},0))emit(frame);
  }});
  try{
    harness.seedThread("Release prep");harness.seedThread("Hotfix");
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Release prep");
    const card=page.getByTestId("activity-card").last(),rows=card.locator("details.tool-event");
    const titled=title=>rows.filter({has:page.locator("summary strong",{hasText:title})});
    const editing=titled(/^Editing files$/),plan=card.locator("details.tool-event.kind-plan");
    const openCard=async()=>{await expect(card).toBeVisible({timeout:15_000});if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();await expect(card).toHaveAttribute("data-state","open")};
    // The file each step that says it edits files names once it is opened.
    const named=async()=>{
      const files=[];
      for(const row of await editing.all()){
        if(!await row.evaluate(node=>node.open))await row.locator("summary").click();
        const text=await row.locator(".tool-event-body").innerText();files.push(FILES.find(file=>text.includes(file))||"no file: "+text.slice(0,160));
      }
      return files;
    };
    // shot: the card's screenshots, taken before its steps are opened.
    const editsOnly=async(when,shot=null)=>{
      await expect(editing,`only Claude's edits say they edit files (${when})`).toHaveCount(EDITS.length);
      await expect(titled(/^TodoWrite$/).locator("summary em"),`no TodoWrite step but the one that failed (${when})`).toHaveText(["failed"]);
      if(shot)await shot();
      expect(await named(),`each edit names its file (${when})`).toEqual(FILES);
      await expect(page.getByText("A subagent's own step"),`the subagent's list shows nowhere (${when})`).toHaveCount(0);
    };

    await send(page,"Prepare the release");
    await expect(page.getByText("Planning the release.",{exact:true})).toBeVisible({timeout:15_000});
    await openCard();
    // Claude's second list is the plan; the subagent's own list is not.
    await expect(plan.locator("summary strong")).toHaveText(TODOS.map(todo=>todo.content),{timeout:15_000});
    await expect(plan.locator("summary em")).toHaveText(["done","running","pending"],{timeout:15_000});
    await editsOnly("as the turn runs",()=>page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-plan-only-live-dark-1280x800.png`}));
    listSeen.open();
    await expect(page.getByText("The checklist is read; the changelog is next.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    await openCard();
    await editsOnly("once the turn ended");

    // The thread opened again, from another thread, and after the window reloaded: its card, from the thread's history, says the same.
    await openThread(page,"Hotfix");await openThread(page,"Release prep");
    await expect(page.getByText("The checklist is read; the changelog is next.",{exact:true})).toBeVisible({timeout:15_000});
    await openCard();
    await editsOnly("opened again");
    await page.reload();
    await expect(page.locator('.thread-main[title="Hotfix"]'),"the thread list has loaded").toHaveCount(1,{timeout:15_000});
    await openThread(page,"Release prep");
    await expect(page.getByText("The checklist is read; the changelog is next.",{exact:true})).toBeVisible({timeout:15_000});
    await openCard();
    await editsOnly("after a reload",async()=>{
      for(const mode of ["dark","light"]){
        if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
        await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-plan-only-reloaded-${mode}-1280x800.png`});
      }
    });
    await page.setViewportSize({width:700,height:800});
    await expect(editing,"a narrow window shows the same steps").toHaveCount(EDITS.length);
    await expect(titled(/^TodoWrite$/).locator("summary em")).toHaveText(["failed"]);
    await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-plan-only-reloaded-light-700x800.png`});
  }finally{listSeen.open();await harness.close()}
});

// A Claude thread recorded before Claude's to-do lists showed as the plan only kept each TodoWrite as a file change that names no file
// (the relay read Claude's TodoWrite as an edit). Opened again, from another thread and after a reload, its card shows no step saying
// files were edited for them, only Claude's real edit, and the TodoWrite that failed reads as the failed call it is.
test("a Claude thread that stored its to-do lists as file changes shows no step saying files were edited for them, opened again and after a reload",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({turn:async()=>{}});
  try{
    const thread=harness.seedThread("Release prep");harness.seedThread("Hotfix");
    // The turn's items as the relay stored them then: each TodoWrite a file change with no file and the list as its input, the subagent's
    // still running as the turn ended, beside Claude's edit of the changelog.
    const todoWrite=(id,status,todos,rawOutput)=>({type:"fileChange",id,status,changes:[],rawInput:{todos},...(rawOutput?{rawOutput}:{})});
    const turn=harness.threadStore.addTurn(thread.id,{inputText:"Prepare the release",items:[
      todoWrite("toolu_todo_1","completed",TODOS,"Todos have been modified successfully."),
      {type:"fileChange",id:"toolu_edit",status:"completed",changes:[{path:"CHANGELOG.md",kind:"update",oldText:"## Unreleased\n",newText:"## 2.0.0\n"}],rawInput:{file_path:"CHANGELOG.md",old_string:"## Unreleased",new_string:"## 2.0.0"},rawOutput:"The file was updated."},
      todoWrite("toolu_todo_sub","inProgress",[{content:"A subagent's own step",status:"pending",activeForm:"Taking its own step"}]),
      todoWrite("toolu_todo_bad","failed",[{content:"A subagent's next step"}],"<tool_use_error>InputValidationError: The required parameter `todos[0].status` is missing</tool_use_error>"),
      todoWrite("toolu_todo_2","completed",TODOS,"Todos have been modified successfully."),
      {type:"agentMessage",id:"assistant-release",text:"The checklist is read; the changelog is next."},
    ]});
    harness.threadStore.finishTurn(thread.id,turn.id,{status:"completed"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Release prep");
    const card=page.getByTestId("activity-card").last(),rows=card.locator("details.tool-event");
    const titled=title=>rows.filter({has:page.locator("summary strong",{hasText:title})});
    const shown=async when=>{
      await expect(page.getByText("The checklist is read; the changelog is next.",{exact:true})).toBeVisible({timeout:15_000});
      await expect(card).toBeVisible({timeout:15_000});if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();
      await expect(card.locator(".activity-card-summary"),`the card counts the edit and the list that failed, no other list (${when})`).toHaveText(/^2 steps/);
      await expect(titled(/^Editing files$/),`only Claude's edit says it edits files (${when})`).toHaveCount(1);
      await expect(titled(/^TodoWrite$/).locator("summary em"),`the list that failed reads as the failed call it is (${when})`).toHaveText(["failed"]);
      const editing=titled(/^Editing files$/);if(!await editing.evaluate(node=>node.open))await editing.locator("summary").click();
      await expect(editing.locator(".tool-event-body"),`the edit names its file (${when})`).toContainText("CHANGELOG.md");
    };
    await shown("opened");
    await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-stored-opened-dark-1280x800.png`});
    await openThread(page,"Hotfix");await openThread(page,"Release prep");
    await shown("opened again");
    // The window reloads with the other thread open: a reload can list the thread open as it reloads twice in the sidebar, a glitch of
    // the sidebar's own that this test does not look at.
    await openThread(page,"Hotfix");
    await page.reload();
    await expect(page.locator('.thread-main[title="Release prep"]'),"the thread list has loaded").toHaveCount(1,{timeout:15_000});
    await openThread(page,"Release prep");
    await shown("after a reload");
    await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-stored-reloaded-light-1280x800.png`});
    await page.setViewportSize({width:700,height:800});
    await expect(titled(/^Editing files$/),"a narrow window shows the same steps").toHaveCount(1);
    await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:`${auditDir}claude-todo-stored-reloaded-light-700x800.png`});
  }finally{await harness.close()}
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

test("a hook's reason for dropping a Claude prompt shows once in its turn, and a Compact whose compaction failed says why instead of reading compacted",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({turn:async({message,emit})=>{
    const said=message.message.content.map(part=>part.text||"").join("");
    if(said==="/compact"){
      emit({type:"system",subtype:"status",status:"compacting",session_id:"s",uuid:randomUUID()});
      emit({type:"system",subtype:"status",status:null,compact_result:"failed",compact_error:"Not enough messages to compact.",session_id:"s",uuid:randomUUID()});
      emit({type:"result",subtype:"success",is_error:false,result:"",local_command:"compact",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
      return;
    }
    if(said.includes("Deploy to production")){
      // A UserPromptSubmit hook blocked the prompt: Claude Code warns with its reason and repeats it as the result's text.
      emit({type:"system",subtype:"informational",content:"Started in the background: agent-1",level:"info",session_id:"s",uuid:randomUUID()});
      emit({type:"system",subtype:"informational",content:REASON,level:"warning",prevent_continuation:true,session_id:"s",uuid:randomUUID()});
      emit({type:"result",subtype:"success",is_error:false,result:REASON,num_turns:0,user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
    }
  }});
  // The relay's answer to Compact, which comes after everything the compaction sent (a compacted thread among it).
  let compactRequest=null,compactAnswered;const compactAnswer=new Promise(resolve=>{compactAnswered=resolve});
  page.on("websocket",socket=>{
    const read=payload=>{try{return JSON.parse(String(payload))}catch{return null}};
    socket.on("framesent",({payload})=>{const message=read(payload);if(message?.method==="thread/compact/start")compactRequest=message.id});
    socket.on("framereceived",({payload})=>{const message=read(payload);if(compactRequest!=null&&message?.id===compactRequest&&!message.method)compactAnswered(message)});
  });
  try{
    harness.seedThread("Deploy",{permissionProfile:"supervised"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Deploy");

    await send(page,"Deploy to production");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    const card=page.getByTestId("activity-card").last();
    await expect(card).toBeVisible({timeout:15_000});
    if(await card.getAttribute("data-state")==="closed")await card.locator(".activity-card-head").click();
    const notice=card.locator("details.tool-event").filter({has:page.locator("strong",{hasText:REASON})});
    // Soft, so that the old code also shows what Compact says.
    await expect.soft(notice,"the hook's reason, as a finished row of the turn").toBeVisible();
    await expect.soft(notice.locator("em")).toHaveText("done");
    await expect.soft(page.locator(".history-assistant").filter({hasText:REASON}),"not as Claude's answer too").toHaveCount(0);
    await expect.soft(page.getByText("Started in the background: agent-1"),"an info line stays out").toHaveCount(0);
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-hook-dropped-prompt-notice-dark-1280x800.png`});

    await page.locator(".composer-context .context-compact-btn").click();
    const failed=page.getByText("Context compaction failed: Not enough messages to compact.",{exact:true});
    await expect.soft(failed,"the failure says why").toBeVisible({timeout:15_000});
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-compaction-failed-${mode}-1280x800.png`});
    }
    // The relay refuses the compaction instead of reporting the thread compacted, which the window would have said.
    const answer=await compactAnswer;
    expect.soft(answer.error?.message,"the relay's answer is the failure").toBe("Not enough messages to compact.");
    await expect(page.getByText("Context compacted",{exact:true}),"never reported compacted").toHaveCount(0);
    await expect(failed).toBeVisible();
  }finally{await harness.close()}
});
