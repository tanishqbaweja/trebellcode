import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, statfsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir, loadavg, homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { attachCodexRelay, probeCodexReady, waitForCodexReady } from "./codex-relay.mjs";
import {
  environmentWorkspaceDiff,
  environmentWorkspaceEditorFile,
  environmentWorkspaceEditorSave,
  environmentWorkspaceFile,
  environmentWorkspacePath,
  environmentWorkspaceSearch,
  environmentWorkspaceTree,
  localWorkspaceFileInfo,
} from "./workspace.mjs";
import { spawn } from "node:child_process";
import { codexBin, codexHome, packageRoot, trebellHome } from "./paths.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { CheckpointService } from "./checkpoint-service.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { EnvironmentManager, remoteTransportEnvironment } from "./environment-manager.mjs";
import { interactiveTerminalCommand } from "./terminal-command.mjs";
import { startRemoteAppServer } from "./environment-app-server.mjs";
import { DEFAULT_MODEL_PROVIDER, MODEL_PROVIDERS, ProviderManager, normalizeProviderId } from "./provider-manager.mjs";
import { isRetiredProviderModel, removeRetiredProviderData } from "./legacy-provider-migration.mjs";
import { modelContextWindowFromMetadata, modelContextWindowKey } from "./model-context-window.mjs";
import { withNormalizedModelCapabilities } from "./model-capabilities.mjs";
import { AgentRuntimeManager, normalizeAgentRuntime } from "./agent-runtime-manager.mjs";
import { ANTIGRAVITY_API_KEY_METHOD, saveAntigravityApiKey, signInAntigravityProfile } from "./antigravity-auth.mjs";
import { AgentThreadStore } from "./agent-thread-store.mjs";
import { importClaudeHistory, publicHistoryCandidate, scanLocalAgentHistory } from "./agent-history-import.mjs";
import { agentPermissionModeFromStart, attachAgentRelay } from "./agent-relay.mjs";
import { NATIVE_REPLY_STREAM } from "./native-agent-session.mjs";
import { nativeStreamOptions } from "./native-reply-streaming.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { codexAppServerToken, codexUpstreamToken } from "./codex-app-server-auth.mjs";
import { extendConnectAttemptTimeout } from "./connect-attempt-timeout.mjs";
import { listLicenses, licenseDetail } from "./license-service.mjs";
import { WorktreeCleanupService } from "./worktree-cleanup.mjs";
import { StorageCleanupService } from "./storage-cleanup-service.mjs";
import { ensureDocumentText, extractedDocumentText } from "./document-text.mjs";
import { sweepAutoPullProjects } from "./auto-pull-service.mjs";
import { CloneJobService } from "./clone-job-service.mjs";
import { prepareCodexHome, resolveCodexHomeLayout } from "./codex-home-layout.mjs";
import { localHomePath } from "./local-home-path.mjs";
import { boundDiagnosticText } from "./diagnostic-bounds.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { createNativeSourceControlExecutor, sourceControlEnvironmentKeys } from "./native-source-control.mjs";
import { offlineE2eClaudeCapabilities, offlineE2eDiscoveryRun, offlineE2eHarnessRun, offlineE2eSourceControlExecutor } from "./offline-e2e-host.mjs";
import { ContextEngine, createRemoteContextIo } from "./context-engine.mjs";
import { repositoryContextDeliveryPacket } from "./context-provenance.mjs";
import { RepositoryKnowledgeService } from "./repository-knowledge-service.mjs";
import { REPOSITORY_TOOL_DEFINITIONS, invokeRepositoryTool, parseRepositoryToolArguments, repositoryDynamicToolNamespace, repositoryToolHandlers } from "./repository-tool-catalog.mjs";
import { EventJournal, NOISY_METHOD } from "./event-journal.mjs";
import { enrichGoal, goalAdditionalContext, goalBudgetGate, normalizeGoal } from "./goal-state.mjs";
import { preferredCodexDefaultModel, withConfiguredCodexServiceTier } from "./codex-model-catalog.mjs";
import { codexGoalRecord, codexGoalSetParams, codexGoalStatus } from "./codex-goal.mjs";
import { recordCodexBudgetEvidence, recordCodexChildAgentEvidence } from "./codex-budget-evidence.mjs";
import { recordCodexRecoveryItemEvidence, staleCodexRecoveryState } from "./codex-recovery-evidence.mjs";
import { withCodexContextPieces } from "./codex-additional-context.mjs";
import { createCodexTurnUsage } from "./codex-turn-usage.mjs";
import { continuityAdditionalContext, continuitySnapshot, normalizeContinuityNotes } from "./continuity-state.mjs";
import { verificationRepairAttempt, verificationRepairChainState, verificationRepairContext, verificationRepairPrompt, verificationRepairState } from "./verification-repair.mjs";
import { collectVerificationEvidence } from "./verification-evidence-collector.mjs";
import { runAutomaticVerificationEvidence } from "./verification-auto-runner.mjs";
import { mergeVerificationEvidence } from "./verification-loop.mjs";
import { verificationContinuationAttempt, verificationContinuationChainState, verificationContinuationContext, verificationContinuationPrompt, verificationContinuationState } from "./verification-continuation.mjs";
import { verificationAutomationAttempt, verificationAutomationChainState } from "./verification-automation.mjs";
import { normalizeBrowserVerificationReceipt } from "./browser-verification-evidence.mjs";
import { delegationContextValue, delegationGoalPatch, delegationPolicies } from "./delegation-state.mjs";
import { executeDelegation } from "./delegation-executor.mjs";
import { cleanupDelegationWorktree, createDelegationWorktree } from "./delegation-worktree.mjs";
import { codexFileChanges, resolveCodexApprovalByPolicy, workspaceFilePath } from "./codex-policy-adapter.mjs";
import { allowsSession, approvalThreadId, createCodexSessionApprovals, sessionApprovalKind, sessionApprovalResult } from "./codex-session-approvals.mjs";
import { CODEX_GOAL_CONTINUATION_GRACE_MS, createCodexGoalContinuations } from "./codex-goal-continuation.mjs";
import { withoutCodexGoalStart } from "./codex-goal-start.mjs";
import { resolveRecipeExecution } from "./recipes.mjs";
import { runProjectHooks, verificationHookSteps } from "./project-hooks.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { generateTextWithHarness, HARNESS_TEXT_TIMEOUT_MS } from "./harness-text-generation.mjs";

const TREBELL_VERSION = await readFile(join(packageRoot,"package.json"),"utf8")
  .then(text=>String(JSON.parse(text).version||"0.0.0"))
  .catch(()=>"0.0.0");
import {
  gitInfo, cloneRepository, initializeRepository, createBranch, switchBranch, commitAll, fetchRepo, pullRepo, pushRepo,
  safeAutoPull, createWorktree, removeWorktree,
} from "./git-service.mjs";
import {
  sourceControlDiagnostics, listPullRequests, createPullRequest, pullRequestDetail,
  editPullRequest, editPullRequestComment, approvePullRequestWorkflows, revertPullRequest,
  commentOnPullRequest, reviewPullRequest, mergePullRequest, updatePullRequestBranch,
  rebasePullRequestStack,
  checkoutPullRequest, requestPullRequestReviewer, publishRepository, getPullRequestFilesViewed, setPullRequestFilesViewed,
  sourceControlGitAction, sourceControlGitInfo, sourceControlPullRequestTemplate, sourceControlRecentCommitSubjects, sourceControlRepositoryIdentity, sourceControlReviewRangeContext, withSourceControlExecutor,
} from "./source-control-service.mjs";
import { prViewedKey, updateViewedRecord, viewedStates } from "./pr-viewed-state.mjs";
import { buildPullRequestLink, linkedPullRequestTerminalStatus, normalizePullRequestIdentity, parsePullRequestUrl, pullRequestForBranch, pullRequestIdentityKey } from "./pr-link-utils.mjs";
import { createBranchPullRequestSweep } from "./branch-pull-request-sweep.mjs";

const MIME = {
  ".html":"text/html; charset=utf-8",
  ".htm":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".gif":"image/gif",
  ".webp":"image/webp",
  ".bmp":"image/bmp",
  ".pdf":"application/pdf",
  ".mp3":"audio/mpeg",
  ".wav":"audio/wav",
  ".m4a":"audio/mp4",
  ".ogg":"audio/ogg",
  ".flac":"audio/flac",
  ".mp4":"video/mp4",
  ".webm":"video/webm",
  ".mov":"video/quicktime",
  ".md":"text/markdown; charset=utf-8",
  ".csv":"text/csv; charset=utf-8",
  ".tsv":"text/tab-separated-values; charset=utf-8",
  ".ico":"image/x-icon",
};

// Vite names every file under assets/ by its content hash, so the browser keeps it for good. The rest (index.html, which names those
// files, and the icon) is checked on every load and answered 304 while its size and modification time are unchanged.
async function sendUiFile(req,res,{dist,file,info}){
  const headers={"content-type":MIME[extname(file)]||"application/octet-stream"};
  if(file.startsWith(join(dist,"assets")+sep))headers["cache-control"]="public, max-age=31536000, immutable";
  else{
    headers["cache-control"]="no-cache";headers.etag=`W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    const tag=headers.etag.slice(2);
    if(String(req.headers?.["if-none-match"]||"").split(",").some(value=>{const item=value.trim();return item==="*"||item.replace(/^W\//,"")===tag})){res.writeHead(304,{"cache-control":headers["cache-control"],etag:headers.etag});return res.end()}
  }
  const body=await readFile(file);
  res.writeHead(200,headers);
  return res.end(body);
}

function loopbackHttpUrl(input){
  const value=input instanceof URL?input:new URL(typeof input==="string"?input:String(input?.url||""));
  const host=String(value.hostname||"").toLowerCase();
  return ["http:","https:"].includes(value.protocol)&&["127.0.0.1","localhost","::1","[::1]","0.0.0.0"].includes(host);
}
export function offlineE2eFetch(fetchImpl=globalThis.fetch){
  return async(input,options)=>{
    let allowed=false,display="unknown";
    try{
      const value=input instanceof URL?input:new URL(typeof input==="string"?input:String(input?.url||""));
      display=value.origin;allowed=loopbackHttpUrl(value);
    }catch{}
    if(!allowed)throw new Error("Offline browser E2E blocked external network request: "+display);
    return fetchImpl(input,options);
  };
}

const json = (res,status,body) => {
  const data=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":String(data.length),"cache-control":"no-store"});
  res.end(data);
};

async function readJsonBody(req,maxBytes=2*1024*1024){
  let body="";
  for await (const chunk of req){
    body+=chunk;
    if(Buffer.byteLength(body,"utf8")>maxBytes) throw new Error("request_too_large");
  }
  if(!body) return {};
  try{return JSON.parse(body)}catch{throw new Error("invalid_json")}
}

// An uploaded file's stored name: characters outside [a-zA-Z0-9._-] become "_", and a name longer than 80 characters keeps
// its start and its extension.
export function safeAttachmentName(name,fallback="attachment.bin"){
  const safe=String(name||fallback).replace(/[^a-zA-Z0-9._-]/g,"_");
  if(safe.length<=80)return safe;
  const dot=safe.lastIndexOf(".");
  const extension=dot>0&&safe.length-dot<=12?safe.slice(dot):"";
  return safe.slice(0,80-extension.length)+extension;
}
export function requestAbortController(req,res){
  const controller=new AbortController();
  const abort=()=>{
    if(controller.signal.aborted)return;
    const error=new Error("Client disconnected before the request completed.");error.name="AbortError";controller.abort(error);
  };
  const onRequestAborted=()=>abort(),onResponseClosed=()=>{if(!res?.writableEnded)abort()};
  req?.once?.("aborted",onRequestAborted);res?.once?.("close",onResponseClosed);
  return {
    controller,signal:controller.signal,
    dispose(){req?.off?.("aborted",onRequestAborted);res?.off?.("close",onResponseClosed)},
  };
}

function parseArgs(argv){
  const out={port:Number(process.env.PORT||process.env.TREBELL_GUI_PORT||3210),appPort:Number(process.env.TREBELL_APP_SERVER_PORT)||null,host:process.env.TREBELL_GUI_HOST||"127.0.0.1",open:false,mock:process.env.TREBELL_GUI_MOCK==="1"};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--port") out.port=Number(argv[++i]);
    else if(argv[i]==="--app-port") out.appPort=Number(argv[++i])||null;
    else if(argv[i]==="--open") out.open=true;
    else if(argv[i]==="--mock") out.mock=true;
  }
  return out;
}

function openBrowser(url){
  const command=process.platform==="win32"
    ? ["cmd",["/c","start","",url]]
    : process.platform==="darwin"
      ? ["open",[url]]
      : ["xdg-open",[url]];
  const child=spawn(command[0],command[1],{detached:true,stdio:"ignore"});
  child.unref();
}

// A child killed by a signal (a crash by SIGSEGV or SIGABRT, the OOM killer, kill()) has ended with exitCode still null: its
// signalCode says so.
function childEnded(child){return Boolean(child&&(child.exitCode!==null||child.signalCode!==null))}
async function waitForChildExit(child,timeoutMs=3000){
  if(!child || childEnded(child)) return;
  await Promise.race([
    new Promise(resolve=>{
      const done=()=>resolve();
      child.once("exit",done);
      child.once("close",done);
    }),
    new Promise(resolve=>setTimeout(resolve,timeoutMs)),
  ]);
}

// Whether a local port is free to listen on. An explicitly configured app-server port another program holds would only reach that program.
async function tcpPortFree(port){
  const server=createTcpServer();
  const free=await new Promise(resolve=>server.once("error",()=>resolve(false)).listen(port,"127.0.0.1",()=>resolve(true)));
  if(free)await new Promise(resolve=>server.close(resolve));
  return free;
}
async function freeTcpPort(){
  const server=createTcpServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const address=server.address();const port=typeof address==="object"&&address?address.port:0;
  await new Promise(resolve=>server.close(resolve));
  if(!port)throw new Error("Could not reserve a Codex app-server port");
  return port;
}

async function stopChildProcess(child){
  if(!child || childEnded(child)) return;
  const pid=child.pid;
  try{
    if(process.platform==="win32" && pid){
      await new Promise(resolve=>{
        const killer=spawn("taskkill",["/PID",String(pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        killer.once("exit",resolve);
        killer.once("error",resolve);
        setTimeout(resolve,3000);
      });
      await waitForChildExit(child,3000);
    }else{
      child.kill("SIGTERM");
      await waitForChildExit(child,1500);
      if(!childEnded(child)){
        child.kill("SIGKILL");
        await waitForChildExit(child,1500);
      }
    }
  }catch{}
  try{child.stdout?.destroy();}catch{}
  try{child.stderr?.destroy();}catch{}
}

// "OpenAI API" -> "OpenAI API key", "Anthropic" -> "Anthropic API key".
export function apiKeyLabel(providerName){
  const name=String(providerName||"Provider").trim();
  return /\bAPI$/i.test(name)?name+" key":name+" API key";
}
export function codexAppServerEnvironment({env=process.env,runtimeInstance=null,runtimeHome=null,platform=process.platform}={}){
  return {
    ...buildRuntimeEnvironment("codex",{
      parent:env,
      approved:runtimeInstance?.approvedEnvironmentKeys,
      overrides:runtimeInstance?.environment,
      platform,
    }),
    ...(runtimeHome?{CODEX_HOME:runtimeHome}:{}),
  };
}

// The Codex homes a local app-server for a runtime profile runs on (codex-home-layout.mjs).
function codexHomeConfig(runtimeInstance,env){
  return {homePath:runtimeInstance?.homePath?.trim()||null,shadowHomePath:runtimeInstance?.shadowHomePath?.trim()||null,defaultHome:String(env.CODEX_HOME||"").trim()||join(homedir(),".codex")};
}

async function startAppServer({appPort,env=process.env,mock=false,environments=null,environmentId=null,runtimeInstance=null,runtimeEnvironmentNames=null,command:runtimeCommand=null}){
  if(mock) return { child:null, logs:[], targetUrl:null, readyUrl:null, environment:null, appPort, runtimeInstanceId:runtimeInstance?.id||"codex-default" };
  if(environmentId&&environments){
    const profile=environments.get(environmentId);
    if(profile&&profile.type!=="local"){
      try{
        const remote=await startRemoteAppServer({
          environments,
          environmentId,
          appPort,
          runtimeInstance,
          runtimeEnvironmentNames,
          hostEnvironment:env,
          debug:env.TREBELL_GUI_DEBUG==="1",
        });
        return {...remote,appPort,runtimeInstanceId:runtimeInstance?.id||"codex-default"};
      }catch(error){
        const text=redactSecretText((error?.stack||error?.message||String(error))+"\n",{environment:{...env,...(runtimeInstance?.environment||{})}});
        return {
          child:null,
          logs:[{at:Date.now(),stream:"environment",text:boundDiagnosticText(text)}],
          targetUrl:`ws://127.0.0.1:${appPort}`,
          readyUrl:null,
          environment:{id:profile.id,name:profile.name,type:profile.type},
          appPort,
          runtimeInstanceId:runtimeInstance?.id||"codex-default",
          error:redactSecretText(error instanceof Error?error.message:String(error),{environment:{...env,...(runtimeInstance?.environment||{})}}),
        };
      }
    }
  }
  // The same Codex the status probe checked (AgentRuntimeManager.executable): the profile binary, else the user's installed CLI.
  const command=runtimeCommand||runtimeInstance?.binaryPath?.trim()||codexBin(env);
  const homeLayout=await prepareCodexHome(codexHomeConfig(runtimeInstance,env));
  const runtimeHome=homeLayout.effectiveHomePath||null;
  if(runtimeHome)await mkdir(runtimeHome,{recursive:true});
  const runtimeEnv=codexAppServerEnvironment({env,runtimeInstance,runtimeHome});
  // Only Trebell's own clients can drive the app-server: they send its token (codex-app-server-auth.mjs).
  const shell=process.platform==="win32" && !command.toLowerCase().endsWith(".exe"),auth=await codexAppServerToken({env,quote:shell});
  const args=["app-server","--listen",`ws://127.0.0.1:${appPort}`,...auth.args];
  const logs=[];
  const pushLog=(chunk,stream)=>{
    const line=boundDiagnosticText(redactSecretText(chunk,{environment:runtimeEnv}));
    logs.push({at:Date.now(),stream,text:line});
    if(logs.length>250) logs.splice(0,logs.length-250);
    if(env.TREBELL_GUI_DEBUG==="1") (stream==="stderr"?process.stderr:process.stdout).write(line);
  };
  const child=spawn(command,args,{
    cwd:process.cwd(),
    env:runtimeEnv,
    windowsHide:true,
    shell,
    stdio:["ignore","pipe","pipe"],
  });
  child.stdout?.on("data",chunk=>pushLog(chunk,"stdout"));
  child.stderr?.on("data",chunk=>pushLog(chunk,"stderr"));
  child.on("error",error=>{pushLog(error.stack||error.message,"stderr");void auth.release()});
  child.on("exit",(code,signal)=>{pushLog(`app-server exited code=${code} signal=${signal}\n`,"stderr");void auth.release()});
  return { child, logs, targetUrl:`ws://127.0.0.1:${appPort}`, readyUrl:`http://127.0.0.1:${appPort}/readyz`, environment:null, appPort, runtimeInstanceId:runtimeInstance?.id||"codex-default",runtimeHome,sharedRuntimeHome:homeLayout.sharedHomePath,continuationKey:homeLayout.continuationKey,wsToken:auth.token };
}

// Why an app-server did not become ready: once it has exited, the last thing it wrote (codex says why it could not listen).
export function appServerStartError(server,name){
  const child=server?.child,exited=Boolean(child&&(child.exitCode!==null||child.signalCode!==null));
  if(!exited)return `Codex app-server profile '${name}' did not become ready`;
  const lines=(server.logs||[]).filter(entry=>entry.stream==="stderr").map(entry=>String(entry.text||"")).join("").split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!/^app-server exited /.test(line)&&!/^WARNING:/.test(line));
  // A Codex from before --ws-auth stops on the argument, and its last line only says to try --help. One a WSL or SSH host runs (its
  // token as --ws-token-sha256, environment-app-server.mjs) is named with that environment, where it is to be updated.
  const flag=lines.map(line=>/unexpected argument '(--ws-auth|--ws-token-sha256)'/.exec(line)?.[1]).find(Boolean),remote=server.environment;
  if(flag)return `Codex app-server profile '${name}' exited before it was ready${remote?` in the ${remote.type==="wsl"?"WSL":"SSH"} environment '${remote.name}'`:""}: this Codex has no ${flag}, which Trebell Code starts each Codex app-server with so that only Trebell Code can connect to it. Update Codex${remote?` in '${remote.name}'`:""} (npm install -g @openai/codex), then try again.`;
  const said=String(lines.at(-1)||"").replace(/^Error:\s*/,"").slice(0,300);
  return `Codex app-server profile '${name}' exited before it was ready`+(said?": "+said:"");
}

async function appServerReady(instance,appPort){
  if(instance?.readyUrl){
    try{
      const response=await fetch(instance.readyUrl,{signal:AbortSignal.timeout(1200)});
      return response.ok;
    }catch{return false}
  }
  return instance?.child ? await probeCodexReady(instance?.appPort||appPort) : false;
}

async function waitForAppServer(instance,appPort,timeoutMs=15000){
  if(!instance?.readyUrl) return instance?.child ? await waitForCodexReady(instance?.appPort||appPort,timeoutMs).catch(()=>false) : false;
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(await appServerReady(instance,appPort))return true;
    // A server whose process has exited never becomes ready, so a stop during its boot ends the wait too.
    if(instance.child&&(instance.child.exitCode!==null||instance.child.signalCode!==null))return false;
    await new Promise(resolve=>setTimeout(resolve,180));
  }
  return false;
}

async function stopAppServer(instance){
  // Stopped on purpose: its exit is no death (noteCodexAppServerExit).
  if(instance)instance.stopping=true;
  await stopChildProcess(instance?.child);
  try{await instance?.close?.()}catch{}
  // A local codex can still hold its port a moment after the process Trebell started has ended (on Windows that is codex's shell
  // wrapper, which exits first): the stop ends once the port is free, or after 3 s, so a start on that port (the configured catalog
  // port, after a restart or an environment switch) is not refused as held by another program.
  const port=Number(instance?.appPort);
  if(instance?.child&&!instance.environment&&port>0)for(const started=Date.now();!await tcpPortFree(port)&&Date.now()-started<3000;)await new Promise(resolve=>setTimeout(resolve,25));
}

function knownModelProvider(providerId){
  return Object.prototype.hasOwnProperty.call(MODEL_PROVIDERS,String(providerId||"").trim().toLowerCase());
}

// The Codex requests that start a turn in their thread: a restore of the thread's files waits for none of them, and refuses while one
// is on its way.
const CODEX_TURN_START_METHODS=new Set(["turn/start","review/start","thread/compact/start","thread/queue/start"]);
// Requests the server answers by starting the thread's next turn itself (its own turn/start to Codex): verification's next step and
// its repair. Edit from here counts them as turn starts.
const CODEX_SERVER_TURN_METHODS=new Set(["thread/verification/continue","thread/verification/repair"]);
const startsCodexTurn=method=>CODEX_TURN_START_METHODS.has(method)||CODEX_SERVER_TURN_METHODS.has(method);

const MOCK_DEFAULT_MODEL="test/coding-fast";
function fakeModels(provider=DEFAULT_MODEL_PROVIDER){
  if(provider==="agentrouter") return ["gpt-5.6-sol","gpt-6-astra","claude-opus-4-8","claude-opus-5","deepseek-v4-flash"];
  if(provider==="justworker") return ["claude-opus-4-8"];
  if(provider==="hcnsec") return ["glm-5.3"];
  if(provider==="vyceai") return ["claude-sonnet-4-6","gpt-astra","deepseek-v4.1","auto"];
  return [MOCK_DEFAULT_MODEL,"test/coding-large"];
}
function fakeDefaultModel(provider=DEFAULT_MODEL_PROVIDER){
  return fakeModels(provider).includes(MOCK_DEFAULT_MODEL)?MOCK_DEFAULT_MODEL:null;
}

// A byte count for the Runtime tab, e.g. "28.0 GB" or "2.26 TB".
export function formatByteSize(bytes){
  const value=Number(bytes);
  if(!Number.isFinite(value)||value<0)return "\u2014";
  const units=["B","KB","MB","GB","TB","PB"];let size=value,unit=0;
  while(size>=1024&&unit<units.length-1){size/=1024;unit++}
  return (unit===0?String(Math.round(size)):size>=100?size.toFixed(0):size>=10?size.toFixed(1):size.toFixed(2))+" "+units[unit];
}
// Whether local Codex history can be imported now, and if not, why: the harness or environment choice, or no local Codex
// app-server to fork the sessions into (the mock server runs none; one bound to a remote environment is not local).
export function codexHistoryImportStatus({runtime,activeEnvironmentId=null,appServer=null}={}){
  const choice="Codex imports need the Codex harness on Local machine.";
  if(runtime!=="codex")return {available:false,reason:"harness",message:choice};
  if(activeEnvironmentId)return {available:false,reason:"environment",message:choice};
  if(!appServer?.targetUrl||appServer.environment)return {available:false,reason:"app-server",message:"Codex imports need a local Codex app-server, and none is reachable."};
  return {available:true,reason:null,message:null};
}
function statsSnapshot(){
  const load=cpus().length ? Math.min(100,Math.round((requireLoad()/cpus().length)*100)) : 0;
  const usedMem=Math.max(0,totalmem()-freemem());
  let disk="\u2014";
  try{
    const fs=statfsSync(tmpdir());
    const used=(fs.blocks-fs.bfree)*fs.bsize;
    disk=formatByteSize(used);
  }catch{}
  return {
    cpu:`${load}%`,
    memory:formatByteSize(usedMem),
    disk,
    network:"Local",
  };
}
function requireLoad(){
  try{
    if(process.env.TREBELL_TEST_LOAD) return Number(process.env.TREBELL_TEST_LOAD) || 0;
    return process.platform==="win32" ? 0 : (loadavg()[0] || 0);
  }catch{return 0}
}

const COMMON_PREVIEW_PORTS=[3000,3001,4173,4200,4321,5000,5173,5174,8000,8080,8081,8787,8888];

async function discoverPreviewServers(){
  const checks=COMMON_PREVIEW_PORTS.map(async port=>{
    const url=`http://127.0.0.1:${port}/`;
    try{
      const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(650)});
      const contentType=String(response.headers.get("content-type")||"").toLowerCase();
      return {
        host:"localhost",
        port,
        url:`http://localhost:${port}`,
        status:response.status,
        contentType:contentType.split(";")[0]||null,
        web:contentType.includes("text/html")||contentType.includes("application/xhtml+xml")||response.status<500,
      };
    }catch{return null}
  });
  return (await Promise.all(checks)).filter(Boolean).filter(item=>item.web).sort((a,b)=>a.port-b.port);
}

function parseJsonc(text){
  const source=String(text||"");
  let clean="",inString=false,escaped=false,lineComment=false,blockComment=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(lineComment){if(ch==="\n"){lineComment=false;clean+=ch}continue}
    if(blockComment){if(ch==="*"&&next==="/"){blockComment=false;i++}continue}
    if(inString){
      clean+=ch;
      if(escaped)escaped=false;
      else if(ch==="\\")escaped=true;
      else if(ch==='"')inString=false;
      continue;
    }
    if(ch==='"'){inString=true;clean+=ch;continue}
    if(ch==="/"&&next==="/"){lineComment=true;i++;continue}
    if(ch==="/"&&next==="*"){blockComment=true;i++;continue}
    clean+=ch;
  }
  clean=clean.replace(/,\s*([}\]])/g,"$1");
  return JSON.parse(clean);
}

async function readOptionalJson(path,{jsonc=false}={}){
  try{
    const raw=await readFile(path,"utf8");
    return jsonc?parseJsonc(raw):JSON.parse(raw);
  }catch{return null}
}

// The shell and arguments that run a command as written. cmd.exe takes the command line whole, quoted once as Node's own shell option
// does: passed as one argument, its double quotes would be escaped with backslashes (the MSVCRT rule), which cmd.exe does not undo.
// On Windows the arguments are that command line as a string, which node-pty uses as is and spawn takes with windowsVerbatimArguments.
function commandShellSpec(command,env=process.env){
  if(process.platform==="win32")return {shell:env.COMSPEC||"cmd.exe",args:`/d /s /c "${String(command||"")}"`};
  const shell=env.SHELL||"/bin/bash";
  return {shell,args:["-lc",String(command||"")]};
}

async function runLocalHookCommand(command,{cwd=null,env=process.env,timeoutMs=30000}={}){
  const spec=commandShellSpec(command,env),startedAt=Date.now(),limit=Math.max(1000,Math.min(300000,Number(timeoutMs)||30000));
  return new Promise((resolveRun,reject)=>{
    let settled=false,timedOut=false;const child=spawn(spec.shell,[spec.args].flat(),{cwd:cwd||undefined,env,windowsHide:true,windowsVerbatimArguments:true,stdio:["ignore","pipe","pipe"]});
    child.stdout?.on("data",()=>{});child.stderr?.on("data",()=>{});
    const timer=setTimeout(()=>{timedOut=true;void stopChildProcess(child)},limit);
    const finish=(error,code=null)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveRun({exitCode:code??1,timedOut,durationMs:Date.now()-startedAt})};
    child.once("error",error=>finish(error));child.once("close",code=>finish(null,code));
  });
}

