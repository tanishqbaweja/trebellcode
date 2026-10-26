import { resolve } from "node:path";
import { acpToolFrame } from "./acp-tool-state.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { MuseHost, MUSE_SHUTDOWN_TIMEOUT_MS, MUSE_STARTUP_TIMEOUT_MS, loadMuseSdk, museServeArgs, museWorkspaceRoot } from "./muse-host.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";

// Muse Code sessions and turns over the Muse Session Protocol (T3 Code's MuseAdapter): a session is started or resumed on Trebell's
// own host (muse-host.mjs), each prompt is a turn/start the turn's id is minted for, and Muse's item events come back as the
// ACP-shaped updates the relay reads (replies, reasoning summaries, commands, file edits, web searches).

export const MUSE_REQUEST_TIMEOUT_MS=30_000;
export const MUSE_INTERRUPT_TIMEOUT_MS=30_000;
// Every session is asked for explicitly: without a profile Muse may start in Auto-review, where an AI reviewer decides (T3
// f87dd14da). Group M3 maps each Trebell mode to its profile and approval mode.
const MUSE_APPROVAL_MODE="promptUnmatched";
const MUSE_PERMISSION_PROFILE=":ask-me";
// Meta's provider refuses "none"; the rest are MSP's efforts.
const MUSE_EFFORTS=new Set(["minimal","low","medium","high","xhigh","max","ultra"]);
// Items with rows of their own elsewhere (todo lists, questions, workflows) unless they failed, and Muse's housekeeping: the user's
// own message, the reminder children every model step runs, and compactions (group M5).
const OWN_ROW_TOOLS=new Set(["write_todos","request_user_input","workflow"]);
const SKIPPED_KINDS=new Set(["userMessage","reminderChild","compaction"]);
const ACTIONS=Object.freeze({
  "session/start":"start the session","session/resume":"resume this conversation","session/setApprovalMode":"set the session's approval mode",
  "turn/start":"start the turn","turn/steer":"take the message into the running turn","turn/interrupt":"stop the turn",
  "approval/decide":"take Trebell's answer to its request","userInput/cancel":"take Trebell's answer to its question",
});

function text(value){return typeof value==="string"?value:value==null?"":String(value)}
function wait(ms){let timer;const promise=new Promise(resolve=>{timer=setTimeout(resolve,ms);timer?.unref?.()});return {promise,cancel:()=>clearTimeout(timer)}}
async function within(promise,ms){const timer=wait(ms);try{return await Promise.race([Promise.resolve(promise).then(()=>true,()=>true),timer.promise.then(()=>false)])}finally{timer.cancel()}}
function shorten(value,limit=80){const line=text(value).replace(/\s+/g," ").trim();return line.length>limit?line.slice(0,limit-1)+"…":line}

// Prompt parts for turn/start and turn/steer: text as it is, images as base64 with their media type, and any other attachment as
// a line naming the file it was saved to. An input with neither text nor an image is refused.
export function museInputParts(parts=[]){
  const out=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="text"){const value=text(part.text);if(value)out.push({type:"text",text:value})}
    else if(part?.type==="image"&&part.data)out.push({type:"image",base64Data:text(part.data),mediaType:text(part.mimeType||part.mime_type)||"image/png"});
    else if(part?.type==="resource_link"&&part.uri)out.push({type:"text",text:`Attached file: ${fileUriPath(part.uri)??text(part.uri)}`});
  }
  if(!out.some(part=>part.type==="image"||part.text.trim()))throw new Error("Muse Code needs text or an image to start a turn.");
  return out;
}

// What Muse's transcript shows for the turn: the person's own words, without Trebell's working context or runtime notes.
export function museDisplayText(parts=[]){
  const list=Array.isArray(parts)?parts:[];
  const own=list.map(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.userParts).find(Array.isArray);
  const words=(own||list.filter(part=>part?.type==="text").map(part=>text(part.text))).join("\n").trim();
  return words||(list.some(part=>part?.type==="image")?"Attached image":"");
}

export function museToolStatus(item={}){
  if(item.status==="inProgress")return "in_progress";
  if(item.status==="completed"&&!(item.kind==="compaction"&&item.outcome&&item.outcome!=="compacted"))return "completed";
  return "failed";
}

