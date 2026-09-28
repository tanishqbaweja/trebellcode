import { TREBELL_USER_AGENT } from "./version.mjs";
import { adaptAnthropicResponse, ANTHROPIC_PRE_SERIALIZED_MESSAGES, chatToAnthropic, createAnthropicMessageProjector, providerTurnAnthropicScaffold, providerTurnToAnthropic } from "./anthropic-chat-adapter.mjs";
import { NATIVE_CHAT_MESSAGE_CACHE_IDENTITY, normalizeChatTurnResponse, normalizeResponsesTurnResponse, providerTurnToChat, providerTurnToResponses, providerToolsToChat } from "./provider-turn.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { performance } from "node:perf_hooks";
import { providerCapabilities } from "./provider-capabilities.mjs";
import { NATIVE_OPENAI_CONTINUATION_IDENTITY, OpenAiResponseContinuationTracker } from "./openai-response-continuation.mjs";
import { OpenAiResponsesWebSocket, openAiResponsesWebSocketStreamId } from "./openai-responses-websocket.mjs";
import { NATIVE_TOOL_SCHEMA_FINGERPRINT } from "./native-request-metrics.mjs";

export const MODEL_PROVIDERS = Object.freeze({
  freebuff: {
    id: "freebuff",
    name: "Freebuff",
    baseUrl: null,
    wireApi: "responses",
    protocolCompatibility: ["openai-responses"],
    envKey: null,
    requiresKey: false,
  },
  openai: {
    id: "openai",
    name: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    wireApi: "responses",
    protocolCompatibility: ["openai-responses"],
    envKey: "OPENAI_API_KEY",
    requiresKey: true,
    official: true,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic API",
    baseUrl: "https://api.anthropic.com/v1",
    wireApi: "chat",
    protocolCompatibility: ["anthropic-messages"],
    envKey: "ANTHROPIC_API_KEY",
    requiresKey: true,
    official: true,
    authStyle: "anthropic",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini API",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "GEMINI_API_KEY",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    requiresKey: true,
    official: true,
  },
  agentrouter: {
    id: "agentrouter",
    name: "AgentRouter",
    baseUrl: "https://co.agentrouter.org/v1",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "AGENTROUTER_API_KEY",
    requiresKey: true,
  },
  justworker: {
    id: "justworker",
    name: "JustWorker.icu",
    // The endpoint supplied by the service intentionally spells the host
    // "justwoker". Keep the configured API URL exact instead of guessing.
    baseUrl: "https://api.justwoker.icu/v1",
    wireApi: "chat",
    protocolCompatibility: ["anthropic-messages"],
    envKey: "JUSTWORKER_API_KEY",
    envKeys: ["JUSTWORKER_API_KEY", "JUST_WORKER_API_KEY"],
    requiresKey: true,
    staticModels: ["claude-opus-4-8"],
  },
  hcnsec: {
    id: "hcnsec",
    name: "HCNSec.cn",
    baseUrl: "https://api.hcnsec.cn/v1",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "HCNSEC_API_KEY",
    envKeys: ["HCNSEC_API_KEY", "HNSEC_API_KEY"],
    requiresKey: true,
    staticModels: ["glm-5.3"],
  },
  vyceai: {
    id: "vyceai",
    name: "VyceAi",
    baseUrl: "https://vyceai.com/v1",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "VYCEAI_API_KEY",
    envKeys: ["VYCEAI_API_KEY", "VYCE_API_KEY"],
    requiresKey: true,
  },
});

export function normalizeProviderId(value) {
  const id = String(value || "freebuff").trim().toLowerCase();
  return MODEL_PROVIDERS[id] ? id : "freebuff";
}

function providerSecretsPath(env = process.env) {
  return join(trebellHome(env), "provider-secrets.json");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bundledCodexVersion(){
  try{
    const pkg=JSON.parse(readFileSync(new URL("../node_modules/@openai/codex/package.json",import.meta.url),"utf8"));
    const value=String(pkg?.version||"").trim();if(value)return value;
  }catch{}
  try{
    const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
    const value=String(pkg?.dependencies?.["@openai/codex"]||"").trim().replace(/^[^0-9]*/,"");
    if(value)return value;
  }catch{}
  return "0.149.1";
}
const DEFAULT_AGENTROUTER_CLIENT_VERSION=bundledCodexVersion();
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;
function providerErrorExcerpt(value,{environment={},secret="",maxChars=1200}={}){
  const max=Math.max(120,Math.min(4000,Math.trunc(Number(maxChars)||1200))),scan=String(value??"").slice(0,Math.max(max*4,max+4096));
  return redactSecretText(scan,{environment:{...environment,TREBELL_PROVIDER_ERROR_SECRET:String(secret||"")}}).slice(0,max);
}
function agentRouterClientVersion(environment={}){
  const requested=String(environment.AGENTROUTER_CLIENT_VERSION||environment.TREBELL_AGENTROUTER_CLIENT_VERSION||DEFAULT_AGENTROUTER_CLIENT_VERSION).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(requested)?requested:DEFAULT_AGENTROUTER_CLIENT_VERSION;
}

function agentRouterHeaders(key, { accept = "application/json", environment = {} } = {}) {
  const version=agentRouterClientVersion(environment);
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: accept,
    "User-Agent": `codex_cli_rs/${version}`,
    originator: "codex_cli_rs",
    version,
  };
}

function agentRouterProvider(provider,environment={}){
  const configuredBase=String(environment.AGENTROUTER_BASE_URL||"").trim().replace(/\/+$/,"");
  const requestedWire=String(environment.AGENTROUTER_WIRE_API||"").trim().toLowerCase();
  const wireApi=["responses","openai-responses"].includes(requestedWire)
    ?"responses"
    :["chat","openai-chat-completions"].includes(requestedWire)
      ?"chat"
      :provider.wireApi;
  return {
    ...provider,
    baseUrl:configuredBase||provider.baseUrl,
    wireApi,
    protocolCompatibility:[wireApi==="responses"?"openai-responses":"openai-chat-completions"],
  };
}

