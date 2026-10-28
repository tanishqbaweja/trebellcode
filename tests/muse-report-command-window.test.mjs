import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityRow, mergeLiveRow, settledRow } from "../ui/src/activity-item.js";
import { completedItemStatus } from "../ui/src/tool-event-status.js";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// A command Muse Code's report still runs when the person's message takes the report over, as the open window shows it. Muse Code's
// session sends the command's row again, saying it runs on past the report's turn (runsPastTurn); the window's row takes that in
// although its title, kind and status are as they were, so the report's end in Trebell leaves the command running on the report's
// card, and only the command's own end settles it there. The rows are folded from the real relay's notifications as the window folds
// them (App.jsx): each item notification's row merged by mergeLiveRow, and the turn's end settling them by settledRow with keepPast.
function windowRow(notifications,{threadId,commandId,reportId}){
  let row=null,atReportEnd=null;
  for(const {method,params} of notifications){
    if(params?.threadId!==threadId)continue;
    if(method==="turn/completed"&&String(params.turn?.id)===reportId){atReportEnd=row&&settledRow(row,{keepPast:true});row=atReportEnd;continue}
    const phase={"item/started":"started","item/tool/progress":"progress","item/completed":"completed"}[method];
    if(!phase||params.item?.id!==commandId)continue;
    row=mergeLiveRow(row,activityRow(phase==="completed"?{...params.item,status:completedItemStatus(params.item)}:params.item,{turnId:params.turnId}),{phase});
  }
  return {atReportEnd:atReportEnd&&{status:atReportEnd.status,runsPastTurn:atReportEnd.raw?.runsPastTurn===true},now:row&&{status:row.status,turnId:row.turnId}};
}

test("a command Muse Code's report still runs when a message takes the report over keeps running in the window past the report's end, until its own end settles it on the report's card",async()=>{
  const holds=await mkdtemp(join(tmpdir(),"trebell-muse-report-command-hold-")),release=join(holds,"release");
  const relay=await museRelay("trebell-muse-report-command-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1",MUSE_FAKE_REPORT_COMMAND:"1",MUSE_FAKE_REPORT_COMMAND_HOLD:release}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    await relay.completed(thread.id,1);
    // Muse reports on the finished workflow in a turn of its own, and runs `npm test` there, which goes on until the hold's file is there.
    const started=()=>relay.notifications.find(item=>item.method==="item/started"&&item.params.threadId===thread.id&&String(item.params.item?.id||"").endsWith("-report-check"));
    await eventually(()=>started(),"the report's command");
    const commandId=started().params.item.id,reportId=String(started().params.turnId),shape={threadId:thread.id,commandId,reportId};
    // The person's message takes the report over: the report's turn ends in Trebell while Muse still runs the command.
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"And one more thing"}]});
    await relay.completed(thread.id,2);
    const ended=relay.notifications.findIndex(item=>item.method==="turn/completed"&&String(item.params.turn?.id)===reportId);
    assert.ok(relay.notifications.slice(0,ended).some(item=>item.method==="item/tool/progress"&&item.params.item?.id===commandId&&item.params.item.runsPastTurn===true),"the row came again before the report's end, saying it runs past it");
    assert.deepEqual(windowRow(relay.notifications,shape),{atReportEnd:{status:"running",runsPastTurn:true},now:{status:"running",turnId:reportId}},"the report's end leaves the command running on its card");
    // The command ends: its row settles there, on the report's card, and the message's turn runs.
    await writeFile(release,"");
    await relay.completed(thread.id,3);
    assert.deepEqual(windowRow(relay.notifications,shape).now,{status:"done",turnId:reportId});
    assert.ok(relay.notifications.filter(item=>/^item\//.test(item.method)&&item.params.item?.id===commandId).every(item=>String(item.params.turnId)===reportId),"no row of it is the message's turn's");
  }finally{await relay.close();await rm(holds,{recursive:true,force:true}).catch(()=>{})}
});