async function projectActionSuggestions(projectPath){
  const root=resolve(projectPath);
  const [t3,pkg,pnpmLock,yarnLock,bunLock,bunLockb]=await Promise.all([
    readOptionalJson(join(root,"t3.json"),{jsonc:true}),
    readOptionalJson(join(root,"package.json")),
    stat(join(root,"pnpm-lock.yaml")).then(()=>true).catch(()=>false),
    stat(join(root,"yarn.lock")).then(()=>true).catch(()=>false),
    stat(join(root,"bun.lock")).then(()=>true).catch(()=>false),
    stat(join(root,"bun.lockb")).then(()=>true).catch(()=>false),
  ]);
  const fileScripts=Array.isArray(t3?.scripts)?t3.scripts.slice(0,50).map((script,index)=>({
    id:`t3-${index}-${String(script?.name||"action").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,32)}`,
    source:"t3.json",
    name:String(script?.name||`Action ${index+1}`).trim().slice(0,80),
    command:String(script?.command||"").trim().slice(0,8000),
    previewUrl:script?.previewUrl?String(script.previewUrl).trim().slice(0,1000):null,
    autoOpenPreview:Boolean(script?.autoOpenPreview),
    runOnWorktreeCreate:Boolean(script?.runOnWorktreeCreate),
    waitForSetup:script?.runOnWorktreeCreate===true&&script?.async===false,
  })).filter(script=>script.command):[];
  const packageManager=pnpmLock?"pnpm":(yarnLock?"yarn":((bunLock||bunLockb)?"bun":"npm"));
  const packageScripts=Object.entries(pkg?.scripts||{}).slice(0,80).map(([name,command])=>({
    id:`package-${name}`,
    source:"package.json",
    name,
    command:packageManager==="yarn"?`yarn ${name}`:`${packageManager} run ${name}`,
    declaredCommand:String(command||""),
    previewUrl:null,
    autoOpenPreview:false,
    runOnWorktreeCreate:false,
    waitForSetup:false,
  }));
  return {
    t3:{present:Boolean(t3),defaultThreadEnvMode:t3?.defaultThreadEnvMode==="worktree"?"worktree":t3?.defaultThreadEnvMode==="local"?"current":null,worktreeSubmodules:["recursive","top-level","none"].includes(t3?.worktreeSubmodules)?t3.worktreeSubmodules:null},
    packageManager,
    scripts:[...fileScripts,...packageScripts],
  };
}

