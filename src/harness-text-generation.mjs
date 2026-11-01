import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AcpClient } from "./acp-client.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { acpStartFailure } from "./acp-start-exit.mjs";
import { acpApplyValue, acpConfigSelect, acpReadOnlyMode } from "./acp-session-config.mjs";
import { withProbeAdvice } from "./agent-runtime-manager.mjs";
import { claudeExplainedApiError, claudeLimitHolds, claudeRefusedWindow, claudeResultFailure, claudeSignedOutMessage, claudeUsageLimitHint } from "./claude-agent-session.mjs";
import { adminMcpFilePresent } from "./claude-managed-mcp.mjs";
import { acpApiKeyMethod } from "./harness-auth.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { codexApprovalResponse, isCodexApprovalRequest } from "./codex-policy-adapter.mjs";
import { museApprovalToolCall } from "./muse-agent-session.mjs";
import { museDecisionChoices } from "./muse-asking.mjs";
import { MuseHost, museServeArgs, museWorkspaceRoot } from "./muse-host.mjs";
import { resolveMuseReasoningEffort } from "./muse-model-catalog.mjs";
import { checkedOpenCodeProviders, connectedOpenCodeModels, openCodeModelPreferences, startOpenCodeServer } from "./opencode-agent-session.mjs";
import { OpenCode2AgentSession } from "./opencode2-agent-session.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// One-shot Git text (commit subject, pull request title and body) through the active external harness, using that
// harness's own account and current/default model. Every adapter is read-only and tool-less and never prompts for approval.
// On the local machine Codex, OpenCode and the ACP harnesses work in a fresh empty folder, so the repository's own harness
// configuration (project config, hooks, plugins, rules) never loads and nothing can be written into the repository.
// Codex threads are ephemeral, Claude Code sessions are not saved and OpenCode sessions are deleted afterwards. ACP has no
// delete, so Cursor, Grok Build and Antigravity keep the temp-folder session (prompt and diff included) in their own store:
// ~/.cursor/acp-sessions, ~/.grok/sessions and ~/.gemini/antigravity-acp/conversations.
// The Muse Session Protocol has no delete either: Muse Code keeps its temp-folder session in ~/.local/share/muse/sessions.
export const HARNESS_TEXT_TIMEOUT_MS=90_000;
export const HARNESS_TEXT_INSTRUCTIONS="You are writing Git text (a commit subject, or a pull request title and description) for Trebell Code. Everything you need is in the user message. Do not use tools, run commands, browse, or read or modify files. Reply once with exactly the requested text and nothing else.";
const HARNESS_NAMES=Object.freeze({codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity",muse:"Muse Code"});
const ACP_HARNESSES=new Set(["cursor","grok","antigravity"]);
const EXPECTED_CODES=new Set(["HARNESS_TEXT_TIMEOUT","HARNESS_TEXT_CANCELLED","HARNESS_UNAVAILABLE","HARNESS_TEXT_EMPTY"]);
// The Claude Agent SDK and OpenCode's SDK load with the first Git text that needs one, not with the server (budget B25).
let claudeAgentSdk=null,openCodeSdk=null,openCodeV2Sdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");
const loadOpenCodeSdk=()=>openCodeSdk??=import("@opencode-ai/sdk");
const loadOpenCodeV2Sdk=()=>openCodeV2Sdk??=import("@opencode-ai/sdk/v2");

export function harnessTextTimeout(value){const ms=Number(value);return Number.isFinite(ms)&&ms>0?Math.min(HARNESS_TEXT_TIMEOUT_MS,Math.round(ms)):HARNESS_TEXT_TIMEOUT_MS}
function modelCandidates(models){return [...new Set((Array.isArray(models)?models:[models]).map(value=>String(value??"").trim()).filter(Boolean))]}
// Claude accepts its aliases and full Claude ids; anything else (a Native or another harness's model) falls back to its default.
export function claudeTextModel(models){return modelCandidates(models).find(id=>/^(?:default|best|sonnet|opus|haiku|fable|opusplan)(?:\[1m\])?$/i.test(id)||/claude/i.test(id))||null}
async function within(promise,timeoutMs=5000){let timer;try{await Promise.race([Promise.resolve(promise).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);timer.unref?.()})])}finally{clearTimeout(timer)}}
// A fresh empty folder for one local request: the prompt is self-contained, so the harness never needs the repository. Registered
// before anything else, its removal runs last (teardown is newest-first), after the harness process tree has stopped.
async function scratchFolder(ctx){
  const path=await mkdtemp(join(tmpdir(),"trebell-git-text-"));
  ctx.defer(()=>rm(path,{recursive:true,force:true,maxRetries:10,retryDelay:100}));ctx.check();
  return path;
}

