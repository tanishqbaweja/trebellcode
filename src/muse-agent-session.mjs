import { resolve } from "node:path";
import { acpToolFrame } from "./acp-tool-state.mjs";
import { linkedFileLine } from "./prompt-attachments.mjs";
import { retryNotice, retryReason } from "./retry-notice.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { museAnswerPayload, museCardButtons, museDecisionChoices, museDecisionToSend, museDialogQuestions } from "./muse-asking.mjs";
import { MuseHost, MUSE_HOST_BOUNDS, loadMuseSdk, museHostCannotSandbox, museLaunchPlan, museServeArgs, museSessionSettings, museWorkspaceRoot } from "./muse-host.mjs";
import { resolveMuseReasoningEffort } from "./muse-model-catalog.mjs";
import { MUSE_LAST_DATE_MS, museLimitLiftsAt, museQuotaStop } from "./muse-quota.mjs";
import { museItemRow, museLabel, museShowsNoRow, museTodoPlan, museWorkProgress, museWorkflowAgentRows } from "./muse-rows.mjs";
import { MUSE_REASONING_EFFORTS } from "./model-reasoning-effort.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { SessionRefusalError } from "./session-refusal.mjs";

// Muse Code sessions and turns over the Muse Session Protocol: a session is started or resumed on Trebell's
// own host (muse-host.mjs), each prompt is a turn/start the turn's id is minted for, and Muse's item events come back as the
// ACP-shaped updates the relay reads (replies, reasoning summaries, commands, file edits, web searches, subagents and workflows, the
// todo list as a plan, token usage and the context meter). A turn Muse starts itself is a turn of its own (onWakeTurn).

export const MUSE_REQUEST_TIMEOUT_MS=30_000;
export const MUSE_INTERRUPT_TIMEOUT_MS=30_000;
// How often Trebell asks the person again about one approval or question whose answer Muse would not take.
const MUSE_ASK_ATTEMPTS=3;
// How many settled approvals and questions a session remembers, so a late copy of one is not asked again.
const MUSE_SETTLED_LIMIT=500;
export const MUSE_SIGNED_OUT_MESSAGE="Muse Code is signed out. Sign in with muse login, then send the message again.";
// What the next message does once Muse Code's host is gone, which a host lost between turns says after why it went (#lose). It names
// Muse Code: after the host's own reason, an "it" would read as the last thing that reason names (another Muse process, a file).
const MUSE_NEXT_MESSAGE="The next message starts Muse Code again.";
export const MUSE_VIEW_GAP_MESSAGE="Muse Code dropped some of this conversation's updates before they reached Trebell, so Trebell stopped it. "+MUSE_NEXT_MESSAGE;
// Why a session with MCP servers to hand over did not start: its host never granted sessionMcp (#mcpConfig).
export const MUSE_MCP_UNSUPPORTED="Trebell could not hand its tools and your MCP servers to Muse Code: this Muse Code build does not accept MCP servers for a session. Install a newer Muse Code release.";
const ITEM_EVENTS=new Set(["item/started","item/updated","item/completed"]);
// Work that runs on past the turn that started it: Muse's subagents and workflows.
const WORK_KINDS=new Set(["subagent","workflow"]);
// How many ended Muse turns a session remembers, so a late copy of one's turn/started starts no turn of its own.
const MUSE_ENDED_TURNS_LIMIT=200;
// Work that has said nothing for this long holds the host no more: a workflow gone silent, or one whose end never reached Trebell.
// Trebell's own choice, eight hours, the same as Claude Code's hold (claude-agent-session CLAUDE_MAX_IDLE_PIN_MS). Once the hold
// ends, the relay's next idle sweep closes the session, which stops any of that work still running, so the hold outlasts a working
// day's quiet build, training run or download, and the four hours 2.1.2 gave, so nothing 2.1.2 kept running stops sooner now. The
// cost: a host whose work's end never reached Trebell keeps its process and memory that long.
export const MUSE_MAX_IDLE_PIN_MS=8*60*60_000;
// Meta's provider refuses "none"; the rest are MSP's efforts.
const MUSE_EFFORTS=new Set(MUSE_REASONING_EFFORTS);
// The model choice that lets Muse pick: the catalog's default row; the word itself never goes to Muse.
const MUSE_DEFAULT_MODEL="default";
const ACTIONS=Object.freeze({
  "session/start":"start the session","session/resume":"resume this conversation","session/setApprovalMode":"set the session's approval mode",
  "session/setModel":"switch to the thread's model",
  "turn/start":"start the turn","turn/steer":"take the message into the running turn","turn/interrupt":"stop the turn",
  "approval/decide":"take Trebell's answer to its request","userInput/cancel":"take Trebell's answer to its question",
  "userInput/answer":"take the answer to its question",
  "session/compact":"compact the conversation",
});
// Trebell's words for a conversation with nothing to compact (session/compact's noop, or a session with no turn yet, missing_run).
export const MUSE_NOTHING_TO_COMPACT="There is no Muse Code conversation history to compact yet.";
export const MUSE_COMPACTION_STOPPED="Muse Code's context compaction was stopped before it finished.";
// A message in a mode this Muse Code host was not launched for, while Muse's own work holds the host (as Claude Code's background
// work blocks a change that would end it). The report runs as a turn, whose Stop every window shows, so its refusal names it. A
// compaction runs in no turn, and only the window that waits for it shows its Stop (which stops the host, cancel), not a reloaded
// window or another of the person's, so its refusal names none.
export const MUSE_COMPACTION_BLOCKS_MODE_CHANGE="Muse Code is still compacting this conversation, and this mode needs a new Muse Code host, which would stop the compaction. Wait for it to finish, or keep the current mode, then send the message again.";
export const MUSE_REPORT_BLOCKS_MODE_CHANGE="Muse Code is still writing its report on the work it finished, and this mode needs a new Muse Code host, which would stop the report. Wait for it to finish (or stop it), or keep the current mode, then send the message again.";
// The same refusals for a follow-up of Trebell's queue sent now while a turn runs (turn/steer), which stays queued, in the queue's own
// words: the queue sends it once the turn ends (the report's, unless a Stop holds the queue), and a compaction still running then
// refuses it again, as it refuses a message.
export const MUSE_COMPACTION_KEEPS_QUEUED="Muse Code is still compacting this conversation, and this mode needs a new Muse Code host, which would stop the compaction. It stays queued, and goes once this turn ends if Muse Code has finished compacting by then.";
export const MUSE_REPORT_KEEPS_QUEUED="Muse Code is still writing its report on the work it finished, and this mode needs a new Muse Code host, which would stop the report. It stays queued and goes once the report ends.";
// Why Muse did not compact, from its own durable words (compaction_unavailable, summarizer_failed), as a sentence.
function compactionFailure(reason){const words=text(reason).trim().replaceAll("_"," ");return `Muse Code could not compact the conversation${words?`: ${words}`:""}.`}

function text(value){return typeof value==="string"?value:value==null?"":String(value)}
function wait(ms){let timer;const promise=new Promise(resolve=>{timer=setTimeout(resolve,ms);timer?.unref?.()});return {promise,cancel:()=>clearTimeout(timer)}}
async function within(promise,ms){const timer=wait(ms);try{return await Promise.race([Promise.resolve(promise).then(()=>true,()=>true),timer.promise.then(()=>false)])}finally{timer.cancel()}}
// Whether an event naming a Muse turn is another turn's: one it names that is neither this turn's own nor a turn this one took in
// (joined). An event that names no turn is the running turn's.
function elsewhere(turn,turnId){
  if(!turnId)return false;
  return turnId!==turn.turnId&&!turn.joined.has(turnId);
}

// What a message with neither words nor a picture is told: MSP takes no turn input that is empty.
export const MUSE_EMPTY_PROMPT="This message has no text and no image, so there is nothing to send to Muse Code.";
// One prompt part as MSP turn input (TurnInputPart), by the part's type, or null when it carries nothing to send: text as it is, an
// image as base64 with its media type, and any other attachment as Trebell's attachment line for it (linkedFileLine): the file it
// was saved to, and the file a document's text was extracted to. A type not named here is left out.
const TURN_INPUT={
  text:part=>{const words=text(part.text);return words?{type:"text",text:words}:null},
  image:part=>part.data?{type:"image",base64Data:text(part.data),mediaType:text(part.mimeType||part.mime_type)||"image/png"}:null,
  resource_link:part=>part.uri?{type:"text",text:linkedFileLine(part)}:null,
};
function turnInput(part){
  const convert=typeof part?.type==="string"&&Object.hasOwn(TURN_INPUT,part.type)?TURN_INPUT[part.type]:null;
  return convert?convert(part):null;
}
// Input that gives Muse something to read: an image, or text that is more than white space.
const hasContent=input=>input.type!=="text"||/\S/.test(input.text);
// The input of turn/start and turn/steer, in the parts' own order; one with no content at all is refused (MUSE_EMPTY_PROMPT).
export function museInputParts(parts=[]){
  const input=(Array.isArray(parts)?parts:[]).map(part=>turnInput(part)).filter(Boolean);
  if(!input.some(hasContent))throw new Error(MUSE_EMPTY_PROMPT);
  return input;
}

// What Muse's transcript shows for the turn: the person's own words, without Trebell's working context or runtime notes.
export function museDisplayText(parts=[]){
  const list=Array.isArray(parts)?parts:[];
  const own=list.map(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.userParts).find(Array.isArray);
  const words=(own||list.filter(part=>part?.type==="text").map(part=>text(part.text))).join("\n").trim();
  return words||(list.some(part=>part?.type==="image")?"Attached image":"");
}

