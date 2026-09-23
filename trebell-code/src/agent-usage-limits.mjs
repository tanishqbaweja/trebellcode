function checkedAt(){return new Date().toISOString()}
function clampPercent(value){const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(100,number)):null}
function unavailable(reason="unsupported",message=null,at=checkedAt()){
  return {checkedAt:at,windows:[],unavailable:{reason,...(message?{message}:{})}};
}
function available(windows,at=checkedAt()){return {checkedAt:at,windows}}
function safeJson(text,fallback=null){try{return JSON.parse(String(text||""))}catch{return fallback}}
function resetIso(value){
  if(value==null||value==="")return null;
  const numeric=Number(value);
  const date=Number.isFinite(numeric)&&numeric>0?new Date(numeric):new Date(String(value));
  return Number.isFinite(date.getTime())?date.toISOString():null;
}
async function fetchJson(fetchImpl,url,{method="GET",token=null,headers={},body=null,timeoutMs=10000}={}){
  if(typeof fetchImpl!=="function")return {ok:false,status:0,data:null};
  let response;
  try{
    response=await fetchImpl(url,{
      method,
      headers:{...(token?{authorization:"Bearer "+token}:{}),...headers},
      ...(body==null?{}:{body:JSON.stringify(body)}),
      ...(typeof AbortSignal?.timeout==="function"?{signal:AbortSignal.timeout(timeoutMs)}:{}),
    });
  }catch{return {ok:false,status:0,data:null}}
  if(!response?.ok)return {ok:false,status:Number(response?.status)||0,data:null};
  try{return {ok:true,status:Number(response.status)||200,data:await response.json()}}
  catch{return {ok:false,status:Number(response.status)||200,data:null}}
}

export function cursorUsageResponseToLimits(response,at=checkedAt()){
  const usage=response?.planUsage&&typeof response.planUsage==="object"?response.planUsage:null;
  const resetsAt=resetIso(response?.billingCycleEnd);const windows=[];
  for(const [id,label] of [["totalPercentUsed","Monthly"],["autoPercentUsed","Monthly · Auto"],["apiPercentUsed","Monthly · API"]]){
    const usedPercent=clampPercent(usage?.[id]);if(usedPercent==null)continue;
    windows.push({id,kind:"monthly",label,usedPercent,...(resetsAt?{resetsAt}:{})});
  }
  return windows.length?available(windows,at):unavailable("unsupported",null,at);
}

export async function readCursorUsageLimits({environment={},platform=process.platform,home="",readText,joinPath,fetchImpl=globalThis.fetch}={}){
  const at=checkedAt();let token=String(environment.CURSOR_AUTH_TOKEN||"").trim();
  if(!token&&String(environment.CURSOR_API_KEY||"").trim())return unavailable("unsupported",null,at);
  const credentialStore=String(environment.AGENT_CLI_CREDENTIAL_STORE||"").trim();
  if(!token&&(credentialStore==="memory"||(platform==="darwin"&&credentialStore!=="file"))){
    return unavailable("unsupported","Cursor usage requires a file-based login or CURSOR_AUTH_TOKEN.",at);
  }
  if(!token&&readText&&joinPath){
    const directory=platform==="win32"
      ?String(environment.APPDATA||joinPath(home,"AppData","Roaming","Cursor"))
      :platform==="darwin"?joinPath(home,".cursor"):joinPath(environment.XDG_CONFIG_HOME||joinPath(home,".config"),"cursor");
    const credentials=safeJson(await readText(joinPath(directory,"auth.json")),{})||{};
    token=String(credentials.accessToken||"").trim();
  }
  if(!token)return unavailable("unsupported",null,at);
  const endpoint=String(environment.CURSOR_API_ENDPOINT||"https://api2.cursor.sh").trim().replace(/\/$/,"");
  const result=await fetchJson(fetchImpl,endpoint+"/aiserver.v1.DashboardService/GetCurrentPeriodUsage",{
    method:"POST",token,headers:{"content-type":"application/json","connect-protocol-version":"1","x-cursor-client-type":"cli"},body:{},
  });
  return result.ok?cursorUsageResponseToLimits(result.data,at):unavailable("probeFailed","Cursor could not read usage limits.",at);
}

export function grokUsageResponseToLimits(response,at=checkedAt()){
  const usedPercent=clampPercent(response?.config?.creditUsagePercent);
  if(usedPercent==null)return unavailable("unsupported",null,at);
  const rawType=String(response?.config?.currentPeriod?.type||"").replace(/^USAGE_PERIOD_TYPE_/,"");
  const kind=rawType==="WEEKLY"?"weekly":rawType==="MONTHLY"?"monthly":"other";
  const resetsAt=resetIso(response?.config?.currentPeriod?.end);
  return available([{id:"subscription",kind,label:kind==="weekly"?"Weekly":kind==="monthly"?"Monthly":"Subscription",usedPercent,...(resetsAt?{resetsAt}:{})}],at);
}

