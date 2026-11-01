import { configuredReasoningEffort, normalizeRuntimeReasoningEffort } from "../../src/model-reasoning-effort.mjs";
import { codexServiceTierForTurn, codexServiceTierPickerValue, configuredModelServiceTier } from "../../src/model-service-tier.mjs";
import { attachedPathOf, attachmentLine, readableTextNote } from "../../src/attachment-line.mjs";

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

// The longest text a Codex turn sends, the composer's limit on the typed text (App.jsx MAX_COMPOSER_CHARS). Codex itself takes up
// to 1,048,576 characters (MAX_USER_INPUT_TEXT_CHARS, codex-rs/protocol/src/user_input.rs), so the composer's limit is the one
// that binds.
export const CODEX_MAX_INPUT_CHARS=200_000;

// ---- Attachments
// Codex opens an attached file from the path its message names (src/attachment-line.mjs). An image or an audio file also goes as
// an item of its own, which Codex sends the model as it is; the kind comes from the file's extension, in any letter case.
const ITEM_KINDS=new Map([
  ...["png","jpg","jpeg","gif","webp","bmp"].map(extension=>[extension,"image"]),
  ...["mp3","wav","m4a","ogg","flac"].map(extension=>[extension,"audio"]),
]);
const ITEM_TYPES=Object.freeze({image:"localImage",audio:"localAudio"});
function lastPart(path){return String(path??"").split(/[\\/]/).pop()}
function attachmentKind(path){
  const name=lastPart(path),dot=name.lastIndexOf(".");
  return (dot<0?null:ITEM_KINDS.get(name.slice(dot+1).toLowerCase()))??"file";
}

// What the GUI server's check of a message's files answered for each attached Word, Excel or other document: the file Trebell
// extracted its text to (textPath, src/document-text.mjs). A file the check names without one is forgotten.
const textFiles=new Map();
export function noteDocumentTexts(files){
  for(const file of Array.isArray(files)?files:[]){
    if(!file?.path)continue;
    if(file.textPath)textFiles.set(String(file.path),String(file.textPath));
    else textFiles.delete(String(file.path));
  }
}
export function documentTextPath(path){return textFiles.get(String(path))??null}
// What follows a document's path where a message lists its files (an answer to a question), else nothing.
export function documentTextNote(path){return readableTextNote(documentTextPath(path))}

// A Codex turn's input: one text item, then an item for each image and audio file, in the order attached. The text item holds the
// typed text whole, then a blank line, then one line for each attachment, one under the other, so the composer's limit on the
// text never hides a file (a file has no item of its own, and Codex would never see one left out). A document's line also names
// the file its text was extracted to (textPath); an image's never does.
export function codexTurnInput(text,paths=[],{displayName=lastPartOrAttachment,textPath=documentTextPath}={}){
  const lines=[],items=[];
  for(const entry of Array.isArray(paths)?paths:[]){
    const path=String(entry||"");
    if(!path)continue;
    const kind=attachmentKind(path);
    lines.push(attachmentLine(kind,displayName(path),path,kind==="image"?null:textPath(path)));
    if(ITEM_TYPES[kind])items.push({type:ITEM_TYPES[kind],path});
  }
  const parts=[String(text??""),lines.join("\n")].filter(part=>part!=="");
  return [{type:"text",text:parts.join("\n\n"),textElements:[]},...items];
}
function lastPartOrAttachment(path){return lastPart(path)||"attachment"}

// A Codex message's text as the person typed it and the paths of the files it went with, so a queued follow-up is edited as the
// draft it was and a thread opened again shows its messages' files. The lines that name attachments at the end of the text come
// off: the ones codexTurnInput writes, and the earlier wording older threads hold, where a blank line parted every line
// (attachedPathOf reads both). One blank line, the one before the first attachment, goes with them. A text without such lines
// comes back as it is.
export function splitCodexAttachmentText(text){
  const whole=String(text??""),lines=whole.split("\n"),paths=[];
  let kept=lines.length;
  for(let index=lines.length-1;index>=0;index--){
    if(lines[index]==="")continue;
    const path=attachedPathOf(lines[index]);
    if(path===null)break;
    paths.unshift(path);kept=index;
  }
  if(!paths.length)return {text:whole,paths};
  const typed=lines.slice(0,kept);
  if(typed.at(-1)==="")typed.pop();
  return {text:typed.join("\n"),paths};
}