function jsonObject(value){
  if(typeof value!=="string"||!value.trim())return null;
  try{const parsed=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:null}catch{return null}
}
function webHits(value){
  const results=jsonObject(value)?.results;if(!Array.isArray(results))return null;
  return results.filter(hit=>hit&&typeof hit==="object").map(({url,title,snippet})=>({
    ...(typeof url==="string"&&url.trim()?{url:url.trim()}:{}),...(typeof title==="string"&&title.trim()?{title:title.trim()}:{}),...(typeof snippet==="string"&&snippet?{snippet}:{}),
  }));
}
function hitsText(results){return results.map(hit=>[hit.title&&hit.url?`${hit.title} (${hit.url})`:hit.title||hit.url||"",hit.snippet||""].filter(Boolean).join("\n")).filter(Boolean).join("\n\n")}

// One Muse item as an ACP tool update, as T3's museToolPresentation maps it: Muse's shell and the person's own shell commands run
// as commands with their output and exit code; a write, edit or patch with a file is a file edit with its exact old and new text
// (an ACP diff) or Muse's patch; a web search lists its hits and a fetched page its text; anything else is a tool row with its
// arguments. Muse's tool arguments are model-written JSON, which may not parse while they stream.
export function museToolUpdate(item={}){
  const args=jsonObject(item.args),arg=(...keys)=>{for(const key of keys)if(typeof args?.[key]==="string")return args[key];return undefined};
  const tool=text(item.tool||item.kind)||"tool",status=museToolStatus(item);
  const name=item.kind==="subagent"?item.objective||item.role||"Muse agent":item.kind==="workflow"?item.entryId||"Workflow":tool;
  const detail=status==="failed"?item.failureReason||`Muse Code reported ${item.status||"a failure"}.`:"";
  const body=item.visibleOutput??item.result?.summary??item.text??(Array.isArray(item.summary)?item.summary.join("\n"):undefined)??item.finalSummary??item.fallbackText??item.objective??"";
  const output=detail?[detail,text(body)].filter(Boolean).join("\n"):text(body);
  const base={toolCallId:text(item.itemId),status};
  if(item.kind==="userShell"||/shell|bash|exec_command/i.test(text(item.tool))){
    const command=item.commandText??arg("command","cmd")??item.args??"";
    // Muse's own shell answers with a record of the run ({command, exit_code, output, ...}), which carries the output and exit code.
    const record=jsonObject(item.visibleOutput),run=record&&typeof record.output==="string"?{...record,output:detail?[detail,record.output].filter(Boolean).join("\n"):record.output}:null;
    return {...base,kind:"execute",title:text(command)||tool,rawInput:args||{command:text(command)},rawOutput:run||output,...(Number.isInteger(item.exitCode)?{exitCode:item.exitCode}:{})};
  }
  if(item.kind==="toolCall"&&/write|edit|patch/i.test(tool)){
    const path=arg("file_path","path","filePath")?.trim();
    if(path){
      const oldText=arg("old_string","old_str","oldStr","oldText"),newText=arg("new_string","new_str","newStr","newText","content"),patch=arg("diff","patch","diffStr");
      return {
        ...base,kind:"edit",title:detail?`${tool}: ${detail}`:tool,rawInput:args,rawOutput:output,locations:[{path}],
        content:newText!==undefined?[{type:"diff",path,...(oldText!==undefined?{oldText}:{}),newText}]:[],
        ...(newText===undefined&&patch!==undefined?{changes:[{path,kind:"update",diff:patch}]}:{}),
      };
    }
  }
  if(item.kind==="toolCall"&&/web|browse|fetch/i.test(tool)){
    const query=arg("query","url","pattern")?.trim(),url=arg("url")?.trim();
    const hits=item.tool==="web_search"&&!detail?webHits(text(body)):null;
    const results=hits??(output?[{...(url?{url}:{}),snippet:output}]:[]);
    return {...base,kind:"fetch",title:query?`${tool}: ${query}`:tool,rawInput:args||{},rawOutput:{...(query?{query}:{}),results},content:results.length?[{type:"content",content:{type:"text",text:hitsText(results)}}]:[]};
  }
  return {...base,kind:"other",title:detail?`${name}: ${detail}`:name,rawInput:args||(item.args?{args:text(item.args)}:{}),rawOutput:output};
}

