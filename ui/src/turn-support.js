// What the app does around an agent's turn beyond showing it: the repository context a send carries, the new worktree a send can
// ask for, the compaction a send runs first, a send that is a command rather than a message (a project's recipe or one of the
// composer's slash commands), the agent's own tool calls (Trebell's browser, computer, source-control, repository and delegation
// tools), the verification planned once a turn completes, and the turns a restart interrupted; and what the person starts around a
// turn: a send in the background or to several models, a delegated task, a queued follow-up's Send now, Edit from here, Compact and
// a desktop SnapShot attached. Nothing on the first screen or in opening and reading a thread needs it, so App loads this module at
// idle after the first paint (B11). Each function takes what it reads of App's render as deps, as App's own functions read it.
import { api } from "./api.js";
import { codexGoalsMissing, describeCodexGoal } from "./codex-turn-options.js";
import { parseCodexGoalCommand } from "./codex-goal-command.js";
import { repositoryFocusPaths } from "./context-focus.js";
import { contextTaskAnchor, contextTaskText } from "./context-task.js";
import { repositoryContextDeliveryPacket, repositoryContextEntries } from "./context-provenance.js";
import { desktopBridgeToolAvailability } from "./desktop-tool-availability.js";
import { requestTurnVerificationPlan, verificationPlanEvent } from "./turn-verification.js";
import { maybeStartAutomaticVerificationRepair } from "./auto-verification-repair.js";
import { maybeStartAutomaticVerificationContinuation } from "./auto-verification-continuation.js";
import { askTerminalKeyboard } from "./terminal-keyboard.js";
import { autoCompactionDecision } from "./auto-compaction.js";
import { isVideoAttachment } from "./composer-state.js";
import { fanoutWorkspaceError, threadForWorktree } from "./fanout-utils.js";
import { threadListParams } from "./thread-list-query.js";
import { configuredModelOptions } from "../../src/model-options.mjs";
import { configuredReasoningEffort } from "../../src/model-reasoning-effort.mjs";
import { configuredModelServiceTier } from "../../src/model-service-tier.mjs";
import { nativeTurnContextOptions } from "../../src/native-configuration.mjs";
import { harnessThreadOptions, harnessTurnOptions } from "./harness-turn-options.js";
import { queuedSubmissionDraft, queuedSubmissionNeedsToolExpansion } from "./native-queue.js";
import { browserVerificationReceipt } from "../../src/browser-verification-evidence.mjs";
import { CODEX_GOAL_START } from "../../src/codex-goal-start.mjs";

export { repositoryContextEntries } from "./context-provenance.js";

function sentenceText(value){const text=String(value||"").trim();return !text||/[.!?…]$/.test(text)?text:text+"."}

async function recordBrowserVerificationEvidence(client,params,tool,result,success=true){
  const threadId=String(params?.threadId||"").trim(),turnId=String(params?.turnId||"").trim();if(!client?.request||!threadId||!turnId)return;
  const evidence=browserVerificationReceipt({tool,result,success,callId:params?.callId||params?.toolCallId||null});if(!evidence)return;
  await client.request("thread/verification/evidence/record",{threadId,turnId,evidence}).catch(()=>null);
}

// A tool the agent calls that Trebell itself answers (item/tool/call): each answer goes back on the socket that asked.
export function answerToolCall({client,message,permissionMode,activeThread,linkPullRequestUrl,projectPath,workspaceEnvironmentId,runtimeCapabilities,delegateTask,loadSharedToolCatalog}){
  const p=message.params||{};
  if(p.namespace==="trebell_browser"){
    (async()=>{
      try{
        if(!window.trebellDesktop?.browser)throw new Error("Agent browser is only available in the desktop app.");
        const {sharedToolResponseContent}=await loadSharedToolCatalog();
        let result;
        if(p.tool==="open")result=await window.trebellDesktop.browser.navigate(p.arguments?.url);
        else if(p.tool==="back")result=await window.trebellDesktop.browser.back();
        else if(p.tool==="forward")result=await window.trebellDesktop.browser.forward();
        else if(p.tool==="reload")result=await window.trebellDesktop.browser.reload();
        else if(p.tool==="snapshot")result=await window.trebellDesktop.browser.snapshot();
        else if(p.tool==="click")result=await window.trebellDesktop.browser.click(p.arguments?.ref);
        else if(p.tool==="type")result=await window.trebellDesktop.browser.type(p.arguments?.ref,p.arguments?.text);
        else if(p.tool==="runtime")result=await window.trebellDesktop.browser.runtime();
        else if(p.tool==="set_viewport")result=await window.trebellDesktop.browser.setViewport(p.arguments?.width,p.arguments?.height);
        else if(p.tool==="screenshot"){
          const shot=await window.trebellDesktop.browser.screenshot();
          await recordBrowserVerificationEvidence(client,p,p.tool,shot,true);
          client.respond(message.id,{contentItems:sharedToolResponseContent("trebell_browser",[{type:"inputImage",imageUrl:shot.dataUrl},{type:"inputText",text:JSON.stringify({url:shot.url,title:shot.title,width:shot.width,height:shot.height})}]),success:true});
          return;
        }else throw new Error("Unknown Trebell browser tool: "+p.tool);
        await recordBrowserVerificationEvidence(client,p,p.tool,result,true);
        client.respond(message.id,{contentItems:sharedToolResponseContent("trebell_browser",[{type:"inputText",text:JSON.stringify(result)}]),success:true});
      }catch(error){
        await recordBrowserVerificationEvidence(client,p,p.tool,null,false);
        client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false});
      }
    })();
    return;
  }
  if(p.namespace==="trebell_computer"){
    (async()=>{
      try{
        if(!desktopBridgeToolAvailability(window.trebellDesktop).computer)throw new Error("Computer use is only available in the Windows desktop app.");
        const args=p.arguments||{};
        if(p.tool!=="screenshot"&&permissionMode!=="full")throw new Error("Desktop mouse and keyboard control requires Full access mode.");
        const {sharedToolResponseContent}=await loadSharedToolCatalog();
        if(p.tool==="screenshot"){
          const shot=await window.trebellDesktop.computer.screenshot();
          client.respond(message.id,{contentItems:sharedToolResponseContent("trebell_computer",[{type:"inputImage",imageUrl:shot.dataUrl},{type:"inputText",text:JSON.stringify({width:shot.width,height:shot.height,displayId:shot.displayId,originX:shot.originX,originY:shot.originY,scaleFactor:shot.scaleFactor})}]),success:true});
          return;
        }
        let result;
        if(p.tool==="move")result=await window.trebellDesktop.computer.move(args.x,args.y);
        else if(p.tool==="click")result=await window.trebellDesktop.computer.click(args);
        else if(p.tool==="scroll")result=await window.trebellDesktop.computer.scroll(args.delta);
        else if(p.tool==="type")result=await window.trebellDesktop.computer.type(args.text);
        else if(p.tool==="key")result=await window.trebellDesktop.computer.key(args.key);
        else throw new Error("Unknown Trebell computer tool: "+p.tool);
        client.respond(message.id,{contentItems:sharedToolResponseContent("trebell_computer",[{type:"inputText",text:JSON.stringify(result)}]),success:true});
      }catch(error){
        client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false});
      }
    })();
    return;
  }
  if(p.namespace==="trebell_source_control"){
    (async()=>{
      try{
        if(p.tool!=="link_pull_request")throw new Error("Unknown Trebell source-control tool: "+p.tool);
        if(!activeThread?.id)throw new Error("A Trebell thread must be open before linking a pull request.");
        const result=await linkPullRequestUrl(p.arguments?.url,"agent");
        client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify({linked:true,number:result?.link?.number,url:result?.link?.url})}],success:true});
      }catch(error){client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false})}
    })();
    return;
  }
  if(p.namespace==="trebell_repo"){
    (async()=>{
      try{
        if(!projectPath)throw new Error("A workspace must be open before querying repository intelligence.");
        const args=p.arguments||{},params=new URLSearchParams({path:projectPath});if(workspaceEnvironmentId)params.set("environmentId",workspaceEnvironmentId);
        let result;
        if(p.tool==="search_symbols"){params.set("q",String(args.query||""));if(args.limit!=null)params.set("limit",String(args.limit));result=await api("/api/context/symbols?"+params)}
        else if(p.tool==="file_relations"){params.set("file",String(args.path||""));result=await api("/api/context/relations?"+params)}
        else throw new Error("Unknown Trebell repository tool: "+p.tool);
        client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true});
      }catch(error){client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false})}
    })();
    return;
  }
  if(p.namespace==="trebell_delegate"){
    (async()=>{
      try{
        if(p.tool!=="delegate")throw new Error("Unknown Trebell delegation tool: "+p.tool);
        if(!runtimeCapabilities.delegation||!runtimeCapabilities.dynamicTools)throw new Error("The active runtime cannot invoke Trebell delegation tools.");
        const result=await delegateTask(p.arguments||{});
        client.respond(message.id,{contentItems:[{type:"inputText",text:JSON.stringify({
          started:true,parentThreadId:result.parentThreadId,threadId:result.thread?.id||null,turnId:result.turnId||null,
          cwd:result.workspace?.cwd||null,branch:result.workspace?.branch||null,isolation:result.spec?.isolation||null,permissions:result.spec?.permissions||null,model:result.spec?.model||null,budget:result.spec?.budget||null,
        })}],success:true});
      }catch(error){client.respond(message.id,{contentItems:[{type:"inputText",text:error.message||String(error)}],success:false})}
    })();
    return;
  }
  client.respond(message.id,{contentItems:[{type:"inputText",text:"No client-defined dynamic tool is registered for "+(p.namespace||"default")+"/"+p.tool}],success:false});
}

