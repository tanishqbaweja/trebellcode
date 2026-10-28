import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileUri, fileUriPath } from "./file-uri.mjs";
import { OpenCodeAgentSession, inferOpenCodeDefaultVariant, openCode2InventoryReads, openCode2ModelId, openCode2PrimaryAgents, openCode2ServerInfo, openCode2Within, openCodeListsAsListed, openCodePermissionDisposition, openCodePermissionRules, openCodeReadOutput, openCodeRefusal, openCodeRetryNotice, openCodeRetryStop, startOpenCode2Server, waitForOpenCode2Models } from "./opencode-agent-session.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizePermissionKind, normalizePermissionMode } from "./permission-policy.mjs";
import { PROMPT_IMAGE_PATH, textExtractedTo } from "./prompt-attachments.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";

const STOPPED=Symbol("opencode2-stopped");
// OpenCode 2.x's client loads with the first OpenCode 2.x session, before it starts its server, not with the server (budget B25).
let openCodeClient=null;
const loadOpenCodeClient=()=>openCodeClient??=import("@opencode/client");

function authHeader(password=""){
  return "Basic "+Buffer.from("opencode:"+String(password),"utf8").toString("base64");
}
function clientFor(OpenCode,server){
  return OpenCode.make({baseUrl:server.url,headers:{Authorization:authHeader(server.password)}});
}
function modelKey(model){return openCode2ModelId(model)}
function modelRef(id,variant=null){
  const raw=String(id||""),slash=raw.indexOf("/");if(slash<=0)return null;
  return {providerID:raw.slice(0,slash),id:raw.slice(slash+1),...(variant?{variant}:{})};
}
function variantsOf(model){
  return (Array.isArray(model?.variants)?model.variants:[]).map(item=>String(item?.id||"").trim()).filter(Boolean);
}
function v2Action(permission){const value=String(permission||"*");return value==="bash"?"shell":value==="task"?"subagent":value}
function v2Rules(mode,{repositoryMcp=null,grants=[]}={}){
  const rules=openCodePermissionRules(mode,{allowedTools:repositoryMcp?.name?[`${repositoryMcp.name}_*`]:[]});
  return [...rules.map(rule=>({action:v2Action(rule.permission),resource:String(rule.pattern||"*"),effect:rule.action==="allow"?"allow":rule.action==="deny"?"deny":"ask"})),...(Array.isArray(grants)?grants:[])];
}
// OpenCode 2 takes an attachment as a URI it reads itself ({uri, name}), and refuses the whole prompt when one is missing (T3 Code). A
// PNG, JPEG, GIF or WebP image whose saved file is there goes that way, and every attachment is named by its saved path, which the agent
// opens with its own tools, a document with the file its text was extracted to. A server of the profile's own may not see this
// machine's files: it gets the paths only.
const NATIVE_IMAGES=Object.freeze({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp"});
const fileExists=path=>access(path).then(()=>true,()=>false);
export async function openCode2PromptInput(parts=[],{external=false}={}){
  const text=[],files=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="text"){text.push(String(part.text||""));continue}
    const pasted=part?.type==="image";if(!pasted&&part?.type!=="resource_link")continue;
    const path=pasted?String(part[PROMPT_IMAGE_PATH]||""):fileUriPath(part.uri)||"";
    const mime=pasted?String(part.mimeType||"").toLowerCase():NATIVE_IMAGES[extname(path).toLowerCase()]||"",native=Object.values(NATIVE_IMAGES).includes(mime);
    const kind=pasted||native?"image":"file",name=String(part.name||(path?basename(path):"")||kind);
    if(!path){text.push(pasted?`[Attached image "${name}" could not be sent: Trebell Code has no saved file for it]`:`[Attached file "${name}" is at: ${String(part.uri||"")}]`);continue}
    text.push(`[Attached ${kind} "${name}" is saved at: ${path}${textExtractedTo(part)}]`);
    if(native&&!external&&await fileExists(path))files.push({uri:fileUri(path),name});
  }
  return {text:text.join("\n"),files};
}
// OpenCode 2 asks through forms: its question tool's questions, a plugin's or a server's (T3 Code's formQuestions and formAnswer). String
// and multiselect fields are the question dialog's questions, their options its choices; a field the dialog cannot show is named.
const FORM_FIELD_NAMES=Object.freeze({external:"a link to open",boolean:"a yes or no answer",number:"a number",integer:"a whole number"});
const formText=value=>typeof value==="string"?value.trim():"";
export function openCode2FormQuestions(form){
  const fields=Array.isArray(form?.fields)?form.fields:[],questions=[];
  if(!fields.length)return {unsupported:"an answer to a form with no questions"};
  for(const [index,field] of fields.entries()){
    const type=String(field?.type||"");
    if(type!=="string"&&type!=="multiselect")return {unsupported:FORM_FIELD_NAMES[type]||`a value of type ${type||"unknown"}`};
    if(field.hidden===true)return {unsupported:"a hidden field"};
    if(Array.isArray(field.when)&&field.when.length)return {unsupported:"a field that depends on another"};
    const header=formText(field.title)||`Question ${index+1}`;
    const options=(Array.isArray(field.options)?field.options:[]).filter(option=>formText(option?.value)||formText(option?.label)).map(option=>({label:formText(option.label)||formText(option.value),description:formText(option.description),value:formText(option.value)?String(option.value):formText(option.label)}));
    // Choices only, unless the field takes the person's own words too (or offers no choices).
    questions.push({id:String(field.key),header,question:formText(field.description)||header,multiSelect:type==="multiselect",options,...(field.custom===true||!options.length?{}:{allowCustomAnswer:false})});
  }
  return {questions};
}
// The answers by field key: a multiselect's as a list, a string's joined.
export function openCode2FormAnswer(form,answers={}){
  const answer={};
  for(const field of Array.isArray(form?.fields)?form.fields:[]){
    const raw=answers?.[field.key],values=(Array.isArray(raw)?raw:[raw]).filter(value=>typeof value==="string"&&value.trim());
    if(values.length)answer[field.key]=field.type==="multiselect"?values:values.join(", ");
  }
  return answer;
}
// A form cancelled with a message fails its tool with that message and the model goes on; one cancelled without a message stops the
// asking session's run, as Stop does. A question the person dismissed (the dialog's Cancel and close answer with nothing) or left
// unanswered until the window stopped waiting is cancelled without one, as T3 Code cancels it, and this session's turn ends saying so.
const FORM_UNANSWERED=Object.freeze({dismissed:"OpenCode's question was dismissed, so Trebell declined it and stopped the turn.",unanswered:"OpenCode's question was not answered in time, so Trebell declined it and stopped the turn."});
const FORM_GONE=new Set(["FormNotFoundError","FormAlreadySettledError","SessionNotFoundError"]);
function untilAborted(promise,signal){
  if(signal.aborted)return Promise.resolve(null);
  return new Promise((resolve,reject)=>{
    const onAbort=()=>resolve(null);signal.addEventListener("abort",onAbort,{once:true});
    promise.then(value=>{signal.removeEventListener("abort",onAbort);resolve(value)},error=>{signal.removeEventListener("abort",onAbort);reject(error)});
  });
}
function errorText(error){
  if(!error)return "OpenCode request failed";
  return String(error?.message||error?.data?.message||error?._tag||error).slice(0,2000);
}
// OpenCode 2 types a usage window or budget the provider says is used up as provider.quota (HTTP 429) or provider.rate-limit: a usage
// limit, whose failure says where to check it. An empty balance is provider.quota too, with HTTP 402, and never resets, so OpenCode's
// own message (where to add credit) stands alone (T3 Code).
export const OPENCODE_USAGE_LIMIT_HINT="See Usage for your OpenCode limits.";
function executionFailure(error){
  const type=String(error?.type||""),usageLimit=(type==="provider.quota"&&Number(error?.status)!==402)||type==="provider.rate-limit";
  if(!usageLimit)return {text:errorText(error),usageLimit};
  const said=String(error?.message||"").trim().replace(/[\s.]+$/,"");
  return {text:`${said||"OpenCode reached a usage limit"}. ${OPENCODE_USAGE_LIMIT_HINT}`,usageLimit};
}
// OpenCode 2 sends a heartbeat on its event stream every 10 to 15 seconds, so a stream that has sent nothing for this long while the
// session waits on it is lost (T3 Code's client and OpenCode's own app wait as long), as is one that ends or fails. As T3 Code follows
// its stream, the session subscribes again, up to five times two seconds apart, and a new stream counts once OpenCode has said which
// sessions it still runs: a turn whose run goes on goes on, with what it said meanwhile read back from the session's history, one whose
// run ended meanwhile ends as that history says, and the questions and approvals asked meanwhile are asked again. A turn the session
// cannot follow again ends saying so, and its run is stopped; the next turn subscribes first, and asks OpenCode before it sends.
const SILENT_STREAM_MS=45_000,RECONNECT_ATTEMPTS=5,RECONNECT_DELAY_MS=2_000,RECONNECT_OPEN_MS=5_000,RECONNECT_CHECK_MS=5_000,INTERRUPT_MS=10_000;
const STREAM_LOST=Object.freeze({
  unreachable:"Trebell lost its connection to OpenCode's event stream and could not reconnect, so it stopped following the turn. Send the message again to retry.",
  unknown:"Trebell lost OpenCode's event stream, and OpenCode did not say whether it still runs the turn, so Trebell stopped following it. Send the message again to retry.",
  unsent:"OpenCode never confirmed the message and is not running it, so Trebell stopped the turn. Send the message again to retry.",
});
// A message sent after a turn Trebell stopped following waits for OpenCode to say that turn's run has ended (T3 Code's
// OPENCODE_2_STILL_STOPPING), so that run's text and end reach no turn of the new message's.
const AFTER_LOST_TURN=Object.freeze({
  running:"OpenCode was still running the turn Trebell stopped following, so Trebell stopped that run and did not send this message. Send the message again in a moment.",
  unknown:"OpenCode did not say whether it still runs the turn Trebell stopped following, so Trebell did not send this message. Send the message again in a moment.",
});
const ENDED_FAILED="OpenCode ended the turn with an error while Trebell was reconnecting to it.";
// A turn's history is read back to its own message, at most this many messages a page and this many pages.
const HISTORY_PAGE=50,HISTORY_PAGES=20;
const after=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Trebell's repository tools are an MCP server of the session's folder, which OpenCode drops when it evicts an idle folder, so it is
// added again before every turn; adding an unchanged config keeps its connection (T3 Code).
const MCP_ADD_TIMEOUT_MS=5_000;
// How long a resumed session's open requests are listed, and then stopped, before the session goes on without (T3 Code: 5 and 10 s).
const LEFTOVER_LIST_MS=5_000,LEFTOVER_STOP_MS=10_000;
function permissionDecision(value){return value==="accept"||value==="acceptForSession"?"once":"reject"}
function permissionTitle(data){
  const action=String(data?.action||"tool"),resources=(Array.isArray(data?.resources)?data.resources:[]).map(String).filter(Boolean);
  return data?.message||(`OpenCode · ${action}`+(resources.length?` · ${resources.slice(0,2).join(", ")}`:""));
}
function outputText(content){
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(item=>typeof item==="string"?item:typeof item?.text==="string"?item.text:"").join("");
}