// appPort: the catalog Codex app-server's port, when one is configured (TREBELL_APP_SERVER_PORT or --app-port). By default every start
// takes a free port, so a program on a fixed one (another Trebell, an app-server a crash left behind) never keeps Codex from starting.
export async function createGuiServer({port=3210,appPort=null,host="127.0.0.1",mock=false,env=process.env,fetchFn=globalThis.fetch,harnessTextGenerator=generateTextWithHarness}={}){
  const offlineE2E=env.TREBELL_E2E_OFFLINE==="1"||process.env.TREBELL_E2E_OFFLINE==="1";
  if(offlineE2E&&!mock)throw new Error("Offline browser E2E forbids starting a real Trebell provider or Codex app-server.");
  const fetchImpl=offlineE2E?offlineE2eFetch(fetchFn):fetchFn;
  const bootId=randomUUID();
  const dist=String(env.TREBELL_UI_DIST||"").trim()?resolve(String(env.TREBELL_UI_DIST).trim()):resolve(packageRoot,"ui","dist");
  // The server keeps one sqlite connection for its state (closed in close()) instead of opening one per read or write.
  const state=new TrebellStateStore(env,{keepConnection:true});
  // After the settings migration above: delete what retired model providers left under the Trebell home.
  removeRetiredProviderData(env,{log:message=>console.error(message)});
  const eventJournal=new EventJournal(env);
  const providers=new ProviderManager({env,fetchFn:fetchImpl});
  // Offline E2E also runs none of the host programs that would reach the network or answer from this machine's own installs and
  // sign-ins: host discovery (ssh -V, wsl --list), the harness checks and the code-host CLIs answer from offline-e2e-host.mjs.
  const environments=new EnvironmentManager({state,env,...(offlineE2E?{discoveryRun:offlineE2eDiscoveryRun}:{})});
  // An attachment on this machine as the composer gets it back, with the file a Word, Excel or other document's text was extracted
  // to (textPath, document-text.mjs), which the composer names in a Codex message as the relay names it for every other harness.
  // Trebell Native's prompt names a document itself and no text of it, so nothing is extracted while it is the harness; a message
  // sent to another harness has its documents extracted as its files are checked before it goes. extract false: only the text a
  // document has already, for a send's second check of its files, right after the first one extracted it.
  const withDocumentText=async(file,{extract=true}={})=>{const textPath=selectedAgentRuntime==="native"?null:await (extract?ensureDocumentText:extractedDocumentText)(file.path,{home:trebellHome(env)});return textPath?{...file,textPath}:file};
  const storedActiveEnvironmentId=state.settings().activeEnvironmentId||null;
  if(storedActiveEnvironmentId&&!environments.get(storedActiveEnvironmentId))state.updateSettings({activeEnvironmentId:null});
  function requestedEnvironmentId(value,{fallback=true}={}){
    if(value===undefined||value===null)return fallback?(state.settings().activeEnvironmentId||null):null;
    const text=String(value).trim();return text||null;
  }
  function environmentPath(value,environmentId){
    const text=String(value||"").trim();if(!text)throw new Error("path is required");
    const profile=environmentId?environments.get(environmentId):null;
    if(environmentId&&!profile)throw new Error("Environment profile was not found");
    if(!profile||profile.type==="local")return resolve(text);
    if(text.startsWith("/"))return posix.normalize(text);
    return posix.normalize(posix.join(profile.cwd||"/",text));
  }
  function projectWithEnvironment(project){
    if(!project)return project;
    const profile=project.environmentId?environments.get(project.environmentId,{includeDisabled:true}):null;
    const cloneJob=project.cloneJob?{
      id:project.cloneJob.id,url:project.cloneJob.url,status:project.cloneJob.status,progress:project.cloneJob.progress,
      phase:project.cloneJob.phase,error:project.cloneJob.error||null,startedAt:project.cloneJob.startedAt,completedAt:project.cloneJob.completedAt||null,
    }:null;
    return {...project,cloneJob,environment:project.environmentId?{
      id:project.environmentId,
      name:profile?.name||"Unavailable environment",
      type:profile?.type||"unknown",
      enabled:profile?.enabled!==false,
    }:{id:null,name:"Local machine",type:"local"},effectiveSettings:state.projectSettings(project.path,project.environmentId).effective};
  }
  const agentRuntimes=new AgentRuntimeManager({state,env,environments,fetchImpl,...(offlineE2E?{runFn:offlineE2eHarnessRun,claudeCapabilitiesCache:offlineE2eClaudeCapabilities}:{})});
  // Settings' Antigravity sign-in that runs, whichever window asked: one at a time (/api/agent-runtime-auth).
  let antigravitySignIn=null;
  const codexThreadModels=new Map();
  // As state: one sqlite connection for the agent threads, closed in close(). The server is the only writer of them.
  const agentThreads=new AgentThreadStore(env,{keepConnection:true});
  agentThreads.reconcileRestart({continueAfterRestart:Boolean(state.settings().continueThreadsAfterRestart)});
  for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
    const recovery=meta?.restartRecovery;
    if(recovery?.runtime!=="codex"||recovery?.status!=="active"||!recovery.turnId||recovery.bootId===bootId)continue;
    state.updateThreadMeta(threadId,{restartRecovery:staleCodexRecoveryState(recovery,{continueAfterRestart:Boolean(state.settings().continueThreadsAfterRestart)})});
  }
  let selectedAgentRuntime=normalizeAgentRuntime(state.settings().agentRuntime);
  if(state.settings().agentRuntime!==selectedAgentRuntime) state.updateSettings({agentRuntime:selectedAgentRuntime,agentRuntimeInstanceId:`${selectedAgentRuntime}-default`});
  let selectedProvider=normalizeProviderId(state.settings().modelProvider);
  if(state.settings().modelProvider!==selectedProvider) state.updateSettings({modelProvider:selectedProvider});
  const nativeModelContextWindows=new Map();
  function rememberNativeModelContextWindows(catalog,{fallbackProvider=selectedProvider}={}){
    for(const row of catalog?.metadata?.models||[]){
      const size=modelContextWindowFromMetadata(row);if(!size)continue;
      nativeModelContextWindows.set(modelContextWindowKey(row.provider||fallbackProvider,row.id),size);
    }
  }
  async function resolveNativeModelContextWindow({provider,model}={}){
    const providerId=normalizeProviderId(provider||selectedProvider),key=modelContextWindowKey(providerId,model);if(nativeModelContextWindows.has(key))return nativeModelContextWindows.get(key);
    if(mock||!model)return null;
    const result=await providers.models(providerId);rememberNativeModelContextWindows({metadata:{models:result.metadata||[]}}, {fallbackProvider:providerId});
    return nativeModelContextWindows.get(key)||null;
  }
  const safeLogText=value=>boundDiagnosticText(redactSecretText(value,{environment:env}));
  function codexRuntimeProvider(threadId=null,meta=threadId?state.threadMeta(threadId):null){
    if(meta?.runtimeInstanceId)return meta.runtimeInstanceId;
    if(agentRuntimes.activeRuntime()==="codex")return agentRuntimes.activeInstance().id;
    return "codex-default";
  }
  const checkpoints=new CheckpointService({state,env,environments});
  function recordCheckpointTrace(name,status,checkpoint=null,extra={}){
    const threadId=checkpoint?.threadId||extra.threadId||null,meta=threadId?state.threadMeta(threadId):{};
    eventJournal.record({
      runtime:meta?.runtime||null,provider:meta?.runtimeInstanceId||null,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,
      threadId,turnId:checkpoint?.turnId||extra.turnId||null,category:"checkpoint",name,status,
      data:{checkpointId:checkpoint?.id||extra.checkpointId||null,root:checkpoint?.root||null,commit:checkpoint?.commit||null,label:checkpoint?.label||null,reason:extra.reason||null,message:extra.message||null},
    });
  }
  const EXTERNAL_SOURCE_CONTROL_ACTIONS=new Set(["push","git.push","publish","pr.create","pr.edit","pr.edit-comment","pr.approve-workflows","pr.revert","pr.rebase-stack","pr.comment","pr.review","pr.merge","pr.update-branch","pr.request-reviewer"]);
  function hookProjectFor(cwd,environmentId=null){
    const value=String(cwd||"").trim();if(!value)return null;const profile=environmentId?environments.get(environmentId):null,remote=Boolean(profile&&profile.type!=="local");
    const key=input=>{if(remote){const normalized=posix.normalize(String(input||"").replace(/\\/g,"/"));return normalized.length>1?normalized.replace(/\/$/,""):normalized}const normalized=resolve(String(input||""));return process.platform==="win32"?normalized.toLowerCase():normalized};
    const wanted=key(value);return state.projects().find(project=>(project.environmentId||null)===(environmentId||null)&&key(project.path)===wanted)||null;
  }
  async function executeInstalledProjectHooks(event,{cwd=null,environmentId=null,action=null,threadId=null}={}){
    const project=hookProjectFor(cwd,environmentId);if(!project?.hooks?.length)return [];
    return runProjectHooks({
      hooks:project.hooks,event,action,
      execute:async hook=>{
        if(environmentId){const result=await environments.execute(environmentId,{command:hook.command,cwd:project.path,timeoutMs:hook.timeoutMs,maxOutput:64*1024});return {exitCode:result.exitCode,timedOut:result.timedOut,durationMs:result.durationMs}}
        return runLocalHookCommand(hook.command,{cwd:project.path,env,timeoutMs:hook.timeoutMs});
      },
      onEvent:entry=>{
        const phase=entry.phase,status=phase==="started"?"running":phase==="completed"?"completed":"failed",result=entry.result||{};
        eventJournal.record({environmentId:environmentId||null,threadId:threadId||null,category:"hook",name:"hook."+phase,status,data:{hookId:entry.hook?.id||null,name:entry.hook?.name||null,event,action:action||null,failureMode:entry.hook?.failureMode||null,...(phase==="started"?{}:{exitCode:result.exitCode??null,timedOut:Boolean(result.timedOut),durationMs:Number(result.durationMs)||0}),...(entry.error?{message:redactSecretText(entry.error?.message||String(entry.error),{environment:env}).slice(0,1000)}:{})}});
      },
    });
  }
  function withInstalledVerificationHooks(plan,{cwd=null,environmentId=null}={}){
    const project=hookProjectFor(cwd,environmentId),hookSteps=verificationHookSteps(project?.hooks||[]);if(!hookSteps.length)return plan;
    const existing=new Set((plan?.steps||[]).map(step=>String(step?.id||"")));return {...plan,steps:[...(plan?.steps||[]),...hookSteps.filter(step=>!existing.has(step.id))]};
  }
  async function tracedSourceControlMutation(action,{cwd=null,environmentId=null,provider=null,number=null,threadId=null}={},run){
    const startedAt=Date.now(),externalSideEffect=EXTERNAL_SOURCE_CONTROL_ACTIONS.has(String(action||""));
    try{
      await executeInstalledProjectHooks("source-control.before",{cwd,environmentId,action,threadId});
      const result=await run();
      await executeInstalledProjectHooks("source-control.after",{cwd,environmentId,action,threadId});
      const resolvedNumber=number??result?.number??result?.item?.number??null;
      eventJournal.record({environmentId:environmentId||null,threadId:threadId||null,category:"source-control",name:"source_control."+String(action||"mutation"),status:"completed",data:{action,cwd,provider:provider||result?.provider||result?.item?.provider||null,number:resolvedNumber==null?null:Number(resolvedNumber),externalSideEffect,durationMs:Date.now()-startedAt}});
      return result;
    }catch(error){
      eventJournal.record({environmentId:environmentId||null,threadId:threadId||null,category:"source-control",name:"source_control."+String(action||"mutation"),status:"failed",data:{action,cwd,provider:provider||null,number:number==null?null:Number(number),externalSideEffect,durationMs:Date.now()-startedAt,message:error?.message||String(error)}});
      throw error;
    }
  }
  const contextEngine=new ContextEngine({env});
  const repositoryKnowledge=new RepositoryKnowledgeService({
    state,
    ioFactory:async({projectPath,environmentId})=>{
      const profile=environmentId?environments.get(environmentId):null;
      return profile&&profile.type!=="local"?createRemoteContextIo({environments,environmentId,root:projectPath}):null;
    },
  });
  const terminals=mock ? null : new TerminalManager({env});
  // Each project action's terminal while it runs, by environment, project and action: a second run of an action that still runs
  // shows its terminal instead of starting it twice (a second dev server only fails on its port).
  // A run whose terminal is still starting is kept too (projectActionStarts): a run that comes meanwhile (the second click of a
  // double click, which leaves before the first answers) waits for it and answers with its terminal, so the action starts once.
  const projectActionSessions=new Map(),projectActionStarts=new Map();
  const projectActionKey=(projectPath,environmentId,scriptId)=>[environmentId||"",projectPath,String(scriptId||"")].join("\0");
  const projectActionStarted=async key=>{for(let starting;(starting=projectActionStarts.get(key));)await starting.catch(()=>{})};
  const runningProjectAction=key=>{const session=terminals?.snapshot(projectActionSessions.get(key)||"");if(session?.running)return session;projectActionSessions.delete(key);return null};
  const actionSessionSummary=session=>{const {buffer,...rest}=session||{};return rest};
  // An action runs its command as the terminal's own program, as worktree setup does, so its terminal runs exactly while the action
  // does: it ends with the command (its exit code on the tab) and Stop ends it, with all that the command started (endsTree). A
  // remote environment runs it with sh -lc there.
  async function createProjectActionSession(projectPath,environmentId,script){
    const command=String(script.command||""),base=terminalOptions({environmentId,cwd:projectPath,name:script.name||"Project action",cols:120,rows:32});
    const profile=environmentId?environments.get(environmentId):null;
    if(profile&&profile.type!=="local"){
      const remote=environments.terminalArgvSpec(environmentId,{command:"sh",args:["-lc",command],cwd:projectPath});
      return terminals.create({...base,cwd:remote.cwd,shell:remote.shell,args:remote.args,endsTree:true,environmentId:remote.environmentId??base.environmentId,environmentName:remote.environmentName||base.environmentName,environmentType:remote.environmentType||base.environmentType});
    }
    const spec=commandShellSpec(command,env);
    return terminals.create({...base,shell:spec.shell,args:spec.args,endsTree:true});
  }
  function terminalOptions({environmentId=null,cwd=null,name=null,cols=120,rows=32,terminalEnv=null}={}){
    const spec=environments.terminalSpec(environmentId,{cwd});
    const profile=environmentId?environments.get(environmentId):null;
    const remoteTransport=Boolean(profile&&profile.type!=="local");
    const displayCwd=String(cwd||profile?.cwd||process.cwd());
    return {
      cwd:spec.cwd,
      displayCwd,
      cols,
      rows,
      name:name||"Terminal",
      env:remoteTransport?{...remoteTransportEnvironment(env,{platform:process.platform}),...(terminalEnv||{})}:(terminalEnv||null),
      replaceEnv:remoteTransport,
      shell:spec.shell,
      args:spec.args,
      environmentId:spec.environmentId,
      environmentName:spec.environmentName,
      environmentType:spec.environmentType,
    };
  }
  async function createTerminalSession(body={}){
    const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
      ?requestedEnvironmentId(body.environmentId,{fallback:false})
      :requestedEnvironmentId(null);
    return terminals.create(terminalOptions({
      environmentId,
      cwd:body.cwd||null,
      name:body.name||null,
      cols:body.cols,
      rows:body.rows,
      terminalEnv:body.env||null,
    }));
  }
  function sourceControlExecutor(environmentId){
    const profile=environmentId?environments.get(environmentId):null;
    const localRequest=async(url,options={})=>{
      const response=await fetchImpl(url,options);const text=await response.text();
      return {ok:response.ok,status:response.status,text};
    };
    const base=createNativeSourceControlExecutor({environments,environmentId,environment:env,platform:process.platform});
    if(!profile||profile.type==="local")return {...base,request:localRequest};
    return {
      ...base,
      withTempJsonFile:async(content,callback)=>{
        const allocated=await environments.executeArgv(environmentId,{command:"mktemp",args:["/tmp/trebell-azdo-XXXXXX.json"],cwd:"",timeoutMs:8000,maxOutput:64*1024,environmentNames:sourceControlEnvironmentKeys("mktemp")});
        if(allocated.exitCode!==0)throw new Error(allocated.stderr||"Could not allocate remote Azure DevOps request file");
        const path=String(allocated.stdout||"").trim();if(!path)throw new Error("Remote Azure DevOps request file path was empty");
        const created=await environments.executeArgvInput(environmentId,{command:"tee",args:[path],input:String(content??""),cwd:"",timeoutMs:12000,maxOutput:64*1024,environmentNames:sourceControlEnvironmentKeys("tee")});
        if(created.exitCode!==0){await environments.executeArgv(environmentId,{command:"rm",args:["-f",path],cwd:"",timeoutMs:8000,maxOutput:64*1024,environmentNames:sourceControlEnvironmentKeys("rm")}).catch(()=>{});throw new Error(created.stderr||"Could not create remote Azure DevOps request file")}
        try{return await callback(path)}
        finally{await environments.executeArgv(environmentId,{command:"rm",args:["-f",path],cwd:"",timeoutMs:8000,maxOutput:64*1024,environmentNames:sourceControlEnvironmentKeys("rm")}).catch(()=>{})}
      },
      readFile:async(path)=>{
        const result=await environments.executeArgv(environmentId,{command:"cat",args:[String(path)],cwd:"",timeoutMs:12000,maxOutput:4*1024*1024,environmentNames:sourceControlEnvironmentKeys("cat")});
        if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote file");
        return result.stdout;
      },
      request:async(url,options={})=>{
        if(offlineE2E&&!loopbackHttpUrl(url))throw new Error("Offline browser E2E blocked external network request: "+String(url));
        const method=String(options.method||"GET").toUpperCase();
        const config=["silent","show-error","max-time = 30","request = "+JSON.stringify(method)];
        if(options.redirect!=="manual")config.push("location");
        for(const [name,value] of Object.entries(options.headers||{}))config.push("header = "+JSON.stringify(String(name)+": "+String(value)));
        config.push("write-out = "+JSON.stringify("\nTREBELL_HTTP_STATUS:%{http_code}"));
        const args=["--config","-"];
        if(options.body!==undefined)args.push("--data-raw",String(options.body));
        args.push(String(url));
        const result=await environments.executeArgvInput(environmentId,{command:"curl",args,input:config.join("\n")+"\n",cwd:"",timeoutMs:35000,maxOutput:10*1024*1024,environmentNames:sourceControlEnvironmentKeys("curl")});
        if(result.exitCode!==0)throw new Error(result.stderr||"Remote HTTP request failed");
        const match=String(result.stdout||"").match(/\nTREBELL_HTTP_STATUS:(\d{3})$/);
        const status=Number(match?.[1]||0);
        const text=match?result.stdout.slice(0,match.index):result.stdout;
        return {ok:status>=200&&status<300,status,text};
      },
      readFjKeys:async()=>{
        const command=[
          "for f in",
          "\"$HOME/.local/share/forgejo-cli/keys.json\"",
          "\"$HOME/Library/Application Support/forgejo-cli.forgejo-cli/keys.json\"",
          "\"$HOME/Library/Application Support/Cyborus.forgejo-cli/keys.json\";",
          "do if [ -f \"$f\" ]; then cat \"$f\"; exit 0; fi; done; exit 1",
        ].join(" ");
        const result=await environments.executeArgv(environmentId,{command:"sh",args:["-lc",command],cwd:"",timeoutMs:12000,maxOutput:2*1024*1024,environmentNames:sourceControlEnvironmentKeys("tea")});
        if(result.exitCode!==0)return {hosts:{},aliases:{}};
        try{return JSON.parse(result.stdout)}catch{return {hosts:{},aliases:{}}}
      },
    };
  }
  // Offline E2E answers the code-host CLIs (gh, glab, tea, fj, az) as not installed: they would ask GitHub and the other hosts with
  // this machine's sign-ins (offline-e2e-host.mjs). Git still runs.
  function inSourceControlEnvironment(environmentId,callback){
    const executor=sourceControlExecutor(environmentId);
    return withSourceControlExecutor(offlineE2E?offlineE2eSourceControlExecutor(executor):executor,callback);
  }
  function threadPullRequestAttachments(threadId){
    return (state.threadMeta(threadId)?.attachments||[]).filter(item=>item?.attachmentType==="pull_request");
  }
  function threadPullRequestLinks(threadId){
    return threadPullRequestAttachments(threadId).map(item=>({...item.payload,__identityKey:item.identityKey})).filter(Boolean);
  }
  async function resolvePullRequestIdentity(identity,{preferredPath=null,preferredEnvironmentId=null}={}){
    const wanted=normalizePullRequestIdentity(identity);if(!wanted)throw new Error("Pull request identity is incomplete");
    const projects=state.projects().sort((a,b)=>{
      const aPreferred=a.path===preferredPath&&(a.environmentId||null)===(preferredEnvironmentId||null);
      const bPreferred=b.path===preferredPath&&(b.environmentId||null)===(preferredEnvironmentId||null);
      return Number(bPreferred)-Number(aPreferred);
    });
    for(const project of projects){
      try{
        const repo=await inSourceControlEnvironment(project.environmentId||null,()=>sourceControlRepositoryIdentity(project.path,{provider:wanted.provider||null}));
        if(String(repo.host||"").toLowerCase()!==wanted.host||String(repo.repository||"").toLowerCase()!==wanted.repository.toLowerCase())continue;
        const detail=await inSourceControlEnvironment(project.environmentId||null,()=>pullRequestDetail(project.path,wanted.number,{provider:repo.provider}));
        if(detail?.ok&&detail.item)return {project:projectWithEnvironment(project),detail};
      }catch{}
    }
    throw new Error("Add a Trebell project for "+wanted.host+"/"+wanted.repository+" to resolve this pull request.");
  }
  function storePullRequestLink(threadId,link){
    const key=pullRequestIdentityKey(link);if(!key)throw new Error("Pull request identity is incomplete");
    const meta=state.threadMeta(threadId);const attachments=(meta.attachments||[]).filter(item=>!(item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)));
    attachments.push({attachmentType:"pull_request",identityKey:key,payload:link});
    const dismissed=(meta.dismissedPullRequestKeys||[]).filter(item=>item!==key);
    const legacy=attachments.filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload);
    state.updateThreadMeta(threadId,{attachments,dismissedPullRequestKeys:dismissed,linkedPullRequests:legacy,autoSettlePending:null,autoSettleAppliedSignature:null});
    return {key,links:threadPullRequestLinks(threadId)};
  }
  function removePullRequestLink(threadId,identity){
    const key=pullRequestIdentityKey(identity);if(!key)throw new Error("Pull request identity is incomplete");
    const meta=state.threadMeta(threadId);const attachments=(meta.attachments||[]).filter(item=>!(item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)));
    const dismissed=[...new Set([...(meta.dismissedPullRequestKeys||[]),key])];
    const legacy=attachments.filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload);
    state.updateThreadMeta(threadId,{attachments,dismissedPullRequestKeys:dismissed,linkedPullRequests:legacy,autoSettlePending:null});
    return {key,links:threadPullRequestLinks(threadId)};
  }
  function reversePullRequestLinks(identity){
    const key=pullRequestIdentityKey(identity);if(!key)return[];
    const externalThreads=new Map(agentThreads.list().map(thread=>[thread.id,thread]));
    const results=[];
    for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
      if(!(meta.attachments||[]).some(item=>item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)))continue;
      const thread=externalThreads.get(threadId);
      results.push({threadId,title:thread?.name||thread?.preview||meta.title||null,cwd:thread?.cwd||meta.cwd||null,archived:Boolean(thread?.archived||meta.archived)});
    }
    return results;
  }
  async function syncThreadPullRequestLinks(threadId){
    const meta=state.threadMeta(threadId);const attachments=meta.attachments||[];
    const pullAttachments=attachments.filter(item=>item?.attachmentType==="pull_request");
    if(!pullAttachments.length)return {threadId,links:[]};
    const dismissed=new Set(meta.dismissedPullRequestKeys||[]);const synced=new Map();
    for(const attachment of pullAttachments){
      const original=attachment.payload||{};const identity=normalizePullRequestIdentity(original.identity||original);
      if(!identity){synced.set(attachment.identityKey,attachment);continue}
      try{
        const resolved=await resolvePullRequestIdentity(identity);
        const detail=resolved.detail.item;const updated=buildPullRequestLink({...detail,linkedAt:original.linkedAt},{source:original.source||"manual"});
        const updatedKey=pullRequestIdentityKey(updated);synced.set(updatedKey,{attachmentType:"pull_request",identityKey:updatedKey,payload:updated});
        const layers=Array.isArray(detail.stack?.layers)?detail.stack.layers:[];
        for(const layer of layers){
          const layerIdentity={...identity,number:Number(layer.number)};const layerKey=pullRequestIdentityKey(layerIdentity);
          if(!layerKey||dismissed.has(layerKey)||synced.has(layerKey))continue;
          const existing=pullAttachments.find(item=>item.identityKey===layerKey);
          try{
            const layerDetail=Number(layer.number)===Number(detail.number)?detail:await inSourceControlEnvironment(resolved.project.environmentId||null,()=>pullRequestDetail(resolved.project.path,layer.number,{provider:identity.provider}));
            if(!layerDetail?.ok||!layerDetail.item)continue;
            const layerLink=buildPullRequestLink({...layerDetail.item,linkedAt:existing?.payload?.linkedAt},{source:existing?.payload?.source||"stack"});
            synced.set(layerKey,{attachmentType:"pull_request",identityKey:layerKey,payload:layerLink});
          }catch{}
        }
      }catch{synced.set(attachment.identityKey,attachment)}
    }
    const nonPr=attachments.filter(item=>item?.attachmentType!=="pull_request");const next=[...nonPr,...synced.values()];
    const legacy=[...synced.values()].map(item=>item.payload);
    const lifecycle=linkedPullRequestTerminalStatus(legacy);const settings=state.settings();
    const patch={attachments:next,linkedPullRequests:legacy,lastPullRequestSyncAt:Date.now()};
    if(!lifecycle.terminal){
      patch.autoSettlePending=null;
      if(meta.autoSettleAppliedSignature)patch.autoSettleAppliedSignature=null;
    }else if(settings.autoSettleMergedThreads&&meta.autoSettleAppliedSignature!==lifecycle.signature){
      patch.autoSettlePending={signature:lifecycle.signature,requestedAt:Date.now(),reason:"pull_requests_terminal"};
    }
    state.updateThreadMeta(threadId,patch);
    return {threadId,links:threadPullRequestLinks(threadId),lifecycle,pendingSettlement:patch.autoSettlePending||null};
  }
  const syncBranchPullRequests=createBranchPullRequestSweep({
    state,pullRequestForBranch,inEnvironment:inSourceControlEnvironment,repositoryIdentity:sourceControlRepositoryIdentity,listPullRequests,
  });
  function remoteEnvironmentProfile(environmentId){
    const profile=environmentId?environments.get(environmentId):null;
    return profile&&profile.type!=="local"?profile:null;
  }
  async function ensureGeneralWorkspace(environmentId=null){
    const profile=remoteEnvironmentProfile(environmentId);
    if(!profile){
      const path=join(trebellHome(env),"general");
      await mkdir(path,{recursive:true});
      return {path,environmentId:null,environmentName:"Local machine",remote:false};
    }
    const result=await environments.execute(environmentId,{
      command:'root="$HOME/.trebell-code/general"; mkdir -p "$root" && printf "%s" "$root"',
      cwd:"",timeoutMs:12000,maxOutput:64*1024,
    });
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not prepare the general-chat workspace");
    const path=String(result.stdout||"").trim();
    if(!path)throw new Error("The selected environment did not report its general-chat workspace");
    return {path,environmentId:profile.id,environmentName:profile.name,remote:true};
  }
  function pathInside(rootPath,filePath,{remote=false}={}){
    if(remote){
      const base=posix.normalize(String(rootPath||"/"));const target=posix.normalize(String(filePath||""));
      const rel=posix.relative(base,target);return rel===""||(!rel.startsWith("..")&&!posix.isAbsolute(rel));
    }
    const base=resolve(rootPath||process.cwd());const target=resolve(filePath||"");
    const rel=relative(base,target);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));
  }
  // A Codex profile's home on this machine (local-home-path); one under a user this machine does not have is no home to look in.
  function expandLocalHomePath(value){
    const raw=String(value||"").trim();if(!raw)return null;
    const home=localHomePath(raw);return home.error?null:resolve(home.path);
  }
  async function localVisualizationRoots(workspaceRoot){
    const roots=[resolve(workspaceRoot||process.cwd()),join(codexHome(env),"visualizations")];
    const active=agentRuntimes.activeInstance();
    if(active?.kind==="codex"){
      for(const candidate of [active.homePath,active.shadowHomePath]){
        const expanded=expandLocalHomePath(candidate);if(expanded)roots.push(join(expanded,"visualizations"));
      }
    }
    return [...new Set(roots.map(root=>resolve(root)))];
  }
  async function remoteVisualizationRoots(environmentId,workspaceRoot){
    const roots=[posix.normalize(String(workspaceRoot||"/"))];
    const homeResult=await environments.executeArgv(environmentId,{command:"printenv",args:["HOME"],cwd:"",timeoutMs:8000,maxOutput:64*1024}).catch(()=>null);
    const home=String(homeResult?.stdout||"").trim();
    if(home)roots.push(posix.join(home,".codex","visualizations"));
    return [...new Set(roots.map(root=>posix.normalize(root)))];
  }
  async function findLocalVisualization(roots,fileName,threadId=null){
    const wanted=basename(String(fileName||""));if(!wanted)return null;
    let visited=0;const maxVisited=4000;
    async function walk(dir,depth){
      if(depth>8||visited>=maxVisited)return null;
      let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return null}
      for(const entry of entries){
        if(++visited>maxVisited)return null;
        const full=join(dir,entry.name);
        if(entry.isFile()&&entry.name===wanted&&(!threadId||full.includes(String(threadId))))return full;
        if(entry.isDirectory()){const found=await walk(full,depth+1);if(found)return found}
      }
      return null;
    }
    for(const root of roots.slice(1)){const found=await walk(root,0);if(found)return found}
    return null;
  }
  async function resolveVisualizationPath({workspaceRoot,path,file,threadId,environmentId}={}){
    const remote=remoteEnvironmentProfile(environmentId);
    const requested=String(path||file||"").trim();if(!requested)throw new Error("Visualization path is required");
    if(!/\.html?$/i.test(requested))throw new Error("Only HTML visualizations can be rendered");
    if(remote){
      const roots=await remoteVisualizationRoots(environmentId,workspaceRoot||remote.cwd||"/");
      let target=requested.startsWith("/")?posix.normalize(requested):posix.normalize(posix.join(roots[0],requested));
      if(!requested.includes("/")&&file){
        for(const root of roots.slice(1)){
          const args=[root,"-type","f","-name",basename(requested)];
          if(threadId)args.push("-path","*/"+String(threadId)+"/*");
          args.push("-print","-quit");
          const result=await environments.executeArgv(environmentId,{command:"find",args,cwd:"",timeoutMs:12000,maxOutput:128*1024}).catch(()=>null);
          const found=String(result?.stdout||"").split(/\r?\n/).find(Boolean);if(found){target=posix.normalize(found);break}
        }
      }
      if(!roots.some(root=>pathInside(root,target,{remote:true})))throw new Error("Visualization is outside the active workspace and Codex visualization directory");
      return {remote:true,path:target,roots};
    }
    const roots=await localVisualizationRoots(workspaceRoot);
    let target=isAbsolute(requested)?resolve(requested):resolve(roots[0],requested);
    if(!requested.includes("/")&&!requested.includes("\\")&&file){
      const found=await findLocalVisualization(roots,requested,threadId);if(found)target=found;
    }
    if(!roots.some(root=>pathInside(root,target)))throw new Error("Visualization is outside the active workspace and Codex visualization directory");
    return {remote:false,path:target,roots};
  }
  // check: only whether it can be shown (a HEAD request), without reading it.
  async function readVisualization({workspaceRoot,path,file,threadId,environmentId,check=false}={}){
    const located=await resolveVisualizationPath({workspaceRoot,path,file,threadId,environmentId});
    const info=located.remote?await environments.attachmentInfo(environmentId,located.path):await stat(located.path).then(item=>({size:item.size,isFile:item.isFile()}));
    if(info.isFile===false)throw new Error("Visualization path is not a file");
    if(!Number.isFinite(Number(info.size))||Number(info.size)>2*1024*1024)throw new Error("Visualization is too large to render (maximum 2 MB)");
    if(check)return {path:located.path,content:""};
    if(!located.remote)return {path:located.path,content:await readFile(located.path,"utf8")};
    const child=environments.streamFile(environmentId,located.path);let stdout="",stderr="";
    await new Promise((resolveRead,reject)=>{
      child.stdout.on("data",chunk=>{stdout+=String(chunk);if(Buffer.byteLength(stdout,"utf8")>2*1024*1024){try{child.kill()}catch{}reject(new Error("Visualization exceeded the 2 MB render limit"))}});
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-64*1024)});
      child.once("error",reject);child.once("close",code=>code===0?resolveRead():reject(new Error(stderr.trim()||"Could not read visualization")));
    });
    return {path:located.path,content:stdout};
  }
  function worktreeUsage(){
    const activePaths=[],referencedPaths=[];
    for(const thread of agentThreads.list()){
      if(thread.cwd)referencedPaths.push(thread.cwd);
      if(thread.cwd&&(thread.status?.type==="active"||thread.recovery?.pending))activePaths.push(thread.cwd);
    }
    for(const meta of Object.values(state.listThreadMeta())){
      if(meta?.cwd&&!meta.deletedAt)referencedPaths.push(meta.cwd);
      if(meta?.cwd&&!meta.deletedAt&&meta.active)activePaths.push(meta.cwd);
    }
    for(const session of terminals?.list?.()||[])if(session?.cwd&&session.running)activePaths.push(session.cwd);
    return {activePaths,referencedPaths};
  }
  const cleanupLogs=[];
  const worktreeCleanup=new WorktreeCleanupService({state,environments,getUsage:worktreeUsage,log:message=>{cleanupLogs.push({at:Date.now(),stream:"cleanup",text:safeLogText(String(message)+"\n")});if(cleanupLogs.length>100)cleanupLogs.splice(0,cleanupLogs.length-100)}});
  const storageCleanup=new StorageCleanupService({state,env,terminals,worktreeCleanup,log:message=>{cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(String(message)+"\n")});if(cleanupLogs.length>100)cleanupLogs.splice(0,cleanupLogs.length-100)}});
  const cloneJobs=new CloneJobService({state,environments,env,log:message=>appServer?.logs?.push({at:Date.now(),stream:"clone",text:safeLogText(String(message)+"\n")})});
  await cloneJobs.recoverInterrupted();
  const codexAppServers=new Map(),codexAppServerStarts=new Map(),codexThreadServerKeys=new Map(),codexThreadReleases=new Map();
  // "Allow session" on a Codex approval, by thread and permission mode (codex-session-approvals.mjs): a thread's session that ends (it
  // unloads, or its app-server is released or dies) takes it along.
  const codexSessionApprovals=createCodexSessionApprovals();
  const codexPoolKey=(ownerKey,instanceId,environmentId=state.settings().activeEnvironmentId||null)=>String(ownerKey||"catalog")+":"+(environmentId||"local")+":"+String(instanceId||"codex-default");
  function codexInstance(instanceId=null){
    const instances=agentRuntimes.instances();
    if(instanceId){const exact=instances.find(item=>item.kind==="codex"&&item.id===instanceId);if(exact)return exact}
    const active=agentRuntimes.activeInstance();if(active?.kind==="codex")return active;
    return instances.find(item=>item.kind==="codex")||null;
  }
  // A thread's own app-server that could not start is not launched again by every request about the thread: an app that connects
  // again reopens the thread with several requests, and again at each retry. For CODEX_THREAD_START_RETRY_MS its failure answers
  // them, and the first request after that launches Codex once more.
  const CODEX_THREAD_START_RETRY_MS=10_000;
  async function ensureCodexAppServer(instanceId=null,{environmentId=state.settings().activeEnvironmentId||null,preferredPort=null,ownerKey="catalog"}={}){
    const instance=codexInstance(instanceId);if(!instance)throw new Error("Codex runtime profile was not found");
    const key=codexPoolKey(ownerKey,instance.id,environmentId);const current=codexAppServers.get(key);
    if(current&&(mock||(!current.error&&current.child&&!childEnded(current.child))))return current;
    if(current?.error&&current.failedAt&&String(ownerKey).startsWith("thread:")&&Date.now()-current.failedAt<CODEX_THREAD_START_RETRY_MS)return current;
    if(codexAppServerStarts.has(key))return codexAppServerStarts.get(key);
    const starting=(async()=>{
      if(current){await stopAppServer(current);codexAppServers.delete(key)}
      if(preferredPort&&!mock&&!await tcpPortFree(preferredPort))throw new Error(`The Codex app-server port ${preferredPort} (TREBELL_APP_SERVER_PORT or --app-port) is in use by another program`);
      const targetPort=preferredPort||await freeTcpPort();
      const started=await startAppServer({appPort:targetPort,env,mock,environments,environmentId,runtimeInstance:instance,runtimeEnvironmentNames:agentRuntimes.childEnvironmentKeys(instance),command:agentRuntimes.executable(instance,{environmentId})});
      started.poolKey=key;started.ownerKey=ownerKey;started.runtimeInstanceId=instance.id;started.environmentId=environmentId||null;started.continuationKey=agentRuntimes.continuationKey(instance);
      codexAppServers.set(key,started);
      started.child?.once("exit",(code,signal)=>noteCodexAppServerExit(started,code,signal));
      if(!mock){const ready=await waitForAppServer(started,targetPort,15000).catch(()=>false);if(!ready&&!started.error)started.error=appServerStartError(started,instance.displayName||instance.id);if(ready)started.readyAt=Date.now()}
      if(started.error)started.failedAt=Date.now();
      return started;
    })();
    codexAppServerStarts.set(key,starting);
    try{return await starting}finally{codexAppServerStarts.delete(key)}
  }
  // A private app-server for one-shot Git text: no relay connection shares it, so its ephemeral thread is never announced
  // to the UI or recorded in thread metadata, and stopping it afterwards leaves nothing behind. A profile or environment
  // restart leaves it running (stopCodexAppServers keepGitText); the request releases it.
  async function dedicatedCodexAppServer(instanceId,environmentId=null){
    const server=await ensureCodexAppServer(instanceId,{environmentId,ownerKey:"git-text:"+randomUUID()});
    const release=async()=>{if(codexAppServers.get(server.poolKey)===server)codexAppServers.delete(server.poolKey);await stopAppServer(server)};
    if(server?.error||!server?.targetUrl){await release().catch(()=>{});throw new Error(server?.error||"Codex app-server is unavailable")}
    return {url:server.targetUrl,token:server.wsToken||null,release};
  }
  // keepGitText leaves the private Git text app-servers running: a profile or environment switch must not kill a request in flight, which
  // already snapshotted its runtime profile and environment and releases its own server. Shutdown (close) stops every server.
  async function stopCodexAppServers({keepGitText=false}={}){
    if(codexThreadReleases.size)await Promise.allSettled([...codexThreadReleases.values()]);
    const keys=[...codexAppServers.keys()].filter(key=>!keepGitText||!key.startsWith("git-text:")),servers=keys.map(key=>codexAppServers.get(key));
    for(const key of keys)codexAppServers.delete(key);
    codexThreadServerKeys.clear();codexThreadReleases.clear();codexSessionApprovals.clear();
    await Promise.all(servers.map(server=>stopAppServer(server)));
  }
  async function releaseCodexThreadServer(threadId){
    const id=String(threadId||"").trim();if(!id)return;
    if(codexThreadReleases.has(id))return codexThreadReleases.get(id);
    codexSessionApprovals.end(id);
    const releasing=(async()=>{
      const key=codexThreadServerKeys.get(id);codexThreadServerKeys.delete(id);if(!key)return;
      const server=codexAppServers.get(key);codexAppServers.delete(key);codexAppServerStarts.delete(key);
      if(server)await stopAppServer(server);
    })();
    codexThreadReleases.set(id,releasing);
    try{return await releasing}finally{if(codexThreadReleases.get(id)===releasing)codexThreadReleases.delete(id)}
  }
  // The catalog app-server answers the Codex transport's requests that name no thread (initialize, thread/list, model/list,
  // account/read), the Codex model catalog and Codex history import. No other runtime uses it, and Git text starts its own. So it
  // starts with Codex active or with the first request that needs it, and the server listens without waiting for its boot (a Codex
  // app-server and its console host, 48-80 MB, about 0.9 s to answer). Until then appServer holds only the runtime log the other
  // services write to. Mock mode's catalog is a stub with no process, so it is there from the start as before.
  let appServer={logs:[],idle:true},appServerStart=null,closing=false;
  const catalogInstanceId=()=>agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance().id:null;
  function catalogAppServer(){
    if(closing)return Promise.reject(new Error("Trebell is shutting down"));
    // One that has exited, or could not start, starts again with the next request that needs it, as T3 starts Codex again once its
    // process has exited.
    const child=appServer.child;
    if(appServerStart&&!appServer.error&&!(child&&(child.exitCode!==null||child.signalCode!==null)))return appServerStart;
    // A start that throws (no Codex profile, a Codex home it cannot prepare) leaves a server that says why, as one that never became
    // ready does. A restart replaces the start, and one it replaced does not overwrite what replaced it.
    const start=appServerStart=ensureCodexAppServer(catalogInstanceId(),{preferredPort:appPort,ownerKey:"catalog"})
      .catch(error=>({child:null,logs:[],targetUrl:null,readyUrl:null,environment:null,appPort,error:error instanceof Error?error.message:String(error)}))
      .then(server=>{if(appServerStart===start){if(appServer.idle)server.logs.unshift(...appServer.logs.slice(-250));appServer=server}return server});
    return start;
  }
  if(mock)await catalogAppServer();else if(agentRuntimes.activeRuntime()==="codex")catalogAppServer().catch(()=>{});
  // What the catalog app-server reports, known before it starts: the remote environment it runs in, and the Codex homes it runs on
  // (startAppServer), whose sessions the history scan leaves out because Codex lists them itself.
  function catalogEnvironment(){
    if(!appServer.idle)return appServer.environment||null;
    const id=state.settings().activeEnvironmentId||null,profile=id?environments.get(id):null;
    return profile&&profile.type!=="local"?{id:profile.id,name:profile.name,type:profile.type,cwd:profile.cwd||""}:null;
  }
  function catalogCodexHomes(){
    if(!appServer.idle)return [appServer.runtimeHome,appServer.sharedRuntimeHome].filter(Boolean);
    const instance=codexInstance(catalogInstanceId());if(!instance||catalogEnvironment())return [];
    const layout=resolveCodexHomeLayout(codexHomeConfig(instance,env));
    return [layout.effectiveHomePath,layout.sharedHomePath].filter(Boolean);
  }

  function providerReady(providerId=selectedProvider){
    return mock || providers.hasKey(providerId);
  }
  async function bootstrapPayload(req,{agentSnapshot=null}={}){
    // Codex is ready once its catalog is, so a Codex bootstrap waits for the boot the server no longer waits for.
    if(selectedAgentRuntime==="codex")await catalogAppServer().catch(()=>{});
    const appReady=mock || await appServerReady(appServer,appPort);
    const activeAgentInstance=agentRuntimes.activeInstance();
    const activeAgentStatus=agentSnapshot?.statuses?.find(item=>item.id===activeAgentInstance?.id)
      || await agentRuntimes.probe(activeAgentInstance).catch(()=>null);
    const runtimeReady=selectedAgentRuntime==="codex"
      ?Boolean(appReady&&activeAgentStatus?.available)
      :Boolean(activeAgentStatus?.available);
    return {
      mock,
      agentRuntime:selectedAgentRuntime,
      agentRuntimeInstanceId:activeAgentInstance?.id||`${selectedAgentRuntime}-default`,
      runtimeCapabilities:agentRuntimes.capabilities(activeAgentInstance),
      agentRuntimeReady:mock||runtimeReady,
      agentRuntimeStatus:activeAgentStatus,
      provider:selectedProvider,
      providerReady:providerReady(),
      appServerReady:appReady,
      wsUrl:mock ? null : (env.TREBELL_GUI_PUBLIC==="1"
        ? `${String(req.headers["x-forwarded-proto"]||"https").split(",")[0].trim()==="https"?"wss":"ws"}://${String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim()}${selectedAgentRuntime==="codex"?"/api/codex/ws":"/api/agent/ws"}`
        : `ws://127.0.0.1:${port}${selectedAgentRuntime==="codex"?"/api/codex/ws":"/api/agent/ws"}`),
      cwd:process.cwd(),
      platform:process.platform,
      version:TREBELL_VERSION,
      activeEnvironment:catalogEnvironment(),
      appServerError:appServer?.error||null,
    };
  }
  function codexGoalTurns(meta={}){
    const completed=Array.isArray(meta.codexTurnTimings)?meta.codexTurnTimings:[],recovery=meta.restartRecovery;
    if(recovery?.runtime!=="codex"||recovery?.status!=="active"||!recovery.turnId||!Number(recovery.startedAt))return completed;
    return [...completed,{id:String(recovery.turnId),startedAt:Math.floor(Number(recovery.startedAt)/1000),durationMs:null,status:"inProgress"}];
  }
  function durableCodexGoal(threadId){
    const meta=state.threadMeta(threadId),raw=meta?.goal;if(!raw)return null;
    const createdAt=Number(raw.createdAt)||Date.now(),goal=normalizeGoal({threadId,previous:{...raw,createdAt},patch:{},now:Number(raw.updatedAt)||Date.now()});
    // A goal mirrored from Codex keeps Codex's own status (blocked, usageLimited, budgetLimited) and token accounting, and why Trebell
    // paused it (codexGoalRecord).
    const nativeStatus=raw.native?codexGoalStatus(raw.status):null;if(nativeStatus)goal.status=nativeStatus;if(goal.status==="paused"&&raw.pauseReason)goal.pauseReason=raw.pauseReason;
    const usage=state.threadUsage(threadId,{since:goal.createdAt});
    const baselines=meta?.goalBudgetBaselines||null;
    const toolCallsUsed=baselines?Math.max(0,Number(meta?.codexToolCallCount||0)-Number(baselines.toolCalls||0)):0;
    const childAgentsUsed=baselines?Math.max(0,Number(meta?.codexChildAgentCount||0)-Number(baselines.childAgents||0)):0;
    return enrichGoal(goal,{
      usage:raw.native?{...(usage||{}),totalTokens:raw.native.tokensUsed}:usage,turns:codexGoalTurns(meta),
      toolCallsUsed,toolCallTelemetryComplete:Boolean(baselines?.toolCallTelemetryComplete),
      childAgentsUsed,childAgentTelemetryComplete:Boolean(baselines?.childAgentTelemetryComplete),
    });
  }
  // Codex threads use Codex's own goal (T3 runGoalCommand). Trebell mirrors it into the thread's record, next to its own
  // guidance and extra budgets, and the renderer gets Codex's goal with those added. Tool-call and child-agent use count
  // from when Trebell saw the goal start; a goal it did not see start reports incomplete telemetry.
  function mirrorCodexGoal(threadId,nativeGoal,{patch={},fresh=false}={}){
    const meta=state.threadMeta(threadId);
    if(!nativeGoal){if(meta?.goal)state.updateThreadMeta(threadId,{goal:null,goalBudgetBaselines:undefined});return null}
    const goal=codexGoalRecord(nativeGoal,{threadId,previous:fresh?null:meta?.goal||null,patch});if(!goal)return null;
    const baselines=(!fresh&&meta?.goalBudgetBaselines)||{toolCalls:Math.max(0,Number(meta?.codexToolCallCount)||0),childAgents:Math.max(0,Number(meta?.codexChildAgentCount)||0),toolCallTelemetryComplete:fresh,childAgentTelemetryComplete:fresh};
    state.updateThreadMeta(threadId,{goal,goalBudgetBaselines:baselines});
    return durableCodexGoal(threadId);
  }
  const codexGoalRoute=threadId=>({routeMessage:{method:"thread/goal/get",params:{threadId}}});
  // A Trebell goal Codex never had (a delegated task's goal, or one set before Codex goals were used) stays Trebell's
  // own until it is next changed; a mirrored goal Codex no longer has was cleared in Codex.
  function trebellOnlyCodexGoal(threadId){const goal=state.threadMeta(threadId)?.goal;return goal&&!goal.native?goal:null}
  async function readCodexGoal(threadId,requestUpstream){
    const nativeGoal=(await requestUpstream("thread/goal/get",{threadId},codexGoalRoute(threadId)))?.goal||null;
    if(!nativeGoal&&trebellOnlyCodexGoal(threadId))return durableCodexGoal(threadId);
    return mirrorCodexGoal(threadId,nativeGoal);
  }
  // The goal writes on their way, by thread (setCodexGoal): Codex's own notifications of the steps between stay from the windows,
  // which get the goal as it ends up. A replaced goal read cleared in the Goal panel, then paused, before its first turn started
  // (T3 goalUpdatesHeld).
  const codexGoalWrites=new Map();
  function codexGoalWriting(threadId){
    codexGoalWrites.set(threadId,(codexGoalWrites.get(threadId)||0)+1);
    return ()=>{const left=(codexGoalWrites.get(threadId)||1)-1;if(left>0)codexGoalWrites.set(threadId,left);else codexGoalWrites.delete(threadId)};
  }
  async function setCodexGoal(threadId,patch,requestUpstream){
    const written=codexGoalWriting(threadId);let cleared=false;
    try{
      const route=codexGoalRoute(threadId),current=(await requestUpstream("thread/goal/get",{threadId},route))?.goal||null;
      const meta=state.threadMeta(threadId),trebellOnly=current?null:trebellOnlyCodexGoal(threadId);
      const previous=current?codexGoalRecord(current,{threadId,previous:meta?.goal||null}):trebellOnly;
      // The whole patch (objective, budgets) is checked before any of it reaches Codex.
      const next=normalizeGoal({threadId,previous,patch});
      const {replace,params}=codexGoalSetParams({threadId,patch,current,next});
      if(replace){await requestUpstream("thread/goal/clear",{threadId},route);cleared=true}
      // A patch of Trebell's own guidance or budgets alone leaves Codex's goal as it is.
      const result=Object.keys(params).some(key=>key!=="threadId")?await requestUpstream("thread/goal/set",params,route):{goal:current};
      const goal=mirrorCodexGoal(threadId,result?.goal||null,{patch,fresh:replace||(!current&&!trebellOnly)});
      relay.broadcast("thread/goal/updated",{threadId,goal});
      return goal;
    }catch(error){
      // A new goal that failed after the old one went leaves none.
      if(cleared){mirrorCodexGoal(threadId,null);relay.broadcast("thread/goal/updated",{threadId,goal:null})}
      throw error;
    }finally{written()}
  }
  async function clearCodexGoal(threadId,requestUpstream){
    const result=await requestUpstream("thread/goal/clear",{threadId},codexGoalRoute(threadId));
    mirrorCodexGoal(threadId,null);relay.broadcast("thread/goal/updated",{threadId,goal:null});
    return {ok:true,cleared:Boolean(result?.cleared)};
  }
  // Codex continues an active goal with turns of its own, which never pass Trebell's budget gate. Once a budget only
  // Trebell tracks (time, turns, tool calls, cost) runs out, the goal is paused so Codex stops after the turn that ended.
  // Codex starts its next goal turn as soon as one ends, so a turn it already started is stopped as T3's Stop does
  // (pause, then interrupt).
  async function pauseCodexGoalOverBudget(threadId,finishedTurnId,requestUpstream){
    const goal=durableCodexGoal(threadId);if(goal?.status!=="active"||!state.threadMeta(threadId)?.goal?.native)return;
    const gate=goalBudgetGate(goal,{includeChildAgents:false});
    if(gate.allowed||!(gate.timeExhausted||gate.turnExhausted||gate.toolCallExhausted||gate.costExhausted))return;
    try{
      const route=codexGoalRoute(threadId),paused=await requestUpstream("thread/goal/set",{threadId,status:"paused"},route);
      mirrorCodexGoal(threadId,paused?.goal||null);
      const running=state.threadMeta(threadId)?.restartRecovery;
      const nextTurnId=running?.runtime==="codex"&&running.status==="active"&&running.turnId&&String(running.turnId)!==String(finishedTurnId||"")?String(running.turnId):null;
      if(nextTurnId)await requestUpstream("turn/interrupt",{threadId,turnId:nextTurnId},route);
      const meta=state.threadMeta(threadId);
      eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId,category:"budget",name:"goal.budget_paused",status:"blocked",data:{reason:gate.reason,timeExhausted:gate.timeExhausted,turnExhausted:gate.turnExhausted,toolCallExhausted:gate.toolCallExhausted,costExhausted:gate.costExhausted,interruptedTurnId:nextTurnId}});
    }catch(error){appServer?.logs?.push({at:Date.now(),stream:"relay",text:safeLogText("Could not pause the Codex goal over budget: "+(error?.message||String(error))+"\n")})}
  }
  // A Codex goal still active once Codex has started no turn for it within the grace after a completed one reads Paused, not Active
  // with nothing running (codex-goal-continuation.mjs). The pause goes on the connection of a window still there of those that saw the
  // turn end or showed the thread during the wait (a window reloaded meanwhile, which opened it again). With none there it is owed,
  // and made by the next window to read the thread's goal, before that read answers. A window that has gone would open a connection
  // no one closes (connected).
  const codexGoalContinuations=createCodexGoalContinuations({expire:(threadId,{turnId,windows=[]})=>{
    const window=windows.find(item=>item.connected?.()!==false);if(!window)return false;
    void pauseUncontinuedCodexGoal(threadId,turnId,window.requestUpstream);
  }});
  async function pauseUncontinuedCodexGoal(threadId,turnId,requestUpstream,{owed=false}={}){
    // A turn that runs, or whose start a window has on its way (a follow-up sent just now), goes on with the thread; so does one Codex
    // says runs when the pause was owed, which it may have started while no window was there to see it start.
    const meta=state.threadMeta(threadId);if(!meta?.goal?.native||meta.goal.status!=="active"||threadTurnRuns(threadId))return;
    const route=codexGoalRoute(threadId);let written=null;
    try{
      if(owed&&(await requestUpstream("thread/read",{threadId,includeTurns:false},route))?.thread?.status?.type==="active")return;
      // The windows get the goal as it ends up, saying why it paused (pauseReason), as a window that reads it later does.
      written=codexGoalWriting(threadId);const paused=await requestUpstream("thread/goal/set",{threadId,status:"paused"},route);
      relay.broadcast("thread/goal/updated",{threadId,goal:mirrorCodexGoal(threadId,paused?.goal||null,{patch:{pauseReason:"continuationExpired"}})});
      eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta.environmentId??state.settings().activeEnvironmentId??null,threadId,turnId,category:"goal",name:"goal.continuation_expired",status:"paused",data:{completedTurnId:turnId,graceMs:CODEX_GOAL_CONTINUATION_GRACE_MS,owed}});
    }catch(error){appServer?.logs?.push({at:Date.now(),stream:"relay",text:safeLogText("Could not pause the Codex goal Codex stopped working toward: "+(error?.message||String(error))+"\n")})}
    finally{written?.()}
  }
  function durableCodexContinuity(threadId){
    const meta=state.threadMeta(threadId);
    const restart=meta?.restartRecovery,status=String(restart?.status||"");
    const recovery=restart?.runtime==="codex"&&["pending","blocked","interrupted","error"].includes(status)?{
      pending:status==="pending",blocked:status==="blocked",turnId:restart.turnId||null,reason:restart.reason||null,message:restart.message||null,uncertainTools:Array.isArray(restart.uncertainTools)?restart.uncertainTools:[],
    }:null;
    return continuitySnapshot({
      threadId,thread:{id:threadId,cwd:meta?.cwd||null,runtime:"codex",runtimeInstanceId:meta?.runtimeInstanceId||null,turns:codexGoalTurns(meta),recovery},meta,goal:durableCodexGoal(threadId),
      verificationRecords:state.verificationRecords({threadId,limit:10}),
      checkpoints:state.checkpoints(threadId),
      traces:eventJournal.list({threadId,limit:80}),
    });
  }
  function codexVerificationState(threadId,recordId=null){
    const records=state.verificationRecords({threadId,limit:50});
    if(!records.length)return {record:null,nextAction:null};
    return verificationRepairState(records,recordId);
  }
  async function createCodexVerificationCheckpoint(threadId,label){
    const meta=state.threadMeta(threadId);if(!meta?.cwd)return null;
    try{
      const checkpoint=await checkpoints.create({cwd:meta.cwd,threadId,label,environmentId:meta.environmentId??null});
      recordCheckpointTrace(checkpoint?.supported===false?"checkpoint.skipped":"checkpoint.created",checkpoint?.supported===false?"unsupported":"completed",checkpoint,{threadId,reason:checkpoint?.reason||null});
      return checkpoint?.supported===false?null:checkpoint;
    }catch(error){recordCheckpointTrace("checkpoint.create_failed","error",null,{threadId,message:error.message});return null}
  }
  function linkCodexVerificationCheckpoint(checkpoint,turnId){
    if(!checkpoint?.id||!turnId)return null;
    try{const linked=checkpoints.link(checkpoint.id,{turnId});recordCheckpointTrace("checkpoint.linked","completed",linked,{checkpointId:checkpoint.id,turnId});return linked}
    catch(error){recordCheckpointTrace("checkpoint.link_failed","error",checkpoint,{checkpointId:checkpoint.id,turnId,message:error.message});return null}
  }
  async function repairCodexVerification(threadId,params,requestUpstream){
    const meta=state.threadMeta(threadId);if(meta.active)throw new Error("Stop the running turn before starting verification repair.");
    assertCodexGoalBudget(threadId);
    const {record,nextAction}=codexVerificationState(threadId,params.recordId||null);
    if(!record)throw new Error("No persisted verification record is available for this thread.");
    if(nextAction.action!=="repair")throw new Error("Latest verification does not require repair (next action: "+nextAction.action+").");
    const repairAttempt=verificationRepairAttempt(meta?.verificationRepairChain,record,{automatic:Boolean(params.auto)}),automationAttempt=verificationAutomationAttempt(meta?.verificationAutomationChain,record,{automatic:Boolean(params.auto),action:"repair"});
    if(!repairAttempt.allowed)throw Object.assign(new Error(`Automatic verification repair stopped after ${repairAttempt.limit} attempts. Review the remaining failure before continuing.`),{code:-32001});
    if(!automationAttempt.allowed)throw Object.assign(new Error(`Automatic verification workflow stopped after ${automationAttempt.limit} actions. Review the remaining verification state before continuing.`),{code:-32001});
    const repairContext=verificationRepairContext({record,nextAction});
    const withGoal=goalAdditionalContext({},durableCodexGoal(threadId));
    const withContinuity=continuityAdditionalContext(withGoal,durableCodexContinuity(threadId));
    const additionalContext={...(withContinuity||{}),"trebell.verification_repair":{kind:"application",value:repairContext}};
    const model=codexThreadModels.get(threadId)||null;
    const turnParams={
      threadId,cwd:meta?.cwd||undefined,approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy,
      input:[{type:"text",text:verificationRepairPrompt(),textElements:[]}],additionalContext,...(model?{model}:{}),
    };
    for(const key of Object.keys(turnParams))if(turnParams[key]===undefined)delete turnParams[key];
    const checkpoint=await createCodexVerificationCheckpoint(threadId,"Verification repair before "+String(record.id||"").slice(0,80));
    const started=await requestUpstream("turn/start",turnParams,{routeMessage:{method:"thread/read",params:{threadId}},timeoutMs:120_000});
    if(started?.turn?.id){linkCodexVerificationCheckpoint(checkpoint,started.turn.id);state.updateThreadMeta(threadId,{verificationRepairChain:verificationRepairChainState(repairAttempt,started.turn.id),...(params.auto?{verificationAutomationChain:verificationAutomationChainState(automationAttempt,started.turn.id)}:{})})}
    eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??null,threadId,turnId:started?.turn?.id||null,category:"verification",name:"verification.repair_started",status:"running",data:{recordId:record.id,nextAction:nextAction.action,failedSteps:nextAction.failedSteps||[],automatic:Boolean(params.auto),attempt:repairAttempt.attempts}});
    return {record,nextAction,turn:started?.turn||null};
  }
  async function continueCodexVerification(threadId,params,requestUpstream){
    const meta=state.threadMeta(threadId);if(meta.active)throw new Error("Stop the running turn before continuing verification.");
    assertCodexGoalBudget(threadId);
    const records=state.verificationRecords({threadId,limit:50}),prepared=verificationContinuationState(records,params.recordId||null),{record,nextAction}=prepared;
    if(nextAction.action!=="verify"||!nextAction.nextStep)throw new Error("Latest verification does not require another verification step (next action: "+nextAction.action+").");
    const continuationAttempt=verificationContinuationAttempt(meta?.verificationContinuationChain,record,{automatic:Boolean(params.auto)}),automationAttempt=verificationAutomationAttempt(meta?.verificationAutomationChain,record,{automatic:Boolean(params.auto),action:"verify"});
    if(!continuationAttempt.allowed)throw Object.assign(new Error(`Automatic verification continuation stopped after ${continuationAttempt.limit} attempts. Review the remaining verification state before continuing.`),{code:-32001});
    if(!automationAttempt.allowed)throw Object.assign(new Error(`Automatic verification workflow stopped after ${automationAttempt.limit} actions. Review the remaining verification state before continuing.`),{code:-32001});
    const continuationContext=verificationContinuationContext(prepared),withGoal=goalAdditionalContext({},durableCodexGoal(threadId)),withContinuity=continuityAdditionalContext(withGoal,durableCodexContinuity(threadId)),additionalContext={...(withContinuity||{}),"trebell.verification_continue":{kind:"application",value:continuationContext}},model=codexThreadModels.get(threadId)||null;
    const turnParams={threadId,cwd:meta?.cwd||undefined,approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy,input:[{type:"text",text:verificationContinuationPrompt(),textElements:[]}],additionalContext,...(model?{model}:{})};for(const key of Object.keys(turnParams))if(turnParams[key]===undefined)delete turnParams[key];
    const started=await requestUpstream("turn/start",turnParams,{routeMessage:{method:"thread/read",params:{threadId}},timeoutMs:120_000});
    if(started?.turn?.id)state.updateThreadMeta(threadId,{verificationContinuationChain:verificationContinuationChainState(continuationAttempt,started.turn.id),...(params.auto?{verificationAutomationChain:verificationAutomationChainState(automationAttempt,started.turn.id)}:{})});
    eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??null,threadId,turnId:started?.turn?.id||null,category:"verification",name:"verification.continuation_started",status:"running",data:{recordId:record.id,nextStepId:nextAction.nextStep?.id||null,automatic:Boolean(params.auto),attempt:continuationAttempt.attempts}});
    return {record,nextAction,turn:started?.turn||null};
  }
  function assertCodexGoalBudget(threadId){
    const goal=durableCodexGoal(threadId),gate=goalBudgetGate(goal,{includeChildAgents:false});if(gate.allowed)return goal;
    const meta=state.threadMeta(threadId);
    eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId,category:"budget",name:"goal.budget_blocked",status:"blocked",data:{goalStatus:goal?.status||null,tokenBudget:goal?.tokenBudget??null,tokensUsed:goal?.tokensUsed??0,timeBudgetMinutes:goal?.timeBudgetMinutes??null,timeUsedSeconds:goal?.timeUsedSeconds??0,turnBudget:goal?.turnBudget??null,turnsUsed:goal?.turnsUsed??0,toolCallBudget:goal?.toolCallBudget??null,toolCallsUsed:goal?.toolCallsUsed??0,toolCallTelemetryComplete:goal?.toolCallTelemetryComplete??true,childAgentBudget:goal?.childAgentBudget??null,childAgentsUsed:goal?.childAgentsUsed??null,childAgentTelemetryComplete:goal?.childAgentTelemetryComplete??false,costBudgetUsd:goal?.costBudgetUsd??null,costUsedUsd:goal?.costUsedUsd??null,costTelemetryComplete:goal?.costTelemetryComplete??true,tokenExhausted:gate.tokenExhausted,timeExhausted:gate.timeExhausted,turnExhausted:gate.turnExhausted,toolCallExhausted:gate.toolCallExhausted,childAgentExhausted:gate.childAgentExhausted,costExhausted:gate.costExhausted}});
    throw Object.assign(new Error(gate.reason),{code:-32001});
  }
  const pendingDelegations=new Map();
  function reserveCodexDelegation(threadId){
    const goal=durableCodexGoal(threadId),pending=Math.max(0,Number(pendingDelegations.get(threadId))||0);
    if(goal?.childAgentBudget!=null&&goal.childAgentTelemetryComplete&&Number(goal.childAgentsUsed||0)+pending>=Number(goal.childAgentBudget)){
      throw Object.assign(new Error(`Goal budget exhausted: child-agent budget exhausted (${Number(goal.childAgentsUsed||0)+pending}/${goal.childAgentBudget}). Increase the exhausted budget before delegating more work.`),{code:-32001});
    }
    assertCodexGoalBudget(threadId);
    pendingDelegations.set(threadId,pending+1);
    return ()=>{const next=Math.max(0,(Number(pendingDelegations.get(threadId))||1)-1);if(next)pendingDelegations.set(threadId,next);else pendingDelegations.delete(threadId)};
  }
  async function prepareCodexDelegationWorkspace(parentThreadId,spec,parentThread=null){
    const meta=state.threadMeta(parentThreadId),sourceCwd=String(meta?.cwd||parentThread?.cwd||"").trim();
    if(!sourceCwd)throw new Error("Delegation requires a parent workspace");
    if(spec.isolation==="inherit")return {cwd:sourceCwd,branch:meta?.branch||null,isolation:"inherit",worktree:false};
    const environmentId=meta?.environmentId??parentThread?.providerMeta?.environmentId??null;
    const info=environmentId?await inSourceControlEnvironment(environmentId,()=>sourceControlGitInfo(sourceCwd)):await gitInfo(sourceCwd);if(!info.isGit)throw new Error("Worktree delegation requires a Git workspace");if(!info.branch)throw new Error("Worktree delegation requires a checked-out base branch");
    const label=spec.label||spec.model||spec.task.split(/\s+/).slice(0,4).join("-");
    const slug=String(label||"agent").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,28)||"agent";
    const stamp=Date.now().toString(36)+randomBytes(2).toString("hex");
    const branch=`trebell/delegate-${slug}-${stamp}`,path=info.root+`-trebell-delegate-${slug}-${stamp}`;
    const sourceProject=state.project(environmentId?sourceCwd:resolve(sourceCwd),environmentId),scoped=sourceProject?state.projectSettings(sourceProject.path,environmentId):{defaults:state.environmentDefaults(environmentId),overrides:{}};
    const submodules=scoped.overrides.worktreeSubmodules||scoped.defaults.worktreeSubmodules||"recursive";
    let created=null;
    try{
      created=await createDelegationWorktree({
        sourceCwd,environmentId,branch,path,baseBranch:info.branch,submodules,
        createLocal:createWorktree,removeLocal:removeWorktree,
        runRemoteGit:environmentId?action=>inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(sourceCwd,action)):null,
        executeRemoteArgv:environmentId?options=>environments.executeArgv(environmentId,options):null,
      });
      const inherited=sourceProject?{
        defaultModel:sourceProject.defaultModel??null,permissionMode:sourceProject.permissionMode??null,workspaceMode:sourceProject.workspaceMode??null,
        worktreeSubmodules:sourceProject.worktreeSubmodules??null,worktreeCleanup:sourceProject.worktreeCleanup??null,settingsOverrides:sourceProject.settingsOverrides||{},
        icon:sourceProject.icon??null,scripts:sourceProject.scripts||[],preferredScriptId:sourceProject.preferredScriptId??null,hooks:sourceProject.hooks||[],
      }:{};
      state.touchProject(created.worktree,{...inherited,environmentId:environmentId||null,managedWorktree:{root:created.info?.root||info.root,branch,baseBranch:info.branch,submodules,createdAt:Date.now(),cleanedAt:null,cleanupReason:null}});
      const setup=(sourceProject?.scripts||[]).find(script=>script.runOnWorktreeCreate);
      let setupSession=null;
      if(setup&&!mock&&terminals){
        if(environmentId){
          const remote=environments.terminalArgvSpec(environmentId,{command:"sh",args:["-lc",String(setup.command||"")],cwd:created.worktree}),profile=environments.get(environmentId);
          setupSession=await terminals.create({cwd:remote.cwd,displayCwd:created.worktree,name:`${setup.name||"Setup"} · delegated setup`,cols:120,rows:32,shell:remote.shell,args:remote.args,env:remoteTransportEnvironment(env,{platform:process.platform}),replaceEnv:true,endsTree:true,environmentId:remote.environmentId,environmentName:remote.environmentName||profile?.name||"Remote environment",environmentType:remote.environmentType||profile?.type||"remote"});
        }else{
          const shell=commandShellSpec(setup.command,env);
          setupSession=await terminals.create({cwd:created.worktree,name:`${setup.name||"Setup"} · delegated setup`,cols:120,rows:32,shell:shell.shell,args:shell.args,endsTree:true});
        }
        if(setup.waitForSetup){
          const settled=await terminals.waitForExit(setupSession.id,{timeoutMs:30*60_000});
          if(settled.timeout)throw new Error("Delegated worktree setup is still running after 30 minutes");
          if(settled.exitCode!==0)throw new Error(`Delegated worktree setup failed with exit code ${settled.exitCode??"unknown"}`);
        }
      }
      return {cwd:created.worktree,branch,isolation:"worktree",worktree:true,baseBranch:info.branch,environmentId:environmentId||null,setupSessionId:setupSession?.id||null};
    }catch(error){
      if(created?.worktree)await cleanupDelegationWorktree({sourceCwd,worktreePath:created.worktree,environmentId,removeLocal:removeWorktree,runRemoteGit:environmentId?action=>inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(sourceCwd,action)):null}).catch(()=>{});
      throw error;
    }
  }

  async function cleanupPreparedDelegationWorkspace(workspace,parentThread=null){
    if(!workspace?.worktree)return;
    const parentId=String(parentThread?.id||""),parentMeta=parentId?state.threadMeta(parentId):{},sourceCwd=String(parentMeta?.cwd||parentThread?.cwd||workspace.cwd||"").trim(),environmentId=parentMeta?.environmentId??parentThread?.providerMeta?.environmentId??workspace.environmentId??null;
    await cleanupDelegationWorktree({sourceCwd,worktreePath:workspace.cwd,environmentId,removeLocal:removeWorktree,runRemoteGit:environmentId?action=>inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(sourceCwd,action)):null});
  }
  async function delegateCodexThread(params,requestUpstream){
    const parentThreadId=String(params.threadId||params.parentThreadId||"").trim();if(!parentThreadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
    const parentMeta=state.threadMeta(parentThreadId);
    return executeDelegation({
      parentThreadId,request:params,
      reserve:()=>reserveCodexDelegation(parentThreadId),
      prepareWorkspace:({spec})=>prepareCodexDelegationWorkspace(parentThreadId,spec),
      startThread:async({spec,workspace})=>{
        const model=spec.model||codexThreadModels.get(parentThreadId)||null,policy=delegationPolicies(spec.permissions,workspace.cwd);
        const startParams={cwd:workspace.cwd,approvalPolicy:policy.approvalPolicy,sandbox:policy.sandbox,ephemeral:false,threadSource:"trebell-delegate",...(model?{model}:{})};
        const started=await requestUpstream("thread/start",startParams,{routeMessage:{method:"thread/read",params:{threadId:parentThreadId}},timeoutMs:120_000});
        return started?.thread||null;
      },
      configureChild:async({spec,workspace,childThread,delegationId})=>{
        const childId=String(childThread.id),model=spec.model||codexThreadModels.get(parentThreadId)||childThread.model||null,goal=normalizeGoal({threadId:childId,patch:delegationGoalPatch(spec)});
        state.updateThreadMeta(childId,{
          cwd:workspace.cwd,branch:workspace.branch||null,runtime:"codex",runtimeInstanceId:parentMeta?.runtimeInstanceId||null,environmentId:parentMeta?.environmentId??null,
          permissionProfile:agentPermissionModeFromStart({permissionProfile:spec.permissions}),
          parentThreadId,delegation:{id:delegationId,parentThreadId,task:spec.task,permission:spec.permissions,requestedPermission:spec.permission,isolation:spec.isolation==="inherit"?"shared":"worktree",requestedIsolation:spec.requestedIsolation,ownership:spec.ownership,model,createdAt:Date.now(),status:"running"},
          goal,goalBudgetBaselines:{toolCalls:0,childAgents:0,toolCallTelemetryComplete:true,childAgentTelemetryComplete:true},
        });
        const parentServerKey=codexThreadServerKeys.get(parentThreadId);if(parentServerKey)codexThreadServerKeys.set(childId,parentServerKey);
        recordCodexChildAgentEvidence(state,{id:childId,parentThreadId});codexThreadModels.set(childId,model||null);
      },
      startTurn:async({spec,workspace,childThread})=>{
        const model=spec.model||codexThreadModels.get(parentThreadId)||childThread.model||null,policy=delegationPolicies(spec.permissions,workspace.cwd);
        const delegationContext=delegationContextValue({parentThreadId,spec});
        const turnParams={threadId:String(childThread.id),cwd:workspace.cwd,approvalPolicy:policy.approvalPolicy,sandboxPolicy:policy.sandboxPolicy,input:[{type:"text",text:spec.task,textElements:[]}],additionalContext:{"trebell.delegation":{kind:"application",value:delegationContext}},...(model?{model}:{})};
        const turnStarted=await requestUpstream("turn/start",turnParams,{routeMessage:{method:"thread/read",params:{threadId:String(childThread.id)}},timeoutMs:120_000});
        state.updateThreadMeta(String(childThread.id),{delegation:{...state.threadMeta(String(childThread.id)).delegation,turnId:turnStarted?.turn?.id||null}});
        return turnStarted?.turn||null;
      },
      cleanupWorkspace:async({workspace})=>{if(workspace?.worktree)await cleanupPreparedDelegationWorkspace(workspace,{id:parentThreadId,cwd:parentMeta?.cwd||workspace.cwd,providerMeta:{environmentId:parentMeta?.environmentId??null}}).catch(()=>{})},
      markFailed:async({childThread,error})=>{
        const childId=String(childThread.id),meta=state.threadMeta(childId);
        state.updateThreadMeta(childId,{delegation:{...(meta.delegation||{}),status:"failed",error:error.message||String(error),failedAt:Date.now()}});
      },
      onStarted:async result=>{
        const childId=String(result.thread.id),publicThread={...result.thread,parentThreadId,agentRole:"delegate"};
        eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(parentThreadId),environmentId:parentMeta?.environmentId??null,threadId:parentThreadId,turnId:result.turn?.id||null,category:"delegation",name:"delegation.started",status:"running",data:{delegationId:result.delegationId,childThreadId:childId,isolation:result.isolation,permissions:result.permission,branch:result.workspace?.branch||null}});
        relay.broadcast("thread/delegated",{threadId:parentThreadId,delegationId:result.delegationId,childThreadId:childId,thread:publicThread,turn:result.turn||null,workspace:result.workspace});
        result.thread=publicThread;
      },
    });
  }
  function codexPermissionProfilePatch(params={}){
    const hasPolicy=Object.prototype.hasOwnProperty.call(params,"permissionProfile")||Object.prototype.hasOwnProperty.call(params,"approvalPolicy")||Object.prototype.hasOwnProperty.call(params,"sandbox")||Object.prototype.hasOwnProperty.call(params,"sandboxPolicy");
    return hasPolicy?{permissionProfile:agentPermissionModeFromStart(params)}:{};
  }
  function withCodexRepositoryTools(message){
    if(message?.method!=="thread/start")return message;
    const params=message.params||{},existing=Array.isArray(params.dynamicTools)?params.dynamicTools:[];
    const repositoryNamespace=repositoryDynamicToolNamespace()[0];
    const dynamicTools=[...existing.filter(item=>String(item?.name||"")!=="trebell_repo"),repositoryNamespace];
    return {...message,params:{...params,dynamicTools}};
  }
  async function resolveCodexRepositoryTool(message){
    const params=message?.params||{};
    if(message?.method!=="item/tool/call"||params.namespace!=="trebell_repo")return null;
    const threadId=String(params.threadId||"").trim();
    if(!threadId)return {handled:true,result:{contentItems:[{type:"inputText",text:"A Trebell thread is required before querying repository intelligence."}],success:false}};
    const meta=state.threadMeta(threadId),root=meta?.cwd||null;
    if(!root)return {handled:true,result:{contentItems:[{type:"inputText",text:"The active thread has no pinned workspace for repository intelligence."}],success:false}};
    const definition=REPOSITORY_TOOL_DEFINITIONS.find(item=>item.name===params.tool);
    if(!definition)return {handled:true,result:{contentItems:[{type:"inputText",text:"Unknown Trebell repository tool: "+String(params.tool||"")}],success:false}};
    const environmentId=Object.prototype.hasOwnProperty.call(meta||{},"environmentId")?meta.environmentId:null,profile=environmentId?environments.get(environmentId):null;
    const io=profile&&profile.type!=="local"?createRemoteContextIo({environments,environmentId,root}):null;
    const handlers=repositoryToolHandlers({contextEngine,root,io,knowledgeService:repositoryKnowledge,environmentId});
    const traceBase={runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId,threadId:threadId||null,turnId:params.turnId||null,category:"tool"};
    try{
      const args=parseRepositoryToolArguments(definition,params.arguments||{});
      const result=await invokeRepositoryTool(handlers,definition,args);
      eventJournal.record({...traceBase,name:"repository_tool.completed",status:"completed",data:{tool:definition.name}});
      return {handled:true,result:{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true}};
    }catch(error){
      eventJournal.record({...traceBase,name:"repository_tool.completed",status:"failed",data:{tool:definition.name,message:error?.message||String(error)}});
      return {handled:true,result:{contentItems:[{type:"inputText",text:error?.message||String(error)}],success:false}};
    }
  }
  // The allowance ("Allow session") each approval the window is asked was read from as it came, by the request's params, until the
  // window answers it (onServerRequestAnswered).
  const codexApprovalAllowances=new WeakMap();
  // The files each Codex file change in progress touches, from its item/started, by thread, turn and item, until the item or its
  // turn completes: Codex's approval request for it names none (codexFileChanges). They go to the policy as the paths asked for, every
  // one of them, and to the window's card (trebellFileChanges), the first 200 of them.
  const codexFileChangeItems=new Map(),fileChangeKey=(threadId,turnId,itemId)=>[threadId,turnId,itemId].map(value=>String(value??"")).join("\0");
  function noteCodexFileChanges(message){
    const params=message?.params||{},item=params.item,threadId=String(params.threadId||"");if(!threadId)return;
    if((message.method==="item/started"||message.method==="item/completed")&&item?.type==="fileChange"&&item.id!=null){
      const key=fileChangeKey(threadId,params.turnId,item.id);codexFileChangeItems.delete(key);
      if(message.method==="item/started")codexFileChangeItems.set(key,codexFileChanges(item.changes));
      while(codexFileChangeItems.size>500)codexFileChangeItems.delete(codexFileChangeItems.keys().next().value);
      return;
    }
    if(!["turn/completed","thread/closed","thread/archived","thread/deleted"].includes(message.method))return;
    const prefix=threadId+"\0"+(message.method==="turn/completed"?String(params.turn?.id||params.turnId||"")+"\0":"");
    for(const key of [...codexFileChangeItems.keys()])if(key.startsWith(prefix))codexFileChangeItems.delete(key);
  }
  function codexApprovalFiles(message){
    const params=message?.params||{};
    if(message?.method==="applyPatchApproval")return codexFileChanges(params.fileChanges);
    return message?.method==="item/fileChange/requestApproval"?codexFileChangeItems.get(fileChangeKey(params.threadId,params.turnId,params.itemId))||[]:[];
  }
  function resolveCodexServerApproval(message){
    const params=message?.params||{},threadId=approvalThreadId(params)||null,meta=threadId?state.threadMeta(threadId):{},profile=meta?.permissionProfile||"supervised";
    const resolved=resolveCodexApprovalByPolicy(message,{
      profile,workspace:meta?.cwd||null,
      rules:Array.isArray(state.settings().policyRules)?state.settings().policyRules:[],
      provenance:params?._meta?.provenance||params.provenance||"unknown",
      files:codexApprovalFiles(message),
    });
    if(!resolved?.policy)return null;
    const action=resolved.policy.action,base={runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId,turnId:params.turnId||null,category:"policy"};
    const data={
      method:message.method,decision:resolved.policy.decision,reason:resolved.policy.reason,profile:resolved.policy.profile,
      action:action.action,kind:action.kind,riskLevel:action.riskLevel,reversibility:action.reversibility,idempotent:action.idempotent,
      externalSideEffect:action.externalSideEffect,pathInsideWorkspace:action.pathInsideWorkspace,networkHost:action.networkHost||null,provenance:action.provenance,
    };
    eventJournal.record({...base,name:"permission.requested",status:"pending",data:{method:message.method,action:action.action,kind:action.kind}});
    eventJournal.record({...base,name:"policy.decision",status:resolved.policy.decision.toLowerCase(),data});
    if(!resolved.handled){
      // A request the person would be asked: one of a kind "Allow session" allowed in this thread and mode is answered for them, unless
      // a rule of theirs asks about it (resolved.policy.rule), which asks every time.
      const kind=sessionApprovalKind(message.method,params),allowance=kind&&threadId?codexSessionApprovals.allowance(threadId,profile):null;
      if(allowance?.has(kind)&&!resolved.policy.rule){
        eventJournal.record({...base,name:"permission.resolved",status:"accept",data:{method:message.method,policyDecision:resolved.policy.decision,sessionAllowed:true}});
        return {handled:true,result:sessionApprovalResult(message.method)};
      }
      if(allowance&&message.params&&typeof message.params==="object")codexApprovalAllowances.set(message.params,{kind,allowance});
      return null;
    }
    eventJournal.record({...base,name:"permission.resolved",status:resolved.policy.decision==="ALLOW"?"accept":"decline",data:{method:message.method,policyDecision:resolved.policy.decision}});
    return {handled:true,result:resolved.result};
  }
  async function resolveCodexServerRequest(message){
    return await resolveCodexRepositoryTool(message)||resolveCodexServerApproval(message);
  }
  async function withCodexGoalContext(message){
    if(message?.method!=="turn/start")return message;
    const params=message.params||{},threadId=params.threadId?String(params.threadId):"";if(!threadId)return message;
    const runtimeContext={
      ...(params.additionalContext||{}),
      "trebell.runtime":{kind:"application",value:runtimeInstructions({harness:"Codex",model:params.model||codexThreadModels.get(threadId)||null})},
    };
    const goalContext=goalAdditionalContext(runtimeContext,durableCodexGoal(threadId));
    let additionalContext=continuityAdditionalContext(goalContext,durableCodexContinuity(threadId));
    const meta=state.threadMeta(threadId),projectPath=meta?.cwd||params.cwd||null;
    if(projectPath){
      const query=(Array.isArray(params.input)?params.input:[]).filter(item=>item?.type==="text").map(item=>String(item.text||"")).join("\n").slice(0,4000);
      try{
        const knowledge=await repositoryKnowledge.context({projectPath,environmentId:meta?.environmentId??null,query,limit:12,refresh:true});
        if(knowledge.context)additionalContext={...additionalContext,"trebell.repository_knowledge":{kind:"application",value:knowledge.context}};
      }catch(error){
        appServer?.logs?.push({at:Date.now(),stream:"repository-knowledge",text:safeLogText((error?.message||String(error))+"\n")});
      }
    }
    if(additionalContext===params.additionalContext)return message;
    return {...message,params:{...params,additionalContext}};
  }
  // Every turn Codex starts through the relay, the window's and the server's own (verification, delegation), gets its context
  // here, split last so that Codex, which cuts a long value's middle out, takes each value whole.
  async function transformCodexClientMessage(message){
    return withCodexContextPieces(await withCodexGoalContext(withCodexRepositoryTools(message)));
  }
  // The Codex turns each thread runs, as the relay sees them pass (turn/started, or a turn-start's answer, until turn/completed, or a
  // read of the thread that finds it idle), and the threads whose files Edit from here is restoring: the restore refuses a thread that
  // runs or is starting a turn, a turn start that comes meanwhile is refused (startsCodexTurn), and one Codex starts by itself
  // meanwhile (a goal's next turn) is noted, so the restore puts the files back as they were.
  const codexRunningTurns=new Map(),restoringThreads=new Map();
  // Each running Codex turn's token usage over all its model requests, from the thread's running total (codex-turn-usage.mjs).
  const codexTurnUsage=createCodexTurnUsage();
  // The threads a read or resume found running a turn it did not name, whose start no window saw (noteCodexTurnResumed).
  const codexUnnamedTurns=new Set();
  // A thread's own app-server that died (it had served, nothing stopped or released it): how it ended, and whether a turn ran on it, by
  // thread. Each resume of the thread names it (trebellAppServerExit) until the thread's next turn starts, so the app can say once, in
  // the thread, what happened, however often it reconnects.
  const codexAppServerExits=new Map();
  function noteCodexAppServerExit(server,code,signal){
    if(closing||server.stopping||!server.readyAt||codexAppServers.get(server.poolKey)!==server)return;
    const at=Date.now();
    for(const [threadId,key] of codexThreadServerKeys){
      if(key!==server.poolKey)continue;
      codexAppServerExits.delete(threadId);codexAppServerExits.set(threadId,{id:randomUUID(),code:Number.isInteger(code)?code:null,signal:signal||null,at,turnRunning:codexRunningTurns.has(threadId)});
      noteCodexTurnEnded(threadId);codexSessionApprovals.end(threadId);
    }
    while(codexAppServerExits.size>200)codexAppServerExits.delete(codexAppServerExits.keys().next().value);
  }
  function noteCodexTurnStarted(threadId,turnId){
    const id=String(threadId||"");if(!id)return;
    codexAppServerExits.delete(id);
    const restoring=restoringThreads.get(id);if(restoring)restoring.turnStarted=true;
    if(!turnId)return;codexUnnamedTurns.delete(id);let turns=codexRunningTurns.get(id);if(!turns)codexRunningTurns.set(id,turns=new Set());turns.add(String(turnId));
  }
  // A read or resume that finds the thread running a turn: one Codex started while no window showed the thread (a goal's next turn)
  // was never seen to start. The turn the answer names in progress runs; an answer with no turns (excludeTurns, the app's own
  // resume) leaves it to the turn of the thread's next usage update. That turn's updates then count toward it (codexTurnUsage).
  function noteCodexTurnResumed(threadId,thread){
    const id=String(threadId||""),named=(Array.isArray(thread?.turns)?thread.turns:[]).findLast(turn=>turn?.id&&(turn.status==="inProgress"||turn.status?.type==="active"));
    if(named){if(!codexRunningTurns.get(id)?.has(String(named.id)))noteCodexTurnStarted(id,named.id);return}
    codexUnnamedTurns.delete(id);codexUnnamedTurns.add(id);while(codexUnnamedTurns.size>500)codexUnnamedTurns.delete(codexUnnamedTurns.values().next().value);
  }
  function noteCodexTurnEnded(threadId,turnId=null){
    const id=String(threadId||""),turns=codexRunningTurns.get(id);codexUnnamedTurns.delete(id);if(!turns)return;
    if(turnId)turns.delete(String(turnId));else turns.clear();
    if(!turns.size)codexRunningTurns.delete(id);
  }
  // A turn runs in the thread now, in any window: a relay harness's (Trebell Native, Claude Code, the ACP harnesses) or a Codex turn
  // that runs or whose start is on its way.
  function threadTurnRuns(threadId){
    const id=String(threadId||"");if(!id)return false;
    if(agentThreads.getMetadata(id)?.status?.type==="active"||codexRunningTurns.has(id))return true;
    return relay.requestsInProgress(({method,params})=>startsCodexTurn(method)&&String(params?.threadId||"")===id)>0;
  }
  function markCodexTurnActive(threadId,turnId){
    if(!threadId||!turnId)return;
    state.updateThreadMeta(threadId,{active:true,restartRecovery:{runtime:"codex",bootId,threadId,turnId,status:"active",startedAt:Date.now(),uncertainTools:[]}});
  }
  function clearCodexRecovery(threadId,status="completed",message=null){
    if(!threadId)return;
    const meta=state.threadMeta(threadId),current=meta?.restartRecovery,finishedAt=Date.now();let codexTurnTimings=Array.isArray(meta?.codexTurnTimings)?meta.codexTurnTimings:[];
    if(current?.runtime==="codex"&&current.turnId&&Number(current.startedAt)){
      const timing={id:String(current.turnId),startedAt:Math.floor(Number(current.startedAt)/1000),durationMs:Math.max(0,finishedAt-Number(current.startedAt)),status};
      codexTurnTimings=[...codexTurnTimings.filter(item=>String(item?.id||item?.turnId||"")!==timing.id),timing].slice(-500);
    }
    state.updateThreadMeta(threadId,{active:false,codexTurnTimings,restartRecovery:current?{...current,bootId,status,finishedAt,...(message?{message}:{})}:undefined});
  }
  function codexRecoverySnapshot(){
    const enabled=Boolean(state.settings().continueThreadsAfterRestart);
    const items=[],blocked=[];
    for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
      const recovery=meta?.restartRecovery;
      if(recovery?.runtime==="codex"&&recovery?.status==="pending"&&recovery.bootId!==bootId&&recovery.turnId)items.push({threadId,turnId:recovery.turnId,startedAt:recovery.startedAt||null});
      if(recovery?.runtime==="codex"&&recovery?.status==="blocked"&&recovery.bootId!==bootId&&recovery.turnId)blocked.push({threadId,turnId:recovery.turnId,startedAt:recovery.startedAt||null,message:recovery.message||null,uncertainTools:Array.isArray(recovery.uncertainTools)?recovery.uncertainTools:[]});
    }
    return {enabled,bootId,items,blocked};
  }

  async function restartAppServer(){
    // A catalog still starting is stopped too: the first stop takes it once it has spawned, and the second one a start that spawned after.
    await stopCodexAppServers({keepGitText:true});await appServerStart;await stopCodexAppServers({keepGitText:true});
    appServer={logs:[],idle:true};appServerStart=null;
    if(mock||agentRuntimes.activeRuntime()==="codex")await catalogAppServer();
    return appServer;
  }

  function importedHistorySourceIds(){
    const ids=new Set();
    for(const meta of Object.values(state.listThreadMeta())){
      if(meta?.deletedAt)continue;
      const sourceId=String(meta?.historyImport?.sourceId||"").trim();if(sourceId)ids.add(sourceId);
    }
    for(const thread of agentThreads.list()){
      const sourceId=String(thread?.providerMeta?.historyImport?.sourceId||"").trim();if(sourceId)ids.add(sourceId);
    }
    return ids;
  }
  async function localAgentHistory(){
    const candidates=await scanLocalAgentHistory({
      env,
      excludeHomes:catalogCodexHomes(),
      includeClaude:env.TREBELL_HISTORY_DISABLE_CLAUDE!=="1",
    });
    const imported=importedHistorySourceIds();
    return {candidates,publicCandidates:candidates.map(candidate=>publicHistoryCandidate(candidate,{alreadyImported:imported.has(candidate.id)}))};
  }
  async function importAgentHistory(sourceIds=[]){
    const ids=[...new Set((sourceIds||[]).map(value=>String(value||"").trim()).filter(Boolean))].slice(0,50);
    if(!ids.length)throw new Error("Choose at least one history session to import");
    const {candidates}=await localAgentHistory();const byId=new Map(candidates.map(candidate=>[candidate.id,candidate]));
    const importedSources=importedHistorySourceIds();const results=[];let codexClient=null;
    try{
      for(const id of ids){
        const candidate=byId.get(id);
        if(!candidate){results.push({id,status:"error",error:"History session is no longer available"});continue}
        if(importedSources.has(id)){results.push({id,source:candidate.source,status:"skipped",reason:"already_imported"});continue}
        try{
          if(candidate.source==="claude"){
            const result=await importClaudeHistory(agentThreads,candidate);
            const thread=result.thread;
            state.updateThreadMeta(thread.id,{cwd:candidate.cwd,environmentId:null,historyImport:{source:"claude",sourceId:id,providerSessionId:candidate.providerSessionId,importedAt:Date.now()}});
            state.touchProject(candidate.cwd,{environmentId:null});
            importedSources.add(id);
            results.push({id,source:"claude",status:result.status,threadId:thread.id});
            continue;
          }
          if(candidate.source==="codex"){
            if(selectedAgentRuntime!=="codex")throw new Error("Switch the active coding harness to Codex before importing Codex history");
            if(state.settings().activeEnvironmentId)throw new Error("Codex history import is local-only. Switch the active environment to Local machine first");
            await catalogAppServer().catch(()=>{});
            if(!appServer?.targetUrl||appServer?.environment)throw new Error("Local Codex app-server is not available");
            if(!await waitForAppServer(appServer,appPort,15_000))throw new Error("Local Codex app-server is not ready");
            if(!codexClient){codexClient=new CodexAppServerClient(appServer.targetUrl,{clientVersion:TREBELL_VERSION,token:appServer.wsToken});await codexClient.connect()}
            const forked=await codexClient.forkFromRollout({threadId:candidate.providerSessionId,path:candidate.sourcePath,cwd:candidate.cwd});
            const threadId=String(forked?.thread?.id||"").trim();if(!threadId)throw new Error("Codex did not return the imported thread");
            if(candidate.title)await codexClient.request("thread/name/set",{threadId,name:candidate.title}).catch(()=>{});
            state.updateThreadMeta(threadId,{cwd:candidate.cwd,environmentId:null,historyImport:{source:"codex",sourceId:id,sourceThreadId:candidate.providerSessionId,importedAt:Date.now()}});
            state.touchProject(candidate.cwd,{environmentId:null});
            importedSources.add(id);
            results.push({id,source:"codex",status:"imported",threadId});
            continue;
          }
          results.push({id,source:candidate.source,status:"error",error:"Unsupported history source"});
        }catch(error){results.push({id,source:candidate.source,status:"error",error:error instanceof Error?error.message:String(error)})}
      }
    }finally{codexClient?.close()}
    return results;
  }
  async function codexNativeModelCatalog(){
    const instance=agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance():codexInstance();
    if(!instance)throw new Error("Codex runtime profile was not found");
    const server=await catalogAppServer();
    if(!server?.targetUrl||server.error)throw new Error(server?.error||"Codex app-server is unavailable");
    if(!mock&&!await waitForAppServer(server,server.appPort||appPort,15_000))throw new Error("Codex app-server is not ready");
    const client=new CodexAppServerClient(server.targetUrl,{clientVersion:TREBELL_VERSION,token:server.wsToken});
    try{
      await client.connect();
      const account=await client.request("account/read",{}).catch(()=>null);
      if(account?.requiresOpenaiAuth&&!account?.account)throw new Error("Codex is not authenticated. Run codex login or use Sign in from Agents & models.");
      // The tier the person's own Codex config runs new threads at (config/read for no folder, so no project's layers, as T3 reads
      // it), read beside the model list: each model that lists it takes it as its default tier, which the Speed picker shows while
      // nothing is picked (withConfiguredCodexServiceTier). A Codex that cannot say within 3 s leaves the list as Codex gave it.
      let tierTimer=null;
      const configuredTier=Promise.race([client.request("config/read",{includeLayers:false}).then(answer=>answer?.config?.service_tier??null,()=>null),new Promise(resolve=>{tierTimer=setTimeout(resolve,3000,null)})]).finally(()=>clearTimeout(tierTimer));
      const rows=[],seen=new Set();let cursor=null;
      for(let page=0;page<20;page++){
        const result=await client.request("model/list",cursor?{cursor}:{});
        for(const row of result?.data||[]){
          const id=String(row?.id||row?.model||"").trim();if(!id||row?.hidden||seen.has(id))continue;seen.add(id);rows.push(row);
        }
        const next=String(result?.nextCursor||"").trim();if(!next||next===cursor)break;cursor=next;
      }
      const models=rows.map(row=>String(row.id||row.model)),serviceTier=await configuredTier;
      const metadata=withConfiguredCodexServiceTier(rows,serviceTier).map(row=>({
        ...row,id:String(row.id||row.model),name:String(row.displayName||row.id||row.model),provider:"codex",agent:"Codex",
        reasoningEfforts:Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts:undefined,
        defaultReasoningEffort:row.defaultReasoningEffort||null,
      }));
      return {models,defaultModel:preferredCodexDefaultModel(rows),metadata:{provider:"codex",agentRuntime:"codex",source:"codex-model-list",models:metadata}};
    }finally{client.close()}
  }

  // A catalog answers for the runtime and provider selected when it was asked for: a harness switch can land while the list loads,
  // and the app keeps only a catalog named for the runtime it shows, so the payload must never name the newly selected one.
  async function selectedModels({nativeProviderCatalog=null}={}){
    const runtime=selectedAgentRuntime,provider=selectedProvider;
    const mergeCustom=catalog=>{
      if(!["native","codex","claude","opencode","cursor","grok","antigravity","muse"].includes(runtime))return catalog;
      const custom=(state.settings().customModels||[]).filter(item=>item&&item.id&&item.runtime===runtime&&(runtime!=="native"||item.provider===provider));
      if(!custom.length)return catalog;
      const baseModels=Array.isArray(catalog.models)?catalog.models:[];const models=[...baseModels];for(const item of custom)if(!models.includes(item.id))models.push(item.id);
      const metadataModels=[...(catalog.metadata?.models||[])];for(const item of custom){const index=metadataModels.findIndex(model=>model.id===item.id);const meta={id:item.id,name:item.name||item.id,provider:runtime==="native"?provider:runtime,agent:runtime,custom:true,effort:item.effort||null,serviceTier:item.serviceTier||null};if(index>=0)metadataModels[index]={...metadataModels[index],...meta};else metadataModels.push(meta)}
      return {...catalog,models,metadata:{...(catalog.metadata||{}),models:metadataModels}};
    };
    const finish=catalog=>{
      const merged=mergeCustom(catalog);
      const normalized={...merged,metadata:{...(merged.metadata||{}),models:(merged.metadata?.models||[]).map(withNormalizedModelCapabilities)}};
      if(runtime==="native")rememberNativeModelContextWindows(normalized);
      return {...normalized,scope:{agentRuntime:runtime,provider}};
    };
    if(runtime==="codex"){
      if(mock)return finish({models:["gpt-6-astra","gpt-5.6-sol","gpt-5.6-terra"],metadata:{provider:"codex",agentRuntime:"codex",source:"mock-codex",models:["gpt-6-astra","gpt-5.6-sol","gpt-5.6-terra"].map(id=>({id,name:id,provider:"codex",agent:"Codex"}))}});
      return finish(await codexNativeModelCatalog());
    }
    if(runtime!=="native"){
      const result=await agentRuntimes.models(agentRuntimes.activeInstance());
      return finish({models:result.models||[],defaultModel:result.preferred||null,metadata:{provider:runtime,agentRuntime:runtime,source:result.source,models:result.metadata||[]},error:result.error||null,...(result.inventory?{inventory:result.inventory}:{})});
    }
    if(mock) return finish({models:fakeModels(provider),defaultModel:fakeDefaultModel(provider),metadata:{provider:provider,models:fakeModels(provider).map(id=>({id,provider:provider}))}});
    const result=nativeProviderCatalog||await providers.models(provider);
    return finish({models:result.models||[],defaultModel:result.defaultModel||null,metadata:{provider:provider,source:result.source,models:result.metadata||[]},error:result.error||null});
  }
  async function selectedModelsPayload(){
    const catalog=await selectedModels(),runtime=catalog.scope.agentRuntime;
    return {
      ...(runtime==="native"?{provider:catalog.scope.provider}:{}),
      agentRuntime:runtime,
      ready:runtime==="native"?providerReady():true,
      models:catalog.models||[],
      defaultModel:catalog.defaultModel||null,
      metadata:catalog.metadata||null,
      error:catalog.error||null,
      ...(catalog.inventory?{inventory:catalog.inventory}:{}),
    };
  }
  async function runtimeRefreshPayload(req,{agentSnapshot=null}={}){
    const runtime=selectedAgentRuntime,provider=selectedProvider;
    const [bootstrap,catalog]=await Promise.all([
      bootstrapPayload(req,{agentSnapshot}),
      selectedModelsPayload().catch(error=>({
        ...(runtime==="native"?{provider}:{}),
        agentRuntime:runtime,
        ready:false,
        models:[],
        defaultModel:null,
        metadata:null,
        error:error instanceof Error?error.message:String(error),
      })),
    ]);
    return {bootstrap,catalog};
  }

  async function nativeProviderTurn(request={}){
    const provider=normalizeProviderId(request.provider||selectedProvider),model=String(request.model||"").trim();if(!model)throw new Error("Trebell Native requires a model.");
    if(mock){
      const last=[...(request.messages||[])].reverse().find(message=>message?.role==="user"),content=typeof last?.content==="string"?last.content:"";
      return {id:"mock-native-"+randomUUID(),provider,model,text:`Mock Trebell Native reply: ${content}`.trim(),toolCalls:[],finishReason:"stop",status:"completed",usage:{inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0},raw:{mock:true}};
    }
    if(!knownModelProvider(request.provider||selectedProvider))throw Object.assign(new Error("Trebell Native cannot use this thread's model provider because it is not available. Choose a model provider in Settings > Agents & models."),{retryable:false});
    if(isRetiredProviderModel(model))throw Object.assign(new Error("Trebell Native cannot use this thread's model because it is no longer available. Choose another model and send again."),{retryable:false});
    if(typeof request[NATIVE_REPLY_STREAM]!=="function")return providers.turn(provider,request,{signal:request.signal,promptCaching:provider==="anthropic",streamResponses:provider==="openai"});
    // A request the session wants to show as it streams carries its observer under a Symbol; the provider gets the request
    // without it (its other Symbol keys stay, the identity caches are keyed by them) and only the options say how to stream.
    const {[NATIVE_REPLY_STREAM]:onStream,...providerRequest}=request;
    return providers.turn(provider,providerRequest,{signal:request.signal,promptCaching:provider==="anthropic",streamResponses:provider==="openai",...nativeStreamOptions(provider,onStream)});
  }
  function sourceControlStyleInstruction(style,kind,customInstructions=""){
    if(style==="conventional")return kind==="review"
      ?"Keep the pull request title concise and specific. Do not force Conventional Commit syntax into the pull request title."
      :"Use Conventional Commits for the commit subject. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.";
    if(style==="custom")return customInstructions?"Follow these source-control writing instructions exactly:\n"+customInstructions:"Use a clear, specific engineering style and avoid filler.";
    return kind==="review"
      ?"Follow the repository's established pull request title and body style when examples are available."
      :"Follow the repository's established commit message style when examples are available.";
  }
  async function sourceControlWritingContext(cwd,environmentId,{includeRepositoryInstructions=false,includeReviewTemplate=false}={}){
    const subjects=includeRepositoryInstructions?await inSourceControlEnvironment(environmentId,()=>sourceControlRecentCommitSubjects(cwd,{limit:10})).catch(()=>[]):[];
    const instructions=[];const paths=[];
    if(includeRepositoryInstructions)paths.push("AGENTS.md","CLAUDE.md","CONTRIBUTING.md");
    for(const relativePath of [...new Set(paths)]){
      try{
        const filePath=remoteEnvironmentProfile(environmentId)?relativePath:join(cwd,relativePath);
        const file=await environmentWorkspaceFile(filePath,12_000,{root:cwd,environments,environmentId});
        // CLAUDE.md is often a link to AGENTS.md or a copy of it (T3 GitManager): a file that says what one already added says is left out.
        const content=String(file.content||"").trim();if(content&&!instructions.some(item=>item.content===content))instructions.push({path:relativePath,content});
      }catch{}
    }
    const reviewTemplate=includeReviewTemplate
      ?await inSourceControlEnvironment(environmentId,()=>sourceControlPullRequestTemplate(cwd)).catch(()=>null)
      :null;
    return {subjects,instructions,reviewTemplate};
  }
  function sourceControlTextGenerator(){
    if(selectedAgentRuntime==="native")return {runtime:"native",generatedWith:MODEL_PROVIDERS[selectedProvider]?.name||selectedProvider};
    return {runtime:selectedAgentRuntime,generatedWith:agentRuntimes.definitions().find(item=>item.id===selectedAgentRuntime)?.name||selectedAgentRuntime};
  }
  async function sourceControlTextRequest({cwd,environmentId,kind,model=null,signal=null}){
    // Snapshot the writer first so a harness switch during the diff cannot route this prompt somewhere else.
    const generator=sourceControlTextGenerator(),harnessInstance=generator.runtime==="native"?null:agentRuntimes.activeInstance();
    const scoped=state.projectSettings(cwd,environmentId).effective;
    const style=scoped.sourceControlTextStyle||"repository";const selectedModel=scoped.sourceControlTextModel||model||null;
    const customInstructions=String(scoped.sourceControlCustomInstructions||"").trim();const followTemplates=scoped.sourceControlFollowTemplates!==false;
    const diff=kind==="review"
      ?await inSourceControlEnvironment(environmentId,()=>sourceControlReviewRangeContext(cwd))
      :await environmentWorkspaceDiff(cwd,{environments,environmentId});
    const context=await sourceControlWritingContext(cwd,environmentId,{includeRepositoryInstructions:style==="repository",includeReviewTemplate:kind==="review"&&followTemplates});
    const recent=context.subjects.length?"Recent commit subjects:\n"+context.subjects.map(subject=>"- "+subject).join("\n")+"\n\n":"";
    const instructions=context.instructions.length?"Repository guidance:\n"+context.instructions.map(item=>"### "+item.path+"\n"+item.content.slice(0,6000)).join("\n\n")+"\n\n":"";
    const template=context.reviewTemplate?"Repository pull request template:\n"+String(context.reviewTemplate).slice(0,8000)+"\n\n":"";
    const styleInstruction=sourceControlStyleInstruction(style,kind,customInstructions);
    const prompt=kind==="review"
      ?[
        "Generate a pull request title and description for the current change.",
        styleInstruction,
        "Return strict JSON only with this shape: {\"title\":\"...\",\"body\":\"...\"}.",
        "Keep the title under 100 characters. The body should summarize the change and validation without inventing tests or results.",
        recent,instructions,template,
        diff.baseRef?"Base: "+diff.baseRef:null,
        diff.commitSummary?"Branch commits:\n"+String(diff.commitSummary).slice(0,12000):null,
        diff.diffSummary?"Branch diff summary:\n"+String(diff.diffSummary).slice(0,12000):null,
        "Diff:\n"+String(diff.diff||"").slice(0,60000),
      ].filter(Boolean).join("\n\n")
      :[
        "Write one Git commit subject for the current change.",
        styleInstruction,
        "Keep the subject under 100 characters. Return only the subject with no quotes or markdown.",
        recent,instructions,"Status:\n"+String(diff.status||"").slice(0,12000),"Diff:\n"+String(diff.diff||"").slice(0,60000),
      ].filter(Boolean).join("\n\n");
    if(mock)return kind==="review"
      ?{text:JSON.stringify({title:"Mock generated review",body:"Mock generated description."}),style,model:selectedModel,prompt,...generator}
      :{text:"Mock generated commit",style,model:selectedModel,prompt,...generator};
    if(harnessInstance){
      // An external harness writes the text with its own account and current/default model, and the diff never reaches the
      // Native provider. Codex threads are ephemeral, Claude Code sessions are not saved and OpenCode sessions are deleted; ACP
      // has no delete, so Cursor, Grok Build and Antigravity keep the temp-folder session in their own store (see harness-text-generation.mjs).
      const generated=await harnessTextGenerator({
        runtimeManager:agentRuntimes,instance:harnessInstance,prompt,cwd,environmentId,signal,version:TREBELL_VERSION,timeoutMs:HARNESS_TEXT_TIMEOUT_MS,
        models:[scoped.sourceControlTextModel,model].filter(Boolean),
        codexAppServer:()=>dedicatedCodexAppServer(harnessInstance.id,environmentId),
      });
      return {text:String(generated?.text||"").trim(),style,model:generated?.model||null,prompt,runtime:harnessInstance.kind,generatedWith:generated?.name||generator.generatedWith};
    }
    const answer=await providers.directChat(selectedProvider,{prompt,model:selectedModel});
    return {text:String(answer.text||"").trim(),style,model:selectedModel,prompt,...generator};
  }
  function generatedCommitSubject(text){
    const lines=String(text||"").replace(/```[\w-]*/g,"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    return String(lines[0]||"").replace(/^["'`]+|["'`]+$/g,"").trim();
  }
  function sourceControlTextStatus(error){return error?.code==="HARNESS_TEXT_TIMEOUT"?504:400}

  const server=createServer(async(req,res)=>{
    const url=new URL(req.url || "/",`http://127.0.0.1:${port}`);

    if(url.pathname==="/api/state" && req.method==="GET") return json(res,200,state.snapshot({includeCollections:false,threadMetaView:"catalog",threadMetaLimit:250}));
    if(url.pathname==="/api/recovery"){
      if(req.method==="GET")return json(res,200,codexRecoverySnapshot());
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const threadId=String(body.threadId||"");if(!threadId)throw new Error("threadId is required");
          const action=String(body.action||"clear");
          clearCodexRecovery(threadId,action==="failed"?"error":action==="interrupted"?"interrupted":"completed",body.message?String(body.message):null);
          return json(res,200,codexRecoverySnapshot());
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/settings"){
      if(req.method==="GET") return json(res,200,state.settings());
      if(req.method==="POST"){
        try{
          const patch=await readJsonBody(req);
          if(Object.prototype.hasOwnProperty.call(patch,"remoteAccessToken"))delete patch.remoteAccessToken;
          if(Object.prototype.hasOwnProperty.call(patch,"remoteAccessEnabled"))delete patch.remoteAccessEnabled;
          if(Object.prototype.hasOwnProperty.call(patch,"remoteAccessPort"))delete patch.remoteAccessPort;
          if("modelProvider" in patch) patch.modelProvider=normalizeProviderId(patch.modelProvider);
          if("agentRuntime" in patch) patch.agentRuntime=normalizeAgentRuntime(patch.agentRuntime);
          const previous=selectedProvider;
          const previousAgentRuntime=agentRuntimes.activeRuntime();
          const previousAgentInstanceId=agentRuntimes.activeInstance().id;
          let runtimeSelection=null;
          if("agentRuntime" in patch||"agentRuntimeInstanceId" in patch){
            const requestedRuntime="agentRuntime" in patch?patch.agentRuntime:previousAgentRuntime;
            const requestedInstanceId=Object.prototype.hasOwnProperty.call(patch,"agentRuntimeInstanceId")
              ?(patch.agentRuntimeInstanceId||null)
              :(requestedRuntime===previousAgentRuntime?previousAgentInstanceId:null);
            runtimeSelection=await agentRuntimes.setActive({runtime:requestedRuntime,instanceId:requestedInstanceId});
            selectedAgentRuntime=runtimeSelection.runtime;
            delete patch.agentRuntime;delete patch.agentRuntimeInstanceId;
          }
          const next=state.updateSettings(patch);
          if("modelProvider" in patch && patch.modelProvider!==previous){
            selectedProvider=patch.modelProvider;
          }
          if(runtimeSelection?.runtime==="codex"&&(previousAgentRuntime!=="codex"||previousAgentInstanceId!==runtimeSelection.instance.id))await restartAppServer();
          return json(res,200,next);
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/general-workspace"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        return json(res,200,await ensureGeneralWorkspace(environmentId));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/agent-runtimes"){
      if(req.method==="GET"){
        // Settings' own listing (its open and Refresh): Muse Code's model lists are read again too, and OpenCode's catalogs on Refresh
        // (its open asks with x-trebell-catalogs: kept, which keeps a complete one).
        try{return json(res,200,await agentRuntimes.snapshot({refresh:true,keepOpenCode:req.headers["x-trebell-catalogs"]==="kept"}));}
        catch(error){return json(res,500,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(body.action==="select"){
            const previousRuntime=agentRuntimes.activeRuntime();
            const previousInstanceId=agentRuntimes.activeInstance().id;
            const selected=await agentRuntimes.setActive({runtime:body.runtime,instanceId:body.instanceId||null});
            selectedAgentRuntime=selected.runtime;
            if(selected.runtime==="codex"&&(previousRuntime!=="codex"||previousInstanceId!==selected.instance.id))await restartAppServer();
            const snapshot=await agentRuntimes.snapshot();
            return json(res,200,{...snapshot,selected,...await runtimeRefreshPayload(req,{agentSnapshot:snapshot})});
          }
          if(body.action==="upsert"){
            const instance=agentRuntimes.upsertInstance(body.instance||{});
            const active=agentRuntimes.activeInstance().id===instance.id;
            if(instance.kind==="codex"&&active)await restartAppServer();
            const snapshot=await agentRuntimes.snapshot();
            return json(res,200,{instance,...snapshot,...(active?await runtimeRefreshPayload(req,{agentSnapshot:snapshot}):{})});
          }
          if(body.action==="probe"){
            const instance=agentRuntimes.instances().find(item=>item.id===String(body.instanceId||""))||body.runtime;
            return json(res,200,{status:await agentRuntimes.probe(instance)});
          }
          if(body.action==="install"){
            // instanceId: the profile whose row was pressed, whose binary an update is for.
            const installed=await agentRuntimes.install(body.runtime,{environmentId:Object.prototype.hasOwnProperty.call(body,"environmentId")?body.environmentId:undefined,id:typeof body.id==="string"?body.id.slice(0,100):null,instanceId:typeof body.instanceId==="string"?body.instanceId.slice(0,200):null});
            const snapshot=await agentRuntimes.snapshot();
            const active=installed.runtime===snapshot.selectedRuntime;
            return json(res,200,{installed,...snapshot,...(active?await runtimeRefreshPayload(req,{agentSnapshot:snapshot}):{})});
          }
          // The answer of an install on its way that this window did not start (another tab's, or its own from before a reload), as the
          // install's own answer once it ends; waited:false with the harness list when none runs any more.
          if(body.action==="install-wait"){
            const waiting=agentRuntimes.waitForInstall(body.runtime);
            if(!waiting)return json(res,200,{waited:false,...await agentRuntimes.snapshot()});
            const installed=await waiting;
            const snapshot=await agentRuntimes.snapshot();
            const active=installed.runtime===snapshot.selectedRuntime;
            return json(res,200,{installed,...snapshot,...(active?await runtimeRefreshPayload(req,{agentSnapshot:snapshot}):{})});
          }
          return json(res,400,{error:"unknown agent runtime action"});
        }catch(error){return json(res,400,{error:error.message,...(error?.code==="install-running"?{code:error.code,installId:error.installId}:{})});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id");if(!id)return json(res,400,{error:"id is required"});
        try{
          const removed=agentRuntimes.removeInstance(id);
          if(removed.resetTo&&removed.kind==="codex")await restartAppServer();
          const snapshot=await agentRuntimes.snapshot();
          return json(res,200,{...removed,...snapshot,...(removed.resetTo?await runtimeRefreshPayload(req,{agentSnapshot:snapshot}):{})});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/agent-runtime-auth"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req),action=String(body.action||"login");
        // remove-key: Antigravity's saved Gemini API key goes.
        if(action!=="login"&&action!=="remove-key")throw new Error("Unsupported runtime authentication action");
        const instance=agentRuntimes.instances().find(item=>item.id===String(body.instanceId||""))
          ||agentRuntimes.instances().find(item=>item.kind===String(body.runtime||""))
          ||agentRuntimes.activeInstance();
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const cwd=agentRuntimes.runtimeCwd(body.cwd||process.cwd(),environmentId);
        if(instance.kind==="antigravity"){
          // Antigravity signs in only with a Gemini API key (antigravity-auth.mjs): the key typed in Settings, or the one saved, is
          // saved once Antigravity has signed in with it and opened a session. No answer carries it back.
          // An Antigravity chat's process keeps the key it started with: a key removed, or another one saved, stops the chats open on the
          // key before (the relay's closeRuntimeSessions), and the answer says how many (stoppedChats).
          const signedIn={ok:true,authenticated:true,auth:{runtime:"antigravity",instanceId:instance.id,methodId:ANTIGRAVITY_API_KEY_METHOD,methodName:"Gemini API key"}};
          // One sign-in at a time (T3: "already in progress"): a second would start another Antigravity, and a key removed meanwhile
          // would come back once the running one saved its key.
          if(antigravitySignIn)throw new Error(action==="remove-key"?"Antigravity is signing in with a Gemini API key, which it saves once it is signed in. Remove the key once that sign-in has ended.":"Antigravity is already signing in with a Gemini API key, which can take up to 5 minutes. Try again once that sign-in has ended.");
          if(action==="remove-key"){saveAntigravityApiKey(null,{env:agentRuntimes.env});const stoppedChats=await agentRelay?.closeRuntimeSessions?.("antigravity")||0;return json(res,200,{ok:true,authenticated:false,stoppedChats,agentSnapshot:await agentRuntimes.snapshot()})}
          if(mock)return json(res,200,{...signedIn,agentSnapshot:await agentRuntimes.snapshot()});
          if(environmentId)throw new Error("Antigravity ACP sign-in is currently supported on the local machine only.");
          const signingIn=antigravitySignIn=signInAntigravityProfile(agentRuntimes,instance,{apiKey:body.apiKey,version:TREBELL_VERSION});
          let changed;try{({changed}=await signingIn)}finally{if(antigravitySignIn===signingIn)antigravitySignIn=null}
          const stoppedChats=changed?await agentRelay?.closeRuntimeSessions?.("antigravity")||0:0;
          return json(res,200,{...signedIn,stoppedChats,agentSnapshot:await agentRuntimes.snapshot()});
        }
        if(action!=="login")throw new Error("Unsupported runtime authentication action");
        // prelude: what a WSL or SSH host runs before the sign-in there (a Codex profile's home), kept out of the answer.
        const {prelude,...auth}=agentRuntimes.authCommand(instance,{action:"login",environmentId});
        if(mock){
          return json(res,200,{ok:true,auth,session:{id:"mock-runtime-auth",name:auth.name+" sign in",cwd,environmentId:environmentId||null,environmentName:"Mock environment",environmentType:environmentId?"remote":"local",running:true}});
        }
        const authProfile=environmentId?environments.get(environmentId):null,remoteAuth=Boolean(authProfile&&authProfile.type!=="local");
        const spec=remoteAuth
          ?environments.terminalArgvSpec(environmentId,{command:auth.command,args:auth.args,cwd,prelude})
          :environments.terminalSpec(environmentId,{cwd});
        const session=await terminals.create({
          cwd:spec.cwd,
          displayCwd:cwd,
          cols:120,
          rows:32,
          name:auth.name+" sign in",
          env:remoteAuth?remoteTransportEnvironment(env,{platform:process.platform}):agentRuntimes.childEnv(instance),
          replaceEnv:true,
          shell:spec.shell,
          args:spec.args,
          environmentId:spec.environmentId,
          environmentName:spec.environmentName,
          environmentType:spec.environmentType,
        });
        if(!remoteAuth)await terminals.write(session.id,interactiveTerminalCommand(auth.command,auth.args,{platform:process.platform})+"\r");
        return json(res,200,{ok:true,auth,session});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/agent-runtime-usage"&&req.method==="GET"){
      try{
        const rawEnvironment=url.searchParams.get("environmentId");
        const environmentId=rawEnvironment==="local"?null:rawEnvironment?requestedEnvironmentId(rawEnvironment,{fallback:false}):requestedEnvironmentId(null);
        const instance=agentRuntimes.activeInstance();
        const usage=await agentRuntimes.usageLimits(instance,{environmentId});
        return json(res,200,{runtime:instance.kind,instanceId:instance.id,environmentId:environmentId||null,...usage});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/providers"){
      if(req.method==="GET"){
        return json(res,200,{selected:selectedProvider,providers:providers.definitions(),status:providers.status(selectedProvider),ready:providerReady()});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          const provider=normalizeProviderId(body.provider||selectedProvider);
          let validatedCatalog=null;
          if("apiKey" in body&&!knownModelProvider(body.provider||selectedProvider))throw new Error("Unknown model provider. Choose a listed provider before saving an API key.");
          if("apiKey" in body){
            // A key for a provider with a live model list is saved only once that list answers to it (checkKey).
            if(String(body.apiKey||"").trim() && ["openai","anthropic","gemini","agentrouter","vyceai"].includes(provider)){
              try{
                validatedCatalog=await providers.checkKey(provider,body.apiKey);
              }catch(error){
                throw new Error(`${apiKeyLabel(providers.get(provider).name)} check failed: ${error instanceof Error?error.message:String(error)}`);
              }
            }else providers.setKey(provider,body.apiKey);
          }
          const changed=provider!==selectedProvider;
          if(changed){
            state.updateSettings({modelProvider:provider});
            selectedProvider=provider;
          }
          const catalog=await selectedModels({nativeProviderCatalog:selectedAgentRuntime==="native"&&provider===selectedProvider?validatedCatalog:null}).catch(error=>({models:[],error:error.message}));
          return json(res,200,{
            selected:selectedProvider,
            agentRuntime:selectedAgentRuntime,
            providers:providers.definitions(),
            status:providers.status(selectedProvider),
            ready:providerReady(),
            models:catalog.models||[],
            defaultModel:catalog.defaultModel||null,
            metadata:catalog.metadata||null,
            error:catalog.error||null,
          });
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/environments"){
      if(req.method==="GET"){
        try{const discovered=await environments.discover();return json(res,200,{...discovered,activeEnvironmentId:state.settings().activeEnvironmentId||null,activeEnvironment:environments.get(state.settings().activeEnvironmentId)||null});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{return json(res,200,{profile:environments.upsert(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id");
        const wasActive=Boolean(id&&state.settings().activeEnvironmentId===id);
        const ok=id?environments.remove(id):false;
        if(wasActive){
          state.updateSettings({activeEnvironmentId:null});
          await restartAppServer();
        }
        return json(res,200,{ok,activeEnvironmentId:state.settings().activeEnvironmentId||null});
      }
    }
    if(url.pathname==="/api/environment/enabled"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);const id=String(body.id||"").trim();if(!id)throw new Error("id is required");
        const profile=environments.get(id,{includeDisabled:true});if(!profile)throw new Error("Environment profile was not found");
        const enabled=body.enabled!==false;const updated=environments.setEnabled(id,enabled);
        let activeEnvironmentId=state.settings().activeEnvironmentId||null;
        if(!enabled&&activeEnvironmentId===id){
          activeEnvironmentId=null;state.updateSettings({activeEnvironmentId:null});
          await agentRelay?.reset?.();
          await restartAppServer();
        }
        return json(res,200,{ok:true,profile:updated,activeEnvironmentId,appServerReady:mock||await appServerReady(appServer,appPort)});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/activate"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const id=body.id?String(body.id):null;
        if(id){
          const profile=environments.get(id,{includeDisabled:true});
          if(!profile)throw new Error("Environment profile was not found");
          if(profile.enabled===false)throw new Error("Environment is switched off. Turn it on before using it for agents.");
          // A host that does not answer the environment's own check (its Test button) is refused before anything stops: no harness
          // runs there, and Trebell Native checks nothing on the host when it starts.
          if(profile.type!=="local"){
            const reached=await environments.probe(id).catch(error=>({ok:false,stderr:error?.message||String(error)}));
            if(!reached.ok)return json(res,503,{error:String(reached.stderr||reached.stdout||"").trim()||`${profile.name} did not answer`,activeEnvironmentId:state.settings().activeEnvironmentId||null});
          }
        }
        // Whether the runtime runs in the chosen environment is known only once it has restarted there. A switch to a host it cannot
        // run in is undone: the environment that was active is saved and restarted again, and the failure answers with an error status.
        // A switch to Local machine is kept, with the runtime said not ready: it is the way back from a host that stopped answering,
        // which an undo would make the agent environment again.
        const previousId=state.settings().activeEnvironmentId||null;
        const switchTo=async environmentId=>{state.updateSettings({activeEnvironmentId:environmentId});await agentRelay?.reset?.();await restartAppServer()};
        await switchTo(id);
        const appReady=mock||await appServerReady(appServer,appPort);
        const activeAgentInstance=agentRuntimes.activeInstance();
        const activeAgentStatus=await agentRuntimes.probe(activeAgentInstance,{environmentId:id}).catch(error=>({
          id:activeAgentInstance?.id||null,
          kind:selectedAgentRuntime,
          name:selectedAgentRuntime,
          available:false,
          message:error instanceof Error?error.message:String(error),
        }));
        const agentRuntimeReady=mock||(selectedAgentRuntime==="codex"?Boolean(appReady&&activeAgentStatus?.available):Boolean(activeAgentStatus?.available));
        const runtimeError=selectedAgentRuntime==="codex"
          ?(appServer?.error||(!activeAgentStatus?.available?activeAgentStatus?.message:null)||null)
          :(agentRuntimeReady?null:(activeAgentStatus?.message||"Active agent runtime is unavailable"));
        if(runtimeError&&id){
          if(id!==previousId)await switchTo(previousId);
          return json(res,503,{error:runtimeError,activeEnvironmentId:previousId});
        }
        return json(res,200,{
          activeEnvironmentId:id,
          activeEnvironment:id?environments.get(id):null,
          agentRuntime:selectedAgentRuntime,
          agentRuntimeInstanceId:activeAgentInstance?.id||`${selectedAgentRuntime}-default`,
          agentRuntimeReady,
          agentRuntimeStatus:activeAgentStatus,
          appServerReady:appReady,
        });
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/probe"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await environments.probe(body.id));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/themes"&&req.method==="GET"){
      try{
        const requested=url.searchParams.get("id");
        const id=requested==null?(state.settings().activeEnvironmentId||null):(requested||null);
        return json(res,200,await environments.themeCatalog(id));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/execute"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await environments.execute(body.id,body));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/usage"){
      if(req.method==="GET"){
        const requested=url.searchParams.getAll("environmentId");
        const environmentIds=requested.length?requested.map(value=>!value||value==="local"?null:value):undefined;
        return json(res,200,state.usage({days:Number(url.searchParams.get("days")||30),limit:Number(url.searchParams.get("limit")||1000),environmentIds}));
      }
      if(req.method==="DELETE")return json(res,200,{ok:true,cleared:state.clearUsage()});
    }
    if(url.pathname==="/api/traces"&&req.method==="GET"){
      return json(res,200,{items:eventJournal.list({
        threadId:url.searchParams.get("threadId")||null,
        turnId:url.searchParams.get("turnId")||null,
        runtime:url.searchParams.get("runtime")||null,
        category:url.searchParams.get("category")||null,
        limit:Number(url.searchParams.get("limit")||200),
        before:url.searchParams.get("before")||null,
        after:url.searchParams.get("after")||null,
      }),journal:eventJournal.status()});
    }
    if(url.pathname==="/api/projects"){
      if(req.method==="GET") return json(res,200,{projects:state.projects().map(projectWithEnvironment)});
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(!body.path) return json(res,400,{error:"path is required"});
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
            ?requestedEnvironmentId(body.environmentId,{fallback:false})
            :requestedEnvironmentId(null);
          const path=environmentPath(body.path,environmentId);
          // A save that names its project (a Projects card's) changes that project only. One removed meanwhile, which a save still on
          // its way when the person pressed Remove reaches after the removal, is not created again under its folder's name.
          if(body.id!=null){const named=state.projectById(String(body.id));if(!named||named.path!==path||(named.environmentId||null)!==(environmentId||null))return json(res,404,{error:"Project was not found"})}
          const project=state.touchProject(path,{...body,environmentId});
          if(body.activate)state.updateSettings({activeProjectId:project.id});
          return json(res,200,{project:projectWithEnvironment(project)});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        // The answer is the record as it was removed, with every save that reached the server first, for an Undo to put back.
        const id=url.searchParams.get("id"),removed=id?state.removeProject(id):null;
        return json(res,200,{ok:true,project:removed?projectWithEnvironment(removed):null});
      }
    }
    if(url.pathname==="/api/project-recipe/resolve"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(body.path||"",environmentId);if(!projectPath)throw new Error("Project path is required");
        const project=state.project(projectPath,environmentId);if(!project)return json(res,404,{error:"Project was not found"});
        const key=String(body.recipe||"").trim().toLowerCase();
        const recipe=(project.recipes||[]).find(item=>String(item.id||"").toLowerCase()===key||String(item.name||"").toLowerCase()===key);
        if(!recipe)return json(res,404,{error:"Project recipe was not found"});
        const runtime=normalizeAgentRuntime(body.runtime||selectedAgentRuntime);
        const execution=resolveRecipeExecution(recipe,{
          projectPath,input:body.input||"",currentPermission:body.currentPermission||"supervised",runtime,
          toolPolicyEnforced:runtime==="native",environmentIsolated:false,
        });
        return json(res,200,{execution});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/clone-jobs"){
      if(req.method==="GET"){
        const id=String(url.searchParams.get("id")||"").trim();
        if(!id)return json(res,200,{jobs:cloneJobs.list()});
        const job=cloneJobs.get(id);if(!job)return json(res,404,{error:"Clone job was not found"});
        const project=state.project(job.destination,job.environmentId||null);
        return json(res,200,{job,project:projectWithEnvironment(project)});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const action=String(body.action||"start");
          let job;
          if(action==="start"){
            const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
            if(!body.destination)throw new Error("Clone destination is required");
            const destination=environmentPath(body.destination,environmentId);
            job=await cloneJobs.start({url:body.url,destination,environmentId,name:body.name||null});
          }else if(action==="cancel")job=await cloneJobs.cancel(body.id);
          else if(action==="retry")job=await cloneJobs.retry(body.id);
          else throw new Error("Unknown clone action");
          const project=job?.destination?state.project(job.destination,job.environmentId||null):null;
          return json(res,200,{ok:true,job,project:projectWithEnvironment(project)});
        }catch(error){return json(res,400,{ok:false,error:error.message});}
      }
    }
    if(url.pathname==="/api/history-import"){
      if(req.method==="GET"){
        try{
          const {publicCandidates}=await localAgentHistory();
          if(selectedAgentRuntime==="codex")await catalogAppServer().catch(()=>{});
          const codexImport=codexHistoryImportStatus({runtime:selectedAgentRuntime,activeEnvironmentId:state.settings().activeEnvironmentId,appServer});
          return json(res,200,{
            sessions:publicCandidates,
            codexImportAvailable:codexImport.available,
            codexImportUnavailable:codexImport.available?null:{reason:codexImport.reason,message:codexImport.message},
          });
        }catch(error){return json(res,400,{error:error.message})}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const results=await importAgentHistory(body.sessionIds||[]);
          return json(res,200,{ok:results.every(item=>item.status!=="error"),results,projects:state.projects().map(projectWithEnvironment)});
        }catch(error){return json(res,400,{error:error.message})}
      }
    }
    if(url.pathname==="/api/scoped-settings"){
      if(req.method==="GET"){
        try{
          const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
          const projectId=String(url.searchParams.get("projectId")||"").trim();
          if(projectId){
            const project=state.projects().find(item=>item.id===projectId);if(!project)throw new Error("Project was not found");
            const resolved=state.projectSettings(project.path,project.environmentId);
            return json(res,200,{scope:"project",environmentId:project.environmentId||null,project:projectWithEnvironment(project),...resolved});
          }
          const defaults=state.environmentDefaults(environmentId);
          return json(res,200,{scope:"environment",environmentId,defaults,overrides:{},effective:defaults});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const projectId=String(body.projectId||"").trim();const patch=body.patch&&typeof body.patch==="object"?body.patch:{};const resetKeys=Array.isArray(body.resetKeys)?body.resetKeys:[];
          if(projectId){
            const project=state.projects().find(item=>item.id===projectId);if(!project)throw new Error("Project was not found");
            const result=state.updateProjectSettings(project.path,project.environmentId,patch,resetKeys);
            return json(res,200,{scope:"project",environmentId:project.environmentId||null,project:projectWithEnvironment(result.project),defaults:result.defaults,overrides:result.overrides,effective:result.effective});
          }
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
          state.updateEnvironmentDefaults(environmentId,patch,resetKeys);const defaults=state.environmentDefaults(environmentId);
          return json(res,200,{scope:"environment",environmentId,defaults,overrides:{},effective:defaults});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/worktree/cleanup"&&req.method==="POST"){
      try{const body=await readJsonBody(req);return json(res,200,await worktreeCleanup.sweep({reason:body.reason||null,path:body.path||null}))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/storage-cleanup"){
      if(req.method==="GET"){
        try{return json(res,200,await storageCleanup.snapshot())}
        catch(error){return json(res,500,{error:error.message});}
      }
      if(req.method==="POST"){
        try{return json(res,200,await storageCleanup.sweep({reason:"manual"}))}
        catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/worktree/ensure"&&req.method==="POST"){
      try{const body=await readJsonBody(req);if(!body.path)throw new Error("path is required");return json(res,200,await worktreeCleanup.ensure(body.path))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/project-actions/suggestions"&&req.method==="GET"){
      try{return json(res,200,await projectActionSuggestions(url.searchParams.get("path")||process.cwd()));}
      catch(error){return json(res,400,{scripts:[],error:error.message});}
    }
    if(url.pathname==="/api/project-script/run"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(body.path||process.cwd(),environmentId);
        const project=state.project(projectPath,environmentId);
        if(!project) return json(res,404,{error:"Project was not found"});
        const script=(project.scripts||[]).find(item=>item.id===String(body.scriptId||""));
        if(!script) return json(res,404,{error:"Project action was not found"});
        if(mock){
          const profile=environmentId?environments.get(environmentId):null;
          return json(res,200,{ok:true,script,session:{id:"mock-project-action",name:script.name,cwd:projectPath,environmentId,environmentName:profile?.name||"Local machine",environmentType:profile?.type||"local",running:true},previewUrl:script.previewUrl||null});
        }
        const key=projectActionKey(projectPath,environmentId,script.id);await projectActionStarted(key);
        const running=runningProjectAction(key);
        if(running)return json(res,200,{ok:true,script,session:actionSessionSummary(running),alreadyRunning:true,previewUrl:script.previewUrl||null});
        const starting=createProjectActionSession(projectPath,environmentId,script).then(session=>{projectActionSessions.set(key,session.id);return session});
        projectActionStarts.set(key,starting);
        let session;try{session=await starting}finally{if(projectActionStarts.get(key)===starting)projectActionStarts.delete(key)}
        return json(res,200,{ok:true,script,session:terminals.snapshot(session.id),previewUrl:script.previewUrl||null});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    // The actions of a project that run now (the header's action button shows it), and Stop for one, which keeps its terminal as
    // stopped history.
    if(url.pathname==="/api/project-script/runs"&&req.method==="GET"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),runs={};
        for(const script of state.project(projectPath,environmentId)?.scripts||[]){const running=runningProjectAction(projectActionKey(projectPath,environmentId,script.id));if(running)runs[script.id]=running.id}
        return json(res,200,{runs});
      }catch(error){return json(res,400,{runs:{},error:error.message});}
    }
    if(url.pathname==="/api/project-script/stop"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(body.path||process.cwd(),environmentId);
        if(mock)return json(res,200,{ok:true,session:null});
        const key=projectActionKey(projectPath,environmentId,body.scriptId),id=projectActionSessions.get(key);
        const stopped=id?await terminals.stop(id):null;if(!stopped?.running)projectActionSessions.delete(key);
        return json(res,200,{ok:true,session:stopped?actionSessionSummary(stopped):null});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/preview/servers"&&req.method==="GET"){
      try{return json(res,200,{servers:await discoverPreviewServers()});}
      catch(error){return json(res,200,{servers:[],error:error.message});}
    }
    if(url.pathname==="/api/thread-meta"){
      const id=url.searchParams.get("threadId");
      if(req.method==="GET"){
        if(id)return json(res,200,state.threadMeta(id));
        if(url.searchParams.get("view")==="catalog")return json(res,200,state.threadMetaCatalogPage({limit:url.searchParams.get("limit")||100,cursor:url.searchParams.get("cursor")||null}));
        return json(res,200,state.listThreadMeta());
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(!body.threadId) return json(res,400,{error:"threadId is required"});
          return json(res,200,state.updateThreadMeta(body.threadId,body.patch||{}));
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/stashes"){
      if(req.method==="GET") return json(res,200,{stashes:state.listStashes()});
      if(req.method==="POST"){
        try{return json(res,200,{stash:state.addStash(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) state.removeStash(id);
        return json(res,200,{ok:true});
      }
    }
    if(url.pathname==="/api/git/info"){
      try{
        const environmentId=url.searchParams.has("environmentId")
          ?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false})
          :requestedEnvironmentId(null);
        const profile=remoteEnvironmentProfile(environmentId);
        const cwd=environmentPath(url.searchParams.get("path")||profile?.cwd||process.cwd(),environmentId);
        const info=profile
          ?await inSourceControlEnvironment(environmentId,()=>sourceControlGitInfo(cwd))
          :await gitInfo(cwd);
        return json(res,200,{...info,environmentId:environmentId||null,environmentType:profile?.type||"local"});
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/git/action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const remoteProfile=remoteEnvironmentProfile(environmentId);
        const cwd=environmentPath(body.cwd||remoteProfile?.cwd||process.cwd(),environmentId);
        if(remoteProfile){
          if(body.action==="clone")return json(res,400,{error:"Clone into a remote environment from its Terminal or create the project after cloning."});
          const result=await tracedSourceControlMutation("git."+body.action,{cwd,environmentId},()=>inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(cwd,{
            action:body.action,
            name:body.action==="worktree-create"?body.branch:body.name,
            message:body.message,
            setUpstream:Boolean(body.setUpstream),
            startPoint:body.baseBranch||body.startPoint||null,
            path:body.path||null,
            force:Boolean(body.force),
          })));
          if(body.action==="init")state.touchProject(cwd,{environmentId});
          if(body.action==="worktree-create"&&body.path){
            const sourceProject=state.project(cwd,environmentId);
            const inherited=sourceProject?{
              defaultModel:sourceProject.defaultModel??null,
              permissionMode:sourceProject.permissionMode??null,
              workspaceMode:sourceProject.workspaceMode??null,
              worktreeSubmodules:sourceProject.worktreeSubmodules??null,
              worktreeCleanup:sourceProject.worktreeCleanup??null,
              settingsOverrides:sourceProject.settingsOverrides||{},
              icon:sourceProject.icon??null,
              scripts:sourceProject.scripts||[],
              preferredScriptId:sourceProject.preferredScriptId??null,
              hooks:sourceProject.hooks||[],
            }:{};
            state.touchProject(environmentPath(body.path,environmentId),{...inherited,environmentId,managedWorktree:{root:result.info?.root||cwd,branch:String(body.branch||""),baseBranch:String(body.baseBranch||result.info?.branch||""),submodules:"none",createdAt:Date.now(),cleanedAt:null,cleanupReason:null}});
          }
          return json(res,200,{ok:true,result});
        }
        let result;
        switch(body.action){
          case "clone": result=await tracedSourceControlMutation("git.clone",{cwd:body.destination},()=>cloneRepository(body.url,body.destination)); state.touchProject(result.root||body.destination,{environmentId:null}); break;
          case "init": result=await tracedSourceControlMutation("git.init",{cwd},()=>initializeRepository(cwd)); state.touchProject(result.root||cwd,{environmentId:null}); break;
          case "branch-create": result=await tracedSourceControlMutation("git.branch-create",{cwd},()=>createBranch(cwd,body.name,{checkout:body.checkout!==false,startPoint:body.startPoint||null})); break;
          case "branch-switch": result=await tracedSourceControlMutation("git.branch-switch",{cwd},()=>switchBranch(cwd,body.name)); break;
          case "commit": result=await tracedSourceControlMutation("git.commit",{cwd},()=>commitAll(cwd,body.message||"Trebell Code changes")); break;
          case "fetch": result=await tracedSourceControlMutation("git.fetch",{cwd},()=>fetchRepo(cwd)); break;
          case "pull": result=await tracedSourceControlMutation("git.pull",{cwd},()=>pullRepo(cwd)); break;
          case "push": result=await tracedSourceControlMutation("push",{cwd},()=>pushRepo(cwd,{setUpstream:Boolean(body.setUpstream)})); break;
          case "auto-pull": result=await tracedSourceControlMutation("git.auto-pull",{cwd},()=>safeAutoPull(cwd)); break;
          case "worktree-create": {
            const sourceProject=state.project(resolve(cwd),null);
            const projectConfig=await projectActionSuggestions(cwd).catch(()=>({t3:{}}));
            const scoped=sourceProject?state.projectSettings(sourceProject.path,null):{defaults:state.environmentDefaults(null),overrides:{}};
            const submodules=scoped.overrides.worktreeSubmodules||projectConfig?.t3?.worktreeSubmodules||scoped.defaults.worktreeSubmodules||"recursive";
            result=await tracedSourceControlMutation("git.worktree-create",{cwd},()=>createWorktree(cwd,{branch:body.branch,path:body.path,baseBranch:body.baseBranch||null,submodules}));
            const inherited=sourceProject?{
              defaultModel:sourceProject.defaultModel??null,
              permissionMode:sourceProject.permissionMode??null,
              workspaceMode:sourceProject.workspaceMode??null,
              worktreeSubmodules:sourceProject.worktreeSubmodules??null,
              worktreeCleanup:sourceProject.worktreeCleanup??null,
              settingsOverrides:sourceProject.settingsOverrides||{},
              icon:sourceProject.icon??null,
              scripts:sourceProject.scripts||[],
              preferredScriptId:sourceProject.preferredScriptId??null,
              hooks:sourceProject.hooks||[],
            }:{};
            state.touchProject(result.worktree,{...inherited,environmentId:null,managedWorktree:{root:result.info.root,branch:String(body.branch||""),baseBranch:String(body.baseBranch||result.info.branch||""),submodules,createdAt:Date.now(),cleanedAt:null,cleanupReason:null}});
            const setup=(sourceProject?.scripts||[]).find(script=>script.runOnWorktreeCreate);
            if(setup&&!mock&&terminals){
              const spec=commandShellSpec(setup.command,env);
              const session=await terminals.create({cwd:result.worktree,name:`${setup.name||"Setup"} · setup`,cols:120,rows:32,shell:spec.shell,args:spec.args,endsTree:true});
              result={...result,setup:{scriptId:setup.id,scriptName:setup.name,command:setup.command,waitForSetup:Boolean(setup.waitForSetup),session:terminals.snapshot(session.id)}};
            }
            break;
          }
          case "worktree-remove": result=await tracedSourceControlMutation("git.worktree-remove",{cwd},()=>removeWorktree(cwd,body.path,{force:Boolean(body.force)})); break;
          default:return json(res,400,{error:"unknown git action"});
        }
        return json(res,200,{ok:true,result});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/diagnostics"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>sourceControlDiagnostics(cwd,url.searchParams.get("provider")||null)));
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/prs"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>listPullRequests(cwd,{provider:url.searchParams.get("provider")||null})));
      }catch(error){return json(res,400,{ok:false,items:[],error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const result=await tracedSourceControlMutation("pr.create",{cwd,environmentId,provider:body.provider||null},()=>inSourceControlEnvironment(environmentId,()=>createPullRequest(cwd,body)));
        return json(res,200,{ok:true,...result});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/publish" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await tracedSourceControlMutation("publish",{cwd,environmentId,provider:body.provider||null},()=>inSourceControlEnvironment(environmentId,()=>publishRepository(cwd,body))));
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-detail"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,url.searchParams.get("number"),{provider:url.searchParams.get("provider")||null})));
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/settlements"&&req.method==="GET"){
      const enabled=Boolean(state.settings().autoSettleMergedThreads);const items=[];
      if(enabled)for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        const links=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
        const lifecycle=linkedPullRequestTerminalStatus(links.length?links:(meta.linkedPullRequests||[]));
        if(!lifecycle.terminal||meta.autoSettleAppliedSignature===lifecycle.signature)continue;
        const pending=meta?.autoSettlePending;
        items.push({threadId,signature:lifecycle.signature,requestedAt:Number(pending?.requestedAt)||null,reason:pending?.reason||"pull_requests_terminal"});
      }
      return json(res,200,{enabled,items});
    }
    if(url.pathname==="/api/source-control/branch-reviews"&&req.method==="GET"){
      const items=[];
      for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        if(!meta?.branch||meta.deletedAt)continue;
        items.push({
          threadId,branch:meta.branch,review:meta.branchPullRequest||null,
          lastSyncedAt:Number(meta.lastBranchPullRequestSyncAt)||null,error:meta.branchPullRequestSyncError||null,
        });
      }
      return json(res,200,{items});
    }
    if(url.pathname==="/api/source-control/thread-link"){
      if(req.method==="GET"){
        try{
          const threadId=String(url.searchParams.get("threadId")||"").trim();
          if(threadId)return json(res,200,{threadId,links:threadPullRequestLinks(threadId)});
          const identity=normalizePullRequestIdentity({
            provider:url.searchParams.get("provider"),host:url.searchParams.get("host"),repository:url.searchParams.get("repository"),number:url.searchParams.get("number"),url:url.searchParams.get("url"),
          });
          if(!identity)throw new Error("threadId or pull request identity is required");
          return json(res,200,{identity,threads:reversePullRequestLinks(identity)});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const action=String(body.action||"link");const threadId=String(body.threadId||"").trim();
          if(action==="resolve"){
            const identity=normalizePullRequestIdentity(body.identity||body.pr||{url:body.url})||parsePullRequestUrl(body.url);
            if(!identity)throw new Error("Not a pull request URL");
            const resolved=await resolvePullRequestIdentity(identity,{preferredPath:body.cwd||null,preferredEnvironmentId:body.environmentId||null});
            return json(res,200,{identity:resolved.detail.item.identity,project:resolved.project,pr:resolved.detail.item});
          }
          if(!threadId)throw new Error("threadId is required");
          if(action==="sync")return json(res,200,{ok:true,...await syncThreadPullRequestLinks(threadId)});
          if(action==="unlink"){
            const identity=normalizePullRequestIdentity(body.identity||body.pr||{url:body.url});return json(res,200,{ok:true,...removePullRequestLink(threadId,identity)});
          }
          if(action!=="link")throw new Error("Unknown pull request link action");
          let pr=body.pr&&typeof body.pr==="object"?body.pr:null;let identity=normalizePullRequestIdentity(pr?.identity||pr||{url:body.url});
          if(!identity&&body.cwd&&body.number){
            const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
            const cwd=environmentPath(body.cwd,environmentId);const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,body.number,{provider:body.provider||null}));
            if(!detail?.ok||!detail.item)throw new Error(detail?.error||"Pull request not found");pr=detail.item;identity=pr.identity;
          }
          if(!identity)throw new Error("Pull request identity is incomplete");
          if(!pr?.identity||!pr?.title||(!pr?.stack&&body.refresh!==false)){
            const resolved=await resolvePullRequestIdentity(identity,{preferredPath:body.cwd||null,preferredEnvironmentId:body.environmentId||null}).catch(()=>null);
            if(resolved?.detail?.item)pr={...pr,...resolved.detail.item};
          }
          const link=buildPullRequestLink({...pr,identity,url:pr?.url||body.url},{source:body.source||"manual"});
          return json(res,200,{ok:true,link,...storePullRequestLink(threadId,link)});
        }catch(error){return json(res,400,{ok:false,error:error.message});}
      }
    }
    if(url.pathname==="/api/source-control/pr-viewed"&&req.method==="GET"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId),number=url.searchParams.get("number"),provider=url.searchParams.get("provider")||null;
        const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,number,{provider}));if(!detail?.ok||!detail.item)return json(res,400,{error:detail?.error||"Pull request not found"});
        if(detail.provider==="github")return json(res,200,await inSourceControlEnvironment(environmentId,()=>getPullRequestFilesViewed(cwd,number,{provider:detail.provider})));
        const project=state.project(cwd,environmentId);const key=prViewedKey(detail.provider,number);const record=project?.pullRequestViewedFiles?.[key]||{};
        return json(res,200,{ok:true,provider:detail.provider,store:"environment",files:viewedStates(detail.item.files||[],record,detail.item.headSha),headSha:detail.item.headSha||null});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-viewed"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId),number=body.number,provider=body.provider||null,updates=Array.isArray(body.files)?body.files:[];
        const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,number,{provider}));if(!detail?.ok||!detail.item)throw new Error(detail?.error||"Pull request not found");
        if(detail.provider==="github")return json(res,200,await inSourceControlEnvironment(environmentId,()=>setPullRequestFilesViewed(cwd,number,updates,{provider:detail.provider})));
        const project=state.project(cwd,environmentId)||state.touchProject(cwd,{environmentId});const records={...(project.pullRequestViewedFiles||{})};const key=prViewedKey(detail.provider,number);records[key]=updateViewedRecord(detail.item.files||[],records[key]||{},detail.item.headSha,updates);state.touchProject(cwd,{environmentId,pullRequestViewedFiles:records});
        return json(res,200,{ok:true,provider:detail.provider,store:"environment",files:viewedStates(detail.item.files||[],records[key],detail.item.headSha),headSha:detail.item.headSha||null});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const action=String(body.action||""),provider=body.provider||null;
        const result=await tracedSourceControlMutation("pr."+action,{cwd,environmentId,provider,number:body.number,threadId:body.threadId||null},()=>{
          if(action==="edit")return inSourceControlEnvironment(environmentId,()=>editPullRequest(cwd,body.number,{provider,title:body.title,body:body.body}));
          if(action==="edit-comment")return inSourceControlEnvironment(environmentId,()=>editPullRequestComment(cwd,body.number,body.commentId,body.body||"",{provider}));
          if(action==="approve-workflows")return inSourceControlEnvironment(environmentId,()=>approvePullRequestWorkflows(cwd,body.number,{provider}));
          if(action==="revert")return inSourceControlEnvironment(environmentId,()=>revertPullRequest(cwd,body.number,{provider}));
          if(action==="rebase-stack")return inSourceControlEnvironment(environmentId,()=>rebasePullRequestStack(cwd,body.number,{provider}));
          if(action==="comment")return inSourceControlEnvironment(environmentId,()=>commentOnPullRequest(cwd,body.number,body.body||"",{provider}));
          if(action==="review")return inSourceControlEnvironment(environmentId,()=>reviewPullRequest(cwd,body.number,{provider,event:body.event,body:body.body||""}));
          if(action==="merge")return inSourceControlEnvironment(environmentId,()=>mergePullRequest(cwd,body.number,{provider,method:body.method,auto:Boolean(body.auto)}));
          if(action==="update-branch")return inSourceControlEnvironment(environmentId,()=>updatePullRequestBranch(cwd,body.number,{provider,rebase:body.rebase!==false}));
          if(action==="checkout")return inSourceControlEnvironment(environmentId,()=>checkoutPullRequest(cwd,body.number,{provider}));
          if(action==="request-reviewer")return inSourceControlEnvironment(environmentId,()=>requestPullRequestReviewer(cwd,body.number,body.reviewer,{provider}));
          throw new Error("unknown PR action");
        });
        return json(res,200,result);
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/git/commit-message" && req.method==="POST"){
      const cancellation=requestAbortController(req,res);
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const generated=await sourceControlTextRequest({cwd,environmentId,kind:"commit",model:body.model||null,signal:cancellation.signal});
        const message=generatedCommitSubject(generated.text);if(!message)throw new Error("The model did not return a commit subject");
        return json(res,200,{message,style:generated.style,model:generated.model,runtime:generated.runtime,generatedWith:generated.generatedWith});
      }catch(error){
        if(cancellation.signal.aborted)return;
        return json(res,sourceControlTextStatus(error),{error:error.message});
      }finally{cancellation.dispose()}
    }
    if(url.pathname==="/api/git/review-text" && req.method==="POST"){
      const cancellation=requestAbortController(req,res);
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const generated=await sourceControlTextRequest({cwd,environmentId,kind:"review",model:body.model||null,signal:cancellation.signal});
        const raw=generated.text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();
        let parsed=null;try{parsed=JSON.parse(raw)}catch{
          const start=raw.indexOf("{"),end=raw.lastIndexOf("}");if(start>=0&&end>start)try{parsed=JSON.parse(raw.slice(start,end+1))}catch{}
        }
        const lines=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        const title=String(parsed?.title||lines[0]||"").replace(/^[#*\-\s]+/,"").slice(0,100).trim();
        const reviewBody=String(parsed?.body||(!parsed?lines.slice(1).join("\n"):"")).trim();
        if(!title)throw new Error("The model did not return a pull request title");
        return json(res,200,{title,body:reviewBody,style:generated.style,model:generated.model,runtime:generated.runtime,generatedWith:generated.generatedWith});
      }catch(error){
        if(cancellation.signal.aborted)return;
        return json(res,sourceControlTextStatus(error),{error:error.message});
      }finally{cancellation.dispose()}
    }
    if(url.pathname==="/api/checkpoints"){
      if(req.method==="GET") return json(res,200,{checkpoints:checkpoints.list(url.searchParams.get("threadId")||null)});
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          const meta=body.threadId?state.threadMeta(String(body.threadId)):null;
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?(body.environmentId||null):(meta?.environmentId??null);
          const checkpoint=await checkpoints.create({...body,environmentId});
          recordCheckpointTrace(checkpoint?.supported===false?"checkpoint.skipped":"checkpoint.created",checkpoint?.supported===false?"unsupported":"completed",checkpoint,{threadId:body.threadId||null,reason:checkpoint?.reason||null});
          return json(res,200,checkpoint);
        }catch(error){
          recordCheckpointTrace("checkpoint.create_failed","error",null,{message:error.message});
          return json(res,400,{error:error.message});
        }
      }
    }
    if(url.pathname==="/api/checkpoints/link" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const checkpoint=checkpoints.link(body.id,body.patch||{});recordCheckpointTrace("checkpoint.linked","completed",checkpoint,{checkpointId:body.id,turnId:body.patch?.turnId||null});
        return json(res,200,{checkpoint});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/checkpoints/restore" && req.method==="POST"){
      let body=null,threadId=null,restoring=null;
      try{
        body=await readJsonBody(req);threadId=body.threadId?String(body.threadId):null;
        // The files of a thread whose turn runs (in any window, a Codex turn whose start is on its way too) stay as they are: the turn
        // is working on them, and its conversation could not be rewound with them (Edit from here restores the files first).
        if(threadId&&(threadTurnRuns(threadId)||restoringThreads.has(threadId)))return json(res,409,{error:"Stop the running turn first."});
        // While the files go back, no turn of the thread starts through Trebell; one that starts all the same (Codex starts a goal's next
        // turn by itself) has every file put back as it was, and the restore is refused like one under a running turn.
        if(threadId)restoringThreads.set(threadId,restoring={turnStarted:false});
        const result=await checkpoints.restore(body.id,{threadId});
        if(threadId&&(restoring.turnStarted||threadTurnRuns(threadId))){
          let filesPutBack=false;
          if(result.undoId)filesPutBack=await checkpoints.undoRestore(result.undoId,{threadId}).then(()=>true,error=>{recordCheckpointTrace("checkpoint.restore_failed","error",result.checkpoint,{checkpointId:body.id,threadId,message:error.message});return false});
          return json(res,409,{error:"Stop the running turn first.",filesPutBack});
        }
        recordCheckpointTrace("checkpoint.restored","completed",result.checkpoint,{checkpointId:body.id,threadId});
        return json(res,200,result);
      }catch(error){
        recordCheckpointTrace("checkpoint.restore_failed","error",null,{checkpointId:body?.id||null,threadId,message:error.message});
        // A restore that failed part-way says whether the files were put back as they were before it (CheckpointService.restore).
        return json(res,400,{error:error.message,...(typeof error?.filesPutBack==="boolean"?{filesPutBack:error.filesPutBack}:{})});
      }finally{if(threadId&&restoringThreads.get(threadId)===restoring)restoringThreads.delete(threadId)}
    }
    // Takes a restore back (Edit from here whose rewind the harness refused): every file as it was before the restore.
    if(url.pathname==="/api/checkpoints/undo" && req.method==="POST"){
      let body=null;
      try{
        body=await readJsonBody(req);const threadId=body.threadId?String(body.threadId):null;
        const result=await checkpoints.undoRestore(body.undoId,{threadId});recordCheckpointTrace("checkpoint.restore_undone","completed",null,{threadId});
        return json(res,200,result);
      }catch(error){
        recordCheckpointTrace("checkpoint.restore_undo_failed","error",null,{threadId:body?.threadId||null,message:error.message});
        return json(res,400,{error:error.message});
      }
    }
    if(url.pathname==="/api/terminal/sessions"){
      if(mock){
        if(req.method==="GET") return json(res,200,{sessions:[]});
        if(req.method==="POST") return json(res,200,{session:{id:"mock-terminal",name:"Terminal",cwd:process.cwd(),buffer:"",running:true}});
        if(req.method==="DELETE") return json(res,200,{ok:true});
      }
      if(req.method==="GET"){
        const filter=url.searchParams.has("environmentId")
          ?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false})
          :undefined;
        return json(res,200,{sessions:terminals.list(filter)});
      }
      if(req.method==="POST"){
        try{return json(res,200,{session:await createTerminalSession(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) await terminals.close(id);
        return json(res,200,{ok:true});
      }
    }

    if(url.pathname==="/api/bootstrap"){
      return json(res,200,await bootstrapPayload(req));
    }
    if(url.pathname==="/api/runtime"){
      // The UI polls this every few seconds and shows only the active harness, so probe that one CLI instead of every
      // installed harness (the official Cursor launcher alone takes seconds to answer).
      let activeInstance=null,agentRuntimeStatus=null;
      try{activeInstance=agentRuntimes.activeInstance();agentRuntimeStatus=await agentRuntimes.probe(activeInstance)}catch{}
      return json(res,200,{
        agentRuntime:selectedAgentRuntime,
        agentRuntimeInstanceId:activeInstance?.id||null,
        agentRuntimeStatus:agentRuntimeStatus||null,
        provider:selectedProvider,
        providerReady:providerReady(),
        appServerReady:mock || await appServerReady(appServer,appPort),
        appServerExitCode:appServer?.child?.exitCode ?? null,
        activeEnvironment:catalogEnvironment(),
        appServerError:appServer?.error||null,
        logs:[...(appServer?.logs||[])].sort((a,b)=>a.at-b.at).slice(-80),
      });
    }
    if(url.pathname==="/api/chat/direct" && req.method==="POST"){
      try{
        const payload=await readJsonBody(req);
        const prompt=String(payload.prompt||"").trim();
        const model=String(payload.model||"").trim();
        if(!prompt||!model) return json(res,400,{error:"prompt and model are required"});
        if(mock) return json(res,200,{text:`Mock direct reply: ${prompt}`,model,provider:selectedProvider,raw:{mock:true}});
        // Never send a prompt meant for another harness to the Native provider (e.g. while that harness reconnects).
        if(selectedAgentRuntime!=="native") return json(res,409,{error:"Direct chat is only available when Trebell Native is the active harness."});
        return json(res,200,await providers.directChat(selectedProvider,{prompt,model}));
      }catch(error){return json(res,502,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/tree"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceTree(url.searchParams.get("path")||process.cwd(),{environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/diff"){
      const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
      return json(res,200,await environmentWorkspaceDiff(url.searchParams.get("path")||process.cwd(),{environments,environmentId}));
    }
    if(url.pathname==="/api/visualization"&&(req.method==="GET"||req.method==="HEAD")){
      const headers={
        "content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",
        "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      };
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const result=await readVisualization({
          workspaceRoot:url.searchParams.get("root")||process.cwd(),path:url.searchParams.get("path")||null,file:url.searchParams.get("file")||null,
          threadId:url.searchParams.get("threadId")||null,environmentId,check:req.method==="HEAD",
        });
        res.writeHead(200,{...headers,"content-disposition":"inline; filename=\""+basename(result.path).replace(/\"/g,"")+"\""});
        return res.end(req.method==="HEAD"?undefined:result.content);
      }catch(error){
        // A visualization that cannot be shown is named by its file name alone, so a reply never shows a local path (the card asks with
        // HEAD first). A read that fails after that check (the file removed, or held open, in between) answers the card's frame with a
        // page that says so and tells the card, which says it in its own line.
        const missing=error?.code==="ENOENT"||/ENOENT|no such file/i.test(String(error?.message||""));
        if(req.method==="HEAD"){res.writeHead(missing?404:400);return res.end()}
        const said=((missing?"Visualization not found: ":"Could not show visualization ")+String(url.searchParams.get("path")||url.searchParams.get("file")||"").split(/[\\/]/).pop()).replace(/[&<>"']/g,ch=>"&#"+ch.charCodeAt(0)+";");
        res.writeHead(missing?404:400,headers);
        return res.end("<!doctype html><meta charset=utf-8><title>"+said+"</title><p>"+said+"</p><script>parent.postMessage({trebellVisualization:\""+(missing?"missing":"failed")+"\"},\"*\")</script>");
      }
    }
    if(url.pathname==="/api/workspace/raw"&&(req.method==="GET"||req.method==="HEAD")){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const located=environmentWorkspacePath(url.searchParams.get("root")||process.cwd(),url.searchParams.get("path")||"",{environments,environmentId});
        const requested=located.path;
        let info;
        if(located.remote)info=await environments.attachmentInfo(environmentId,requested);
        // Placed as the editor's read is, through '..' and links, so a picture behind a link out of the project is refused as its text is.
        else info={size:(await localWorkspaceFileInfo(located)).size};
        const type=MIME[extname(requested).toLowerCase()]||"application/octet-stream";
        const range=String(req.headers.range||"").match(/^bytes=(\d*)-(\d*)$/);
        // A workspace file is the repository's content, not the app's: one that can run scripts (HTML, SVG) is served sandboxed, so it
        // never runs with the app's origin however it is opened, and no file is read as a type it was not served as.
        const active=/^(?:text\/html|image\/svg\+xml)\b/.test(type);
        const common={"content-type":type,"accept-ranges":"bytes","cache-control":"no-store","content-disposition":`inline; filename="${basename(requested).replace(/"/g,"")}"`,"x-content-type-options":"nosniff",...(active?{"content-security-policy":"sandbox"}:{})};
        if(info.size===0){
          res.writeHead(200,{...common,"content-length":"0"});
          return res.end();
        }
        if(range){
          let start=range[1]?Number(range[1]):0;
          let end=range[2]?Number(range[2]):info.size-1;
          if(!range[1]&&range[2]){const suffix=Number(range[2]);start=Math.max(0,info.size-suffix);end=info.size-1}
          start=Math.max(0,Math.min(start,info.size-1));end=Math.max(start,Math.min(end,info.size-1));
          res.writeHead(206,{...common,"content-range":`bytes ${start}-${end}/${info.size}`,"content-length":String(end-start+1)});
          if(req.method==="HEAD")return res.end();
          if(located.remote){
            const child=environments.streamFile(environmentId,requested,{start,length:end-start+1});
            child.once("error",()=>res.destroy());
            req.once("close",()=>{if(child.exitCode===null)child.kill()});
            return child.stdout.pipe(res);
          }
          return createReadStream(requested,{start,end}).pipe(res);
        }
        res.writeHead(200,{...common,"content-length":String(info.size)});
        if(req.method==="HEAD")return res.end();
        if(located.remote){
          const child=environments.streamFile(environmentId,requested);
          child.once("error",()=>res.destroy());
          req.once("close",()=>{if(child.exitCode===null)child.kill()});
          return child.stdout.pipe(res);
        }
        return createReadStream(requested).pipe(res);
      }catch(error){return json(res,404,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/file"){
      if(req.method==="PUT"){
        try{
          const body=await readJsonBody(req,4*1024*1024);
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
          const saved=await environmentWorkspaceEditorSave(body.path,body.content,{version:body.version??null,root:body.root||null,environments,environmentId});
          return json(res,saved.conflict?409:200,saved);
        }catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
      }
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceEditorFile(url.searchParams.get("path")||"",{root:url.searchParams.get("root")||null,environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/search"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceSearch(url.searchParams.get("path")||process.cwd(),url.searchParams.get("q")||"",{environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/files"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchFiles({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/map"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.repositoryMap({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||60),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/commands"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.projectCommands({root,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId),files=url.searchParams.getAll("file").filter(Boolean),riskHints=url.searchParams.getAll("risk").filter(Boolean);
        const plan=withInstalledVerificationHooks(await contextEngine.verificationPlan({root,paths:files.length?files:null,riskHints,capabilities:{diagnostics:!['0','false','no'].includes(String(url.searchParams.get("diagnostics")||"").toLowerCase()),semanticDiagnostics:['1','true','yes'].includes(String(url.searchParams.get("semantic")||"").toLowerCase())},io:remote?createRemoteContextIo({environments,environmentId,root}):null}),{cwd:root,environmentId});
        return json(res,200,plan);
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification/assess"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024);
        return json(res,200,contextEngine.assessVerification({plan:body.plan,evidence:Array.isArray(body.evidence)?body.evidence:[]}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification/next"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024);
        return json(res,200,contextEngine.nextVerificationAction({plan:body.plan,evidence:Array.isArray(body.evidence)?body.evidence:[]}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification/plan-turn"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024),threadId=String(body.threadId||"").trim(),turnId=String(body.turnId||"").trim();
        if(!threadId||!turnId)return json(res,400,{error:"threadId and turnId are required"});
        const meta=state.threadMeta(threadId),continuationChain=meta?.verificationContinuationChain||null;
        if(continuationChain?.lastContinuationTurnId&&String(continuationChain.lastContinuationTurnId)===turnId&&continuationChain.sourceRecordId){
          const sourceRecord=state.verificationRecords({threadId,limit:100}).find(item=>String(item?.id||"")===String(continuationChain.sourceRecordId))||null;
          if(sourceRecord){
            const environmentId=meta?.environmentId??null,root=sourceRecord.projectPath||meta?.cwd||process.cwd(),remote=remoteEnvironmentProfile(environmentId),verificationIo=remote?createRemoteContextIo({environments,environmentId,root}):null,agentTurn=agentThreads.get(threadId)?.turns?.find(turn=>String(turn?.id||"")===turnId)||null,traces=eventJournal.list({threadId,turnId,limit:500});
            const observed=collectVerificationEvidence({plan:sourceRecord.plan,turnItems:agentTurn?.items||[],traces}),merged=mergeVerificationEvidence(sourceRecord.evidence,observed),automatic=await runAutomaticVerificationEvidence({contextEngine,plan:sourceRecord.plan,evidence:merged,root,io:verificationIo}),assessment=contextEngine.assessVerification({plan:sourceRecord.plan,evidence:automatic.evidence});
            const record=state.recordVerification({environmentId,projectPath:root,threadId,turnId,plan:sourceRecord.plan,evidence:automatic.evidence,assessment}),nextAction=contextEngine.nextVerificationAction({plan:record.plan,evidence:record.evidence});
            eventJournal.record({environmentId,threadId,turnId,category:"verification",name:"verification.continuation_evaluated",status:assessment.status,data:{recordId:record.id,sourceRecordId:sourceRecord.id,evidenceCount:record.evidence.length,newEvidenceCount:observed.length,nextAction:nextAction.action,nextStepId:nextAction.nextStep?.id||null}});
            return json(res,200,{supported:true,continuation:true,sourceRecordId:sourceRecord.id,checkpointId:null,threadId,turnId,changedPaths:[],record,nextAction});
          }
        }
        const checkpoint=checkpoints.list(threadId).filter(item=>String(item.turnId||"")===turnId).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]||null;
        if(!checkpoint)return json(res,200,{supported:false,reason:"checkpoint_unavailable",threadId,turnId,changedPaths:[],record:null,nextAction:null});
        const changed=await checkpoints.changedPaths(checkpoint.id,{threadId});
        if(!changed.paths.length){
          eventJournal.record({environmentId:state.threadMeta(threadId)?.environmentId??null,threadId,turnId,category:"verification",name:"verification.skipped",status:"completed",data:{checkpointId:checkpoint.id,reason:"no_workspace_changes"}});
          return json(res,200,{supported:true,checkpointId:checkpoint.id,threadId,turnId,changedPaths:[],record:null,nextAction:{action:"complete",reason:"No workspace file changes were detected since the pre-turn checkpoint."}});
        }
        const environmentId=meta?.environmentId??null,remote=remoteEnvironmentProfile(environmentId),verificationIo=remote?createRemoteContextIo({environments,environmentId,root:changed.root}):null,riskHints=Array.isArray(body.riskHints)?body.riskHints.map(String).filter(Boolean).slice(0,20):[];
        const plan=withInstalledVerificationHooks(await contextEngine.verificationPlan({root:changed.root,paths:changed.paths,riskHints,capabilities:{diagnostics:body.diagnostics!==false,semanticDiagnostics:Boolean(body.semanticDiagnostics)},io:verificationIo}),{cwd:changed.root,environmentId});
        const agentTurn=agentThreads.get(threadId)?.turns?.find(turn=>String(turn?.id||"")===turnId)||null;
        const traces=eventJournal.list({threadId,turnId,limit:500}),collectedEvidence=collectVerificationEvidence({plan,turnItems:agentTurn?.items||[],traces});
        const automatic=await runAutomaticVerificationEvidence({contextEngine,plan,evidence:collectedEvidence,root:changed.root,io:verificationIo}),evidence=automatic.evidence,assessment=contextEngine.assessVerification({plan,evidence});
        const record=state.recordVerification({environmentId:meta?.environmentId??null,projectPath:changed.root,threadId,turnId,plan,evidence,assessment});
        const nextAction=contextEngine.nextVerificationAction({plan:record.plan,evidence:record.evidence});
        if(automatic.attempted.length)eventJournal.record({environmentId,threadId,turnId,category:"verification",name:"diagnostics.generated",status:record.evidence.find(item=>item.stepId==="diagnostics")?.status||assessment.status,data:{recordId:record.id,checkpointId:checkpoint.id,pathCount:automatic.attempted.length,errorCount:Number(record.evidence.find(item=>item.stepId==="diagnostics")?.errorCount)||0,semantic:Boolean(plan.steps.find(step=>step.id==="diagnostics")?.semantic)}});
        eventJournal.record({environmentId:meta?.environmentId??null,threadId,turnId,category:"verification",name:"verification.planned",status:assessment.status,data:{recordId:record.id,checkpointId:checkpoint.id,projectPath:changed.root,risk:assessment.risk,changedPathCount:changed.paths.length,changedPaths:changed.paths.slice(0,100),evidenceCount:evidence.length,automaticEvidenceCount:automatic.attempted.length,nextAction:nextAction.action,nextStepId:nextAction.nextStep?.id||null}});
        return json(res,200,{supported:true,checkpointId:checkpoint.id,threadId,turnId,changedPaths:changed.paths,record,nextAction});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification-records/repair-context"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024),threadId=String(body.threadId||"").trim();if(!threadId)throw new Error("threadId is required");
        const prepared=codexVerificationState(threadId,body.recordId||null);if(!prepared.record)throw new Error("No persisted verification record is available for this thread.");
        if(prepared.nextAction.action!=="repair")throw new Error("Latest verification does not require repair (next action: "+prepared.nextAction.action+").");
        return json(res,200,{record:prepared.record,nextAction:prepared.nextAction,prompt:verificationRepairPrompt(),context:verificationRepairContext(prepared)});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification-records"){
      if(req.method==="GET"){
        const options={limit:Number(url.searchParams.get("limit")||100)};
        if(url.searchParams.has("threadId"))options.threadId=url.searchParams.get("threadId");
        if(url.searchParams.has("projectPath"))options.projectPath=url.searchParams.get("projectPath");
        if(url.searchParams.has("environmentId")){const raw=url.searchParams.get("environmentId");options.environmentId=!raw||raw==="local"?null:raw}
        return json(res,200,{records:state.verificationRecords(options)});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req,2*1024*1024),evidence=Array.isArray(body.evidence)?body.evidence:[],assessment=contextEngine.assessVerification({plan:body.plan,evidence});
          const environmentId=!body.environmentId||body.environmentId==="local"?null:String(body.environmentId);
          const record=state.recordVerification({id:body.id,environmentId,projectPath:body.projectPath||body.path||null,threadId:body.threadId||null,turnId:body.turnId||null,plan:body.plan,evidence,assessment});
          const nextAction=contextEngine.nextVerificationAction({plan:record.plan,evidence:record.evidence});
          eventJournal.record({environmentId,threadId:record.threadId||null,turnId:record.turnId||null,category:"verification",name:"verification.completed",status:assessment.status,data:{recordId:record.id,projectPath:record.projectPath||null,risk:assessment.risk,verified:Boolean(assessment.verified),summary:assessment.summary,nextAction:nextAction.action,nextStepId:nextAction.nextStep?.id||null}});
          return json(res,200,{record,nextAction});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/context/symbols"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchSymbols({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||40),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/relations"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.fileRelations({root,path:url.searchParams.get("file")||"",io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/tests"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.relatedTests({root,path:url.searchParams.has("file")?url.searchParams.get("file"):null,name:url.searchParams.has("name")?url.searchParams.get("name"):null,limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/calls"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.callHierarchy({root,name:url.searchParams.get("name")||"",path:url.searchParams.has("file")?url.searchParams.get("file"):null,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/diagnostics"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.diagnostics({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||100),semantic:["1","true","yes"].includes(String(url.searchParams.get("semantic")||"").toLowerCase()),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/language-symbol"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.languageSymbol({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),operation:url.searchParams.get("operation")||"definition",limit:Number(url.searchParams.get("limit")||100),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/code-actions"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId),codes=String(url.searchParams.get("codes")||"").split(",").map(value=>Number(String(value).replace(/^TS/i,""))).filter(Number.isFinite);
        return json(res,200,await contextEngine.codeActions({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),limit:Number(url.searchParams.get("limit")||20),codes,io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/organize-imports"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.organizeImports({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/rename-preview"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.renamePreview({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),newName:url.searchParams.get("newName")||"",limit:Number(url.searchParams.get("limit")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/references"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.symbolReferences({root,name:url.searchParams.get("name")||"",path:url.searchParams.has("file")?url.searchParams.get("file"):null,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/search"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchCode({root,query:url.searchParams.get("q")||"",regex:["1","true"].includes(url.searchParams.get("regex")),caseSensitive:["1","true"].includes(url.searchParams.get("caseSensitive")),limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/source"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.readSourceRange({root,path:url.searchParams.get("file")||"",startLine:Number(url.searchParams.get("startLine")||1),endLine:url.searchParams.has("endLine")?Number(url.searchParams.get("endLine")):null,maxLines:Number(url.searchParams.get("maxLines")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/git"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitContext({root,io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/history"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitHistory({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||20),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/blame"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitBlame({root,path:url.searchParams.get("file")||"",startLine:Number(url.searchParams.get("startLine")||1),endLine:url.searchParams.has("endLine")?Number(url.searchParams.get("endLine")):null,maxLines:Number(url.searchParams.get("maxLines")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/packet"&&req.method==="POST"){
      const cancellation=requestAbortController(req,res);
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const root=environmentPath(body.path||process.cwd(),environmentId);
        const remote=remoteEnvironmentProfile(environmentId);
        const packet=await contextEngine.buildPacket({
          root,
          task:body.task||"",
          focusPaths:Array.isArray(body.focusPaths)?body.focusPaths:[],
          maxTokens:body.maxTokens,
          maxFiles:body.maxFiles,
          tokensUsed:body.tokensUsed,
          contextWindow:body.contextWindow,
          io:remote?createRemoteContextIo({environments,environmentId,root}):null,
          signal:cancellation.signal,
        });
        return json(res,200,repositoryContextDeliveryPacket(packet,{seedOnly:body.deliveryProjection==="seed",currentTask:body.userTask||""}));
      }catch(error){
        if(cancellation.signal.aborted||error?.name==="AbortError")return;
        return json(res,400,{error:error.message});
      }finally{cancellation.dispose()}
    }
    if(url.pathname==="/api/attachments/text" && req.method==="POST"){
      try{
        const body=await readJsonBody(req,70*1024*1024);
        const dir=join(trebellHome(env),"attachments");
        await mkdir(dir,{recursive:true});
        const safe=safeAttachmentName(body.name,"pasted-context.txt");
        const path=join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
        await writeFile(path,String(body.text||""),"utf8");
        return json(res,200,{path,name:basename(path),size:Buffer.byteLength(String(body.text||""),"utf8"),mime:"text/plain"});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/blob" && req.method==="POST"){
      try{
        const body=await readJsonBody(req,72*1024*1024);
        const data=Buffer.from(String(body.dataBase64||""),"base64");
        const mime=String(body.mime||"application/octet-stream").toLowerCase();
        const maxBytes=mime.startsWith("image/")?10*1024*1024:50*1024*1024;
        if(data.length>maxBytes) return json(res,413,{error:`${mime.startsWith("image/")?"Image":"Attachment"} is larger than ${Math.round(maxBytes/1024/1024)} MB`});
        const dir=join(trebellHome(env),"attachments");
        await mkdir(dir,{recursive:true});
        const safe=safeAttachmentName(body.name,"attachment.bin");
        const path=join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
        await writeFile(path,data);
        // A document's text is extracted once the composer takes the upload in (/api/attachments/import, next), which knows the
        // environment: a thread in a remote environment gets a copy on its host, where no text of this machine's is named.
        return json(res,200,{path,name:basename(path),size:data.length,mime});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/import"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024);
        const paths=Array.isArray(body.paths)?body.paths.slice(0,100):[];
        if(!paths.length)return json(res,200,{files:[]});
        const files=[];
        for(const path of paths){const file=await environments.prepareAttachment(body.environmentId||null,path);files.push(file.copied?file:await withDocumentText(file))}
        return json(res,200,{files});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/validate"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024);const paths=Array.isArray(body.paths)?body.paths:[];
        const result=await environments.validateAttachments(body.environmentId||null,paths),profile=body.environmentId?environments.get(body.environmentId):null;
        // A message about to go names each document's extracted text, extracted now if its attaching did not (T3 claims a message's
        // attachments the same way); a remote environment's files are on its host. A send checks its files twice, and the second
        // check, which comes right after the first, asks for no extraction (extract: false): a send extracts each document once.
        if(!profile||profile.type==="local")for(const [index,file] of result.files.entries())result.files[index]=await withDocumentText(file,{extract:body.extract!==false});
        return json(res,200,result);
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/models"){
      const runtime=selectedAgentRuntime,provider=selectedProvider;
      try{
        return json(res,200,await selectedModelsPayload());
      }catch(error){
        return json(res,503,{...(runtime==="native"?{provider}:{}),agentRuntime:runtime,ready:false,models:[],defaultModel:null,error:error instanceof Error?error.message:String(error)});
      }
    }
    if(url.pathname==="/api/update/check"){
      try{
        // Releases are published to their own repository (package.json build.publish), which the desktop updater reads too.
        const response=await fetchImpl("https://api.github.com/repos/tanishqbaweja/trebellcode-releases/releases/latest",{headers:{"User-Agent":"Trebell-Code/"+TREBELL_VERSION},signal:AbortSignal.timeout(8000)});
        const item=await response.json().catch(()=>({}));
        if(!response.ok){
          const detail=String(item?.message||"").trim();
          return json(res,502,{current:TREBELL_VERSION,error:`GitHub release check failed (${response.status})${detail?": "+detail:""}`});
        }
        return json(res,200,{current:TREBELL_VERSION,latest:item.tag_name||null,url:item.html_url||null,name:item.name||null});
      }catch(error){return json(res,502,{current:TREBELL_VERSION,error:"Could not reach GitHub releases: "+(error?.message||String(error))});}
    }
    if(url.pathname==="/api/licenses"&&req.method==="GET"){
      try{return json(res,200,await listLicenses({query:url.searchParams.get("q")||""}))}
      catch(error){return json(res,500,{error:error.message});}
    }
    if(url.pathname==="/api/licenses/detail"&&req.method==="GET"){
      try{return json(res,200,await licenseDetail(url.searchParams.get("id")||""))}
      catch(error){return json(res,404,{error:error.message});}
    }
    if(url.pathname==="/api/diagnostics"){
      const cwd=url.searchParams.get("path")||process.cwd();
      return json(res,200,{
        version:TREBELL_VERSION,
        runtime:{provider:selectedProvider,providerReady:providerReady(),appServerReady:mock||await appServerReady(appServer,appPort),appServerExitCode:appServer?.child?.exitCode??null},
        state:{projects:state.projects(),settings:state.settings(),threadMeta:state.listThreadMeta()},
        git:await gitInfo(cwd).catch(error=>({error:error.message})),
        terminalSessions:mock?[]:terminals.list(),
        logs:[...(appServer?.logs||[])].sort((a,b)=>a.at-b.at).slice(-100),
      });
    }
    if(url.pathname==="/api/stats") return json(res,200,statsSnapshot());
    if(url.pathname==="/api/health") return json(res,200,{ok:true});
    if(url.pathname.startsWith("/api/")) return json(res,404,{error:"API route not found"});

    let path=url.pathname==="/" ? "/index.html" : url.pathname;
    path=normalize(path).replace(/^([.][.][/\\])+/, "");
    let file=resolve(dist,`.${path}`);
    if(!file.startsWith(dist)) return json(res,403,{error:"forbidden"});
    try{
      let info=await stat(file);
      if(info.isDirectory()){file=join(file,"index.html");info=await stat(file)}
      return await sendUiFile(req,res,{dist,file,info});
    }catch{
      try{
        const index=join(dist,"index.html");
        return await sendUiFile(req,res,{dist,file:index,info:await stat(index)});
      }catch{
        return json(res,503,{error:"Trebell UI is not built. Run npm run ui:build first."});
      }
    }
  });

  async function codexThreadProfiles(threadId){
    const id=String(threadId||"").trim();if(!id)throw Object.assign(new Error("threadId is required"),{code:-32602});
    const meta=state.threadMeta(id);const environmentId=meta.environmentId??state.settings().activeEnvironmentId??null;
    const current=codexInstance(meta.runtimeInstanceId)||codexInstance();if(!current)return {supported:false,label:"Codex profile",currentInstanceId:null,items:[],reason:"No Codex runtime profile is configured."};
    const compatibleIds=new Set(agentRuntimes.compatibleInstanceIds(current));
    const compatible=agentRuntimes.instances().filter(instance=>instance.kind==="codex"&&compatibleIds.has(instance.id));
    const items=await Promise.all(compatible.map(async instance=>{
      const status=await agentRuntimes.probe(instance,{environmentId}).catch(error=>({available:false,message:error.message||String(error)}));
      return {id:instance.id,displayName:instance.displayName||instance.id,current:instance.id===current.id,available:Boolean(status?.available),authenticated:status?.authenticated??null,version:status?.version||null,message:status?.message||null};
    }));
    return {supported:true,label:"Codex profile",currentInstanceId:current.id,items};
  }
  async function setCodexThreadProfile(threadId,instanceId){
    const id=String(threadId||"").trim(),targetId=String(instanceId||"").trim();if(!id||!targetId)throw Object.assign(new Error("threadId and instanceId are required"),{code:-32602});
    const meta=state.threadMeta(id);if(meta.active)throw new Error("Stop the running turn before switching Codex profiles.");
    const environmentId=meta.environmentId??state.settings().activeEnvironmentId??null;
    const current=codexInstance(meta.runtimeInstanceId)||codexInstance();const target=codexInstance(targetId);
    if(!target||!current)throw new Error("Codex runtime profile was not found");
    if(!agentRuntimes.compatibleInstanceIds(current).includes(target.id))throw new Error("This Codex profile uses a different CODEX_HOME, so it cannot continue this thread.");
    const status=await agentRuntimes.probe(target,{environmentId});if(!status.available)throw new Error(status.message||"The selected Codex profile is unavailable");
    if(target.id===current.id)return {threadId:id,runtimeInstanceId:target.id};
    await releaseCodexThreadServer(id);
    try{
      const targetServer=await ensureCodexAppServer(target.id,{environmentId,ownerKey:`thread:${id}`});if(targetServer.error)throw new Error(targetServer.error);
      codexThreadServerKeys.set(id,targetServer.poolKey);
    }catch(error){
      const restored=await ensureCodexAppServer(current.id,{environmentId,ownerKey:`thread:${id}`}).catch(()=>null);if(restored&&!restored.error)codexThreadServerKeys.set(id,restored.poolKey);
      throw error;
    }
    state.updateThreadMeta(id,{runtime:"codex",runtimeInstanceId:target.id,environmentId,active:false});
    return {threadId:id,runtimeInstanceId:target.id};
  }
  async function codexRelayTarget(message){
    const threadId=String(message?.params?.threadId||message?.params?._trebellThreadId||"").trim();
    if(threadId&&codexThreadReleases.has(threadId))await codexThreadReleases.get(threadId);
    const meta=threadId?state.threadMeta(threadId):{};const environmentId=threadId?(meta.environmentId??state.settings().activeEnvironmentId??null):(state.settings().activeEnvironmentId||null);
    let instance=threadId&&meta.runtimeInstanceId?codexInstance(meta.runtimeInstanceId):null;if(!instance)instance=codexInstance();
    if(!instance)throw new Error("Codex runtime profile was not found");
    const remote=environmentId?environments.get(environmentId):null;
    let server;
    if(message?.method==="thread/start"){
      server=await ensureCodexAppServer(instance.id,{environmentId,ownerKey:`start:${String(message.id??randomUUID())}`});
    }else if(threadId){
      const existingKey=codexThreadServerKeys.get(threadId);const existing=existingKey?codexAppServers.get(existingKey):null;
      if(existing&&(mock||(!existing.error&&existing.child&&!childEnded(existing.child))))server=existing;
      else{
        server=await ensureCodexAppServer(instance.id,{environmentId,ownerKey:`thread:${threadId}`});
        codexThreadServerKeys.set(threadId,server.poolKey);
      }
    }else server=await catalogAppServer();
    if(server?.error)throw new Error(server.error);
    if(threadId&&!meta.runtimeInstanceId&&["thread/resume","thread/read","turn/start","turn/interrupt","turn/steer","thread/compact/start","thread/revert","review/start"].includes(message?.method))state.updateThreadMeta(threadId,{runtime:"codex",runtimeInstanceId:instance.id,environmentId});
    return {key:server.poolKey,url:server.targetUrl};
  }

  const terminalWs=terminals?.attachWebSocket(server);
  // A Codex thread as the windows list it: one whose first message began a goal shows the objective, as its message does.
  const codexListedThread=thread=>{const preview=thread&&typeof thread.preview==="string"?withoutCodexGoalStart(thread.preview):null;return preview!=null&&preview!==thread.preview?{...thread,preview}:thread};
  const relay=attachCodexRelay(server,{
    // A mock server runs no Codex: its requests go to the app-server port it was given, where a test's stand-in answers. A real one
    // has no such fallback, since a program on a fixed port is not this Trebell's Codex.
    targetUrl:()=>appServer?.targetUrl||(mock&&appPort?`ws://127.0.0.1:${appPort}`:null),
    resolveTarget:message=>codexRelayTarget(message),
    // A thread's app-server that is released leaves the pool before it is stopped, and one started in its place has another URL; one
    // that died is still there.
    targetLive:({key,url})=>codexAppServers.get(key)?.targetUrl===url,
    // The token of the app-server Trebell started for the connection's route (startAppServer, here or on a WSL or SSH host;
    // codexUpstreamToken): its pool entry, or the catalog app-server for the base route. A mock server's stand-in has none.
    upstreamToken:(url,route)=>codexUpstreamToken(codexAppServers,{key:route?.key,url},appServer),
    transformClientMessage:message=>transformCodexClientMessage(message),
    handleServerRequest:async message=>resolveCodexServerRequest(message),
    // A card whose "Allow session" allows its kind for the rest of the thread's session says which (trebellSessionScope, command or
    // fileChange; codex-session-approvals.mjs). A file change's card names the files it touches (trebellFileChanges), which Codex's
    // request leaves out, each from the thread's workspace when it is inside it: the first 200, and how many more there are
    // (trebellFileChangesMore).
    transformServerRequest:message=>{
      const scope=message?.params&&typeof message.params==="object"?codexApprovalAllowances.get(message.params)?.kind||null:null;
      const asked=scope?{...message,params:{...message.params,trebellSessionScope:scope}}:message;
      if(message?.method!=="item/fileChange/requestApproval"&&message?.method!=="applyPatchApproval")return asked;
      const files=codexApprovalFiles(message);if(!files.length)return asked;
      const workspace=state.threadMeta(approvalThreadId(message.params))?.cwd||null,shown=path=>path&&workspaceFilePath(workspace,path);
      return {...asked,params:{...asked.params,trebellFileChanges:files.slice(0,200).map(file=>({...file,path:shown(file.path),movePath:shown(file.movePath)})),...(files.length>200?{trebellFileChangesMore:files.length-200}:{})}};
    },
    // The person's "Allow session" allows the request's kind in its thread and mode from here (codex-session-approvals.mjs).
    onServerRequestAnswered:(message,{method,params})=>{
      const pending=params&&typeof params==="object"?codexApprovalAllowances.get(params):null;if(!pending)return;
      codexApprovalAllowances.delete(params);
      if(!message?.error&&allowsSession(method,message?.result))pending.allowance.add(pending.kind);
    },
    handleRequest:async (message,{requestUpstream,connected})=>{
      const params=message.params||{},threadId=params.threadId?String(params.threadId):"";
      // A window that reads the thread or its goal can make the pause of a goal Codex starts no next turn for, should the windows that
      // saw its turn end go (codexGoalContinuations); its read of the goal makes one owed first, so it reads the goal as it ends up.
      if(threadId&&(message.method==="thread/resume"||message.method==="thread/read"||message.method==="thread/goal/get"))codexGoalContinuations.follow(threadId,{requestUpstream,connected});
      if(message.method==="thread/goal/get"){
        const owed=threadId?codexGoalContinuations.take(threadId):null;if(owed)await pauseUncontinuedCodexGoal(threadId,owed.turnId,requestUpstream,{owed:true});
        return {handled:true,result:{goal:threadId?await readCodexGoal(threadId,requestUpstream):null}};
      }
      if(message.method==="thread/goal/set"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        return {handled:true,result:{goal:await setCodexGoal(threadId,params,requestUpstream)}};
      }
      if(message.method==="thread/goal/clear"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        return {handled:true,result:await clearCodexGoal(threadId,requestUpstream)};
      }
      if(message.method==="thread/continuity/get")return {handled:true,result:{continuity:threadId?durableCodexContinuity(threadId):null}};
      if(message.method==="thread/continuity/set"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        const meta=state.threadMeta(threadId),continuityNotes=normalizeContinuityNotes(meta?.continuityNotes||null,params);
        state.updateThreadMeta(threadId,{continuityNotes});const continuity=durableCodexContinuity(threadId);
        relay.broadcast("thread/continuity/updated",{threadId,continuity});return {handled:true,result:{continuity}};
      }
      if(message.method==="thread/continuity/clear"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        state.updateThreadMeta(threadId,{continuityNotes:undefined});const continuity=durableCodexContinuity(threadId);
        relay.broadcast("thread/continuity/updated",{threadId,continuity});return {handled:true,result:{ok:true,continuity}};
      }
      // While Edit from here puts the thread's files back, no turn of it starts through Trebell: one the window asks for, nor one the
      // server starts for it (verification's next step or repair, which would also make a checkpoint of the files half restored).
      if(threadId&&startsCodexTurn(message.method)&&restoringThreads.has(threadId))throw Object.assign(new Error("This thread's files are going back for Edit from here. Send again once that is done."),{code:-32001});
      if(message.method==="thread/verification/get")return {handled:true,result:threadId?codexVerificationState(threadId,params.recordId||null):{record:null,nextAction:null}};
      if(message.method==="thread/verification/evidence/record"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});const turnId=String(params.turnId||"").trim();if(!turnId)throw Object.assign(new Error("turnId is required"),{code:-32602});
        const evidence=normalizeBrowserVerificationReceipt(params.evidence||{}),meta=state.threadMeta(threadId);eventJournal.record({runtime:"codex",provider:codexRuntimeProvider(threadId),environmentId:meta?.environmentId??null,threadId,turnId,category:"verification",name:"verification.browser_evidence",status:evidence.success?"completed":"failed",data:evidence});return {handled:true,result:{ok:true}};
      }
      if(message.method==="thread/verification/repair"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        return {handled:true,result:await repairCodexVerification(threadId,params,requestUpstream)};
      }
      if(message.method==="thread/verification/continue"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        return {handled:true,result:await continueCodexVerification(threadId,params,requestUpstream)};
      }
      if(message.method==="thread/delegate")return {handled:true,result:await delegateCodexThread(params,requestUpstream)};
      if(((message.method==="turn/start"&&params.turnTrigger!=="trebell-restart-continuation")||message.method==="thread/queue/start")&&threadId)assertCodexGoalBudget(threadId);
      if(message.method==="thread/runtimeInstances/list")return {handled:true,result:await codexThreadProfiles(message.params?.threadId)};
      if(message.method==="thread/runtimeInstance/set")return {handled:true,result:await setCodexThreadProfile(message.params?.threadId,message.params?.instanceId)};
      return null;
    },
    // Codex's goal notifications reach the renderer with Trebell's guidance and budget figures added; a finished turn
    // checks the budgets only Trebell tracks.
    // A thread whose own app-server died: its resumes name the death until its next turn (noteCodexAppServerExit).
    // A thread a Codex goal's first message began is listed by its objective, as the person typed it (codex-goal-start.mjs).
    transformServerResponse:(message,{requestMethod,requestParams})=>{
      const result=message?.result,listed=codexListedThread(result?.thread),page=Array.isArray(result?.data)?result.data.map(codexListedThread):null;
      if(listed!==result?.thread)message={...message,result:{...result,thread:listed}};
      if(page&&page.some((thread,index)=>thread!==result.data[index]))message={...message,result:{...message.result,data:page}};
      if(requestMethod!=="thread/resume"||!message?.result?.thread)return message;
      const exit=codexAppServerExits.get(String(requestParams?.threadId||message.result.thread.id||""));
      return exit?{...message,result:{...message.result,trebellAppServerExit:exit}}:message;
    },
    transformServerMessage:(message,{requestUpstream,connected})=>{
      const params=message.params||{},threadId=params.threadId?String(params.threadId):"";
      if(message.method==="thread/started"&&params.thread){const listed=codexListedThread(params.thread);return listed===params.thread?message:{...message,params:{...params,thread:listed}}}
      if(!threadId)return message;
      // A goal Trebell is writing reaches the windows as it ends up (setCodexGoal), not through the steps Codex says it took.
      if((message.method==="thread/goal/updated"||message.method==="thread/goal/cleared")&&codexGoalWrites.has(threadId))return false;
      if(message.method==="thread/goal/updated"&&params.goal)return {...message,params:{...params,goal:mirrorCodexGoal(threadId,params.goal)}};
      if(message.method==="thread/goal/cleared")mirrorCodexGoal(threadId,null);
      if(message.method==="turn/completed"){
        const turnId=params.turn?.id||params.turnId||null,goal=state.threadMeta(threadId)?.goal;
        void pauseCodexGoalOverBudget(threadId,turnId,requestUpstream);
        // A completed turn of an active goal: Codex is to start the goal's next turn (codex-goal-continuation.mjs).
        if((params.turn?.status||"completed")==="completed"&&goal?.native&&goal.status==="active")codexGoalContinuations.turnCompleted(threadId,{turnId,windows:[{requestUpstream,connected}]});
      }
      return message;
    },
    // A catalog not started yet starts with the transport's first request (codexRelayTarget).
    // A catalog app-server that has exited or could not start is started again by the connection's first request, which says why if it
    // cannot (catalogAppServer), instead of every handshake being refused while nothing starts it.
    enabled:()=>!closing,
      log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"relay",text:safeLogText(message)}),
    // The journal drops noisy methods (token deltas, listings, reads), so the trace looks up the thread's meta and the settings only
    // for a method it keeps. A reply streams one delta per token, and each lookup was a sqlite read of the whole meta.
    onClientMessage:message=>{
      const traceMethod=message?.method||"";
      if(traceMethod&&!NOISY_METHOD.test(traceMethod)){
        const traceParams=message?.params||{};const traceThreadId=traceParams.threadId||null;const traceMeta=traceThreadId?state.threadMeta(traceThreadId):null;
        eventJournal.recordProtocol({runtime:"codex",provider:codexRuntimeProvider(traceThreadId,traceMeta),environmentId:traceMeta?.environmentId??state.settings().activeEnvironmentId??null,direction:"client",method:traceMethod,params:traceParams});
      }
      if((message?.method==="thread/resume"||message?.method==="turn/start")&&message.params?.threadId&&message.params?.cwd){
        state.updateThreadMeta(message.params.threadId,{cwd:message.params.cwd,runtime:"codex",deletedAt:null});
      }
      if(message?.method==="turn/start"){
        const threadId=message.params?.threadId,model=message.params?.model;
        if(threadId){
          const permissionPatch=codexPermissionProfilePatch(message.params||{});
          if(Object.keys(permissionPatch).length){state.updateThreadMeta(threadId,permissionPatch);codexSessionApprovals.turnStarted(threadId,permissionPatch.permissionProfile)}
          if(model)codexThreadModels.set(threadId,model);
        }
      }
      // A thread the window lets go unloads (T3 unloadThread): what "Allow session" allowed in it goes.
      if(message?.method==="thread/unsubscribe"&&message.params?.threadId)codexSessionApprovals.end(message.params.threadId);
    },
    onServerMessage:(message,route)=>{
      const params=message?.params||{};
      recordCodexBudgetEvidence(state,message);
      recordCodexRecoveryItemEvidence(state,message);
      noteCodexFileChanges(message);
      if(params.threadId&&["thread/closed","thread/archived","thread/deleted"].includes(message?.method)){codexSessionApprovals.end(params.threadId);codexGoalContinuations.cancel(params.threadId)}
      // Codex goes on with the goal, or the goal stopped being active: no goal waits for its next turn (codex-goal-continuation.mjs).
      if(params.threadId&&(message?.method==="turn/started"||message?.method==="thread/goal/cleared"||message?.method==="thread/goal/updated"&&codexGoalStatus(params.goal?.status)!=="active"))codexGoalContinuations.cancel(params.threadId);
      const traceMethod=message?.method||route?.requestMethod||"";
      if(traceMethod&&!NOISY_METHOD.test(traceMethod)){
        const traceThreadId=params.threadId||params.thread?.id||null;const traceMeta=traceThreadId?state.threadMeta(traceThreadId):null;
        eventJournal.recordProtocol({runtime:"codex",provider:codexRuntimeProvider(traceThreadId,traceMeta),environmentId:traceMeta?.environmentId??state.settings().activeEnvironmentId??null,direction:"runtime",method:traceMethod,params});
      }
      const startedThread=message?.method==="thread/started"?params.thread:(route?.requestMethod==="thread/start"?message?.result?.thread:null);
      if(startedThread?.id){
        recordCodexChildAgentEvidence(state,startedThread);
        if(startedThread.model)codexThreadModels.set(startedThread.id,startedThread.model);
        const routedServer=route?.targetKey?codexAppServers.get(route.targetKey):null;
        if(routedServer)codexThreadServerKeys.set(startedThread.id,routedServer.poolKey);
        const ephemeral=Boolean(route?.requestParams?.ephemeral);
        state.updateThreadMeta(startedThread.id,{cwd:startedThread.cwd||null,runtime:"codex",runtimeInstanceId:routedServer?.runtimeInstanceId||agentRuntimes.activeInstance().id,environmentId:routedServer?.environmentId??state.settings().activeEnvironmentId??null,deletedAt:null,active:false,ephemeral,catalogHidden:ephemeral,...codexPermissionProfilePatch(route?.requestParams||{})});
      }
      if(message?.method==="thread/deleted"&&params.threadId){
        codexThreadModels.delete(params.threadId);noteCodexTurnEnded(params.threadId);codexAppServerExits.delete(String(params.threadId));const meta=state.threadMeta(params.threadId);state.removeThreadMeta(params.threadId);
        setTimeout(()=>releaseCodexThreadServer(params.threadId).catch(()=>{}),0);
        if(meta?.cwd)worktreeCleanup.sweep({reason:"thread-delete",path:meta.cwd}).catch(error=>cleanupLogs.push({at:Date.now(),stream:"cleanup",text:safeLogText(error.message+"\n")}));
      }
      if(message?.method==="thread/archived"&&params.threadId){codexAppServerExits.delete(String(params.threadId));setTimeout(()=>releaseCodexThreadServer(params.threadId).catch(()=>{}),0)}
      if(route?.requestMethod==="thread/unsubscribe"&&!message?.error&&route.requestParams?.threadId){
        const threadId=String(route.requestParams.threadId);const meta=state.threadMeta(threadId);
        if(!meta.active)setTimeout(()=>releaseCodexThreadServer(threadId).catch(()=>{}),0);
      }
      if(message?.method==="turn/started"){markCodexTurnActive(params.threadId,params.turn?.id||params.turnId);noteCodexTurnStarted(params.threadId,params.turn?.id||params.turnId)}
      if(message?.method==="turn/completed"){clearCodexRecovery(params.threadId,"completed");noteCodexTurnEnded(params.threadId,params.turn?.id||params.turnId||null)}
      // A turn-start's answer names a turn that runs; a read of the thread says whether one still does (one whose end the relay never
      // saw, its window having closed, no longer counts), and finds one whose start it never saw.
      const answeredThreadId=String(route?.requestParams?.threadId||"");
      if(answeredThreadId&&CODEX_TURN_START_METHODS.has(route?.requestMethod)&&!message?.error){const turn=message?.result?.turn;if(turn?.id&&(!turn.status||turn.status==="inProgress"))noteCodexTurnStarted(answeredThreadId,turn.id)}
      if(answeredThreadId&&(route?.requestMethod==="thread/read"||route?.requestMethod==="thread/resume")&&message?.result?.thread){
        if(message.result.thread.status?.type!=="active")noteCodexTurnEnded(answeredThreadId);else noteCodexTurnResumed(answeredThreadId,message.result.thread);
      }
      if(message?.method==="thread/status/changed"&&params.threadId&&params.status&&params.status.type!=="active")noteCodexTurnEnded(params.threadId);
      // A turn's record holds every model request it made so far. Codex's token usage carries no cost (total, last and the context
      // window only), so the record has none, and the Usage page prices the tokens of a model whose price is set.
      if(message?.method==="thread/tokenUsage/updated"&&params.threadId&&params.turnId){
        // The turn a read or resume found running without naming it is the one its thread's next update is for.
        if(codexUnnamedTurns.delete(String(params.threadId))&&!codexRunningTurns.get(String(params.threadId))?.has(String(params.turnId)))noteCodexTurnStarted(params.threadId,params.turnId);
        const usage=codexTurnUsage.update({threadId:params.threadId,turnId:params.turnId,tokenUsage:params.tokenUsage,running:Boolean(codexRunningTurns.get(String(params.threadId))?.has(String(params.turnId)))});
        const meta=usage?state.threadMeta(params.threadId):null;
        if(usage)state.recordUsage({runtime:"codex",provider:codexRuntimeProvider(params.threadId),model:codexThreadModels.get(params.threadId)||null,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId:params.threadId,turnId:params.turnId,usage,cost:null,at:Date.now()});
      }
    },
  });
  const agentRelay=mock?null:attachAgentRelay(server,{
    runtimeManager:agentRuntimes,
    threadStore:agentThreads,
    terminals,
    state,
    environments,
    contextEngine,
    repositoryKnowledge,
    nativeProviderTurn,
    nativeModelContextWindow:resolveNativeModelContextWindow,
    version:TREBELL_VERSION,
      log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"agent-relay",text:safeLogText(String(message)+"\n")}),
    onThreadDeleted:thread=>thread?.cwd?worktreeCleanup.sweep({reason:"thread-delete",path:thread.cwd}):null,
    journal:eventJournal,
    checkpoints,
    prepareDelegationWorkspace:({parentThreadId,parentThread,spec})=>prepareCodexDelegationWorkspace(parentThreadId,spec,parentThread),
    cleanupDelegationWorkspace:({workspace,parentThread})=>cleanupPreparedDelegationWorkspace(workspace,parentThread),
  });

  // The page, Playwright's request context and Node's keep-alive agent send their next request on a connection they keep open. Node
  // closes one that sat idle for 5 s, so a request sent just then met a closing socket (ECONNRESET): an idle connection is kept
  // longer than those clients keep it, and the header timeout stays above that.
  server.keepAliveTimeout=65_000;server.headersTimeout=66_000;
  // The close waits for every connection to end, and a tray Quit or an install waits on the close while the window is still open: what
  // is still open a second into it (a socket no socket server ended, such as the terminal drawer's opened again, a request still
  // running) is ended then, so the app quits instead of staying on, hidden, without its tray icon.
  const connections=new Set();
  server.on("connection",socket=>{connections.add(socket);socket.once("close",()=>connections.delete(socket))});
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,host,resolve);
  });
  let cleanupTimer=null;
  let pullRequestSyncTimer=null,pullRequestSyncRunning=false;
  let autoPullTimer=null,autoPullRunning=false;
  const sweepPullRequestLinks=async()=>{
    if(pullRequestSyncRunning)return;pullRequestSyncRunning=true;
    try{
      const now=Date.now();
    await syncBranchPullRequests().catch(error=>appServer?.logs?.push({at:Date.now(),stream:"branch-pr-sync",text:safeLogText(error.message+"\n")}));
      for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        const links=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
        if(!links.length)continue;
        const states=links.map(link=>String(link.snapshot?.state||link.state||"").toUpperCase());
        if(states.length&&states.every(value=>value==="MERGED"))continue;
        const openOrUnknown=states.some(value=>!value||value==="OPEN");
        const cadence=openOrUnknown?60_000:10*60_000;
        if(now-Number(meta.lastPullRequestSyncAt||0)<cadence)continue;
    await syncThreadPullRequestLinks(threadId).catch(error=>appServer?.logs?.push({at:Date.now(),stream:"pr-sync",text:safeLogText(error.message+"\n")}));
      }
    }finally{pullRequestSyncRunning=false}
  };
  const sweepAutoPull=async()=>{
    if(autoPullRunning)return;autoPullRunning=true;
    try{
      await sweepAutoPullProjects({
        state,
        pullProject:project=>inSourceControlEnvironment(project.environmentId||null,()=>sourceControlGitAction(project.path,{action:"auto-pull"})),
    log:message=>appServer?.logs?.push({at:Date.now(),stream:"auto-pull",text:safeLogText(String(message)+"\n")}),
      });
    }finally{autoPullRunning=false}
  };
  if(!mock){
  storageCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(error.message+"\n")}));
  cleanupTimer=setInterval(()=>storageCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(error.message+"\n")})),60*60_000);cleanupTimer.unref?.();
    setTimeout(()=>sweepPullRequestLinks().catch(()=>{}),5000).unref?.();
    pullRequestSyncTimer=setInterval(()=>sweepPullRequestLinks().catch(()=>{}),60_000);pullRequestSyncTimer.unref?.();
    setTimeout(()=>sweepAutoPull().catch(()=>{}),7000).unref?.();
    autoPullTimer=setInterval(()=>sweepAutoPull().catch(()=>{}),5*60_000);autoPullTimer.unref?.();
  }
  return {
    url:`http://${host==="0.0.0.0"?"127.0.0.1":host}:${port}`,
    server,
    close:async()=>{
      closing=true;
      if(cleanupTimer)clearInterval(cleanupTimer);
      if(pullRequestSyncTimer)clearInterval(pullRequestSyncTimer);
      if(autoPullTimer)clearInterval(autoPullTimer);
      codexGoalContinuations.clear();
      relay.close();
      await agentRelay?.close?.();
      terminalWs?.close();
      await Promise.allSettled([
        cloneJobs.shutdown(),
        terminals?.shutdown(),
        // A catalog still booting is stopped too, as restartAppServer does, so that no Codex app-server outlives the server.
        stopCodexAppServers().then(()=>appServerStart).then(()=>stopCodexAppServers()),
        eventJournal.close(),
      ]);
      state.close();agentThreads.close();
      await new Promise(resolve=>{const cut=setTimeout(()=>{for(const socket of connections)socket.destroy()},1000);server.close(()=>{clearTimeout(cut);resolve()})});
    },
  };
}

export async function mainGui(argv=process.argv.slice(2)){
  // A slow IPv4 connect where IPv6 does not route gets a second, not 250 ms (connect-attempt-timeout.mjs).
  extendConnectAttemptTimeout();
  const opts=parseArgs(argv);
  const gui=await createGuiServer(opts);
  console.log(`Trebell Code GUI running at ${gui.url}`);
  if(opts.open) openBrowser(gui.url);
  const shutdown=async()=>{await gui.close();process.exit(0);};
  process.once("SIGINT",shutdown);
  process.once("SIGTERM",shutdown);
  await new Promise(()=>{});
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  mainGui().catch(error=>{console.error(error);process.exitCode=1;});
}
