// What the app does around an agent's turn beyond showing it: the repository context a send carries, the new worktree a send can
// ask for, the compaction a send runs first, a send that is a command rather than a message (a project's recipe or one of the
// composer's slash commands), the agent's own tool calls (Trebell's browser, computer, source-control, repository and delegation
// tools), the verification planned once a turn completes, and the turns a restart interrupted. Nothing on the first screen or in
// opening and reading a thread needs it, so App loads this module at idle after the first paint (B11). Each function takes what it
// reads of App's render as deps, as App's own functions read it.
import { api } from "./api.js";
import { codexGoalsMissing, describeCodexGoal } from "./codex-turn-options.js";
import { parseCodexGoalCommand } from "./codex-goal-command.js";
import { repositoryFocusPaths } from "./context-focus.js";
import { contextTaskAnchor, contextTaskText } from "./context-task.js";
import { repositoryContextDeliveryPacket } from "./context-provenance.js";
import { desktopBridgeToolAvailability } from "./desktop-tool-availability.js";
import { requestTurnVerificationPlan, verificationPlanEvent } from "./turn-verification.js";
import { maybeStartAutomaticVerificationRepair } from "./auto-verification-repair.js";
import { maybeStartAutomaticVerificationContinuation } from "./auto-verification-continuation.js";
import { askTerminalKeyboard } from "./terminal-keyboard.js";
import { autoCompactionDecision } from "./auto-compaction.js";
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
  const {currentProject,projectPath,workspaceEnvironmentId,permissionMode,setPermissionMode,agentRuntime,agentRuntimeLabel,models,model,attachments,contextChips,runtimeCapabilities,rpc,activeThread,activeThreadRef,startTurn,compactContext,startReview,runUserAction,newChat,openRightPanel,openProviderSettings,setPanel,setPaletteOpen,setPrompt,setGoal,setEvents,setComposerAlert,askForModel}=deps;
  const [command,...rest]=text.split(/\s+/);
  const recipe=(currentProject?.recipes||[]).find(item=>item.name===command);
  if(recipe){
    try{
      const resolved=await api("/api/project-recipe/resolve",{method:"POST",body:{path:projectPath,environmentId:workspaceEnvironmentId,recipe:recipe.id||recipe.name,input:rest.join(" "),currentPermission:permissionMode,runtime:agentRuntime}});
      const execution=resolved.execution;if(!execution)throw new Error("Recipe could not be resolved");
      if(execution.model&&!models.includes(execution.model))throw new Error(`Recipe ${recipe.name} requires model ${execution.model}, which is not available in the active runtime.`);
      // A recipe that names no model runs on the composer's. With none chosen from a catalog that lists some (Trebell Native on a
      // provider that names no default), the composer asks for one as it does for a message (App's dispatchSend) and keeps the command.
      if(!execution.model&&!models.includes(model)&&models.length&&askForModel){askForModel();return "kept"}
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