export class OpenCode2AgentSession extends OpenCodeAgentSession{
  // loadClient: the @opencode/client module the session drives (tests pass a stand-in).
  constructor(options={}){
    super(options);
    this.version=String(options.version||"");this.loadClient=typeof options.loadClient==="function"?options.loadClient:loadOpenCodeClient;
    // The forms waiting on the person, by form ID: {controller, answering}.
    this.forms=new Map();
    // The permission requests handled, by request ID, so one asked again after a reconnect is not answered twice; following: whether the
    // session follows OpenCode's event stream (#follow); unsettled: a turn ended that OpenCode may still run (#lose).
    this.permissionsHandled=new Set();this.following=false;this.unsettled=false;
    this.appliedSelection=null;
    this.sessionRules=[];
    this.messageText=new Map();
    this.reasoningText=new Map();
    this.toolNames=new Map();
    this.sessionParents=new Map();
    this.sessionGrants=[];
    this.agentIds=new Map();
  }

  async start({providerSessionId=null,model=null}={}){
    const {OpenCode}=await this.loadClient();
    this.server=await startOpenCode2Server({command:this.command,cwd:this.cwd,env:this.env,serverUrl:this.serverUrl});
    if(this.closed){this.server.close?.();throw new Error("OpenCode was stopped while it started.")}
    this.server.child?.once?.("exit",(code,signal)=>{this.serverExit={code,signal}});
    this.client=clientFor(OpenCode,this.server);
    await openCode2ServerInfo(this.client);
    const location={directory:this.cwd};
    await this.#addRepositoryMcp();
    // The commands (OpenCode lists MCP prompts among them, which can take long), skills and agents hold up nothing: the composer gets
    // them, and a turn's agent its id, whenever OpenCode lists them.
    const [commands,skills,agents]=openCode2InventoryReads(this.client,location,{listMs:null}),announce=openCodeListsAsListed(this,{commands,skills,agents},{agents:openCode2PrimaryAgents});
    void agents.then(list=>{for(const entry of list||[]){const id=String(entry?.id||"").trim(),name=String(entry?.name||"").trim();if(id){this.agentIds.set(id,id);if(name)this.agentIds.set(name,id)}}});
    const [modelResult,defaultResult]=await Promise.all([
      waitForOpenCode2Models(this.client,location,{requiredModel:model}),
      this.client.model.default({location}).catch(()=>({data:null})),
    ]);
    for(const entry of Array.isArray(modelResult?.data)?modelResult.data:[]){
      if(entry?.enabled===false)continue;
      const id=modelKey(entry);if(!id)continue;
      const variants=variantsOf(entry);
      this.modelMap.set(id,modelRef(id));
      this.modelNames.set(id,String(entry.name||id));this.modelVariants.set(id,variants);
      if(Number(entry.limit?.context)>0)this.contextByModel.set(id,Number(entry.limit.context));
    }
    const requestedId=String(model||"").trim(),requested=this.modelMap.has(requestedId)?requestedId:null;
    if(requestedId&&!requested)throw new Error(`Model unavailable: ${requestedId}`);
    const defaultId=modelKey(defaultResult?.data);
    this.model=requested||(this.modelMap.has(defaultId)?defaultId:[...this.modelMap.keys()][0]||null);
    let info=null;
    if(providerSessionId){
      try{info=await this.client.session.get({sessionID:String(providerSessionId)})}
      catch(error){
        if(error?._tag==="SessionNotFoundError"||/not found/i.test(errorText(error)))throw new HarnessSessionLostError(`OpenCode could not resume this conversation: ${errorText(error)}`,{harness:"opencode",sessionId:providerSessionId});
        throw error;
      }
    }
    this.sessionRules=v2Rules(this.permissionMode,{repositoryMcp:this.repositoryMcp,grants:this.sessionGrants});
    if(!info)info=await this.client.session.create({location,permissions:this.sessionRules});
    this.sessionId=String(info.id);
    if(providerSessionId){await this.#stopLeftoverRequests();await this.#applyPermissionRules()}
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    const availableModels=[...this.modelMap.keys()];
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:this.modelNames.get(modelId)||modelId}))},configOptions:[],modes:{currentModeId:String(info.agent||"build"),availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    announce({status:{type:"idle"}});
    this.#follow();
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  // A resumed session's run may still wait on a question or an approval asked while Trebell was not there (a profile's own server
  // outlives Trebell): nothing would ever answer it, and the thread's next prompt would wait behind that run. As T3 Code does when it
  // resumes a session (stopLeftoverRequests), each is stopped without a message, which ends the run; requests OpenCode cannot list in
  // time are left as they are.
  async #stopLeftoverRequests(){
    const sessionID=this.sessionId;
    const listed=await openCode2Within(LEFTOVER_LIST_MS,"OpenCode did not list the session's open requests.",signal=>Promise.all([this.client.permission.list({sessionID},{signal}),this.client.session.form.list({sessionID},{signal})])).catch(()=>null);
    if(!listed)return;
    const [permissions,forms]=listed.map(list=>Array.isArray(list)?list:[]);
    await openCode2Within(LEFTOVER_STOP_MS,"OpenCode did not take the session's open requests back.",()=>Promise.allSettled([
      ...permissions.map(request=>this.client.permission.reply({sessionID,requestID:String(request.id),decision:"reject"})),
      ...forms.map(form=>this.#cancelForm({id:form.id,sessionID})),
    ])).catch(()=>{});
  }
  // A turn whose add fails goes on without the repository tools, and the session's MCP status says why.
  async #addRepositoryMcp(){
    if(!this.repositoryMcp)return;
    const name=String(this.repositoryMcp.name),config=this.repositoryMcp.openCode||{};
    try{
      await openCode2Within(MCP_ADD_TIMEOUT_MS,`OpenCode did not add Trebell's repository tools within ${MCP_ADD_TIMEOUT_MS/1000} seconds.`,signal=>this.client.mcp.add({server:name,location:{directory:this.cwd},config:{
        type:"local",command:Array.isArray(config.command)?config.command.map(String):[String(this.repositoryMcp.command),...(this.repositoryMcp.args||[])],
        ...(config.environment?{environment:Object.fromEntries(Object.entries(config.environment).map(([key,value])=>[key,String(value)]))}:{}),
        disabled:config.enabled===false,
        ...(Number(config.timeout)>0?{timeout:{startup:Number(config.timeout)}}:{}),
      }},{signal}));
      this.repositoryMcpStatus=[{name,configured:true,status:"connected"}];
    }catch(error){this.repositoryMcpStatus=[{name,configured:false,error:errorText(error)}]}
    if(this.sessionSetup)this.sessionSetup.trebellRepositoryMcp=this.repositoryMcpStatus[0];
  }
  #selection(){
    const selected=modelRef(this.model);if(!selected)return null;
    const variants=this.modelVariants.get(this.model)||[],variant=this.variant&&variants.includes(this.variant)?this.variant:null;
    return {...selected,...(variant?{variant}:{})};
  }
  async #applySelection(){
    const selected=this.#selection();if(!selected||!this.client||!this.sessionId)return;
    const fingerprint=JSON.stringify(selected);if(fingerprint===this.appliedSelection)return;
    await this.client.session.switchModel({sessionID:this.sessionId,model:selected});
    this.appliedSelection=fingerprint;
  }
  async #applyPermissionRules(){
    if(!this.client||!this.sessionId)return;
    this.sessionRules=v2Rules(this.permissionMode,{repositoryMcp:this.repositoryMcp,grants:this.sessionGrants});
    await this.client.session.update({sessionID:this.sessionId,permissions:this.sessionRules});
  }
  async setPermissionMode(mode){
    this.permissionMode=normalizePermissionMode(mode||"supervised");
    if(this.client&&this.sessionId)await this.#applyPermissionRules();
    return this.permissionMode;
  }
  setReasoningEffort(value){this.variant=typeof value==="string"&&value.trim()?value.trim():null;this.appliedSelection=null;return this.variant}
  async setModel(model){if(this.modelMap.has(String(model||""))){this.model=String(model);this.appliedSelection=null}return {modelId:this.model}}

  async prompt(parts,{agent=null,onDelivered=null}={}){
    if(!this.client||!this.sessionId)throw new Error("OpenCode session is not started.");
    if(this.activePrompt)throw new Error("OpenCode already has a running turn.");
    await this.#afterLostTurn();
    await this.#addRepositoryMcp();await this.#applySelection();await this.#applyPermissionRules();
    if(agent){const agentId=this.agentIds.get(String(agent))||String(agent);await this.client.session.switchAgent({sessionID:this.sessionId,agent:agentId})}
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    // A session that could not reconnect to its stream follows it again before it sends, so the turn's events reach it.
    if(!this.following)await Promise.race([this.#follow(),after(RECONNECT_OPEN_MS)]);
    let settleTurn=()=>{};const completion=new Promise(resolve=>{settleTurn=resolve});
    const input=await openCode2PromptInput(parts,{external:Boolean(this.serverUrl)});
    // stopError: why Trebell ended the turn itself (a retry it will not wait for, a question it cannot show). text: the reply the window
    // has, made of its text blocks (#block).
    const turn={done:false,cancelled:false,error:null,stopError:null,text:"",blocks:new Map(),assistantMessageId:null,startedAt:Date.now(),completion,settle:settleTurn};
    this.activePrompt=turn;
    try{
      // A turn Trebell ended (Stop, an event stream gone silent) does not wait on a prompt request OpenCode never answered. The message
      // is OpenCode's once the request answers, the turn ended or not (onDelivered).
      const ended=turn.completion.then(()=>turn.stopError||turn.cancelled?STOPPED:new Promise(()=>{}));
      const posted=this.client.session.prompt({sessionID:this.sessionId,text:input.text,...(input.files.length?{files:input.files}:{})});
      // accepted: OpenCode took the message, whose id starts the turn's history (#turnHistory). One it takes after Trebell stopped
      // following the turn has its run stopped, unless a later turn runs by then.
      void posted.then(value=>{turn.accepted=value||{};if(turn.lost&&!this.activePrompt&&!this.closed)void this.#interrupt()},()=>{});
      if(typeof onDelivered==="function")void posted.then(()=>{try{onDelivered()}catch{}},()=>{});
      const accepted=await Promise.race([posted,ended]);
      await turn.completion;
      if(turn.stopError)throw turn.stopError;
      if(turn.cancelled)return {stopReason:"cancelled",providerMessageId:null,assistantMessageId:turn.assistantMessageId,raw:accepted===STOPPED?null:accepted};
      if(turn.error)throw Object.assign(new Error(turn.error),turn.usageLimit?{usageLimit:true}:{});
      // Only the messages since the turn's own count: OpenCode's newest assistant message may be an earlier turn's.
      const since=await this.#turnHistory(turn).catch(()=>null)||[];
      const user=since.findLast(item=>item?.type==="user"),assistant=since.findLast(item=>item?.type==="assistant");
      if(assistant?.id)turn.assistantMessageId=assistant.id;
      if(assistant?.error)throw new Error(errorText(assistant.error));
      if(assistant?.finish==="error")throw new Error("OpenCode reported that the model turn failed.");
      this.#showRest(turn,since);
      return {stopReason:"end_turn",providerMessageId:user?.id||accepted?.id||null,assistantMessageId:turn.assistantMessageId,raw:assistant||accepted};
    }finally{turn.done=true;turn.settle?.();if(this.activePrompt===turn)this.activePrompt=null}
  }
  // After a turn Trebell stopped following (#lose), OpenCode says whether it still runs that turn's message before the next one is sent,
  // as T3 Code asks before it starts a turn on an unsettled session: a run that goes on is stopped, and this message is refused.
  async #afterLostTurn(){
    if(!this.unsettled)return;
    const runs=await openCode2Within(RECONNECT_CHECK_MS,AFTER_LOST_TURN.unknown,signal=>this.client.session.active({signal})).catch(()=>null);
    if(!runs||typeof runs!=="object")throw new Error(AFTER_LOST_TURN.unknown);
    if(Object.hasOwn(runs,this.sessionId)){await this.#interrupt();throw new Error(AFTER_LOST_TURN.running)}
    this.unsettled=false;
  }
  #interrupt(){
    return openCode2Within(INTERRUPT_MS,"OpenCode did not stop the run.",signal=>this.client.session.interrupt({sessionID:this.sessionId},{signal})).catch(()=>null);
  }
  // The session's history since the turn's own message, oldest first, as T3 Code reads it back; null when it does not reach that message.
  async #turnHistory(turn){
    const start=String(turn?.accepted?.id||"");if(!start)return null;
    const read=[];let cursor=null;
    for(let page=0;page<HISTORY_PAGES;page++){
      const listed=await this.client.message.list({sessionID:this.sessionId,order:"desc",limit:HISTORY_PAGE,...(cursor?{cursor}:{})});
      const items=Array.isArray(listed?.data)?listed.data:[];
      for(const item of items){if(String(item?.id||"")===start)return read.reverse();read.push(item)}
      cursor=listed?.cursor?.next||null;if(!cursor||!items.length)break;
    }
    return null;
  }
  // A text block of the turn's reply (an assistant message's text part, by its ordinal), as far as the window shows it. held: shown on only
  // at its end, which carries its whole text (#backfill).
  #block(turn,messageID,ordinal){
    const key=`${messageID}:${Number(ordinal)||0}`;let block=turn.blocks.get(key);
    if(!block){block={text:"",held:false};turn.blocks.set(key,block)}
    return block;
  }
  #show(turn,block,text){
    if(!text)return;block.text+=text;turn.text+=text;
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}});
  }
  // The reply as OpenCode keeps it, its messages' text blocks in order: the part the window does not have yet (text OpenCode did not
  // stream) is sent once; a reply that differs from the window's is left as the window shows it.
  #showRest(turn,since){
    const full=since.filter(item=>item?.type==="assistant").flatMap(item=>(Array.isArray(item.content)?item.content:[]).filter(part=>part?.type==="text").map(part=>String(part.text||""))).join("");
    if(full.length<=turn.text.length||!full.startsWith(turn.text))return;
    const rest=full.slice(turn.text.length);turn.text=full;
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:rest}}});
  }

  async steer(parts){
    if(!this.client||!this.sessionId||!this.activePrompt)throw new Error("OpenCode has no running turn to steer.");
    const input=await openCode2PromptInput(parts,{external:Boolean(this.serverUrl)});const accepted=await this.client.session.prompt({sessionID:this.sessionId,text:input.text,...(input.files.length?{files:input.files}:{}),delivery:"steer"});
    return {accepted:true,pending:0,providerMessageId:accepted?.id||null};
  }
  async cancel(){
    const turn=this.activePrompt;if(turn)turn.cancelled=true;
    if(this.client&&this.sessionId)await this.client.session.interrupt({sessionID:this.sessionId}).catch(()=>{});
    turn?.settle?.();
  }
  async compact(){
    if(!this.client||!this.sessionId)throw new Error("OpenCode session is not started.");
    return await this.client.session.compact({sessionID:this.sessionId});
  }
  async fork(){
    if(this.activePrompt)throw new Error("Stop the running OpenCode turn before forking this thread.");
    const before=await this.client.message.list({sessionID:this.sessionId,order:"asc",limit:1000});
    const forked=await this.client.session.fork({sessionID:this.sessionId});
    const after=await this.client.message.list({sessionID:forked.id,order:"asc",limit:1000});
    const source=Array.isArray(before?.data)?before.data:[],copies=Array.isArray(after?.data)?after.data:[];
    return {...forked,sessionId:forked.id,messageIds:source.map((item,index)=>[String(item?.id||""),String(copies[index]?.id||"")]).filter(([a,b])=>a&&b),tailId:null};
  }
  async rewind(messageID){
    if(this.activePrompt)throw new Error("Stop the running OpenCode turn before rewinding this thread.");
    const boundary=String(messageID||"");if(!boundary)throw Object.assign(new Error("OpenCode could not rewind to this turn."),{code:"OPENCODE_REWIND_TARGET_MISSING"});
    const forked=await this.client.session.fork({sessionID:this.sessionId,boundary:{type:"before",messageID:boundary}});
    this.sessionId=String(forked.id);if(this.sessionSetup)this.sessionSetup.sessionId=this.sessionId;
    await this.#applyPermissionRules();this.appliedSelection=null;await this.#applySelection();
    return {sessionId:this.sessionId,messageIds:[],tailId:null};
  }
  async close(){
    if(this.closed)return;this.closed=true;
    if(this.activePrompt){this.activePrompt.cancelled=true;this.activePrompt.settle?.()}
    for(const pending of this.forms.values())pending.controller.abort();this.forms.clear();
    this.eventAbort.abort();
    if(this.client&&this.sessionId)await this.client.session.interrupt({sessionID:this.sessionId}).catch(()=>{});
    this.server?.close?.();
    await Promise.race([this.eventTask||Promise.resolve(),new Promise(resolve=>setTimeout(resolve,1000))]).catch(()=>{});
  }

  async #belongs(sessionID){
    const id=String(sessionID||"");if(!id)return false;if(id===this.sessionId)return true;
    if(this.sessionParents.has(id))return this.sessionParents.get(id);
    let current=id;
    for(let depth=0;depth<8;depth++){
      try{
        const session=await this.client.session.get({sessionID:current}),parent=String(session?.parentID||"");
        if(parent===this.sessionId){this.sessionParents.set(id,true);return true}
        if(!parent)break;current=parent;
      }catch{break}
    }
    this.sessionParents.set(id,false);return false;
  }
  async #permission(data){
    // One request is answered once, also when it is listed again after a reconnect (#askOpenRequests).
    const requestID=String(data?.id||"");if(!requestID||this.permissionsHandled.has(requestID))return;
    if(!(await this.#belongs(data?.sessionID)))return;
    if(this.permissionsHandled.has(requestID))return;this.permissionsHandled.add(requestID);
    const kind=String(data?.action||""),disposition=openCodePermissionDisposition(this.permissionMode,kind);
    let decision=disposition==="allow"?"accept":disposition==="deny"?"decline":"decline";
    if(disposition==="ask"&&this.onPermission){
      const options=[{optionId:"once",name:"Allow once",kind:"allow_once"},...(Array.isArray(data?.save)&&data.save.length?[{optionId:"always",name:"Allow session",kind:"allow_always"}]:[]),{optionId:"reject",name:"Reject",kind:"reject_once"}];
      const toolCall={title:permissionTitle(data),toolCallId:String(data?.id||""),rawInput:{...(data?.metadata||{}),resources:Array.isArray(data?.resources)?data.resources:[]},kind:normalizePermissionKind(kind)};
      decision=await Promise.resolve().then(()=>this.onPermission({method:"permission",params:{toolCall,permissionType:kind,options}})).then(value=>value||"decline",()=>"decline");
    }
    if(decision==="acceptForSession"&&String(data.sessionID)===this.sessionId){
      const resources=(Array.isArray(data?.save)&&data.save.length?data.save:data?.resources)||[];
      for(const resource of resources.map(String).filter(Boolean))if(!this.sessionGrants.some(grant=>grant.action===kind&&grant.resource===resource))this.sessionGrants.push({action:kind,resource,effect:"allow"});
      await this.#applyPermissionRules().catch(()=>{});
    }
    const refusal=openCodeRefusal(decision,{disposition,mode:this.permissionMode,action:kind,resources:data?.resources});
    // A refused shell call reaches the model only as "Unable to execute command", which it retries, so the reason is steered into the
    // session before the refusal (as T3 Code does); the refusal stands without it.
    if(refusal)await this.client.session.synthetic({sessionID:String(data.sessionID),text:refusal.note,delivery:"steer",resume:false}).catch(()=>{});
    await this.client.permission.reply({sessionID:String(data.sessionID),requestID:String(data.id),decision:permissionDecision(decision),...(refusal?{message:refusal.reason}:{})}).catch(()=>{});
  }
  // One subscription to the event stream: opened resolves true at its first chunk (OpenCode 2 sends server.connected at once) and false
  // if it ends before; ended once it has ended, however it ended; drop lets go of it. Every chunk the stream receives counts (onActivity),
  // OpenCode's heartbeats among them. The silence counts only while the session waits for the stream, as T3 Code's timeout runs only
  // while a read waits, so an approval the person takes minutes over is no silence of the stream's. (@opencode/client 2.0.24 reads the
  // stream in the background and reports its heartbeats meanwhile; a subscription it is told to let go of ends quietly.) A stream opened
  // again holds its events until gate settles, once the session has caught up with what it missed (#reconnected), as T3 Code's events
  // wait for its reconcile.
  #subscribe(gate=null){
    const silence=new AbortController(),signal=AbortSignal.any([this.eventAbort.signal,silence.signal]);
    let timer=null,open=()=>{};const opened=new Promise(resolve=>{open=resolve});
    const waiting=()=>{clearTimeout(timer);timer=setTimeout(()=>silence.abort(),SILENT_STREAM_MS)};
    const ended=(async()=>{
      try{
        waiting();
        for await(const event of this.client.event.subscribe({signal,onActivity:()=>{open(true);waiting()}})){
          clearTimeout(timer);if(this.closed)break;
          if(gate){await gate;gate=null;if(signal.aborted)break}
          try{await this.#event(event)}catch(error){if(!this.closed)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:errorText(error)}})}
          waiting();
        }
      // A stream that failed (a Transport error), like one Trebell let go of, is followed again: neither is an error of the turn's.
      }catch{}
      finally{clearTimeout(timer);open(false)}
    })();
    return {opened,ended,drop:()=>silence.abort()};
  }
  // The event stream, followed while the session is open (T3 Code's follow): a lost stream is subscribed to again (RECONNECT_ATTEMPTS
  // times, RECONNECT_DELAY_MS apart), and a new one counts once the session has caught up with what it missed (#reconnected); if none
  // does, a running turn ends saying so (#lose). The promise tells whether the first subscription opened.
  #follow(){
    this.following=true;let first=this.#subscribe();
    this.eventTask=(async()=>{
      for(let stream=first;stream&&!this.closed;){
        await stream.ended;if(this.closed)break;
        stream=null;let opened=false;
        for(let attempt=0;attempt<RECONNECT_ATTEMPTS&&!this.closed&&!stream;attempt++){
          if(attempt)await after(RECONNECT_DELAY_MS);if(this.closed)break;
          let caughtUp=()=>{};const next=this.#subscribe(new Promise(resolve=>{caughtUp=resolve}));
          const open=await Promise.race([next.opened,after(RECONNECT_OPEN_MS).then(()=>false)]);opened||=open;
          if(open&&await this.#reconnected().catch(()=>false))stream=next;else next.drop();
          caughtUp();if(!stream)await next.ended;
        }
        if(!stream&&!this.closed)this.#lose(this.activePrompt,opened?STREAM_LOST.unknown:STREAM_LOST.unreachable);
      }
      this.following=false;
    })();
    return first.opened;
  }
  // A turn the session stopped following ends with the reason. OpenCode may still run its message, so that run is stopped (once
  // OpenCode has the message: interrupt false when it does not yet) and the next message asks OpenCode first (#afterLostTurn).
  #lose(turn,reason,{interrupt=true}={}){
    if(!turn||turn.done||turn.cancelled||turn.stopError||this.activePrompt!==turn)return;
    turn.lost=true;turn.stopError=new Error(reason);this.unsettled=true;turn.settle?.();
    if(interrupt)void this.#interrupt();
  }
  // Once the session listens again, OpenCode says which sessions it still runs (session.active), and a new stream counts only once it
  // has (true): T3 Code's reconnect includes this check and tries again without it. A turn whose run goes on goes on, with the text it
  // missed read back from the session's history (#backfill), and the questions and approvals of the session and its subagents that came
  // while Trebell was not listening are asked; a turn whose run ended meanwhile ends as that history says (#endedMeanwhile), and one
  // whose message OpenCode never took ends saying so.
  async #reconnected(){
    const turn=this.activePrompt;
    const runs=await openCode2Within(RECONNECT_CHECK_MS,"OpenCode did not say which sessions it runs.",signal=>this.client.session.active({signal}));
    if(this.closed)return true;
    if(!runs||typeof runs!=="object")return false;
    const live=()=>turn&&!turn.done&&!turn.cancelled&&!turn.stopError&&this.activePrompt===turn,going=Object.hasOwn(runs,this.sessionId);
    if(live()&&!going&&!turn.accepted)this.#lose(turn,STREAM_LOST.unsent,{interrupt:false});
    else if(live()&&turn.accepted){
      const since=await this.#turnHistory(turn);
      if(live())going?this.#backfill(turn,since):this.#endedMeanwhile(turn,since);
    }
    for(const sessionID of [this.sessionId,...[...this.sessionParents].filter(([,mine])=>mine).map(([id])=>id)])if(Object.hasOwn(runs,sessionID))void this.#askOpenRequests(sessionID);
    return true;
  }
  // What the run said while Trebell was not listening (T3 Code's backfill): each text block OpenCode has kept since the turn's message is
  // shown on from where the window's copy of it ends, and then held until OpenCode ends it (session.text.ended carries its whole text),
  // so what the new stream sends again of it is not shown twice.
  #backfill(turn,since){
    for(const message of since||[]){
      if(message?.type!=="assistant")continue;let ordinal=0;
      for(const part of Array.isArray(message.content)?message.content:[]){
        if(part?.type!=="text")continue;
        const block=this.#block(turn,message.id,ordinal++),text=String(part.text||"");
        if(text.startsWith(block.text))this.#show(turn,block,text.slice(block.text.length));
        block.held=true;
      }
    }
  }
  // A run that ended while Trebell was not listening ends as the session's history says (T3 Code's reconcile): by the idle item OpenCode
  // keeps for a run's end, since the turn's own message. Without one (a restarted server keeps none for the run it lost) the run was
  // stopped, and so is the turn.
  #endedMeanwhile(turn,since){
    const outcome=String(since?.findLast(item=>item?.type==="idle")?.outcome||"");
    if(outcome==="failed"){
      const error=since.findLast(item=>item?.type==="assistant")?.error,failure=error?executionFailure(error):{text:ENDED_FAILED,usageLimit:false};
      turn.error=failure.text;turn.usageLimit=failure.usageLimit;
    }else if(outcome!=="succeeded")turn.cancelled=true;
    turn.settle?.();
  }
  async #askOpenRequests(sessionID){
    const listed=await openCode2Within(RECONNECT_CHECK_MS,"OpenCode did not list the session's open requests.",signal=>Promise.all([this.client.permission.list({sessionID},{signal}),this.client.session.form.list({sessionID},{signal})])).catch(()=>null);
    if(!listed||this.closed)return;
    const [permissions,forms]=listed.map(list=>Array.isArray(list)?list:[]);
    for(const form of forms)this.#askForm({...form,sessionID:String(form?.sessionID||sessionID)});
    for(const request of permissions)void this.#permission({...request,sessionID:String(request?.sessionID||sessionID)}).catch(()=>{});
  }
  async #event(event){
    const data=event?.data||{},sessionID=String(data.sessionID||"");
    if(sessionID&&!(await this.#belongs(sessionID)))return;
    const turn=this.activePrompt;
    if(event.type==="permission.asked")return await this.#permission(data);
    // A form names its session inside it. The question waits on the person without holding the event stream.
    if(event.type==="form.created"){const form=data.form||{};if(await this.#belongs(form.sessionID))this.#askForm(form);return}
    if(event.type==="form.replied"||event.type==="form.cancelled")return this.#formSettled(String(data.id||""));
    if(event.type==="session.retry.scheduled")return this.#retry(event,sessionID);
    if(event.type==="session.text.delta"&&turn&&sessionID===this.sessionId){
      const delta=String(data.delta||"");if(!delta)return;turn.assistantMessageId=String(data.assistantMessageID||turn.assistantMessageId||"")||null;
      const block=this.#block(turn,data.assistantMessageID,data.ordinal);if(!block.held)this.#show(turn,block,delta);return;
    }
    // A block held since a reconnect is shown on at its end.
    if(event.type==="session.text.ended"&&turn&&sessionID===this.sessionId){
      const block=this.#block(turn,data.assistantMessageID,data.ordinal),text=String(data.text||"");
      if(block.held){block.held=false;if(text.startsWith(block.text))this.#show(turn,block,text.slice(block.text.length))}return;
    }
    if(event.type==="session.reasoning.delta"&&turn&&sessionID===this.sessionId){
      const delta=String(data.delta||"");if(delta)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:delta},messageId:String(data.assistantMessageID||"reasoning")}});return;
    }
    if(event.type==="session.usage.updated"&&sessionID===this.sessionId){
      const tokens=data.tokens||{},used=Number(tokens.input||0)+Number(tokens.output||0)+Number(tokens.reasoning||0);
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used,size:this.contextByModel.get(this.model)||0,cost:data.cost!=null?{amount:Number(data.cost),currency:"USD"}:null,usage:{input_tokens:Number(tokens.input||0),output_tokens:Number(tokens.output||0),reasoning_tokens:Number(tokens.reasoning||0),cache_read_input_tokens:Number(tokens.cache?.read||0),cache_write_input_tokens:Number(tokens.cache?.write||0)}}});return;
    }
    if(event.type==="session.tool.input.started"){this.toolNames.set(String(data.id),String(data.name||"tool"));this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:String(data.id),title:String(data.name||"Tool"),kind:normalizePermissionKind(data.name),status:"in_progress",rawInput:{}}});return}
    if(event.type==="session.tool.called"){const id=String(data.id),name=this.toolNames.get(id)||"tool";this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"in_progress",rawInput:data.input||{}}});return}
    if(event.type==="session.tool.success"){const id=String(data.id),name=this.toolNames.get(id)||"tool",output=outputText(data.content);this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"completed",rawOutput:name==="read"?openCodeReadOutput(output):output}});return}
    if(event.type==="session.tool.failed"){const id=String(data.id),name=this.toolNames.get(id)||"tool";this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:id,title:name,kind:normalizePermissionKind(name),status:"failed",rawOutput:errorText(data.error)}});return}
    if(event.type==="session.execution.succeeded"&&turn&&sessionID===this.sessionId){turn.settle?.();return}
    if(event.type==="session.execution.failed"&&turn&&sessionID===this.sessionId){const failure=executionFailure(data.error);turn.error=failure.text;turn.usageLimit=failure.usageLimit;turn.settle?.();return}
    if(event.type==="session.execution.interrupted"&&turn&&sessionID===this.sessionId){turn.cancelled=true;turn.settle?.();return}
  }
  // A retry OpenCode schedules for this turn's request, or a subagent's, shows while Trebell waits for it (openCodeRetryNotice); one that
  // is hours away, or past OPENCODE_RETRY_LIMITS, ends the turn with the provider's reason (openCodeRetryStop), as OpenCode 1.x's does.
  #retry(event,sessionID){
    const turn=this.activePrompt;if(!turn||turn.done||turn.cancelled||turn.stopError)return;
    // OpenCode 2 counts the first request as attempt 1, so its first retry is attempt 2; the wait runs from when it was scheduled (T3).
    const data=event?.data||{},own=sessionID===this.sessionId,retry=Math.max(1,Math.floor(Number(data.attempt)||0)-1),created=Number(event?.created)||Date.now();
    const reason=openCodeRetryStop({type:"retry",attempt:retry,next:Number(data.at),message:data.error},{now:created,model:own?this.model:null});
    if(!reason){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",willRetry:true,message:openCodeRetryNotice({message:data.error,model:own?this.model:null,retry,waitMs:Number(data.at)-created,subagent:!own})}});return}
    turn.stopError=new Error(own?reason:`A subagent's model request failed: ${reason}`);turn.settle?.();
    for(const id of own?[this.sessionId]:[sessionID,this.sessionId])void Promise.resolve(this.client?.session?.interrupt?.({sessionID:id})).catch(()=>{});
  }
  // A form of this session or a subagent's goes to the question dialog (onQuestion) and is answered with what the person chose. One the
  // dialog cannot show is declined and ends the turn saying so, and so does one left unanswered (FORM_UNANSWERED). The card goes when
  // OpenCode settles the form elsewhere (form.replied, form.cancelled).
  #askForm(form){
    const formID=String(form?.id||"");if(!formID||this.forms.has(formID))return;
    const pending={controller:new AbortController(),answering:false};this.forms.set(formID,pending);
    void this.#answerForm(form,pending).catch(()=>{}).finally(()=>{if(this.forms.get(formID)===pending)this.forms.delete(formID)});
  }
  #formSettled(formID){
    const pending=this.forms.get(formID);if(!pending||pending.answering)return;
    this.forms.delete(formID);pending.controller.abort();
  }
  async #cancelForm(form,message=null){
    return await Promise.resolve(this.client?.session?.form?.cancel?.({sessionID:String(form.sessionID),formID:String(form.id),...(message?{message}:{})})).then(()=>true,error=>FORM_GONE.has(error?.name));
  }
  async #answerForm(form,pending){
    const sessionID=String(form.sessionID),formID=String(form.id),turn=this.activePrompt,own=sessionID===this.sessionId,mapped=openCode2FormQuestions(form);
    if(mapped.unsupported){
      pending.answering=true;
      const reason=`OpenCode asked for ${mapped.unsupported}, which Trebell Code's question dialog cannot show, so Trebell declined the question`;
      // The cancel stops this session's run (OpenCode's Stop) and the turn ends with the reason. A subagent is told the reason instead and
      // goes on: stopping it would not end the turn.
      if(!own||!turn||turn.done)return void await this.#cancelForm(form,reason+".");
      turn.stopError=new Error(reason+" and stopped the turn.");
      if(!(await this.#cancelForm(form)))await Promise.resolve(this.client?.session?.interrupt?.({sessionID})).catch(()=>{});
      turn.settle?.();return;
    }
    let answers=null;
    if(typeof this.onQuestion==="function")answers=await untilAborted(Promise.resolve().then(()=>this.onQuestion({toolName:"question",input:{questions:mapped.questions},signal:pending.controller.signal})),pending.controller.signal).catch(()=>null);
    // Settled elsewhere, or the session closed: there is nothing to send.
    if(pending.controller.signal.aborted||this.closed)return;
    pending.answering=true;
    // A stopped turn's run is ending, and the form with it.
    if(turn?.cancelled)return void await this.#cancelForm(form);
    const answer=openCode2FormAnswer(form,answers||{});
    if(!Object.keys(answer).length){
      // The cancel stops the asking session's run: this session's turn ends with the reason, set before OpenCode says the run stopped.
      // A subagent's question ends the subagent's run only, and the turn goes on as OpenCode goes on.
      const ends=own&&turn&&!turn.done&&!turn.cancelled&&!turn.stopError;
      if(ends)turn.stopError=new Error(answers?FORM_UNANSWERED.dismissed:FORM_UNANSWERED.unanswered);
      if(!(await this.#cancelForm(form))&&own)await Promise.resolve(this.client?.session?.interrupt?.({sessionID})).catch(()=>{});
      if(ends)turn.settle?.();
      return;
    }
    try{await this.client.session.form.reply({sessionID,formID,answer})}
    catch(error){
      if(FORM_GONE.has(error?.name))return;
      // OpenCode refused the answer (one that is not among the choices, say): the cancel's message fails the question tool with the reason,
      // which tells the model, and the person on the tool's row, while the turn goes on. (An error notice would end the window's turn.)
      await this.#cancelForm(form,`The user's answer could not be given: ${errorText(error)}. Continue without it, and tell the user what you would need from them.`);
    }
  }
}