const GOAL_STATUS_LABELS={active:"active",paused:"paused",blocked:"blocked",usageLimited:"usage limited",budgetLimited:"budget limited",complete:"complete"};
export function codexGoalStatusLabel(status){return GOAL_STATUS_LABELS[status]||String(status||"")}
// The line that says what goal a Codex thread has: the note /goal leaves, and the notification when Codex ends an active goal.
export function codexGoalLine(goal){
  const objective=goal?.objective;
  if(!objective)return "This thread has no goal.";
  return `Goal ${codexGoalStatusLabel(goal.status)}: ${objective}`;
}
// A Codex without goals (an app-server from before them) refuses thread/goal/* as a method it does not have: "Invalid request:
// unknown variant `thread/goal/get`, expected one of …", as Codex refuses any method it lacks, or JSON-RPC's Method not found.
export function codexGoalsMissing(error){
  return /method not found|unknown variant `?thread\/goal/i.test(error?.message);
}

// The variant a Codex error names (TurnError.codexErrorInfo), or null: Codex writes a variant without data as its camel-case
// name ("usageLimitExceeded") and one with data as an object whose one key is that name ({httpConnectionFailed:{...}}).
export function codexErrorVariant(info){
  switch(typeof info){
    case "string":return info===""?null:info;
    case "object":{
      if(info===null)return null;
      const [variant=null]=Object.keys(info);
      return variant;
    }
    default:return null;
  }
}

// How far Codex has got trying a request again, as its error's message counts it: "Reconnecting... 2/5" is try 2 of
// five ("Reconnecting... waiting for network" counts none). The count is the first slash with a whole number on each side, blanks
// allowed between: {attempt, maxAttempts}, or null without one or when it holds a 0.
export function codexRetryCount(message){
  const text=String(message??"");
  for(const {index:slash} of text.matchAll(/\//g)){
    const attempt=wholeNumberBeside(text,slash,-1);
    if(attempt===null)continue;
    const maxAttempts=wholeNumberBeside(text,slash,1);
    if(maxAttempts===null)continue;
    return attempt>0&&maxAttempts>0?{attempt,maxAttempts}:null;
  }
  return null;
}
// The whole number written next to the character at `slash`, before it (side -1) or after it (side 1), blanks between them
// skipped: a run of digits with no letter, digit or "_" right beyond it ("v2" and "5x" are words). null without one.
const BLANK=/\s/,WORD_CHARACTER=/\w/;
function wholeNumberBeside(text,slash,side){
  const inText=at=>at>=0&&at<text.length;
  let at=slash+side;
  while(inText(at)&&BLANK.test(text[at]))at+=side;
  const near=at;
  while(inText(at)&&text[at]>="0"&&text[at]<="9")at+=side;
  if(at===near||(inText(at)&&WORD_CHARACTER.test(text[at])))return null;
  return Number(side<0?text.slice(at+1,near+1):text.slice(near,at));
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
  const code=codexErrorVariant(error?.codexErrorInfo);
  const kind=code==="usageLimitExceeded"||code==="rateLimitExceeded"||error?.codexErrorInfo?.responseTooManyFailedAttempts?.httpStatusCode===429?"usage_limit"
    :code==="unauthorized"?"auth"
    :code?.startsWith("http")||code?.startsWith("responseStream")?"transport"
    :"provider";
  const hint=kind==="usage_limit"?"See Usage for your Codex limits.":kind==="auth"?"Sign in to Codex again from Agents & models, or run codex login.":"";
  const willRetry=params?.willRetry===true;
  const retry=willRetry?codexRetryCount(error?.message||message):null;
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
