import { realpath } from "node:fs/promises";
import spawn from "cross-spawn";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./acp-client.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

// Muse Code's host: Trebell starts the person's own `muse serve`, which speaks the Muse Session Protocol (MSP, NDJSON JSON-RPC over
// its stdio), and drives it through Meta's SDK (@muse-code/sdk) over a bare Connection on that stdio, as the SDK's docs advise for
// one's own transport. Trebell owns the process, so it has its pid and its exit: on Windows muse.cmd runs cmd.exe, which runs
// PowerShell with .muse-launcher.ps1, which runs the 400 MB muse-bin-<version>.exe, and the whole tree is stopped on close.

export const MUSE_STARTUP_TIMEOUT_MS=20_000;
export const MUSE_SHUTDOWN_TIMEOUT_MS=10_000;
// How long the frames Muse wrote last have to arrive once its process has exited, while a tool it started may hold its output.
export const MUSE_EXIT_DRAIN_MS=1_000;
const MUSE_SIGTERM_GRACE_MS=2_000;
const MUSE_GROUP_POLL_MS=50;
const MUSE_KILL_WAIT_MS=3_000;
const MUSE_SCHEMA_VERSION=1;

// The SDK loads with the first Muse host, never with the server (budget B25); a failed load is tried again by the next host.
let museSdk=null;
export function loadMuseSdk(){
  return museSdk??=import("@muse-code/sdk").catch(error=>{
    museSdk=null;
    throw Object.assign(new Error(`Trebell could not load Muse Code's SDK (@muse-code/sdk): ${error?.message||error}`),{cause:error});
  });
}

// The flags a host keeps for its lifetime: Read only runs without Muse's shell and file writes, and without
// trusting the workspace (its skills and rules); every other mode trusts the workspace, and Full access also runs Muse's shell
// without its sandbox. The read-only probe host (model/list) also leaves the session log off.
export function museServeArgs(mode="supervised",{sessionLog=true}={}){
  const value=normalizePermissionMode(mode);
  return ["serve",...(value==="read-only"?["--disable-shell","--disable-write"]:["--trust-workspace",...(value==="full"?["--disable-sandbox"]:[])]),...(sessionLog?[]:["--no-session-log"])];
}
// The permission profile and approval mode a session starts or resumes in, by Trebell's mode, asked for explicitly: without one
// Muse's own default may be Auto-review, where its AI reviewer decides. Full
// access lets everything run; Auto is Muse's Auto-review, whose reviewer clears what it can and asks the person the rest, as
// Cursor's --auto-review; Supervised, Auto-accept edits and Read only ask (Muse lets file reads and edits in the workspace through
// in every mode, and a Read only host has no shell or writes to ask about).
export function museSessionPolicy(mode="supervised"){
  const value=normalizePermissionMode(mode);
  if(value==="full")return {permissionProfile:":unrestricted",approvalMode:"allowAll"};
  return {permissionProfile:value==="auto"?":auto-review":":ask-me",approvalMode:"promptUnmatched"};
}
// Everything a mode fixes when the host launches: a mode with another plan needs a new host (needsRelaunch).
export function museLaunchPlan(mode="supervised"){return {args:museServeArgs(mode),...museSessionPolicy(mode)}}

// The keys and header strings Muse Code reads in place of the person's own `muse login` (its binary: "META_API_KEY always takes
// priority over the account login"), or to reach another provider: none reaches it, matched by name in any case and never read,
// except META_API_KEY for a profile set to an API key (authMethod "api-key", Settings' choice), whose launch carries the Meta key.
const MUSE_KEY_NAMES=new Set(["META_API_KEY","MODEL_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","OPENROUTER_API_KEY","MUSE_CUSTOM_HEADERS"]);
// The environment Muse Code runs with: MUSE_NO_AUTO_UPDATE=1, since Meta's launcher may otherwise
// update itself in the foreground, or start a hidden PowerShell updater, each time Trebell starts Muse Code; and none of the keys
// above on Sign in, so a key set for something else (Native on Meta's API) never bills the person per token in place of their
// subscription.
export function museEnvironment(env=process.env,{authMethod="sign-in"}={}){
  const out={},onKey=authMethod==="api-key";
  for(const name of Object.keys(env||{})){const upper=name.toUpperCase();if(!MUSE_KEY_NAMES.has(upper)||(onKey&&upper==="META_API_KEY"))out[name]=env[name]}
  out.MUSE_NO_AUTO_UPDATE="1";
  return out;
}
// What a host started without an environment runs with: what a Muse Code profile gets of Trebell's own (runtime-environment.mjs),
// so no other harness's key reaches Muse either.
function inheritedMuseEnvironment(){return buildRuntimeEnvironment("muse",{parent:process.env})}

