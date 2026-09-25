import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { spawn } from "node:child_process";
import { DEFAULT_PORT, PROVIDER_COMPAT_PORT } from "./config.mjs";
import { remoteToolPathPrelude } from "./environment-manager.mjs";
import { boundDiagnosticText } from "./diagnostic-bounds.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

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
  return {appPort:30000+seed,providerPort:48000+seed};
}

function providerPort(provider,override=null){
  return Number.isInteger(override)?override:(provider==="freebuff"?DEFAULT_PORT:PROVIDER_COMPAT_PORT);
}

export function remoteCodexArgs({provider,baseUrl,listen}){
  const id=String(provider||"freebuff");
  return [
    "--config",`model_provider=${JSON.stringify(id)}`,
    "--config",`model_providers.${id}.name=${JSON.stringify("Trebell "+id)}`,
    "--config",`model_providers.${id}.base_url=${JSON.stringify(baseUrl)}`,
    "--config",`model_providers.${id}.wire_api="responses"`,
    "--config",`model_providers.${id}.requires_openai_auth=false`,
    "--config",`model_providers.${id}.request_max_retries=2`,
    "--config",`model_providers.${id}.stream_max_retries=2`,
    "--config",`model_providers.${id}.stream_idle_timeout_ms=300000`,
    "app-server","--listen",listen,
  ];
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

async function createProviderProxy(host,localPort){
  const server=createTcpServer(client=>{
    const upstream=tcpConnect({host:"127.0.0.1",port:localPort});
    client.on("error",()=>{try{upstream.destroy()}catch{}});
    upstream.on("error",()=>{try{client.destroy()}catch{}});
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,host,resolve);
  });
  const address=server.address();
  return {
    port:typeof address==="object"&&address?address.port:0,
    close:()=>new Promise(resolve=>server.close(()=>resolve())),
  };
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
  provider,
  localProviderPort=null,
  runtimeInstance=null,
  debug=false,
}={}){
  const profile=environments?.get(environmentId);
  if(!profile||profile.type==="local")return null;
  const logs=[];
  const logEnvironment={...process.env,...(runtimeInstance?.environment||{})};
  const resolvedProviderPort=providerPort(provider,localProviderPort);
  const runtime=remoteCodexProfileSetup({profile,runtimeInstance});

  if(profile.type==="wsl"){
    const network=await wslNetwork(environments,environmentId);
    const proxy=await createProviderProxy(network.host,resolvedProviderPort);
    const baseUrl=`http://${network.host}:${proxy.port}/v1`;
    const listen=`ws://0.0.0.0:${appPort}`;
    const command=remoteToolPathPrelude()+"\n"+(runtime.prelude?runtime.prelude+"\n":"")+"exec "+shellJoin([runtime.command,...remoteCodexArgs({provider,baseUrl,listen})]);
    let child;
    try{
      child=environments.spawnSession(environmentId,{command,cwd:profile.cwd||null});
    }catch(error){
      await proxy.close().catch(()=>{});
      throw error;
    }
    attachLogs(child,logs,{debug,environment:logEnvironment});
    return {
      child,
      logs,
      environment:{id:profile.id,name:profile.name,type:profile.type,cwd:profile.cwd||""},
      targetUrl:`ws://${network.guest}:${appPort}`,
      readyUrl:`http://${network.guest}:${appPort}/readyz`,
      close:()=>proxy.close(),
    };
  }

  if(profile.type==="ssh"){
    const remotePorts=sshRemotePorts(appPort);
    const remoteProviderPort=remotePorts.providerPort;
    const remoteAppPort=remotePorts.appPort;
    const baseUrl=`http://127.0.0.1:${remoteProviderPort}/v1`;
    const listen=`ws://127.0.0.1:${remoteAppPort}`;
    const remoteCommand=remoteToolPathPrelude()+"\n"+(runtime.prelude?runtime.prelude+"\n":"")+(profile.cwd?"cd "+quotePosix(profile.cwd)+" && ":"")+"exec "+shellJoin([runtime.command,...remoteCodexArgs({provider,baseUrl,listen})]);
    const executable=process.platform==="win32"?"ssh.exe":"ssh";
    const args=[
      "-o","BatchMode=yes",
      "-o","ExitOnForwardFailure=yes",
      "-o","ConnectTimeout=8",
      "-o","ServerAliveInterval=15",
      "-o","ServerAliveCountMax=3",
      "-L",`127.0.0.1:${appPort}:127.0.0.1:${remoteAppPort}`,
      "-R",`127.0.0.1:${remoteProviderPort}:127.0.0.1:${resolvedProviderPort}`,
      "-p",String(profile.port||22),
    ];
    if(profile.identityFile)args.push("-i",profile.identityFile);
    args.push(profile.user?profile.user+"@"+profile.host:profile.host,remoteCommand);
    const child=spawn(executable,args,{env:process.env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
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
