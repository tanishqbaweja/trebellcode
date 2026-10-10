import { configuredReasoningEffort, normalizeRuntimeReasoningEffort } from "../../src/model-reasoning-effort.mjs";
import { codexServiceTierForTurn, codexServiceTierPickerValue, configuredModelServiceTier } from "../../src/model-service-tier.mjs";

// Codex turn options, input and errors, aligned with T3 Code's Codex adapter (apps/server/src/orchestration-v2/Adapters/
// CodexAdapterV2.ts) and provider (apps/server/src/provider/CodexProvider.ts).

// The settings Codex reports for a thread: thread/resume ({model, reasoningEffort, serviceTier}) and
// thread/settings/updated ({threadSettings:{model, effort, serviceTier}}).
export function codexThreadSettings(threadId,source={}){
  const id=String(threadId||"").trim(),settings=source?.threadSettings&&typeof source.threadSettings==="object"?source.threadSettings:source;
  const model=String(settings?.model||"").trim();
  if(!id||!model)return null;
  const effort=Object.prototype.hasOwnProperty.call(settings,"effort")?settings.effort:settings.reasoningEffort;
  return {threadId:id,model,effort:normalizeRuntimeReasoningEffort("codex",effort),serviceTier:String(settings?.serviceTier||"").trim()||null};
}

// The effort and tier a Codex turn sends and the composer shows. While the open thread is on the model it runs, they are
// the thread's own settings (T3 shows and sends activeThread.modelSelection); otherwise the user's pick for the model, else
// the custom model's. effort null sends none (Codex uses the model's default); serviceTier null sends none (the thread
// keeps its tier).
export function codexModelChoices({settings={},provider="",model="",metadata={},custom=null,thread=null}={}){
  const fromThread=Boolean(thread?.model&&thread.model===model);
  const effort=fromThread?thread.effort:(configuredReasoningEffort(settings,"codex",provider,model)||normalizeRuntimeReasoningEffort("codex",custom?.effort));
  const tier=fromThread?thread.serviceTier:configuredModelServiceTier(settings,"codex",provider,model),customTier=fromThread?null:custom?.serviceTier||null;
  return {
    fromThread,
    effort:effort||null,
    serviceTier:codexServiceTierForTurn({configured:tier,custom:customTier,metadata}),
    serviceTierPicker:codexServiceTierPickerValue(tier,metadata,customTier),
  };
}

// T3 PROVIDER_SEND_TURN_MAX_INPUT_CHARS: attachment lines that would push the text past it are left out.
export const CODEX_MAX_INPUT_CHARS=120_000;
const IMAGE=/\.(png|jpe?g|gif|webp|bmp)$/i,AUDIO=/\.(mp3|wav|m4a|ogg|flac)$/i;
function fileName(path){return String(path||"").split(/[\\/]/).pop()||"attachment"}

// T3 providerMessageTextWithAttachmentPaths: every attachment is named in the prompt with the path it is saved at, so
// Codex reads it with its own tools; images and audio also go as native items.
export function codexTurnInput(text,paths=[],{displayName=fileName,maxChars=CODEX_MAX_INPUT_CHARS}={}){
  let body=String(text??"");const media=[];
  for(const path of Array.isArray(paths)?paths:[]){
    const value=String(path||"");if(!value)continue;
    const image=IMAGE.test(value),line=`[Attached ${image?"image":"file"} "${displayName(value)}" is saved at: ${value}]`;
    const candidate=body?`${body}\n\n${line}`:line;
    if(candidate.length<=maxChars)body=candidate;
    if(image)media.push({type:"localImage",path:value});
    else if(AUDIO.test(value))media.push({type:"localAudio",path:value});
  }
  return [{type:"text",text:body,textElements:[]},...media];
}

