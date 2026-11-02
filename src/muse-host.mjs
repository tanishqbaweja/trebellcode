import { realpath } from "node:fs/promises";
import spawn from "cross-spawn";
import { agentLogExcerpt, extendAgentLog } from "./agent-log.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

// Muse Code's host: Trebell starts the person's own `muse serve`, which speaks the Muse Session Protocol (MSP, NDJSON JSON-RPC over
// its stdio), and drives it through Meta's SDK (@muse-code/sdk) over a bare Connection on that stdio, as the SDK's docs advise for
// one's own transport. Trebell owns the process, so it has its pid and its exit: on Windows muse.cmd runs cmd.exe, which runs
// PowerShell with .muse-launcher.ps1, which runs the 400 MB muse-bin-<version>.exe, and the whole tree is stopped on close.

// The two waits of a host, each the default of one of its options: answerMs is how long a host Trebell has spawned may take to
// answer initialize before the start gives up (startupTimeoutMs), and exitMs how long a host whose input has ended may take to
// exit before its process tree is stopped (shutdownTimeoutMs, the name Meta's SDK gives the same wait).
export const MUSE_HOST_BOUNDS=Object.freeze({answerMs:20_000,exitMs:10_000});
// How long the frames Muse wrote last have to arrive once its process has exited, while a tool it started may hold its output.
export const MUSE_EXIT_DRAIN_MS=1_000;
const MUSE_SIGTERM_GRACE_MS=2_000;
const MUSE_GROUP_POLL_MS=50;
const MUSE_KILL_WAIT_MS=3_000;

// The SDK loads with the first Muse host, never with the server (budget B25); a failed load is tried again by the next host.
let museSdk=null;
export function loadMuseSdk(){
  return museSdk??=import("@muse-code/sdk").catch(error=>{
    museSdk=null;
    throw Object.assign(new Error(`Trebell could not load Muse Code's SDK (@muse-code/sdk): ${error?.message||error}`),{cause:error});
  });
}

// What `muse serve` is allowed at each of Trebell's access levels, for the whole life of a host. Read only keeps Muse to
// reading: no shell, no file writes and no trust in the workspace (its own skills and rules). Every other level trusts the
// workspace, and Full access also lets Muse's shell run outside its sandbox.
function museServeAllowance(mode){
  const access=normalizePermissionMode(mode),readOnly=access==="read-only";
  return {shell:!readOnly,write:!readOnly,trustWorkspace:!readOnly,sandbox:access!=="full"};
}
// Each flag of `muse serve` beside the allowance that calls for it, in the order a host is given them: launch plans are
// compared as JSON (needsRelaunch), so the order never varies.
const SERVE_FLAGS=Object.freeze([
  ["--disable-shell",allowed=>!allowed.shell],
  ["--disable-write",allowed=>!allowed.write],
  ["--trust-workspace",allowed=>allowed.trustWorkspace],
  ["--disable-sandbox",allowed=>!allowed.sandbox],
  ["--no-session-log",allowed=>!allowed.sessionLog],
]);
// The arguments a host starts with, a new array each time. The session log stays on unless options.sessionLog is given and
// false (the read-only host that lists the models turns it off).
export function museServeArgs(mode,options={}){
  const sessionLog=options?.sessionLog===undefined||Boolean(options.sessionLog);
  const allowed={...museServeAllowance(mode),sessionLog};
  return ["serve",...SERVE_FLAGS.filter(([,wanted])=>wanted(allowed)).map(([flag])=>flag)];
}
// A session's permission profile and approval mode at each of Trebell's access levels, as [profile, mode]. Muse's protocol lets
// a client pick among the profiles and modes its host already defines, never make one, and a session/start or session/resume that
// names neither runs under the host's own default, which can hand approvals to Muse's reviewer; so Trebell always names both.
// Full access runs every tool call; Auto takes Muse's auto-review profile, whose reviewer clears what it can and leaves the rest to
// the person, like Cursor's --auto-review. A level missing here (Supervised, Auto-accept edits, Read only, or one Trebell does not
// know) has Muse ask the person about anything no rule of its own allows. Muse lets reads and edits inside the workspace through
// at every level, and a Read only host has no shell or writes to ask about.
const SETTINGS_BY_ACCESS=new Map([
  ["full",[":unrestricted","allowAll"]],
  ["auto",[":auto-review","promptUnmatched"]],
]);
const ASK_THE_PERSON=[":ask-me","promptUnmatched"];
// The settings for a level by any name Trebell's permission policy knows it by (no level at all is Supervised), as a new object.
export function museSessionSettings(mode="supervised"){
  const [permissionProfile,approvalMode]=SETTINGS_BY_ACCESS.get(normalizePermissionMode(mode))??ASK_THE_PERSON;
  return {permissionProfile,approvalMode};
}
// Everything a mode fixes when the host launches: a mode with another plan needs a new host (needsRelaunch).
export function museLaunchPlan(mode="supervised"){return {args:museServeArgs(mode),...museSessionSettings(mode)}}
// Whether a host cannot run the commands it was started to run: it launched with its shell and its sandbox (args), and its answer
// to initialize says it cannot use that sandbox (sandboxAvailability "unavailable"), so each command fails before it starts, one the
// person allowed too. Muse Code 1.4.13's host answers so on Windows even where `muse sandbox windows check` reports the sandbox
// ready. A host that names no availability, one older than the field, is taken as able to.
export function museHostCannotSandbox(initializeResult,args=[]){
  const flags=new Set(Array.isArray(args)?args:[]);
  return initializeResult?.sandboxAvailability==="unavailable"&&!flags.has("--disable-sandbox")&&!flags.has("--disable-shell");
}