// An automatic repair or check runs as a new turn of the open thread: the window treats it as running from the moment the
// harness returns it (as App's startReview does), so the composer offers Stop with the "started" row, before turn/started arrives.
function adoptAutomaticTurn({activeThreadRef,setRunning,setActiveTurnId},threadId,started){
  const turn=started?.started?started.turn:null;
  if(turn?.id&&turn.status!=="completed"&&activeThreadRef.current?.id===threadId){setRunning(true);setActiveTurnId(turn.id)}
}
// verificationPlanFailed: App's own note of a plan that could not be made, also when this module could not load. The plan's row, and
// the row of a repair or check that could not start, are notices of the turn after its steps, on its card with them.
export async function planCompletedTurnEvidence(deps,threadId,turnId){
  const {activeThreadRef,rpcRef,setEvents,setContinuity,automaticVerificationRepairSeenRef,automaticVerificationContinuationSeenRef,verificationPlanFailed}=deps;
  if(!threadId||!turnId)return;
  try{
    const result=await requestTurnVerificationPlan({request:api,threadId,turnId});
    const event=verificationPlanEvent(result,turnId);
    if(event&&activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous.filter(item=>item.id!==event.id),event]);
    if(result?.record&&rpcRef.current){
      const refreshed=await rpcRef.current.request("thread/continuity/get",{threadId}).catch(()=>null);
      if(refreshed&&activeThreadRef.current?.id===threadId)setContinuity(refreshed.continuity||null);
    }
    if(result?.nextAction?.action==="repair"&&rpcRef.current){
      try{
        const repair=await maybeStartAutomaticVerificationRepair({rpc:rpcRef.current,threadId,result,seen:automaticVerificationRepairSeenRef.current});
        adoptAutomaticTurn(deps,threadId,repair);
        if(repair.started&&activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous.filter(item=>item.id!=="verification-auto-repair-"+repair.recordId),{id:"verification-auto-repair-"+repair.recordId,kind:"verification",title:"Automatic same-thread repair turn",status:"running",raw:{recordId:repair.recordId,turnId:repair.turn?.id||null}}]);
      }catch(error){
        if(activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous,{id:"verification-auto-repair-error-"+String(result.record?.id||turnId),kind:"error",title:"Automatic verification repair stopped: "+(error?.message||String(error)),status:"done",raw:{threadId,turnId,recordId:result.record?.id||null},turnId:String(turnId),notice:2}]);
      }
    }else if(result?.nextAction?.action==="verify"&&rpcRef.current){
      try{
        const continuation=await maybeStartAutomaticVerificationContinuation({rpc:rpcRef.current,threadId,result,seen:automaticVerificationContinuationSeenRef.current});
        adoptAutomaticTurn(deps,threadId,continuation);
        if(continuation.started&&activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous.filter(item=>item.id!=="verification-auto-continue-"+continuation.recordId+"-"+continuation.nextStepId),{id:"verification-auto-continue-"+continuation.recordId+"-"+continuation.nextStepId,kind:"verification",title:"Automatic same-thread check turn · "+continuation.nextStepId,status:"running",raw:{recordId:continuation.recordId,nextStepId:continuation.nextStepId,turnId:continuation.turn?.id||null}}]);
      }catch(error){
        if(activeThreadRef.current?.id===threadId)setEvents(previous=>[...previous,{id:"verification-auto-continue-error-"+String(result.record?.id||turnId),kind:"error",title:"Automatic verification continuation stopped: "+(error?.message||String(error)),status:"done",raw:{threadId,turnId,recordId:result.record?.id||null,nextStepId:result.nextAction?.nextStep?.id||null},turnId:String(turnId),notice:2}]);
      }
    }
  }catch(error){
    verificationPlanFailed(threadId,turnId,error);
  }
}

// The Codex turns a restart interrupted (recovery: /api/recovery's answer, which App reads on every connect and hands on only when it
// names turns to continue): each is continued unless it ended meanwhile. App itself tells the person of a turn that may already have
// done its work, which is left to them.
export async function continueInterruptedTurns({client,recovery,showActionError}){
  for(const item of recovery.items||[]){
    try{
      await client.request("thread/resume",{threadId:item.threadId,excludeTurns:true});
      let previous=null,recentError=null,legacyError=null;
      try{
        const recent=await client.request("thread/turns/list",{threadId:item.threadId,limit:20,sortDirection:"desc",itemsView:"notLoaded"});
        previous=(recent?.data||[]).find(turn=>turn.id===item.turnId)||null;
      }catch(error){recentError=error}
      if(!previous){
        try{
          const legacy=await client.request("thread/read",{threadId:item.threadId,includeTurns:true});
          previous=(legacy?.thread?.turns||[]).find(turn=>turn.id===item.turnId)||null;
        }catch(error){legacyError=error}
      }
      if(!previous){
        const detail=[recentError&&("recent turns: "+(recentError.message||String(recentError))),legacyError&&("thread read: "+(legacyError.message||String(legacyError)))].filter(Boolean).join(" · ");
        throw new Error("Could not verify the interrupted turn before restart continuation"+(detail?": "+detail:"."));
      }
      if(previous&&["completed","failed","cancelled","interrupted"].includes(previous.status)){
        try{await api("/api/recovery",{method:"POST",body:{threadId:item.threadId,action:"clear"}})}
        catch(error){showActionError(error,"Could not clear completed restart recovery")}
        continue;
      }
      await client.request("turn/start",{threadId:item.threadId,input:[],turnTrigger:"trebell-restart-continuation"});
    }catch(error){
      let markError=null;
      try{await api("/api/recovery",{method:"POST",body:{threadId:item.threadId,action:"failed",message:error.message||String(error)}})}
      catch(persistError){markError=persistError}
      if(markError)showActionError(new Error((error?.message||String(error))+" · Could not record restart recovery failure: "+(markError?.message||String(markError))),"Could not safely recover interrupted thread");
      else showActionError(error,"Could not safely recover interrupted thread");
    }
  }
}