// The prompt and attachment paths of a Codex input text built by codexTurnInput, so a queued follow-up is edited as the
// draft it was.
const ATTACHMENT_LINE=/^\[Attached (?:image|file) "[^"\n]*" is saved at: ([^\n]+)\]$/u;
export function splitCodexAttachmentText(text){
  const blocks=String(text??"").split("\n\n"),paths=[];
  while(blocks.length){
    const match=ATTACHMENT_LINE.exec(blocks.at(-1));if(!match)break;
    paths.unshift(match[1]);blocks.pop();
  }
  return {text:blocks.join("\n\n"),paths};
}

// T3 parseCodexGoalCommand: /goal shows the goal (as does /goal edit), clear, pause and resume control it, and any other
// text becomes the new objective. Returns null for every other message.
export function parseCodexGoalCommand(text){
  const match=/^\/goal(?:\s+([\s\S]*))?$/u.exec(String(text??"").trim());
  if(!match)return null;
  const argument=(match[1]??"").trim();
  switch(argument.toLowerCase()){
    case "":case "edit":return {type:"show"};
    case "clear":return {type:"clear"};
    case "pause":return {type:"pause"};
    case "resume":return {type:"resume"};
    default:return {type:"set",objective:argument};
  }
}

const GOAL_STATUS_LABELS={active:"active",paused:"paused",blocked:"blocked",usageLimited:"usage limited",budgetLimited:"budget limited",complete:"complete"};
export function codexGoalStatusLabel(status){return GOAL_STATUS_LABELS[status]||String(status||"")}
export function describeCodexGoal(goal){
  return goal?.objective?`Goal ${codexGoalStatusLabel(goal.status)}: ${goal.objective}`:"No goal is set.";
}

// T3 codexErrorInfoCode: the camel-case code of a CodexErrorInfo (a string, or an object keyed by its variant).
export function codexErrorInfoCode(value){
  if(typeof value==="string")return value||null;
  if(!value||typeof value!=="object")return null;
  return Object.keys(value)[0]??null;
}

// T3 parseCodexRetryProgress: "attempt/max" in a retry message.
export function parseCodexRetryProgress(message){
  const match=/\b(\d+)\s*\/\s*(\d+)\b/u.exec(String(message??""));
  if(!match)return null;
  const attempt=Number.parseInt(match[1],10),maxAttempts=Number.parseInt(match[2],10);
  return attempt>=1&&maxAttempts>=1?{attempt,maxAttempts}:null;
}

function errorText(error){
  return String(error?.additionalDetails??"").trim()||String(error?.message??"").trim();
}

// A Codex `error` notification ({error:{message, codexErrorInfo, additionalDetails}, willRetry, threadId, turnId}), as T3
// reads it: the text is additionalDetails or message, usage and rate limits are usage-limit failures, http* and
// responseStream* are transport failures, and willRetry means Codex is still working on the turn.
export function codexErrorNotice(params={}){
  const error=params?.error&&typeof params.error==="object"?params.error:null;
  const message=errorText(error)||String(params?.message??"").trim()||"Agent error";
  const code=codexErrorInfoCode(error?.codexErrorInfo);
  const kind=code==="usageLimitExceeded"||code==="rateLimitExceeded"?"usage_limit"
    :code==="unauthorized"?"auth"
    :code?.startsWith("http")||code?.startsWith("responseStream")?"transport"
    :"provider";
  const hint=kind==="usage_limit"?"See Usage for your Codex limits.":kind==="auth"?"Sign in to Codex again from Agents & models, or run codex login.":"";
  const willRetry=params?.willRetry===true;
  const retry=willRetry?parseCodexRetryProgress(error?.message||message):null;
  const title=willRetry
    ?`Retrying${retry?` (${retry.attempt}/${retry.maxAttempts})`:""}: ${message}`
    :(hint?`${message} · ${hint}`:message);
  return {message,code,kind,hint,willRetry,retry,title};
}

// The failure of a Codex turn that ended with status "failed" (Turn.error is only set then), or null.
export function codexTurnFailure(turn){
  if(turn?.status!=="failed")return null;
  const error=turn.error&&typeof turn.error==="object"?turn.error:null;
  return codexErrorNotice({error:error||{message:"The turn failed."}});
}
