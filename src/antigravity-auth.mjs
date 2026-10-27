import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AcpClient } from "./acp-client.mjs";
import { acpProbeSession } from "./acp-model-catalog.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { harnessSecret, saveHarnessSecret } from "./harness-secrets.mjs";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

// Antigravity in Trebell Code signs in only with a Gemini API key (a Google AI Studio key), the route Google recommends for
// third-party apps: Google's Antigravity terms (section 6) count reaching the service through a third-party app with an Antigravity
// Google sign-in as a breach, so Trebell offers no Google sign-in and never uses one the person made elsewhere. Antigravity runs in a
// home of its own under Trebell's (its GEMINI_HOME, as T3 Code gives each Antigravity profile one, antigravityAuthSupport.ts): a
// Google login cached in the person's ~/.gemini never reaches it, nor one in the system keychain (AGY_ACP_FORCE_FILE_STORAGE keeps
// the agent to that home's files), and the settings.json Trebell writes is not the one Zed or JetBrains share when they run the same
// agent. The person's global skills are linked into that home (T3 AntigravitySkills.ts).

// The key method. Antigravity 1.4.3's initialize lists it beside its Google logins; T3 signs in with the method it is set to whether
// initialize lists it or not (AcpSessionRuntime authenticateEagerly), as earlier Antigravity listed only its Google login.
export const ANTIGRAVITY_API_KEY_METHOD="gemini-api-key";
const API_KEY_SECRET="antigravity.geminiApiKey";
// How long a sign-in may take (T3 AntigravityAuth AUTH_TIMEOUT_MS): Antigravity's bundled Python has no IPv4 fallback, so where IPv6
// is broken each request to Google waits about two minutes before it fails.
export const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS=300_000;
export const ANTIGRAVITY_KEY_NEEDED="Antigravity needs a Gemini API key. Create one in Google AI Studio (aistudio.google.com/apikey), then add it to Antigravity in Settings.";
export const ANTIGRAVITY_KEY_SAVED="Gemini API key saved.";
export const ANTIGRAVITY_IPV6_MESSAGE="Antigravity needs IPv6 socket support, which this machine does not give it. Turn IPv6 on, then try again (in WSL: remove ipv6.disable=1 from .wslconfig, then run wsl --shutdown).";
const UNREACHABLE="Antigravity did not finish signing in with the Gemini API key within 5 minutes: it could not reach Google. Check this machine's network connection, then try again. Broken IPv6 is a common cause, as Antigravity has no IPv4 fallback.";

export function antigravityHome(env=process.env){return join(trebellHome(env),"antigravity-home")}
export function antigravityApiKey(env=process.env){return harnessSecret(API_KEY_SECRET,{env})}
export function saveAntigravityApiKey(key,{env=process.env}={}){saveHarnessSecret(API_KEY_SECRET,key,{env})}