// The choice that declines a Muse approval: Muse's own "denied" choice (the narrowest scope first), else its "abort" (shell
// approvals offer Reject as abort). A choice that would save a rule is never taken on its own.
export function museDeclineChoice(choices=[]){
  const list=(Array.isArray(choices)?choices:[]).filter(choice=>choice&&typeof choice.choiceId==="string"&&choice.choiceId);
  const rank=choice=>choice.scope==="once"?0:choice.scope==="session"?1:2;
  return list.filter(choice=>choice.decision==="denied").sort((a,b)=>rank(a)-rank(b))[0]||list.find(choice=>choice.decision==="abort")||null;
}
function approvalTarget(params={}){
  const subject=params.subject||{};
  if(subject.kind==="shell"&&subject.command)return `run ${shorten(subject.command)}`;
  if(subject.kind==="fileAccess"&&subject.path)return `${subject.access==="read"?"read":"write"} ${shorten(subject.path)}`;
  if(subject.kind==="network"&&subject.host)return `reach ${shorten(subject.host)}`;
  if(subject.target)return `control ${shorten(subject.target)}`;
  return `use ${shorten(params.toolName||subject.toolName||"a tool")}`;
}

export class MuseAgentSession{
  constructor({command="muse",cwd,env=process.env,permissionMode="supervised",onUpdate,onPermission=null,onQuestion=null,version="0.0.0",spawnFn=undefined,platform=process.platform,loadSdk=loadMuseSdk,stopTree=undefined,startupTimeoutMs=MUSE_STARTUP_TIMEOUT_MS,shutdownTimeoutMs=MUSE_SHUTDOWN_TIMEOUT_MS,requestTimeoutMs=MUSE_REQUEST_TIMEOUT_MS,interruptTimeoutMs=MUSE_INTERRUPT_TIMEOUT_MS}={}){
    this.command=command;this.cwd=resolve(cwd||process.cwd());this.env=env;this.permissionMode=normalizePermissionMode(permissionMode||"supervised");
    this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.version=version;
    this.hostOptions={spawnFn,platform,stopTree,startupTimeoutMs,shutdownTimeoutMs};this.platform=platform;this.loadSdk=loadSdk;
    this.requestTimeoutMs=requestTimeoutMs;this.interruptTimeoutMs=interruptTimeoutMs;
    this.args=museServeArgs(this.permissionMode);this.host=null;this.connection=null;this.initializeResult=null;this.sessionSetup=null;
    this.sessionId=null;this.model=null;this.reasoningEffort=null;this.turnRoot=null;
    this.dead=false;this.deadError=null;this.closed=false;this.activePrompt=null;
    // Approval stages and questions already answered, approvals already resolved, and the rows shown for them.
    this.decidedStages=new Set();this.resolvedApprovals=new Set();this.cancelledQuestions=new Set();this.noticeRows=new Set();
  }

