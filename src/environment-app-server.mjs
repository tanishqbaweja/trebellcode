import { spawn } from "node:child_process";
import { remoteEnvironmentCommand, remoteToolPathPrelude, remoteTransportEnvironment } from "./environment-manager.mjs";
import { boundDiagnosticText } from "./diagnostic-bounds.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { runtimeEnvironmentKeys } from "./runtime-environment.mjs";

function quotePosix(value){
  return "'" + String(value).replace(/'/g,"'\\''") + "'";
}

function shellJoin(parts){
  return parts.map(quotePosix).join(" ");
}

const REMOTE_CODEX_SHARED_DIRECTORIES=["sessions","archived_sessions","sqlite","shell_snapshots","worktrees","skills","plugins","cache","logs","mcp-oauth-locks"];

function remotePathExpression(value){
  const raw=String(value||"").trim();
  if(raw==="~")return '"$HOME"';
  if(raw.startsWith("~/"))return '"$HOME"/'+quotePosix(raw.slice(2));
  return quotePosix(raw);
}

export function remoteCodexProfileSetup({profile={},runtimeInstance=null}={}){
  const instance=runtimeInstance||{};
  const command=String(instance.binaryPath||profile.codexPath||"codex").trim()||"codex";
  const lines=[];
  for(const [name,value] of Object.entries(instance.environment||{})){
    if(!/^[A-Z_][A-Z0-9_]*$/i.test(name)||value==null)continue;
    lines.push("export "+name+"="+quotePosix(String(value)));
  }
  const shared=String(instance.homePath||"").trim();
  const shadow=String(instance.shadowHomePath||"").trim();
  if(shadow){
    lines.push("trebell_codex_shared="+remotePathExpression(shared||"~/.codex"));
    lines.push("trebell_codex_effective="+remotePathExpression(shadow));
    lines.push('mkdir -p "$trebell_codex_shared" "$trebell_codex_effective"');
    lines.push("for trebell_codex_entry in "+REMOTE_CODEX_SHARED_DIRECTORIES.map(quotePosix).join(" ")+"; do");
    lines.push('  mkdir -p "$trebell_codex_shared/$trebell_codex_entry"');
    lines.push('  if [ -L "$trebell_codex_effective/$trebell_codex_entry" ]; then rm -f "$trebell_codex_effective/$trebell_codex_entry";');
    lines.push('  elif [ -e "$trebell_codex_effective/$trebell_codex_entry" ]; then echo "Trebell cannot prepare remote Codex shadow entry $trebell_codex_entry because a non-link entry already exists." >&2; exit 74; fi');
    lines.push('  ln -s "$trebell_codex_shared/$trebell_codex_entry" "$trebell_codex_effective/$trebell_codex_entry"');
    lines.push("done");
    lines.push('export CODEX_HOME="$trebell_codex_effective"');
  }else if(shared){
    lines.push("trebell_codex_effective="+remotePathExpression(shared));
    lines.push('mkdir -p "$trebell_codex_effective"');
    lines.push('export CODEX_HOME="$trebell_codex_effective"');
  }
  return {command,prelude:lines.join("\n"),sharedHomePath:shared||null,effectiveHomePath:shadow||shared||null};
}

export function sshRemotePorts(localAppPort){
  const seed=Math.abs(Math.trunc(Number(localAppPort)||0))%16000;
  return {appPort:30000+seed};
}

export function remoteCodexArgs({listen}){
  return ["app-server","--listen",listen];
}

function attachLogs(child,logs,{debug=false,environment=process.env}={}){
  const push=(chunk,stream)=>{
    const text=boundDiagnosticText(redactSecretText(chunk,{environment}));
    logs.push({at:Date.now(),stream,text});
    if(logs.length>250)logs.splice(0,logs.length-250);
    if(debug)(stream==="stderr"?process.stderr:process.stdout).write(text);
  };
  child.stdout?.on("data",chunk=>push(chunk,"stdout"));
  child.stderr?.on("data",chunk=>push(chunk,"stderr"));
  child.on("error",error=>push(error.stack||error.message,"stderr"));
  child.on("exit",(code,signal)=>push(`remote app-server exited code=${code} signal=${signal}\n`,"stderr"));
}

async function wslNetwork(environments,id){
  const result=await environments.execute(id,{
    cwd:"",
    timeoutMs:10000,
    command:"printf 'HOST='; ip route show default | awk '{print $3; exit}'; printf '\\nGUEST='; hostname -I 2>/dev/null || true",
  });
  if(result.exitCode!==0)throw new Error(result.stderr||"Could not inspect WSL networking");
  const host=result.stdout.match(/(?:^|\n)HOST=([^\n]+)/)?.[1]?.trim()||"";
  const guest=(result.stdout.match(/(?:^|\n)GUEST=([^\n]+)/)?.[1]||"").trim().split(/\s+/).find(Boolean)||"";
  if(!host||!guest)throw new Error("Could not determine WSL host/guest addresses");
  return {host,guest};
}

export async function startRemoteAppServer({
  environments,
  environmentId,
  appPort,
  runtimeInstance=null,
  runtimeEnvironmentNames=null,
  hostEnvironment=process.env,
  spawnProcess=spawn,
  debug=false,
}={}){
  const profile=environments?.get(environmentId);
  if(!profile||profile.type==="local")return null;
  const logs=[];
  const logEnvironment={...hostEnvironment,...(runtimeInstance?.environment||{})};
  const runtime=remoteCodexProfileSetup({profile,runtimeInstance});
  const inheritedNames=Array.isArray(runtimeEnvironmentNames)&&runtimeEnvironmentNames.length
    ?runtimeEnvironmentNames
    :runtimeEnvironmentKeys("codex",{approved:runtimeInstance?.approvedEnvironmentKeys});
  const commandEnvironmentNames=[...new Set([...inheritedNames,...(runtime.effectiveHomePath?["CODEX_HOME"]:[])])];
  const isolatedRuntimeCommand=listen=>"exec "+remoteEnvironmentCommand(
    shellJoin([runtime.command,...remoteCodexArgs({listen})]),
    commandEnvironmentNames,
    runtimeInstance?.environment||{},
  );

  if(profile.type==="wsl"){
    const network=await wslNetwork(environments,environmentId);
    const listen=`ws://0.0.0.0:${appPort}`;
    const command=remoteToolPathPrelude()+"\n"+(runtime.prelude?runtime.prelude+"\n":"")+isolatedRuntimeCommand(listen);
    const child=environments.spawnSession(environmentId,{command,cwd:profile.cwd||null});
    attachLogs(child,logs,{debug,environment:logEnvironment});
    return {
      child,
      logs,
      environment:{id:profile.id,name:profile.name,type:profile.type,cwd:profile.cwd||""},
      targetUrl:`ws://${network.guest}:${appPort}`,
      readyUrl:`http://${network.guest}:${appPort}/readyz`,
      close:async()=>{},
    };
  }

  if(profile.type==="ssh"){
    const remotePorts=sshRemotePorts(appPort);
    const remoteAppPort=remotePorts.appPort;
    const listen=`ws://127.0.0.1:${remoteAppPort}`;
    const remoteCommand=remoteToolPathPrelude()+"\n"+(runtime.prelude?runtime.prelude+"\n":"")+(profile.cwd?"cd "+quotePosix(profile.cwd)+" && ":"")+isolatedRuntimeCommand(listen);
    const executable=process.platform==="win32"?"ssh.exe":"ssh";
    const args=[
      "-o","BatchMode=yes",
      "-o","ExitOnForwardFailure=yes",
      "-o","ConnectTimeout=8",
      "-o","ServerAliveInterval=15",
      "-o","ServerAliveCountMax=3",
      "-L",`127.0.0.1:${appPort}:127.0.0.1:${remoteAppPort}`,
      "-p",String(profile.port||22),
    ];
    if(profile.identityFile)args.push("-i",profile.identityFile);
    args.push(profile.user?profile.user+"@"+profile.host:profile.host,remoteCommand);
    const child=spawnProcess(executable,args,{env:remoteTransportEnvironment(hostEnvironment),windowsHide:true,stdio:["ignore","pipe","pipe"]});
    attachLogs(child,logs,{debug,environment:logEnvironment});
    return {
      child,
      logs,
      environment:{id:profile.id,name:profile.name,type:profile.type,cwd:profile.cwd||""},
      targetUrl:`ws://127.0.0.1:${appPort}`,
      readyUrl:`http://127.0.0.1:${appPort}/readyz`,
      close:async()=>{},
    };
  }

  throw new Error("Unsupported remote environment type: "+profile.type);
}