const GROK_CUSTOM_ENV=["GROK_OIDC_ISSUER","GROK_OIDC_CLIENT_ID","GROK_OAUTH2_ISSUER","GROK_OAUTH2_CLIENT_ID","GROK_OAUTH2_PRINCIPAL_TYPE","GROK_OAUTH2_PRINCIPAL_ID","GROK_AUTH_PROVIDER_COMMAND","GROK_LOCAL_AUTH","GROK_CLI_CHAT_PROXY_BASE_URL","GROK_MODELS_BASE_URL","GROK_CONFIG","GROK_CONFIG_PATH"];
export async function readGrokUsageLimits({environment={},home="",readText,joinPath,fetchImpl=globalThis.fetch}={}){
  const at=checkedAt();
  if(String(environment.XAI_API_KEY||"").trim()||GROK_CUSTOM_ENV.some(name=>String(environment[name]||"").trim()))return unavailable("unsupported",null,at);
  if(!readText||!joinPath)return unavailable("unsupported",null,at);
  const grokHome=String(environment.GROK_HOME||"").trim()||joinPath(home,".grok");
  for(const path of [joinPath(grokHome,"config.toml"),joinPath(grokHome,"managed_config.toml"),joinPath(grokHome,"requirements.toml"),"/etc/grok/managed_config.toml","/etc/grok/requirements.toml"]){
    const config=await readText(path)||"";
    if(/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config))return unavailable("unsupported",null,at);
  }
  const contents=String(environment.GROK_AUTH||"").trim()||await readText(joinPath(grokHome,"auth.json"))||"{}";
  const credentials=safeJson(contents,{})||{};
  const credential=credentials["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"]??credentials["https://accounts.x.ai/sign-in"];
  const token=credential?.auth_mode==="api_key"?"":String(credential?.key||"").trim();
  if(!token)return unavailable("unsupported",null,at);
  const result=await fetchJson(fetchImpl,"https://cli-chat-proxy.grok.com/v1/billing?format=credits",{token});
  return result.ok?grokUsageResponseToLimits(result.data,at):unavailable("probeFailed","Grok could not read usage limits.",at);
}

export function openCodeUsageResponseToLimits(response,at=checkedAt()){
  const source=response?.usage;
  if(!source||typeof source!=="object")return unavailable("probeFailed","OpenCode Go could not read usage.",at);
  const definitions=[
    ["rolling","go_rolling","session","Go · Session",5*60],
    ["weekly","go_weekly","weekly","Go · Weekly",7*24*60],
    ["monthly","go_monthly","monthly","Go · Monthly",null],
  ];
  const windows=[];
  for(const [key,id,kind,label,windowDurationMins] of definitions){
    const usedPercent=clampPercent(source[key]?.percent);const resetsAt=resetIso(source[key]?.resetsAt);
    if(usedPercent==null||!resetsAt)return unavailable("probeFailed","OpenCode Go could not read usage.",at);
    windows.push({id,kind,label,usedPercent,resetsAt,...(windowDurationMins?{windowDurationMins}:{})});
  }
  return available(windows,at);
}

export async function readOpenCodeUsageLimits({environment={},home="",readText,joinPath,fetchImpl=globalThis.fetch,serverUrl=""}={}){
  const at=checkedAt();
  if(String(serverUrl||"").trim()||!readText||!joinPath)return unavailable("unsupported",null,at);
  const dataHome=String(environment.XDG_DATA_HOME||"").trim()||joinPath(home,".local","share");
  const contents=String(environment.OPENCODE_AUTH_CONTENT||"").trim()||await readText(joinPath(dataHome,"opencode","auth.json"))||"{}";
  const auth=safeJson(contents,{})||{};const stored=auth["opencode-go"];
  const token=String(stored?.type==="api"?stored.key:environment.OPENCODE_API_KEY||"").trim();
  if(!token)return unavailable("unsupported",null,at);
  const result=await fetchJson(fetchImpl,"https://opencode.ai/zen/go/v1/usage",{token,timeoutMs:5000});
  if(result.status===403)return unavailable("unsupported",null,at);
  return result.ok?openCodeUsageResponseToLimits(result.data,at):unavailable("probeFailed","OpenCode Go could not read usage.",at);
}

export async function readAgentRuntimeUsage(runtime,options={}){
  if(runtime==="cursor")return readCursorUsageLimits(options);
  if(runtime==="grok")return readGrokUsageLimits(options);
  if(runtime==="opencode")return readOpenCodeUsageLimits(options);
  return unavailable("unsupported",null,checkedAt());
}
