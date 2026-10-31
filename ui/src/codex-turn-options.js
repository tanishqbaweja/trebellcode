import { configuredReasoningEffort, normalizeRuntimeReasoningEffort } from "../../src/model-reasoning-effort.mjs";
import { codexServiceTierForTurn, codexServiceTierPickerValue, configuredModelServiceTier } from "../../src/model-service-tier.mjs";

// Codex turn options, input and errors, as Codex's app-server takes and sends them.

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
// the thread's own settings; otherwise the user's pick for the model, else
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

// The longest text a Codex turn sends, the composer's limit on the typed text (App.jsx MAX_COMPOSER_CHARS).
export const CODEX_MAX_INPUT_CHARS=120_000;
const IMAGE=/\.(png|jpe?g|gif|webp|bmp)$/i,AUDIO=/\.(mp3|wav|m4a|ogg|flac)$/i;
function fileName(path){return String(path||"").split(/[\\/]/).pop()||"attachment"}

// The file each attached Word, Excel or other document's text was extracted to, as the GUI server's check of a message's files before
// it goes answers it (textPath, src/document-text.mjs), so the message names it: "(text extracted to: <file>)".
const documentTexts=new Map();
export function noteDocumentTexts(files){for(const file of Array.isArray(files)?files:[])if(file?.path)file.textPath?documentTexts.set(String(file.path),String(file.textPath)):documentTexts.delete(String(file.path))}
export const documentTextPath=path=>documentTexts.get(String(path))||null;
export const documentTextNote=path=>{const text=documentTextPath(path);return text?` (text extracted to: ${text})`:""};

// Every attachment is named in the prompt with the path it is saved at, so
// Codex reads it with its own tools; images and audio also go as native items. The lines follow the text whatever its length:
// a file has no item of its own, so a line left out would be a file Codex never sees. A document's line names the
// file its text was extracted to too (textPath).
export function codexTurnInput(text,paths=[],{displayName=fileName,textPath=documentTextPath}={}){
  let body=String(text??"");const media=[];
  for(const path of Array.isArray(paths)?paths:[]){
    const value=String(path||"");if(!value)continue;
    const image=IMAGE.test(value),extracted=image?null:textPath(value);
    const line=`[Attached ${image?"image":"file"} "${displayName(value)}" is saved at: ${value}${extracted?` (text extracted to: ${extracted})`:""}]`;
    body=body?`${body}\n\n${line}`:line;
    if(image)media.push({type:"localImage",path:value});
    else if(AUDIO.test(value))media.push({type:"localAudio",path:value});
  }
  return [{type:"text",text:body,textElements:[]},...media];
}

// The prompt and attachment paths of a Codex input text built by codexTurnInput, so a queued follow-up is edited as the
// draft it was.
const ATTACHMENT_LINE=/^\[Attached (?:image|file) "[^"\n]*" is saved at: ([^\n]+?)(?: \(text extracted to: [^\n]+\))?\]$/u;
export function splitCodexAttachmentText(text){
  const blocks=String(text??"").split("\n\n"),paths=[];
  while(blocks.length){
    const match=ATTACHMENT_LINE.exec(blocks.at(-1));if(!match)break;
    paths.unshift(match[1]);blocks.pop();
  }
  return {text:blocks.join("\n\n"),paths};
}

const GOAL_STATUS_LABELS={active:"active",paused:"paused",blocked:"blocked",usageLimited:"usage limited",budgetLimited:"budget limited",complete:"complete"};
export function codexGoalStatusLabel(status){return GOAL_STATUS_LABELS[status]||String(status||"")}
export function describeCodexGoal(goal){
  return goal?.objective?`Goal ${codexGoalStatusLabel(goal.status)}: ${goal.objective}`:"This thread has no goal.";
}
// A Codex without goals (an app-server from before them) refuses thread/goal/* as a method it does not have: "Invalid request:
// unknown variant `thread/goal/get`, expected one of …", as Codex refuses any method it lacks, or JSON-RPC's Method not found.
export function codexGoalsMissing(error){
  return /method not found|unknown variant `?thread\/goal/i.test(error?.message);
}

// The camel-case code of a CodexErrorInfo (a string, or an object keyed by its variant).
export function codexErrorInfoCode(value){
  if(typeof value==="string")return value||null;
  if(!value||typeof value!=="object")return null;
  return Object.keys(value)[0]??null;
}

// The "attempt/max" in a retry message.
export function parseCodexRetryProgress(message){
  const match=/\b(\d+)\s*\/\s*(\d+)\b/u.exec(String(message??""));
  if(!match)return null;
  const attempt=Number.parseInt(match[1],10),maxAttempts=Number.parseInt(match[2],10);
  return attempt>=1&&maxAttempts>=1?{attempt,maxAttempts}:null;
}

function errorText(error){
  return String(error?.additionalDetails??"").trim()||String(error?.message??"").trim();
}

// A Codex `error` notification ({error:{message, codexErrorInfo, additionalDetails}, willRetry, threadId, turnId}), read so:
// the text is additionalDetails or message, usage and rate limits are usage-limit failures, http* and
// responseStream* are transport failures, and willRetry means Codex is still working on the turn. Retries that ran out
// (responseTooManyFailedAttempts) say why only by the last attempt's HTTP status: a 429 is a usage limit, any other status a
// provider error.
export function codexErrorNotice(params={}){
  const error=params?.error&&typeof params.error==="object"?params.error:null;
  const message=errorText(error)||String(params?.message??"").trim()||"Agent error";
  const code=codexErrorInfoCode(error?.codexErrorInfo);
  const kind=code==="usageLimitExceeded"||code==="rateLimitExceeded"||error?.codexErrorInfo?.responseTooManyFailedAttempts?.httpStatusCode===429?"usage_limit"
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
