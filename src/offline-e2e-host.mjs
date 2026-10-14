// What programs installed on this machine answer in offline browser E2E.
//
// The Playwright web server runs the GUI server mocked and offline (TREBELL_GUI_MOCK=1 with TREBELL_E2E_OFFLINE=1), and
// offlineE2eFetch (gui-server.mjs) refuses every request that leaves the machine. Three kinds of reads still started programs
// installed here, which reach the network or answer from the person's own installs and sign-ins, and on a loaded host took longer
// than a test waits:
// - the code-host CLIs. The diagnostics ask gh, glab, tea, fj and az for their version and sign-in (gh auth status and az account
//   show ask GitHub and Azure with the person's accounts; 9.1 s on a busy host), and the pull-request list runs gh pr list
//   against GitHub.
// - host discovery for Environments: ssh -V and wsl --list (5.3 s on a busy host).
// - the harness checks, which start the Codex, Claude Code, Cursor, Grok and OpenCode installed here with their sign-ins (Codex's
//   app-server, `claude auth status`, `grok models`, `opencode serve`, and Claude Code's capability probe for the Usage page):
//   Settings' harness list still said "Checking…" after 15 s.
// In that mode they answer at once. The CLIs answer as on a machine that has none of them, and discovery answers as the fixed host
// below. Git itself still runs: the tests make real repositories and remotes. A test that needs a code host, a signed-in harness
// or another host answers the page's request for it itself (page.route), as the code-host and harness tests already do. (The server
// makes no harness but Codex the active one when it finds no CLI for it.)

export const OFFLINE_E2E_CODE_HOST_CLIS=Object.freeze(["gh","glab","tea","fj","az"]);

// The name a command runs as: gh for gh, gh.exe or C:\tools\gh.cmd.
function commandName(command){
  return (String(command||"").trim().replace(/\\/g,"/").split("/").at(-1)||"").toLowerCase().replace(/\.(?:exe|cmd|bat)$/,"");
}
// How a missing command fails, as Node words it (spawn gh ENOENT), with the reason it is missing here.
function notInstalled(command){
  return `spawn ${command} ENOENT (offline browser E2E answers ${commandName(command)} as not installed)`;
}

// The source-control executor (source-control-service withSourceControlExecutor) for offline E2E: a code-host CLI answers as one
// that is not installed, as execFile's ENOENT reaches the service through the native executor, and fj finds no saved login.
// Everything else, git included, runs through the executor it wraps.
export function offlineE2eSourceControlExecutor(executor){
  const codeHost=command=>OFFLINE_E2E_CODE_HOST_CLIS.includes(commandName(command));
  const missing=command=>({ok:false,code:1,stdout:"",stderr:notInstalled(command)});
  return {
    ...executor,
    run:async(command,args,options)=>codeHost(command)?missing(command):executor.run(command,args,options),
    runStdin:async(command,args,input,options)=>codeHost(command)?missing(command):executor.runStdin(command,args,input,options),
    readFjKeys:async()=>({hosts:{},aliases:{}}),
  };
}

// Host discovery's answers in offline E2E (EnvironmentManager discoveryRun): a host with an OpenSSH client and, on Windows, one WSL
// distro beside Docker Desktop's own, which discovery drops as it does on a real host. Nothing else is asked of the host there.
export const OFFLINE_E2E_HOST={
  ssh:"OpenSSH_9.5p1 (offline browser E2E host)",
  wslDistros:["Ubuntu-24.04","docker-desktop"],
};
export async function offlineE2eDiscoveryRun(command){
  const name=commandName(command);
  if(name==="ssh")return {exitCode:0,signal:null,timedOut:false,stdout:"",stderr:OFFLINE_E2E_HOST.ssh};
  if(name==="wsl")return {exitCode:0,signal:null,timedOut:false,stdout:OFFLINE_E2E_HOST.wslDistros.join("\n")+"\n",stderr:""};
  return {exitCode:1,signal:null,timedOut:false,stdout:"",stderr:notInstalled(command)};
}

// The harness checks' process runner in offline E2E (AgentRuntimeManager runFn): every harness CLI answers as one that is not
// installed, as the default runner reports a spawn that fails, so each check says its harness was not found.
export async function offlineE2eHarnessRun(command){
  return {ok:false,code:null,error:notInstalled(command),stdout:"",stderr:""};
}
// Claude Code's capability probe in offline E2E (AgentRuntimeManager claudeCapabilitiesCache), which the Usage page reads plan
// usage from while Claude Code is the active harness: it fails at once, as it does where Claude Code is not installed.
export const offlineE2eClaudeCapabilities=Object.freeze({
  load:async()=>{throw new Error(notInstalled("claude"))},
  clear(){},
});