// Variables that would give Muse Code a key or extra request headers in place of the person's own `muse login` (its binary:
// "META_API_KEY always takes priority over the account login"), or send it to another provider. Held back from every host, by
// their upper-case names, as Windows compares names.
const MUSE_KEY_VARIABLES=new Set(["META_API_KEY","MODEL_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","OPENROUTER_API_KEY","MUSE_CUSTOM_HEADERS"]);
// The one of them a profile set to its API key (authMethod "api-key", Settings' choice) passes on: the Meta key it signs in with.
const PROFILE_KEY_VARIABLE="META_API_KEY";
// Turns off the self-update of Meta's launcher, which may otherwise update itself in the foreground, or start a hidden PowerShell
// updater, each time Trebell starts Muse Code (Settings' Update runs Muse with its own environment, muse-maintenance.mjs).
const NO_SELF_UPDATE=Object.freeze({MUSE_NO_AUTO_UPDATE:"1"});

// Whether a variable is kept from the host: one of the key variables, unless it is the profile key and the profile passes it on.
function heldBack(name,passesProfileKey){
  const upper=name.toUpperCase();
  return MUSE_KEY_VARIABLES.has(upper)&&!(passesProfileKey&&upper===PROFILE_KEY_VARIABLE);
}
// The environment a Muse Code host runs with: the given one (the process's own when none is given), less the variables held
// back, whose values are never read, and with the self-update off whatever it said. So a key set for something else (Native on
// Meta's API) never bills the person per token in place of their subscription. The given object stays as it was.
export function museHostEnvironment(source=process.env,{authMethod="sign-in"}={}){
  const passesProfileKey=authMethod==="api-key";
  const passed=Object.keys(source??{}).filter(name=>!heldBack(name,passesProfileKey));
  return {...Object.fromEntries(passed.map(name=>[name,source[name]])),...NO_SELF_UPDATE};
}
// What a host started without an environment runs with: what a Muse Code profile gets of Trebell's own (runtime-environment.mjs),
// so no other harness's key reaches Muse either.
function inheritedMuseEnvironment(){return buildRuntimeEnvironment("muse",{parent:process.env})}