export function museInitializeParams(version="0.0.0",requestedCapabilities=["sessionMcp"]){
  return {clientInfo:{name:"trebell_code",title:"Trebell Code",version:String(version||"0.0.0")},capabilities:{requestedCapabilities:[...requestedCapabilities]}};
}

// A Windows folder in the verbatim form turn/start's workspaceRoots takes: \\?\C:\repo, or \\?\UNC\server\share\repo for a share.
export function museVerbatimPath(path){
  const value=String(path||"");
  if(value.startsWith("\\\\?\\"))return value;
  return value.startsWith("\\\\")?"\\\\?\\UNC\\"+value.slice(2):"\\\\?\\"+value;
}

// The folder as Muse Code takes it: links resolved and spelled as the disk spells it (native realpath; Muse refuses a root whose
// case differs), and for turn/start on Windows in the verbatim form, the only one Muse 1.4.13 accepts there ("expected a canonical
// path"). The process itself starts in the plain folder: cmd.exe cannot start in a verbatim one.
export async function museWorkspaceRoot(path,{platform=process.platform,verbatim=true,resolveReal=realpath}={}){
  const canonical=await resolveReal(String(path)).catch(()=>platform==="win32"?String(path).replaceAll("/","\\"):String(path));
  return platform==="win32"&&verbatim?museVerbatimPath(canonical):canonical;
}

// How Muse Code's host ended, in Trebell's words, by the exit codes Meta's SDK names (classifyExit), with the last thing it wrote.
const EXIT_REASONS=Object.freeze({
  2:"Muse Code refused the way Trebell started it",
  3:"Muse Code could not load its settings; check ~/.config/muse/settings.json",
  4:"Another Muse Code process holds this session; close it and try again",
  5:"This Muse Code build cannot host sessions for Trebell; update Muse Code",
});
export function museExitMessage(exit={},stderrTail="",{command="muse",environment=process.env}={}){
  if(exit?.error)return `Could not start Muse Code '${command}': ${exit.error.message||exit.error}`;
  const line=sanitizeAcpStderrExcerpt(stderrTail,environment).split(/\r?\n/).map(text=>text.trim()).filter(Boolean).at(-1)||"";
  const code=exit?.code,reason=Number.isInteger(code)?EXIT_REASONS[code]:null;
  const base=reason?`${reason} (exit code ${code})`:`Muse Code exited unexpectedly (${Number.isInteger(code)?`code ${code}`:`signal ${exit?.signal||"unknown"}`})`;
  return line?`${base}: ${line}`:`${base}.`;
}

function wait(ms){
  let timer;const promise=new Promise(resolve=>{timer=setTimeout(resolve,ms);timer?.unref?.()});
  return {promise,cancel:()=>clearTimeout(timer)};
}
async function within(promise,ms){
  const timer=wait(ms);
  try{return await Promise.race([Promise.resolve(promise).then(()=>true,()=>true),timer.promise.then(()=>false)])}finally{timer.cancel()}
}

// Stops a host's whole process tree. On Windows: taskkill /T /F while the launcher still runs (cmd.exe waits for PowerShell, which
// waits for muse-bin, so the tree hangs off it), as AcpClient.stop does; a launcher that has exited is left alone, as AcpClient.stop
// leaves one: Windows may have given its pid to another process by then, whose tree taskkill would end. Elsewhere: SIGTERM to the
// process group the host leads, then SIGKILL once its grace has passed while any of it is left. No other process takes the group's
// id while one of its processes lives, so it still reaches a tool Muse started that holds its output once Muse has exited, as Meta's
// SDK reaches one.
export async function stopMuseProcessTree(child,{platform=process.platform,graceMs=MUSE_SIGTERM_GRACE_MS,spawnFn=spawn}={}){
  if(!child?.pid)return;
  if(platform==="win32"){
    if(child.exitCode!=null||child.signalCode!=null)return;
    await new Promise(resolve=>{
      let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};
      try{const killer=spawnFn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",done);killer.once("error",done);wait(MUSE_KILL_WAIT_MS).promise.then(done)}catch{done()}
    });
    return;
  }
  const signal=name=>{try{process.kill(-child.pid,name)}catch{try{child.kill(name)}catch{}}};
  // The host itself, or any process of its group (ESRCH: none is left).
  const left=()=>{if(child.exitCode==null&&child.signalCode==null)return true;try{process.kill(-child.pid,0);return true}catch(error){return error?.code!=="ESRCH"}};
  signal("SIGTERM");
  for(const deadline=Date.now()+graceMs;left();await wait(MUSE_GROUP_POLL_MS).promise)if(Date.now()>=deadline)return void signal("SIGKILL");
}

