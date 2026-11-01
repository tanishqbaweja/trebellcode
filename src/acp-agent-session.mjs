import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AcpClient, defaultAcpClientCapabilities } from "./acp-client.mjs";
import { ANTIGRAVITY_API_KEY_METHOD, ANTIGRAVITY_SIGN_IN_NEEDED } from "./antigravity-auth.mjs";
import { acpStartFailure } from "./acp-start-exit.mjs";
import { acpApplyValue, acpConfigSelect, acpReadOnlyMode, acpSetupWithConfigOptions, acpSetupWithValue } from "./acp-session-config.mjs";
import { cursorEffortChange, cursorFastChange, cursorPickedChange, GROK_INITIALIZE_META } from "./acp-model-catalog.mjs";
import { acpToolFrame, mergeAcpToolUpdate } from "./acp-tool-state.mjs";
import { CursorLostBackendReply } from "./cursor-transport-failure.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { acpApiKeyMethod } from "./harness-auth.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizeModelOptionValues } from "./model-options.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionKind, normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { attachmentLine, unsentImageLine } from "./attachment-line.mjs";
import { documentKind } from "./document-reading.mjs";
import { attachmentName, PROMPT_AUDIO_PATH, PROMPT_IMAGE_PATH, PROMPT_TEXT_PATH, unreadableAttachment } from "./prompt-attachments.mjs";
import { runtimeHarnessLabel, runtimeInstructions } from "./runtime-instructions.mjs";
import { SessionRefusalError } from "./session-refusal.mjs";

// Generic ACP session used for Cursor, Grok Build, Antigravity and remote-environment OpenCode,
// one runtime for all of them, with what differs for Cursor, Grok and Antigravity kept in it.

const CANCELLED=Symbol("cancelled");
// Updates that describe the session rather than a turn; they pass while a session starts or loads.
const METADATA_UPDATES=new Set(["available_commands_update","config_option_update","current_mode_update","session_info_update"]);
// Turn updates after which Cursor's next text is a new reply message.
const CURSOR_MESSAGE_BREAKS=new Set(["tool_call","tool_call_update","agent_thought_chunk","plan"]);
// Grok and Antigravity resume without replaying history; the rest load.
const RESUME_FIRST=new Set(["grok","antigravity"]);
// The model ids Trebell used before real model lists; they mean "the harness's current model".
const MODEL_ALIASES={grok:"grok-build",cursor:"cursor-default",antigravity:"antigravity-default"};
const TOOL_STATE_LIMIT=1000;
const GROK_CANCEL_META=Object.freeze({cancelTrigger:"ctrl_c"});
const GROK_TASK_PROMPT_PREFIX="task-completed-";
const GROK_RATE_LIMIT_CODE=-32003;
// ACP's auth_required error: the harness is signed out.
const ACP_AUTH_REQUIRED=-32000;
// After Grok's prompt_complete, how long to wait for the session/prompt answer that carries the detail.
const GROK_COMPLETION_GRACE_MS=3000;
const GROK_STOP_WAIT_MS=15_000;
// The id of Grok Build's one approval that lasts only for the session ("allow all edits this session"); its other always-allow
// options are saved for the whole project.
const GROK_SESSION_EDITS_ID="allow-edits-session";
// Commands a harness lists that the composer leaves out, grouped by why. Grok Build's come from its own command list: the two
// switches that change how Grok approves tools (Trebell starts Grok at the thread's access level and answers its permission
// requests itself), and its context view, which over ACP answers with nothing to show.
const COMMANDS_LEFT_OUT={
  grok:{approvalSwitches:["always-approve","auto"],nothingOverAcp:["context"]},
};
function commandsLeftOut(runtime){
  return new Set(Object.hasOwn(COMMANDS_LEFT_OUT,runtime??"")?Object.values(COMMANDS_LEFT_OUT[runtime]).flat():[]);
}
const GROK_SESSION_NOTIFICATIONS=new Set(["x.ai/session_notification","_x.ai/session_notification","_x.ai/session/update"]);
const GROK_PROMPT_COMPLETE=new Set(["x.ai/session/prompt_complete","_x.ai/session/prompt_complete"]);
// The first line of a Grok turn that its rate limit ended; Grok's own detail, when it gave one, follows on the next line.
export const GROK_ALLOWANCE_USED_UP="Grok Build has used up its usage allowance. Try the message again when it resets.";
export const GROK_EMPTY_PLAN="# No plan from Grok Build\n\nGrok Build left plan mode without writing a plan.";
export const GROK_PLAN_FEEDBACK="Trebell Code has shown your plan to the user. Stop here: the user answers with feedback, or asks you to carry it out, in a later turn.";

function inside(root,candidate){
  const rel=relative(resolve(root),resolve(candidate));
  return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));
}

// A path the harness asks for resolves through links, its last part included, before it is
// checked against the session's roots (the workspace and Trebell's attachments folder), so a link inside the workspace
// cannot read or write through to a file outside them. A missing file (a new write) is checked by its nearest existing
// folder; an entry that exists but does not resolve, like a dangling link, is refused rather than written through.
async function clientFilePath(roots,path){
  const requested=resolve(String(path??""));
  const outside=()=>Object.assign(new Error(`Path is outside the active workspace: ${path}`),{code:-32602});
  const exists=entry=>lstat(entry).then(()=>true,()=>false);
  let real=null,folder=requested;const missing=[];
  while(real===null){
    try{real=join(await realpath(folder),...missing)}
    catch(error){
      if(error?.code!=="ENOENT"||await exists(folder)||dirname(folder)===folder)throw outside();
      missing.unshift(basename(folder));folder=dirname(folder);
    }
  }
  const realRoots=await Promise.all(roots.map(root=>realpath(root).catch(()=>resolve(root))));
  if(!realRoots.some(root=>inside(root,real)))throw outside();
  return real;
}

function text(value){return String(value??"").trim()}

// A document's link is followed by its attachment line, which also names the file holding its extracted text (agent-relay
// acpPrompt), so Cursor and Grok read that text with their own tools.
function acpDocumentLine(part){
  const path=fileUriPath(part.uri)||String(part.uri||"");
  return {type:"text",text:attachmentLine("file",part.name||basename(path),path,part[PROMPT_TEXT_PATH])};
}
export function acpDocumentTextParts(parts){
  return (Array.isArray(parts)?parts:[]).flatMap(part=>part?.type==="resource_link"&&part[PROMPT_TEXT_PATH]?[part,acpDocumentLine(part)]:[part]);
}
// ---- What an Antigravity message carries as content
// Antigravity's initialize offers, in promptCapabilities, the content it takes besides text and file links: images, audio and
// embedded context. Its tools open nothing outside the workspace folders (1.2.1 also refuses a folder granted with
// additionalDirectories), so a file kept in Trebell's attachments folder reaches the model only when it is sent as content. A
// message's parts are decided in order, each by the first rule below that knows it; a part that no rule knows goes unchanged.

// Google gives its limits in MB, read here as decimal megabytes: that is the smaller reading, so a part within them fits whichever
// unit is meant. Sources: Vertex AI's Gemini 3.8 Flash page (docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/
// 3-8-flash), the Gemini API's pages on file input, tokens and audio (ai.google.dev/gemini-api/docs/file-input-methods, .../tokens
// and .../audio), and the ACP Python SDK that Antigravity's server is built on (github.com/agentclientprotocol/python-sdk,
// src/acp/core.py).
const MB=1_000_000,MiB=1024*1024;
const ANTIGRAVITY_LIMITS=Object.freeze({
  // One part: Vertex AI takes an image of up to 7 MB inline, a text/plain file of up to 7 MB and a PDF of up to 50 MB.
  imageBytes:7*MB,textBytes:7*MB,pdfBytes:50*MB,
  // An embedded text fills at most half of the model's 1,048,576-token window, at about 4 characters a token. That still holds the
  // longest text Trebell reads out of a document (document-reading.mjs, and the note after the text of a document cut there).
  textCharacters:1_048_576/2*4,
  // The one JSON-RPC line a prompt travels on: the SDK reads a line of up to 50 MiB, and 2 MiB of it stays free for the message's
  // own words, its links and the JSON around them.
  lineBytes:48*MiB,
  // The model request: 100 MB of inline data, less 4 MB for Antigravity's instructions and the conversation, as much as a whole
  // window of 1,048,576 tokens at about 4 characters each. The 100 MB is the file input page's. The Gemini API's image and audio
  // pages give a whole request 20 MB and Vertex AI's page gives no figure; only a live call could tell which one holds.
  requestBytes:96*MB,
});
// The image types Google lists for Gemini's image input (the Vertex AI page above, and ai.google.dev/gemini-api/docs/
// image-understanding). An image of any other type, a GIF or a BMP, is named by its saved file instead.
const ANTIGRAVITY_IMAGE_TYPES=new Set(["image/png","image/jpeg","image/webp","image/heic","image/heif"]);
// Audio goes by extension, in any case: what the composer sends as audio (App.jsx inputsFor: .mp3, .wav, .m4a, .ogg and .flac) and
// .aac, which it sends as a file link, each under the media type registered for it.
const AUDIO_MEDIA=new Map(Object.entries({".mp3":"audio/mpeg",".wav":"audio/wav",".m4a":"audio/mp4",".ogg":"audio/ogg",".flac":"audio/flac",".aac":"audio/aac"}));
// A linked file goes embedded when what it holds is text, whatever its name (embeddableText), labelled text/plain unless its
// extension names a format with a media type of its own that tells a reader how the text is laid out: Markdown (RFC 7763), HTML,
// CSS, CSV (RFC 4180), JSON (RFC 8259), JSON Lines (the format's own page), XML (RFC 7303) and YAML (RFC 9512).
const TEXT_MEDIA=new Map(Object.entries({
  ".md":"text/markdown",".markdown":"text/markdown",".html":"text/html",".htm":"text/html",".css":"text/css",".csv":"text/csv",
  ".json":"application/json",".jsonl":"application/jsonl",".xml":"application/xml",".yaml":"application/yaml",".yml":"application/yaml",
}));
const extensionOf=path=>extname(path).toLowerCase();

