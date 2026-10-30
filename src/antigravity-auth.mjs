import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AcpClient } from "./acp-client.mjs";
import { acpProbeSession } from "./acp-model-catalog.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

// Antigravity signs in as the person picks in Settings (harness-auth.mjs): with its own sign-in, which the agent runs itself over ACP
// (authenticate with a login method its initialize lists: it opens Google's page, and keeps its token in its home), or on the
// Google Gemini API key Trebell keeps for Native's Gemini provider, through its gemini-api-key method. Trebell never reads the token
// the agent keeps: its status only checks that the token file is there. Antigravity runs in a home of its own under
// Trebell's (its GEMINI_HOME): a login cached in the person's ~/.gemini never reaches
// it, nor one in the system keychain (AGY_ACP_FORCE_FILE_STORAGE keeps the agent to that home's files), and the settings.json there
// is not the one Zed or JetBrains share when they run the same agent. The person's global skills are linked into that home.

// The key method, used only for a profile set to an API key. Antigravity 1.4.3's initialize lists it beside its own logins.
export const ANTIGRAVITY_API_KEY_METHOD="gemini-api-key";
// Antigravity's own logins as its initialize lists them, in the order Settings' Sign in picks one: Google's, then Gemini Enterprise's
// and Agent Platform's, then any other the agent runs itself.
const OWN_SIGN_IN_METHODS=["oauth-personal","oauth-business","agent-platform"];
// How long a sign-in may take: the person finishes it in the browser, and Antigravity's bundled
// Python has no IPv4 fallback, so where IPv6 is broken each request to Google waits about two minutes before it fails.
export const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS=300_000;
export const ANTIGRAVITY_SIGN_IN_NEEDED="Antigravity is not signed in. Press Sign in to sign in with Antigravity's own sign-in, or set it to run on a Google Gemini API key.";
export const ANTIGRAVITY_SIGNED_IN="Signed in with Antigravity's own sign-in.";
export const ANTIGRAVITY_KEY_READY="Runs on the Google Gemini API key.";
export const ANTIGRAVITY_IPV6_MESSAGE="Antigravity needs IPv6 socket support, which this machine does not give it. Turn IPv6 on, then try again (in WSL: remove ipv6.disable=1 from .wslconfig, then run wsl --shutdown).";
const UNREACHABLE="Antigravity's sign-in did not finish within 5 minutes. Finish it in the browser page Antigravity opened; Antigravity does not fall back to IPv4 when IPv6 fails, so also check that this machine reaches Google, then sign in again.";

export function antigravityHome(env=process.env){return join(trebellHome(env),"antigravity-home")}
const settingsFile=env=>join(antigravityHome(env),"antigravity-acp","settings.json");

// Which sign-in Antigravity's home holds: the method its settings.json names (auth.type), and whether the agent keeps a login token
// there, its token file, which only access() checks: it is never read.
export async function antigravitySignInState({env=process.env}={}){
  let method=null;
  try{const parsed=JSON.parse(await readFile(settingsFile(env),"utf8"));method=typeof parsed?.auth?.type==="string"&&parsed.auth.type.trim()?parsed.auth.type.trim():null}catch{}
  let token=false;try{await access(join(antigravityHome(env),"antigravity-acp","acp_token.json"));token=true}catch{}
  return {method,token,signedIn:Boolean(method&&method!==ANTIGRAVITY_API_KEY_METHOD&&token)};
}

// The Google credentials, projects and homes Antigravity reads from its environment, and its own AGY_ACP_
// switches: none comes from Trebell's environment, a name a profile approves or a profile's variable, whatever its case (Windows reads
// names so). The launch gets Trebell's home for it, file storage for its logins, and, for a profile set to an API key, the Gemini
// key as GEMINI_API_KEY, which only the key method reads (GOOGLE_API_KEY would take its place, as Google's client prefers it).
const GOOGLE_NAMES=new Set(["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION","GOOGLE_CLOUD_QUOTA_PROJECT","GOOGLE_GENAI_USE_VERTEXAI","GCLOUD_PROJECT","CLOUDSDK_CORE_PROJECT","GEMINI_HOME"]);
const googleName=name=>{const upper=String(name).toUpperCase();return GOOGLE_NAMES.has(upper)||upper.startsWith("AGY_ACP_")};
export function antigravityEnvironment(env={},{home,apiKey=null}={}){
  const kept={};for(const [name,value] of Object.entries(env||{}))if(!googleName(name))kept[name]=value;
  return {...kept,GEMINI_HOME:home,AGY_ACP_FORCE_FILE_STORAGE:"1",...(apiKey?{GEMINI_API_KEY:apiKey}:{})};
}