export class MuseHost{
  // env: the profile's (AgentRuntimeManager.childEnv), authMethod how the profile signs in (museEnvironment).
  constructor({command="muse",args=museServeArgs(),cwd=process.cwd(),env=null,authMethod="sign-in",spawnFn=spawn,platform=process.platform,startupTimeoutMs=MUSE_STARTUP_TIMEOUT_MS,shutdownTimeoutMs=MUSE_SHUTDOWN_TIMEOUT_MS,stopTree=stopMuseProcessTree,onWarning=null}={}){
    this.command=command;this.args=[...args];this.cwd=cwd;this.env=museEnvironment(env??inheritedMuseEnvironment(),{authMethod});this.spawnFn=spawnFn;this.platform=platform;
    this.startupTimeoutMs=startupTimeoutMs;this.shutdownTimeoutMs=shutdownTimeoutMs;this.stopTree=stopTree;this.onWarning=onWarning;
    this.sdk=null;this.child=null;this.connection=null;this.initializeResult=null;this.fingerprintWarning=null;
    this.stderrTail="";this.exit=null;this.closing=false;this.#closing=null;
    let settle;this.exited=new Promise(resolve=>{settle=resolve});this.#settleExit=settle;
  }
  #closing;#settleExit;#shutdownDeadline=null;#outputHeld=false;

  get pid(){return this.child?.pid??null}
  exitMessage(exit=this.exit){return museExitMessage(exit||{},this.stderrTail,{command:this.command,environment:this.env})}

  // Starts the host and opens the connection: initialize (Trebell Code, with session MCP servers), a schema envelope of version 1
  // or a refusal, a fingerprint other than the SDK's logged and let through (additive evolution), then initialized; all within
  // startupTimeoutMs. A start that fails stops what it started.
  async start({version="0.0.0",requestedCapabilities=["sessionMcp"],loadSdk=loadMuseSdk}={}){
    this.sdk=await loadSdk();
    if(this.closing)throw new Error("Muse Code was stopped while it started.");
    const startup=wait(this.startupTimeoutMs);
    try{
      this.#spawn();
      this.connection=new this.sdk.Connection(this.#transport());
      const answer=await Promise.race([
        this.connection.request("initialize",museInitializeParams(version,requestedCapabilities)).then(result=>({result}),error=>({error})),
        this.exited.then(exit=>({exit})),
        startup.promise.then(()=>({timeout:true})),
      ]);
      if(answer.timeout)throw new Error(`Muse Code did not start: it did not answer within ${Math.round(this.startupTimeoutMs/1000)} seconds.`);
      if(answer.exit)throw new Error(this.exitMessage(answer.exit));
      if(answer.error)throw answer.error;
      const result=answer.result;
      if(result?.schema?.version!==MUSE_SCHEMA_VERSION)throw new Error(`This Muse Code build speaks session protocol version ${result?.schema?.version??"(none)"}, and Trebell speaks version ${MUSE_SCHEMA_VERSION}. Use a Muse Code release that Trebell supports.`);
      this.fingerprintWarning=typeof result.schema.fingerprint==="string"?this.sdk.checkServedFingerprint(result.schema.fingerprint)||null:{message:"Muse Code sent no schema fingerprint."};
      if(this.fingerprintWarning)try{this.onWarning?.(this.fingerprintWarning.message)}catch{}
      this.initializeResult=result;
      this.connection.notify("initialized");
      return this;
    }catch(error){
      const failure=await this.#startFailure(error);
      await this.close();
      throw failure;
    }finally{startup.cancel()}
  }

  // A host that exited while it started says so by its exit; a stop (close) says the start was stopped.
  async #startFailure(error){
    if(this.closing)return new Error("Muse Code was stopped while it started.");
    if(!this.exit&&this.child&&!(await within(this.exited,500)))return error instanceof Error?error:new Error(String(error));
    return this.exit?Object.assign(new Error(this.exitMessage()),{code:this.exit.code,cause:error}):error;
  }

