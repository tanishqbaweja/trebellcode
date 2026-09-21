import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { spawn } from "node:child_process";
import { DEFAULT_PORT, PROVIDER_COMPAT_PORT } from "./config.mjs";

function quotePosix(value){
  return "'" + String(value).replace(/'/g,"'\\''") + "'";
}

function shellJoin(parts){
  return parts.map(quotePosix).join(" ");
}

function providerPort(provider){
  return provider==="freebuff"?DEFAULT_PORT:PROVIDER_COMPAT_PORT;
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

function attachLogs(child,logs,{debug=false}={}){
  const push=(chunk,stream)=>{
    const text=String(chunk);
    logs.push({at:Date.now(),stream,text});
    if(logs.length>250)logs.splice(0,logs.length-250);
    if(debug)(stream==="stderr"?process.stderr:process.stdout).write(chunk);
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
  debug=false,
}={}){
  const profile=environments?.get(environmentId);
  if(!profile||profile.type==="local")return null;
  const logs=[];
  const localProviderPort=providerPort(provider);

  if(profile.type==="wsl"){
    const network=await wslNetwork(environments,environmentId);
    const proxy=await createProviderProxy(network.host,localProviderPort);
    const baseUrl=`http://${network.host}:${proxy.port}/v1`;
    const listen=`ws://0.0.0.0:${appPort}`;
    const command="exec "+shellJoin([profile.codexPath||"codex",...remoteCodexArgs({provider,baseUrl,listen})]);
    let child;
    try{
      child=environments.spawnSession(environmentId,{command,cwd:profile.cwd||null});
    }catch(error){
      await proxy.close().catch(()=>{});
      throw error;
    }
    attachLogs(child,logs,{debug});
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
    const remoteProviderPort=23335;
    const remoteAppPort=appPort;
    const baseUrl=`http://127.0.0.1:${remoteProviderPort}/v1`;
    const listen=`ws://127.0.0.1:${remoteAppPort}`;
    const remoteCommand=(profile.cwd?"cd "+quotePosix(profile.cwd)+" && ":"")+"exec "+shellJoin([profile.codexPath||"codex",...remoteCodexArgs({provider,baseUrl,listen})]);
    const executable=process.platform==="win32"?"ssh.exe":"ssh";
    const args=[
      "-o","BatchMode=yes",
      "-o","ExitOnForwardFailure=yes",
      "-o","ConnectTimeout=8",
      "-o","ServerAliveInterval=15",
      "-o","ServerAliveCountMax=3",
      "-L",`127.0.0.1:${appPort}:127.0.0.1:${remoteAppPort}`,
      "-R",`127.0.0.1:${remoteProviderPort}:127.0.0.1:${localProviderPort}`,
      "-p",String(profile.port||22),
    ];
    if(profile.identityFile)args.push("-i",profile.identityFile);
    args.push(profile.user?profile.user+"@"+profile.host:profile.host,remoteCommand);
    const child=spawn(executable,args,{env:process.env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    attachLogs(child,logs,{debug});
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