function officialResponsesToolName(namespace,name){return namespace?String(namespace)+"__"+String(name||"tool"):String(name||"tool")}
function officialOpenAiPromptCacheKey(body={},toolsJson=null){
  if(typeof toolsJson!=="string"){
    const seed=JSON.stringify({model:String(body.model||""),instructions:String(body.instructions||""),tools:Array.isArray(body.tools)?body.tools:[],parallelToolCalls:Boolean(body.parallel_tool_calls)});
    return "trebell-"+createHash("sha256").update(seed).digest("hex").slice(0,32);
  }
  const state=createHash("sha256");
  state.update('{"model":');state.update(JSON.stringify(String(body.model||"")));
  state.update(',"instructions":');state.update(JSON.stringify(String(body.instructions||"")));
  state.update(',"tools":');state.update(toolsJson);
  state.update(',"parallelToolCalls":');state.update(Boolean(body.parallel_tool_calls)?"true":"false");state.update("}");
  return "trebell-"+state.digest("hex").slice(0,32);
}
function officialOpenAiExplicitCacheBreakpointsSupported(model=""){
  const match=String(model||"").trim().toLowerCase().match(/(?:^|\/)gpt-(\d+)(?:\.(\d+))?/);
  if(!match)return false;
  const major=Number(match[1]||0),minor=Number(match[2]||0);
  return major>5||(major===5&&minor>=6);
}
function normalizedOpenAiPromptCacheDiagnostics(body={}){
  const value=body?.prompt_cache_diagnostics;
  if(!value||typeof value!=="object")return null;
  const type=String(value.type||"").trim();if(!type)return null;
  const reason=String(value.reason||"").trim();
  const optionalCount=input=>{
    if(input==null||input==="")return null;
    const number=Number(input);return Number.isFinite(number)&&number>=0?number:null;
  };
  return {
    type:type.slice(0,80),
    reason:reason?reason.slice(0,120):null,
    comparisonReusableTokens:optionalCount(value.comparison_reusable_tokens),
    cacheMissedTokens:optionalCount(value.cache_missed_tokens),
  };
}
function normalizedOpenAiReasoningContext(body={}){
  const context=String(body?.reasoning?.context||"").trim().toLowerCase();
  return ["all_turns","current_turn"].includes(context)?context:null;
}
function officialOpenAiTools(requestTools=[]){
  const tools=[];
  for(const entry of Array.isArray(requestTools)?requestTools:[]){
    if(entry?.type==="namespace"&&entry.name&&Array.isArray(entry.tools)){
      for(const child of entry.tools){
        if(!child?.name)continue;
        tools.push({type:"function",name:officialResponsesToolName(entry.name,child.name),description:child.description||entry.description||"",parameters:child.parameters||child.inputSchema||{type:"object",properties:{}}});
      }
      continue;
    }
    if(entry?.type==="function"){
      const source=entry.function||entry,name=source.name||entry.name;if(!name)continue;
      tools.push({type:"function",name:String(name),description:source.description||entry.description||"",parameters:source.parameters||entry.parameters||entry.inputSchema||{type:"object",properties:{}}});
    }
  }
  return tools;
}
const PRE_SERIALIZED_TOP_LEVEL=Symbol("trebell.provider.pre-serialized-top-level");
function attachPreSerializedTopLevel(body,key,value,json){
  if(!body||typeof body!=="object"||typeof json!=="string")return body;
  try{
    let cached=body[PRE_SERIALIZED_TOP_LEVEL];
    if(!(cached instanceof Map)){cached=new Map();Object.defineProperty(body,PRE_SERIALIZED_TOP_LEVEL,{value:cached,enumerable:true,configurable:true})}
    cached.set(String(key),{value,json});
  }catch{}
  return body;
}
function stringifyProviderBody(body){
  const cached=body&&typeof body==="object"?body[PRE_SERIALIZED_TOP_LEVEL]:null;
  if(!(cached instanceof Map)||!cached.size||typeof body?.toJSON==="function")return JSON.stringify(body);
  const parts=[];
  for(const key of Object.keys(body)){
    const entry=cached.get(key),valueJson=entry&&entry.value===body[key]&&typeof entry.json==="string"?entry.json:JSON.stringify(body[key]);
    if(valueJson!==undefined)parts.push(JSON.stringify(key)+":"+valueJson);
  }
  return `{${parts.join(",")}}`;
}

function preSerializedChatMessages(messages=[],cache=null){
  if(!cache||typeof cache.get!=="function"||typeof cache.set!=="function")return null;
  const parts=[];
  try{
    for(const message of Array.isArray(messages)?messages:[]){
      if(!message||typeof message!=="object")return null;
      let json=cache.get(message);if(typeof json!=="string"){json=JSON.stringify(message);if(typeof json!=="string")return null;cache.set(message,json)}parts.push(json);
    }
  }catch{return null}
  return `[${parts.join(",")}]`;
}
function officialOpenAiResponsesBody(request={},toolManifest=null,promptCacheKeyForBody=null,responsesOptions=null){
  const explicitCacheBreakpoints=officialOpenAiExplicitCacheBreakpointsSupported(request.model),body=providerTurnToResponses(request,{preserveInstructionOrder:true,flattenToolCallNames:true,toolResultCacheBreakpoints:explicitCacheBreakpoints,...(responsesOptions&&typeof responsesOptions==="object"?responsesOptions:{})});
  const tools=Array.isArray(toolManifest?.tools)?toolManifest.tools:officialOpenAiTools(request.tools);body.tools=tools;
  if(explicitCacheBreakpoints){
    const comparisonResponseId=String(request.promptCacheComparisonResponseId||"").trim();
    body.prompt_cache_options={mode:"implicit",...(comparisonResponseId?{comparison_response_id:comparisonResponseId}:{})};
  }
  body.prompt_cache_key=typeof promptCacheKeyForBody==="function"?promptCacheKeyForBody(body,toolManifest?.toolsJson):officialOpenAiPromptCacheKey(body,toolManifest?.toolsJson);
  if(toolManifest?.toolsJson&&body.tools===toolManifest.tools)attachPreSerializedTopLevel(body,"tools",body.tools,toolManifest.toolsJson);
  return body;
}

async function readOpenAiResponsesStream(source,{requestStartedAt=performance.now()}={}){
  if(!source||typeof source.getReader!=="function")throw new Error("OpenAI Responses stream body is unavailable.");
  const reader=source.getReader(),decoder=new TextDecoder();let buffer="",response=null,responseBytes=0,timeToFirstTokenMs=null;
  const consume=block=>{
    const data=String(block||"").split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
    if(!data||data==="[DONE]")return;
    let event;try{event=JSON.parse(data)}catch{throw new Error("OpenAI Responses stream returned an invalid JSON event.")}
    if(event.type==="response.output_text.delta"&&event.delta&&timeToFirstTokenMs==null)timeToFirstTokenMs=Number((performance.now()-requestStartedAt).toFixed(3));
    if((event.type==="response.completed"||event.type==="response.incomplete")&&event.response)response=event.response;
    if(event.type==="response.failed"){
      const error=new Error(event.response?.error?.message||event.error?.message||"OpenAI Responses stream failed.");error.code=event.response?.error?.code||event.error?.code||"openai_stream_failed";throw error;
    }
    if(event.type==="error"){
      const error=new Error(event.message||event.error?.message||"OpenAI Responses stream failed.");error.code=event.code||event.error?.code||"openai_stream_error";throw error;
    }
  };
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      responseBytes+=Number(value?.byteLength||0);buffer+=decoder.decode(value,{stream:true});
      const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||"";for(const block of blocks)consume(block);
    }
    buffer+=decoder.decode();if(buffer.trim())consume(buffer);
  }catch(error){error.streamTelemetry={responseBytes,timeToFirstTokenMs};throw error}
  finally{reader.releaseLock()}
  if(!response)throw new Error("OpenAI Responses stream ended before a completed response was received.");
  return {response,responseBytes,timeToFirstTokenMs};
}