// Who Trebell is to a host (msp.d.ts ClientInfo: a machine name of [a-z0-9_], a display name, then the version).
const TREBELL_CLIENT=Object.freeze({name:"trebell_code",title:"Trebell Code"});
// The initialize request: Trebell Code at the app's version (0.0.0 when it has none), asking for a copy of the capabilities named.
function initializeRequest(appVersion,capabilities){
  return {clientInfo:{...TREBELL_CLIENT,version:String(appVersion||"0.0.0")},capabilities:{requestedCapabilities:Array.from(capabilities)}};
}

// The wire envelope version Trebell's frames are written for (msp.d.ts SchemaInfo.version: 1 in v1, and meant to stay 1).
const MSP_ENVELOPE_VERSION=1;
// What Trebell makes of the schema pair in a host's initialize answer. Another envelope version, or none, is a refusal: Trebell
// cannot read that host's frames. Otherwise the answer stands, with a warning or null. The fingerprint names the stable surface
// the host serves, and one other than the SDK's pin only warns, since that surface grows by additions (Meta's SDK: advisory,
// never a connection failure); compare is the SDK's checkServedFingerprint. A host that names no fingerprint gets Trebell's own
// warning.
export function museSchemaVerdict(answer,compare){
  const schema=answer?.schema,version=schema?.version;
  if(version!==MSP_ENVELOPE_VERSION){
    const given=version==null?"named no session protocol version":`answered with session protocol version ${JSON.stringify(version)}`;
    return {refusal:`Muse Code ${given}, but Trebell Code reads only version ${MSP_ENVELOPE_VERSION}. Install a Muse Code release that serves version ${MSP_ENVELOPE_VERSION}.`};
  }
  if(typeof schema.fingerprint!=="string")return {warning:"Muse Code did not name its protocol schema fingerprint, so Trebell could not check it against Meta's SDK; the session goes on."};
  return {warning:compare(schema.fingerprint)?.message??null};
}

// How a Windows path starts in the verbatim form (\\?\), in that form for a share (\\?\UNC\), and as a share is usually
// written (\\server\share).
const VERBATIM_PREFIX="\\\\?\\",VERBATIM_SHARE_PREFIX="\\\\?\\UNC\\",SHARE_PREFIX="\\\\";

// A Windows path in the verbatim form, the only one Muse 1.4.13 takes in turn/start's workspaceRoots ("expected a canonical
// path"): D:\code\app is \\?\D:\code\app, the share \\fileserver\team\app is \\?\UNC\fileserver\team\app, and a path that
// is verbatim already stays as it is. Nothing else in the path changes.
export function verbatimWindowsPath(path){
  const text=path?String(path):"";
  if(text.startsWith(VERBATIM_PREFIX))return text;
  if(text.startsWith(SHARE_PREFIX))return VERBATIM_SHARE_PREFIX+text.slice(SHARE_PREFIX.length);
  return VERBATIM_PREFIX+text;
}

// A folder with its links followed and, on Windows, each part spelled as the disk spells it (the native realpath: Muse
// refuses a root whose letter case differs). A folder that cannot be resolved, whether its resolver rejects or throws, is
// taken as given, with Windows separators on Windows.
async function resolvedFolder(folder,{windows,resolveReal}){
  try{return await resolveReal(folder)}
  catch{return windows?folder.replaceAll("/","\\"):folder}
}