export function declineCodexServerRequest(message){
  const method=String(message?.method||"");
  if(isCodexApprovalRequest(message))return codexApprovalResponse(message,false);
  if(method==="mcpServer/elicitation/request")return {action:"decline",content:null,_meta:null};
  if(method==="item/tool/requestUserInput")return {answers:{}};
  if(method==="currentTime/read")return {currentTimeAt:Math.floor(Date.now()/1000)};
  throw Object.assign(new Error(`Trebell Git text generation does not service ${method||"this request"}`),{code:-32601});
}
export function denyAcpRequest(method,params={}){
  if(method==="session/request_permission"){
    // Reject once, never reject-always: Grok saves an always answer for the whole project (a remote Git text runs in the repository).
    const options=Array.isArray(params?.options)?params.options:[],reject=options.find(option=>option?.kind==="reject_once");
    return reject?{outcome:{outcome:"selected",optionId:reject.optionId}}:{outcome:{outcome:"cancelled"}};
  }
  if(method==="session/elicitation"||method==="elicitation/create")return {action:"cancel"};
  throw Object.assign(new Error(`Trebell Git text generation is read-only and does not allow ${method}`),{code:/^(?:fs|terminal)\//.test(String(method))?-32000:-32601});
}

async function codexTextModel(client,candidates){
  if(!candidates.length)return null;
  const ids=new Set();let cursor=null;
  try{
    for(let page=0;page<10;page++){
      const result=await client.request("model/list",{includeHidden:true,...(cursor?{cursor}:{})});
      for(const row of result?.data||[])for(const id of [row?.id,row?.model])if(id)ids.add(String(id));
      const next=String(result?.nextCursor||"").trim();if(!next||next===cursor)break;cursor=next;
    }
  }catch{return null}
  return candidates.find(id=>ids.has(id))||null;
}
function codexReplyText(state){
  const written=state.messages.filter(item=>item.text.trim());
  return (written.filter(item=>item.phase==="final_answer").at(-1)||written.filter(item=>item.phase!=="commentary").at(-1)||written.at(-1))?.text||state.deltas;
}
// Thread config for Codex Git text, checked against Codex 0.155.1: notify, hooks (features.codex_hooks is the older name), web search,
// apps, plugins, multi-agent, tool suggestions, image generation, browser and computer use, goals and the shell and image tools are off.
// Each configured MCP server is switched off by name (setting mcp_servers to {} changes nothing); config/read lists them without starting
// them, unlike mcpServerStatus/list. Still offered: request_user_input (answered empty) and the read-only skill list/read tools.
const CODEX_GIT_TEXT_CONFIG=Object.freeze({notify:[],web_search:"disabled","features.hooks":false,"features.codex_hooks":false,"features.apps":false,"features.plugins":false,"features.multi_agent":false,"features.tool_suggest":false,"features.image_generation":false,"features.browser_use":false,"features.computer_use":false,"features.goals":false,"features.shell_tool":false,"features.unified_exec":false,"features.view_image":false});
export function codexGitTextConfig(effective={}){
  const config={...CODEX_GIT_TEXT_CONFIG};
  for(const name of Object.keys(effective?.mcp_servers||{})){
    // Codex only accepts these names, and a dotted override needs one; anything else would stay on, so the request stops instead.
    if(!/^[A-Za-z0-9_-]+$/.test(name))throw new Error(`Codex MCP server '${name}' cannot be switched off for Git text`);
    config[`mcp_servers.${name}.enabled`]=false;
  }
  // features.plugins already removes every plugin; a plugin id a dotted override cannot name relies on that alone.
  for(const id of Object.keys(effective?.plugins||{}))if(/^[A-Za-z0-9_@+-]+$/.test(id))config[`plugins.${id}.enabled`]=false;
  return config;
}
// Codex: an ephemeral (never written to disk) thread on a private app-server with no environment (no shell or file tools), the config
// above, read-only sandbox and never-approve policy. Locally it works in an empty folder so the repository's .codex config and hooks do not
// load; a remote environment's Codex keeps the repository, which is where it runs.
async function codexText(ctx){
  if(typeof ctx.codexAppServer!=="function")throw new Error("Codex app-server is unavailable for Git text generation");
  const cwd=ctx.runtimeManager.remoteIo?.(ctx.cwd,ctx.environmentId)?ctx.cwd:await scratchFolder(ctx);
  const server=await ctx.codexAppServer();ctx.defer(()=>server?.release?.());ctx.check();
  if(!server?.url)throw new Error("Codex app-server did not report a connection URL");
  const state={threadId:null,turnId:null,deltas:"",messages:[],done:false};let settle=null;
  const finished=new Promise((resolve,reject)=>{settle={resolve,reject}});finished.catch(()=>{});
  const onNotification=message=>{
    const params=message?.params||{};if(!state.threadId||params.threadId!==state.threadId)return;
    if(message.method==="item/agentMessage/delta")state.deltas+=String(params.delta||"");
    else if(message.method==="item/completed"&&params.item?.type==="agentMessage")state.messages.push({text:String(params.item.text||""),phase:params.item.phase||null});
    else if(message.method==="error"&&params.willRetry!==true){state.done=true;settle.reject(new Error(params.error?.message||"Codex reported an error"))}
    else if(message.method==="turn/completed"){
      const turn=params.turn||{};state.done=true;
      if(turn.status==="completed")settle.resolve();else settle.reject(new Error(turn.error?.message||(turn.status==="interrupted"?"Codex interrupted the turn":`Codex turn ${String(turn.status||"failed")}`)));
    }
  };
  // A stopped app-server (a crash, or a profile or environment change) fails the request at once instead of waiting out the time limit.
  // After a completed turn state.done is set, so the close during teardown changes nothing.
  const onClose=()=>{if(!state.done){state.done=true;settle.reject(new Error("Codex app-server stopped before it returned the Git text. Try again."))}};
  const client=new CodexAppServerClient(server.url,{clientVersion:ctx.version,timeoutMs:ctx.limit,token:server.token,onNotification,onServerRequest:declineCodexServerRequest,onClose});
  ctx.defer(()=>client.close());
  await client.connect();ctx.check();
  const account=await client.request("account/read",{}).catch(()=>null);ctx.check();
  if(account?.requiresOpenaiAuth&&!account?.account)throw Object.assign(new Error("Codex is not authenticated. Run codex login or use Sign in from Agents & models."),{code:"HARNESS_UNAVAILABLE"});
  const model=await codexTextModel(client,ctx.models);ctx.check();
  const effective=await client.request("config/read",{cwd}).catch(error=>{throw new Error(`Codex could not list its MCP servers to switch them off: ${error?.message||error}`)});ctx.check();
  const config=codexGitTextConfig(effective?.config);
  const started=await client.request("thread/start",{cwd,approvalPolicy:"never",sandbox:"read-only",ephemeral:true,environments:[],config,threadSource:"trebell-git-text",developerInstructions:HARNESS_TEXT_INSTRUCTIONS,...(model?{model}:{})});
  state.threadId=String(started?.thread?.id||"")||null;if(!state.threadId)throw new Error("Codex did not create the Git text thread");
  ctx.defer(()=>client.request("thread/unsubscribe",{threadId:state.threadId}));ctx.check();
  const turn=await client.request("turn/start",{threadId:state.threadId,input:[{type:"text",text:ctx.prompt,textElements:[]}],approvalPolicy:"never",sandboxPolicy:{type:"readOnly",networkAccess:false},environments:[],turnTrigger:"trebell-git-text",...(model?{model}:{})});
  state.turnId=String(turn?.turn?.id||"")||null;
  ctx.defer(()=>state.done||!state.turnId?null:client.request("turn/interrupt",{threadId:state.threadId,turnId:state.turnId}));
  await finished;
  return {text:codexReplyText(state),model:String(started?.model||model||"")||null};
}

// Claude Code: one turn, no built-in or MCP tools, hooks off, every permission denied, no session written to disk.
async function claudeText(ctx){
  const {runtimeManager,instance,environmentId}=ctx,query=ctx.deps.claudeQuery||(await loadClaudeAgentSdk()).query;
  const command=runtimeManager.executable(instance,{environmentId}),spawnProcess=runtimeManager.processSpawner?.(instance,environmentId)||null;
  const cwd=runtimeManager.runtimeCwd?.(ctx.cwd,environmentId)||ctx.cwd,model=claudeTextModel(ctx.models),abortController=new AbortController();
  const abort=()=>abortController.abort();if(ctx.signal.aborted)abort();else ctx.signal.addEventListener("abort",abort,{once:true});
  const env={...runtimeManager.childEnv(instance),CLAUDE_AGENT_SDK_CLIENT_APP:`trebell-code/${ctx.version}`};
  // Next to an administrator's managed-mcp.json Claude Code loads only the managed servers and exits at startup on
  // --strict-mcp-config; a Claude Code started elsewhere reads its own machine's file, so it keeps the flag.
  const managedMcp=!spawnProcess&&await adminMcpFilePresent({exists:ctx.deps.claudeManagedMcpExists});ctx.check();
  const runtime=query({prompt:ctx.prompt,options:{
    cwd,...(model?{model}:{}),
    // A Windows .cmd shim cannot be spawned directly; the SDK runs a native binary or a .js entry itself.
    pathToClaudeCodeExecutable:spawnProcess?command:resolveWindowsCommandShim(command,{allowScripts:true}),
    env,
    tools:[],mcpServers:{},...(managedMcp?{}:{strictMcpConfig:true}),settingSources:["user"],settings:{disableAllHooks:true},
    permissionMode:"dontAsk",canUseTool:async(_toolName,_input,options)=>({behavior:"deny",message:"Trebell Git text generation is read-only and tool-less.",toolUseID:options?.toolUseID}),
    maxTurns:1,persistSession:false,includePartialMessages:false,
    systemPrompt:{type:"preset",preset:"claude_code",append:HARNESS_TEXT_INSTRUCTIONS},
    abortController,...(spawnProcess?{spawnClaudeCodeProcess:spawnProcess}:{}),
  }});
  ctx.defer(()=>{abortController.abort();try{runtime?.close?.()}catch{}});
  let result=null,usedModel=model,streamed="",signedOut=null,explained=null,rateLimited=false,blocked=null;const limits=new Map();
  for await(const message of runtime){
    if(message?.type==="system"&&message.subtype==="init"){usedModel=message.model||usedModel;continue}
    if(message?.type==="rate_limit_event"){const rejected=claudeRefusedWindow(message);if(rejected)limits.set(rejected.rateLimitType||"unknown",rejected);continue}
    // An assistant message that carries an error is the API error the result reports, never the reply; a sign-in failure, a usage
    // limit or an error Claude does not retry (an unknown model) names the failure, as in a Claude thread, until a later reply goes through.
    if(message?.type==="assistant"){if(message.error){if(message.error==="authentication_failed")signedOut=claudeSignedOutMessage(spawnProcess||String(env.CLAUDE_CONFIG_DIR||"")!==String(process.env.CLAUDE_CONFIG_DIR||"")?env.CLAUDE_CONFIG_DIR:"");rateLimited=message.error==="rate_limit";explained=claudeExplainedApiError(message);blocked=claudeRefusedWindow(message);continue}rateLimited=false;explained=null;blocked=null;for(const block of message.message?.content||[])if(block?.type==="text"&&block.text)streamed+=block.text;continue}
    if(message?.type==="result"){result=message;break}
  }
  if(!result)throw new Error("Claude Code ended without a result");
  if(blocked&&!limits.has(blocked.rateLimitType||"unknown"))limits.set(blocked.rateLimitType||"unknown",blocked);
  // The user-facing failure, as a Claude thread turn reports it (CLI diagnostics are never the message).
  const knownCause=signedOut||(claudeLimitHolds(result,rateLimited||limits.size>0)?claudeUsageLimitHint([...limits.values()]):null);
  const failure=claudeResultFailure(result,{knownCause,explainedError:explained});if(failure)throw new Error(failure);
  return {text:String(result.result||streamed||""),model:usedModel||null};
}

function openCodeData(result,label){
  if(result?.error)throw new Error(result.error?.data?.message||result.error?.message||`OpenCode ${label} failed`);
  return result?.data;
}
// OpenCode writes Git text in a regular OpenCode turn, the kind every OpenCode model answers: OpenCode's built-in tools are offered, but
// each needs permission first, and every other tool (MCP servers, plugins) is denied, so OpenCode leaves it out. Trebell refuses every
// permission request and dismisses every question, so nothing runs and the session stays read-only. A tool-less request (no tool
// definitions at all) is never sent: OpenCode Zen's free models refuse it with "OpenCode's free tier can only be used from within
// OpenCode". No `tools` map is sent either: OpenCode would replace these rules with it.
const OPENCODE_BUILTIN_PERMISSIONS=Object.freeze(["read","edit","glob","grep","list","bash","task","external_directory","todowrite","question","webfetch","websearch","lsp","doom_loop","skill"]);
export const OPENCODE_GIT_TEXT_PERMISSION=Object.freeze([{permission:"*",pattern:"*",action:"deny"},...OPENCODE_BUILTIN_PERMISSIONS.map(permission=>({permission,pattern:"*",action:"ask"}))]);
// The reason OpenCode hands the model with a refused tool call (permission.reply's message), so it answers instead of asking again.
export const GIT_TEXT_TOOL_DECLINE="Trebell declined this tool call: Git text is written without tools, and the message already holds the diff and all the context. Answer in one reply that contains only the text that was asked for.";
// Remote OpenCode answers through its ACP server, as remote OpenCode threads do. ACP never asks the client about tools OpenCode allows
// (its default build agent runs bash and edits unasked), so the process starts with this config (OPENCODE_CONFIG_CONTENT works in
// OpenCode 1.x and 2.x), the session switches to its agent before the prompt (without that agent nothing is sent), and the same rules
// apply: built-in tools ask, Trebell's ACP client refuses each request, everything else is denied.
const OPENCODE_GIT_TEXT_AGENT="trebell-git-text";
const OPENCODE_GIT_TEXT_RULES=Object.freeze(Object.fromEntries(OPENCODE_GIT_TEXT_PERMISSION.map(rule=>[rule.permission,rule.action])));
export const OPENCODE_GIT_TEXT_CONFIG=JSON.stringify({permission:{"*":"deny"},agent:{[OPENCODE_GIT_TEXT_AGENT]:{mode:"primary",description:"Trebell Git text",permission:OPENCODE_GIT_TEXT_RULES}}});
// A refusal with a reason goes back to the model and the turn goes on; a plain refusal ends the turn. Past this many refusals the plain
// one is sent, so a model that keeps reaching for tools cannot loop until the timeout.
const OPENCODE_GIT_TEXT_FEEDBACK_REFUSALS=2;
const OPENCODE_EVENTS_READY_MS=3000;
// Refuses every permission request and question of one OpenCode session until stopped. `ready` settles once the event stream is open
// (OpenCode sends server.connected first), so nothing the prompt asks is missed.
function refuseOpenCodeAsks({client,v2Client,directory,sessionId}){
  const controller=new AbortController();let refusals=0,markReady=()=>{};
  const opened=new Promise(resolve=>{markReady=resolve});
  const legacyReject=requestID=>Promise.resolve(client.postSessionIdPermissionsPermissionId?.({path:{id:sessionId,permissionID:requestID},query:{directory},body:{response:"reject"}})).catch(()=>{});
  const task=(async()=>{
    try{
      const events=await client.event.subscribe({query:{directory},signal:controller.signal,sseMaxRetryAttempts:0});
      for await(const event of events.stream){
        markReady();
        const p=event?.properties||{},requestID=String(p.id||"");
        if(String(p.sessionID||"")!==sessionId||!requestID)continue;
        if(event.type==="permission.asked"){
          refusals++;const feedback=refusals<=OPENCODE_GIT_TEXT_FEEDBACK_REFUSALS;
          const replied=await Promise.resolve(v2Client?.permission?.reply?.({requestID,directory,reply:"reject",...(feedback?{message:GIT_TEXT_TOOL_DECLINE}:{})})).then(result=>Boolean(result)&&!result.error,()=>false);
          if(!replied)await legacyReject(requestID);
        }
        else if(event.type==="permission.updated")await legacyReject(requestID);
        else if(event.type==="question.asked")await Promise.resolve(v2Client?.question?.reject?.({requestID,directory})).catch(()=>{});
      }
    }catch{}
    finally{markReady()}
  })();
  return {
    ready:Promise.race([opened,new Promise(resolve=>{const timer=setTimeout(resolve,OPENCODE_EVENTS_READY_MS);timer.unref?.()})]),
    async stop(){controller.abort();await within(task,1500)},
  };
}
async function openCode2Text(ctx){
  const {runtimeManager,instance,environmentId}=ctx,cwd=instance.serverUrl?ctx.cwd:await scratchFolder(ctx),chunks=[];
  const session=new OpenCode2AgentSession({
    command:runtimeManager.executable(instance,{environmentId}),cwd,env:runtimeManager.childEnv(instance,{version:ctx.runtimeStatus?.version||null}),serverUrl:instance.serverUrl||null,
    version:ctx.runtimeStatus?.version||"",permissionMode:"read-only",repositoryMcp:null,
    onUpdate:event=>{const update=event?.update||{};if(update.sessionUpdate==="agent_message_chunk"&&update.content?.type==="text")chunks.push(String(update.content.text||""))},
    onPermission:async()=>"decline",
  });
  ctx.defer(async()=>{
    if(session.client&&session.sessionId)await within(session.client.session.delete({sessionID:session.sessionId}),1500);
    await within(session.close(),1500);
  });
  const requested=ctx.models.find(id=>String(id||"").includes("/"))||null;
  await session.start({model:requested});ctx.check();
  if(session.client&&session.sessionId)await session.client.session.instructions.entry.put({sessionID:session.sessionId,key:"trebell.git_text",value:HARNESS_TEXT_INSTRUCTIONS});
  await session.prompt([{type:"text",text:ctx.prompt}]);ctx.check();
  return {text:chunks.join(""),model:session.model||requested};
}

// OpenCode: one regular turn (see above) in a fresh SDK session, which is deleted afterwards.
async function openCodeText(ctx){
  const {runtimeManager,instance,environmentId}=ctx;
  if(runtimeManager.remoteIo?.(ctx.cwd,environmentId))return acpText(ctx,{args:["acp"],environment:{OPENCODE_CONFIG_CONTENT:OPENCODE_GIT_TEXT_CONFIG},mode:OPENCODE_GIT_TEXT_AGENT,deleteSession:true});
  if(/(?:^|\s)v?2\./i.test(String(ctx.runtimeStatus?.version||"")))return openCode2Text(ctx);
  // Trebell starts its own `opencode serve` in an empty folder, so the repository's .opencode plugins and opencode.json never load (plugin
  // code would run as the user and see the diff). A profile's own server URL keeps the repository as its directory: Trebell does not own
  // that server's working folder, and a local temp path may not exist on its host.
  const createClient=ctx.deps.openCodeClient||(await loadOpenCodeSdk()).createOpencodeClient,createV2Client=ctx.deps.openCodeV2Client||(await loadOpenCodeV2Sdk()).createOpencodeClient;
  const cwd=instance.serverUrl?ctx.cwd:await scratchFolder(ctx),env=runtimeManager.childEnv(instance,{version:ctx.runtimeStatus?.version||null});
  const server=await (ctx.deps.openCodeServer||startOpenCodeServer)({command:runtimeManager.executable(instance,{environmentId}),cwd,env,serverUrl:instance.serverUrl||null});
  ctx.defer(()=>server?.close?.());ctx.check();
  // A server Trebell started with the profile's OPENCODE_SERVER_PASSWORD answers only its clients that send it (startOpenCodeServer).
  const client=createClient({baseUrl:server.url,directory:cwd,headers:server.headers});
  const providers=checkedOpenCodeProviders(openCodeData(await client.provider.list({query:{directory:cwd}}),"provider list"));ctx.check();
  // The thread's model when OpenCode has it; otherwise the model OpenCode itself would pick: configured, then recently used, then a
  // connected provider's default (the recent list is read only for the server Trebell started here).
  let catalog=connectedOpenCodeModels(providers),chosen=ctx.models.find(id=>catalog.models.some(item=>item.id===id))||null;
  if(!chosen){catalog=connectedOpenCodeModels(providers,await openCodeModelPreferences({client,directory:cwd,env,localState:!instance.serverUrl,readText:ctx.deps.openCodeStateReader}));ctx.check();chosen=catalog.preferred||null}
  const entry=catalog.models.find(item=>item.id===chosen)||null;
  const session=openCodeData(await client.session.create({query:{directory:cwd},body:{title:"Trebell Git text",permission:OPENCODE_GIT_TEXT_PERMISSION}}),"session create");
  const sessionId=String(session?.id||"");if(!sessionId)throw new Error("OpenCode did not create the Git text session");
  ctx.defer(async()=>{await within(client.session.abort({path:{id:sessionId},query:{directory:cwd}}),1500);await client.session.delete({path:{id:sessionId},query:{directory:cwd}})});ctx.check();
  const refusals=refuseOpenCodeAsks({client,v2Client:createV2Client({baseUrl:server.url,directory:cwd,headers:server.headers}),directory:cwd,sessionId});
  let result;
  try{
    await refusals.ready;ctx.check();
    result=openCodeData(await client.session.prompt({path:{id:sessionId},query:{directory:cwd},body:{...(entry?{model:{providerID:entry.providerID,modelID:entry.modelID}}:{}),system:HARNESS_TEXT_INSTRUCTIONS,parts:[{type:"text",text:ctx.prompt}]},signal:ctx.signal}),"session prompt");
  }finally{await refusals.stop()}
  const info=result?.info||{};if(info.error)throw new Error(info.error?.data?.message||info.error?.name||"OpenCode model request failed");
  const text=(result?.parts||[]).filter(part=>part?.type==="text"&&!part.synthetic).map(part=>String(part.text||"")).join("");
  return {text,model:chosen||(info.providerID&&info.modelID?`${info.providerID}/${info.modelID}`:null)};
}

// The read-only mode an ACP harness offers (acp-session-config.mjs): Cursor's "ask" (Cursor applies its workspace_readonly sandbox
// only there and auto-approves allowlisted tools in its default agent mode), otherwise ask, read-only or plan, from the agent's modes
// or its mode config option (OpenCode lists its agents only as a config option).
export { acpReadOnlyMode };
// The model ids Trebell used before real model lists mean the harness's current model; Cursor's base ids drop bracketed options.
const ACP_MODEL_ALIASES=Object.freeze({cursor:"cursor-default",grok:"grok-build",antigravity:"antigravity-default"});
function acpTextModel(kind,id){const value=String(id||"").trim();if(!value||value===ACP_MODEL_ALIASES[kind])return null;return kind==="cursor"?value.replace(/\[.*$/,"")||null:value}
// ACP harnesses (Cursor, Grok Build, Antigravity, remote OpenCode): no client filesystem or terminal, every permission request rejected,
// and a read-only mode set before the prompt. Locally the session works in an empty folder, so the repository's .cursor/cli.json
// permissions and rules stay out, nothing can be written into the repository and the session is not listed under it; a remote session
// keeps the repository. Teardown cancels a prompt still running, deletes the session where the harness can (remote OpenCode), closes it
// and stops the process tree. ACP itself has no delete: Cursor, Grok Build and Antigravity keep the temp-folder session in their own store.
// Modes and models are read and changed through the agent's config options when it has them.
async function acpText(ctx,{args=null,environment=null,mode=null,deleteSession=false}={}){
  const {runtimeManager,instance,environmentId}=ctx;
  const command=runtimeManager.executable(instance,{environmentId}),spawner=runtimeManager.processSpawner?.(instance,environmentId)||null;
  const remote=Boolean(runtimeManager.remoteIo?.(ctx.cwd,environmentId));
  const cwd=remote?(runtimeManager.runtimeCwd?.(ctx.cwd,environmentId)||ctx.cwd):await scratchFolder(ctx);
  const processCwd=instance.kind==="antigravity"&&!remote&&command?dirname(command):null;
  // Explicit variables reach a remote process through its spawner and a local one through its environment.
  const spawnProcess=spawner&&environment?options=>spawner({...options,environment}):spawner;
  const env={...runtimeManager.childEnv(instance),...(!spawner&&environment?environment:{})};
  let sessionId=null,text="",prompting=false,deleteViaAcp=false;
  // A local Antigravity unpacks its bundle into a Trebell-owned temp folder that is removed once the process has stopped.
  const client=new AcpClient({command,args:args||runtimeManager.acpArgs(instance,"read-only",cwd),cwd:processCwd||cwd,env,spawnProcess,runTempRoot:instance.kind==="antigravity"&&!spawner?acpRuntimeTempRoot(env,"antigravity"):null,onRequest:(method,params)=>denyAcpRequest(method,params)});
  // Without an ACP delete (OpenCode 1.x) the harness CLI deletes the session once the ACP process has stopped and cannot write it again.
  if(deleteSession)ctx.defer(()=>sessionId&&!deleteViaAcp?runtimeManager.runCli?.(instance,["session","delete",sessionId],{environmentId,timeoutMs:15_000}):null);
  ctx.defer(async()=>{
    if(sessionId&&prompting)try{client.cancel(sessionId)}catch{}
    if(sessionId&&deleteViaAcp)await within(Promise.resolve().then(()=>client.request("session/delete",{sessionId},2000)),2500);
    if(sessionId)await within(Promise.resolve().then(()=>client.closeSession(sessionId,{timeoutMs:2000})),2500);
    await client.stop();
  });
  client.on("sessionUpdate",params=>{
    const update=params?.update||{};if(!sessionId||params?.sessionId!==sessionId)return;
    if(update.sessionUpdate==="agent_message_chunk"&&update.content?.type==="text")text+=String(update.content.text||"");
  });
  // A harness whose process ends as it starts says so in plain words, as a chat's message does (acp-start-exit.mjs): not the client's
  // "ACP runtime exited code=3 signal=null" with a sign-in link the message hides.
  const starting=async step=>{try{return await step()}catch(error){throw acpStartFailure(instance.kind,ctx.name,error,env)}};
  await starting(()=>client.start());ctx.check();
  // Cursor lists its base model ids (the ids in Trebell's model list) only to a client with the parameterized model picker.
  const capabilities={fs:{readTextFile:false,writeTextFile:false},terminal:false,...(instance.kind==="cursor"?{_meta:{parameterizedModelPicker:true}}:{})};
  const initialized=await starting(()=>client.initialize({version:ctx.version,capabilities,timeoutMs:ctx.remaining()}));ctx.check();
  // A Grok on its API key signs in with its key method before the session, as a chat of it does (acpApiKeyMethod): a login it
  // cached itself never writes the Git text. A process that ends as it signs in ended as it started too, and says so as above.
  const keyMethod=acpApiKeyMethod({runtime:instance.kind,authMethod:runtimeManager.authMethod?.(instance),env,initializeResult:initialized});
  if(keyMethod){
    await starting(async()=>{
      try{await client.authenticate(keyMethod,{timeoutMs:ctx.remaining()})}
      catch(failure){throw new Error(`${ctx.name} could not sign in with '${keyMethod}': ${failure?.message||failure}`,{cause:failure})}
    });
    ctx.check();
  }
  deleteViaAcp=Boolean(deleteSession&&initialized?.agentCapabilities?.sessionCapabilities?.delete);
  let setup=await starting(()=>client.createSession({cwd,mcpServers:[]}));
  sessionId=String(setup?.sessionId||"")||null;if(!sessionId)throw new Error(`${ctx.name} did not create the Git text session`);ctx.check();
  // Setting the read-only mode and the model are the start's last steps (Cursor gets a model on every request): a process that ends at
  // either ended as it started too, and says so as above; any other failure says which step failed.
  const configStep=(apply,failed)=>starting(async()=>{try{return await apply()}catch(error){throw new Error(failed(error),{cause:error})}});
  // A required mode (Cursor's ask, the restricted OpenCode agent) is never skipped: without it the prompt is not sent.
  const modes=acpConfigSelect(setup,"mode");
  const target=mode?(modes.choices.some(choice=>choice.value===mode)?mode:null):acpReadOnlyMode(instance.kind,setup),required=Boolean(mode)||instance.kind==="cursor";
  if(required&&!target)throw new Error(`${ctx.name} did not offer ${mode?`its restricted ${mode} agent`:"its read-only ask mode"}, so the Git text prompt was not sent`);
  if(target&&modes.current!==target){
    setup=await configStep(()=>acpApplyValue(client,sessionId,setup,"mode",target),()=>`${ctx.name} could not switch to its read-only ${target} mode, so the Git text prompt was not sent`);
    ctx.check();
  }
  // The thread's model when the harness offers it. Cursor saves its model globally, so it always gets an explicit one (Auto when
  // the thread's is not offered); the others otherwise keep their current model.
  const models=acpConfigSelect(setup,"model"),offeredModel=id=>Boolean(id)&&models.choices.some(choice=>choice.value===id);
  const chosen=ctx.models.map(id=>acpTextModel(instance.kind,id)).find(offeredModel)||(instance.kind==="cursor"&&offeredModel("default")?"default":null);
  if(chosen&&(chosen!==models.current||instance.kind==="cursor")){
    setup=await configStep(()=>acpApplyValue(client,sessionId,setup,"model",chosen),error=>`${ctx.name} could not switch to model ${chosen}: ${error?.message||error}`);
    ctx.check();
  }
  prompting=true;
  const result=await client.prompt(sessionId,[{type:"text",text:HARNESS_TEXT_INSTRUCTIONS+"\n\n"+ctx.prompt}]);prompting=false;
  const stopReason=String(result?.stopReason||"end_turn");
  if(stopReason==="refusal")throw new Error(`${ctx.name} declined to write the Git text`);
  if(stopReason==="cancelled")throw new Error(`${ctx.name} cancelled the Git text request`);
  return {text,model:chosen||models.current||null};
}

// Git text through Muse Code. Trebell starts its own `muse serve --disable-shell --disable-write` in an empty temp folder (a host
// without a shell, without file writes and without trust in any workspace's skills or rules), opens a new session whose policy
// denies whatever it does not allow (denyUnmatched), and runs one turn on the thread's model when Muse lists it (else the
// catalog's default row, else Muse's own) at Low Thinking. Muse's session log stays on: Muse reads a turn's events, its end
// included, back from it. The request fails on whatever keeps the answer from arriving whole: an approval or a question Muse
// raises anyway (Trebell turns it down), a gap in the events, a frame Trebell cannot read, the connection closing, the host exiting.
const museWords=value=>String(value??"").trim();
// Revisions only go up: a copy replaces the kept one when its revision is higher, and one without a numeric revision counts as 0.
const museRevision=item=>{const value=Number(item?.revision);return Number.isFinite(value)?value:0};

// The model and Thinking level of the turn: the first of the thread's models the catalog lists, else the catalog's default row,
// else none (Muse's own model); Low where that model offers it, the model's own rule otherwise.
function museGitTextModel(catalog,candidates){
  const offered=id=>Array.isArray(catalog?.models)&&catalog.models.includes(id);
  const modelId=candidates.find(offered)||catalog?.preferred||null;
  const row=modelId&&Array.isArray(catalog?.metadata)?catalog.metadata.find(entry=>entry?.id===modelId):null;
  return {modelId,effort:resolveMuseReasoningEffort(row||null,"low")};
}

// The turn as Muse reports it: its agent replies, each at its highest revision and in the order Muse first showed them, and what
// its end makes of them.
class MuseGitTextTurn{
  constructor(sessionId,turnId){this.sessionId=sessionId;this.turnId=turnId;this.replies=new Map()}
  // A whole item (item/started, item/updated, item/completed): kept when it is one of this turn's agent replies and newer than
  // the copy kept so far. Muse's other kinds and other turns' replies are not the answer.
  note(item){
    if(item?.kind!=="agentMessage"||!item.itemId||item.turnId!==this.turnId)return;
    const kept=this.replies.get(item.itemId);
    if(!kept||museRevision(item)>museRevision(kept))this.replies.set(item.itemId,item);
  }
  // The last reply Muse still stands by (not retracted) is the answer; the ones before it are commentary.
  answer(){
    let last=null;
    for(const reply of this.replies.values())if(!reply.retracted)last=reply;
    return last;
  }
  // turn/start's acknowledgement names the turn Muse runs the request in: this one, or none at all.
  owns(ack){return !ack?.turnId||ack.turnId===this.turnId}
  // What turn/completed means for the request: {text} when the turn completed with a whole reply (or none), else {error}.
  end(params){
    const terminal=museWords(params.terminal);
    if(terminal!=="completed")return {error:museTurnFailure(terminal,params)};
    const reply=this.answer();
    if(reply?.truncated)return {error:new Error("Muse Code cut its reply short, so Trebell did not use it. Try again.")};
    return {text:String(reply?.text??"")};
  }
}

// Why a turn that did not complete left no answer. A signed-out Muse says how to sign in (signedOut: the caller's recheck then adds
// no advice of its own); any other end gives Muse's own words, the failure's message before the turn's reason, else the terminal.
function museTurnFailure(terminal,{error,reason}){
  const {kind,message}=Object(error);
  if(kind==="authRequired")return Object.assign(new Error("Muse Code is signed out. Sign in with muse login, then try again."),{signedOut:true});
  const words=[message,reason].map(museWords).find(Boolean);
  if(words)return new Error(words);
  if(terminal==="cancelled")return new Error("Muse Code cancelled the Git text request.");
  return new Error(`Muse Code ended the turn ${terminal||"without an answer"}.`);
}

// The asks Muse may raise during the turn, each both as a notification and as a server request. Trebell answers each once (an
// approval declined with Muse's own denied choice, never one that saves a rule; a question cancelled) and the request fails.
const MUSE_GIT_TEXT_ASKS=Object.freeze({
  approval:{
    idOf:ask=>ask.approvalId,
    answer(connection,sessionId,id,ask){
      const decline=museDecisionChoices(ask.availableChoices).get("decline");
      if(!decline)return null;
      return connection.command("approval/decide",{sessionId,approvalId:id,requirementId:ask.currentRequirementId,choiceId:decline.choiceId},{maxAttempts:1});
    },
    reason:ask=>`Muse Code asked for permission (${museApprovalToolCall(ask).title}) while writing the Git text, and Trebell declined it: Git text generation is read-only and tool-less.`,
  },
  question:{
    idOf:ask=>ask.userInputId,
    answer:(connection,sessionId,id)=>connection.command("userInput/cancel",{sessionId,userInputId:id,reason:"Trebell Git text generation cannot ask the user. Reply with exactly the requested text."},{maxAttempts:1}),
    reason:()=>"Muse Code asked a question while writing the Git text, and Trebell cancelled it: Git text generation cannot ask the user.",
  },
});
// The asks Muse sends as server requests, by method (a Map, so a method named like a key every object has is no ask).
const MUSE_ASK_REQUESTS=new Map([["approval/request","approval"],["userInput/request","question"]]);
// The answer to a server request Trebell does not serve, as MSP spells an unknown method.
const museUnknownMethod=(sdk,method)=>new sdk.MspError({data:{kind:"methodNotFound",retryable:false},code:-32601,message:`method not found: ${method}`});

// The request's one outcome: the first answer or failure stands, and a failure nobody waits for any more is dropped. failed only
// ever rejects (with that failure), for the steps that wait on Muse before the turn.
function museOutcome(){
  let succeed,reject;
  const settled=new Promise((resolve,fail)=>{succeed=resolve;reject=fail});
  const failed=settled.then(()=>new Promise(()=>{}));
  settled.catch(()=>{});failed.catch(()=>{});
  return {settled,failed,succeed,fail:reason=>reject(reason instanceof Error?reason:new Error(String(reason)))};
}
// What a promise gives within ms, else null (a rejection gives null too).
async function museSettledWithin(promise,ms){
  let timer;
  const late=new Promise(resolve=>{timer=setTimeout(resolve,ms,null);timer.unref?.()});
  try{return await Promise.race([Promise.resolve(promise).catch(()=>null),late])}finally{clearTimeout(timer)}
}

// The host for one request, started: Muse's read-only serve in the request's own folder, with the profile's environment and
// sign-in (so a key the profile did not approve never reaches Muse), asking for no session MCP servers. Its close joins the
// request's teardown the moment the host exists, so a stop while it starts still closes it. A test hands in its own host maker.
async function museStartedGitTextHost(ctx,folder){
  const {runtimeManager:manager,instance,environmentId}=ctx;
  const options={
    cwd:folder,
    args:museServeArgs("read-only"),
    command:manager.executable(instance,{environmentId}),
    authMethod:manager.authMethod?.(instance)||"sign-in",
    env:manager.childEnv(instance),
  };
  const host=ctx.deps.museHost?ctx.deps.museHost(options):new MuseHost(options);
  ctx.defer(()=>host.close());
  await host.start({requestedCapabilities:[],version:ctx.version});
  return host;
}

// Reads what Muse sends during the request against the turn: replies and the turn's end (the answer or Muse's failure), asks
// (each turned down once), gaps, frames Trebell cannot read, and the connection or the host going away. Each settles the outcome.
function followMuseGitText(host,turn,outcome){
  const connection=host.connection,turnedDown={approval:new Set(),question:new Set()};
  // Muse hears Trebell's answer first; then the request fails with the reason.
  const turnDown=(kind,ask)=>{
    if(ask?.sessionId!==turn.sessionId)return;
    const rule=MUSE_GIT_TEXT_ASKS[kind],id=museWords(rule.idOf(ask));
    if(!id||turnedDown[kind].has(id))return;
    turnedDown[kind].add(id);
    try{rule.answer(connection,turn.sessionId,id,ask)?.catch?.(()=>{})}catch{}
    outcome.fail(rule.reason(ask));
  };
  const keep=params=>turn.note(params.item);
  const notices=new Map([
    ["item/started",keep],["item/updated",keep],["item/completed",keep],
    ["turn/completed",params=>{
      if(params.turnId!==turn.turnId)return;
      const ending=turn.end(params);
      if(ending.error)outcome.fail(ending.error);else outcome.succeed(ending.text);
    }],
    ["view/gap",()=>outcome.fail("Muse Code dropped part of its reply before it reached Trebell. Try again.")],
    ["approval/requested",params=>turnDown("approval",params)],
    ["userInput/requested",params=>turnDown("question",params)],
  ]);
  // Only this session's notifications count.
  connection.onNotification(frame=>{
    const params=frame?.params;
    if(params?.sessionId===turn.sessionId)notices.get(museWords(frame.method))?.(params);
  });
  // A server request gets its receipt once Trebell has turned the ask down; any other request is refused as unknown.
  connection.onServerRequest(async request=>{
    const kind=MUSE_ASK_REQUESTS.get(request?.method);
    if(!kind)throw museUnknownMethod(host.sdk,request?.method);
    turnDown(kind,request.params||{});
    return {};
  });
  connection.onProtocolError(error=>outcome.fail(`Muse Code sent a frame Trebell could not read: ${error?.message||error}`));
  // When the connection drops, Muse's exit explains it if the exit comes within 2 s: its exit code and its last line.
  const dropped=async()=>{
    const exit=await museSettledWithin(host.exited,2000);
    outcome.fail(exit?host.exitMessage(exit):"Muse Code closed its connection to Trebell before it returned the Git text. Try again.");
  };
  connection.closed.then(dropped,dropped);
  host.exited.then(exit=>outcome.fail(host.exitMessage(exit)));
}

// session/start, tried once: a fresh session of Trebell's minting in the request's folder on Meta's models, whose policy denies
// whatever it does not allow, on the chosen model when there is one (else Muse's own).
function museOpenGitTextSession(connection,turn,{workspaceRoot,modelId}){
  const params={sessionId:turn.sessionId,providerId:"meta",approvalMode:"denyUnmatched",workspaceRoot};
  if(modelId)params.modelId=modelId;
  return connection.command("session/start",params,{maxAttempts:1});
}
// turn/start under the turn's own id (Muse names a fresh turn after its command id): one text part, Trebell's instructions and
// then the prompt, at the chosen Thinking level when there is one. Its acknowledgement is not waited for, since Muse may end the
// turn before it or never send one, and the turn's end settles the request; one for another turn, or Muse refusing the start,
// fails it.
function museStartGitTextTurn(connection,turn,{prompt,effort},outcome){
  const params={sessionId:turn.sessionId,input:[{type:"text",text:`${HARNESS_TEXT_INSTRUCTIONS}\n\n${prompt}`}]};
  if(effort)params.reasoningEffort=effort;
  connection.command("turn/start",params,{commandId:turn.turnId}).then(ack=>{
    if(!turn.owns(ack))outcome.fail("Muse Code took the Git text request into another turn than the one Trebell started.");
  },outcome.fail);
}

// The Muse Code adapter: the request's folder, model and host, then one session and one turn, read through to the outcome.
async function museText(ctx){
  const folder=await scratchFolder(ctx);
  // Muse wants the root spelled as the disk spells it (it refuses another letter case).
  const workspaceRoot=await museWorkspaceRoot(folder,{verbatim:false});ctx.check();
  const {modelId,effort}=museGitTextModel(ctx.runtimeManager.museModelCatalog?.(ctx.instance)||null,ctx.models);
  const host=await museStartedGitTextHost(ctx,folder);ctx.check();
  const {connection}=host,outcome=museOutcome();
  const turn=new MuseGitTextTurn(connection.mintCommandId(),connection.mintCommandId());
  followMuseGitText(host,turn,outcome);
  // The session's answer is awaited unless the request fails first (a frame Trebell cannot read, Muse exiting).
  const opening=museOpenGitTextSession(connection,turn,{workspaceRoot,modelId});
  opening.catch(()=>{});
  const session=(await Promise.race([opening,outcome.failed]))?.session;ctx.check();
  museStartGitTextTurn(connection,turn,{prompt:ctx.prompt,effort},outcome);
  // The model Muse says the session runs, else the one Trebell asked for.
  const model=museWords(session?.modelId)||modelId;
  return {text:await outcome.settled,model};
}

export async function generateTextWithHarness({runtimeManager,instance=null,prompt,cwd=process.cwd(),environmentId=undefined,models=[],timeoutMs=HARNESS_TEXT_TIMEOUT_MS,version="0.0.0",codexAppServer=null,signal=null,deps={}}={}){
  const target=instance||runtimeManager?.activeInstance?.()||null,kind=String(target?.kind||"").trim();
  if(!kind||kind==="native")throw new Error("Trebell Native writes Git text with its model provider; harness text generation needs an external harness.");
  const definition=runtimeManager?.definitions?.().find(item=>item.id===kind)||null,name=definition?.name||HARNESS_NAMES[kind]||kind;
  const adapter=kind==="codex"?codexText:kind==="claude"?claudeText:kind==="opencode"?openCodeText:kind==="muse"?museText:ACP_HARNESSES.has(kind)||definition?.protocol==="acp"?acpText:null;
  if(!adapter)throw new Error(`${name} cannot write Git text in Trebell Code`);
  const text=String(prompt??"");if(!text.trim())throw new Error("A Git text prompt is required");
  const limit=harnessTextTimeout(timeoutMs),startedAt=Date.now(),controller=new AbortController(),cleanups=[];let closed=false,timer=null,onAbort=null;
  const defer=fn=>{if(typeof fn!=="function")return;if(closed)void within(Promise.resolve().then(fn));else cleanups.push(fn)};
  const check=()=>{if(controller.signal.aborted)throw controller.signal.reason||new Error("Git text generation stopped")};
  const stopped=new Promise((_,reject)=>{
    const stop=error=>{if(!controller.signal.aborted)controller.abort(error);reject(error)};
    const seconds=Math.max(1,Math.round(limit/1000));
    timer=setTimeout(()=>stop(Object.assign(new Error(`${name} did not return the Git text within ${seconds} second${seconds===1?"":"s"}. Try again, or choose a faster ${name} model.`),{code:"HARNESS_TEXT_TIMEOUT"})),limit);
    onAbort=()=>stop(Object.assign(new Error("Git text generation was cancelled."),{name:"AbortError",code:"HARNESS_TEXT_CANCELLED"}));
    if(signal?.aborted)onAbort();else signal?.addEventListener?.("abort",onAbort,{once:true});
  });
  stopped.catch(()=>{});
  const context={runtimeManager,instance:target,kind,name,prompt:text,cwd,environmentId,models:modelCandidates(models),version,codexAppServer,deps:deps||{},signal:controller.signal,limit,remaining:()=>Math.max(1000,limit-(Date.now()-startedAt)),defer,check};
  const running=(async()=>{
    if(kind!=="codex"&&typeof runtimeManager?.probe==="function"){
      const status=await runtimeManager.probe(target,{environmentId});context.runtimeStatus=status;check();
      if(!status?.available)throw Object.assign(new Error(status?.message||`${name} is unavailable`),{code:"HARNESS_UNAVAILABLE"});
    }
    // A profile on an API key writes Git text only with its key, whatever status was kept from before the key went (keyRefusal).
    const keyRefused=runtimeManager?.keyRefusal?.(target,environmentId);
    if(keyRefused)throw Object.assign(new Error(keyRefused.message),{code:"HARNESS_UNAVAILABLE"});
    return adapter(context);
  })();
  running.catch(()=>{});
  try{
    const result=await Promise.race([running,stopped]);
    const reply=String(result?.text||"").trim();
    if(!reply)throw Object.assign(new Error(`${name} returned an empty reply. Try again.`),{code:"HARNESS_TEXT_EMPTY"});
    return {text:reply,model:result?.model||null,runtime:kind,name};
  }catch(error){
    if(EXPECTED_CODES.has(error?.code))throw error;
    // A harness that failed is asked again once, as the relay asks after a failed session (AgentRuntimeManager.recheck): the probe
    // answer it started on is kept for a minute and may be one it no longer gives (a sign-out outside Trebell). The next poll reads
    // what the check finds, and an answer that the harness cannot run or is not signed in adds its advice after the harness's words,
    // unless those words already say it is signed out and how to sign in (signedOut, Muse Code's).
    const status=kind!=="codex"&&typeof runtimeManager?.recheck==="function"?await runtimeManager.recheck(target,{environmentId}).catch(()=>null):null;
    const said=String(error?.message||error||"unknown error").trim().slice(0,1500),detail=error?.signedOut===true?said:withProbeAdvice(said,status);
    throw Object.assign(new Error(`${name} could not write the Git text: ${detail}`),{code:"HARNESS_TEXT_FAILED",cause:error});
  }finally{
    closed=true;clearTimeout(timer);signal?.removeEventListener?.("abort",onAbort);
    // Teardown runs newest-first; the reply waits briefly for it so a hung harness cannot hold the error past the limit.
    const teardown=(async()=>{for(const cleanup of cleanups.splice(0).reverse())await within(Promise.resolve().then(cleanup))})();
    await within(teardown,3000);
  }
}