// The first turn of a Codex goal asks for the work (codex-goal-start.mjs): Codex gets CODEX_GOAL_START before the objective, while the
// person's message, its checkpoint and the Goal panel keep the objective as written.
export { CODEX_GOAL_START };
// The running turn is a compaction of the thread's own, which a goal command never stops (T3 isNativeMaintenanceCommand: a run whose
// message is /compact): the one this window asked for (compactionWaiters), or a turn that shows nothing but a compaction (its rows in
// events are compactions alone, as turn-activity.js storeCompactionTurnIds reads a stored one, and messages hold no message, reply or
// thought of it) and that no active goal drives. A turn that compacts as it works, an ordinary turn or a goal's own (also one that
// opens with a compaction), is stopped as any other.
function compactionTurn({activeThread,activeTurnId,compactionWaiters,events=[],messages=[]},goalStatus){
  const turnId=String(activeTurnId??""),ofTurn=item=>turnId!==""&&String(item?.turnId??"")===turnId;
  if(compactionWaiters?.has(String(activeThread?.id||"")))return true;
  const rows=events.filter(ofTurn);
  return rows.length>0&&rows.every(row=>row.kind==="contextCompaction")&&!messages.some(ofTurn)&&goalStatus!=="active";
}
// A goal command that stops the turn running (T3 goalCommandStopsActiveRun) stops it as Stop does: an active goal is paused first,
// so Codex starts no further turn of it. waitForEnd: the command starts a turn, which waits for the stopped one's turn/completed,
// or 10 s, after which Codex says why should it refuse the start. A compaction of the thread's own (compacting) is not stopped: the
// command waits for its turn to end, up to a minute, as T3 queues it after the compaction.
async function stopForGoal({rpc,stop},threadId,{waitForEnd=false,compacting=false}={}){
  let off=()=>{},timer=null;
  const ended=waitForEnd?new Promise(resolve=>{timer=setTimeout(resolve,compacting?60_000:10_000);off=rpc.subscribeNotifications(message=>{if(message.method==="turn/completed"&&String(message.params?.threadId||"")===threadId)resolve()})}):null;
  try{if(!compacting)await stop();await ended}finally{off();clearTimeout(timer)}
}
// Codex /goal, run like T3 Code's runGoalCommand and the Codex TUI: /goal shows the goal, clear, pause and resume
// control it, and any other text sets a new goal and starts its first turn. A new goal or a resume sent while a turn runs stops that
// turn and starts once it has ended; clear and pause stop only a turn the goal drives (it is active); none stops a compaction of the
// thread's own (compactionTurn), whose end a goal's turn waits for. One that cannot run keeps the draft ("kept") and says why beside
// the composer, as /goal does on the other harnesses; a Codex without goals is said not to support them.
async function runCodexGoalCommand(deps,command){
  const {activeThread,running,goal,startTurn,attachments,model,contextChips,rpc,agentRuntimeLabel,setGoal,openRightPanel,setEvents,setComposerAlert}=deps;
  const threadId=activeThread?.id?String(activeThread.id):null;
  const note=(title,kind="tool")=>setEvents(prev=>[...prev,{id:"goal-command-"+Date.now()+"-"+Math.random().toString(36).slice(2,6),kind,title,status:"done",raw:{}}]);
  try{
    if(command?.type==="set"){
      if(running&&threadId)await stopForGoal(deps,threadId,{waitForEnd:true,compacting:compactionTurn(deps,goal?.status)});
      await startTurn(command.objective,attachments,model,null,null,repositoryFocusPaths(attachments,contextChips),{goalPatch:{objective:command.objective,status:"active"},inputText:CODEX_GOAL_START+command.objective});
      return;
    }
    if(!threadId||!rpc){note("No goal is set.");return}
    const current=(await rpc.request("thread/goal/get",{threadId}))?.goal||null;setGoal(current);
    const compacting=Boolean(running)&&compactionTurn(deps,current?.status),drives=running&&current?.status==="active"&&!compacting;
    if(command?.type==="clear"){if(drives)await stopForGoal(deps,threadId);const result=await rpc.request("thread/goal/clear",{threadId});setGoal(null);note(result?.cleared?"Goal cleared.":"No goal to clear.");return}
    if(!current){note("No goal is set.");return}
    if(command?.type==="pause"){if(drives)await stopForGoal(deps,threadId);const paused=await rpc.request("thread/goal/set",{threadId,status:"paused"});setGoal(paused?.goal||null);note("Goal paused. Send /goal resume to continue.");return}
    if(command?.type==="resume"){
      // A turn without new input continues the goal from the history.
      if(running)await stopForGoal(deps,threadId,{waitForEnd:true,compacting});
      await startTurn("",[],model,null,null,null,{goalPatch:{status:"active"},goalResume:true});
      return;
    }
    openRightPanel("goal");note(describeCodexGoal(current));
  }catch(error){
    // A Stop before the goal's first turn started keeps the draft with no note, as a send does (dispatchSend). A request Codex has not
    // answered may still go through, and a new goal whose first turn did not start stays set (paused): each is said as it is.
    if(error?.trebellSendStopped)return "kept";
    const reason=codexGoalsMissing(error)?"this Codex does not support goals.":sentenceText(error.message||String(error));
    setComposerAlert({kind:"send",text:error?.rpcTimedOut&&error.trebellGoalSet?agentRuntimeLabel+" has not answered the send, so it may still start. Your draft is kept; check the conversation before sending it again."
      :error?.rpcTimedOut&&command.type!=="show"?agentRuntimeLabel+" has not answered, so the goal may still change. Your draft is kept; check the Goal panel before sending it again."
      :(command.type==="set"&&error?.trebellGoalSet?"The goal is set, but its first turn did not start: ":"Could not "+command.type+" the goal: ")+reason+" Your draft is kept."});
    return "kept";
  }
}
// A send that is a command rather than a message to the agent (App asks whenever a send starts with "/"): a project's recipe by its
// name, or one of the composer's commands. It answers true when the command ran (the composer empties), "kept" when the composer
// keeps what it holds, and false for text that names no command, which App then sends as a message.
export async function runSlashCommand(deps,text){
  const {currentProject,projectPath,workspaceEnvironmentId,permissionMode,setPermissionMode,agentRuntime,agentRuntimeLabel,models,model,attachments,contextChips,runtimeCapabilities,rpc,activeThread,activeThreadRef,startTurn,compactContext,startReview,runUserAction,newChat,openRightPanel,openProviderSettings,setPanel,setPaletteOpen,setPrompt,setGoal,setEvents,setComposerAlert}=deps;
  const [command,...rest]=text.split(/\s+/);
  const recipe=(currentProject?.recipes||[]).find(item=>item.name===command);
  if(recipe){
    try{
      const resolved=await api("/api/project-recipe/resolve",{method:"POST",body:{path:projectPath,environmentId:workspaceEnvironmentId,recipe:recipe.id||recipe.name,input:rest.join(" "),currentPermission:permissionMode,runtime:agentRuntime}});
      const execution=resolved.execution;if(!execution)throw new Error("Recipe could not be resolved");
      if(execution.model&&!models.includes(execution.model))throw new Error(`Recipe ${recipe.name} requires model ${execution.model}, which is not available in the active runtime.`);
      // Its message shows in the conversation while an automatic compaction runs before it (pending): the composer let it go already.
      await startTurn(execution.turnInput,attachments,execution.model||model,null,null,repositoryFocusPaths(attachments,contextChips),{
        permissionModeOverride:execution.permissionMode,
        additionalContext:{"trebell.recipe":{kind:"application",value:execution.context}},
        goalPatch:execution.goalPatch,
        toolAllowlist:execution.toolAllowlist,
        pending:true,
      });
      if(execution.permissionMode&&execution.permissionMode!==permissionMode)setPermissionMode(execution.permissionMode);
      setEvents(prev=>[...prev,{id:"recipe-"+Date.now(),kind:"tool",title:`Started project recipe ${recipe.name}`,status:"done",raw:{recipe:recipe.name,permissionMode:execution.permissionMode,model:execution.model||model,maxChildren:execution.goalPatch?.childAgentBudget??null}}]);
    }catch(error){setEvents(prev=>[...prev,{id:"recipe-error-"+Date.now(),kind:"error",title:`Could not run ${recipe.name}: ${error.message||String(error)}`,status:"done",raw:{}}])}
    return true;
  }
  if(command==="/compact"){
    await compactContext();return true
  }
  if(command==="/ps"){
    if(runtimeCapabilities.backgroundProcesses&&activeThread?.id)openRightPanel("runtime");
    else setEvents(prev=>[...prev,{id:"ps-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose background process controls`,status:"done",raw:{}}]);
    return true
  }
  if(command==="/stop"){
    if(!runtimeCapabilities.backgroundProcesses||!activeThread?.id||!rpc){setEvents(prev=>[...prev,{id:"stop-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose background process controls`,status:"done",raw:{}}]);return true}
    try{await rpc.request("thread/backgroundTerminals/clean",{threadId:activeThread.id});setEvents(prev=>[...prev,{id:"background-stop-"+Date.now(),kind:"tool",title:"Stopped agent background processes",status:"done",raw:{}}])}
    catch(error){setEvents(prev=>[...prev,{id:"background-stop-error-"+Date.now(),kind:"error",title:"Could not stop background processes: "+(error.message||String(error)),status:"done",raw:{}}])}
    return true
  }
  if(command==="/model"){openProviderSettings();return true}
  if(command==="/terminal"){setPanel("terminal");return true}
  if(command==="/diff"){openRightPanel("diff");return true}
  if(command==="/git"){openRightPanel("source");return true}
  if(command==="/preview"){openRightPanel("preview");return true}
  if(command==="/agents"){if(runtimeCapabilities.delegation)openRightPanel("agents");else setEvents(prev=>[...prev,{id:"agents-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose delegated-agent controls`,status:"done",raw:{}}]);return true}
  // /review is the header's Review, and a review that does not start says why the same way.
  if(command==="/review"){await runUserAction(startReview,"Could not start review");return true}
  if(command==="/feedback"){
    if(agentRuntime!=="codex"||!activeThread?.id||!rpc){setEvents(prev=>[...prev,{id:"feedback-unavailable-"+Date.now(),kind:"error",title:"Codex feedback requires an existing Codex thread",status:"done",raw:{}}]);return true}
    try{
      const result=await rpc.request("feedback/upload",{classification:"bug",reason:rest.join(" ").trim()||null,threadId:activeThread.id,includeLogs:true});
      setEvents(prev=>[...prev,{id:"feedback-"+Date.now(),kind:"tool",title:`Feedback uploaded${result?.threadId?` · ${result.threadId}`:""}`,status:"done",raw:result||{}}]);
    }catch(error){setEvents(prev=>[...prev,{id:"feedback-error-"+Date.now(),kind:"error",title:"Feedback upload failed: "+(error.message||String(error)),status:"done",raw:{}}])}
    return true;
  }
  if(command==="/goal"){
    const goalCommand=parseCodexGoalCommand(text);
    if(agentRuntime==="codex")return await runCodexGoalCommand(deps,goalCommand)||true;
    // Elsewhere /goal opens the thread's goal: pause, resume and clear change it as the Goal panel's buttons do, and any other text
    // after it is the objective it sets. A goal is kept with a thread, so on New task the draft stays ("kept") and the composer says why.
    const threadId=activeThread?.id,patch=goalCommand.type==="set"?{objective:goalCommand.objective,status:"active"}:goalCommand.type==="pause"?{status:"paused"}:goalCommand.type==="resume"?{status:"active"}:null;
    if(!threadId){setComposerAlert({kind:"send",text:"A goal belongs to a thread. Send a first message to start one, then set its goal. Your draft is kept."});return "kept"}
    if(patch||goalCommand.type==="clear"){
      try{if(!rpc)throw new Error(agentRuntimeLabel+" is not connected yet");const result=await rpc.request(patch?"thread/goal/set":"thread/goal/clear",{threadId,...patch});if(activeThreadRef.current?.id===threadId)setGoal(patch&&result?.goal||null)}
      catch(error){setComposerAlert({kind:"send",text:"Could not "+goalCommand.type+" the goal: "+sentenceText(error?.message||String(error))+" Your draft is kept."});return "kept"}
    }
    openRightPanel("goal");return true;
  }
  if(command==="/palette"){setPaletteOpen(true);return true}
  if(command==="/new"){await newChat();return true}
  if(command==="/clear"){await newChat();return true}
  // /plan fills the composer with the plan prompt to send, which the composer keeps ("kept").
  if(command==="/plan"){setPrompt("Create a clear execution plan, then carry it out. "+rest.join(" "));return "kept"}
  return false;
}

async function monitorWorktreeSetup({setWorktreeSetup},sessionId,{timeoutMs=30*60_000}={}){
  const started=Date.now();let consecutiveErrors=0;
  while(Date.now()-started<timeoutMs){
    let data;
    try{data=await api("/api/terminal/sessions");consecutiveErrors=0}
    catch(error){
      consecutiveErrors++;
      if(consecutiveErrors>=3){
        const failure=new Error("Could not monitor worktree setup: "+(error?.message||String(error)));
        setWorktreeSetup(prev=>prev?.sessionId===sessionId?{...prev,phase:"failed",detail:failure.message}:prev);
        throw failure;
      }
      await new Promise(resolve=>setTimeout(resolve,700));continue;
    }
    const session=(data.sessions||[]).find(item=>item.id===sessionId);
    if(session&&!session.running){
      const failed=session.exitCode!==0;
      setWorktreeSetup(prev=>prev?.sessionId===sessionId?{...prev,phase:failed?"failed":"done",detail:failed?`Setup exited with code ${session.exitCode??"unknown"}`:"Setup completed",exitCode:session.exitCode}:prev);
      return {exitCode:session.exitCode};
    }
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  setWorktreeSetup(prev=>prev?.sessionId===sessionId?{...prev,phase:"failed",detail:"Setup is still running after 30 minutes."}:prev);
  return {timeout:true,exitCode:null};
}
async function waitForDetachedSetup(sessionId,{timeoutMs=30*60_000}={}){
  const started=Date.now();let consecutiveErrors=0;
  while(Date.now()-started<timeoutMs){
    let data;
    try{data=await api("/api/terminal/sessions");consecutiveErrors=0}
    catch(error){
      consecutiveErrors++;
      if(consecutiveErrors>=3)throw new Error("Could not monitor background worktree setup: "+(error?.message||String(error)));
      await new Promise(resolve=>setTimeout(resolve,700));continue;
    }
    const session=(data.sessions||[]).find(item=>item.id===sessionId);
    if(session&&!session.running)return {exitCode:session.exitCode};
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  return {timeout:true,exitCode:null};
}

// A send's new worktree (App asks for one only in New worktree mode). owns: whether the view that asked for the worktree is still
// shown. One left meanwhile gets no worktree card, project or terminal of this worktree; the worktree is still made for the send.
// pressed: the presses counted at the send's press, as of which the setup terminal asks for the keyboard as it opens the drawer, once
// the worktree is made, so a menu opened or a key pressed meanwhile keeps the keyboard where it went (terminal-keyboard.js).
// worktreeCardErrors: the failures the worktree setup card already shows (the activity list does not repeat them).
export async function prepareWorktree(deps,basePath,modelId,{owns=null,pressed}={}){
  const {setWorktreeSetup,touchProject,setPanel,showActionError,worktreeCardErrors}=deps;
  const card=next=>{if(!owns||owns())setWorktreeSetup(next)};
  const info=await api("/api/git/info?path="+encodeURIComponent(basePath));
  if(!info.isGit)throw new Error("New worktree mode requires a Git project.");
  const slug=String(modelId||"model").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(-24)||"agent";
  const stamp=Date.now().toString(36);
  const branch="trebell/"+slug+"-"+stamp;
  const path=info.root+"-trebell-"+slug+"-"+stamp;
  card({phase:"creating",branch,path,scriptName:null,sessionId:null,detail:"Creating an isolated Git worktree"});
  try{
    const response=await api("/api/git/action",{method:"POST",body:{action:"worktree-create",cwd:info.root,branch,path,baseBranch:info.branch}});
    const worktree=response.result?.worktree||path;
    await touchProject(worktree,undefined,{owns});
    const setup=response.result?.setup||null;
    if(setup?.session?.id){
      card({
        phase:"running",
        branch,
        path:worktree,
        scriptName:setup.scriptName||"Setup",
        sessionId:setup.session.id,
        waitForSetup:Boolean(setup.waitForSetup),
        detail:setup.waitForSetup?"Agent will start after setup completes":"Setup is running in the background",
      });
      if(!owns||owns()){askTerminalKeyboard(pressed);setPanel("terminal");setTimeout(()=>window.dispatchEvent(new CustomEvent("trebell:terminal-refresh",{detail:setup.session.id})),0)}
      const completion=monitorWorktreeSetup(deps,setup.session.id);
      if(setup.waitForSetup){
        const settled=await completion;
        if(settled.timeout)throw new Error("Worktree setup is still running after 30 minutes. The agent was not started.");
        if(settled.exitCode!==0)throw new Error(`Worktree setup failed with exit code ${settled.exitCode??"unknown"}. Fix the setup terminal, then retry.`);
      }else{
        completion.then(settled=>{
          if(settled.timeout)throw new Error("Background worktree setup is still running after 30 minutes.");
          if(settled.exitCode!==0)throw new Error(`Background worktree setup failed with exit code ${settled.exitCode??"unknown"}.`);
          setWorktreeSetup(current=>current?.sessionId===setup.session.id?{...current,phase:"done",detail:"Setup completed"}:current);
        }).catch(error=>{
          setWorktreeSetup(current=>current?.sessionId===setup.session.id?{...current,phase:"failed",detail:error?.message||String(error)}:current);
          showActionError(error,"Background worktree setup needs attention");
        });
      }
    }else{
      card({phase:"done",branch,path:worktree,scriptName:null,sessionId:null,detail:"Worktree created"});
    }
    return worktree;
  }catch(error){
    card(prev=>({...prev,phase:"failed",detail:error.message||String(error)}));
    if(error&&typeof error==="object")worktreeCardErrors.add(error);
    throw error;
  }
}
// A background send's worktree (App asks for one in New worktree mode, and always for a multi-model send).
export async function prepareDetachedWorktree({showActionError},basePath,modelId,{environmentId=null}={}){
  const infoParams=new URLSearchParams({path:String(basePath)});if(environmentId)infoParams.set("environmentId",environmentId);
  const info=await api("/api/git/info?"+infoParams);if(!info.isGit)throw new Error("Background worktree mode requires a Git project.");if(!info.branch)throw new Error("Background worktrees require a checked-out base branch; detached HEAD is not supported.");
  const slug=String(modelId||"model").replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(-24)||"agent";const stamp=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  const branch="trebell/"+slug+"-"+stamp;const path=info.root+"-trebell-"+slug+"-"+stamp;
  const response=await api("/api/git/action",{method:"POST",body:{action:"worktree-create",cwd:info.root,branch,path,baseBranch:info.branch,environmentId:environmentId||null}});const worktree=response.result?.worktree||path;
  try{await api("/api/projects",{method:"POST",body:{path:worktree,environmentId:environmentId||null}})}
  catch(error){showActionError(error,"Could not register background worktree")}
  const setup=response.result?.setup||null;
  if(setup?.session?.id&&setup.waitForSetup){const settled=await waitForDetachedSetup(setup.session.id);if(settled.timeout)throw new Error("Background worktree setup is still running after 30 minutes.");if(settled.exitCode!==0)throw new Error(`Background worktree setup failed with exit code ${settled.exitCode??"unknown"}.`)}
  return worktree;
}

// The repository context a send carries, asked for while the send makes its file checkpoint (App checks first that the thread has a
// project and a workspace). contextUnavailable: App's own note of a packet that could not be made, also when this module could not load.
export async function prepareTurnContext(deps,thread,cwd,text,paths,{background=false,ignoreUsage=false,ready=true}={}){
  const {agentRuntime,activeThread,tokenUsage,threadMeta,workspaceEnvironmentId,threadTelemetryRef,contextTaskRef,updateThreadMeta,showActionError,setEvents,contextUnavailable}=deps;
  const usage=ignoreUsage?null:(threadTelemetryRef.current[thread.id]?.tokenUsage||(activeThread?.id===thread.id?tokenUsage:null));
  const previousTask=contextTaskRef.current.get(thread.id)||threadMeta[thread.id]?.trebellContext?.continuityTask||threadMeta[thread.id]?.trebellContext?.userTask||threadMeta[thread.id]?.trebellContext?.task||"";
  const contextTask=contextTaskText(text,previousTask);
  const continuityTask=contextTaskAnchor(text,previousTask);
  try{
    const request=api("/api/context/packet",{method:"POST",body:{
      path:cwd,task:contextTask,focusPaths:paths||[],environmentId:workspaceEnvironmentId||null,
      tokensUsed:usage?.last?.inputTokens??null,contextWindow:usage?.modelContextWindow??null,
      deliveryProjection:agentRuntime==="native"?"seed":null,userTask:String(text||""),
    }});request.catch(()=>{});
    // A send asks for the packet while it makes its file checkpoint and uses it once the send gets here (ready): the packet's
    // notice still follows the checkpoint's, and a send that fails before then (ready false) leaves no trace of it.
    if(!await ready)return null;
    const packet=await request;
    if(packet.skipped){
      const pressure={...(packet.budget||{}),at:Date.now(),skipped:true};
      try{await updateThreadMeta(thread.id,{trebellContextPressure:pressure,trebellContextError:null},{strict:true})}
      catch(error){showActionError(error,"Repository context was skipped but its inspector state could not be saved")}
      if(!background)setEvents(prev=>[...prev,{id:"context-pressure-"+packet.id,kind:"context",title:"Trebell context skipped · preserving "+Number(pressure.reserveTokens||0).toLocaleString()+" tokens for the response",status:"done",raw:{contextId:packet.id,budget:packet.budget}}]);
      return packet;
    }
    const deliveredPacket=repositoryContextDeliveryPacket(packet,{seedOnly:agentRuntime==="native"});
    const stored={...deliveredPacket,userTask:String(text||""),queryTask:contextTask,continuityTask,runtime:agentRuntime,delivery:agentRuntime==="codex"?"additionalContext":"promptPreamble"};
    try{await updateThreadMeta(thread.id,{trebellContext:stored,trebellContextError:null,trebellContextPressure:null},{strict:true})}
    catch(error){showActionError(error,"Repository context was injected but its inspector state could not be saved")}
    contextTaskRef.current.set(thread.id,continuityTask);
    if(!background)setEvents(prev=>[...prev,{id:"context-"+deliveredPacket.id,kind:"context",title:`Trebell context · ${deliveredPacket.items?.length||0} file${(deliveredPacket.items?.length||0)===1?"":"s"} · ~${deliveredPacket.tokenEstimate||0} tokens`,status:"done",raw:{contextId:deliveredPacket.id,items:deliveredPacket.items?.length||0,tokenEstimate:deliveredPacket.tokenEstimate||0}}]);
    return deliveredPacket;
  }catch(error){
    return contextUnavailable(thread,error,{background});
  }
}

// The compaction a send runs first, once the thread's context is as full as the automatic compaction setting waits for (App checks
// first that the harness compacts and is connected). The send waits for it to end, as long as its harness takes, with the row App
// shows while it runs (requestThreadCompaction). One that failed, or that the person stopped with the header's Stop, leaves the
// context as it was, and the message goes on with a row saying why, as Grok's stopped one does: stopping it ends the compaction, not
// the message waiting for it. One the window stopped waiting for says so, as a compaction whose end is not known (status unknown),
// and the compaction's own end, should it come, takes that row (thread/compacted). held: the composer's message, which no queue
// holds: it waits meanwhile in its thread's queue as being sent, held by this window (heldBy: windowKey; heldUntil: holdMs from now),
// whose card says what it waits for. The window renews its hold a quarter of holdMs apart while it waits, so a window closed or lost
// meanwhile holds the message no longer once holdMs has passed since it last did. That shows it; another window that opens the
// thread meanwhile shows it as on its way there, and a window that opens the thread again, or is reloaded or closed meanwhile, keeps
// it for the person to send (persistent-queue.js hydratePersistedQueue, heldElsewhere). It leaves the queue before the send goes on,
// never after its turn may have started, and after a renewal still on its way, which would put it back. A message with no draft of
// the composer's (a project's recipe) shows as on its way meanwhile (onWait: its message in the conversation). compacted: the context
// is compacted; row: the turn's row saying how the compaction went.
export async function compactBeforeTurn(deps,thread,held,onWait=null){
  const {activeThread,tokenUsage,threadTelemetryRef,settings,requestThreadCompaction,updateThreadTelemetry,activeThreadRef,setTokenUsage,localQueueStartRef,windowKey,holdMs,persistLocalQueue,queueNow}=deps;
  const usage=threadTelemetryRef.current[thread.id]?.tokenUsage||(activeThread?.id===thread.id?tokenUsage:null);
  const decision=autoCompactionDecision(usage,{enabled:settings.autoCompactContext===true,thresholdPercent:settings.autoCompactThresholdPercent??85});
  if(!decision.shouldCompact)return {};
  const row=patch=>({id:"auto-compact-"+thread.id,kind:"contextCompaction",title:"Context compacted automatically before this turn",status:"done",raw:decision,...patch});
  const now=Date.now(),kept=held&&{...held,id:crypto.randomUUID(),createdAt:now,dispatchingAt:now,heldBy:windowKey,heldUntil:now+holdMs},onItsWay=localQueueStartRef.current;
  if(kept){onItsWay.add(kept.id);await persistLocalQueue(thread.id,[...queueNow(thread.id),kept]).catch(()=>{})}
  else onWait?.();
  let renewed=Promise.resolve();
  const renew=kept&&setInterval(()=>{renewed=renewed.then(()=>{const items=queueNow(thread.id);if(items.some(item=>item.id===kept.id))return persistLocalQueue(thread.id,items.map(item=>item.id===kept.id?{...item,heldUntil:Date.now()+holdMs}:item))}).catch(()=>{})},holdMs/4);
  try{
    await requestThreadCompaction(thread.id);
    updateThreadTelemetry(thread.id,{tokenUsage:null,lastActivityAt:Date.now()});
    if(activeThreadRef.current?.id===thread.id)setTokenUsage(null);
    return {compacted:true,row:row()};
  }catch(error){
    const message=error?.message||String(error);
    return {compacted:false,row:row(error?.waited?{status:"unknown",title:message,waited:true}:{kind:"error",title:"Automatic context compaction failed; continuing: "+message})};
  }finally{if(kept){clearInterval(renew);await renewed;await persistLocalQueue(thread.id,queueNow(thread.id).filter(item=>item.id!==kept.id)).catch(()=>{});onItsWay.delete(kept.id)}}
}

// Work sent to run apart from the open thread: a send in the background, one task sent to several models at once (each in a worktree
// of its own) and a task the agent delegates (thread/delegate). Each starts only once the person sends it (the composer's background
// send, a send with several models picked, the Agents page or the agent's own delegation tool), so App loads it with this module at
// idle after the first paint (B11); a send made before then waits for it.
const contextEntriesOf=(packet,options)=>packet?repositoryContextEntries(packet,options):{};
// checked: the send checked its files a moment ago (a background send, a fan-out), which extracted their text: this check only finds it.
export async function startDetachedTurn(deps,text,paths,modelId=deps.model,{forceWorktree=false,basePath=null,projectless=deps.projectlessMode,focusPaths=null,checked=false}={}){
  const {agentRuntime,assertTurnModel,backgroundThreadsRef,bootstrap,codexChoicesFor,contextChips,createThreadFor,inputsFor,loadSharedToolCatalog,markThreadTurn,modelMeta,permissionMode,prepareDetachedWorktree,prepareTurnContext,presetFor,projectPath,provider,providerAgent,reportCheckpointIssue,rpc,rpcStatus,selectedCollaborationMode,setThreads,settings,turnStillRuns,validateAttachmentPaths,workspaceEnvironmentId}=deps;
  assertTurnModel(modelId);
  await validateAttachmentPaths(paths||[],{extract:!checked});if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");
  let cwd=basePath||projectPath||bootstrap.cwd;if(!cwd)throw new Error(projectless?"Could not prepare the General chat workspace.":"Choose a project before starting background work.");
  // Trebell's tool catalog comes before the worktree, so a task that cannot start for want of it leaves no worktree behind.
  await loadSharedToolCatalog();
  if(!projectless)cwd=await prepareDetachedWorktree(cwd,modelId,{force:forceWorktree,environmentId:workspaceEnvironmentId});
  let thread=null;let turnRequestStarted=false;
  try{
    thread=await createThreadFor(modelId,cwd,{projectless,taskText:text});if(!thread?.id)throw new Error("Agent harness did not create a background thread");
    backgroundThreadsRef.current.add(thread.id);setThreads(prev=>[thread,...prev.filter(item=>item.id!==thread.id)]);
    // The context packet only reads files, so it is built while the checkpoint is made.
    const contextReady=prepareTurnContext(thread,cwd,text,focusPaths||repositoryFocusPaths(paths,contextChips),{projectless,background:true});
    let checkpoint=null;
    if(!projectless){
      try{checkpoint=await api("/api/checkpoints",{method:"POST",body:{cwd,threadId:thread.id,label:text.slice(0,80)}})}
      catch(error){reportCheckpointIssue("Could not create background file checkpoint; file restore for this turn is unavailable",error,{threadId:thread.id,cwd})}
    }
    const p=presetFor(permissionMode);
    const sandboxPolicy=p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:{type:"workspaceWrite",writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
    const reasoningEffort=configuredReasoningEffort(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{});
    const serviceTier=configuredModelServiceTier(settings,agentRuntime,provider,modelId);
    turnRequestStarted=true;
    const codexChoices=agentRuntime==="codex"?codexChoicesFor(modelId,thread.id):null,collaboration=selectedCollaborationMode(modelId,{effort:codexChoices?.effort||null});
    const contextPacket=await contextReady,contextEntries=contextEntriesOf(contextPacket,agentRuntime==="native"?nativeTurnContextOptions(text):{seedOnly:false,currentTask:text});
    const result=await rpc.request("turn/start",{threadId:thread.id,model:modelId,...(agentRuntime==="native"?{modelProvider:provider,...(reasoningEffort?{reasoningEffort}:{}),...(serviceTier?{serviceTier}:{})}:{}),cwd,...(agentRuntime!=="codex"?{agent:providerAgent||null}:{}),...(codexChoices?.effort?{effort:codexChoices.effort}:{}),...(codexChoices?.serviceTier?{serviceTier:codexChoices.serviceTier}:{}),...harnessTurnOptions(agentRuntime,{permissionMode,reasoningEffort,serviceTier,modelOptions:configuredModelOptions(settings,agentRuntime,provider,modelId,modelMeta?.[modelId]||{})}),...(collaboration?{collaborationMode:collaboration}:{}),approvalPolicy:p.approvalPolicy,sandboxPolicy,input:inputsFor(text,paths),...(Object.keys(contextEntries).length?{additionalContext:contextEntries}:{})});const turnId=result?.turn?.id||null;
    // The sidebar row shows the task running even when the harness sends no turn/started for a thread that is not open.
    if(turnId&&turnStillRuns(result.turn))markThreadTurn(thread.id,true);
    if(checkpoint?.id&&turnId)try{await api("/api/checkpoints/link",{method:"POST",body:{id:checkpoint.id,patch:{turnId}}})}catch(error){reportCheckpointIssue("Background file checkpoint was created but could not be linked to its turn; restore may be unavailable after reload",error,{threadId:thread.id,turnId,checkpointId:checkpoint.id})}
    return {thread,turnId,cwd};
  }catch(error){
    const mayHaveSucceeded=!error?.trebellRpcResponse;
    let uncertainThread=thread;const verificationErrors=[];
    if(mayHaveSucceeded&&!uncertainThread?.id){
      for(let attempt=0;attempt<3&&!uncertainThread;attempt++){
        if(attempt)await new Promise(resolve=>setTimeout(resolve,250));
        try{
          const listed=await rpc.request("thread/list",threadListParams(100));
          uncertainThread=threadForWorktree(listed.data||[],cwd);
        }catch(listError){verificationErrors.push(listError)}
      }
      if(uncertainThread?.id){backgroundThreadsRef.current.add(uncertainThread.id);setThreads(prev=>[uncertainThread,...prev.filter(item=>item.id!==uncertainThread.id)])}
    }
    const failure=error instanceof Error?error:new Error(String(error));
    if(mayHaveSucceeded&&(uncertainThread?.id||turnRequestStarted||verificationErrors.length))failure.trebellUncertain={threadId:uncertainThread?.id||null,cwd,model:modelId,phase:turnRequestStarted?"turn":"thread",verificationError:verificationErrors.at(-1)?.message||null};
    throw failure;
  }
}
export async function delegateTask(deps,rawSpec){
  const {activeThreadRef,backgroundThreadsRef,models,rpc,rpcStatus,setGoal,setThreadMeta,setThreads}=deps;
  if(!rpc||rpcStatus!=="connected")throw new Error("Agent harness is not connected");
  const parent=activeThreadRef.current;if(!parent?.id)throw new Error("Open a parent thread before delegating work.");
  if(rawSpec?.model&&!models.includes(rawSpec.model))throw new Error("Delegation model is not available in the active runtime: "+rawSpec.model);
  const result=await rpc.request("thread/delegate",{threadId:parent.id,...rawSpec});
  if(result?.thread?.id){
    backgroundThreadsRef.current.add(result.thread.id);
    setThreads(previous=>[result.thread,...previous.filter(item=>item.id!==result.thread.id)]);
    const meta=await api("/api/thread-meta?threadId="+encodeURIComponent(result.thread.id)).catch(()=>null);
    if(meta)setThreadMeta(previous=>({...previous,[result.thread.id]:meta}));
  }
  try{
    const refreshed=(await rpc.request("thread/goal/get",{threadId:parent.id}))?.goal||null;
    if(activeThreadRef.current?.id===parent.id)setGoal(refreshed);
  }catch{}
  return result;
}
async function saveFailureStash(draft){
  try{await api("/api/stashes",{method:"POST",body:draft});return{ok:true,error:""}}
  catch(error){return{ok:false,error:error?.message||String(error)||"Unknown stash error"}}
}
// A fan-out that cannot start keeps the draft ("kept"): the composer gives it back (dispatchSend), or still holds it (sendInBackground).
export async function sendModelFanout(deps,text){
  const {activeThread,agentRuntimeLabel,attachments,bootstrap,contextChips,desktopNotify,dropSentDraft,gitInfo,maxComposerChars,models,projectPath,prompt,resetAssistantStream,restoreFailedDraft,running,runtimeCapabilities,selectedModels,setEvents,setPromptHistoryIndex,setSection,showActionError,validateAttachmentPaths}=deps;
  const fanout=[...new Set(selectedModels.filter(id=>models.includes(id)))];if(activeThread?.id||running||fanout.length<2)return false;
  if(!runtimeCapabilities.multiModelFanout)return false;
  const workspaceError=fanoutWorkspaceError(gitInfo);if(workspaceError){setEvents(prev=>[...prev,{id:"fanout-workspace-"+Date.now(),kind:"error",title:workspaceError,status:"done",raw:{}}]);return "kept"}
  if(prompt.length>maxComposerChars){setEvents(prev=>[...prev,{id:"fanout-long-"+Date.now(),kind:"error",title:`Message exceeds the ${maxComposerChars.toLocaleString()} character limit`,status:"done",raw:{}}]);return "kept"}
  if(runtimeCapabilities.videoAttachments===false&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"fanout-video-"+Date.now(),kind:"error",title:agentRuntimeLabel+" does not accept video attachments",status:"done",raw:{}}]);return "kept"}
  try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"fanout-attachment-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return "kept"}
  const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd};
  // Its text left the composer as the send started (dispatchSend), or leaves it once the fan-out has launched (sendInBackground); its
  // files and context leave it now, and what was added meanwhile stays.
  setPromptHistoryIndex(-1);dropSentDraft(draft);setEvents([]);resetAssistantStream();setSection("chat");
  const launches=fanout.map(modelId=>startDetachedTurn(deps,draft.text,draft.attachments,modelId,{forceWorktree:true,basePath:draft.projectPath,focusPaths:repositoryFocusPaths(draft.attachments,draft.contextChips),checked:true}).then(result=>({ok:true,modelId,result})).catch(error=>({ok:false,modelId,error})));
  // What came of each launch is told once all have answered, by background-send-outcome.js, which loads then: should it not load,
  // the draft of a launch that failed goes back to the composer.
  Promise.all(launches).then(results=>import("./background-send-outcome.js").then(({settleModelFanout})=>settleModelFanout({results,fanout,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents:added=>setEvents(prev=>[...prev,...added])}),error=>{if(results.some(item=>!item.ok))restoreFailedDraft(draft);showActionError(error,"Could not show how the multi-model run went")}));
  return true;
}
export async function sendInBackground(deps,promptOverride=null){
  const {activeThread,agentRuntimeLabel,attachments,bootstrap,contextChips,desktopNotify,maxComposerChars,model,modelsRef,projectPath,projectlessMode,prompt,resetAssistantStream,restoreFailedDraft,rpc,rpcStatus,running,runtimeCapabilities,runtimeSwitchRef,send,setAttachments,setContextChips,setEvents,setPrompt,setPromptHistoryIndex,setSection,showActionError,validateAttachmentPaths,waitForActiveClone}=deps;
  if(!runtimeCapabilities.detachedTasks){await send(promptOverride);return}
  if(activeThread?.id||running||runtimeSwitchRef.current){await send(promptOverride);return}
  const visiblePrompt=promptOverride==null?prompt:String(promptOverride),text=visiblePrompt.trim();if(!text)return;
  if(visiblePrompt.length>maxComposerChars){setEvents(prev=>[...prev,{id:"prompt-too-long-"+Date.now(),kind:"error",title:`Message exceeds the ${maxComposerChars.toLocaleString()} character limit`,status:"done",raw:{length:visiblePrompt.length}}]);return}
  if(text.startsWith("/")){await send(promptOverride);return}
  try{await waitForActiveClone()}catch(error){setEvents(prev=>[...prev,{id:"clone-wait-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
  // A fan-out that has launched takes the text it sent out of the composer, as Enter and Send take a draft out as its send starts
  // (dispatchSend): what the person typed on after it while the fan-out waited for a clone or checked its files stays there, for the
  // next message. The text stayed, and a second Enter launched the same fan-out again. One that cannot start ("kept") leaves it.
  const fanned=await sendModelFanout(deps,text);if(fanned){if(fanned===true)setPrompt(current=>current.startsWith(visiblePrompt)?current.slice(visiblePrompt.length).replace(/^\s+/,""):current);return}
  if(bootstrap.mock||!rpc||rpcStatus!=="connected"||runtimeSwitchRef.current||!modelsRef.current.includes(model)){await send(promptOverride);return}
  if(runtimeCapabilities.videoAttachments===false&&attachments.some(isVideoAttachment)){setEvents(prev=>[...prev,{id:"video-unsupported-"+Date.now(),kind:"error",title:agentRuntimeLabel+" does not accept video attachments",status:"done",raw:{}}]);return}
  try{await validateAttachmentPaths(attachments)}catch(error){setEvents(prev=>[...prev,{id:"background-attachment-error-"+Date.now(),kind:"error",title:error.message,status:"done",raw:{}}]);return}
  const draft={text,attachments:[...attachments],contextChips:[...contextChips],projectPath:projectPath||bootstrap.cwd,model,projectless:projectlessMode};
  setPrompt("");setPromptHistoryIndex(-1);setAttachments([]);setContextChips([]);setEvents([]);resetAssistantStream();setSection("chat");
  // A launch that fails is told by background-send-outcome.js, which loads then: should it not load, the draft goes back to the
  // composer.
  startDetachedTurn(deps,draft.text,draft.attachments,draft.model,{basePath:draft.projectPath,projectless:draft.projectless,focusPaths:repositoryFocusPaths(draft.attachments,draft.contextChips),checked:true}).catch(error=>import("./background-send-outcome.js").then(({settleFailedBackgroundSend})=>settleFailedBackgroundSend({error,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents:added=>setEvents(prev=>[...prev,...added])}),()=>{restoreFailedDraft(draft);showActionError(error,"Background task failed")}));
}

// A desktop SnapShot (window.trebellDesktop.snapshots) goes to the composer: its image, and the window's accessibility text when it
// has some, each a file with its chip, and the capture is acknowledged once they are there. One comes only once the person takes a
// SnapShot (or one waits as the window opens), so App loads this with this module at idle after the first paint (B11): a capture
// before then waits for it, and one that cannot load it says so, as a capture that fails does, and stays pending.
export async function attachSnapshot({snapshots,prepareAttachmentPaths,setAttachments,setContextChips,setSection,maxAttachments},id){
  const capture=await snapshots.read(id);
  const safeProcess=String(capture.process||"window").replace(/[^a-zA-Z0-9._-]+/g,"-").slice(0,60)||"window";
  const uploaded=await api("/api/attachments/blob",{method:"POST",body:{name:`snapshot-${safeProcess}-${capture.createdAt||Date.now()}.png`,mime:"image/png",dataBase64:capture.dataBase64}});
  const [imagePath]=await prepareAttachmentPaths([uploaded.path]);
  setAttachments(prev=>[...new Set([...prev,imagePath])].slice(-maxAttachments));
  setContextChips(prev=>[...prev.filter(chip=>chip.path!==imagePath),{id:crypto.randomUUID(),path:imagePath,kind:"snapshot",label:`SnapShot: ${capture.process||"App"}`,detail:capture.title||`${capture.width||"?"}×${capture.height||"?"}`}].slice(-maxAttachments));
  if(capture.hasAccessibility&&Array.isArray(capture.accessibility)&&capture.accessibility.length){
    const context={app:capture.process||null,windowTitle:capture.title||null,bounds:capture.bounds||null,controls:capture.accessibility};
    try{
      const metadata=await api("/api/attachments/text",{method:"POST",body:{name:`snapshot-${safeProcess}-ui.json`,text:JSON.stringify(context,null,2)}});
      const [metadataPath]=await prepareAttachmentPaths([metadata.path]);
      setAttachments(prev=>[...new Set([...prev,metadataPath])].slice(-maxAttachments));
      setContextChips(prev=>[...prev.filter(chip=>chip.path!==metadataPath),{id:crypto.randomUUID(),path:metadataPath,kind:"snapshot",label:"SnapShot app text",detail:capture.title||capture.process||"Accessibility context"}].slice(-maxAttachments));
    }catch{}
  }
  setSection("chat");await snapshots.ack(id);
}

// A follow-up waiting in the queue sent now (its Send now, or the keyboard's steer): steered into the running turn, or started as the
// next turn once none runs. The person sends it, so it waits for this module when pressed before it has loaded.
export async function sendQueuedNow(deps,item){
  const {activeThread,activeTurnId,agentRuntime,cannotSteerReason,clearQueuedDispatch,followConversationEnd,inputsFor,loadNativeQueue,localQueueStartRef,model,permissionMode,persistLocalQueue,queueKeysDone,queueNow,queuedEditId,queuedOnItsWay,restoreFailedDraft,rpc,running,runtimeCapabilities,setActiveTurnId,setComposerAlert,setMessages,setQueued,setRunning,startTurn,validateAttachmentPaths}=deps;
  // The follow-up being edited waits for its edit (its Send now is disabled, and the keyboard's steer skips it): sending it now
  // would send the text the composer is changing. One on its way is being sent already (queuedOnItsWay).
  if(item?.id&&(item.id===queuedEditId||queuedOnItsWay(item)))return;
  if(running&&!runtimeCapabilities.steering)throw new Error(cannotSteerReason);
  // Send now is the next send, so the composer's note about the last one ends.
  setComposerAlert(null);
  if(item?.native&&runtimeCapabilities.nativeQueue&&rpc&&activeThread?.id){
    const requiredToolNamespaces=Array.isArray(item.dynamicToolNamespaces)?item.dynamicToolNamespaces:[],needsToolExpansion=queuedSubmissionNeedsToolExpansion(item,activeThread.providerMeta?.dynamicToolNamespaces||[]);
    if(running&&activeTurnId&&runtimeCapabilities.steering&&!needsToolExpansion){
      const originalInput=item.input?.length?item.input:inputsFor(item.draftText||item.text,item.attachments);const originalClientId=item.clientUserMessageId||("trebell-queue-"+crypto.randomUUID());
      try{
        await rpc.request("thread/queue/delete",{threadId:activeThread.id,queuedSubmissionId:item.id});
        await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:originalInput});
        setQueued(prev=>prev.filter(q=>q.id!==item.id));queueKeysDone(item.id);followConversationEnd();setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.draftText||item.text,attachments:item.attachments,turnId:activeTurnId}]);return;
      }catch(error){
        let restored;
        try{
          restored=await rpc.request("thread/queue/add",{threadId:activeThread.id,input:originalInput,clientUserMessageId:originalClientId,dynamicToolNamespaces:requiredToolNamespaces});
        }catch(restoreError){
          setQueued(prev=>prev.filter(q=>q.id!==item.id));
          restoreFailedDraft({text:item.draftText||item.text,attachments:item.attachments||[],contextChips:item.contextChips||[]});
          throw new Error((error?.message||String(error))+" · Native queue restore also failed: "+(restoreError?.message||String(restoreError))+". The queued draft was restored to the composer.");
        }
        const restoredDraft={...queuedSubmissionDraft(restored?.queuedSubmission||{}),contextChips:[...(item.contextChips||[])],model:item.model||model};
        setQueued(prev=>prev.map(q=>q.id===item.id?restoredDraft:q));
        try{await loadNativeQueue(rpc,activeThread.id)}
        catch(refreshError){throw new Error((error?.message||String(error))+" · Queue was restored, but refresh failed: "+(refreshError?.message||String(refreshError))+".")}
        throw error;
      }
    }
    if(running)return;
    const result=await rpc.request("thread/queue/start",{threadId:activeThread.id,queuedSubmissionId:item.id});const turnId=result?.turn?.id||null;
    setRunning(Boolean(turnId));setActiveTurnId(turnId);setQueued(prev=>prev.filter(q=>q.id!==item.id));queueKeysDone(item.id);
    // The harness may tell the message before it answers (the agent relay does, item/completed): it shows once.
    if(turnId){followConversationEnd();const id=item.clientUserMessageId||("queue-start-"+item.id);setMessages(prev=>prev.some(message=>message.id===id)?prev:[...prev,{id,role:"user",text:item.draftText||item.text,attachments:item.attachments,turnId}])}return;
  }
  // From the press on it is on its way (localQueueStartRef), until what became of it is written: its files are checked and its
  // dispatch mark is written before its card says so, and a Remove, an Edit or a second Send now meanwhile would drop a follow-up
  // this send sends anyway, or send it twice. Nor does the queue start it as well, as it would once a start that failed has stopped
  // the thread running.
  const onItsWay=localQueueStartRef.current;onItsWay.add(item.id);
  try{
    await validateAttachmentPaths(item.attachments||[]);
    if(runtimeCapabilities.steering&&running&&rpc&&activeThread&&activeTurnId){
      // Steered into the turn, it is on its way until Codex has it: its card says so and leaves it be, and a steer that fails leaves
      // it queued as it was (clearQueuedDispatch). One the relay refuses for the mode it is sent in says so as the queue's own note
      // does, in the relay's words for a follow-up that stays queued (data.queued): the queue sends it once the turn ends, unless a
      // Stop holds it, and the note ends as it goes, as a Stop holds the queue, or as the follow-up leaves the queue otherwise.
      let steered=false;
      try{
        await persistLocalQueue(activeThread.id,queueNow(activeThread.id).map(q=>q.id===item.id?{...q,dispatchingAt:Date.now()}:q));
        await rpc.request("turn/steer",{threadId:activeThread.id,expectedTurnId:activeTurnId,input:inputsFor(item.text,item.attachments),...harnessThreadOptions(agentRuntime,{permissionMode})});steered=true;
        await persistLocalQueue(activeThread.id,queueNow(activeThread.id).filter(q=>q.id!==item.id));queueKeysDone(item.id);followConversationEnd();setMessages(prev=>[...prev,{id:"steer-"+Date.now(),role:"user",text:item.text,attachments:item.attachments,turnId:activeTurnId}]);return;
      }catch(error){if(!steered)await clearQueuedDispatch(activeThread.id,item.id);if(error?.rpcCode!==-31000)throw error;setComposerAlert({kind:"send",text:"Queued follow-up not sent: "+sentenceText(error.rpcData?.queued||error.message),queuedId:item.id});return}
    }
    if(running)return;
    // Its dispatch mark goes into the queue as it is now (queueNow), not the copy taken at the press.
    const threadId=activeThread?.id||null,dispatching=queueNow(threadId).map(q=>q.id===item.id?{...q,dispatchingAt:Date.now(),autoStartFailed:false}:q);
    if(threadId)await persistLocalQueue(threadId,dispatching);else setQueued(dispatching);
    try{
      await startTurn(item.text,item.attachments,item.model||model,null,null,repositoryFocusPaths(item.attachments,item.contextChips),{sentChips:item.contextChips||[],checked:true});
      await persistLocalQueue(threadId,queueNow(threadId).filter(q=>q.id!==item.id));queueKeysDone(item.id);
    }catch(error){
      // Stop ended it before its turn existed: it stays in its place in the queue, which is left as it is but for its dispatch mark, as
      // when the queue starts it. A start that failed marks only it to retry, in the queue as that is now (queueNow).
      if(error?.trebellSendStopped){await clearQueuedDispatch(threadId,item.id);return}
      const failed=queueNow(threadId).map(q=>q.id===item.id?{...q,dispatchingAt:null,autoStartFailed:true}:q);try{await persistLocalQueue(threadId,failed)}catch{setQueued(failed)}throw error;
    }
  }finally{onItsWay.delete(item.id)}
}
// Edit from here: asked once, then the conversation (and, in a worktree of its own, the files) goes back to the message, which comes
// back to the composer to edit (edit-from-here.js, loaded once the person has said yes).
export async function editFromHere(deps,message){
  const {activeThread,activeThreadRef,askConfirm,currentProject,editFromHereAskingRef,focusComposerAt,projectPath,reloadActiveThread,rpc,rpcRef,running,runtimeCapabilities,setAttachments,setPrompt,showActionError,turnRunsNow}=deps;
  if(!runtimeCapabilities.rewind||!rpc||!activeThread?.id||!message.turnId)return;
  // One question at a time: a double click, or Enter held on the button, asks once.
  if(editFromHereAskingRef.current)return;
  const threadId=activeThread.id;
  const normalizePath=value=>String(value||"").replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase();
  // In a worktree of its own the files go back with the conversation, to the checkpoint taken before this message; anywhere else
  // only the conversation does.
  const isolatedWorktree=Boolean(
    message.checkpointId&&currentProject?.managedWorktree&&!currentProject.managedWorktree.cleanedAt
    &&normalizePath(currentProject.path)===normalizePath(activeThread.cwd||projectPath)
  );
  // Files and conversation go back together or not at all: nothing is restored while a turn runs (the harness refuses that rewind),
  // and files that could not go back leave the conversation as it is.
  const refuseWhileRunning=()=>showActionError(new Error("Stop the running turn first."),"Could not edit from this message");
  if(running){refuseWhileRunning();return}
  // Asked once, before anything changes, saying what will go: Cancel, Escape or closing the question leaves the conversation, the
  // composer and the files as they are.
  editFromHereAskingRef.current=true;
  let confirmed=false;
  try{
    confirmed=await askConfirm("Edit from this message?\n\nThe messages after it are removed from this thread"+(isolatedWorktree
      ?", this message comes back to the composer to edit, and the files in this worktree go back to how they were before it."
      :", and this message comes back to the composer to edit."),{confirm:"Edit from here"});
  }finally{editFromHereAskingRef.current=false}
  if(!confirmed||String(activeThreadRef.current?.id||"")!==String(threadId))return;
  // A turn that started while the question was open, in this window or another, is refused the same way. Another window's turn may
  // not have reached this one yet, so before any file goes back the harness is asked whether the thread runs (the server refuses a
  // restore under a running turn too).
  if(turnRunsNow()){refuseWhileRunning();return}
  // The files and the conversation go back in edit-from-here.js, loaded now.
  const outcome=await import("./edit-from-here.js").then(({rewindToMessage})=>rewindToMessage({client:rpcRef.current||rpc,message,threadId,isolatedWorktree,turnRunsNow})).catch(error=>({error,title:"Could not edit from this message"}));
  if(outcome.refused){refuseWhileRunning();return}
  if(outcome.error){showActionError(outcome.error,outcome.title);return}
  // A draft already in the composer stays, below the message brought back to edit, and so do its files, with the message's own.
  setPrompt(current=>String(current||"").trim()&&current!==message.text?message.text+"\n\n"+current:message.text);if(message.attachments?.length)setAttachments(current=>[...new Set([...current,...message.attachments])]);await reloadActiveThread();
  // The message is the composer's to edit now, so the focus goes there, at its end: the button that had it left with the message.
  focusComposerAt(String(message.text||"").length);
}
// The harnesses whose compaction takes as long as their model needs to summarize, which the window waits ten minutes for (45 s for
// the others'): Grok's runs as a turn of its own (its /compact command), Muse Code's in no turn (session/compact).
const LONG_COMPACTION_RUNTIMES=new Set(["grok","muse"]);
// What a compaction row says once the window stopped waiting for its end (requestThreadCompaction's waited error): neither compacted
// nor failed, its end not known (status unknown, a step's neutral look and pill).
const waitedCompactionRow=error=>({kind:"contextCompaction",title:error.message,status:"unknown",waited:true});
// turnless: the compaction runs in no turn of its own (Muse Code's session/compact), so only the request's answer ends it and the
// header's Stop is its own (stop()). turnId: the turn it runs in otherwise, once the request's answer (Grok's /compact) or its item
// (Codex's) names it, whose error ends it (the error notification).
// Its row in the thread shown (compactingRow) is Compact's, or the one of a message the automatic compaction runs before. At its
// limit the window stops waiting while the harness may still compact: the row says so (waited), as a step whose end is not known,
// not a failed one, and the compaction's own end, should it come, takes that row (thread/compacted, takeCompactionPlace). One that
// runs in no turn (Muse Code's) loses its Stop there, which the row says Compact brings back: Muse joins its running compaction,
// which Compact's row then follows, also in place of the row of a message that went on without it (auto-compact), so one
// compaction keeps one row.
export function requestThreadCompaction(deps,threadId){
  const {activeThreadRef,agentRuntime,agentRuntimeLabel,compactingRow,compactionWaitersRef,rpcRef,setCompactionStops,setEvents,settleCompactionWaiter,upsertEvent}=deps;
  const id=String(threadId||"").trim(),client=rpcRef.current,long=LONG_COMPACTION_RUNTIMES.has(agentRuntime),turnless=agentRuntime==="muse";
  if(!id||!client)return Promise.reject(new Error("Agent harness is not connected"));
  if(activeThreadRef.current?.id===id)setEvents(prev=>upsertEvent(turnless?prev.filter(event=>!(event.waited&&event.id==="auto-compact-"+id)):prev,compactingRow(id)));
  const existing=compactionWaitersRef.current.get(id);if(existing)return existing.promise;
  let resolvePromise,rejectPromise;
  const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject});
  const timer=setTimeout(()=>settleCompactionWaiter(id,Object.assign(new Error(`Trebell stopped waiting for the context compaction after ${long?"10 minutes":"45 seconds"}; ${agentRuntimeLabel} may still be compacting.${turnless?" Press Compact to follow it again; its Stop comes back.":""}`),{waited:true})),long?600_000:45_000);
  const waiter={promise,resolve:resolvePromise,reject:rejectPromise,timer,turnless,turnId:null};
  compactionWaitersRef.current.set(id,waiter);if(waiter.turnless)setCompactionStops(count=>count+1);
  client.request("thread/compact/start",{threadId:id}).then(result=>{if(result?.turn?.id!=null)waiter.turnId??=String(result.turn.id)},error=>settleCompactionWaiter(id,error));
  return promise;
}
// Compact (the composer's button and /compact): the thread's context compacted now, its row saying how it went.
export async function compactContext(deps){
  const {activeThread,activeThreadRef,agentRuntimeLabel,endCompactionRecord,leavingThread,rpc,runtimeCapabilities,setEvents,upsertEvent}=deps;
  if(!runtimeCapabilities.compaction){setEvents(prev=>[...prev,{id:"compact-unavailable-"+Date.now(),kind:"error",title:`${agentRuntimeLabel} does not expose generic context compaction`,status:"done",raw:{}}]);return}
  if(!activeThread?.id||!rpc||leavingThread())return;
  const threadId=activeThread.id,id="context-compact-"+threadId;
  try{
    // Grok's and Muse Code's compaction take as long as the model needs (LONG_COMPACTION_RUNTIMES).
    await requestThreadCompaction(deps,activeThread.id);
  }catch(error){
    // The failure ends the compaction's own row, which no turn ends: it would say "Compacting context" beside its failure. That is
    // its item's row once the item came (in its turn's record too, so the turn's card says it failed), else the one Compact put up.
    // One the window stopped waiting for has not failed, as far as it knows: its row says so, a compaction whose end is not known
    // (requestThreadCompaction).
    const failed=error.waited?waitedCompactionRow(error):{kind:"error",title:"Context compaction failed: "+(error.message||String(error)),status:"done"};
    if(activeThreadRef.current?.id!==threadId)return;
    endCompactionRecord(threadId,null,row=>({...row,...failed}));
    setEvents(prev=>{const row=prev.findLast(item=>item.kind==="contextCompaction"&&item.status==="running");return row?prev.map(item=>item===row?{...item,...failed}:item):upsertEvent(prev,{id,...failed,raw:{}})});
  }
}