// Work of a turn that holds Muse's host while it runs, its turn ended or not: a subagent or a workflow still running, or a command
// Muse sent to the background (background), whose tool call may settle as it goes there: MSP tells its end apart, as an item of its own
// (backgroundTerminalCompletion) naming the call, and until that end the command runs (endedCalls: the calls whose end came). Closing
// the host ends it all.
function runningWork(item,endedCalls=null){return WORK_KINDS.has(item?.kind)?museWorkProgress(item)==="in_progress":item?.kind==="toolCall"&&item.background===true&&!endedCalls?.has(text(item.callId))}

// Muse's token counts as Trebell keeps OpenAI-style usage (Muse's cache counters are subsets of input, reasoning of
// output): input the counted-once prompt tokens with cache reads and writes inside it, reasoning inside output, and the total input
// plus output, so nothing is counted twice. Muse's cost is an estimate of its own, and none is kept.
export function museTurnUsage({input=0,output=0,cacheRead=0,cacheWrite=0,reasoning=0}={}){
  const count=value=>Math.max(0,Math.trunc(Number(value)||0)),inputTokens=count(input),outputTokens=count(output);
  return {inputTokens,cachedInputTokens:Math.min(inputTokens,count(cacheRead)),cacheWriteInputTokens:Math.min(inputTokens,count(cacheWrite)),outputTokens,reasoningOutputTokens:Math.min(outputTokens,count(reasoning)),totalTokens:inputTokens+outputTokens};
}
// One of Muse's token counters (TokenUsage: session/tokenUsage's usage, turn/completed's usage), or null for one Trebell cannot read.
function museTokenCounts(usage){
  const whole=value=>Number.isInteger(value)&&value>=0,optional=value=>whole(value)?value:0;
  if(!usage||typeof usage!=="object"||!whole(usage.inputTokens)||!whole(usage.outputTokens))return null;
  return {input:usage.inputTokens,output:usage.outputTokens,cacheRead:optional(usage.cacheReadTokens??usage.cachedTokens),cacheWrite:optional(usage.cacheWriteTokens),reasoning:optional(usage.reasoningTokens)};
}

// usage/changed is the account's and names no session: the last readable report of each Muse home (each holds its own sign-in),
// by the home its host named, for the Usage page's subscription windows. latestMuseSubscriptionUsage() without a home is the newest
// report of any.
const subscriptionReports=new Map();
export function rememberMuseSubscriptionUsage(usage,{museHome=""}={}){
  if(!usage||typeof usage!=="object")return;
  const home=text(museHome);subscriptionReports.delete(home);subscriptionReports.set(home,{...usage,window:{...usage.window},weekly:{...usage.weekly}});
  while(subscriptionReports.size>16)subscriptionReports.delete(subscriptionReports.keys().next().value);
}
export function latestMuseSubscriptionUsage({museHome=null}={}){
  const reports=museHome==null?[...subscriptionReports.values()]:[subscriptionReports.get(text(museHome))].filter(Boolean);
  const latest=reports.reduce((best,report)=>!best||report.observedAtMs>best.observedAtMs?report:best,null);
  return latest?{...latest,window:{...latest.window},weekly:{...latest.weekly}}:null;
}

// Trebell's MCP servers for a Muse session: the repository tools (trebell_repository) and the person's own servers,
// as session/start's and session/resume's config.mcpServers names them. Each is optional: with Muse's default, required, a server
// Muse cannot reach fails the turn. A server Trebell runs is a stdio one and a remote one is streamable HTTP; MSP has no SSE.
export function museMcpServers(servers=[]){
  const out={},pairs=list=>Object.fromEntries((Array.isArray(list)?list:[]).filter(entry=>entry&&typeof entry.name==="string"&&entry.name).map(entry=>[entry.name,text(entry.value)]));
  for(const server of Array.isArray(servers)?servers:[]){
    const name=text(server?.name).trim();if(!name||server.type==="sse")continue;
    const url=text(server.url).trim(),command=text(server.command).trim();
    if(url&&!command)out[name]={transport:"streamableHttp",url,headers:pairs(server.headers),mode:"optional"};
    else if(command)out[name]={transport:"stdio",command,args:(Array.isArray(server.args)?server.args:[]).map(text),env:pairs(server.env),mode:"optional"};
  }
  return out;
}