// The person's home as Antigravity's Python expands ~: USERPROFILE, else HOMEDRIVE and HOMEPATH, on
// Windows, and HOME elsewhere.
function personHome(env,platform){
  if(platform==="win32")return env.USERPROFILE||(env.HOMEDRIVE&&env.HOMEPATH?env.HOMEDRIVE+env.HOMEPATH:homedir());
  return env.HOME||homedir();
}
const samePath=(a,b,platform)=>platform==="win32"?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
// The person's global skills (~/.gemini/config/skills and ~/.gemini/antigravity-cli/skills) through a link each in Antigravity's
// home: a junction on Windows, which needs no developer mode. A link to a folder that is not there yet works once it is made; a
// folder of the home's own, or a link that cannot be made, leaves the home as it is.
async function linkPersonSkills(home,person,platform){
  for(const parts of [["config","skills"],["antigravity-cli","skills"]]){
    const link=join(home,...parts),target=join(person,".gemini",...parts);
    try{
      const info=await lstat(link).catch(error=>{if(error?.code==="ENOENT")return null;throw error});
      if(info&&!info.isSymbolicLink())continue;
      if(info){if(samePath(resolve(dirname(link),await readlink(link)),target,platform))continue;await rm(link,{force:true})}
      await mkdir(dirname(link),{recursive:true});
      await symlink(target,link,platform==="win32"?"junction":"dir");
    }catch{}
  }
}