  get busy(){return Boolean(this.activePrompt)}
  // A new host can take the conversation up again unless this one keeps its sessions in memory only.
  get resumable(){return Boolean(this.initializeResult)&&this.initializeResult.sessionDurability!=="ephemeral"}
  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode||"supervised");return this.permissionMode}
  // The launch flags are fixed for the host's lifetime, so a mode with other flags needs a new host.
  needsRelaunch(mode){return JSON.stringify(museServeArgs(mode))!==JSON.stringify(this.args)}
  setReasoningEffort(effort){const value=text(effort).trim().toLowerCase();this.reasoningEffort=MUSE_EFFORTS.has(value)?value:null;return this.reasoningEffort}

  async start({providerSessionId=null,model=null,reasoningEffort=undefined}={}){
    if(reasoningEffort!==undefined)this.setReasoningEffort(reasoningEffort);
    this.args=museServeArgs(this.permissionMode);
    const host=new MuseHost({...Object.fromEntries(Object.entries(this.hostOptions).filter(([,value])=>value!==undefined)),command:this.command,args:this.args,cwd:this.cwd,env:this.env,
      onWarning:message=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message}})});
    this.host=host;this.dead=false;this.deadError=null;
    await host.start({version:this.version,loadSdk:this.loadSdk});
    if(this.closed){await host.close();throw new Error("Muse Code was stopped while it started.")}
    const connection=host.connection;this.connection=connection;this.initializeResult=host.initializeResult;
    connection.onNotification(frame=>{if(this.host===host)this.#notification(frame)});
    connection.onServerRequest(request=>this.#serverRequest(host,request));
    connection.onProtocolError(error=>{if(this.host===host)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message:`Muse Code sent a frame Trebell could not read: ${error?.message||error}`}})});
    this.#watch(host);
    try{
      const [workspaceRoot,turnRoot]=await Promise.all([museWorkspaceRoot(this.cwd,{platform:this.platform,verbatim:false}),museWorkspaceRoot(this.cwd,{platform:this.platform})]);
      this.turnRoot=turnRoot;
      const requested=text(model).trim(),modelId=requested&&requested!=="default"?requested:null;
      const sessionId=providerSessionId?text(providerSessionId):connection.mintCommandId();
      this.sessionId=sessionId;
      const result=providerSessionId?await this.#resume(sessionId):await this.#command("session/start",{sessionId,workspaceRoot,providerId:"meta",...(modelId?{modelId}:{}),approvalMode:MUSE_APPROVAL_MODE,permissionProfile:MUSE_PERMISSION_PROFILE});
      if(result?.session?.sessionId!==sessionId)throw new Error("Muse Code answered with another session than the one Trebell asked for.");
      this.model=text(result.session.modelId)||modelId;
      this.sessionSetup={sessionId,models:{currentModelId:this.model,availableModels:this.model?[{modelId:this.model,name:this.model}]:[]},configOptions:[],modes:{currentModeId:"default",availableModes:[]}};
      return {initialize:this.initializeResult,session:this.sessionSetup};
    }catch(error){
      // The host has no session of Trebell's then; a resume that found none closes nothing on Muse's side.
      this.dead=true;this.deadError=error;await host.close().catch(()=>{});
      throw error;
    }
  }

  // A saved conversation is resumed with the profile asked for again and its approval mode set; one Muse no longer has is a lost
  // session, which the relay continues in a fresh one with the thread's earlier messages handed over.
  async #resume(sessionId){
    try{
      const result=await this.#command("session/resume",{sessionId,excludeItems:true,permissionProfile:MUSE_PERMISSION_PROFILE});
      await this.#command("session/setApprovalMode",{sessionId,mode:MUSE_APPROVAL_MODE});
      return result;
    }catch(error){
      if(error?.kind==="sessionNotFound"||error?.kind==="notFound")throw new HarnessSessionLostError(error.message,{harness:"muse",sessionId,code:error.code,cause:error.cause||error});
      throw error;
    }
  }

  // An MSP command, bounded at requestTimeoutMs: turn/start keeps the SDK's retries of an overloaded host, every other command is
  // sent once. A host that does not answer in time is stopped, and the session is dead.
  async #command(method,params,{commandId=undefined,retries=false}={}){
    const connection=this.connection;if(!connection)throw new Error("Muse Code session is not started.");
    const timer=wait(this.requestTimeoutMs);
    try{
      const answer=await Promise.race([
        connection.command(method,params,{...(commandId?{commandId}:{}),...(retries?{}:{maxAttempts:1})}).then(result=>({result}),error=>({error})),
        timer.promise.then(()=>({timeout:true})),
      ]);
      if(answer.timeout){
        const message=`Muse Code did not answer within ${Math.round(this.requestTimeoutMs/1000)} seconds when asked to ${ACTIONS[method]||method}, so Trebell stopped it.`;
        this.#lose(message,{stop:true});
        throw Object.assign(new Error(message),{code:"MUSE_REQUEST_TIMEOUT"});
      }
      if(answer.error){
        const error=answer.error,reason=this.dead&&this.deadError?this.deadError.message:error?.message||String(error);
        throw Object.assign(new Error(`Muse Code could not ${ACTIONS[method]||method}: ${reason}`),{code:error?.code,kind:error?.kind,cause:error});
      }
      return answer.result;
    }finally{timer.cancel()}
  }

  // onDelivered: told once Muse has admitted the turn (its turn/start answer), so the prompt with Trebell's context beside it is in
  // Muse's conversation. The turn's id is minted first, so the events Muse sends for it before that answer are its own.
  async prompt(parts,{onDelivered=null}={}){
    if(!this.connection||!this.sessionId)throw new Error("Muse Code session is not started.");
    if(this.dead)throw this.deadError||new Error("Muse Code stopped.");
    if(this.activePrompt)throw new Error("Muse Code already has a running turn.");
    const input=museInputParts(parts),displayText=museDisplayText(parts);
    const turn=this.#newTurn(this.connection.mintCommandId());this.activePrompt=turn;
    try{
      let ack;
      try{
        ack=await this.#command("turn/start",{
          sessionId:this.sessionId,
          // Muse takes no system context, so Trebell's runtime notes lead the turn's input.
          input:[{type:"text",text:runtimeInstructions({harness:"Muse Code",model:this.model})},...input],
          ...(displayText?{displayText}:{}),
          // Each turn names the folder: a resumed session keeps the roots it had.
          workspaceRoots:[this.turnRoot],ifBusy:"queue",...(this.reasoningEffort?{reasoningEffort:this.reasoningEffort}:{}),
        },{commandId:turn.turnId,retries:true});
        if(ack?.turnId!==turn.turnId)throw new Error("Muse Code took the message into another turn than the one Trebell started.");
      }catch(error){
        turn.admit(false);
        // A host that went away under the request ends the turn with its own reason, its exit, which follows moments later.
        if(await within(this.connection.closed,50))await within(turn.done,2500);
        turn.fail(error);
        return await turn.done;
      }
      turn.admit(true);
      if(typeof onDelivered==="function")try{onDelivered()}catch{}
      return await turn.done;
    }finally{if(this.activePrompt===turn)this.activePrompt=null}
  }

  #newTurn(turnId){
    let settle,fail,admit;
    const done=new Promise((resolve,reject)=>{settle=resolve;fail=reject});
    const admitted=new Promise(resolve=>{admit=resolve});
    const turn={turnId,stopRequested:false,settled:false,items:new Map(),sent:new Map(),tools:new Set(),lastMessage:null,done,admitted,admit};
    turn.settle=value=>{if(turn.settled)return;turn.settled=true;settle(value)};
    turn.fail=error=>{if(turn.settled)return;turn.settled=true;fail(error)};
    done.catch(()=>{});
    return turn;
  }

  // A message sent while the turn runs goes into that turn (turn/steer names the turn it is meant for), once Muse has admitted it.
  async steer(parts){
    const turn=this.activePrompt;
    if(!this.connection||!turn||turn.settled)throw new Error("Muse Code has no running turn to steer.");
    const input=museInputParts(parts);
    if(!(await turn.admitted)||turn.settled)throw new Error("Muse Code has no running turn to steer.");
    const ack=await this.#command("turn/steer",{sessionId:this.sessionId,expectedTurnId:turn.turnId,input});
    if(ack?.turnId!==turn.turnId)throw new Error("Muse Code took the message into another turn than the running one.");
    return {accepted:true,pending:0,providerMessageId:null};
  }

  // Stop: turn/interrupt for the running turn once Muse has admitted it, then its turn/completed. A host that does not confirm
  // the stop within interruptTimeoutMs is stopped itself, and the next message starts it again.
  async cancel(){
    const turn=this.activePrompt;if(!turn||turn.settled)return;
    turn.stopRequested=true;
    if(!(await turn.admitted)||turn.settled)return;
    try{await this.#command("turn/interrupt",{sessionId:this.sessionId,turnId:turn.turnId})}catch{}
    if(turn.settled)return;
    const timer=wait(this.interruptTimeoutMs);
    const confirmed=await Promise.race([turn.done.then(()=>true,()=>true),timer.promise.then(()=>false)]).finally(()=>timer.cancel());
    if(confirmed)return;
    turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null});
    this.#lose(`Muse Code did not confirm within ${Math.round(this.interruptTimeoutMs/1000)} seconds that the turn stopped, so Trebell stopped Muse Code.`,{stop:true,quiet:true});
  }

  async close(){
    if(this.closed)return;this.closed=true;
    const turn=this.activePrompt;if(turn){turn.stopRequested=true;turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null})}
    await this.host?.close().catch(()=>{});
  }

  // The host ending on its own (its exit, or its connection closing first) ends the running turn with Muse's reason once, and
  // leaves the session dead: the next message starts a new host. A host whose connection closed but whose process runs on is stopped.
  #watch(host){
    const lost=message=>{if(this.host===host&&!this.closed&&!host.closing)this.#lose(message,{stop:true})};
    host.exited.then(exit=>lost(host.exitMessage(exit)));
    host.connection.closed.then(async()=>{
      const timer=wait(2000);
      await Promise.race([host.exited,timer.promise]).finally(()=>timer.cancel());
      lost(host.exit?host.exitMessage(host.exit):"Muse Code closed its connection to Trebell unexpectedly.");
    });
  }
  #lose(message,{stop=false,quiet=false}={}){
    if(this.dead||this.closed)return;
    this.dead=true;this.deadError=Object.assign(new Error(message),{code:"MUSE_HOST_LOST"});
    const turn=this.activePrompt;
    if(turn&&!turn.settled){if(turn.stopRequested)turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null});else turn.fail(this.deadError)}
    else if(!quiet)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message}});
    if(stop)void this.host?.close().catch(()=>{});
  }

  // Muse sends a pending approval or question both as a notification and as a server request, answered with the presentation
  // receipt {}; the decision goes out as its own command. Until group M3 shows them, every approval is declined with Muse's own
  // choice and every question cancelled, and the turn's activity says so; nothing waits on an answer nobody can give.
  async #serverRequest(host,request){
    const params=request?.params||{};
    if(this.host===host&&params.sessionId===this.sessionId){
      if(request.method==="approval/request"){void this.#declineApproval(params);return {}}
      if(request.method==="userInput/request"){void this.#cancelQuestion(params);return {}}
    }
    throw new host.sdk.MspError({code:-32601,message:`method not found: ${request?.method}`,data:{kind:"methodNotFound",retryable:false}});
  }

  async #declineApproval(params){
    const approvalId=text(params.approvalId);
    if(!approvalId||this.resolvedApprovals.has(approvalId)||params.change?.kind==="alreadyTerminal"||!params.currentRequirementId)return;
    const stage=approvalId+":"+JSON.stringify(params.currentRequirementId);
    if(this.decidedStages.has(stage))return;this.decidedStages.add(stage);
    const sentence=`Trebell declined Muse Code's request to ${approvalTarget(params)}: Trebell cannot answer Muse Code's approval requests yet.`;
    if(params.subject)this.#notice(`muse-approval:${approvalId}`,sentence,{toolName:text(params.toolName)||null,subject:params.subject});
    const choice=museDeclineChoice(params.availableChoices);
    // No choice declines it: the turn is stopped rather than left waiting.
    if(!choice)return void this.cancel();
    await this.#command("approval/decide",{
      sessionId:this.sessionId,approvalId,requirementId:params.currentRequirementId,choiceId:choice.choiceId,
      ...(choice.acceptsFeedback?{feedback:`${sentence} Do not retry it; continue without it, and tell the user what it would need.`}:{}),
    }).catch(()=>{});
  }

  async #cancelQuestion(params){
    const userInputId=text(params.userInputId);
    if(!userInputId||this.cancelledQuestions.has(userInputId))return;this.cancelledQuestions.add(userInputId);
    const question=(Array.isArray(params.questions)?params.questions:[]).map(entry=>text(entry?.question||entry?.header).trim()).find(Boolean)||"";
    this.#notice(`muse-question:${userInputId}`,`Trebell cancelled Muse Code's question${question?` "${shorten(question)}"`:""}: Trebell cannot answer Muse Code's questions yet.`,{questions:params.questions||[]});
    await this.#command("userInput/cancel",{sessionId:this.sessionId,userInputId,reason:"Trebell Code cannot answer Muse Code's questions yet. Continue without the answer, and tell the user what you would have asked."}).catch(()=>{});
  }

  #notice(id,title,rawInput){
    if(this.noticeRows.has(id))return;this.noticeRows.add(id);
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:id,title,kind:"other",status:"failed",rawInput,rawOutput:title}});
  }

  #notification(frame){
    const method=text(frame?.method),params=frame?.params;
    if(!params||typeof params!=="object"||params.sessionId!==this.sessionId)return;
    if(method==="approval/requested"||method==="approval/updated")return void this.#declineApproval(params);
    if(method==="approval/resolved"){this.resolvedApprovals.add(text(params.approvalId));return}
    if(method==="userInput/requested")return void this.#cancelQuestion(params);
    const turn=this.activePrompt;if(!turn||turn.settled)return;
    if(method==="item/started"||method==="item/updated"||method==="item/completed")return this.#item(turn,params.item);
    if(method==="item/delta")return this.#delta(turn,params);
    if(method==="turn/completed"&&params.turnId===turn.turnId)return this.#completed(turn,params);
  }

  // Items keep their highest revision: an older one arriving late is ignored. Items of other turns are not this turn's.
  #item(turn,item){
    if(!item||typeof item!=="object"||!item.itemId)return;
    if(item.turnId&&item.turnId!==turn.turnId)return;
    const previous=turn.items.get(item.itemId);
    if(previous&&Number(previous.revision)>=Number(item.revision))return;
    const current={...item,...(Array.isArray(item.summary)?{summary:[...item.summary]}:{})};
    turn.items.set(item.itemId,current);this.#publish(turn,current);
  }
  // Deltas append to an open item by field: text to a reply, summary.N to part N of a reasoning summary, output to a command.
  #delta(turn,params){
    const item=turn.items.get(text(params.itemId));if(!item||item.status!=="inProgress")return;
    const field=text(params.field)||"text",delta=text(params.delta);if(!delta)return;
    if(field==="text")item.text=text(item.text)+delta;
    else if(field==="output"||field==="visibleOutput")item.visibleOutput=text(item.visibleOutput)+delta;
    else if(/^summary\.\d+$/.test(field)){const index=Number(field.slice(8));if(index>=100)return;const summary=[...(item.summary||[])];summary[index]=text(summary[index])+delta;item.summary=summary}
    else return;
    this.#publish(turn,item);
  }
  #publish(turn,item){
    if(SKIPPED_KINDS.has(item.kind))return;
    if(item.kind==="toolCall"&&OWN_ROW_TOOLS.has(item.tool)&&museToolStatus(item)!=="failed")return;
    if(item.kind==="agentMessage")return this.#stream(turn,item,"agent_message_chunk",text(item.text));
    // A reasoning item's summary parts, or the provider's own reasoning text where it sends that instead.
    if(item.kind==="reasoning")return this.#stream(turn,item,"agent_thought_chunk",(Array.isArray(item.summary)?item.summary:[]).map(text).filter(Boolean).join("\n\n")||text(item.text));
    const first=!turn.tools.has(item.itemId);turn.tools.add(item.itemId);
    this.onUpdate?.({sessionId:this.sessionId,update:{...acpToolFrame(museToolUpdate(item)),sessionUpdate:first?"tool_call":"tool_call_update"}});
  }
  // The text an item has that has not been sent yet: what a delta added, or on item/completed what the final text has beyond what
  // streamed. A later reply of the turn starts a paragraph of its own.
  #stream(turn,item,type,full){
    const sent=turn.sent.get(item.itemId)||"";
    if(sent&&!full.startsWith(sent))return;
    const chunk=full.slice(sent.length);if(!chunk)return;
    turn.sent.set(item.itemId,full);
    let value=chunk;
    if(type==="agent_message_chunk"){if(!sent&&turn.lastMessage&&turn.lastMessage!==item.itemId&&!/^\s*\n/.test(chunk))value="\n\n"+chunk;turn.lastMessage=item.itemId}
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:type,content:{type:"text",text:value},messageId:item.itemId}});
  }
  // turn/completed settles the prompt: completed ends the turn, cancelled is a stop (interrupted when the person asked for it), and
  // failed fails it with Muse's own error.
  #completed(turn,params){
    const terminal=text(params.terminal);
    if(terminal==="completed")return turn.settle({stopReason:"end_turn",providerMessageId:null,raw:params});
    if(terminal==="cancelled")return turn.settle({stopReason:"cancelled",interrupted:turn.stopRequested,providerMessageId:null,raw:params});
    turn.fail(Object.assign(new Error(text(params.error?.message)||text(params.reason)||"Muse Code could not finish the turn."),{code:params.error?.kind||"MUSE_TURN_FAILED",raw:params}));
  }
}