async function readOpenAiChatStream(source,{requestStartedAt=performance.now()}={}){
  if(!source||typeof source.getReader!=="function")throw new Error("OpenAI Chat stream body is unavailable.");
  const reader=source.getReader(),decoder=new TextDecoder();let buffer="",responseBytes=0,timeToFirstTokenMs=null,id="",model="",finishReason=null,usage=null,text="",role="assistant";
  const toolCalls=new Map();
  const consume=block=>{
    const data=String(block||"").split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
    if(!data||data==="[DONE]")return;
    let event;try{event=JSON.parse(data)}catch{throw new Error("OpenAI Chat stream returned an invalid JSON event.")}
    if(event.error){
      const error=new Error(event.error?.message||"OpenAI Chat stream failed.");error.code=event.error?.code||"openai_chat_stream_error";throw error;
    }
    if(event.id)id=String(event.id);if(event.model)model=String(event.model);if(event.usage)usage=event.usage;
    for(const choice of Array.isArray(event.choices)?event.choices:[]){
      if(choice?.finish_reason)finishReason=String(choice.finish_reason);
      const delta=choice?.delta||{};if(delta.role)role=String(delta.role);
      if(typeof delta.content==="string"&&delta.content){
        if(timeToFirstTokenMs==null)timeToFirstTokenMs=Number((performance.now()-requestStartedAt).toFixed(3));
        text+=delta.content;
      }
      for(const fragment of Array.isArray(delta.tool_calls)?delta.tool_calls:[]){
        const index=Number.isFinite(Number(fragment?.index))?Number(fragment.index):toolCalls.size,current=toolCalls.get(index)||{id:"",type:"function",function:{name:"",arguments:""}};
        if(fragment?.id)current.id=String(fragment.id);if(fragment?.type)current.type=String(fragment.type);
        if(fragment?.function?.name)current.function.name+=String(fragment.function.name);
        if(fragment?.function?.arguments)current.function.arguments+=String(fragment.function.arguments);
        toolCalls.set(index,current);
      }
    }
  };
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      responseBytes+=Number(value?.byteLength||0);buffer+=decoder.decode(value,{stream:true});
      const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||"";for(const block of blocks)consume(block);
    }
    buffer+=decoder.decode();if(buffer.trim())consume(buffer);
  }catch(error){error.streamTelemetry={responseBytes,timeToFirstTokenMs};throw error}
  finally{reader.releaseLock()}
  return {
    response:{id,model,choices:[{message:{role,content:text,tool_calls:[...toolCalls.entries()].sort((a,b)=>a[0]-b[0]).map(([,call])=>call)},finish_reason:finishReason}],usage:usage||{}},
    responseBytes,timeToFirstTokenMs,
  };
}

function normalizeProviderKey(value) {
  let key = String(value || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      key = key.slice(1, -1).trim();
    }
  }
  key = key.replace(/^Bearer\s+/i, "").trim();
  return key;
}