// A key as it was pasted, without the spaces or quotes around it; one with a space, a line break or a control character in it is none.
export function normalizeGeminiApiKey(value){
  let key=String(value??"").replace(/[\u200B-\u200D\u2060\uFEFF]/g,"").trim();
  if(/^(["'`]).+\1$/.test(key))key=key.slice(1,-1).trim();
  return key&&key.length<=512&&/^[\x21-\x7e]+$/.test(key)?key:null;
}

// The Google credentials, projects and homes Antigravity reads from its environment (T3 antigravityEnvironment), and its own AGY_ACP_
// switches: none comes from Trebell's environment, a name a profile approves or a profile's variable, whatever its case (Windows reads
// names so). The launch gets Trebell's home for it, file storage for its logins, and the saved key as GEMINI_API_KEY, which only the
// key method reads (GOOGLE_API_KEY would take its place, as Google's client prefers it).
const GOOGLE_NAMES=new Set(["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION","GOOGLE_CLOUD_QUOTA_PROJECT","GOOGLE_GENAI_USE_VERTEXAI","GCLOUD_PROJECT","CLOUDSDK_CORE_PROJECT","GEMINI_HOME"]);
const googleName=name=>{const upper=String(name).toUpperCase();return GOOGLE_NAMES.has(upper)||upper.startsWith("AGY_ACP_")};
export function antigravityEnvironment(env={},{home,apiKey=null}={}){
  const kept={};for(const [name,value] of Object.entries(env||{}))if(!googleName(name))kept[name]=value;
  return {...kept,GEMINI_HOME:home,AGY_ACP_FORCE_FILE_STORAGE:"1",...(apiKey?{GEMINI_API_KEY:apiKey}:{})};
}

// The person's home as Antigravity's Python expands ~ (T3 resolveAntigravityUserHome): USERPROFILE, else HOMEDRIVE and HOMEPATH, on
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

// Antigravity's home in Trebell, made ready for a launch: owner-only folders, settings.json naming the key method (auth.type, as T3
// antigravityProfileSettings writes it: never the key) beside what the agent keeps there itself, and the person's skills linked in.
export async function prepareAntigravityHome({env=process.env,platform=process.platform}={}){
  const home=antigravityHome(env),root=join(home,"antigravity-acp"),settingsPath=join(root,"settings.json");
  await mkdir(root,{recursive:true,mode:0o700});
  if(platform!=="win32")for(const folder of [home,root])await chmod(folder,0o700);
  let current={};try{const parsed=JSON.parse(await readFile(settingsPath,"utf8"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))current=parsed}catch{}
  const auth=current.auth&&typeof current.auth==="object"&&!Array.isArray(current.auth)?current.auth:{},temporary=`${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify({...current,auth:{...auth,type:ANTIGRAVITY_API_KEY_METHOD}},null,2),{encoding:"utf8",mode:0o600});
  await rename(temporary,settingsPath);
  await linkPersonSkills(home,personHome(env,platform),platform);
  return {home,settingsPath};
}

// An Antigravity process that ended because this machine gives it no IPv6 sockets, as its log says (T3 AntigravityInstallation
// AF_INET6 / enforce_kernel_ipv6_support): the failure that says so, or null.
const IPV6_EXIT=/\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/;
export function antigravityIpv6Failure(error){
  const said=[error?.message,error?.cause?.message].filter(Boolean).join("\n");
  return /ACP runtime exited\b/.test(said)&&IPV6_EXIT.test(said)?Object.assign(new Error(ANTIGRAVITY_IPV6_MESSAGE,{cause:error}),{code:"ANTIGRAVITY_IPV6"}):null;
}

// What a sign-in that failed at step (initialize, authenticate or session) says, in plain words (T3 safeAuthFailure), with the
// agent's own where they help and the key never in them.
function signInFailure(error,step,key){
  const ipv6=antigravityIpv6Failure(error);if(ipv6)return ipv6;
  const said=redactSecretText(String(error?.message||error||""),{environment:{GEMINI_API_KEY:key},redactHomes:true,trim:true}),detail=said||"Antigravity gave no reason",code=error?.code;
  const subscription=/\bSUBSCRIPTION_REQUIRED\b/.test(said)||/\bSUBSCRIPTION_REQUIRED\b/.test(JSON.stringify(error?.data??""));
  const message=subscription?"Google refused Antigravity for this Gemini API key: it needs an eligible Antigravity subscription (SUBSCRIPTION_REQUIRED)."
    :/^(?:authenticate|session\/new) timed out$/.test(said)?UNREACHABLE
    :step==="authenticate"&&code===-32602?"Antigravity rejected the Gemini API key. Check the key in Google AI Studio, then enter it again."
    :step==="session"&&code===-32603?`Antigravity signed in with the Gemini API key but could not start a session or load its models: ${detail}`
    :`Antigravity could not sign in with the Gemini API key: ${detail}`;
  return Object.assign(new Error(message,{cause:error}),code!=null?{code}:{});
}

// Signs Antigravity in with a Gemini API key, with no browser (T3 AntigravityAuth with usesBrowser false): initialize, authenticate
// with the key method, then one session in a throwaway folder, never the project, whose Antigravity history it would join (as the
// model list's session does), to check that Antigravity starts a session with the key and to read its models. It all has 5 minutes.
// Antigravity 1.4.3 sends the key to Google only with a chat's first message, where a key Google refuses is said as Antigravity's
// reply, so neither step tells a wrong key. The key reaches only the Antigravity process, as GEMINI_API_KEY; the caller saves it
// once this succeeds. Answers the session's setup and the key.
export async function signInAntigravity({command,args=[],processCwd=null,env={},runTempRoot=null,spawnProcess=null,version="0.0.0",apiKey,timeoutMs=ANTIGRAVITY_SIGN_IN_TIMEOUT_MS}={}){
  const key=normalizeGeminiApiKey(apiKey);if(!key)throw new Error(String(apiKey??"").trim()?"That is not a Gemini API key: paste the key Google AI Studio shows, on one line.":ANTIGRAVITY_KEY_NEEDED);
  const folder=await mkdtemp(join(tmpdir(),"trebell-antigravity-sign-in-")),deadline=Date.now()+timeoutMs,left=()=>Math.max(1000,deadline-Date.now());
  const client=new AcpClient({command,args,cwd:processCwd||folder,env:{...env,GEMINI_API_KEY:key},runTempRoot,spawnProcess,onRequest:method=>{
    if(method==="session/request_permission")return {outcome:{outcome:"cancelled"}};
    throw Object.assign(new Error(`${method} is not available while Antigravity signs in`),{code:-32601});
  }});
  let step="start";
  try{
    await client.start();
    step="initialize";const initialized=await client.initialize({version,timeoutMs:Math.min(90_000,left())});
    step="authenticate";await client.authenticate(ANTIGRAVITY_API_KEY_METHOD,{timeoutMs:left()});
    step="session";const opened=await acpProbeSession(client,initialized,{cwd:folder,timeoutMs:left()});
    if(!opened.sessionId)throw new Error("Antigravity did not open a session after it signed in");
    return {setup:opened.setup,key};
  }catch(error){throw signInFailure(error,step,key)}
  finally{
    await client.stop().catch(()=>{});
    await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});
  }
}

// Settings' Antigravity sign-in (gui-server's /api/agent-runtime-auth) for the profile: Antigravity's home made ready, the sign-in with
// the key typed (or, with none typed, the one saved), then the key saved and the account's models kept in place of the stand-in list
// (T3 publishes the catalog on sign-in). runtimes: the AgentRuntimeManager. Antigravity unpacks its bundle into a Trebell-owned temp
// folder, removed once the process stops.
export async function signInAntigravityProfile(runtimes,instance,{apiKey=null,version="0.0.0"}={}){
  await prepareAntigravityHome({env:runtimes.env,platform:runtimes.platform});
  const command=runtimes.executable(instance),env=runtimes.childEnv(instance);
  const {setup,key}=await signInAntigravity({command,args:runtimes.acpArgs(instance,"supervised"),processCwd:dirname(command),env,runTempRoot:acpRuntimeTempRoot(env,"antigravity"),version,apiKey:String(apiKey??"").trim()?apiKey:antigravityApiKey(runtimes.env)});
  saveAntigravityApiKey(key,{env:runtimes.env});
  runtimes.rememberAcpSessionModels?.(instance,setup,{environmentId:null});
}

// A short Antigravity session of Trebell's own (the model list's) that Antigravity answers with ACP's auth_required (-32000) signs in
// once with the saved key and is asked again (T3 authenticateAfterRequired); without a key, or once the process has ended, the
// failure stays.
export async function afterAntigravitySignIn(client,env,setUp){
  try{return await setUp()}
  catch(error){
    if(error?.code!==-32000||client.closed||!String(env?.GEMINI_API_KEY||"").trim())throw error;
    await client.authenticate(ANTIGRAVITY_API_KEY_METHOD,{timeoutMs:ANTIGRAVITY_SIGN_IN_TIMEOUT_MS});
    return setUp();
  }
}