// The subjects Muse names (an approval's subject.kind); Trebell's policy answers no other kind for the person.
const MUSE_SUBJECTS=new Set(["shell","fileAccess","network","unixSocket","process","tool"]);
// An approval only the person answers: a protected write, and a subject Trebell does not know, which Muse says clients never approve.
const personOnly=params=>params?.protectedWrite===true||!MUSE_SUBJECTS.has(text(params?.subject?.kind));
// What a Muse approval asks, as the relay's approval card and Trebell's policy read it: a shell stage is a command
// and a file read a read, other file access an edit, a network host network and anything else a tool; its title is the command,
// path, host or target, else the tool.
export function museApprovalToolCall(params={}){
  const subject=params.subject&&typeof params.subject==="object"?params.subject:{},kind=text(subject.kind);
  const title=[subject.command,subject.path,subject.host,subject.target,params.toolName,subject.toolName].map(value=>text(value).trim()).find(Boolean)||"Muse Code requests permission";
  const rawInput=kind==="shell"?{command:text(subject.command)}
    :kind==="fileAccess"?{path:text(subject.path),access:text(subject.access)||"write"}
    :kind==="network"?{host:text(subject.host),...(Number.isInteger(subject.port)?{port:subject.port}:{}),...(subject.protocol?{protocol:text(subject.protocol)}:{})}
    :{...(subject.target?{target:text(subject.target)}:{}),...(typeof params.rawArgs==="string"?{args:params.rawArgs}:{})};
  const policyKind=kind==="shell"?"execute":kind==="fileAccess"?(subject.access==="read"?"read":"edit"):kind==="network"?"network":"other";
  return {toolCallId:text(params.toolCallId||params.itemId||params.approvalId),title,kind:policyKind,rawInput};
}
// The approval card's words for what a Muse approval asks (the relay's card): a title for a file access or network approval, a
// protected write and a read outside the workspace by name (Muse names a path inside its workspace relative to it), else the card's
// own; the stage a staged command's choices answer, with the whole command under it; and the agent a child's approval comes from
// (agent: its name, as its row shows it), which Stop leaves its card waiting for. It runs on past the turn that started it only once
// that turn has ended with its work running (runsPast): a subagent asking while its turn runs stops with that turn. A command a host
// that cannot use its sandbox asks to run (sandboxUnavailable, museHostCannotSandbox) says before the person answers that allowing it
// will not run it, and what will. notice: what is asked, which a desktop notification says, when the card's line is not that.
export const MUSE_SANDBOX_UNAVAILABLE_CARD="Muse Code reports that its sandbox is not available, so this command will fail even if you allow it. To let it run commands, switch this task to Full access, which runs them without the sandbox and without asking.";
export function museApprovalCard(params={},{agent="",runsPast=false,sandboxUnavailable=false}={}){
  const subject=params.subject&&typeof params.subject==="object"?params.subject:{},kind=text(subject.kind),asked=museApprovalToolCall(params).title;
  const outside=/^(?:[a-z]:)?[\\/]|^\.\.(?:[\\/]|$)/i.test(text(subject.path).trim());
  const title=kind==="network"?"Network access needs approval":kind!=="fileAccess"?"":subject.access==="read"?outside?"Read outside the workspace needs approval":"File read needs approval"
    :params.protectedWrite===true?"Write to a protected file needs approval":"File write needs approval";
  const index=params.currentRequirementId?.sourceIndex,stage=kind==="shell"&&Array.isArray(subject.stages)?subject.stages.find(item=>item?.requirementId?.sourceIndex===index):null;
  const words=(Array.isArray(stage?.argv)?stage.argv:[]).map(word=>text(word)).map(word=>word&&!/\s/.test(word)?word:`"${word}"`).join(" ");
  const staged=Number(stage?.totalStages)>1&&words?`Stage ${Number(stage.position)||index+1} of ${stage.totalStages}: ${words}`:"";
  const asker=params.subagentOrigin?`Asked by ${agent?"the "+agent:"a Muse Code workflow agent"}${runsPast?", which runs on past the turn that started it":""}.`:"";
  const warning=kind==="shell"&&sandboxUnavailable?MUSE_SANDBOX_UNAVAILABLE_CARD:"";
  const reason=[asker,staged,warning].filter(Boolean).join(" ");
  return {...(title?{title}:{}),reason:reason||asked,...(reason?{command:asked}:{}),...(asker||warning?{notice:staged||asked}:{})};
}
// How a reset time reads: in the person's own zone and locale, with its weekday, its date and year, and the hour and minute.
const RESET_SHOWN=Object.freeze({weekday:"short",year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
// The reset a quota stop names (museLimitLiftsAt's ISO time) as a Date, or null for none or one Date cannot read.
function readableReset(resetAt){
  if(!resetAt)return null;
  const when=new Date(resetAt);
  return Number.isNaN(when.getTime())?null:when;
}
// What a turn the subscription quota stopped says: Muse Code waits for its allowance to reset, and when that is, if Muse said.
export function museOutOfUsageMessage(resetAt=null){
  const when=readableReset(resetAt);
  if(!when)return "Muse Code is out of usage for now. Wait for its allowance to reset, then try the message again.";
  return `Muse Code is out of usage until its allowance resets on ${when.toLocaleString(undefined,RESET_SHOWN)}. Try the message again after that.`;
}
// Muse's usage report (usage/changed, account-wide): when the host saw it, the tier, and the current window's and the week's
// verbatim percentages (over 100 past the quota) with their resets; null for a report Trebell cannot read.
export function museSubscriptionUsage(params={}){
  const number=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0,stamp=value=>number(value)&&value>0&&value<=MUSE_LAST_DATE_MS;
  const window=params?.window,weekly=params?.weekly;
  if(!stamp(params?.observedAtMs)||typeof params?.tier!=="string")return null;
  if(!window||typeof window!=="object"||!number(window.usedPercent)||!(number(window.windowDurationMins)&&window.windowDurationMins>0)||!stamp(window.resetsAtMs))return null;
  if(!weekly||typeof weekly!=="object"||!number(weekly.usedPercent)||!stamp(weekly.resetsAtMs))return null;
  return {observedAtMs:params.observedAtMs,tier:params.tier,window:{usedPercent:window.usedPercent,windowDurationMins:window.windowDurationMins,resetsAtMs:window.resetsAtMs},weekly:{usedPercent:weekly.usedPercent,resetsAtMs:weekly.resetsAtMs}};
}
// turn/retryScheduled: Muse sends the turn's failed model request again by itself and the turn goes on, so the retry row says what
// failed and which of Muse's tries comes next (retry-notice.mjs). null for a notice Trebell cannot read: no turn, no reason, a try
// that is not a whole number of 1 or more, or a wait that is not a number of 0 ms or more.
export function museRetryNotice(params={}){
  const {turnId,nextAttempt,maxAttempts,retryDelayMs,reason}=params||{};
  const counted=[nextAttempt,maxAttempts].every(value=>Number.isInteger(value)&&value>=1);
  const waits=typeof retryDelayMs==="number"&&Number.isFinite(retryDelayMs)&&retryDelayMs>=0;
  if(!text(turnId)||!counted||!waits||!retryReason(text(reason)))return null;
  return retryNotice({reason:text(reason),sender:"Muse Code",seconds:retryDelayMs/1000,which:`try ${nextAttempt} of ${maxAttempts}`});
}
const requirementKey=requirement=>JSON.stringify(requirement??null);
// What an approval's card shows: its stage and Muse's choices for it.
const shownKey=params=>JSON.stringify([params?.currentRequirementId??null,params?.availableChoices??null]);
// What became of an answer Trebell sent for an approval stage (#sendAnswer): Muse took it; the stage has no such choice, so nothing
// went; the approval was settled already or is gone; Muse had moved past the stage; or Muse refused it, or the command failed.
const ANSWER_TAKEN="taken",ANSWER_NOT_OFFERED="not offered",ANSWER_SETTLED="settled",ANSWER_MOVED_ON="moved on",ANSWER_REFUSED="refused";
// The approval/decide refusals that say where the approval stands rather than what was wrong with the answer: settled already or
// gone, or past the stage the answer named. Any other failure is a refusal of the answer itself.
const DECIDE_REFUSALS=new Map([["approvalAlreadyResolved",ANSWER_SETTLED],["approvalNotFound",ANSWER_SETTLED],["approvalRequirementStale",ANSWER_MOVED_ON]]);

export class MuseAgentSession{
  // modelCatalog: the list Muse Code's status check read ({models, metadata, preferred}, museModelCatalog), or null, which the
  // thread's model and Thinking level are resolved against before each turn. env: the profile's (AgentRuntimeManager.childEnv), and
  // authMethod how its profile signs in (a META_API_KEY reaches Muse only on "api-key", museHostEnvironment).
  // onWakeTurn: told of a turn Muse starts itself, with the promise its end settles (the relay's startWakeTurn). mcpServers: the MCP
  // servers the session gets, as the ACP harnesses get them (the relay's trebell_repository and the person's own, museMcpServers).
  constructor({command="muse",cwd,env=undefined,authMethod="sign-in",permissionMode="supervised",onUpdate,onPermission=null,onQuestion=null,onWakeTurn=null,mcpServers=[],version="0.0.0",modelCatalog=()=>null,spawnFn=undefined,platform=process.platform,loadSdk=loadMuseSdk,stopTree=undefined,startupTimeoutMs=MUSE_HOST_BOUNDS.answerMs,shutdownTimeoutMs=MUSE_HOST_BOUNDS.exitMs,requestTimeoutMs=MUSE_REQUEST_TIMEOUT_MS,interruptTimeoutMs=MUSE_INTERRUPT_TIMEOUT_MS,now=()=>Date.now()}={}){
    this.command=command;this.cwd=resolve(cwd||process.cwd());this.env=env;this.permissionMode=normalizePermissionMode(permissionMode||"supervised");
    this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.onWakeTurn=onWakeTurn;this.version=version;this.modelCatalog=modelCatalog;
    this.mcpServers=Array.isArray(mcpServers)?mcpServers:[];
    this.hostOptions={spawnFn,platform,stopTree,startupTimeoutMs,shutdownTimeoutMs,authMethod};this.platform=platform;this.loadSdk=loadSdk;
    this.requestTimeoutMs=requestTimeoutMs;this.interruptTimeoutMs=interruptTimeoutMs;
    this.args=museServeArgs(this.permissionMode);this.launched=null;this.host=null;this.connection=null;this.initializeResult=null;this.sessionSetup=null;
    // Whether the running host cannot use its sandbox for the commands it runs (museHostCannotSandbox), told on their cards.
    this.sandboxUnavailable=false;
    this.sessionId=null;this.model=null;this.wantedModel=null;this.reasoningEffort=null;this.turnRoot=null;
    this.dead=false;this.deadError=null;this.closed=false;this.activePrompt=null;
    // The approvals and questions Muse asked and has not settled ("approval:<id>", "question:<id>"), and the ones it settled; the names
    // of the agents Muse runs, by the ids a child's approval names them by (#nameAgents).
    this.requests=new Map();this.settledRequests=new Set();this.agentNames=new Map();
    // Muse's last readable usage report (usage/changed), which a turn the quota stopped reads its reset from.
    this.subscriptionUsage=null;
    // The work still running that a turn started (runningWork), by item, with its turn, whose rows it settles after the turn ended,
    // and when any of it was last heard of (its end too, which the relay's idle sweep counts as use); the Muse turns that ended; the
    // latest session/contextUsage ({usedTokens, windowTokens}) and the turn that ran last.
    this.observed=new Map();this.workHeardAt=0;this.now=now;this.endedTurns=new Set();this.context=null;this.lastTurn=null;this.ready=false;
    // The calls of the commands Muse sent to the background whose end it told (backgroundTerminalCompletion).
    this.endedCalls=new Set();
    // The rows a report left open when a message took it over (a command it still runs), followed in the report's turn until they end.
    this.openRows=new Set();
    // The /compact under way (compact), until its compaction item ends.
    this.compaction=null;
  }

  get busy(){return Boolean(this.activePrompt||this.compaction)}
  // Work Muse runs past the turn that started it: a subagent, a workflow or a command in the background
  // still running, unless none of it has been heard of for MUSE_MAX_IDLE_PIN_MS, or a turn Muse started itself. They run in this
  // host, so the relay's idle sweep keeps the session meanwhile.
  get pendingBackgroundWork(){return this.observed.size>0&&this.now()-this.workHeardAt<MUSE_MAX_IDLE_PIN_MS||Boolean(this.activePrompt?.wake&&!this.activePrompt.settled)}
  // Whether the row of that id is of work this session still follows past its turn (observed), a followed workflow's agents with it,
  // which a read of the thread says still runs (agent-relay withLiveWork).
  followsWork(id){
    if(this.dead||this.closed)return false;
    const row=String(id||""),agent=row.indexOf(":agent:");
    return this.observed.has(row)||agent>0&&this.observed.has(row.slice(0,agent));
  }
  // A new host can take the conversation up again unless this one keeps its sessions in memory only.
  get resumable(){return Boolean(this.initializeResult)&&this.initializeResult.sessionDurability!=="ephemeral"}
  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode||"supervised");return this.permissionMode}
  // Why a message cannot go now in the session's mode, or in the mode it asks for (mode), or null: the mode needs another host
  // (needsRelaunch), and Muse's own work holds this one, a compaction or the report Muse writes (also one a message's turn took in
  // before the message went), which a relaunch would stop. The relay refuses such a message before it keeps the message's mode and
  // before its turn starts, or before it steers it into the report (turn/steer names the message's mode), so the person keeps their
  // draft and the thread the mode its host runs; prompt refuses it too. queued: the words for a follow-up of Trebell's queue sent
  // now, which stays queued.
  modeRefusal(mode=this.permissionMode,{queued=false}={}){
    if(!this.launched||this.dead||!this.needsRelaunch(mode))return null;
    const running=this.activePrompt&&!this.activePrompt.settled?this.activePrompt:null;
    const report=running?.wake||running?.successor&&!running.prompted&&[...running.joined].some(id=>!running.endedJoined.has(id));
    return this.compaction?(queued?MUSE_COMPACTION_KEEPS_QUEUED:MUSE_COMPACTION_BLOCKS_MODE_CHANGE):report?(queued?MUSE_REPORT_KEEPS_QUEUED:MUSE_REPORT_BLOCKS_MODE_CHANGE):null;
  }
  // A mode's launch flags, permission profile and approval mode are fixed when its host launches (museLaunchPlan), so a mode with
  // another plan needs a new host, which resumes the conversation (runtime policy changes require a fresh Muse host).
  needsRelaunch(mode){return JSON.stringify(museLaunchPlan(mode))!==JSON.stringify(this.launched?.plan||museLaunchPlan(this.permissionMode))}
  setReasoningEffort(effort){const value=text(effort).trim().toLowerCase();this.reasoningEffort=MUSE_EFFORTS.has(value)?value:null;return this.reasoningEffort}

  #catalog(){try{const catalog=typeof this.modelCatalog==="function"?this.modelCatalog():this.modelCatalog;return catalog&&typeof catalog==="object"?catalog:null}catch{return null}}
  // A model id as Muse takes it: "default" is the catalog's default row, or none (Muse's own) while the list is unknown.
  #resolveModel(model){const value=text(model).trim();return value===MUSE_DEFAULT_MODEL?this.#catalog()?.preferred||null:value||null}
  // The thread's model: sent at once while no turn runs, and otherwise
  // before the next turn, as for a resumed session on another model. A model Muse refuses fails with its reason and leaves the
  // session's model as it was.
  async setModel(model){
    const previous=this.wantedModel;this.wantedModel=this.#resolveModel(model);
    if(this.connection&&this.sessionId&&!this.dead&&!this.activePrompt)try{await this.#applyModel()}catch(error){this.wantedModel=previous;throw error}
    return this.model;
  }
  async #applyModel(){
    const modelId=this.wantedModel;if(!modelId||modelId===this.model)return;
    await this.#command("session/setModel",{sessionId:this.sessionId,model:{modelId,providerId:"meta"}});
    this.model=modelId;
  }
  // The level the turn runs at, against the thread's model in the catalog (resolveMuseReasoningEffort).
  #turnEffort(){return resolveMuseReasoningEffort(this.#catalog()?.metadata?.find?.(row=>row?.id===this.model)||null,this.reasoningEffort)}

  async start({providerSessionId=null,model=null,reasoningEffort=undefined}={}){
    if(reasoningEffort!==undefined)this.setReasoningEffort(reasoningEffort);
    const plan=museLaunchPlan(this.permissionMode);this.args=plan.args;this.launched={mode:this.permissionMode,plan};
    const host=new MuseHost({...Object.fromEntries(Object.entries(this.hostOptions).filter(([,value])=>value!==undefined)),command:this.command,args:this.args,cwd:this.cwd,env:this.env,
      onWarning:message=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message}})});
    this.host=host;this.dead=false;this.deadError=null;
    await host.start({version:this.version,loadSdk:this.loadSdk});
    if(this.closed){await host.close();throw new Error("Muse Code was stopped while it started.")}
    const connection=host.connection;this.connection=connection;this.initializeResult=host.initializeResult;
    this.sandboxUnavailable=museHostCannotSandbox(this.initializeResult,this.args);
    connection.onNotification(frame=>{if(this.host===host)this.#notification(frame)});
    connection.onServerRequest(request=>this.#serverRequest(host,request));
    connection.onProtocolError(error=>{if(this.host===host)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message:`Muse Code sent a frame Trebell could not read: ${error?.message||error}`}})});
    this.#watch(host);
    try{
      const config=this.#mcpConfig();
      const [workspaceRoot,turnRoot]=await Promise.all([museWorkspaceRoot(this.cwd,{platform:this.platform,verbatim:false}),museWorkspaceRoot(this.cwd,{platform:this.platform})]);
      this.turnRoot=turnRoot;
      const modelId=this.#resolveModel(model);this.wantedModel=modelId;
      const sessionId=providerSessionId?text(providerSessionId):connection.mintCommandId();
      this.sessionId=sessionId;
      const result=providerSessionId?await this.#resume(sessionId,config):await this.#command("session/start",{sessionId,workspaceRoot,...config,providerId:"meta",...(modelId?{modelId}:{}),approvalMode:plan.approvalMode,permissionProfile:plan.permissionProfile});
      if(result?.session?.sessionId!==sessionId)throw new Error("Muse Code answered with another session than the one Trebell asked for.");
      this.model=text(result.session.modelId)||modelId;
      this.sessionSetup={sessionId,models:{currentModelId:this.model,availableModels:this.model?[{modelId:this.model,name:this.model}]:[]},configOptions:[],modes:{currentModeId:"default",availableModes:[]}};
      // A turn Muse starts itself is one of the session's from here (#turnStarted).
      this.ready=true;
      return {initialize:this.initializeResult,session:this.sessionSetup};
    }catch(error){
      // The host has no session of Trebell's then; a resume that found none closes nothing on Muse's side.
      this.dead=true;this.deadError=error;await host.close().catch(()=>{});
      throw error;
    }
  }

  // The config part of session/start and session/resume: {} when Trebell has no MCP servers for the session, else the servers under
  // config.mcpServers. MSP lets a session carry them only on a connection whose initialize answer listed sessionMcp among its
  // grantedCapabilities, so a host without that grant fails the start here, before any session is opened on it.
  #mcpConfig(){
    const mcpServers=museMcpServers(this.mcpServers);
    if(!Object.keys(mcpServers).length)return {};
    const granted=this.initializeResult?.grantedCapabilities;
    if(!Array.isArray(granted)||!granted.includes("sessionMcp"))throw new Error(MUSE_MCP_UNSUPPORTED);
    return {config:{mcpServers}};
  }

  // A saved conversation is resumed with its mode's profile asked for again, then its approval mode set (a resume replays the mode
  // it had); one Muse no longer has is a lost session, which the relay continues in a fresh one with the thread's earlier messages
  // handed over.
  async #resume(sessionId,config={}){
    const {permissionProfile,approvalMode}=this.launched?.plan||museSessionSettings(this.permissionMode);
    try{
      const result=await this.#command("session/resume",{sessionId,excludeItems:true,...config,permissionProfile});
      await this.#command("session/setApprovalMode",{sessionId,mode:approvalMode});
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
    // A message sent while Muse's own report turn runs takes that turn over (takeOverWake): the turn that took it over for this
    // message (the relay asks for it before it starts the message's turn) is this message's, else it is taken over here.
    const running=this.activePrompt&&!this.activePrompt.settled?this.activePrompt:null,prepared=running?.successor&&!running.prompted?running:null;
    if(running&&!running.wake&&!prepared)throw new Error("Muse Code already has a running turn.");
    const refuse=error=>{if(prepared){prepared.admit(false);prepared.fail(error)}return error};
    // A mode's launch flags, profile and approvals are its host's (museLaunchPlan), and the relay relaunches for another mode between
    // turns. While Muse's own work holds this host (a compaction, or the report it writes) no host is relaunched, so a message in a mode
    // this host was not launched for is refused rather than run with the old mode's sandbox, profile and approvals.
    if(this.launched&&this.needsRelaunch(this.permissionMode))throw refuse(new SessionRefusalError(this.modeRefusal()||"Muse Code's host was started for another mode, so the message was not sent. Send it again to start Muse Code in this mode."));
    let input,displayText;
    try{input=museInputParts(parts);displayText=museDisplayText(parts)}catch(error){throw refuse(error)}
    if(running?.wake&&!this.takeOverWake())throw new Error("Muse Code already has a running turn.");
    let turn=prepared||(running?.wake?this.activePrompt:null);
    if(!turn){turn=this.#newTurn(this.connection.mintCommandId());this.activePrompt=turn;this.lastTurn=turn}
    turn.prompted=true;
    try{
      let ack;
      try{
        // The thread's model first, when the session runs another.
        await this.#applyModel();
        const reasoningEffort=this.#turnEffort();
        ack=await this.#command("turn/start",{
          sessionId:this.sessionId,
          // Muse takes no system context, so Trebell's runtime notes lead the turn's input.
          input:[{type:"text",text:runtimeInstructions({harness:"Muse Code",model:this.model})},...input],
          ...(displayText?{displayText}:{}),
          // Each turn names the folder: a resumed session keeps the roots it had.
          workspaceRoots:[this.turnRoot],ifBusy:"queue",...(reasoningEffort?{reasoningEffort}:{}),
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

  // The relay asks for the turn of a message it is about to start (agent-relay turn/start), before it starts the message's turn in the
  // thread and gathers the message's context; prompt then sends the message in it. From here a report Muse starts itself joins the
  // message's turn, so it never becomes a turn of its own after the message's.
  // A message sent while Muse's own report turn runs takes that turn over, approvals included. The report ends in Trebell with
  // what it said so far and its tokens, its cards stay to answer, and the turn that takes it
  // over is the session's from here on, so nothing Muse sends meanwhile is lost: the rest of Muse's turn is the message's, Stop ends
  // both, and Muse runs the message after it (ifBusy queue). True then, and the relay waits for the report's turn to end in the thread
  // first. False otherwise; no turn is made when another turn runs, or when the message needs another host, which prompt refuses.
  takeOverWake(){
    const running=this.activePrompt&&!this.activePrompt.settled?this.activePrompt:null;
    if(running&&!running.wake||!this.connection||this.dead||this.closed||(this.launched&&this.needsRelaunch(this.permissionMode)))return false;
    const turn=this.#newTurn(this.connection.mintCommandId());turn.successor=true;
    this.activePrompt=turn;this.lastTurn=turn;
    turn.done.then(()=>{},()=>{}).then(()=>{if(this.activePrompt===turn)this.activePrompt=null});
    if(!running)return false;
    for(const id of [running.turnId,...running.joined])turn.joined.add(id);
    for(const id of running.endedJoined)turn.endedJoined.add(id);
    // The report's tokens so far are its own turn's: its turn/completed counts toward this turn only past them.
    turn.recorded.set(running.turnId,{...running.usage});if(running.joinedUsage)turn.joinedUsage={...running.joinedUsage};
    // What the report was saying goes on here from where it stopped (its replies and reasoning). Its rows stay its own: its work, and a
    // row still open (a command it runs), which settles in the report's turn as its work's rows do (observed, openRows).
    const open=[];
    for(const [id,item] of running.items){
      if(item.kind==="agentMessage"||item.kind==="reasoning")turn.items.set(id,item);
      else if(item.status==="inProgress"&&running.tools.has(id)&&!this.observed.has(id)){this.observed.set(id,running);this.openRows.add(id);this.workHeardAt=this.now();open.push(item)}
    }
    for(const [id,said] of running.sent)turn.sent.set(id,said);
    turn.lastMessage=running.lastMessage;
    // Each open row says from here that it runs past the report's turn (followed, runsPastTurn), sent again before that turn ends in
    // Trebell: the end leaves it running in the window, and its own next row, its end too, settles it in the report's card.
    for(const item of open)this.#publish(running,item);
    running.handOver({stopReason:"end_turn",providerMessageId:null,raw:this.#result(running,{turnId:running.turnId})});
    return true;
  }

  // wake: a turn Muse started itself (#turnStarted). successor: a turn that took one over (takeOverWake), prompted once its message
  // went. joined: Muse's turns this one took in (its report turn, a turn Muse started meanwhile), endedJoined the ones of those that
  // ended. usage: the token counts of its model steps; joinedUsage what turn/completed added up for the turns it took in, past what
  // a report it took over had already counted (recorded). rows: what each subagent's and workflow's row last showed; labels: workflow
  // agents' labels; followed: the items of work followed past the turn (observed), whose rows say so to their end (runsPastTurn).
  #newTurn(turnId,{wake=false}={}){
    let settle,fail,admit;
    const done=new Promise((resolve,reject)=>{settle=resolve;fail=reject});
    const admitted=new Promise(resolve=>{admit=resolve});
    const turn={turnId,wake,successor:false,prompted:false,joined:new Set(),endedJoined:new Set(),usage:{steps:0,reported:false,input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0},joinedUsage:null,recorded:new Map(),rows:new Map(),labels:new Map(),followed:new Set(),
      stopRequested:false,settled:false,items:new Map(),sent:new Map(),tools:new Set(),lastMessage:null,done,admitted,admit};
    turn.settle=value=>{if(turn.settled)return;turn.settled=true;this.#endTurn(turn,value?.stopReason==="cancelled"?"cancelled":"completed");settle(value)};
    turn.fail=error=>{if(turn.settled)return;turn.settled=true;this.#endTurn(turn,"failed");fail(error)};
    // A report turn a message took over ends in Trebell, while Muse's turn goes on in the message's (prompt).
    turn.handOver=value=>{if(turn.settled)return;turn.settled=true;settle(value)};
    done.catch(()=>{});
    return turn;
  }
  // A turn's end settles what it left open: a failed turn's running tools end failed; a stopped or failed turn's subagents
  // and workflows end with it, while a completed turn's run on, their rows settled by their own later events; and the approvals and
  // questions asked in it go, cards and dialogs included, since Muse settles them with the turn. A workflow child's approval outlives
  // it, and so does a command Muse sent to the background.
  #endTurn(turn,how){
    for(const id of [turn.turnId,...turn.joined])this.#rememberEnded(id);
    for(const item of turn.items.values()){
      if(WORK_KINDS.has(item.kind)){
        if(how==="completed"||!runningWork(item))continue;
        this.observed.delete(item.itemId);
        this.#publish(turn,{...item,status:"failed",failureReason:text(item.failureReason)||(how==="cancelled"?"Stopped with its turn.":"The turn ended before this finished.")});
      }else if(how==="failed"&&item.status==="inProgress"&&item.background!==true&&turn.tools.has(item.itemId))this.#row(turn,museItemRow({...item,status:"failed",failureReason:text(item.failureReason)||"The turn ended before this finished."}));
    }
    this.#withdrawRequests(entry=>!entry.child);
  }
  #rememberEnded(turnId){if(!turnId)return;this.endedTurns.add(turnId);if(this.endedTurns.size>MUSE_ENDED_TURNS_LIMIT)this.endedTurns.delete(this.endedTurns.values().next().value)}
  // What a turn's end gives the relay (raw): Muse's own params, with the turn's tokens in Trebell's shape (museTurnUsage) when Muse
  // reported any, never Muse's raw counters, which the relay would read as Trebell's.
  #result(turn,params={}){const raw={...params};delete raw.usage;if(turn.usage.steps||turn.usage.reported)raw.usage=museTurnUsage(turn.usage);return raw}
  // The work still running that ended turns left ends with the host, each row in the turn that started it.
  #settleObserved(reason){
    for(const [itemId,owner] of [...this.observed]){
      this.observed.delete(itemId);this.openRows.delete(itemId);
      const item=owner.items.get(itemId);if(item)this.#publish(owner,{...item,status:"failed",failureReason:text(item.failureReason)||reason});
    }
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

  // /compact: session/compact, a command whose answer is admission only. Accepted, the compaction runs in Muse as an
  // item of its own (kind compaction), whose end settles it: compacted, or why not. A conversation with nothing to compact (noop, or a
  // session with no turn yet) says so, and the session goes on. Muse has no stop for a compaction, so Stop stops the host meanwhile
  // (cancel), and the next message starts Muse Code again.
  async compact(){
    if(!this.connection||!this.sessionId)throw new Error("Muse Code session is not started.");
    if(this.dead)throw this.deadError||new Error("Muse Code stopped.");
    if(this.activePrompt&&!this.activePrompt.settled)throw new Error("Stop the running Muse Code turn before compacting its context.");
    if(this.compaction)return this.compaction.done;
    let resolveDone,rejectDone;
    const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject});done.catch(()=>{});
    const end=then=>value=>{if(compaction.settled)return;compaction.settled=true;if(this.compaction===compaction)this.compaction=null;then(value)};
    const compaction={done,settled:false,settle:null,fail:null};compaction.settle=end(resolveDone);compaction.fail=end(rejectDone);
    this.compaction=compaction;
    try{
      const answer=await this.#command("session/compact",{sessionId:this.sessionId});
      const status=text(answer?.status);
      if(status==="noop")compaction.fail(new Error(MUSE_NOTHING_TO_COMPACT));
      else if(status!=="accepted")compaction.fail(new Error(`Muse Code answered the compaction with ${status?`a status Trebell does not know (${status})`:"no status"}.`));
    }catch(error){
      const reason=text(error?.cause?.data?.reason);
      compaction.fail(error?.kind==="commandRejected"&&reason?new Error(reason==="missing_run"?MUSE_NOTHING_TO_COMPACT:compactionFailure(reason)):error);
    }
    return done;
  }
  // The compaction's item ends it: compacted, nothing compacted (noop), stopped, or failed with Muse's reason. Its start shows nothing
  // more than the row Compact put up. One Muse ran on its own (trigger auto) is not the /compact asked for.
  #compactionItem(item){
    const compaction=this.compaction;if(!compaction||item.trigger==="auto"||item.status==="inProgress")return;
    const outcome=text(item.outcome);
    if(item.status==="completed"&&(!outcome||outcome==="compacted"))return compaction.settle({compacted:true});
    if(outcome==="noop")return compaction.fail(new Error(MUSE_NOTHING_TO_COMPACT));
    if(item.status==="cancelled"||outcome==="cancelled")return compaction.fail(new Error(MUSE_COMPACTION_STOPPED));
    compaction.fail(new Error(compactionFailure(item.reason||item.failureReason)));
  }

  // Stop: turn/interrupt for the running turn once Muse has admitted it, then its turn/completed. A host that does not confirm
  // the stop within interruptTimeoutMs is stopped itself, and the next message starts it again.
  // The turn's own approvals and questions go at once: Muse settles them as it stops the turn, so none is answered for the person.
  async cancel(){
    const turn=this.activePrompt;
    // A compaction under way with no turn running: its host is stopped, since Muse has no stop for one (compact).
    if((!turn||turn.settled)&&this.compaction){this.compaction.fail(new Error(MUSE_COMPACTION_STOPPED));return void this.#lose(MUSE_COMPACTION_STOPPED,{stop:true,quiet:true})}
    if(!turn||turn.settled)return;
    turn.stopRequested=true;this.#withdrawRequests(entry=>!entry.child);
    // A turn that took Muse's report over for a message never sent (Stop came first): the report is stopped, and the turn ends here.
    if(turn.successor&&!turn.prompted){
      for(const id of turn.joined)if(!turn.endedJoined.has(id))try{await this.#command("turn/interrupt",{sessionId:this.sessionId,turnId:id})}catch{}
      if(!turn.prompted){turn.admit(false);turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null})}
      return;
    }
    if(!(await turn.admitted)||turn.settled)return;
    // Muse runs a turn this one took in first, so Stop ends it too.
    for(const id of turn.joined)if(!turn.endedJoined.has(id)&&!turn.settled)try{await this.#command("turn/interrupt",{sessionId:this.sessionId,turnId:id})}catch{}
    if(turn.settled)return;
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
    this.compaction?.fail(new Error("Muse Code stopped before it finished compacting the conversation."));
    this.#settleObserved("Muse Code stopped before this finished.");
    this.#withdrawRequests();
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
  // Every approval and question the host asked goes with it, a workflow child's too.
  #lose(message,{stop=false,quiet=false}={}){
    if(this.dead||this.closed)return;
    this.dead=true;this.deadError=Object.assign(new Error(message),{code:"MUSE_HOST_LOST"});
    // A compaction under way ends with the host's reason, which its own request reports.
    const turn=this.activePrompt,compaction=this.compaction;compaction?.fail(this.deadError);
    if(turn&&!turn.settled){if(turn.stopRequested)turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null});else turn.fail(this.deadError)}
    // A host lost between turns failed no turn: its notice names none (turnless), and says what the next message does.
    else if(!quiet&&!compaction)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",turnless:true,message:message.endsWith(MUSE_NEXT_MESSAGE)?message:`${/[.!?…]$/.test(message)?message:message+"."} ${MUSE_NEXT_MESSAGE}`}});
    this.#settleObserved(message);
    this.#withdrawRequests();
    if(stop)void this.host?.close().catch(()=>{});
  }

  // Muse sends a pending approval or question both as a notification and as a server request, answered with the presentation
  // receipt {}; Trebell's answer goes out as a command of its own (approval/decide, userInput/answer or userInput/cancel).
  async #serverRequest(host,request){
    const params=request?.params||{};
    if(this.host===host&&params.sessionId===this.sessionId){
      if(request.method==="approval/request"){this.#approvalEvent("approval/requested",params);return {}}
      if(request.method==="userInput/request"){this.#questionEvent("userInput/requested",params);return {}}
    }
    throw new host.sdk.MspError({code:-32601,message:`method not found: ${request?.method}`,data:{kind:"methodNotFound",retryable:false}});
  }

  // An approval of this session, routed by its session, a workflow child's too: asked once however many copies
  // of it come (the request, its notification, a re-send), an update keeps its latest stage and choices, and the stage after the one
  // decided (a staged shell command's next command) is asked in turn. An update of one Trebell never saw, and any copy of one Muse
  // has settled, asks nothing.
  #approvalEvent(method,params){
    const id=text(params.approvalId);if(!id)return;
    const key="approval:"+id;
    if(method==="approval/resolved"||params.change?.kind==="alreadyTerminal")return this.#settleRequest(key);
    if(this.settledRequests.has(key))return;
    const known=this.requests.get(key);
    if(known){
      known.params={...known.params,...params};
      // A card answers the stage and choices it shows (as Meta's SDK decides the request it asked about): one Muse has moved on from
      // (its next stage, or other choices) is withdrawn and what Muse asks now is asked in its place, so no
      // answer goes to a stage the person never saw.
      if(known.ask&&known.shown!==shownKey(known.params)){const ask=known.ask;known.ask=null;ask.abort()}
      return void this.#approve(known);
    }
    if(method!=="approval/requested")return;
    const entry={key,kind:"approval",id,params:{...params},child:Boolean(params.subagentOrigin),ask:null,shown:null,answer:null,automatic:null,attempts:0};
    this.requests.set(key,entry);void this.#approve(entry);
  }
  // Who answers the approval's current stage: nobody once it is decided, while Muse settles it or moves it to its next stage. In Full
  // access a workflow child's stage is answered Allow once without asking, as Muse does not pass allowAll on to workflow children,
  // unless only the person answers it (a protected write, a subject Trebell does not know); it is shown
  // only when Muse refuses that answer, and never once Muse has settled it. Every other stage goes to Trebell's policy and the card.
  async #approve(entry){
    // A decision Muse acknowledged as closing the whole approval (terminal) leaves no later stage to ask, though a trailing update
    // may still name one (Meta's SDK).
    if(this.requests.get(entry.key)!==entry||entry.ask||entry.answer?.pending||entry.answer?.closesApproval)return;
    const stage=requirementKey(entry.params.currentRequirementId);
    if(entry.answer?.stage===stage)return;
    if(entry.child&&this.launched?.plan.approvalMode==="allowAll"&&entry.automatic!==stage&&!personOnly(entry.params)){
      entry.automatic=stage;
      const outcome=await this.#sendAnswer(entry,"accept");
      if(outcome===ANSWER_TAKEN)return this.#approve(entry);
      if(outcome===ANSWER_SETTLED||this.requests.get(entry.key)!==entry)return;
    }
    return this.#askApproval(entry,{askUser:entry.automatic===stage});
  }
  // Asks the stage through the relay, as an ACP harness's request is asked: Trebell's policy answers what it allows or denies, and
  // the person the rest, on the approval card with Muse's own choices, which says what is asked and, for a child's, which agent asks
  // (museApprovalCard). askUser: only the person answers. So it is in Auto, whose reviewer (':auto-review') has cleared what it
  // could, as in Grok's Auto; for a protected write, a subject Trebell does not know, a stage with no Allow once to answer for the
  // person with, and a file read: Muse reads its workspace unasked, so one it asks about is outside it, and goes to the person
  // rather than to the workspace boundary that refuses what a harness does unasked (outsideReadsAsk). A card Muse settles
  // meanwhile is withdrawn (signal); a window that never answers declines, rather than leave Muse waiting.
  async #askApproval(entry,{askUser=false}={}){
    const params=entry.params,choices=museDecisionChoices(params.availableChoices),read=params.subject?.kind==="fileAccess"&&params.subject?.access==="read";
    // The stage and choices asked about, which the answer decides.
    const shown={requirementId:params.currentRequirementId,availableChoices:params.availableChoices};
    if(typeof this.onPermission!=="function")return this.#answerApproval(entry,"decline",shown);
    const ask=new AbortController();entry.ask=ask;entry.shown=shownKey(params);
    // The agent that asks, by name, and whether its work runs on past a turn that has ended (observed, its turn settled).
    const origin=params.subagentOrigin||{},agent=[origin.subagentId,origin.childRunId,origin.childSessionId].map(id=>this.agentNames.get(text(id))).find(Boolean);
    const runsPast=Boolean(agent&&this.observed.get(agent.itemId)?.settled);
    let decision="decline";
    try{
      decision=await this.onPermission({
        method:"approval/requested",params:{toolCall:museApprovalToolCall(params)},card:museApprovalCard(params,{agent:agent?.name||"",runsPast,sandboxUnavailable:this.sandboxUnavailable}),
        options:(Array.isArray(params.availableChoices)?params.availableChoices:[]).filter(choice=>choice?.choiceId).map(choice=>({optionId:text(choice.choiceId),name:text(choice.label),kind:text(choice.decision)})),
        askUser:askUser||this.launched?.plan.permissionProfile===":auto-review"||personOnly(params)||!choices.has("accept")||read,
        approvalOptions:museCardButtons(params.availableChoices),signal:ask.signal,...(read?{outsideReadsAsk:true}:{}),
        // A workflow child's approval belongs to no turn of Trebell's: Stop leaves its card waiting.
        ...(entry.child?{runless:true}:{}),
      });
    }catch{decision="decline"}
    finally{if(entry.ask===ask)entry.ask=null}
    if(ask.signal.aborted||this.requests.get(entry.key)!==entry)return;
    return this.#answerApproval(entry,decision,shown);
  }
  // The answer for the stage asked (shown: the stage and choices it was asked with, else the approval's current ones). Cancel (a card
  // the relay withdrew as its thread stopped) is Muse's abort, or its Reject. A decision Muse refuses is asked again on the card, a few
  // times at most; one for a stage Muse has moved past goes nowhere, and the stage Muse asks now is asked in turn, here or by the
  // update that moves it; a stage that cannot be declined stops the turn rather than leave it waiting.
  async #answerApproval(entry,decision,shown=null){
    const wanted=museDecisionToSend(decision,museDecisionChoices(shown?shown.availableChoices:entry.params.availableChoices));
    const outcome=await this.#sendAnswer(entry,wanted,shown);
    if(outcome===ANSWER_TAKEN)return this.#approve(entry);
    if(outcome===ANSWER_SETTLED||this.requests.get(entry.key)!==entry)return;
    if(outcome===ANSWER_MOVED_ON)return requirementKey(entry.params.currentRequirementId)===requirementKey(shown?.requirementId)?undefined:this.#approve(entry);
    if(outcome===ANSWER_NOT_OFFERED&&(wanted==="decline"||wanted==="cancel"))return void this.cancel();
    if(++entry.attempts>=MUSE_ASK_ATTEMPTS)return;
    return this.#askApproval(entry,{askUser:true});
  }
  // Sends Trebell's answer for one stage as approval/decide: the stage and choices a card showed (shown), else the approval's current
  // ones. The command names the stage's requirement, so Muse can tell an answer meant for a stage it has left (approvalRequirementStale).
  // Its reply only admits the command, and the approval/resolved or approval/updated that says what the answer did can come first, so
  // the answer goes on the approval's record (entry.answer: the stage it is for, and whether Muse has yet to reply) before the command
  // leaves: an update that comes meanwhile asks nothing, nor one naming the same stage afterwards. An answer that does not get through
  // comes off the record again, so its stage can be asked again. Returns one of the ANSWER_ outcomes.
  async #sendAnswer(entry,decision,shown=null){
    const asked=shown||{requirementId:entry.params.currentRequirementId,availableChoices:entry.params.availableChoices};
    const choice=museDecisionChoices(asked.availableChoices).get(decision);
    if(!choice)return ANSWER_NOT_OFFERED;
    const answer={stage:requirementKey(asked.requirementId),pending:true,closesApproval:false};
    entry.answer=answer;
    const sent=await this.#command("approval/decide",{sessionId:this.sessionId,approvalId:entry.id,requirementId:asked.requirementId,choiceId:choice.choiceId})
      .then(reply=>({ok:true,reply}),error=>({ok:false,error}));
    answer.pending=false;
    if(!sent.ok){
      if(entry.answer===answer)entry.answer=null;
      return DECIDE_REFUSALS.get(sent.error?.kind)??ANSWER_REFUSED;
    }
    // A terminal answer closed the whole approval: a trailing update naming a later stage asks nothing (#approve).
    answer.closesApproval=sent.reply?.terminal===true;
    return ANSWER_TAKEN;
  }

  // A question: asked once in Trebell's question dialog however many copies of it come, and withdrawn when Muse
  // settles it (userInput/settled).
  #questionEvent(method,params){
    const id=text(params.userInputId);if(!id)return;
    const key="question:"+id;
    if(method==="userInput/settled")return this.#settleRequest(key);
    if(this.settledRequests.has(key)||this.requests.has(key))return;
    const entry={key,kind:"question",id,params:{...params},child:false,ask:null,attempts:0};
    this.requests.set(key,entry);void this.#askQuestion(entry);
  }
  // The answers go back as userInput/answer, a dialog the person closes as userInput/cancel. An answer
  // Muse would refuse, or refuses, is asked again saying what it lacked, a few times at most.
  async #askQuestion(entry,notes={}){
    const params=entry.params,questions=museDialogQuestions(params.questions,notes);
    if(!questions.length||typeof this.onQuestion!=="function")return this.#cancelQuestion(entry,questions.length?"Trebell Code had no window to ask the user in. Continue without the answer.":"The question had nothing to ask.");
    const ask=new AbortController();entry.ask=ask;
    let answers=null;
    try{answers=await this.onQuestion({toolName:text(params.toolName)||"request_user_input",input:{questions},signal:ask.signal})}catch{answers=null}
    finally{if(entry.ask===ask)entry.ask=null}
    if(ask.signal.aborted||this.requests.get(entry.key)!==entry)return;
    if(!answers||typeof answers!=="object"||!Object.keys(answers).length)return this.#cancelQuestion(entry,"The user closed the question without answering. Continue without the answer.");
    const built=museAnswerPayload(params.questions,answers);
    if(built.error)return ++entry.attempts>=MUSE_ASK_ATTEMPTS?this.#cancelQuestion(entry,`The user's answer could not be sent: ${built.error.message} Continue without the answer.`):this.#askQuestion(entry,{[built.error.questionId]:built.error.message});
    try{await this.#command("userInput/answer",{sessionId:this.sessionId,userInputId:entry.id,answers:built.answers})}
    catch(error){
      if(this.dead||this.requests.get(entry.key)!==entry||error?.kind==="userInputAlreadySettled"||error?.kind==="userInputNotFound"||++entry.attempts>=MUSE_ASK_ATTEMPTS)return;
      return this.#askQuestion(entry,{[questions[0].id]:text(error?.cause?.message||error?.message)});
    }
  }
  async #cancelQuestion(entry,reason){
    if(this.requests.get(entry.key)!==entry)return;
    await this.#command("userInput/cancel",{sessionId:this.sessionId,userInputId:entry.id,reason}).catch(()=>{});
  }
  // Muse settled an approval (approval/resolved: the person's answer, its reviewer's or its policy's) or a question
  // (userInput/settled): its card or dialog goes, and a late copy of it is not asked again.
  #settleRequest(key){
    this.settledRequests.add(key);if(this.settledRequests.size>MUSE_SETTLED_LIMIT)this.settledRequests.delete(this.settledRequests.values().next().value);
    const entry=this.requests.get(key);if(!entry)return;
    this.requests.delete(key);entry.ask?.abort();
  }
  #withdrawRequests(which=()=>true){
    for(const entry of [...this.requests.values()])if(which(entry)){this.requests.delete(entry.key);entry.ask?.abort()}
  }
  // The names a child's approval card says who asks with (its subagentOrigin names the agent): a subagent's, by its subagent id and its
  // child session, and a workflow agent's, by its child id, as their rows name them; a workflow's later revisions leave labels out.
  // Each with the item of the work it is (itemId: the subagent's, or its workflow's), which says whether it runs on past its turn.
  #nameAgents(item){
    if(item?.kind==="subagent"){const name=museLabel(item.role)||museLabel(item.objective);if(name)for(const id of [item.subagentId,item.childSessionId])if(text(id))this.agentNames.set(text(id),{name:"subagent "+name,itemId:text(item.itemId)})}
    if(item?.kind==="workflow")for(const child of Array.isArray(item.children)?item.children:[])if(museLabel(child?.label)&&text(child.childId))this.agentNames.set(text(child.childId),{name:"workflow agent "+museLabel(child.label),itemId:text(item.itemId)});
    while(this.agentNames.size>MUSE_SETTLED_LIMIT)this.agentNames.delete(this.agentNames.keys().next().value);
  }

  #notification(frame){
    const method=text(frame?.method),params=frame?.params;
    if(!params||typeof params!=="object")return;
    // usage/changed is the account's, and names no session.
    if(method==="usage/changed")return void this.#usageChanged(params);
    if(params.sessionId!==this.sessionId)return;
    // A gap in what Muse delivered: this host's account of the conversation can no longer be trusted.
    if(method==="view/gap")return void this.#lose(MUSE_VIEW_GAP_MESSAGE,{stop:true});
    if(method==="approval/requested"||method==="approval/updated"||method==="approval/resolved")return void this.#approvalEvent(method,params);
    if(method==="userInput/requested"||method==="userInput/settled")return void this.#questionEvent(method,params);
    // The thread's context meter, whichever turn runs.
    if(method==="session/contextUsage")return void this.#contextUsage(params);
    // The /compact under way, whose item names the turn whose context it compacts, not a turn of Trebell's.
    if(this.compaction&&ITEM_EVENTS.has(method)&&params.item?.kind==="compaction")return void this.#compactionItem(params.item);
    // The end of a command Muse sent to the background, whichever turn runs (#backgroundEnded).
    if(ITEM_EVENTS.has(method)&&params.item?.kind==="backgroundTerminalCompletion")return void this.#backgroundEnded(params.item);
    if(ITEM_EVENTS.has(method))this.#nameAgents(params.item);
    // An item of work a turn that ended left running settles its row in that turn.
    const itemId=ITEM_EVENTS.has(method)?text(params.item?.itemId):method==="item/delta"?text(params.itemId):"",owner=itemId?this.observed.get(itemId):null;
    if(owner?.settled)return ITEM_EVENTS.has(method)?this.#item(owner,params.item):this.#delta(owner,params);
    if(method==="turn/started")return void this.#turnStarted(text(params.turnId));
    const turn=this.activePrompt;if(!turn||turn.settled)return;
    if(ITEM_EVENTS.has(method))return this.#item(turn,params.item);
    if(method==="item/delta")return this.#delta(turn,params);
    const turnId=text(params.turnId),ours=!elsewhere(turn,turnId);
    if(method==="session/tokenUsage"&&ours)return void this.#tokenUsage(turn,params);
    if(method==="session/todoListChanged")return void this.#todos(turn,params);
    if(method==="turn/retryScheduled"&&ours)return void this.#retryScheduled(params);
    if(method==="turn/completed"&&turnId===turn.turnId)return this.#completed(turn,params);
    // A turn this one took in ending does not end this one; its own does.
    if(method==="turn/completed"&&turn.joined.has(turnId))return void this.#joinedCompleted(turn,turnId,params);
    // A queued turn Muse will never run (turn/unqueued) ended unrun.
    if(method==="turn/unqueued"&&turnId===turn.turnId)return turn.settle({stopReason:"cancelled",interrupted:turn.stopRequested,providerMessageId:null,raw:this.#result(turn,params)});
  }
  // A turn Muse starts itself: one that starts while Trebell's turn runs joins it, so its events are that turn's and Stop
  // ends it too; one while none runs, the report Muse writes once its background work finished, is a turn of its own in Trebell
  // (onWakeTurn) until it ends or a message takes it over (prompt). A copy of a turn that ended starts nothing.
  #turnStarted(turnId){
    if(!turnId||this.endedTurns.has(turnId))return;
    const running=this.activePrompt&&!this.activePrompt.settled?this.activePrompt:null;
    if(running){if(elsewhere(running,turnId))running.joined.add(turnId);return}
    if(!this.ready||this.closed||this.dead||typeof this.onWakeTurn!=="function")return;
    const turn=this.#newTurn(turnId,{wake:true});turn.admit(true);this.activePrompt=turn;this.lastTurn=turn;
    turn.done.then(()=>{},()=>{}).then(()=>{if(this.activePrompt===turn)this.activePrompt=null});
    try{this.onWakeTurn(turn.done)}catch{}
  }
  // A turn this one took in ended: Stop no longer ends it, and its totals count toward this turn's, past what a report this turn took
  // over had counted for its own turn (recorded), so no token counts twice.
  #joinedCompleted(turn,turnId,params){
    turn.endedJoined.add(turnId);this.#rememberEnded(turnId);
    const counts=museTokenCounts(params.usage);if(!counts)return;
    const sum=turn.joinedUsage||(turn.joinedUsage={input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0}),recorded=turn.recorded.get(turnId);
    for(const key of Object.keys(sum))sum[key]+=Math.max(0,counts[key]-(Number(recorded?.[key])||0));
  }
  // The latest usage report a quota stop reads its reset from, also kept for the Usage page by the Muse home it is of.
  #usageChanged(params){
    const usage=museSubscriptionUsage(params);
    if(!usage)return this.#skipped("usage/changed","it names no readable usage windows");
    this.subscriptionUsage=usage;rememberMuseSubscriptionUsage(usage,{museHome:text(this.initializeResult?.museHome)});
  }
  // A model step's tokens (session/tokenUsage): its counted-once prompt tokens count as the turn's input, and its output, cache and
  // reasoning counts as the turn's too.
  #tokenUsage(turn,params){
    const counts=museTokenCounts(params.usage);
    if(!counts||!Number.isInteger(params.promptTokens)||params.promptTokens<0)return this.#skipped("session/tokenUsage","it names no readable token counts");
    const usage=turn.usage;usage.steps++;usage.input+=params.promptTokens;
    for(const key of ["output","cacheRead","cacheWrite","reasoning"])usage[key]+=counts[key];
    this.#emitUsage(turn);
  }
  // What Muse's context holds of the model's window (session/contextUsage), shown with the tokens of the turn running or last run.
  #contextUsage(params){
    if(!Number.isInteger(params.usedTokens)||params.usedTokens<0)return this.#skipped("session/contextUsage","it names no readable context size");
    this.context={usedTokens:params.usedTokens,windowTokens:Number.isInteger(params.windowTokens)&&params.windowTokens>0?params.windowTokens:this.context?.windowTokens??null};
    const turn=this.lastTurn;if(turn&&(turn.usage.steps||turn.usage.reported))this.#emitUsage(turn);
  }
  // The turn's totals once it ends: input as its steps counted it, else as turn/completed adds it up, and the output, cache and
  // reasoning counts turn/completed adds up for it and for the turns it took in. A Muse that sends none keeps its steps' counts.
  #finalUsage(turn,params){
    const counts=museTokenCounts(params.usage),usage=turn.usage;
    if(counts){
      const joined=turn.joinedUsage||{input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0};
      if(!usage.steps)usage.input=counts.input+joined.input;
      for(const key of ["output","cacheRead","cacheWrite","reasoning"])usage[key]=Math.max(usage[key],counts[key]+joined[key]);
      usage.reported=true;
    }
    if(usage.steps||usage.reported)this.#emitUsage(turn);
  }
  // The turn's tokens as a usage_update in Trebell's shape (museTurnUsage), with the context meter's numbers: the model's window (size)
  // and what the context holds (contextTokens), which the relay shows as the last request's input.
  #emitUsage(turn){
    const usage=museTurnUsage(turn.usage),context=this.context;
    this.#emit(turn,{sessionUpdate:"usage_update",usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,cache_read_input_tokens:usage.cachedInputTokens,cache_write_input_tokens:usage.cacheWriteInputTokens,reasoning_tokens:usage.reasoningOutputTokens},
      used:usage.totalTokens,size:context?.windowTokens||0,...(context?{contextTokens:context.usedTokens}:{})});
  }
  // Muse's todo list as the turn's plan (museTodoPlan).
  #todos(turn,params){
    if(!Array.isArray(params.items))return this.#skipped("session/todoListChanged","it names no todo list");
    this.#emit(turn,{sessionUpdate:"plan",entries:museTodoPlan(params.items)});
  }
  // Muse retrying the turn's model request: the turn's retry row, as Native's wait for the network shows, and the turn goes on.
  #retryScheduled(params){
    const message=museRetryNotice(params);
    if(message)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",willRetry:true,message}});
    else this.#skipped("turn/retryScheduled","it names no readable attempt, delay or reason");
  }
  // An informational notice Trebell cannot read is skipped with a log line, and the session goes on.
  #skipped(method,reason){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",dropped:true,method,reason,message:`Trebell skipped Muse Code's ${method}: ${reason}.`}})}

  // Items keep their highest revision: an older one arriving late is ignored. Items of other turns are not this turn's, but those of
  // a turn it took in are. Work that runs on past its turn is followed until it ends (observed).
  #item(turn,item){
    if(!item||typeof item!=="object"||!item.itemId)return;
    if(elsewhere(turn,item.turnId))return;
    const previous=turn.items.get(item.itemId);
    if(previous&&Number(previous.revision)>=Number(item.revision))return;
    const current={...item,...(Array.isArray(item.summary)?{summary:[...item.summary]}:{})};
    turn.items.set(item.itemId,current);
    // Each word from that work, its end too, is the session's latest activity (workHeardAt). A row a report left open (openRows) is
    // followed the same way until it ends.
    if(this.observed.has(current.itemId)||runningWork(current,this.endedCalls))this.workHeardAt=this.now();
    if(runningWork(current,this.endedCalls)||this.openRows.has(current.itemId)&&current.status==="inProgress")this.observed.set(current.itemId,turn);
    else{this.observed.delete(current.itemId);this.openRows.delete(current.itemId)}
    this.#publish(turn,current);
  }
  // The end of a command Muse sent to the background (backgroundTerminalCompletion, naming its call): the command holds the host no
  // more, its end counts as use, and its row, in the turn that started it, settles with how it ended and what it said last. The end
  // shows no row of its own.
  #backgroundEnded(item){
    const done=item.backgroundTerminalCompletion,callId=text(done?.toolCallId);if(!callId)return;
    this.endedCalls.add(callId);if(this.endedCalls.size>MUSE_SETTLED_LIMIT)this.endedCalls.delete(this.endedCalls.values().next().value);
    for(const [itemId,owner] of [...this.observed]){
      const call=owner.items.get(itemId);if(call?.kind!=="toolCall"||text(call.callId)!==callId)continue;
      this.observed.delete(itemId);this.workHeardAt=this.now();
      const status=text(done.terminalStatus)==="completed"?"completed":text(done.terminalStatus)||"failed",ended={...call,status,...(typeof done.output==="string"&&done.output?{visibleOutput:done.output}:{})};
      owner.items.set(itemId,ended);this.#publish(owner,ended);
    }
  }
  // Deltas append to an open item by field: text to a reply, summary.N to part N of a reasoning summary, output to a command.
  #delta(turn,params){
    const item=turn.items.get(text(params.itemId));if(!item||item.status!=="inProgress")return;
    const field=text(params.field)||"text",delta=text(params.delta);if(!delta)return;
    if(field==="text")item.text=text(item.text)+delta;
    else if(field==="output"||field==="visibleOutput")item.visibleOutput=text(item.visibleOutput)+delta;
    else if(/^summary\.\d+$/.test(field)){const index=Number(field.slice(8));if(index>=100)return;const summary=[...(item.summary||[])];summary[index]=text(summary[index])+delta;item.summary=summary}
    else return;
    if(this.observed.get(item.itemId)===turn)this.workHeardAt=this.now();
    this.#publish(turn,item);
  }
  #publish(turn,item){
    if(museShowsNoRow(item))return;
    if(item.kind==="agentMessage")return this.#stream(turn,item,"agent_message_chunk",text(item.text));
    // A reasoning item's summary parts, or the provider's own reasoning text where it sends that instead.
    if(item.kind==="reasoning")return this.#stream(turn,item,"agent_thought_chunk",(Array.isArray(item.summary)?item.summary:[]).map(text).filter(Boolean).join("\n\n")||text(item.text));
    // Work followed past its turn (observed), a workflow's agents with it, says so on each of its rows to the one that settles it
    // (runsPastTurn): its turn's end leaves the row as it is in the window, for the work's own later rows to settle.
    if(this.observed.get(item.itemId)===turn)turn.followed.add(item.itemId);
    const past=turn.followed.has(item.itemId);
    this.#row(turn,museItemRow(item,{running:runningWork(item,this.endedCalls)}),{work:WORK_KINDS.has(item.kind),past});
    // A workflow's agents follow its own row.
    if(item.kind==="workflow")for(const update of museWorkflowAgentRows(item,turn.labels))this.#row(turn,update,{work:true,past});
  }
  // One row's update: tool_call the first time, tool_call_update after. A subagent's or a workflow's goes only when it shows something
  // new, as Muse re-sends them whole on each change, and one that settled keeps the end it had.
  #row(turn,update,{work=false,past=false}={}){
    const frame=acpToolFrame(update),id=frame.toolCallId;
    if(work){const shown=JSON.stringify([frame.status,frame.title,frame.rawOutput]);if(turn.rows.get(id)===shown)return;turn.rows.set(id,shown)}
    const first=!turn.tools.has(id);turn.tools.add(id);
    this.#emit(turn,{...frame,sessionUpdate:first?"tool_call":"tool_call_update",...(past?{runsPastTurn:true}:{})});
  }
  // A turn's updates name it (turnKey): the relay keeps a row of a turn that ended in that turn, not in the thread's last one.
  #emit(turn,update){this.onUpdate?.({sessionId:this.sessionId,turnKey:turn.turnId,update})}
  // The text an item has that has not been sent yet: what a delta added, or on item/completed what the final text has beyond what
  // streamed. A later reply of the turn starts a paragraph of its own.
  #stream(turn,item,type,full){
    const sent=turn.sent.get(item.itemId)||"";
    if(sent&&!full.startsWith(sent))return;
    const chunk=full.slice(sent.length);if(!chunk)return;
    turn.sent.set(item.itemId,full);
    let value=chunk;
    if(type==="agent_message_chunk"){if(!sent&&turn.lastMessage&&turn.lastMessage!==item.itemId&&!/^\s*\n/.test(chunk))value="\n\n"+chunk;turn.lastMessage=item.itemId}
    this.#emit(turn,{sessionUpdate:type,content:{type:"text",text:value},messageId:item.itemId});
  }
  // turn/completed settles the prompt: completed ends the turn, cancelled is a stop (interrupted when the person asked for it), and
  // failed fails it with Muse's own error. A stop the subscription quota made is a usage limit (usageLimit, resetAt), as Claude Code's
  // and Grok's are: its message says Muse Code is out of usage until its allowance resets (museOutOfUsageMessage), with Muse's own
  // words kept as its detail; a turn Muse could not run signed out says how to sign in.
  #completed(turn,params){
    this.#finalUsage(turn,params);
    const terminal=text(params.terminal),raw=this.#result(turn,params);
    if(terminal==="completed")return turn.settle({stopReason:"end_turn",providerMessageId:null,raw});
    if(terminal==="cancelled")return turn.settle({stopReason:"cancelled",interrupted:turn.stopRequested,providerMessageId:null,raw});
    const error=params.error&&typeof params.error==="object"?params.error:{},detail=text(error.message)||text(params.reason),code=text(error.kind)||"MUSE_TURN_FAILED";
    if(museQuotaStop(error,detail)){
      const resetAt=museLimitLiftsAt(this.subscriptionUsage,Date.now(),{quota:error.quota,message:detail});
      return turn.fail(Object.assign(new Error(museOutOfUsageMessage(resetAt)),{code,usageLimit:true,resetAt,detail,raw}));
    }
    // signedOut: the message says how to sign in, so the relay's check after it adds no second sign-in advice.
    if(code==="authRequired")return turn.fail(Object.assign(new Error(MUSE_SIGNED_OUT_MESSAGE),{code,detail,raw,signedOut:true}));
    turn.fail(Object.assign(new Error(detail||"Muse Code could not finish the turn."),{code,raw}));
  }
}
