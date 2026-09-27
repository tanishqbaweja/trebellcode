import { TREBELL_USER_AGENT } from "./version.mjs";
import { adaptAnthropicResponse, chatToAnthropic } from "./anthropic-chat-adapter.mjs";
import { normalizeChatTurnResponse, normalizeResponsesTurnResponse, providerTurnToChat, providerTurnToResponses } from "./provider-turn.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { performance } from "node:perf_hooks";
import { providerCapabilities } from "./provider-capabilities.mjs";

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
function officialOpenAiPromptCacheKey(body={}){
  const firstUser=(Array.isArray(body.input)?body.input:[]).find(item=>item?.type==="message"&&item.role==="user")||null;
  const seed=JSON.stringify({
    model:String(body.model||""),
    instructions:String(body.instructions||""),
    tools:Array.isArray(body.tools)?body.tools:[],
    firstUser:firstUser?firstUser.content||[]:[],
  });
  return "trebell-"+createHash("sha256").update(seed).digest("hex").slice(0,32);
}
function officialOpenAiResponsesBody(request={}){
  const body=providerTurnToResponses(request),tools=[];
  for(const entry of Array.isArray(request.tools)?request.tools:[]){
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
  body.tools=tools;
  body.input=(body.input||[]).map(item=>{
    if(item?.type!=="function_call"||!item.namespace)return item;
    const next={...item,name:officialResponsesToolName(item.namespace,item.name)};delete next.namespace;return next;
  });
  body.prompt_cache_key=officialOpenAiPromptCacheKey(body);
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

export class ProviderManager {
  constructor({ env = process.env, fetchFn = fetch, requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
    const timeoutMs = Math.trunc(Number(requestTimeoutMs));
    this.requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.path = providerSecretsPath(env);
    mkdirSync(dirname(this.path), { recursive: true });
    this.secrets = this.#load();
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
    const key = normalizeProviderKey(value);
    if (key) this.secrets[provider.id] = key;
    else delete this.secrets[provider.id];
    this.#save();
    return { provider: provider.id, hasKey: Boolean(key) };
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

  async forwardChat(providerId, chatBody, { signal, userAgent, onWire, promptCaching=false } = {}) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") throw new Error("Freebuff chat is handled by the local freebuff2api bridge.");
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    if (provider.protocolCompatibility?.includes("anthropic-messages")) {
      const anthropicBody = chatToAnthropic(chatBody);
      if(provider.id==="anthropic"&&promptCaching===true)anthropicBody.cache_control={type:"ephemeral"};
      const endpoint=provider.baseUrl + "/messages",body=JSON.stringify(anthropicBody);onWire?.({endpoint,wireApi:"anthropic-messages",requestBytes:Buffer.byteLength(body,"utf8")});
      const upstream = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "Accept": anthropicBody.stream ? "text/event-stream, application/json" : "application/json",
          "User-Agent": TREBELL_USER_AGENT,
        },
        body,
        signal: providerRequestSignal(signal, this.requestTimeoutMs),
      });
      return await adaptAnthropicResponse(upstream, { stream: anthropicBody.stream, model: chatBody.model });
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

    const endpoint=provider.baseUrl + "/chat/completions",body=JSON.stringify(chatBody);onWire?.({endpoint,wireApi:"openai-chat-completions",requestBytes:Buffer.byteLength(body,"utf8")});
    return await this.fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: providerRequestSignal(signal, this.requestTimeoutMs),
    });
  }

  async forwardResponses(providerId, responsesBody, { signal, onWire } = {}) {
    const provider = this.get(providerId);
    if (provider.wireApi !== "responses") {
      throw new Error(`${provider.name} does not use direct Responses forwarding.`);
    }
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    const stream = Boolean(responsesBody?.stream);
    const endpoint=provider.baseUrl + "/responses",body=JSON.stringify(responsesBody);onWire?.({endpoint,wireApi:"openai-responses",requestBytes:Buffer.byteLength(body,"utf8")});
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
      signal: providerRequestSignal(signal, this.requestTimeoutMs),
    });
  }

  async turn(providerId, request={}, { signal, promptCaching=false, streamResponses=false, streamChat=false } = {}) {
    const provider=this.get(providerId),model=String(request.model||"").trim();
    if(!model)throw new Error("Provider turn requires a model.");
    if(provider.id==="freebuff")throw new Error("Freebuff provider turns are served by the local Freebuff bridge, not ProviderManager.");
    const started=performance.now();let wire={endpoint:null,wireApi:null,requestBytes:0};
    const onWire=value=>{wire=value||wire};
    const responsesBody=provider.wireApi==="responses"
      ?(provider.id==="openai"?officialOpenAiResponsesBody({...request,model}):providerTurnToResponses({...request,model}))
      :null;
    if(provider.id==="openai"&&streamResponses===true&&responsesBody)responsesBody.stream=true;
    const chatBody=provider.wireApi==="responses"?null:providerTurnToChat({...request,model});
    if(streamChat===true&&chatBody){chatBody.stream=true;chatBody.stream_options={include_usage:true}}
    const upstream=provider.wireApi==="responses"
      ?await this.forwardResponses(provider.id,responsesBody,{signal,onWire})
      :await this.forwardChat(provider.id,chatBody,{signal,onWire,promptCaching});
    const headersLatencyMs=Number((performance.now()-started).toFixed(3));
    const providerRequestId=upstream.headers?.get?.("x-request-id")||upstream.headers?.get?.("request-id")||upstream.headers?.get?.("x-amzn-requestid")||null;
    const bodyStarted=performance.now();
    const contentType=String(upstream.headers?.get?.("content-type")||"").toLowerCase();
    if(upstream.ok&&provider.id==="openai"&&streamResponses===true&&upstream.body&&contentType.includes("text/event-stream")){
      try{
        const streamed=await readOpenAiResponsesStream(upstream.body,{requestStartedAt:started}),bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        const result=normalizeResponsesTurnResponse(streamed.response,provider.id,model);
        result.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-responses",requestBytes:Number(wire.requestBytes)||0,responseBytes:streamed.responseBytes,responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:streamed.timeToFirstTokenMs,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:result.id||null};
        return result;
      }catch(error){
        const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        error.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-responses",requestBytes:Number(wire.requestBytes)||0,responseBytes:Number(error?.streamTelemetry?.responseBytes||0),responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:error?.streamTelemetry?.timeToFirstTokenMs??null,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:null};throw error;
      }
    }
    if(upstream.ok&&streamChat===true&&upstream.body&&contentType.includes("text/event-stream")){
      try{
        const streamed=await readOpenAiChatStream(upstream.body,{requestStartedAt:started}),bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        const result=normalizeChatTurnResponse(streamed.response,provider.id,model);
        result.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-chat-completions",requestBytes:Number(wire.requestBytes)||0,responseBytes:streamed.responseBytes,responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:streamed.timeToFirstTokenMs,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:result.id||null};
        return result;
      }catch(error){
        const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3)),totalLatencyMs=Number((performance.now()-started).toFixed(3));
        error.telemetry={endpoint:wire.endpoint,wireApi:wire.wireApi||"openai-chat-completions",requestBytes:Number(wire.requestBytes)||0,responseBytes:Number(error?.streamTelemetry?.responseBytes||0),responseHeadersLatencyMs:headersLatencyMs,responseBodyLatencyMs:bodyLatencyMs,timeToFirstTokenMs:error?.streamTelemetry?.timeToFirstTokenMs??null,totalLatencyMs,streaming:true,providerRequestId,providerResponseId:null};throw error;
      }
    }
    const raw=await upstream.text();
    const bodyLatencyMs=Number((performance.now()-bodyStarted).toFixed(3));
    const totalLatencyMs=Number((performance.now()-started).toFixed(3));
    const baseTelemetry={
      endpoint:wire.endpoint,
      wireApi:wire.wireApi||provider.protocolCompatibility?.[0]||provider.wireApi,
      requestBytes:Number(wire.requestBytes)||0,
      responseBytes:Buffer.byteLength(raw,"utf8"),
      responseHeadersLatencyMs:headersLatencyMs,
      responseBodyLatencyMs:bodyLatencyMs,
      timeToFirstTokenMs:null,
      totalLatencyMs,
      streaming:false,
      providerRequestId,
      providerResponseId:null,
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
    result.telemetry={
      ...baseTelemetry,
      providerResponseId:result.id||null,
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