function providerRequestSignal(signal, timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function remainingProviderRequestMs(deadlineAt){
  const remaining=Math.ceil(Number(deadlineAt)-performance.now());
  if(remaining>0)return remaining;
  const error=new DOMException("Provider request deadline exceeded.","TimeoutError");error.retryable=false;throw error;
}

export class ProviderManager {
  constructor({ env = process.env, fetchFn = fetch, requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, openAiResponsesWebSocketFactory=null, openAiResponsesWebSocketRetryMs=30_000, openAiToolManifestCacheSize=32, openAiPromptCacheKeyCacheSize=128, anthropicToolManifestCacheSize=32, chatToolManifestCacheSize=32, reusePreSerializedToolJson=true, reuseOpenAiContinuationInputBuild=true, reuseChatMessageConversion=true, reuseAnthropicMessageBuild=true, nowFn=Date.now } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
    const timeoutMs = Math.trunc(Number(requestTimeoutMs));
    this.requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.path = providerSecretsPath(env);
    mkdirSync(dirname(this.path), { recursive: true });
    this.secrets = this.#load();
    this.openAiResponseContinuations=new OpenAiResponseContinuationTracker();
    this.openAiResponsesWebSocketFactory=typeof openAiResponsesWebSocketFactory==="function"?openAiResponsesWebSocketFactory:options=>new OpenAiResponsesWebSocket(options);
    const retryMs=Math.trunc(Number(openAiResponsesWebSocketRetryMs));this.openAiResponsesWebSocketRetryMs=Number.isFinite(retryMs)&&retryMs>=0?retryMs:30_000;this.nowFn=typeof nowFn==="function"?nowFn:Date.now;
    this.openAiResponsesWebSocket=null;this.openAiResponsesWebSocketDisabledUntil=0;this.openAiResponsesWebSocketPermanentlyDisabled=false;this.openAiResponsesWebSocketTransientFailures=0;
    this.reusePreSerializedToolJson=reusePreSerializedToolJson!==false;
    this.reuseOpenAiContinuationInputBuild=reuseOpenAiContinuationInputBuild!==false;
    this.reuseChatMessageConversion=reuseChatMessageConversion!==false;this.chatMessageConversionCaches=new WeakMap();
    this.reuseAnthropicMessageBuild=reuseAnthropicMessageBuild!==false;this.anthropicMessageProjectors=new WeakMap();
    const manifestCacheSize=Math.trunc(Number(openAiToolManifestCacheSize));this.openAiToolManifestCacheSize=Number.isFinite(manifestCacheSize)&&manifestCacheSize>=0?Math.min(256,manifestCacheSize):32;this.openAiToolManifestCache=new Map();
    const anthropicManifestCacheSize=Math.trunc(Number(anthropicToolManifestCacheSize));this.anthropicToolManifestCacheSize=Number.isFinite(anthropicManifestCacheSize)&&anthropicManifestCacheSize>=0?Math.min(256,anthropicManifestCacheSize):32;this.anthropicToolManifestCache=new Map();
    const cacheKeyCacheSize=Math.trunc(Number(openAiPromptCacheKeyCacheSize));this.openAiPromptCacheKeyCacheSize=Number.isFinite(cacheKeyCacheSize)&&cacheKeyCacheSize>=0?Math.min(1024,cacheKeyCacheSize):128;this.openAiPromptCacheKeyCache=new Map();
    const chatCacheSize=Math.trunc(Number(chatToolManifestCacheSize));this.chatToolManifestCacheSize=Number.isFinite(chatCacheSize)&&chatCacheSize>=0?Math.min(256,chatCacheSize):32;this.chatToolManifestCache=new Map();
  }

  #openAiToolManifest(request={}){
    const supplied=request?.[NATIVE_TOOL_SCHEMA_FINGERPRINT],fingerprint=/^[a-f0-9]{64}$/i.test(String(supplied||""))?String(supplied).toLowerCase():null;
    if(fingerprint&&this.openAiToolManifestCacheSize>0&&this.openAiToolManifestCache.has(fingerprint)){
      const cached=this.openAiToolManifestCache.get(fingerprint);this.openAiToolManifestCache.delete(fingerprint);this.openAiToolManifestCache.set(fingerprint,cached);return cached;
    }
    const builtTools=officialOpenAiTools(request.tools),toolsJson=fingerprint?JSON.stringify(builtTools):null,tools=toolsJson==null?builtTools:JSON.parse(toolsJson),manifest={tools,toolsJson};
    if(fingerprint&&this.openAiToolManifestCacheSize>0){this.openAiToolManifestCache.set(fingerprint,manifest);while(this.openAiToolManifestCache.size>this.openAiToolManifestCacheSize)this.openAiToolManifestCache.delete(this.openAiToolManifestCache.keys().next().value)}
    return manifest;
  }

  #openAiPromptCacheKey(request={},body={},toolsJson=null){
    const supplied=request?.[NATIVE_TOOL_SCHEMA_FINGERPRINT],fingerprint=/^[a-f0-9]{64}$/i.test(String(supplied||""))?String(supplied).toLowerCase():null;
    if(!fingerprint||this.openAiPromptCacheKeyCacheSize<=0)return officialOpenAiPromptCacheKey(body,toolsJson);
    const lookup=String(body.model||"")+"\0"+(body.parallel_tool_calls?"1":"0")+"\0"+fingerprint+"\0"+String(body.instructions||"");
    if(this.openAiPromptCacheKeyCache.has(lookup)){
      const cached=this.openAiPromptCacheKeyCache.get(lookup);this.openAiPromptCacheKeyCache.delete(lookup);this.openAiPromptCacheKeyCache.set(lookup,cached);return cached;
    }
    const value=officialOpenAiPromptCacheKey(body,toolsJson);this.openAiPromptCacheKeyCache.set(lookup,value);
    while(this.openAiPromptCacheKeyCache.size>this.openAiPromptCacheKeyCacheSize)this.openAiPromptCacheKeyCache.delete(this.openAiPromptCacheKeyCache.keys().next().value);
    return value;
  }

  #officialOpenAiResponsesBody(request={},responsesOptions=null){
    const manifest=this.#openAiToolManifest(request);
    return officialOpenAiResponsesBody(request,manifest,(body,toolsJson)=>this.#openAiPromptCacheKey(request,body,toolsJson),responsesOptions);
  }

  #anthropicToolScaffold(request={}){
    const supplied=request?.[NATIVE_TOOL_SCHEMA_FINGERPRINT],fingerprint=/^[a-f0-9]{64}$/i.test(String(supplied||""))?String(supplied).toLowerCase():null;
    if(!fingerprint||this.anthropicToolManifestCacheSize<=0)return {scaffold:providerTurnAnthropicScaffold(request),toolsJson:null};
    const maxOutputTokens=request.maxOutputTokens!=null&&Number.isFinite(Number(request.maxOutputTokens))?Math.max(1,Math.trunc(Number(request.maxOutputTokens))):null,temperature=request.temperature!=null&&Number.isFinite(Number(request.temperature))?Number(request.temperature):null,reasoningEffort=request.reasoningEffort==null?null:String(request.reasoningEffort).trim()||null;
    let toolChoiceKey;try{toolChoiceKey=JSON.stringify(request.toolChoice??"auto")}catch{return {scaffold:providerTurnAnthropicScaffold(request),toolsJson:null}}
    const key=JSON.stringify([fingerprint,String(request.model||""),maxOutputTokens,temperature,reasoningEffort,toolChoiceKey]);
    if(this.anthropicToolManifestCache.has(key)){
      const cached=this.anthropicToolManifestCache.get(key);this.anthropicToolManifestCache.delete(key);this.anthropicToolManifestCache.set(key,cached);return cached;
    }
    const scaffold=providerTurnAnthropicScaffold(request),toolsJson=Array.isArray(scaffold.tools)&&scaffold.tools.length?JSON.stringify(scaffold.tools):null,manifest={scaffold,toolsJson};this.anthropicToolManifestCache.set(key,manifest);
    while(this.anthropicToolManifestCache.size>this.anthropicToolManifestCacheSize)this.anthropicToolManifestCache.delete(this.anthropicToolManifestCache.keys().next().value);
    return manifest;
  }

  #chatToolManifest(request={}){
    const supplied=request?.[NATIVE_TOOL_SCHEMA_FINGERPRINT],fingerprint=/^[a-f0-9]{64}$/i.test(String(supplied||""))?String(supplied).toLowerCase():null;
    if(!fingerprint||this.chatToolManifestCacheSize<=0)return null;
    if(this.chatToolManifestCache.has(fingerprint)){
      const cached=this.chatToolManifestCache.get(fingerprint);this.chatToolManifestCache.delete(fingerprint);this.chatToolManifestCache.set(fingerprint,cached);return cached;
    }
    const tools=providerToolsToChat(request.tools),manifest={tools,toolsJson:JSON.stringify(tools)};this.chatToolManifestCache.set(fingerprint,manifest);
    while(this.chatToolManifestCache.size>this.chatToolManifestCacheSize)this.chatToolManifestCache.delete(this.chatToolManifestCache.keys().next().value);
    return manifest;
  }

  #chatMessageConversionCache(request={}){
    if(!this.reuseChatMessageConversion)return null;
    const identity=request?.[NATIVE_CHAT_MESSAGE_CACHE_IDENTITY];if(!identity||typeof identity!=="object")return null;
    let cache=this.chatMessageConversionCaches.get(identity);if(!cache){cache={messages:new WeakMap(),serialized:new WeakMap()};this.chatMessageConversionCaches.set(identity,cache)}return cache;
  }

  #openAiWebSocketCircuitOpen(){
    if(this.openAiResponsesWebSocketPermanentlyDisabled)return true;
    const now=Number(this.nowFn()),until=Number(this.openAiResponsesWebSocketDisabledUntil||0);if(Number.isFinite(until)&&until>now)return true;
    this.openAiResponsesWebSocketDisabledUntil=0;return false;
  }

  #resetOpenAiWebSocket(reason="reset"){
    const normalized=String(reason||""),transport=this.openAiResponsesWebSocket,transient=["connect_failure","send_failure","transport_failure","timeout_failure"].includes(normalized),protocol=normalized==="protocol_failure";
    if(protocol){this.openAiResponsesWebSocketPermanentlyDisabled=true;this.openAiResponseContinuations.clear()}
    if(transient){
      this.openAiResponsesWebSocketTransientFailures=Math.min(16,Number(this.openAiResponsesWebSocketTransientFailures||0)+1);
      const multiplier=Math.min(16,2**Math.max(0,this.openAiResponsesWebSocketTransientFailures-1)),cooldown=Math.min(300_000,this.openAiResponsesWebSocketRetryMs*multiplier);
      this.openAiResponsesWebSocketDisabledUntil=Math.max(Number(this.openAiResponsesWebSocketDisabledUntil||0),Number(this.nowFn())+cooldown);
    }
    if(transient||protocol){this.openAiResponsesWebSocket=null;try{transport?.close?.()}catch{}}
  }

  #openAiWebSocketTransport(){
    if(this.#openAiWebSocketCircuitOpen())return null;
    if(this.openAiResponsesWebSocket)return this.openAiResponsesWebSocket;
    const key=this.key("openai");if(!key)return null;
    this.openAiResponsesWebSocket=this.openAiResponsesWebSocketFactory({
      apiKey:key,baseUrl:this.get("openai").baseUrl,userAgent:TREBELL_USER_AGENT,
      onReset:event=>this.#resetOpenAiWebSocket(event?.reason||"reset"),
    });
    return this.openAiResponsesWebSocket;
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #save() {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  definitions() {
    return Object.values(MODEL_PROVIDERS).map(({id}) => this.get(id)).map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
      protocolCompatibility: [...(provider.protocolCompatibility || [])],
      requiresKey: provider.requiresKey,
      official: Boolean(provider.official),
      hasKey: provider.requiresKey ? this.hasKey(provider.id) : true,
      capabilities:providerCapabilities(provider.id),
    }));
  }

  get(providerId) {
    const provider=MODEL_PROVIDERS[normalizeProviderId(providerId)];
    return provider.id==="agentrouter"?agentRouterProvider(provider,this.env):provider;
  }

  key(providerId) {
    const provider = this.get(providerId);
    if (!provider.requiresKey) return "";
    const envValue = (provider.envKeys || [provider.envKey]).map(key => this.env[key]).find(Boolean);
    return normalizeProviderKey(this.secrets[provider.id] || envValue || "");
  }

  hasKey(providerId) {
    return Boolean(this.key(providerId));
  }

  setKey(providerId, value) {
    const provider = this.get(providerId);
    if (!provider.requiresKey) throw new Error(`${provider.name} does not use an API key here.`);
    const previousKey=this.key(provider.id),key = normalizeProviderKey(value);
    if (key) this.secrets[provider.id] = key;
    else delete this.secrets[provider.id];
    this.#save();
    if(provider.id==="openai"&&previousKey!==key){try{this.openAiResponsesWebSocket?.close?.()}catch{}this.openAiResponsesWebSocket=null;this.openAiResponsesWebSocketDisabledUntil=0;this.openAiResponsesWebSocketPermanentlyDisabled=false;this.openAiResponsesWebSocketTransientFailures=0;this.openAiResponseContinuations.clear()}
    return { provider: provider.id, hasKey: Boolean(key) };
  }

  close() {
    const transport=this.openAiResponsesWebSocket;
    this.openAiResponsesWebSocket=null;
    this.openAiResponsesWebSocketDisabledUntil=0;
    this.openAiResponsesWebSocketPermanentlyDisabled=false;
    this.openAiResponsesWebSocketTransientFailures=0;
    this.openAiResponseContinuations.clear();
    try{transport?.close?.()}catch{}
  }

  childEnv(providerId, baseEnv = this.env) {
    const provider = this.get(providerId);
    const next = { ...baseEnv };
    if (provider.requiresKey) {
      const key = this.key(provider.id);
      if (key) next[provider.envKey] = key;
      else delete next[provider.envKey];
    }
    return next;
  }

  status(providerId) {
    const provider = this.get(providerId);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
      protocolCompatibility: [...(provider.protocolCompatibility || [])],
      requiresKey: provider.requiresKey,
      official: Boolean(provider.official),
      hasKey: provider.requiresKey ? this.hasKey(provider.id) : true,
      ready: provider.requiresKey ? this.hasKey(provider.id) : true,
      capabilities:providerCapabilities(provider.id),
    };
  }

  async models(providerId) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") return { models: [], source: "freebuff" };
    if (provider.staticModels) {
      return {
        models: [...provider.staticModels],
        source: "static",
        metadata: provider.staticModels.map((id) => ({ id, provider: provider.id, protocolCompatibility: [...(provider.protocolCompatibility || [])] })),
        ...(provider.requiresKey && !this.hasKey(provider.id) ? { error: "API key required" } : {}),
      };
    }
    if (provider.requiresKey && !this.hasKey(provider.id)) {
      return { models: [], source: "none", error: "API key required" };
    }

    const key = this.key(provider.id);
    const response = await this.fetchFn(provider.baseUrl + "/models", {
      headers: provider.id === "agentrouter"
        ? agentRouterHeaders(key,{environment:this.env})
        : provider.authStyle === "anthropic"
          ? {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              Accept: "application/json",
            }
          : {
              Authorization: `Bearer ${key}`,
              Accept: "application/json",
            },
      signal: AbortSignal.timeout(12_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${provider.name} model list failed with HTTP ${response.status}: ${providerErrorExcerpt(raw,{environment:this.env,secret:key,maxChars:500})}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${provider.name} returned invalid JSON from /models`);
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
    const models = [...new Set(rows.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean).map(String))].sort();
    return {
      models,
      source: "live",
      metadata: rows
        .filter((item) => item && typeof item === "object" && item.id)
        .map((item) => {
          const metadata={ ...clone(item), id: String(item.id), provider: provider.id };
          if(metadata.protocolCompatibility==null)metadata.protocolCompatibility=[...(provider.protocolCompatibility||[])];
          return metadata;
        }),
    };
  }

  async forwardChat(providerId, chatBody, { signal, userAgent, onWire, promptCaching=false, anthropicBody=null } = {}) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") throw new Error("Freebuff chat is handled by the local freebuff2api bridge.");
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    if (provider.protocolCompatibility?.includes("anthropic-messages")) {
      const requestBody = anthropicBody||chatToAnthropic(chatBody);
      if(provider.id==="anthropic"&&promptCaching===true)requestBody.cache_control={type:"ephemeral"};
      const endpoint=provider.baseUrl + "/messages",body=this.reusePreSerializedToolJson?stringifyProviderBody(requestBody):JSON.stringify(requestBody);onWire?.({endpoint,wireApi:"anthropic-messages",requestBytes:Buffer.byteLength(body,"utf8")});
      const upstream = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "Accept": requestBody.stream ? "text/event-stream, application/json" : "application/json",
          "User-Agent": TREBELL_USER_AGENT,
        },
        body,
        signal: providerRequestSignal(signal, this.requestTimeoutMs),
      });
      return await adaptAnthropicResponse(upstream, { stream: requestBody.stream, model: requestBody.model });
    }

    const headers = provider.id === "agentrouter"
      ? agentRouterHeaders(key, {
          accept: chatBody.stream ? "text/event-stream, application/json" : "application/json",
          environment:this.env,
        })
      : {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Accept": chatBody.stream ? "text/event-stream, application/json" : "application/json",
          "User-Agent": TREBELL_USER_AGENT,
        };

    const endpoint=provider.baseUrl + "/chat/completions",body=this.reusePreSerializedToolJson?stringifyProviderBody(chatBody):JSON.stringify(chatBody);onWire?.({endpoint,wireApi:"openai-chat-completions",requestBytes:Buffer.byteLength(body,"utf8")});
    return await this.fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: providerRequestSignal(signal, this.requestTimeoutMs),
    });
  }

  async forwardResponses(providerId, responsesBody, { signal, onWire, timeoutMs=this.requestTimeoutMs } = {}) {
    const provider = this.get(providerId);
    if (provider.wireApi !== "responses") {
      throw new Error(`${provider.name} does not use direct Responses forwarding.`);
    }
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    const stream = Boolean(responsesBody?.stream);
    const endpoint=provider.baseUrl + "/responses",body=this.reusePreSerializedToolJson?stringifyProviderBody(responsesBody):JSON.stringify(responsesBody);onWire?.({endpoint,wireApi:"openai-responses",requestBytes:Buffer.byteLength(body,"utf8")});
    return await this.fetchFn(endpoint, {
      method: "POST",
      headers: provider.id === "agentrouter"
        ? agentRouterHeaders(key, {
            accept: stream ? "text/event-stream, application/json" : "application/json",
            environment:this.env,
          })
        : {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: stream ? "text/event-stream, application/json" : "application/json",
            "User-Agent": TREBELL_USER_AGENT,
          },
      body,
      signal: providerRequestSignal(signal, timeoutMs),
    });
  }

  async turn(providerId, request={}, { signal, promptCaching=false, streamResponses=false, streamChat=false } = {}) {
    const provider=this.get(providerId),model=String(request.model||"").trim();
    if(!model)throw new Error("Provider turn requires a model.");
    if(provider.id==="freebuff")throw new Error("Freebuff provider turns are served by the local Freebuff bridge, not ProviderManager.");
    const started=performance.now(),requestDeadlineAt=started+this.requestTimeoutMs;let wire={endpoint:null,wireApi:null,requestBytes:0},wireRequestBytes=0,wireAttempts=0;
    const onWire=value=>{wire=value||wire;wireRequestBytes+=Number(value?.requestBytes||0);wireAttempts++};
    let fullResponsesBody=null,openAiContinuation=null,responsesBody=null;
    if(provider.wireApi==="responses"){
      if(provider.id==="openai"){
        const messageRefs=Array.isArray(request.messages)?request.messages:null,identityToken=request?.[NATIVE_OPENAI_CONTINUATION_IDENTITY]||null,parentId=request.promptCacheComparisonResponseId;
        const preflight=this.reuseOpenAiContinuationInputBuild
          ?this.openAiResponseContinuations.preflight(parentId,{messageRefs,identityToken,model})
          :null;
        if(preflight){
          const suffixBody=this.#officialOpenAiResponsesBody({...request,model},{inputStartMessageIndex:preflight.messageCount});
          openAiContinuation=this.openAiResponseContinuations.prepareSuffix(suffixBody,parentId,{messageRefs,identityToken});
          if(openAiContinuation)responsesBody=openAiContinuation.body;
        }
        if(!responsesBody){
          fullResponsesBody=this.#officialOpenAiResponsesBody({...request,model});
          openAiContinuation=this.openAiResponseContinuations.prepare(fullResponsesBody,parentId,{messageRefs,identityToken});
          responsesBody=openAiContinuation?.body||fullResponsesBody;
        }
      }else{
        fullResponsesBody=providerTurnToResponses({...request,model});
        responsesBody=fullResponsesBody;
      }
    }
    if(provider.id==="openai"&&streamResponses===true&&responsesBody){responsesBody.stream=true;if(fullResponsesBody)fullResponsesBody.stream=true}
    const anthropicScaffold=provider.id==="anthropic"?this.#anthropicToolScaffold({...request,model}):null;
    let anthropicMessageProjector=null;
    if(anthropicScaffold&&this.reuseAnthropicMessageBuild){const identity=request?.[NATIVE_OPENAI_CONTINUATION_IDENTITY];if(identity&&typeof identity==="object"){anthropicMessageProjector=this.anthropicMessageProjectors.get(identity);if(!anthropicMessageProjector){anthropicMessageProjector=createAnthropicMessageProjector();this.anthropicMessageProjectors.set(identity,anthropicMessageProjector)}}}
    const directAnthropicBody=anthropicScaffold?providerTurnToAnthropic({...request,model},{stream:streamChat===true,scaffold:anthropicScaffold.scaffold,messageProjector:anthropicMessageProjector}):null;
    if(this.reusePreSerializedToolJson&&directAnthropicBody?.[ANTHROPIC_PRE_SERIALIZED_MESSAGES])attachPreSerializedTopLevel(directAnthropicBody,"messages",directAnthropicBody.messages,directAnthropicBody[ANTHROPIC_PRE_SERIALIZED_MESSAGES]);
    if(this.reusePreSerializedToolJson&&directAnthropicBody&&anthropicScaffold?.toolsJson&&directAnthropicBody.tools===anthropicScaffold.scaffold.tools)attachPreSerializedTopLevel(directAnthropicBody,"tools",directAnthropicBody.tools,anthropicScaffold.toolsJson);
    const chatManifest=provider.wireApi==="responses"||directAnthropicBody?null:this.#chatToolManifest(request);
    const chatMessageCache=this.#chatMessageConversionCache(request),chatBody=provider.wireApi==="responses"||directAnthropicBody?null:providerTurnToChat({...request,model},{preparedTools:chatManifest?.tools||null,messageCache:chatMessageCache?.messages||null});
    if(streamChat===true&&chatBody){chatBody.stream=true;chatBody.stream_options={include_usage:true}}
    if(chatBody&&chatMessageCache?.serialized){const messagesJson=preSerializedChatMessages(chatBody.messages,chatMessageCache.serialized);if(messagesJson)attachPreSerializedTopLevel(chatBody,"messages",chatBody.messages,messagesJson)}
    if(this.reusePreSerializedToolJson&&chatBody&&chatManifest?.toolsJson&&chatBody.tools===chatManifest.tools)attachPreSerializedTopLevel(chatBody,"tools",chatBody.tools,chatManifest.toolsJson);
    let openAiWebSocketFallback=null,continuationFallback=false;
    const openAiWebSocketStreamId=provider.id==="openai"&&streamResponses===true?openAiResponsesWebSocketStreamId(request?.metadata?.sessionId):null;
    const openAiWebSocketEnabled=Boolean(openAiWebSocketStreamId)&&String(this.env.TREBELL_OPENAI_RESPONSES_WEBSOCKET||"1").trim()!=="0"&&!this.#openAiWebSocketCircuitOpen();
    if(openAiWebSocketEnabled){
      const transport=this.#openAiWebSocketTransport();
      if(transport){
        try{
          const socketSignal=providerRequestSignal(signal,remainingProviderRequestMs(requestDeadlineAt));
          const socketStarted=performance.now(),socketResult=await transport.request(responsesBody,{streamId:openAiWebSocketStreamId,signal:socketSignal}),result=normalizeResponsesTurnResponse(socketResult.response,provider.id,model);
          this.openAiResponsesWebSocketTransientFailures=0;
          this.openAiResponseContinuations.record(result.id,openAiContinuation,result);
          result.telemetry={
            endpoint:String(provider.baseUrl||"").replace(/^http/i,"ws")+"/responses",wireApi:"openai-responses-websocket",requestBytes:Number(socketResult.requestBytes||0),responseBytes:Number(socketResult.telemetry?.responseBytes||0),
            responseHeadersLatencyMs:null,responseBodyLatencyMs:Number(socketResult.telemetry?.totalLatencyMs||0),timeToFirstTokenMs:socketResult.telemetry?.timeToFirstTokenMs??null,totalLatencyMs:Number(socketResult.telemetry?.totalLatencyMs??(performance.now()-socketStarted)),streaming:true,providerRequestId:null,providerResponseId:result.id||null,
            promptCacheDiagnostics:normalizedOpenAiPromptCacheDiagnostics(socketResult.response),reasoningContext:normalizedOpenAiReasoningContext(socketResult.response),persistentConnection:true,responseContinuation:openAiContinuation?{used:Boolean(openAiContinuation.used),attempted:Boolean(openAiContinuation.used),fallback:false,parentId:openAiContinuation.parentId||null,fullInputCount:Number(openAiContinuation.fullInputCount||0),deltaInputCount:Number(openAiContinuation.deltaInputCount||0),savedRequestBytes:Number(openAiContinuation.savedRequestBytes||0),inputBuildReused:Boolean(openAiContinuation.inputBuildReused),canonicalPrefixMessageCount:Number(openAiContinuation.canonicalPrefixMessageCount||0),wireAttempts:1}:null,
          };
          return result;
        }catch(error){
          if(signal?.aborted||error?.name==="AbortError")throw error;
          const failedWire=Number(error?.webSocketTelemetry?.requestBytes||0);if(failedWire>0)wireRequestBytes+=failedWire;wireAttempts++;
          const responseStatus=Number(error?.webSocketEvent?.status||error?.status||error?.statusCode||0),responseMessage=String(error?.webSocketEvent?.error?.message||error?.message||""),failureKind=String(error?.webSocketFailureKind||((error?.name==="TimeoutError")?"timeout":error?.protocolFailure?"protocol":error?.transportFailure?"transport":"unknown")),continuationRejected=Boolean(openAiContinuation?.used)&&[400,404,409].includes(responseStatus),invalidToolOutputRequest=responseStatus===400&&/no tool output found for function call/i.test(responseMessage),replaySafe=error?.replaySafe===true||continuationRejected||invalidToolOutputRequest;
          openAiWebSocketFallback={transportFailure:Boolean(error?.transportFailure),protocolFailure:Boolean(error?.protocolFailure),failureKind,name:error?.name||null,code:error?.code??null,replaySafe,retried:false,requestBytes:failedWire,responseBytes:Number(error?.webSocketTelemetry?.responseBytes||0),timeToFirstTokenMs:error?.webSocketTelemetry?.timeToFirstTokenMs??null};
          if(this.openAiResponsesWebSocket===transport){
            if(error?.transportFailure)this.#resetOpenAiWebSocket("transport_failure");else if(error?.protocolFailure)this.#resetOpenAiWebSocket("protocol_failure");else if(error?.name==="TimeoutError")this.#resetOpenAiWebSocket("timeout_failure");
          }
          if(!replaySafe){
            // A post-send timeout is not safe to replay inside this provider turn,
            // but it is safe for the agent loop to retry as a fresh model attempt:
            // no model tool call is executed until a terminal response is returned.
            // The timeout reset above also opens the socket cooldown, so that fresh
            // attempt naturally uses HTTPS instead of repeating the unhealthy lane.
            error.retryable=error?.retryable===true||Boolean(error?.transportFailure)||error?.name==="TimeoutError";
            error.telemetry={endpoint:String(provider.baseUrl||"").replace(/^http/i,"ws")+"/responses",wireApi:"openai-responses-websocket",requestBytes:failedWire,responseBytes:Number(error?.webSocketTelemetry?.responseBytes||0),timeToFirstTokenMs:error?.webSocketTelemetry?.timeToFirstTokenMs??null,totalLatencyMs:Number((performance.now()-started).toFixed(3)),streaming:true,persistentConnection:true,webSocketFallback:openAiWebSocketFallback};throw error
          }
          try{remainingProviderRequestMs(requestDeadlineAt)}catch{error.retryable=false;error.telemetry={endpoint:String(provider.baseUrl||"").replace(/^http/i,"ws")+"/responses",wireApi:"openai-responses-websocket",requestBytes:failedWire,responseBytes:Number(error?.webSocketTelemetry?.responseBytes||0),timeToFirstTokenMs:error?.webSocketTelemetry?.timeToFirstTokenMs??null,totalLatencyMs:Number((performance.now()-started).toFixed(3)),streaming:true,persistentConnection:true,webSocketFallback:openAiWebSocketFallback};throw error}
          openAiWebSocketFallback.retried=true;
          if(continuationRejected||invalidToolOutputRequest){
            const fallbackBody=this.#officialOpenAiResponsesBody({...request,model,promptCacheComparisonResponseId:""});fallbackBody.stream=true;
            fullResponsesBody=fallbackBody;responsesBody=fallbackBody;continuationFallback=true;
          }
        }
      }
    }
    let upstream=provider.wireApi==="responses"
      ?await this.forwardResponses(provider.id,responsesBody,{signal,onWire,timeoutMs:remainingProviderRequestMs(requestDeadlineAt)})
      :await this.forwardChat(provider.id,chatBody,{signal,onWire,promptCaching,anthropicBody:directAnthropicBody});
    if(provider.id==="openai"&&openAiContinuation?.used&&!upstream.ok&&[400,404,409].includes(Number(upstream.status))){
      try{await upstream.body?.cancel?.()}catch{}
      if(!fullResponsesBody){fullResponsesBody=this.#officialOpenAiResponsesBody({...request,model});if(streamResponses===true)fullResponsesBody.stream=true}
      upstream=await this.forwardResponses(provider.id,fullResponsesBody,{signal,onWire,timeoutMs:remainingProviderRequestMs(requestDeadlineAt)});continuationFallback=true;
    }
    const headersLatencyMs=Number((performance.now()-started).toFixed(3));
    const providerRequestId=upstream.headers?.get?.("x-request-id")||upstream.headers?.get?.("request-id")||upstream.headers?.get?.("x-amzn-requestid")||null;
    const bodyStarted=performance.now();
    const contentType=String(upstream.headers?.get?.("content-type")||"").toLowerCase();
    if(upstream.ok&&provider.id==="openai"&&streamResponses===true&&upstream.body&&contentType.includes("text/event-stream")){
      try{
        const streamed=await readOpenAiResponsesStream(upstream.body,{requestStartedAt:started}),bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        const result=normalizeResponsesTurnResponse(streamed.response,provider.id,model);
        this.openAiResponseContinuations.record(result.id,openAiContinuation,result);
        result.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-responses",requestBytes:wireRequestBytes||Number(wire.requestBytes)||0,responseBytes:streamed.responseBytes,responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:streamed.timeToFirstTokenMs,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:result.id||null,promptCacheDiagnostics:normalizedOpenAiPromptCacheDiagnostics(streamed.response),reasoningContext:normalizedOpenAiReasoningContext(streamed.response),persistentConnection:false,webSocketFallback:openAiWebSocketFallback,responseContinuation:openAiContinuation?{used:Boolean(openAiContinuation.used&&!continuationFallback),attempted:Boolean(openAiContinuation.used),fallback:continuationFallback,parentId:openAiContinuation.parentId||null,fullInputCount:Number(openAiContinuation.fullInputCount||0),deltaInputCount:Number(openAiContinuation.deltaInputCount||0),savedRequestBytes:continuationFallback?0:Number(openAiContinuation.savedRequestBytes||0),inputBuildReused:Boolean(openAiContinuation.inputBuildReused&&!continuationFallback),canonicalPrefixMessageCount:Number(openAiContinuation.canonicalPrefixMessageCount||0),wireAttempts}:null};
        return result;
      }catch(error){
        const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        error.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-responses",requestBytes:wireRequestBytes||Number(wire.requestBytes)||0,responseBytes:Number(error?.streamTelemetry?.responseBytes||0),responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:error?.streamTelemetry?.timeToFirstTokenMs??null,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:null};throw error;
      }
    }
    if(upstream.ok&&streamChat===true&&upstream.body&&contentType.includes("text/event-stream")){
      try{
        const streamed=await readOpenAiChatStream(upstream.body,{requestStartedAt:started}),bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        const result=normalizeChatTurnResponse(streamed.response,provider.id,model);
        result.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-chat-completions",requestBytes:wireRequestBytes||Number(wire.requestBytes)||0,responseBytes:streamed.responseBytes,responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:streamed.timeToFirstTokenMs,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:result.id||null};
        return result;
      }catch(error){
        const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        error.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-chat-completions",requestBytes:wireRequestBytes||Number(wire.requestBytes)||0,responseBytes:Number(error?.streamTelemetry?.responseBytes||0),responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:error?.streamTelemetry?.timeToFirstTokenMs??null,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:null};throw error;
      }
    }
    const raw=await upstream.text();
    const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3));
    const totalLatencyMs=Number((performance.now()-started).toFixed(3));
    const baseTelemetry={
      endpoint:wire.endpoint,
      wireApi:wire.wireApi||provider.protocolCompatibility?.[0]||provider.wireApi,
      requestBytes:wireRequestBytes||Number(wire.requestBytes)||0,
      responseBytes:Buffer.byteLength(raw,"utf8"),
      responseHeadersLatencyMs:headersLatencyMs,
      responseBodyLatencyMs:bodyLatencyMs,
      timeToFirstTokenMs:null,
      totalLatencyMs,
      streaming:false,
      providerRequestId,
      providerResponseId:null,
      ...(provider.id==="openai"?{persistentConnection:false,webSocketFallback:openAiWebSocketFallback}:{}),
    };
    if(!upstream.ok){
      const error=new Error(`${provider.name} HTTP ${upstream.status}: ${providerErrorExcerpt(raw,{environment:this.env,secret:this.key(provider.id),maxChars:1200})}`);
      error.status=upstream.status;
      error.retryable=[408,409,425,429].includes(upstream.status)||(upstream.status>=500&&upstream.status<=599);
      error.telemetry=baseTelemetry;
      throw error;
    }
    let parsed;try{parsed=raw?JSON.parse(raw):{}}catch{
      const error=new Error(`${provider.name} returned invalid JSON for a provider turn.`);error.telemetry=baseTelemetry;throw error;
    }
    const result=provider.wireApi==="responses"
      ?normalizeResponsesTurnResponse(parsed,provider.id,model)
      :normalizeChatTurnResponse(parsed,provider.id,model);
    if(provider.id==="openai")this.openAiResponseContinuations.record(result.id,openAiContinuation,result);
    result.telemetry={
      ...baseTelemetry,
      providerResponseId:result.id||null,
      ...(provider.id==="openai"?{promptCacheDiagnostics:normalizedOpenAiPromptCacheDiagnostics(parsed),reasoningContext:normalizedOpenAiReasoningContext(parsed),responseContinuation:openAiContinuation?{used:Boolean(openAiContinuation.used&&!continuationFallback),attempted:Boolean(openAiContinuation.used),fallback:continuationFallback,parentId:openAiContinuation.parentId||null,fullInputCount:Number(openAiContinuation.fullInputCount||0),deltaInputCount:Number(openAiContinuation.deltaInputCount||0),savedRequestBytes:continuationFallback?0:Number(openAiContinuation.savedRequestBytes||0),inputBuildReused:Boolean(openAiContinuation.inputBuildReused&&!continuationFallback),canonicalPrefixMessageCount:Number(openAiContinuation.canonicalPrefixMessageCount||0),wireAttempts}:null}:{}),
    };
    return result;
  }

  async directChat(providerId, { model, prompt }) {
    const provider = this.get(providerId);
    const result=await this.turn(provider.id,{
      model,
      messages:[{role:"user",content:prompt}],
      tools:[],
      toolChoice:"none",
    });
    return {text:String(result.text||""),model:result.model||model,provider:provider.id,raw:result.raw};
  }
}