  #spawn(){
    const child=this.spawnFn(this.command,this.args,{cwd:this.cwd,env:this.env,windowsHide:true,stdio:["pipe","pipe","pipe"],detached:this.platform!=="win32"});
    this.child=child;
    // A failed spawn (ENOENT; on Windows cross-spawn reports a launcher that found no command the same way) and the end of the
    // process both settle exited, the first one winning. An error from a process still running (a signal it refused) does not.
    const settle=exit=>{if(this.exit)return;this.exit=exit;this.#settleExit(exit)};
    child.on("error",error=>{if(child.pid===undefined||child.exitCode!=null)settle({code:null,signal:null,error})});
    // The end of the process is its raw exit: 'close' waits for every holder of its stdout and stderr, and a tool
    // Muse started (agent-browser and its Chrome, a background terminal) inherits them and can hold them long after Muse has gone.
    // The frames Muse wrote last get MUSE_EXIT_DRAIN_MS to arrive; then its exit stands, and Trebell lets go of its ends of the
    // pipes, which ends the connection.
    let drain=null;
    child.once("exit",(code,signal)=>{drain=setTimeout(()=>{this.#outputHeld=true;settle({code,signal});this.#releasePipes(child)},MUSE_EXIT_DRAIN_MS);drain.unref?.()});
    child.once("close",(code,signal)=>{clearTimeout(drain);settle({code,signal})});
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stderr.on("data",chunk=>{this.stderrTail=appendAcpStderrTail(this.stderrTail,chunk)});
    child.stderr.on("error",()=>{});
    // A write to a host that has gone errors here as well as in its callback; the callback carries it.
    child.stdin.on("error",()=>{});
  }

  // The SDK's DuplexTransport over the host's stdio: UTF-8 stdout chunks in, frames to stdin, and close() ending stdin once the
  // frames the connection accepted have been handed over (bounded by the shutdown budget).
  #transport(){
    const child=this.child;
    return {
      incoming:(async function*(){for await(const chunk of child.stdout)yield String(chunk)})(),
      write:chunk=>new Promise((resolve,reject)=>{
        if(child.stdin.destroyed||child.stdin.writableEnded)return reject(new Error("Muse Code's input is closed."));
        child.stdin.write(chunk,"utf8",error=>error?reject(error):resolve());
      }),
      close:async flushed=>{
        if(flushed)await Promise.race([flushed.catch(()=>{}),this.#shutdownDeadline||wait(this.shutdownTimeoutMs).promise]);
        this.#endInput();
      },
    };
  }
  #endInput(){const stdin=this.child?.stdin;if(stdin&&!stdin.destroyed&&!stdin.writableEnded)try{stdin.end()}catch{}}
  #releasePipes(child){for(const stream of [child.stdin,child.stdout,child.stderr])try{stream?.destroy()}catch{}}

  // Closes the connection, which ends Muse's input: Muse winds down and frees the session's writer lease. A host still running
  // shutdownTimeoutMs later has its whole process tree stopped. So, on Linux and macOS, has one that exited while a process it
  // started still held its output: that process is still in the host's process group.
  close(){return this.#closing??=this.#shutdown()}
  async #shutdown(){
    this.closing=true;
    const child=this.child;if(!child)return;
    const deadline=wait(this.shutdownTimeoutMs);this.#shutdownDeadline=deadline.promise;
    try{
      if(this.connection)void this.connection.close().catch(()=>{});else this.#endInput();
      const exited=await Promise.race([this.exited.then(()=>true),deadline.promise.then(()=>false)]);
      if(!exited||(this.#outputHeld&&this.platform!=="win32")){
        await this.stopTree(child,{platform:this.platform});
        if(!exited)await within(this.exited,MUSE_KILL_WAIT_MS);
      }
    }finally{
      deadline.cancel();
      // A process that holds the pipes after the tree was stopped no longer holds Trebell's ends of them.
      if(!this.exit)this.#releasePipes(child);
    }
  }
}