// What a part takes of a message: its bytes inside the prompt's line and in the model request. Binary content travels as base64,
// 4 bytes for every 3. Antigravity reads a PDF's file into the request itself, so a PDF takes no room on the line.
const asBase64=bytes=>4*Math.ceil(bytes/3);
const onTheLine=bytes=>({line:bytes,request:bytes});
const readByAntigravity=bytes=>({line:0,request:asBase64(bytes)});

// The room one message has left on the line and in the request. admits only asks; claim takes the room when the part fits both.
class MessageRoom{
  #line=ANTIGRAVITY_LIMITS.lineBytes;
  #request=ANTIGRAVITY_LIMITS.requestBytes;
  admits(cost){return cost.line<=this.#line&&cost.request<=this.#request}
  claim(cost){
    if(!this.admits(cost))return false;
    this.#line-=cost.line;this.#request-=cost.request;
    return true;
  }
}

const embeddedText=(path,mimeType,body)=>({type:"resource",resource:{uri:pathToFileURL(path).href,mimeType,text:body}});
const UTF8_EXACT=new TextDecoder("utf-8",{fatal:true});

// The text of a file that may go embedded, or null. It must be a regular file of at most textBytes that reads as UTF-8 (a leading
// byte-order mark dropped), hold no NUL unless nul allows one, have at most textCharacters, and fit in the message as a JSON string.
async function embeddableText(path,room,{nul}){
  const info=await stat(path).catch(()=>null);
  if(!info?.isFile()||info.size>ANTIGRAVITY_LIMITS.textBytes)return null;
  const bytes=await readFile(path).catch(()=>null);
  if(!bytes||bytes.length>ANTIGRAVITY_LIMITS.textBytes)return null;
  let body;
  try{body=UTF8_EXACT.decode(bytes)}catch{return null}
  if(body.length>ANTIGRAVITY_LIMITS.textCharacters||(!nul&&body.includes("\0")))return null;
  return room.claim(onTheLine(Buffer.byteLength(JSON.stringify(body))))?body:null;
}

// A regular file's bytes when its size, as costOf counts it, fits in the message; null otherwise. A file that cannot be read goes
// to unreadable.
async function bytesWithRoom(path,room,costOf,unreadable){
  const info=await stat(path).catch(unreadable);
  if(!info?.isFile()||!room.admits(costOf(info.size)))return null;
  return readFile(path).catch(unreadable);
}

// An image of a type Antigravity takes goes as itself. One it would take that cannot go refuses the whole message, by the image's
// name, before Antigravity is asked anything, since the path of a file Antigravity cannot open would never reach the model. An
// image of another type is named by its saved file, or said not sent when Trebell has no saved copy.
function unsendableImage(saved,overLimit){
  const name=attachmentName(saved);
  return new SessionRefusalError(overLimit
    ?`The image "${name}" is over ${ANTIGRAVITY_LIMITS.imageBytes/MB} MB, the most Antigravity's models take for one image. Attach a smaller copy of it.`
    :`The image "${name}" does not fit in this message to Antigravity with the other attachments. Send it in a message of its own.`);
}
async function agyImage(part,{takes,room}){
  if(part?.type!=="image")return null;
  const saved=part[PROMPT_IMAGE_PATH]||"";
  if(!takes.image||!ANTIGRAVITY_IMAGE_TYPES.has(String(part.mimeType||"").toLowerCase())){
    return [{type:"text",text:saved?attachmentLine("image",basename(saved),saved):unsentImageLine()}];
  }
  const data=String(part.data||"");
  if(Buffer.byteLength(data,"base64")>ANTIGRAVITY_LIMITS.imageBytes)throw unsendableImage(saved,true);
  if(!room.claim(onTheLine(data.length)))throw unsendableImage(saved,false);
  return [part];
}

// The audio file a part stands for, with its media type: the relay's line naming an attached audio file (agent-relay acpPrompt),
// or a file link to an .aac.
function audioFileOf(part){
  let path=null;
  if(part?.type==="text")path=part[PROMPT_AUDIO_PATH]||null;
  else if(part?.type==="resource_link"){const linked=fileUriPath(part.uri);if(linked&&extensionOf(linked)===".aac")path=linked}
  const media=path&&AUDIO_MEDIA.get(extensionOf(path));
  return media?{path,media}:null;
}
// With audio offered, the part that names the file stays, so every attachment is named in the text, and the sound follows it as
// base64 when the message has room for it. No audio file has a limit of its own: Google gives audio a length, not a size, and the
// message's room bounds it. Every audio file with room goes: Vertex AI's page lists one audio file a prompt, but the Gemini API's
// audio page sets no count. A file that is gone refuses the message.
async function agyAudio(part,{takes,room}){
  const audio=takes.audio?audioFileOf(part):null;
  if(!audio)return null;
  const unreadable=error=>{throw unreadableAttachment("file",audio.path,error)};
  const bytes=await bytesWithRoom(audio.path,room,size=>onTheLine(asBase64(size)),unreadable);
  if(!bytes||!room.claim(onTheLine(asBase64(bytes.length))))return [part];
  return [part,{type:"audio",mimeType:audio.media,data:bytes.toString("base64")}];
}

// A document (document-text.mjs) stays a link, followed by the line naming the file its text was extracted to; with embedded
// context that text follows too, since Antigravity cannot open the file in Trebell's attachments folder.
async function agyDocument(part,{takes,room}){
  const extracted=part?.type==="resource_link"?part[PROMPT_TEXT_PATH]:null;
  if(!extracted)return null;
  const body=takes.embedded?await embeddableText(extracted,room,{nul:true}):null;
  return body===null?[part,acpDocumentLine(part)]:[part,acpDocumentLine(part),embeddedText(extracted,"text/plain",body)];
}

// With embedded context, a linked PDF within pdfBytes goes as a document link with its type while the request has room for it, and
// any other linked file that holds text goes as that text in place of the link; a file that holds anything else stays a link. So
// does a document of a kind Trebell reads into text (document-reading.mjs) with no text read from it, as its own bytes are its
// format's (an .rtf's markup, a broken .docx); its text, once read, goes by agyDocument. Trebell writes file links as
// percent-encoded file: URLs (agent-relay acpPrompt).
async function agyLinkedFile(part,{takes,room}){
  if(!takes.embedded||part?.type!=="resource_link")return null;
  const path=fileUriPath(part.uri);
  if(!path)return null;
  const extension=extensionOf(path);
  if(extension===".pdf"){
    const info=await stat(path).catch(()=>null);
    const typed=info?.isFile()&&info.size<=ANTIGRAVITY_LIMITS.pdfBytes&&room.claim(readByAntigravity(info.size));
    return [typed?{...part,mimeType:"application/pdf"}:part];
  }
  if(documentKind(extension))return null;
  const body=await embeddableText(path,room,{nul:false});
  return body===null?null:[embeddedText(path,TEXT_MEDIA.get(extension)||"text/plain",body)];
}

const AGY_CONTENT_RULES=[agyImage,agyAudio,agyDocument,agyLinkedFile];
async function antigravityContentFor(part,message){
  for(const rule of AGY_CONTENT_RULES){
    const sent=await rule(part,message);
    if(sent)return sent;
  }
  return [part];
}
export async function antigravityPromptParts(parts,promptCapabilities={}){
  const offered=Object(promptCapabilities??{});
  const message={takes:{image:offered.image===true,audio:offered.audio===true,embedded:offered.embeddedContext===true},room:new MessageRoom()};
  const content=[];
  for(const part of Array.isArray(parts)?parts:[])content.push(...await antigravityContentFor(part,message));
  return content;
}

// The client services each harness is offered: ACP agents run their own file and shell tools behind
// their own permission requests. Only Antigravity reads and writes files through the client;
// no harness gets the client's terminal (Grok would run its whole command line through it as the program). Cursor lists
// base model ids with per-model options only for clients that can show them.
export function acpClientCapabilities(runtime){
  const capabilities={...defaultAcpClientCapabilities(),terminal:false};
  if(runtime==="antigravity")return capabilities;
  const own={...capabilities,fs:{readTextFile:false,writeTextFile:false}};
  return runtime==="cursor"?{...own,_meta:{parameterizedModelPicker:true}}:own;
}
function offeredClientService(capabilities,method){
  if(method==="fs/read_text_file")return capabilities?.fs?.readTextFile===true;
  if(method==="fs/write_text_file")return capabilities?.fs?.writeTextFile===true;
  if(String(method).startsWith("terminal/"))return capabilities?.terminal===true;
  return true;
}
function selected(optionId){return {outcome:{outcome:"selected",optionId}}}
const CANCELLED_OUTCOME=Object.freeze({outcome:Object.freeze({outcome:"cancelled"})});
function optionOfKind(options,kind){
  return (Array.isArray(options)?options:[]).find(option=>option?.kind===kind&&text(option.optionId))?.optionId||null;
}

// Reads follow the sandbox alone and never ask: every Trebell mode lets the agent read,
// Read Only included, so ACP read, search and think requests are allowed unasked. Other kinds follow the mode.
const ACP_READ_KINDS=new Set(["read","search","think"]);

// The agent's allow-once answer when Trebell's policy allows the request; allow-always only when the
// agent offers no allow-once, because an always answer can outlive the session (Grok saves it for
// the whole project). A denial uses reject-once for the same reason.
export function acpPermissionChoice(options=[],mode="supervised",kind=null,policyInput={}){
  const disposition=ACP_READ_KINDS.has(kind)?"allow":permissionDisposition(mode,normalizePermissionKind(kind),{readOnlyAllowsRead:false,...policyInput});
  if(disposition==="allow")return optionOfKind(options,"allow_once")||optionOfKind(options,"allow_always");
  if(disposition==="deny")return optionOfKind(options,"reject_once");
  return null;
}

// ---- What the person can answer a permission request with
// The card shows the harness's own options (ACP's session/request_permission: each option's name is the label to show, its kind
// a hint), in the order the harness sent them, and the person's answer comes back as a decision that picks the option again.
// Both sides read the options through answerableOptions, so a button always picks the option whose name it showed.
// An option is answerable when it has an id and its kind is one Trebell answers with: allow_once accepts once, allow_always
// accepts for the session, reject_once declines. A remembered refusal (reject_always) never is: Trebell's decline answers only
// the one request. The answer names only its decision, so the first answerable option of each decision stands for it.
// Grok Build keeps its always answers for the whole project, all but its edits-for-this-session option (its own documentation:
// that grant "is held in memory only"), and Trebell answers Grok's requests itself at the thread's access level: an answer Grok
// kept past the session would let it act later without asking. So that option is Grok's only session answer.
const DECISION_BY_KIND=Object.freeze({allow_once:"accept",allow_always:"acceptForSession",reject_once:"decline"});
function keptPastSession(runtime,option){return runtime==="grok"&&text(option.optionId)!==GROK_SESSION_EDITS_ID}
function answerableOptions(runtime,options){
  const byDecision=new Map();
  for(const option of Array.isArray(options)?options:[]){
    if(!text(option?.optionId)||typeof option.kind!=="string"||!Object.hasOwn(DECISION_BY_KIND,option.kind))continue;
    const decision=DECISION_BY_KIND[option.kind];
    if(byDecision.has(decision)||(decision==="acceptForSession"&&keptPastSession(runtime,option)))continue;
    byDecision.set(decision,option);
  }
  return byDecision;
}

// The option a decision picks, answered with its id as the harness sent it; null (the request is answered cancelled) for
// Trebell's stop or anything else. A session answer where the harness offered none for the session is answered once.
export function acpDecisionOption(runtime,options=[],decision="decline"){
  const answerable=answerableOptions(runtime,options);
  const option=answerable.get(decision)??(decision==="acceptForSession"?answerable.get("accept"):undefined);
  return option?option.optionId:null;
}

// The card's buttons: one per answerable option under the name the harness gave it, then Trebell's own button that answers this
// one request cancelled, picking none of the options. It does not stop the turn (the composer's Stop does, with session/cancel),
// and a harness may read it as a refusal of the one call and go on (Cursor does), so it is named for the request alone. Trebell
// has words only for an option that came without a name, taken from what ACP says each kind means.
const WORDS_FOR_NAMELESS=Object.freeze({accept:"Allow this time",acceptForSession:"Allow and remember",decline:"Don't allow"});
const CANCEL_REQUEST=Object.freeze({decision:"cancel",label:"Cancel this request"});
export function acpApprovalOptions(runtime,options=[]){
  const buttons=[...answerableOptions(runtime,options)].map(([decision,option])=>{
    const button={decision,label:text(option.name)||WORDS_FOR_NAMELESS[decision]};
    const warning=securityNote(option);
    return warning?{...button,warning}:button;
  });
  return [...buttons,{...CANCEL_REQUEST}];
}

// Antigravity's security warning on an option (_meta "agy.security.warning"): its message, else its title. The card shows it above
// the buttons, kept to about four lines of its warning line at the card's widest (680 px of 10.5 px monospace holds about 100
// characters a line): a longer one ends after its last whole word that fits, with "…".
const SECURITY_NOTE_MAX=400;
function securityNote(option){
  const note=option?._meta?.["agy.security.warning"];
  const said=text(note?.message)||text(note?.title);
  return said.length>SECURITY_NOTE_MAX?shortenOnWord(said,SECURITY_NOTE_MAX):said;
}
// At most max characters, "…" included: cut at the last blank when it falls in the last quarter of the room, else at the room's end.
function shortenOnWord(said,max){
  const room=said.slice(0,max-1),blank=room.search(/\s\S*$/);
  return (blank>=Math.floor(max*3/4)?room.slice(0,blank):room).trimEnd()+"…";
}

// fs/read_text_file: the file as it is unless a range is asked for; ranges split on "\n" only so
// Windows line endings survive.
export function acpFileSlice(content,line=null,limit=null){
  const source=String(content??"");
  if(line==null&&limit==null)return source;
  const lines=source.split("\n"),start=Math.max(0,(Number(line)||1)-1);
  const end=limit==null?lines.length:Math.min(lines.length,start+Math.max(0,Number(limit)||0));
  return lines.slice(start,end).join("\n");
}

// The composer's slash commands from an ACP availableCommands list: each name once (trimmed, without its leading slashes), with
// its description and input hint when it has them, less the commands Trebell leaves out for this harness (COMMANDS_LEFT_OUT).
export function acpCommandsFromAvailable(list=[],runtime=null){
  const leftOut=commandsLeftOut(runtime),byName=new Map();
  for(const entry of Array.isArray(list)?list:[]){
    const name=text(entry?.name).replace(/^\/+/,"");
    if(name===""||leftOut.has(name)||byName.has(name))continue;
    const command={name},description=text(entry?.description),hint=text(entry?.input?.hint);
    if(description)command.description=description;
    if(hint)command.input={hint};
    byName.set(name,command);
  }
  return [...byName.values()];
}

// A harness runs a slash command only when the message starts with it (Grok: "other commands must start the message"). The
// relay puts Trebell's working context before the user's text, so when that
// text starts with a command the harness lists, the user's parts go alone, without the context or the runtime notes. A lone
// slash text (the relay's /compact) is always sent as a command. Returns the parts to send, or null for an ordinary prompt.
export function acpSlashCommandPrompt(parts=[],commandNames=new Set()){
  const list=Array.isArray(parts)?parts:[];
  const user=list.filter(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.kind!=="working_context");
  const value=text(user.find(part=>part?.type==="text")?.text);
  if(!/^\/[A-Za-z]/.test(value))return null;
  if(list.length===1)return user;
  return commandNames.has(value.slice(1).split(/\s/)[0])?user:null;
}

// The agent's modes (OpenCode's primary agents) as composer agents.
export function acpModeAgents(setup){
  return acpConfigSelect(setup,"mode").choices.map(choice=>{
    const description=choice.description||(choice.name!==choice.value?choice.name:"");
    return {name:choice.value,...(description?{description}:{})};
  });
}

// ---- Grok Build's ask_user_question answer
// Grok reads the answer by each question's text: the option labels chosen, or "Other" when the person wrote their own words, which
// go with it as notes. A single-choice question's chosen option may carry a preview, which goes back with it too.
// The values an answer gives: one or a list, only the non-empty strings, trimmed.
const saidValues=answer=>[answer].flat().filter(value=>typeof value==="string").map(value=>value.trim()).filter(Boolean);
function grokAnswerFor(question,said){
  const labelledOptions=new Map((Array.isArray(question?.options)?question.options:[]).map(option=>[String(option?.label||""),option]));
  const chosen=[],ownWords=[];
  for(const value of said)(labelledOptions.has(value)?chosen:ownWords).push(value);
  const note={};
  if(question?.multiSelect!==true){
    for(const label of chosen){const preview=text(labelledOptions.get(label)?.preview);if(preview){note.preview=preview;break}}
  }
  if(ownWords.length)note.notes=ownWords.join("\n");
  return {labels:chosen.length?chosen:["Other"],note:Object.keys(note).length?note:null};
}
export function grokQuestionResponse(questions=[],answers={}){
  const given=answers&&typeof answers==="object"?answers:{};
  const response={outcome:"accepted",answers:{}},annotations={};
  for(const question of Array.isArray(questions)?questions:[]){
    const key=String(question?.question||"");
    // The person's answer sits under the question's id when it has one, and under its text otherwise.
    const said=saidValues([question?.id??key,key].map(name=>given[name]).find(value=>value!=null));
    if(!said.length)continue;
    const {labels,note}=grokAnswerFor(question,said);
    response.answers[key]=labels;
    if(note)annotations[key]=note;
  }
  if(Object.keys(annotations).length)response.annotations=annotations;
  return response;
}

// ---- Antigravity's multiple-choice questions
// Antigravity asks them as permission requests (an interaction_ tool call) and takes only one of the options it offered as the
// answer. So the person picks among the options that have an id (the first of an id offered twice), each carried by its id so that
// two options of one name stay apart, and the question takes no words of their own. Null when no option has an id. A question
// Antigravity sent without a title asks in Trebell's words.
const ANTIGRAVITY_UNTITLED_QUESTION="Antigravity asks you to pick one of these.";
function antigravityChoiceQuestion(toolCall,options){
  const choices=new Map();
  for(const option of options){
    const id=text(option?.optionId);
    if(id&&!choices.has(id))choices.set(id,{optionId:option.optionId,label:text(option.name)||id});
  }
  if(!choices.size)return null;
  const prompt={id:text(toolCall?.toolCallId),header:"Question",question:text(toolCall?.title)||ANTIGRAVITY_UNTITLED_QUESTION,multiSelect:false,allowCustomAnswer:false,
    options:[...choices].map(([value,choice])=>({value,label:choice.label,description:""}))};
  return {prompt,choices};
}
// The option the person's answer picks, by its id or else by a name only one option has, answered with the id Antigravity offered;
// cancelled when it picks none.
function antigravityChoiceAnswer(choices,picked){
  if(!picked)return CANCELLED_OUTCOME;
  const byId=choices.get(picked);
  if(byId)return selected(byId.optionId);
  const named=[...choices.values()].filter(choice=>choice.label===picked);
  return named.length===1?selected(named[0].optionId):CANCELLED_OUTCOME;
}

// ---- Cursor's questions and plans (cursor/ask_question, cursor/create_plan, as Cursor's ACP page documents them)
// A question Cursor sent without a prompt is still shown, in Trebell's words, with whatever options it has.
const CURSOR_WORDLESS_QUESTION="Cursor sent this question without any words.";
// What a plan request shows in the turn: its plan text (markdown); without any, its overview under the plan's name; with
// neither, Trebell's note that Cursor sent none.
const CURSOR_PLAN_WITHOUT_TEXT="# No plan text from Cursor\n\nCursor proposed a plan but sent none of its text.";
function cursorPlanMarkdown(params){
  const plan=text(params?.plan),overview=text(params?.overview);
  if(plan)return plan;
  return overview?`# ${text(params?.name)||"Cursor's plan"}\n\n${overview}`:CURSOR_PLAN_WITHOUT_TEXT;
}

function unwrapGrokParams(raw){
  return raw&&typeof raw==="object"&&typeof raw.method==="string"&&raw.params&&typeof raw.params==="object"?raw.params:raw;
}

function boundedDetail(value){
  const detail=typeof value==="string"?value.trim():value&&typeof value==="object"?text(value.message||value.error||""):"";
  return detail.length>1500?detail.slice(0,1497)+"...":detail;
}

// The failure of a Grok turn its rate limit ended, as a usage limit: Trebell's sentence, then Grok's own detail when it gave one,
// with the prompt error's data when it carried some.
function grokUsageLimitFailure(detail,data){
  const failure=new Error(detail?`${GROK_ALLOWANCE_USED_UP}\n${detail}`:GROK_ALLOWANCE_USED_UP);
  return Object.assign(failure,{code:GROK_RATE_LIMIT_CODE,usageLimit:true},data===undefined?{}:{data});
}

// Grok settles a failed prompt with prompt_complete (stopReason rate_limit or error) before or
// with its session/prompt error.
export function grokCompletionFailure(notice){
  const reason=text(notice?.stopReason);
  if(reason==="rate_limit")return grokUsageLimitFailure(boundedDetail(notice?.agentResult));
  if(reason==="error"){
    const detail=boundedDetail(notice?.agentResult);
    return Object.assign(new Error(detail||"Grok Build reported an error and ended the turn."),{code:-32603});
  }
  return null;
}

// A session/prompt error from Grok: its rate limit (code -32003, or a rate_limit notice) as a usage limit whose detail is the
// error's own words unless they only say "Rate limited", else the notice's; any other error as the notice reads, or itself.
export function grokPromptError(error,notice=null){
  if(error?.code!==GROK_RATE_LIMIT_CODE&&text(notice?.stopReason)!=="rate_limit")return grokCompletionFailure(notice)||error;
  const said=text(error?.message),saysMore=said!==""&&said.toLowerCase()!=="rate limited";
  return grokUsageLimitFailure(boundedDetail(saysMore?said:notice?.agentResult),error?.data);
}

// Why a thread's model cannot run on this sign-in, and what to do instead. Antigravity and Cursor list the models of the account
// they are signed in with.
function unlistedModelText(runtime,label,model){
  const instead=name=>`Choose one of the models ${name} lists in the composer.`;
  if(runtime==="antigravity")return `This Google account cannot use the model '${model}' in Antigravity. ${instead("Antigravity")}`;
  if(runtime==="cursor")return `This Cursor account cannot use the model '${model}'. ${instead("Cursor")}`;
  return `${label} does not list the model '${model}'. ${instead("it")}`;
}

function requestedModel(runtime,model){
  const id=text(model);
  if(!id||id===MODEL_ALIASES[runtime])return null;
  // Cursor's parameterized picker uses base ids; older ids carried their options in brackets.
  return runtime==="cursor"?id.replace(/\[.*$/,"")||null:id;
}

export class AcpAgentSession{
  constructor({runtime,command,args=[],cwd,processCwd=null,env=process.env,permissionMode="supervised",onUpdate,onPermission,onQuestion=null,onElicitation,onWakeTurn=null,argsForPermission=null,runTempRoot=null,version="0.0.0",spawnProcess=null,remoteIo=null,mcpServers=[],attachmentsDir=null,authMethod="sign-in"}={}){
    this.runtime=runtime;this.command=command;this.args=[...(args||[])];this.cwd=remoteIo?String(cwd||remoteIo.root||"/"):resolve(cwd||process.cwd());this.env=env;
    // How the profile signs in (harness-auth.mjs): "api-key" signs a harness that asks in with its key method, else its own login.
    this.authMethod=authMethod==="api-key"?"api-key":"sign-in";
    // Trebell saves pasted text and uploads outside the workspace. Antigravity checks every path against its own allowed
    // folders, so the session grants it the attachments folder (additionalDirectories) and serves its client files there too.
    this.attachmentsDir=runtime==="antigravity"&&!remoteIo&&text(attachmentsDir)?resolve(attachmentsDir):null;
    this.permissionMode=normalizePermissionMode(permissionMode);this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.onElicitation=onElicitation;this.onWakeTurn=onWakeTurn;this.version=version;
    this.argsForPermission=typeof argsForPermission==="function"?argsForPermission:null;this.runTempRoot=runTempRoot||null;
    this.spawnProcess=spawnProcess;this.remoteIo=remoteIo;this.processCwd=processCwd?resolve(processCwd):null;
    this.mcpServers=Array.isArray(mcpServers)?mcpServers.map(server=>({...server,args:[...(server.args||[])],env:(server.env||[]).map(item=>({...item}))})):[];
    this.client=null;this.sessionId=null;this.initializeResult=null;this.sessionSetup=null;this.model=null;
    // Whether the harness still has Trebell's runtime notes, and the model they named; compactions counts the compactions it finished,
    // so a prompt that one overtook does not count its notes as kept.
    this.runtimeContextSent=false;this.runtimeContextModel=null;this.compactions=0;
    this.label=runtimeHarnessLabel(runtime);
    this.dead=false;this.deadError=null;this.closing=false;this.starting=false;this.settingModel=false;this.loading=false;
    this.activePrompt=null;this.wake=null;this.userWaits=new Set();this.tools=new Map();this.todos=new Map();
    this.reasoningEffort=null;this.grokEffort=null;this.grokEffortSet=false;this.defaultMode=null;
    this.serviceTier=undefined;this.modelOptions={};this.collaborationMode="default";
    this.grokCompletions=new Map();
    // The slash commands the harness lists (initialize or available_commands_update), by name.
    this.commandNames=new Set();
  }

  get busy(){return Boolean(this.activePrompt||this.wake)}
  // Whether a new process could take this conversation up again (#resume): the harness offers session/load or session/resume.
  get resumable(){const caps=this.initializeResult?.agentCapabilities||{};return caps.loadSession===true||caps.sessionCapabilities?.resume!=null}

  async start({providerSessionId=null,model=null,reasoningEffort=undefined}={}){
    const client=new AcpClient({command:this.command,args:this.args,cwd:this.processCwd||this.cwd,env:this.env,spawnProcess:this.spawnProcess,runTempRoot:this.runTempRoot,onRequest:(method,params)=>this.#clientRequest(method,params)});
    this.client=client;this.dead=false;this.deadError=null;this.starting=true;
    if(reasoningEffort!==undefined)this.setReasoningEffort(reasoningEffort);
    client.on("sessionUpdate",params=>{if(this.client===client)this.#sessionUpdate(params)});
    client.on("notification",message=>{if(this.client===client)this.#notification(message)});
    client.on("protocolWarning",warning=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",...warning}}));
    client.on("terminated",error=>{
      if(this.client!==client)return;
      this.dead=true;this.deadError=error;this.#cancelUserWaits();this.#finishWake("cancelled");
      // One that ended as it started (its last step setting the thread's model too) says so as the start's failure does.
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:(this.starting||this.settingModel?this.#startFailure(error):error).message}});
    });
    try{
      await client.start();
      this.initializeResult=await client.initialize({version:this.version,timeoutMs:this.runtime==="antigravity"?90_000:30_000,capabilities:this.#clientCapabilities(),meta:this.runtime==="grok"?GROK_INITIALIZE_META:null});
      // A harness set to its API key that has a key method of its own signs in with it before its session starts (Grok's xai.api_key,
      // its launch carrying XAI_API_KEY), so a login it cached itself (`grok login`) never stands in for the key the person chose.
      this.keySignedIn=false;
      const keyMethod=this.#apiKeyMethod();
      if(keyMethod){
        try{await client.authenticate(keyMethod)}
        catch(failure){throw Object.assign(new Error(`${this.label} could not sign in with '${keyMethod}': ${failure?.message||failure}`),{code:failure?.code,cause:failure})}
        this.keySignedIn=true;
      }
      let setup;
      // The folder is granted before the first upload lands in it, so it must exist for the harness to accept it.
      if(this.attachmentsDir)await mkdir(this.attachmentsDir,{recursive:true}).catch(()=>{});
      setup=await this.#setUp(client,providerSessionId?String(providerSessionId):null);
      this.sessionSetup={...(setup&&typeof setup==="object"?setup:{}),sessionId:this.sessionId};
      this.grokEffort=this.runtime==="grok"?text(this.#grokModelMeta(acpConfigSelect(this.sessionSetup,"model").current).reasoningEffort).toLowerCase()||null:null;
      this.grokEffortSet=false;
      this.defaultMode=acpConfigSelect(this.sessionSetup,"mode").current;
    }catch(error){throw this.#startFailure(error)}
    finally{this.starting=false}
    this.runtimeContextSent=false;
    // Setting the thread's model is the start's last step (Cursor sets one on every start): a process that ends there ended as it
    // started too. The session's updates pass meanwhile, as after any start.
    this.settingModel=true;
    try{await this.#applyModel(model)}catch(error){throw this.#startFailure(error)}
    finally{this.settingModel=false}
    this.#emitInventory();
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  // Why a start failed, as the person reads it: an Antigravity this machine gives no IPv6 sockets says so, and a harness whose process
  // ended says that in plain words (acp-start-exit.mjs).
  #startFailure(error){return acpStartFailure(this.runtime,this.label,error,this.env)}

  // ACP's auth_required (-32000) from session/new, load or resume: the harness signs in once with its own advertised method, and the
  // same setup runs once more. Without such a method, or still signed out after it, the start fails as
  // it is, and the relay adds its check's advice.
  async #setUp(client,providerSessionId){
    const setUp=()=>providerSessionId?this.#resume(client,providerSessionId):this.#create(client);
    try{return await setUp()}
    catch(error){
      // A harness still signed out after its key method signed it in is not asked again.
      const methodId=error?.code===ACP_AUTH_REQUIRED&&!client.closed&&!this.keySignedIn?this.#signInMethod():null;
      // An Antigravity on Sign in that is not signed in signs in from Settings, never in the middle of a chat's start.
      if(!methodId&&this.runtime==="antigravity"&&error?.code===ACP_AUTH_REQUIRED)throw Object.assign(new Error(ANTIGRAVITY_SIGN_IN_NEEDED),{code:error.code,cause:error});
      if(!methodId)throw error;
      try{await client.authenticate(methodId)}
      catch(failure){throw Object.assign(new Error(`${this.label} could not sign in with '${methodId}': ${failure?.message||failure}`),{code:failure?.code,cause:failure})}
      return setUp();
    }
  }

  async #create(client){
    const setup=await client.createSession({cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories:this.#additionalDirectories()});
    this.sessionId=text(setup?.sessionId)||null;
    if(!this.sessionId)throw new Error(`${this.label} did not create a session`);
    return setup;
  }

  // The method a signed-out harness signs in with, by how its profile signs in (Settings' choice), never by what its environment
  // holds: Grok its xAI key method on an API key (its launch then has XAI_API_KEY), else its cached `grok login`, only when its
  // initialize lists it. Antigravity its Gemini key method on an API key, listed or not: it signs in
  // with the method it is set to; on Sign in none here (its own sign-in runs from Settings, in the browser). Any other harness the
  // first method it runs itself (type agent, or none given), such as Cursor's cursor_login.
  #signInMethod(){
    const methods=Array.isArray(this.initializeResult?.authMethods)?this.initializeResult.authMethods:[],onKey=this.authMethod==="api-key";
    if(this.runtime==="antigravity")return onKey&&text(this.env?.GEMINI_API_KEY)?ANTIGRAVITY_API_KEY_METHOD:null;
    if(this.runtime==="grok"){const id=onKey?"xai.api_key":"cached_token";return methods.some(method=>text(method?.id)===id)?id:null}
    return text(methods.find(method=>text(method?.id)&&(method.type==null||method.type==="agent"))?.id)||null;
  }
  // The key method a harness on its API key signs in with as it starts (acpApiKeyMethod, which Git text shares): Grok's xai.api_key,
  // when its initialize lists it and its launch has the key. Antigravity's key method is named in its home's settings
  // (prepareAntigravityHome) and asked for once it says it needs one (#signInMethod).
  #apiKeyMethod(){return acpApiKeyMethod({runtime:this.runtime,authMethod:this.authMethod,env:this.env,initializeResult:this.initializeResult})}

  // The session keeps the id it asked for: session/load and session/resume answers carry no sessionId.
  // A conversation the harness refuses to load or resume is a lost session (HarnessSessionLostError): the relay continues the
  // thread in one fresh session with its earlier messages handed over, and the turn says so. A harness that asks to sign in
  // (ACP auth_required), which #setUp signs in once, or whose process ended cannot run at all, and fails as it is.
  async #resume(client,sessionId){
    const caps=this.initializeResult?.agentCapabilities||{},canLoad=caps.loadSession===true,canResume=caps.sessionCapabilities?.resume!=null;
    const method=canResume&&(RESUME_FIRST.has(this.runtime)||!canLoad)?"resume":canLoad?"load":null;
    if(!method)throw new HarnessSessionLostError(`${this.label} could not resume this conversation: it offers neither session/load nor session/resume.`,{harness:this.runtime,sessionId});
    this.sessionId=sessionId;this.loading=true;
    try{
      const additionalDirectories=this.#additionalDirectories();
      return method==="resume"
        ?await client.resumeSession({sessionId,cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories})
        :await client.loadSession({sessionId,cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories});
    }catch(error){
      const message=`${this.label} could not resume this conversation: ${error?.message||error}`;
      if(error?.code===ACP_AUTH_REQUIRED||client.closed)throw Object.assign(new Error(message),{code:error?.code,cause:error});
      // The harness does not have the session, so closing this one does not ask it to close that session.
      this.sessionId=null;
      throw new HarnessSessionLostError(message,{harness:this.runtime,sessionId,code:error?.code,cause:error});
    }finally{this.loading=false}
  }

  #clientCapabilities(){return acpClientCapabilities(this.runtime)}
  #additionalDirectories(){return this.attachmentsDir?[this.attachmentsDir]:[]}
  #clientFileRoots(){return [this.cwd,...this.#additionalDirectories()]}

  #modelLabel(){
    const model=text(this.model);if(!model)return null;
    return acpConfigSelect(this.sessionSetup,"model").choices.find(choice=>choice.value===model)?.name||model;
  }

  // onDelivered: told once the harness has taken the prompt, with the Trebell context beside it, into its conversation: with the
  // first update the prompt brings (a reply, a thought, a tool call) or with the harness's answer. A request the harness refuses
  // outright (a rate or plan limit) never reached the conversation, and a slash command goes without that context, so neither tells.
  async prompt(content,{messageId=null,agent=undefined,onDelivered=null}={}){
    if(!this.client||!this.sessionId)throw new SessionRefusalError("ACP session is not started");
    if(this.dead)throw this.deadError||new Error(`${this.label} stopped`);
    this.#finishWake("end_turn");
    await this.#applyMode(agent);
    await this.#applyEffort();
    // A harness slash command goes alone: Trebell's context or runtime notes beside it would make it an ordinary prompt.
    const given=Array.isArray(content)?content:[],commandParts=acpSlashCommandPrompt(given,this.commandNames),command=Boolean(commandParts);
    // A lone /compact, the relay's or the person's, compacts the harness's context and the runtime notes in it (its text alone).
    const compacting=command&&commandParts.length===1&&text(commandParts[0]?.text)==="/compact";
    const parts=this.runtime==="antigravity"&&!this.remoteIo?await antigravityPromptParts(commandParts||given,this.initializeResult?.agentCapabilities?.promptCapabilities):acpDocumentTextParts(commandParts||given);
    // The notes go again once the harness compacted them away, or once the session's model, a switch of Trebell's or one the harness
    // reports, is not the one they named.
    const model=this.#modelLabel();
    if(!command&&(!this.runtimeContextSent||this.runtimeContextModel!==model))parts.push({type:"text",text:runtimeInstructions({harness:this.label,model})});
    let markDone;const done=new Promise(resolve=>{markDone=resolve});
    const active={promptId:this.runtime==="grok"?randomUUID():null,cancelled:false,transport:this.runtime==="cursor"?new CursorLostBackendReply():null,done,taken:!command&&typeof onDelivered==="function"?onDelivered:null};
    this.activePrompt=active;
    const compactions=this.compactions;
    try{
      const result=this.runtime==="grok"?await this.#grokPrompt(parts,active,messageId):await this.client.prompt(this.sessionId,parts,{messageId});
      this.#promptTaken(active);
      // A /compact the harness finished (as the relay counts one: neither stopped nor refused) leaves it without the notes, so the
      // next ordinary prompt carries them again; a compaction that came during this prompt took the ones it carried.
      if(compacting&&result?.stopReason!=="cancelled"&&result?.stopReason!=="refusal")this.#compacted();
      else if(!command&&this.compactions===compactions){this.runtimeContextSent=true;this.runtimeContextModel=model}
      // Cursor streams a lost backend connection as the reply and ends the turn normally. The failure
      // carries that last message, the dump with its stack lines, so the relay keeps as the turn's reply only what came before it.
      const failure=active.transport?.diagnostic;
      if(failure&&result?.stopReason!=="cancelled")throw Object.assign(new Error(failure),{code:"CURSOR_TRANSPORT_FAILURE",dump:active.message||""});
      return result;
    }catch(error){
      if(active.cancelled&&(this.dead||!this.client||this.client.closed))return {stopReason:"cancelled"};
      throw error;
    }finally{
      if(this.activePrompt===active)this.activePrompt=null;
      markDone();
    }
  }

  // The harness compacted its context, Trebell's runtime notes with it: the next ordinary prompt carries them again.
  #compacted(){this.compactions++;this.runtimeContextSent=false}

  // Tells, once, that the harness took the running prompt into its conversation (prompt's onDelivered).
  #promptTaken(active){
    const notify=active?.taken;if(!notify)return;
    active.taken=null;try{notify()}catch{}
  }

  // Races session/prompt against Grok's own completion signals, keyed by the prompt id Trebell sends.
  #grokPrompt(parts,active,messageId){
    const promptId=active.promptId;
    return new Promise((resolve,reject)=>{
      let notice=null,timer=null,done=false;
      const finish=(ok,value)=>{if(done)return;done=true;clearTimeout(timer);this.grokCompletions.delete(promptId);ok?resolve(value):reject(value)};
      this.grokCompletions.set(promptId,complete=>{
        if(notice)return;notice=complete;
        timer=setTimeout(()=>{const failure=grokCompletionFailure(notice);failure?finish(false,failure):finish(true,{stopReason:text(notice.stopReason)||"end_turn"})},GROK_COMPLETION_GRACE_MS);
        timer.unref?.();
      });
      this.client.prompt(this.sessionId,parts,{messageId,meta:{promptId,requestId:promptId}}).then(
        result=>{const failure=notice?grokCompletionFailure(notice):null;failure?finish(false,failure):finish(true,result)},
        error=>finish(false,grokPromptError(error,notice)),
      );
    });
  }

  // Stop: answer every waiting approval or question as cancelled, then session/cancel. Grok gets
  // its Ctrl+C marker and a restart once the turn settles, so its background tasks end too.
  cancel(){
    if(!this.client||!this.sessionId)return;
    const active=this.activePrompt;if(active)active.cancelled=true;
    this.#cancelUserWaits();
    try{this.client.cancel(this.sessionId,this.runtime==="grok"?GROK_CANCEL_META:null)}catch{}
    if(this.runtime==="grok"){this.#finishWake("cancelled");void this.#stopAfterCancel(active,this.client)}
  }

  async #stopAfterCancel(active,client){
    if(active)await Promise.race([active.done,new Promise(resolve=>{const timer=setTimeout(resolve,GROK_STOP_WAIT_MS);timer.unref?.()})]);
    if(this.client!==client||this.closing||client.closed)return;
    this.dead=true;this.deadError=Object.assign(new Error(`${this.label} was stopped`),{code:"ACP_STOPPED"});
    await client.stop().catch(()=>{});
  }

  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode)}
  // Cursor and Grok take the permission mode as launch arguments; a different mode needs a new process.
  needsRelaunch(mode){
    if(!this.argsForPermission)return false;
    return JSON.stringify(this.argsForPermission(normalizePermissionMode(mode)))!==JSON.stringify(this.args);
  }
  setReasoningEffort(effort){this.reasoningEffort=text(effort).toLowerCase()||null}
  // The composer's speed for Cursor's Fast switch: "fast" turns it on, anything else (Standard) off. Until a turn names one,
  // Cursor keeps the switch as it is.
  setServiceTier(tier){this.serviceTier=text(tier).toLowerCase()==="fast"?"fast":null}
  // The model settings the user picked in the composer (Cursor's context size or thinking switch), by option id; a setting
  // with no pick stays as Cursor has it.
  setModelOptions(options){this.modelOptions=normalizeModelOptionValues(options)}
  // The composer's Plan mode for Cursor: a Plan turn runs in Cursor's plan mode, any other in its agent mode.
  setCollaborationMode(mode){this.collaborationMode=text(mode).toLowerCase()==="plan"?"plan":"default"}

  async setModel(model){
    if(!this.client||!this.sessionId)throw new Error("ACP session is not started");
    if(this.dead)throw this.deadError||new Error(`${this.label} stopped`);
    await this.#applyModel(model);
    return {model:this.model};
  }
  async setMode(mode){this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"mode",mode);return {mode}}
  async setConfigOption(id,value){
    const result=await this.client?.setConfigOption(this.sessionId,id,value);
    if(Array.isArray(result?.configOptions))this.sessionSetup=acpSetupWithConfigOptions(this.sessionSetup,result.configOptions);
    return result;
  }

  // A model the harness does not list for this sign-in is refused before any switch, saying what to pick instead. Antigravity's
  // list is always checked; another harness's only once it lists some models.
  #refuseUnlisted(choices,model){
    if(choices.some(choice=>choice.value===model))return;
    if(this.runtime==="antigravity"||choices.length)throw new Error(unlistedModelText(this.runtime,this.label,model));
  }

  // The model a thread runs on, applied in the way each harness takes a model.
  async #applyModel(requested){
    const current=acpConfigSelect(this.sessionSetup,"model");
    if(this.runtime==="grok"){
      const target=requestedModel("grok",requested)||current.current;
      if(!target){this.model=null;return}
      const effort=this.#grokEffortFor(target),changed=target!==current.current,effortChanged=Boolean(effort)&&effort!==this.grokEffort;
      if(changed||effortChanged){
        try{await this.client.setModel(this.sessionId,target,effort?{reasoningEffort:effort}:null)}
        catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`,{cause:error}),{code:error?.code})}
        this.sessionSetup=acpSetupWithValue(this.sessionSetup,"model",target);
        this.grokEffort=effort||(changed?text(this.#grokModelMeta(target).reasoningEffort).toLowerCase()||null:this.grokEffort);
        this.grokEffortSet=Boolean(effort&&this.reasoningEffort);
      }
      this.model=target;return;
    }
    if(this.runtime==="cursor"){
      // Cursor saves its model globally, so every session pins the thread's model, Auto ("default") when none.
      const target=requestedModel("cursor",requested)||"default";
      this.#refuseUnlisted(current.choices,target);
      try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
      catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`,{cause:error}),{code:error?.code})}
      this.model=acpConfigSelect(this.sessionSetup,"model").current||target;
      await this.#applyCursorOptions();
      return;
    }
    if(this.runtime==="antigravity"){
      const target=requestedModel("antigravity",requested);
      if(!target){this.model=current.current;return}
      this.#refuseUnlisted(current.choices,target);
      try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
      catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`,{cause:error}),{code:error?.code})}
      this.model=target;return;
    }
    const target=text(requested);
    if(!target||target===current.current){this.model=current.current||target||null;return}
    this.#refuseUnlisted(current.choices,target);
    try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
    catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`,{cause:error}),{code:error?.code})}
    this.model=acpConfigSelect(this.sessionSetup,"model").current||target;
  }

  #grokModelMeta(modelId){
    const model=(this.sessionSetup?.models?.availableModels||[]).find(item=>item?.modelId===modelId);
    return model?._meta&&typeof model._meta==="object"?model._meta:{};
  }
  // The effort a Grok turn runs with: the chosen one when the model offers it; with none chosen, the model's own default
  // once Trebell has changed it in this session (otherwise Grok keeps what it runs with).
  #grokEffortFor(modelId){
    const offered=(this.#grokModelMeta(modelId).reasoningEfforts||[]).map(item=>({value:text(typeof item==="string"?item:item?.value??item?.id).toLowerCase(),isDefault:item?.default===true||item?.isDefault===true}));
    const effort=this.reasoningEffort;
    if(effort)return offered.some(item=>item.value===effort)?effort:null;
    return this.grokEffortSet?offered.find(item=>item.isDefault)?.value||null:null;
  }

  async #applyEffort(){
    if(!this.sessionSetup)return;
    if(this.runtime==="grok"&&this.model&&(this.reasoningEffort||this.grokEffortSet))return this.#applyModel(this.model);
    if(this.runtime==="cursor")return this.#applyCursorOptions();
  }