// Antigravity's home in Trebell, made ready for a launch: owner-only folders, settings.json naming the method it signs in with
// (auth.type, never a key or token) beside what the agent keeps there itself, and the
// person's skills linked in. method: the key method for a profile on an API key, or the login its own sign-in chose; null (a
// profile on Sign in) leaves the method its sign-in recorded and drops the key method an API key left there.
export async function prepareAntigravityHome({env=process.env,platform=process.platform,method=null}={}){
  const home=antigravityHome(env),root=join(home,"antigravity-acp"),settingsPath=join(root,"settings.json");
  await mkdir(root,{recursive:true,mode:0o700});
  if(platform!=="win32")for(const folder of [home,root])await chmod(folder,0o700);
  let current={};try{const parsed=JSON.parse(await readFile(settingsPath,"utf8"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))current=parsed}catch{}
  const auth=current.auth&&typeof current.auth==="object"&&!Array.isArray(current.auth)?current.auth:{};
  const {type:_type,...rest}=auth,type=method||(auth.type===ANTIGRAVITY_API_KEY_METHOD?null:auth.type||null);
  if(type!==(auth.type||null)){
    const temporary=`${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify({...current,auth:type?{...rest,type}:rest},null,2),{encoding:"utf8",mode:0o600});
    await rename(temporary,settingsPath);
  }
  await linkPersonSkills(home,personHome(env,platform),platform);
  return {home,settingsPath};
}

// An Antigravity process that ended because this machine gives it no IPv6 sockets, as its log says (AF_INET6 or
// enforce_kernel_ipv6_support): the failure that says so, or null.
const IPV6_EXIT=/\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/;
export function antigravityIpv6Failure(error){
  const said=[error?.message,error?.cause?.message].filter(Boolean).join("\n");
  return /ACP runtime exited\b/.test(said)&&IPV6_EXIT.test(said)?Object.assign(new Error(ANTIGRAVITY_IPV6_MESSAGE,{cause:error}),{code:"ANTIGRAVITY_IPV6"}):null;
}

// What a sign-in that failed at step (initialize, authenticate or session) says, in plain words, with the
// agent's own where they help.
function signInFailure(error,step){
  const ipv6=antigravityIpv6Failure(error);if(ipv6)return ipv6;
  const said=redactSecretText(String(error?.message||error||""),{redactHomes:true,trim:true}),detail=said||"Antigravity gave no reason",code=error?.code;
  const subscription=/\bSUBSCRIPTION_REQUIRED\b/.test(said)||/\bSUBSCRIPTION_REQUIRED\b/.test(JSON.stringify(error?.data??""));
  const message=subscription?"Google refused Antigravity for this account, saying it needs a subscription that includes Antigravity (SUBSCRIPTION_REQUIRED)."
    :/^(?:authenticate|session\/new) timed out$/.test(said)?UNREACHABLE
    :step==="session"&&code===-32603?`Antigravity signed in but could not start a session or load its models: ${detail}`
    :`Antigravity could not sign in: ${detail}`;
  return Object.assign(new Error(message,{cause:error}),code!=null?{code}:{});
}

// The login Settings' Sign in runs: the one asked for when the agent lists it, else Antigravity's own logins in their order, else
// the first other method the agent runs itself. Never the key method.
export function antigravityOwnSignInMethod(authMethods=[],requested=null){
  const methods=(Array.isArray(authMethods)?authMethods:[]).filter(method=>method?.id&&method.id!==ANTIGRAVITY_API_KEY_METHOD);
  const byId=id=>methods.find(method=>method.id===id);
  return (requested&&byId(String(requested)))||OWN_SIGN_IN_METHODS.map(byId).find(Boolean)||methods.find(method=>method.type==null||method.type==="agent")||null;
}

// Antigravity's own sign-in, in the browser: initialize, the method recorded in its home (onMethod), then
// authenticate, which the agent runs itself (it opens Google's page and keeps its token in its home), then one session in a
// throwaway folder, never the project, whose Antigravity history it would join, to check that it starts one and to read its models.
// It all has 5 minutes. No key is in its environment. Answers the session's setup and the method.
export async function signInAntigravity({command,args=[],processCwd=null,env={},runTempRoot=null,spawnProcess=null,version="0.0.0",methodId=null,onMethod=null,timeoutMs=ANTIGRAVITY_SIGN_IN_TIMEOUT_MS}={}){
  const folder=await mkdtemp(join(tmpdir(),"trebell-antigravity-sign-in-")),deadline=Date.now()+timeoutMs,left=()=>Math.max(1000,deadline-Date.now());
  const launchEnv={};for(const [name,value] of Object.entries(env||{}))if(!["GEMINI_API_KEY","GOOGLE_API_KEY"].includes(name.toUpperCase()))launchEnv[name]=value;
  const client=new AcpClient({command,args,cwd:processCwd||folder,env:launchEnv,runTempRoot,spawnProcess,onRequest:method=>{
    if(method==="session/request_permission")return {outcome:{outcome:"cancelled"}};
    throw Object.assign(new Error(`${method} is not available while Antigravity signs in`),{code:-32601});
  }});
  let step="start";
  try{
    await client.start();
    step="initialize";const initialized=await client.initialize({version,timeoutMs:Math.min(90_000,left())});
    const method=antigravityOwnSignInMethod(initialized?.authMethods,methodId);
    if(!method)throw new Error("Antigravity did not offer a sign-in of its own.");
    await onMethod?.(method.id);
    step="authenticate";await client.authenticate(method.id,{timeoutMs:left()});
    step="session";const opened=await acpProbeSession(client,initialized,{cwd:folder,timeoutMs:left()});
    if(!opened.sessionId)throw new Error("Antigravity did not open a session after it signed in");
    return {setup:opened.setup,methodId:method.id,methodName:method.name||method.id};
  }catch(error){throw signInFailure(error,step)}
  finally{
    await client.stop().catch(()=>{});
    await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});
  }
}

// Settings' Antigravity Sign in (gui-server's /api/agent-runtime-auth) for a profile on Sign in: Antigravity's home made ready, its
// own sign-in, the method it chose recorded in its home, and the account's models kept in place of the stand-in list. runtimes:
// the AgentRuntimeManager. Antigravity unpacks its bundle into a Trebell-owned temp folder,
// removed once the process stops. Answers the method and whether it is another than the one before (changed).
export async function signInAntigravityProfile(runtimes,instance,{methodId=null,version="0.0.0"}={}){
  await prepareAntigravityHome({env:runtimes.env,platform:runtimes.platform});
  const before=(await antigravitySignInState({env:runtimes.env})).method;
  const command=runtimes.executable(instance),env=runtimes.childEnv(instance);
  const signedIn=await signInAntigravity({command,args:runtimes.acpArgs(instance,"supervised"),processCwd:dirname(command),env,runTempRoot:acpRuntimeTempRoot(env,"antigravity"),version,methodId,
    onMethod:method=>prepareAntigravityHome({env:runtimes.env,platform:runtimes.platform,method})});
  runtimes.rememberAcpSessionModels?.(instance,signedIn.setup,{environmentId:null});
  return {methodId:signedIn.methodId,methodName:signedIn.methodName,changed:signedIn.methodId!==before};
}

// A short Antigravity session of Trebell's own (the model list's) that Antigravity answers with ACP's auth_required (-32000) signs in
// once with the key method when its launch has the Gemini key (a profile on an API key), and is asked again. On Sign in it never
// signs in by itself: the person signs in from Settings.
export async function afterAntigravitySignIn(client,env,setUp){
  try{return await setUp()}
  catch(error){
    if(error?.code!==-32000||client.closed||!String(env?.GEMINI_API_KEY||"").trim())throw error;
    await client.authenticate(ANTIGRAVITY_API_KEY_METHOD,{timeoutMs:ANTIGRAVITY_SIGN_IN_TIMEOUT_MS});
    return setUp();
  }
}
