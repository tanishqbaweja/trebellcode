import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileUri, fileUriPath } from "./file-uri.mjs";
import { OpenCodeAgentSession, openCodeStartingVariant, openCode2InventoryReads, openCode2ModelId, openCode2PrimaryAgents, openCode2ServerInfo, openCode2Within, openCodeListsAsListed, openCodePermissionDisposition, openCodeSessionRules, openCodeQuestionText, unwrapOpenCodeRead, openCodeRefusal, openCodeToolTitle, openCodeRequestName, openCodeRetryNotice, openCodeRetryStop, startOpenCode2Server, waitForOpenCode2Models } from "./opencode-agent-session.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizePermissionKind, normalizePermissionMode } from "./permission-policy.mjs";
import { attachmentLine, unsentImageLine } from "./attachment-line.mjs";
import { PROMPT_IMAGE_PATH, PROMPT_TEXT_PATH } from "./prompt-attachments.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { isUserResponseTimeout } from "./user-response-timeout.mjs";

const STOPPED=Symbol("opencode2-stopped");
// The tools OpenCode titles by their input's description (#toolRow).
const DESCRIBED_TOOLS=new Set(["bash","shell","task"]);
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
  const rules=openCodeSessionRules(mode,{allowedTools:repositoryMcp?.name?[`${repositoryMcp.name}_*`]:[]});
  return [...rules.map(rule=>({action:v2Action(rule.permission),resource:String(rule.pattern||"*"),effect:rule.action==="allow"?"allow":rule.action==="deny"?"deny":"ask"})),...(Array.isArray(grants)?grants:[])];
}
// OpenCode 2 takes an attachment as a URI it reads itself ({uri, name}), and refuses the whole prompt when one is missing. A
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
    if(!path){text.push(pasted?unsentImageLine(name):attachmentLine("file",name,String(part.uri||"")));continue}
    text.push(attachmentLine(kind,name,path,part[PROMPT_TEXT_PATH]));
    if(native&&!external&&await fileExists(path))files.push({uri:fileUri(path),name});
  }
  return {text:text.join("\n"),files};
}
// OpenCode 2 asks the person through forms (its question tool's questions, a plugin's, a server's), and Trebell asks them in the
// window's question dialog, which takes words and choices: a field of the string or multiselect kind. A form is asked only when every
// field is one the dialog can ask; any other form is declined, naming what OpenCode asked for (the first field the dialog cannot ask).
const KIND_ASKED_FOR=new Map([["boolean","a yes or no answer"],["number","a number"],["integer","a whole number"],["external","a visit to a web page"]]);
const DIALOG_KINDS=new Set(["string","multiselect"]);
const trimmedText=value=>typeof value==="string"?value.trim():"";
const listOf=value=>Array.isArray(value)?value:[];
const hasWords=value=>typeof value==="string"&&value.trim()!=="";
// What a field asks for that the dialog cannot ask, or null when the dialog can ask it: its kind decides first, then whether OpenCode
// keeps it hidden, then whether it shows only on another field's answer (its conditions).
function beyondDialog(field){
  const kind=String(field?.type||"");
  if(!DIALOG_KINDS.has(kind))return KIND_ASKED_FOR.get(kind)??`a value of type ${kind||"unknown"}`;
  if(field.hidden===true)return "a field it keeps hidden";
  return Array.isArray(field.when)&&field.when.length>0?"a conditional field":null;
}
// The choices of a field as the dialog lists them: each option with a value or a label, shown by its label (else its value) and
// answering with its value (else its label).
function dialogChoices(options){
  return listOf(options).flatMap(option=>{
    const value=trimmedText(option?.value),label=trimmedText(option?.label);
    return value||label?[{label:label||value,description:trimmedText(option.description),value:value?option.value:label}]:[];
  });
}
// The dialog's question for the field at this place in the form (from 1). Only the choices answer a field with choices, unless the field
// takes the person's own words too (custom).
function dialogQuestion(field,place){
  const header=trimmedText(field.title)||`Question ${place}`,options=dialogChoices(field.options);
  const question={id:String(field.key),header,question:trimmedText(field.description)||header,multiSelect:field.type==="multiselect",options};
  if(options.length>0&&field.custom!==true)question.allowCustomAnswer=false;
  return question;
}
// OpenCode's reply from the dialog's answers by question id, which is the field's key: each field's answers that are words (blank ones
// dropped, the others as given), a multiselect's as their list and any other field's joined with ", "; a field without any is left out.
function formReply(fields,answers){
  const byKey=answers&&typeof answers==="object"?answers:{};
  return Object.fromEntries(fields.flatMap(field=>{
    if(field===null||typeof field!=="object")return [];
    const words=[byKey[field.key]].flat().filter(hasWords);
    return words.length>0?[[field.key,field.type==="multiselect"?words:words.join(", ")]]:[];
  }));
}
// A form as the question dialog asks it: declined (what OpenCode asked for that the dialog cannot ask, or null), the dialog's questions,
// reply(answers) for OpenCode's reply, and chosen(reply), each question's reply in the person's words: a choice by its label.
export function openCode2FormDialog(form){
  const fields=listOf(form?.fields);
  // Array.from visits every place of the list, an empty one as a field with no kind.
  const declined=fields.length===0?"an answer to a form with no questions":Array.from(fields,field=>beyondDialog(field)).find(reason=>reason!==null)??null;
  const questions=declined?[]:fields.map((field,index)=>dialogQuestion(field,index+1));
  const chosen=reply=>questions.map(question=>{
    const labels=new Map();for(const option of question.options)if(!labels.has(option.value))labels.set(option.value,option.label);
    return [reply?.[question.id]].flat().filter(Boolean).map(value=>labels.get(value)??value);
  });
  return {declined,questions,reply:answers=>formReply(fields,answers),chosen};
}
// A form cancelled with a message fails its tool with that message and the model goes on; one cancelled without a message stops the
// asking session's run, as Stop does. A question the person dismissed (the dialog's Cancel and close answer with nothing) or left
// unanswered until the window stopped waiting is cancelled without one, and this session's turn ends saying so.
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
// own message (where to add credit) stands alone.
export const OPENCODE_USAGE_LIMIT_HINT="See Usage for your OpenCode limits.";
function executionFailure(error){
  const type=String(error?.type||""),usageLimit=(type==="provider.quota"&&Number(error?.status)!==402)||type==="provider.rate-limit";
  if(!usageLimit)return {text:errorText(error),usageLimit};
  const said=String(error?.message||"").trim().replace(/[\s.]+$/,"");
  return {text:`${said||"OpenCode reached a usage limit"}. ${OPENCODE_USAGE_LIMIT_HINT}`,usageLimit};
}
// How the session follows OpenCode 2's event stream. OpenCode sends a heartbeat on it every 10 to 15 seconds, so a stream that has
// sent nothing for silentMs while the session waits on it is lost, as is one that ends or fails: 45 s, the idle time OpenCode's own
// client gives its event stream (defaultIdleTimeout in @opencode/client 2.0.24, which says the server writes a keepalive every 15 s).
// The session then subscribes again, at most tries times, the first at once and the others spacingMs apart. A new subscription has
// openMs to open, and counts once OpenCode has said within answerMs which sessions it still runs: a turn whose run goes on goes on,
// with what it said meanwhile read back from the session's history, one whose run ended meanwhile ends as that history says, and the
// questions and approvals asked meanwhile are asked again. A turn the session cannot follow again ends saying so, and its run is
// stopped; the next turn subscribes first, and asks OpenCode before it sends. Trebell's own tries and spacing: four, three seconds
// apart, about ten seconds in all, time for a restarted server or a network that dropped for a moment to come back, after which the
// person waiting on the turn is told it ended. answerMs bounds each question put to OpenCode after the stream came back or before a
// message goes out behind a turn Trebell stopped following: which sessions it still runs, and which requests it asked meanwhile.
// OpenCode answers both from memory; Trebell's own 6 s is 2.1.2's 5 s and a fifth more, room for a server slowed by whatever cost the
// stream, and a question it does not answer in time ends the turn, or refuses the message, saying so.
const STREAM_FOLLOW=Object.freeze({silentMs:45_000,tries:4,spacingMs:3_000,openMs:5_000,answerMs:6_000});
// How long OpenCode has to answer a stop of a run Trebell no longer follows (a lost turn's, one whose prompt answered after its turn
// ended, or one still running when the next message goes out): it can wait on the run's tools to end. Trebell's own 12 s, 2.1.2's
// 10 s and a fifth more. A stop not answered in time is let go; a message sent behind a lost turn asks again before it goes.
const INTERRUPT_MS=12_000;
const STREAM_LOST=Object.freeze({
  unreachable:"Trebell lost its connection to OpenCode's event stream and could not reconnect, so it stopped following the turn. Send the message again to retry.",
  unknown:"Trebell lost OpenCode's event stream, and OpenCode did not say whether it still runs the turn, so Trebell stopped following it. Send the message again to retry.",
  unsent:"OpenCode never confirmed the message and is not running it, so Trebell stopped the turn. Send the message again to retry.",
});
// A message sent after a turn Trebell stopped following waits for OpenCode to say that turn's run has ended, so that run's
// text and end reach no turn of the new message's. One refused is not sent: the window keeps
// its draft and puts the reason after "Not sent:".
const AFTER_LOST_TURN=Object.freeze({
  running:"OpenCode was still running the turn Trebell stopped following, so Trebell stopped that run. Send the message again in a moment.",
  unknown:"OpenCode did not say whether it still runs the turn Trebell stopped following. Send the message again in a moment.",
});
const FAILED_WITHOUT_REASON="OpenCode says this turn failed while Trebell was reconnecting, and it kept no reason for the failure.";
const RUN_LOST="OpenCode lost this turn's run while Trebell was reconnecting to it, so the turn did not finish. Send the message again to retry.";
// A turn's history is read back to its own message, at most this many messages a page and this many pages. Trebell's own 100 a page
// and ten pages: the same thousand messages back that 2.1.2 read (50 a page, 20 pages), in half the requests (OpenCode 2.0.24's
// message list takes a limit of 1 to 200).
const HISTORY_PAGE=100,HISTORY_PAGES=10;
const after=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Trebell's repository tools are an MCP server of the session's folder, which OpenCode drops when it evicts an idle folder, so it is
// added again before every turn; adding an unchanged config keeps its connection.
const MCP_ADD_TIMEOUT_MS=5_000;
// A resumed session waits at most listMs for OpenCode to list the requests asked while Trebell was away (approvals and forms, each
// listed on its own within it), and refuseMs for it to take back all it listed, before it goes on without. A request it does not
// take back keeps its run waiting, and the thread's next prompt waits behind that run, so neither wait is shorter than 2.1.2's 5 s
// and 10 s: Trebell's own 6 s for the list, which OpenCode gives from memory but a server busy with other sessions can be slow to
// give, and 12 s for taking them back, which can wait on their runs to stop, each 2.1.2's and a fifth more.
const UNSEEN_REQUESTS=Object.freeze({listMs:6_000,refuseMs:12_000});
// The ids of the requests in a list (none for a list OpenCode did not give), passing over any request without one.
const requestIds=list=>(list||[]).map(request=>request?.id==null?"":String(request.id)).filter(id=>id!=="");
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
// A read's row opens to what it read, and a question's to what was asked and answered, not to the item's JSON.
const textRow=name=>name==="read"||name==="question"?{textOutput:true}:{};
// A question's row text from the questions it was called with: once answered with the answers, otherwise with what OpenCode said.
function questionRow(call,answers,said){
  if(call.name!=="question"||!Array.isArray(call.input.questions))return said;
  const known=Array.isArray(answers)?answers:null;
  return openCodeQuestionText(call.input.questions,known,known?"":said);
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
    // The tool calls that have not ended, by call ID: {name, input}.
    this.toolCalls=new Map();
    // The row text of each question whose answer OpenCode refused, by the message its tool fails with.
    this.refusedAnswers=new Map();
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
    if(providerSessionId){await this.#refuseUnseenRequests();await this.#applyPermissionRules()}
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    const availableModels=[...this.modelMap.keys()];
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:this.modelNames.get(modelId)||modelId}))},configOptions:[],modes:{currentModeId:String(info.agent||"build"),availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    announce({status:{type:"idle"}});
    this.#follow();
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  // A profile's own OpenCode server outlives Trebell, so the run of a session Trebell resumes may still wait on a question or an approval
  // asked while Trebell was away. Nothing would ever answer it, and the thread's next prompt would wait behind that run, so each such
  // request OpenCode lists is refused before the session goes on: an approval rejected and a form cancelled, both without a message,
  // which ends the run. Approvals and forms are listed apart, so one kind OpenCode cannot list leaves the other to be refused; what it
  // does not list in time stays as it is.
  async #refuseUnseenRequests(){
    const sessionID=this.sessionId,waiting=await this.#waitingRequests(sessionID,UNSEEN_REQUESTS.listMs),refusals=[];
    for(const requestID of requestIds(waiting.approvals))refusals.push(()=>this.client.permission.reply({sessionID,requestID,decision:"reject"}));
    for(const formID of requestIds(waiting.forms))refusals.push(()=>this.#cancelForm({id:formID,sessionID}));
    if(refusals.length===0)return;
    await openCode2Within(UNSEEN_REQUESTS.refuseMs,"OpenCode did not take back the requests asked while Trebell was away.",()=>Promise.allSettled(refusals.map(refuse=>Promise.resolve().then(refuse)))).catch(()=>{});
  }
  // A session's open approvals and forms as OpenCode lists them, each kind read on its own within ms: its list, or null when OpenCode
  // did not give one in time (an answer that is not a list counts as an empty one).
  async #waitingRequests(sessionID,ms){
    const read=list=>openCode2Within(ms,"OpenCode did not list the session's open requests.",list).then(found=>Array.isArray(found)?found:[],()=>null);
    const [approvals,forms]=await Promise.all([
      read(signal=>this.client.permission.list({sessionID},{signal})),
      read(signal=>this.client.session.form.list({sessionID},{signal})),
    ]);
    return {approvals,forms};
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
    await this.afterLostTurn();
    await this.#addRepositoryMcp();await this.#applySelection();await this.#applyPermissionRules();
    if(agent){const agentId=this.agentIds.get(String(agent))||String(agent);await this.client.session.switchAgent({sessionID:this.sessionId,agent:agentId})}
    try{await this.client.session.instructions.entry.put({sessionID:this.sessionId,key:"trebell.runtime",value:runtimeInstructions({harness:"OpenCode",model:this.model})})}catch{}
    // A session that could not reconnect to its stream follows it again before it sends, so the turn's events reach it.
    if(!this.following)await Promise.race([this.#follow(),after(STREAM_FOLLOW.openMs)]);
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
  // so no turn starts on an unsettled session: a run that goes on is stopped, and this message is refused. The
  // relay asks before it makes the message's turn, so a refused message stays the person's draft.
  async afterLostTurn(){
    if(!this.unsettled)return;
    const runs=await openCode2Within(STREAM_FOLLOW.answerMs,AFTER_LOST_TURN.unknown,signal=>this.client.session.active({signal})).catch(()=>null);
    if(!runs||typeof runs!=="object")throw new Error(AFTER_LOST_TURN.unknown);
    if(Object.hasOwn(runs,this.sessionId)){await this.#interrupt();throw new Error(AFTER_LOST_TURN.running)}
    this.unsettled=false;
  }
  #interrupt(){
    return openCode2Within(INTERRUPT_MS,"OpenCode did not stop the run.",signal=>this.client.session.interrupt({sessionID:this.sessionId},{signal})).catch(()=>null);
  }
  // The session's history since the turn's own message, oldest first; null when it does not reach that message.
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
    const kind=String(data?.action||""),disposition=openCodePermissionDisposition(this.permissionMode,kind),turn=this.activePrompt;
    let decision=disposition==="allow"?"accept":disposition==="deny"?"decline":"decline";
    if(disposition==="ask"&&this.onPermission){
      const options=[{optionId:"once",name:"Allow once",kind:"allow_once"},...(Array.isArray(data?.save)&&data.save.length?[{optionId:"always",name:"Allow session",kind:"allow_always"}]:[]),{optionId:"reject",name:"Reject",kind:"reject_once"}];
      const toolCall={title:permissionTitle(data),toolCallId:String(data?.id||""),rawInput:{...(data?.metadata||{}),resources:Array.isArray(data?.resources)?data.resources:[]},kind:normalizePermissionKind(kind)};
      // One the window stopped waiting for (left unanswered until the relay's wait ran out) got no answer of the person's. A wait that
      // ended otherwise (Trebell closing) is stopped, as the session's close stops the run.
      decision=await Promise.resolve().then(()=>this.onPermission({method:"permission",params:{toolCall,permissionType:kind,options}})).then(value=>value||"decline",error=>isUserResponseTimeout(error)?"unanswered":"cancel");
    }
    if(decision==="acceptForSession"&&String(data.sessionID)===this.sessionId){
      const resources=(Array.isArray(data?.save)&&data.save.length?data.save:data?.resources)||[];
      for(const resource of resources.map(String).filter(Boolean))if(!this.sessionGrants.some(grant=>grant.action===kind&&grant.resource===resource))this.sessionGrants.push({action:kind,resource,effect:"allow"});
      await this.#applyPermissionRules().catch(()=>{});
    }
    // An approval left unanswered ends this session's turn saying so, as an unanswered question does (FORM_UNANSWERED): rejected without a
    // message, which stops OpenCode's run, the reason set before OpenCode says the run stopped. A subagent's, or one asked while no turn
    // runs, is refused saying it was not answered, and the model goes on.
    const ends=decision==="unanswered"&&String(data.sessionID)===this.sessionId&&turn&&this.activePrompt===turn&&!turn.done&&!turn.cancelled&&!turn.stopError;
    if(ends)turn.stopError=new Error(`OpenCode's ${openCodeRequestName(kind,data?.resources)} was not answered in time, so Trebell declined it and stopped the turn.`);
    const refusal=ends?null:openCodeRefusal(decision,{disposition,mode:this.permissionMode,action:kind,resources:data?.resources});
    // A refused shell call reaches the model only as "Unable to execute command", which it retries, so the reason is steered into the
    // session before the refusal; the refusal stands without it.
    if(refusal)await this.client.session.synthetic({sessionID:String(data.sessionID),text:refusal.note,delivery:"steer",resume:false}).catch(()=>{});
    const replied=await this.client.permission.reply({sessionID:String(data.sessionID),requestID:String(data.id),decision:permissionDecision(decision),...(refusal?{message:refusal.reason}:{})}).then(()=>true,()=>false);
    if(ends){if(!replied)await this.#interrupt();turn.settle?.()}
  }
  // One subscription to the event stream: opened resolves true at its first chunk (OpenCode 2 sends server.connected at once) and false
  // if it ends before; ended once it has ended, however it ended; drop lets go of it. Every chunk the stream receives counts (onActivity),
  // OpenCode's heartbeats among them. The silence counts only while the session waits for the stream, so an approval the
  // person takes minutes over is no silence of the stream's. (@opencode/client 2.0.24 reads the
  // stream in the background and reports its heartbeats meanwhile; a subscription it is told to let go of ends quietly.) A stream opened
  // again holds its events until gate settles, once the session has caught up with what it missed (#reconnected).
  #subscribe(gate=null){
    const silence=new AbortController(),signal=AbortSignal.any([this.eventAbort.signal,silence.signal]);
    let timer=null,open=()=>{};const opened=new Promise(resolve=>{open=resolve});
    const waiting=()=>{clearTimeout(timer);timer=setTimeout(()=>silence.abort(),STREAM_FOLLOW.silentMs)};
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
  // The event stream, followed while the session is open. A lost stream is followed again (#resubscribe); when that fails, a running
  // turn ends saying why (#lose), and the session follows no stream until the next turn. The promise tells whether the first
  // subscription opened.
  #follow(){
    this.following=true;
    const first=this.#subscribe();
    this.eventTask=(async()=>{
      let current=first;
      while(current&&!this.closed){
        await current.ended;
        if(this.closed)break;
        const again=await this.#resubscribe();
        current=again.stream;
        if(!current&&!this.closed)this.#lose(this.activePrompt,again.anyOpened?STREAM_LOST.unknown:STREAM_LOST.unreachable);
      }
      this.following=false;
    })();
    return first.opened;
  }
  // Subscribes again, at most STREAM_FOLLOW.tries times, until a subscription counts: it opened in time, and the session caught up with
  // what it missed (#reconnected) before that subscription's events are read. One that does not count is let go, and has ended, before
  // the next try. Gives the subscription that counted (or null) and whether any of them opened.
  async #resubscribe(){
    let anyOpened=false;
    for(let tried=0;tried<STREAM_FOLLOW.tries&&!this.closed;tried++){
      if(tried>0){await after(STREAM_FOLLOW.spacingMs);if(this.closed)break}
      let release=()=>{};
      const candidate=this.#subscribe(new Promise(resolve=>{release=resolve}));
      const opened=await Promise.race([candidate.opened,after(STREAM_FOLLOW.openMs).then(()=>false)]);
      anyOpened||=opened;
      const counts=opened&&await this.#reconnected().catch(()=>false);
      if(!counts)candidate.drop();
      release();
      if(counts)return {stream:candidate,anyOpened};
      await candidate.ended;
    }
    return {stream:null,anyOpened};
  }
  // A turn the session stopped following ends with the reason. OpenCode may still run its message, so that run is stopped (once
  // OpenCode has the message: interrupt false when it does not yet) and the next message asks OpenCode first (afterLostTurn, which the
  // relay asks before it makes the message's turn).
  #lose(turn,reason,{interrupt=true}={}){
    if(!turn||turn.done||turn.cancelled||turn.stopError||this.activePrompt!==turn)return;
    turn.lost=true;turn.stopError=new Error(reason);this.unsettled=true;turn.settle?.();
    if(interrupt)void this.#interrupt();
  }
  // Once the session listens again, OpenCode says which sessions it still runs (session.active), and a new stream counts only once it
  // has (true). A turn whose run goes on goes on, with the text it
  // missed read back from the session's history (#backfill), and the questions and approvals of the session and its subagents that came
  // while Trebell was not listening are asked; a turn whose run ended meanwhile ends as that history says (#endedMeanwhile), and one
  // whose message OpenCode never took ends saying so.
  async #reconnected(){
    const turn=this.activePrompt;
    const runs=await openCode2Within(STREAM_FOLLOW.answerMs,"OpenCode did not say which sessions it runs.",signal=>this.client.session.active({signal}));
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
  // What the run said while Trebell was not listening: each text block OpenCode has kept since the turn's message is
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
  // A run that ended while Trebell was not listening ends as the session's history says: by the idle item OpenCode
  // keeps for a run's end, since the turn's own message. Without one (a restarted server keeps none for the run it lost) OpenCode lost
  // the run, and the turn ends saying so: nobody stopped it.
  #endedMeanwhile(turn,since){
    const outcome=String(since?.findLast(item=>item?.type==="idle")?.outcome||"");
    if(outcome==="failed"){
      const error=since.findLast(item=>item?.type==="assistant")?.error,failure=error?executionFailure(error):{text:FAILED_WITHOUT_REASON,usageLimit:false};
      turn.error=failure.text;turn.usageLimit=failure.usageLimit;
    }else if(!outcome)turn.stopError=new Error(RUN_LOST);
    else if(outcome!=="succeeded")turn.cancelled=true;
    turn.settle?.();
  }
  // The questions and approvals asked while the stream was lost, asked now; only once OpenCode has listed both kinds.
  async #askOpenRequests(sessionID){
    const {approvals,forms}=await this.#waitingRequests(sessionID,STREAM_FOLLOW.answerMs);
    if(!approvals||!forms||this.closed)return;
    for(const form of forms)this.#askForm({...form,sessionID:String(form?.sessionID||sessionID)});
    for(const request of approvals)void this.#permission({...request,sessionID:String(request?.sessionID||sessionID)}).catch(()=>{});
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
    // A call whose input still streams has not started: it reads pending until OpenCode calls it, as OpenCode 1.x's pending part does.
    if(event.type==="session.tool.input.started"){const id=String(data.id),call={name:String(data.name||"tool"),input:{}};this.toolCalls.set(id,call);this.#toolRow("tool_call",id,call,{status:"pending"});return}
    if(event.type==="session.tool.called"){const id=String(data.id),call=this.#toolCall(id);call.input=data.input&&typeof data.input==="object"?data.input:{};this.#toolRow("tool_call_update",id,call,call.name==="question"?{status:"in_progress",rawOutput:questionRow(call,null,"")}:{status:"in_progress"});return}
    if(event.type==="session.tool.success"){const id=String(data.id),call=this.#toolCall(id),output=outputText(data.content);this.toolCalls.delete(id);this.#toolRow("tool_call_update",id,call,{status:"completed",rawOutput:call.name==="read"?unwrapOpenCodeRead(output):questionRow(call,data.metadata?.answers,output)});return}
    // A question whose answer OpenCode refused fails with the message the session cancelled it with, and its row says it in the person's words.
    if(event.type==="session.tool.failed"){const id=String(data.id),call=this.#toolCall(id),failure=errorText(data.error),refused=this.refusedAnswers.get(failure);this.toolCalls.delete(id);this.refusedAnswers.delete(failure);this.#toolRow("tool_call_update",id,call,{status:"failed",rawOutput:refused||questionRow(call,null,failure)});return}
    if(event.type==="session.execution.succeeded"&&turn&&sessionID===this.sessionId){turn.settle?.();return}
    if(event.type==="session.execution.failed"&&turn&&sessionID===this.sessionId){const failure=executionFailure(data.error);turn.error=failure.text;turn.usageLimit=failure.usageLimit;turn.settle?.();return}
    if(event.type==="session.execution.interrupted"&&turn&&sessionID===this.sessionId){turn.cancelled=true;turn.settle?.();return}
  }
  #toolCall(id){
    if(!this.toolCalls.has(id))this.toolCalls.set(id,{name:"tool",input:{}});
    return this.toolCalls.get(id);
  }
  // OpenCode 2 names a call by its tool only, and its updates after session.tool.called leave out the input: each update is titled as
  // OpenCode 1.x titles the call (openCodeToolTitle), from the input the call was called with, and carries it. OpenCode titles a command
  // and a task by their description; another tool's arguments may hold a description of their own (an MCP tool's), which is no title,
  // so it keeps its name, as OpenCode 1.x shows an MCP tool.
  #toolRow(sessionUpdate,id,{name,input},fields){
    const title=DESCRIBED_TOOLS.has(name)?input.description:"";
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate,toolCallId:id,title:openCodeToolTitle(name,{title,input,cwd:this.cwd}),kind:normalizePermissionKind(name),rawInput:input,...textRow(name),...fields}});
  }
  // A retry OpenCode schedules for this turn's request, or a subagent's, shows while Trebell waits for it (openCodeRetryNotice); one that
  // is hours away, or past OPENCODE_RETRY_LIMITS, ends the turn with the provider's reason (openCodeRetryStop), as OpenCode 1.x's does.
  #retry(event,sessionID){
    const turn=this.activePrompt;if(!turn||turn.done||turn.cancelled||turn.stopError)return;
    // OpenCode 2 counts the first request as attempt 1, so its first retry is attempt 2; the wait runs from when it was scheduled.
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
    const sessionID=String(form.sessionID),formID=String(form.id),turn=this.activePrompt,own=sessionID===this.sessionId,dialog=openCode2FormDialog(form);
    if(dialog.declined){
      pending.answering=true;
      const reason=`OpenCode asked for ${dialog.declined}, which Trebell Code's question dialog cannot show, so Trebell declined the question`;
      // The cancel stops this session's run (OpenCode's Stop) and the turn ends with the reason. A subagent is told the reason instead and
      // goes on: stopping it would not end the turn.
      if(!own||!turn||turn.done)return void await this.#cancelForm(form,reason+".");
      turn.stopError=new Error(reason+" and stopped the turn.");
      if(!(await this.#cancelForm(form)))await Promise.resolve(this.client?.session?.interrupt?.({sessionID})).catch(()=>{});
      turn.settle?.();return;
    }
    // unanswered: no answer came in time (the relay's wait ran out), or there is no one to ask. A wait that ended otherwise (Trebell
    // closing) is no answer either, nor one left unanswered: the question is cancelled as the session's close stops the run.
    let answers=null,unanswered=typeof this.onQuestion!=="function";
    if(!unanswered)answers=await untilAborted(Promise.resolve().then(()=>this.onQuestion({toolName:"question",input:{questions:dialog.questions},signal:pending.controller.signal})),pending.controller.signal).catch(error=>{unanswered=isUserResponseTimeout(error);return null});
    // Settled elsewhere, or the session closed: there is nothing to send.
    if(pending.controller.signal.aborted||this.closed)return;
    pending.answering=true;
    // A stopped turn's run is ending, and the form with it.
    if(turn?.cancelled)return void await this.#cancelForm(form);
    const answer=dialog.reply(answers);
    if(!Object.keys(answer).length){
      // The cancel stops the asking session's run: this session's turn ends with the reason, set before OpenCode says the run stopped.
      // A subagent's question ends the subagent's run only, and the turn goes on as OpenCode goes on.
      const ends=own&&turn&&!turn.done&&!turn.cancelled&&!turn.stopError&&Boolean(answers||unanswered);
      if(ends)turn.stopError=new Error(answers?FORM_UNANSWERED.dismissed:FORM_UNANSWERED.unanswered);
      if(!(await this.#cancelForm(form))&&own)await Promise.resolve(this.client?.session?.interrupt?.({sessionID})).catch(()=>{});
      if(ends)turn.settle?.();
      return;
    }
    try{await this.client.session.form.reply({sessionID,formID,answer})}
    catch(error){
      if(FORM_GONE.has(error?.name))return;
      // OpenCode refused the answer (one that is not among the choices, say): the cancel's message fails the question tool with the reason,
      // which tells the model, while the turn goes on. (An error notice would end the window's turn.) The tool's row tells the person, in
      // their words: what was asked, their answer and OpenCode's reason.
      const reason=errorText(error),message=`The user's answer could not be given: ${reason}. Continue without it, and tell the user what you would need from them.`;
      this.refusedAnswers.set(message,openCodeQuestionText(dialog.questions,dialog.chosen(answer),`OpenCode refused the answer (${reason.replace(/[\s.]+$/,"")}), so the turn went on without it.`));
      await this.#cancelForm(form,message);
    }
  }
}