// The folder Muse Code is given. On Windows, turn/start's roots take the verbatim form (verbatim, the default) and
// session/start's root the plain one; elsewhere the folder is the resolved one either way. The host's process itself
// starts in the plain folder: cmd.exe cannot start in a verbatim one.
export async function museWorkspaceRoot(path,{platform=process.platform,verbatim=true,resolveReal=realpath}={}){
  const windows=platform==="win32";
  const folder=await resolvedFolder(String(path),{windows,resolveReal});
  if(windows&&verbatim)return verbatimWindowsPath(folder);
  return folder;
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
  const line=agentLogExcerpt(stderrTail,environment).split(/\r?\n/).map(text=>text.trim()).filter(Boolean).at(-1)||"";
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
  // env: the profile's (AgentRuntimeManager.childEnv), authMethod how the profile signs in (museHostEnvironment).
  constructor({command="muse",args=museServeArgs(),cwd=process.cwd(),env=null,authMethod="sign-in",spawnFn=spawn,platform=process.platform,startupTimeoutMs=MUSE_HOST_BOUNDS.answerMs,shutdownTimeoutMs=MUSE_HOST_BOUNDS.exitMs,stopTree=stopMuseProcessTree,onWarning=null}={}){
    this.command=command;this.args=[...args];this.cwd=cwd;this.env=museHostEnvironment(env??inheritedMuseEnvironment(),{authMethod});this.spawnFn=spawnFn;this.platform=platform;
    this.startupTimeoutMs=startupTimeoutMs;this.shutdownTimeoutMs=shutdownTimeoutMs;this.stopTree=stopTree;this.onWarning=onWarning;
    this.sdk=null;this.child=null;this.connection=null;this.initializeResult=null;this.schemaWarning=null;
    this.stderrTail="";this.exit=null;this.closing=false;this.#closing=null;
    let settle;this.exited=new Promise(resolve=>{settle=resolve});this.#settleExit=settle;
  }
  #closing;#settleExit;#shutdownDeadline=null;#outputHeld=false;

  get pid(){return this.child?.pid??null}
  exitMessage(exit=this.exit){return museExitMessage(exit||{},this.stderrTail,{command:this.command,environment:this.env})}

  // Starts the host and opens its connection. Within startupTimeoutMs of the spawn the host must answer initialize, which names
  // Trebell Code and the capabilities asked for (a session asks for sessionMcp); museSchemaVerdict then refuses the answer, which
  // fails the start, or accepts it, handing any warning to onWarning, and the initialized notification follows. A start that fails
  // closes what it started. Resolves to the host.
  async start({version="0.0.0",requestedCapabilities=["sessionMcp"],loadSdk=loadMuseSdk}={}){
    this.sdk=await loadSdk();
    if(this.closing)throw new Error("Muse Code was stopped while it started.");
    const startup=wait(this.startupTimeoutMs);
    try{
      this.#spawn();
      this.connection=new this.sdk.Connection(this.#transport());
      const answer=await this.#initializeAnswer(initializeRequest(version,requestedCapabilities),startup.promise);
      const {refusal,warning=null}=museSchemaVerdict(answer,served=>this.sdk.checkServedFingerprint(served));
      if(refusal)throw new Error(refusal);
      this.schemaWarning=warning;
      if(warning)try{this.onWarning?.(warning)}catch{}
      this.initializeResult=answer;
      this.connection.notify("initialized");
      return this;
    }catch(error){
      const failure=await this.#startFailure(error);
      await this.close();
      throw failure;
    }finally{startup.cancel()}
  }

  // Settles with the host's answer to initialize, or fails with why there is none: the request's own error, the host's exit in
  // Trebell's words when it exits first, or the start's deadline passing with no answer. The first of the three decides.
  #initializeAnswer(params,deadline){
    return new Promise((resolve,reject)=>{
      let decided=false;
      const decide=(settle,value)=>{if(!decided){decided=true;settle(value)}};
      const seconds=Math.round(this.startupTimeoutMs/1000);
      this.connection.request("initialize",params).then(answer=>decide(resolve,answer),error=>decide(reject,error));
      this.exited.then(exit=>{if(!decided)decide(reject,new Error(this.exitMessage(exit)))});
      deadline.then(()=>{if(!decided)decide(reject,new Error(`Muse Code did not start: it did not answer within ${seconds} seconds.`))});
    });
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
    child.stderr.on("data",chunk=>{this.stderrTail=extendAgentLog(this.stderrTail,chunk)});
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