  // Cursor's per-model settings after its model, in this order: the chosen effort, the Fast switch once a turn has named a
  // speed, then each setting picked in the composer (context, thinking). Each is looked up in the option list as it stands at
  // that step, since Cursor can answer a change with a new list.
  async #applyCursorOptions(){
    const current=()=>this.sessionSetup?.configOptions;
    if(this.reasoningEffort)await this.#changeCursorSetting(cursorEffortChange(current(),this.reasoningEffort));
    if(this.serviceTier!==undefined)await this.#changeCursorSetting(cursorFastChange(current(),this.serviceTier==="fast"));
    for(const [id,picked] of Object.entries(this.modelOptions))await this.#changeCursorSetting(cursorPickedChange(current(),id,picked));
  }

  // Sends one planned change unless the option already holds that value. The session's copy of the option then shows the
  // value, also when Cursor answers without its option list.
  async #changeCursorSetting(change){
    if(!change||String(change.option.currentValue??"")===String(change.value))return;
    const {option,value,label}=change;
    try{await this.setConfigOption(option.id,value)}
    catch(error){throw Object.assign(new Error(`${this.label} could not set ${text(option.name)||label} to ${value}: ${error?.message||error}`,{cause:error}),{code:error?.code})}
    const held=this.sessionSetup?.configOptions,id=text(option.id);
    const stale=Array.isArray(held)?held.find(entry=>text(entry?.id)===id):null;
    if(stale&&String(stale.currentValue??"")!==String(value))this.sessionSetup={...this.sessionSetup,configOptions:held.map(entry=>entry===stale?{...entry,currentValue:value}:entry)};
  }

  // The mode each turn runs in: Antigravity's from the access level, Cursor's from the
  // composer's Plan mode (plan or agent), OpenCode's from the chosen agent, with Read only forcing the harness's
  // read-only mode.
  #targetMode(agent){
    const {choices}=acpConfigSelect(this.sessionSetup,"mode");if(!choices.length||this.runtime==="grok")return null;
    const offered=value=>{const wanted=text(value).toLowerCase();return wanted?choices.find(choice=>choice.value===text(value))?.value||choices.find(choice=>choice.value.toLowerCase()===wanted)?.value||null:null};
    if(this.runtime==="antigravity")return offered(this.permissionMode==="full"?"yolo":this.permissionMode==="edits"?"auto_edit":"default");
    if(this.permissionMode==="read-only"){
      const readOnly=acpReadOnlyMode(this.runtime,this.sessionSetup);
      if(!readOnly)throw new SessionRefusalError(`${this.label} does not offer a read-only mode, so the turn was not sent.`);
      return readOnly;
    }
    if(this.runtime==="cursor"){
      if(this.collaborationMode!=="plan")return offered("agent")||this.defaultMode;
      const plan=offered("plan");
      if(!plan)throw new SessionRefusalError(`${this.label} does not offer a plan mode, so the turn was not sent.`);
      return plan;
    }
    const chosen=agent?offered(agent):null;
    if(chosen)return chosen;
    return offered(this.runtime==="cursor"?"agent":this.runtime==="opencode"?"build":"")||this.defaultMode;
  }

  async #applyMode(agent){
    if(!this.sessionSetup)return;
    const target=this.#targetMode(agent);if(!target)return;
    if(acpConfigSelect(this.sessionSetup,"mode").current===target)return;
    try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"mode",target)}
    catch(error){throw Object.assign(new Error(`${this.label} could not switch to its ${target} mode, so the turn was not sent: ${error?.message||error}`,{cause:error}),{code:error?.code})}
  }

  #rememberCommands(commands){this.commandNames=new Set(commands.map(command=>command.name));return commands}

  #emitInventory(){
    if(this.runtime==="grok"){
      const available=this.initializeResult?._meta?.availableCommands;
      if(Array.isArray(available))this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"available_commands_update",availableCommands:available,commands:this.#rememberCommands(acpCommandsFromAvailable(available,"grok"))}});
    }
    // OpenCode's primary agents are its modes; Cursor's modes follow the composer's Plan mode and Read only instead.
    if(this.runtime==="opencode"){
      const agents=acpModeAgents(this.sessionSetup);
      if(agents.length)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"config_option_update",configOptions:this.sessionSetup?.configOptions||[],agents}});
    }
  }

  #sessionUpdate(params){
    const update=params?.update&&typeof params.update==="object"?params.update:{},type=text(update.sessionUpdate);
    if(params?._meta?.isReplay===true)return;
    // A load replays the conversation; only session metadata passes while starting or loading.
    if((this.starting||this.loading)&&!METADATA_UPDATES.has(type))return;
    if(type==="config_option_update"&&Array.isArray(update.configOptions))this.sessionSetup=acpSetupWithConfigOptions(this.sessionSetup,update.configOptions);
    if(type==="current_mode_update"&&text(update.currentModeId))this.sessionSetup=acpSetupWithValue(this.sessionSetup,"mode",text(update.currentModeId));
    // A compaction the harness reports finished, its own or a /compact's.
    if(type==="compaction_update"&&text(update.status)==="completed")this.#compacted();
    // Grok answers a finished background task in a turn of its own, tagged task-completed-*.
    const promptId=params?._meta?.promptId;
    if(this.runtime==="grok"&&!this.activePrompt&&typeof promptId==="string"&&promptId.startsWith(GROK_TASK_PROMPT_PREFIX)&&this.wake?.promptId!==promptId){this.#finishWake("end_turn");this.#beginWake(promptId)}
    if(this.activePrompt?.transport)this.#watchCursorMessage(this.activePrompt,type,update);
    // Any update but session metadata while a prompt runs is the harness at work on it, so the prompt is in its conversation. It is
    // told before the update goes on, so the delivery is recorded ahead of the turn's first step.
    if(this.activePrompt&&!METADATA_UPDATES.has(type))this.#promptTaken(this.activePrompt);
    // A tool frame joins its call's state only once the relay has taken it: one the relay throws on is dropped whole (acp-client.mjs),
    // so the call's next updates do not bring its fields back and are not dropped for them.
    const tool=this.#toolState(update,type);
    this.onUpdate?.(tool?{...params,update:{...acpToolFrame(tool.merged),sessionUpdate:type}}:this.#decorate(params,update,type));
    if(tool)this.#keepTool(tool.id,tool.merged);
  }

  // A tool frame merged into its call's last state; null for any other update and for a frame with no call id.
  #toolState(update,type){
    if(type!=="tool_call"&&type!=="tool_call_update")return null;
    const id=text(update.toolCallId);
    return id?{id,merged:mergeAcpToolUpdate(this.tools.get(id),update)}:null;
  }
  #keepTool(id,merged){
    this.tools.delete(id);this.tools.set(id,merged);
    if(this.tools.size>TOOL_STATE_LIMIT)this.tools.delete(this.tools.keys().next().value);
  }

  // Each Cursor reply message is read on its own for a lost-connection dump: a tool call, a thought or a plan ends
  // the message before it, so the next text starts a new one, and the end of the prompt reads only the last. Session metadata ends none.
  // The message's text is kept beside its detector (active.message) for a failure to carry.
  #watchCursorMessage(active,type,update){
    if(CURSOR_MESSAGE_BREAKS.has(type)){active.messageEnded=true;return}
    if(type!=="agent_message_chunk"||update.content?.type!=="text")return;
    if(active.messageEnded){active.transport=new CursorLostBackendReply();active.message="";active.messageEnded=false}
    active.transport.append(update.content.text);active.message=(active.message||"")+String(update.content.text??"");
  }

  #decorate(params,update,type){
    if(type==="available_commands_update")return {...params,update:{...update,commands:this.#rememberCommands(acpCommandsFromAvailable(update.availableCommands,this.runtime))}};
    if(type==="config_option_update"&&this.runtime==="opencode")return {...params,update:{...update,agents:acpModeAgents(this.sessionSetup)}};
    return params;
  }

  #notification(message){
    const method=text(message?.method),params=message?.params||{};
    if(method==="elicitation/complete"){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"elicitation_complete",elicitationId:params.elicitationId||null}});return}
    // Cursor's todo list also arrives as a notification.
    if(this.runtime==="cursor"&&method==="cursor/update_todos"){this.#emitTodos(params?.todos,params?.merge===true);return}
    if(this.runtime!=="grok")return;
    if(GROK_PROMPT_COMPLETE.has(method)){
      if(params.sessionId&&params.sessionId!==this.sessionId)return;
      this.grokCompletions.get(text(params.promptId))?.({promptId:text(params.promptId),stopReason:params.stopReason,agentResult:params.agentResult});
      return;
    }
    if(!GROK_SESSION_NOTIFICATIONS.has(method)||(params.sessionId&&params.sessionId!==this.sessionId))return;
    const update=params.update||{},kind=text(update.sessionUpdate);
    if(kind==="model_changed"){
      const model=text(update.model_id||update.modelId),effort=text(update.reasoning_effort||update.reasoningEffort).toLowerCase();
      if(model){this.sessionSetup=acpSetupWithValue(this.sessionSetup,"model",model);this.model=model}
      if(effort)this.grokEffort=effort;
      return;
    }
    if(kind!=="turn_completed")return;
    const promptId=text(update.prompt_id||update.promptId),stopReason=text(update.stop_reason||update.stopReason);
    if(promptId.startsWith(GROK_TASK_PROMPT_PREFIX)){if(this.wake?.promptId===promptId)this.#finishWake(stopReason||"end_turn");return}
    if(promptId)this.grokCompletions.get(promptId)?.({promptId,stopReason,agentResult:update.agent_result??update.agentResult});
  }

  #beginWake(promptId){
    let finish;const promise=new Promise(resolve=>{finish=resolve});
    this.wake={promptId,finish};
    try{this.onWakeTurn?.(promise)}catch{}
  }
  #finishWake(stopReason="end_turn"){
    const wake=this.wake;if(!wake)return;
    this.wake=null;wake.finish({stopReason});
  }

  // A wait on the user that Stop, a dead process or close() answers as cancelled.
  #waitForUser(start){
    let cancel;const cancelled=new Promise(resolve=>{cancel=()=>resolve(CANCELLED)});
    this.userWaits.add(cancel);
    return Promise.race([Promise.resolve().then(start),cancelled]).finally(()=>this.userWaits.delete(cancel));
  }
  #cancelUserWaits(){for(const cancel of [...this.userWaits])cancel();this.userWaits.clear()}

  // Asks the user through the relay's question prompt; null when dismissed or cancelled.
  async #ask(questions){
    if(typeof this.onQuestion!=="function")return null;
    const result=await this.#waitForUser(()=>this.onQuestion({input:{questions}}));
    if(result===CANCELLED||!result||typeof result!=="object"||!Object.keys(result).length)return null;
    const out={};
    for(const [id,value] of Object.entries(result))out[id]=(Array.isArray(value)?value:[value]).map(item=>text(item)).filter(Boolean);
    return out;
  }

  async #permission(params){
    const options=Array.isArray(params?.options)?params.options:[],toolCall=params?.toolCall||{};
    // Antigravity asks its multiple-choice questions through the permission method.
    if(this.runtime==="antigravity"&&text(toolCall.toolCallId).startsWith("interaction_"))return this.#antigravityQuestion(toolCall,options);
    const kind=toolCall.kind??params?.kind??null;
    // In Grok's Auto mode Grok decides routine actions itself; whatever it asks about goes to the user.
    const askUser=this.runtime==="grok"&&this.permissionMode==="auto";
    const automatic=askUser?null:acpPermissionChoice(options,this.permissionMode,kind,{action:toolCall.title||"session/request_permission",rawInput:toolCall.rawInput||params,workspace:this.cwd});
    if(automatic)return selected(automatic);
    const decision=await this.#waitForUser(()=>this.onPermission?.({method:"session/request_permission",params,options,askUser,approvalOptions:acpApprovalOptions(this.runtime,options)}));
    const optionId=decision===CANCELLED?null:acpDecisionOption(this.runtime,options,decision||"decline");
    return optionId?selected(optionId):CANCELLED_OUTCOME;
  }

  async #antigravityQuestion(toolCall,options){
    const question=antigravityChoiceQuestion(toolCall,options);
    if(!question)return CANCELLED_OUTCOME;
    const answers=await this.#ask([question.prompt]);
    return antigravityChoiceAnswer(question.choices,answers?.[question.prompt.id]?.[0]);
  }

  // Shows a plan the agent proposed (Cursor create_plan, Grok exit_plan_mode) as part of the turn's reply.
  #emitPlanText(markdown){
    const body=text(markdown);if(!body)return;
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"\n\n"+body+"\n"}}});
  }

  #emitTodos(todos,merge){
    if(!merge)this.todos.clear();
    for(const [index,todo] of (Array.isArray(todos)?todos:[]).entries()){
      const content=text(todo?.content)||text(todo?.title),id=text(todo?.id)||content||`todo-${index}`;
      if(!content&&!this.todos.has(id))continue;
      const status=todo?.status==="completed"?"completed":todo?.status==="in_progress"||todo?.status==="inProgress"?"in_progress":"pending";
      this.todos.set(id,{content:content||this.todos.get(id).content,status});
    }
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"plan",entries:[...this.todos.values()]}});
  }

  async #cursorAskQuestion(params){
    const list=Array.isArray(params?.questions)?params.questions:[];
    const questions=list.map((question,index)=>({id:text(question?.id)||`q${index+1}`,header:text(params?.title)||"Question",question:text(question?.prompt)||CURSOR_WORDLESS_QUESTION,multiSelect:question?.allowMultiple===true,options:(question?.options||[]).map(option=>({label:text(option?.label)||text(option?.id),description:""}))}));
    if(!questions.length)return {outcome:{outcome:"skipped",reason:"No questions were asked"}};
    const answers=await this.#ask(questions);
    if(!answers)return {outcome:{outcome:"cancelled"}};
    const chosen=[],notes=[];
    for(const [index,question] of list.entries()){
      const id=questions[index].id,values=answers[id]||[];
      const ids=(question?.options||[]).filter(option=>values.includes(text(option?.label)||text(option?.id))||values.includes(text(option?.id))).map(option=>option.id);
      if(ids.length)chosen.push({questionId:question.id??id,selectedOptionIds:ids});
      else if(values.length)notes.push(`${questions[index].question}: ${values.join(", ")}`);
    }
    if(chosen.length)return {outcome:{outcome:"answered",answers:chosen}};
    return {outcome:{outcome:"skipped",reason:notes.length?`The user answered: ${notes.join("; ")}`:"The user skipped the questions"}};
  }

  async #grokAskUserQuestion(raw){
    const params=unwrapGrokParams(raw),list=Array.isArray(params?.questions)?params.questions:[];
    const questions=list.map((question,index)=>({
      id:String(question?.id??question?.question??`q${index+1}`),header:"Question",question:text(question?.question)||"Provide input",multiSelect:question?.multiSelect===true,
      options:(question?.options||[]).length?question.options.map(option=>({label:String(option?.label||""),description:String(option?.description||option?.label||"")})):[{label:"OK",description:"Continue"}],
    }));
    if(!questions.length)return {outcome:"cancelled"};
    const answers=await this.#ask(questions);
    return answers?grokQuestionResponse(list,answers):{outcome:"cancelled"};
  }

  async #writeAllowed(params){
    if(this.permissionMode==="read-only")return false;
    // Antigravity gates every write behind session/request_permission already.
    if(this.runtime==="antigravity")return true;
    const options=[{kind:"allow_once",optionId:"allow",name:"Allow"},{kind:"reject_once",optionId:"reject",name:"Reject"}];
    const automatic=acpPermissionChoice(options,this.permissionMode,"edit",{action:"Write file",rawInput:params,workspace:this.cwd,requestedPath:params.path});
    if(automatic)return automatic==="allow";
    const decision=await this.#waitForUser(()=>this.onPermission?.({method:"fs/write_text_file",params,options,approvalOptions:acpApprovalOptions(this.runtime,options)}));
    return decision!==CANCELLED&&acpDecisionOption(this.runtime,options,decision||"decline")==="allow";
  }

  async close(){
    this.closing=true;this.#cancelUserWaits();this.#finishWake("cancelled");
    if(this.client&&this.sessionId&&!this.dead&&!this.client.closed)await this.client.closeSession(this.sessionId).catch(()=>{});
    await this.client?.stop().catch(()=>{});
  }

  async #clientRequest(method,params){
    // A file or terminal request the harness was not offered is refused; the harness does that work itself
    // (OpenCode's ACP server, for one, also writes an approved edit through the client and writes it itself when refused).
    if(!offeredClientService(this.#clientCapabilities(),method))throw Object.assign(new Error(`${this.label} was not offered ${method} by Trebell; it runs its own file and shell tools`),{code:-32601});
    if(method==="fs/read_text_file"){
      const content=this.remoteIo?await this.remoteIo.readText(params.path):await readFile(await clientFilePath(this.#clientFileRoots(),params.path),"utf8");
      return {content:acpFileSlice(content,params.line??null,params.limit??null)};
    }
    if(method==="fs/write_text_file"){
      if(!await this.#writeAllowed(params))throw Object.assign(new Error("File write was denied"),{code:-32000});
      if(this.remoteIo){await this.remoteIo.writeText(params.path,String(params.content??""));return {}}
      const path=await clientFilePath(this.#clientFileRoots(),params.path);
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,String(params.content??""),"utf8");
      return {};
    }
    if(method==="session/request_permission")return this.#permission(params);
    if(method==="session/elicitation"||method==="elicitation/create"){
      const result=await this.#waitForUser(()=>this.onElicitation?.({method,params}));
      return result&&result!==CANCELLED?result:{action:"cancel"};
    }
    if(this.runtime==="grok"&&(method==="x.ai/ask_user_question"||method==="_x.ai/ask_user_question"))return this.#grokAskUserQuestion(params);
    if(this.runtime==="grok"&&(method==="x.ai/exit_plan_mode"||method==="_x.ai/exit_plan_mode")){
      this.#emitPlanText(text(unwrapGrokParams(params)?.planContent)||GROK_EMPTY_PLAN);
      return {outcome:"abandoned",feedback:GROK_PLAN_FEEDBACK};
    }
    if(this.runtime==="cursor"){
      if(method==="cursor/ask_question")return this.#cursorAskQuestion(params);
      if(method==="cursor/create_plan"){
        this.#emitPlanText(cursorPlanMarkdown(params));
        if(Array.isArray(params?.todos)&&params.todos.length)this.#emitTodos(params.todos,false);
        return {outcome:{outcome:"accepted"}};
      }
      if(method==="cursor/update_todos"){this.#emitTodos(params?.todos,params?.merge===true);return {}}
      if(method==="cursor/task"||method==="cursor/generate_image")return {};
    }
    throw Object.assign(new Error(`Unsupported ACP client request: ${method}`),{code:-32601});
  }
}
