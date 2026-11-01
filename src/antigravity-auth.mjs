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
// How long a sign-in may take: the person finishes it in the browser, and Antigravity's bundled Python has no IPv4 fallback, so
// where IPv6 is broken each request to Google waits about two minutes before it fails. Five minutes: two such waits and a minute
// for the person.
export const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS=5*60_000;
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

// Variables Google's tools read by themselves. Through them Antigravity would sign in otherwise than the person chose in Settings,
// run on someone's Google Cloud project or keep its logins outside its home in Trebell, so none reaches an Antigravity launch from
// Trebell's environment, a name a profile approves or a variable a profile sets.
const NOT_FOR_ANTIGRAVITY={
  // A key, or the credential file of Application Default Credentials.
  signIn:["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_APPLICATION_CREDENTIALS"],
  // The Google Cloud project (by its current, older and gcloud names), the project billed for quota, the region, and the Gen AI
  // client's switch to Vertex AI.
  cloud:["GOOGLE_CLOUD_PROJECT","GCLOUD_PROJECT","CLOUDSDK_CORE_PROJECT","GOOGLE_CLOUD_QUOTA_PROJECT","GOOGLE_CLOUD_LOCATION","GOOGLE_GENAI_USE_VERTEXAI"],
  // The folder it keeps its settings and logins in, such as the person's own ~/.gemini.
  home:["GEMINI_HOME"],
};
const notForAntigravity=new Set(Object.values(NOT_FOR_ANTIGRAVITY).flat());
// Antigravity's own switches (AGY_ACP_ENABLE_OAUTH, for one) all start so: none is inherited, and Trebell sets the one it needs.
const ANTIGRAVITY_SWITCHES="AGY_ACP_";

// Whether Antigravity may inherit a variable. Windows reads a name in any case as the same variable (Gemini_Api_Key is
// GEMINI_API_KEY there), so the name is compared upper-cased on every platform.
function antigravityInherits(name){
  const asWindowsReadsIt=name.toUpperCase();
  return !notForAntigravity.has(asWindowsReadsIt)&&!asWindowsReadsIt.startsWith(ANTIGRAVITY_SWITCHES);
}

// The environment an Antigravity process starts with: env's variables Antigravity may inherit, values and order as they were, then
// its home (Trebell's for it, or the installer's throwaway one), file storage for its logins (never the system keychain), and, for a
// profile set to an API key, the Gemini key under the one name its key method reads (not GOOGLE_API_KEY, which Google's client would
// take first). A new object: env is left as it was.
export function antigravityEnvironment(env={},{home,apiKey=null}={}){
  const inherited=Object.entries(env??{}).filter(([name])=>antigravityInherits(name));
  const launch=[["GEMINI_HOME",home],["AGY_ACP_FORCE_FILE_STORAGE","1"]];
  if(apiKey)launch.push(["GEMINI_API_KEY",apiKey]);
  return Object.fromEntries([...inherited,...launch]);
}

// Where Antigravity's bundled Python finds "~" (os.path.expanduser), as groups of variables tried in turn, each group's values
// joined: on Windows USERPROFILE, then the drive in HOMEDRIVE followed by the path in HOMEPATH; on every other platform HOME.
const TILDE_SOURCES={windows:[["USERPROFILE"],["HOMEDRIVE","HOMEPATH"]],unix:[["HOME"]]};

// A variable's value, "" when it is unset or empty. Windows reads a name in any case, so there another spelling of it counts,
// after the name as written.
function variableValue(env,name,platform){
  if(!env)return "";
  if(env[name])return String(env[name]);
  if(platform!=="win32")return "";
  const spelled=Object.keys(env).find(key=>key!==name&&key.toUpperCase()===name&&env[key]);
  return spelled?String(env[spelled]):"";
}

// The folder "~" stands for when Antigravity expands it: the first group of TILDE_SOURCES whose variables all have a value. Where
// none has one, Python would leave "~" as it is, and the operating system's home for the person stands in.
export function homeForTilde(env,platform=process.platform){
  for(const group of TILDE_SOURCES[platform==="win32"?"windows":"unix"]){
    const values=group.map(name=>variableValue(env,name,platform));
    if(values.every(value=>value!==""))return values.join("");
  }
  return homedir();
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
  await linkPersonSkills(home,homeForTilde(env,platform),platform);
  return {home,settingsPath};
}

// The words of a text: its runs of ASCII letters, digits and underscores, which is how a log or an error names a constant, a
// setting or a reason code.
const wordsOf=text=>String(text??"").split(/[^A-Za-z0-9_]+/).filter(Boolean);

// How a process exit is recorded: the ACP client ends every request of an agent whose process exited with a failure that carries
// processExit (its code, signal and log excerpt; acp-client.mjs). Callers may wrap that failure (cause), so the wrappers are
// followed, a few at most.
const WRAPPERS_FOLLOWED=5;
function processExitBehind(failure){
  let link=failure;
  for(let hop=0;hop<=WRAPPERS_FOLLOWED&&link&&typeof link==="object";hop++){
    if(link.processExit)return link.processExit;
    link=link.cause;
  }
  return null;
}

// Words Antigravity's log holds when the machine gives it no IPv6 socket: Python's socket error names the address family it
// could not open (AF_INET6, after "Address family not supported by protocol"), and gRPC names its enforce_kernel_ipv6_support
// setting.
const NO_IPV6_LOG_WORDS=new Set(["AF_INET6","enforce_kernel_ipv6_support"]);

// A new error for the person to read, with the failure behind it as its cause and, when there is one, a code.
function failureExplained(sentence,failure,code){
  const explained=new Error(sentence,{cause:failure});
  if(code!=null)explained.code=code;
  return explained;
}

// An Antigravity process that exited because this machine gives it no IPv6 sockets, as its log says: a failure that explains it
// (code ANTIGRAVITY_IPV6, the failure given as its cause), or null for any other failure.
export function antigravityIpv6Failure(error){
  const exit=processExitBehind(error);
  if(!exit||!wordsOf(exit.excerpt).some(word=>NO_IPV6_LOG_WORDS.has(word)))return null;
  return failureExplained(ANTIGRAVITY_IPV6_MESSAGE,error,"ANTIGRAVITY_IPV6");
}

// Google's reason code for an account whose plan does not include Antigravity.
const NO_SUBSCRIPTION_CODE="SUBSCRIPTION_REQUIRED";
// The request through which a sign-in step waits on Google. The ACP client ends one with no answer in time as "<method> timed out".
const WAITS_ON_GOOGLE={authenticate:"authenticate",session:"session/new"};
// JSON-RPC 2.0's code for an error inside the server. Antigravity answers the session it opens after signing in with it when the
// account's session or model list cannot be set up.
const JSON_RPC_INTERNAL_ERROR=-32603;

const messageOf=failure=>typeof failure==="string"?failure:String(failure?.message??"");
// Every string of a JSON-RPC error's data, its keys too, however it nests: the data came as JSON, and JSON.stringify's replacer
// is shown each key and value of it once.
function dataStrings(data){
  const strings=[];
  try{JSON.stringify(data??null,(key,value)=>{if(key)strings.push(key);if(typeof value==="string")strings.push(value);return value})}catch{}
  return strings;
}

// What stopped a sign-in that did not end for want of IPv6, by name, from the failure and the step of signInAntigravity that was
// running (start, initialize, authenticate or session). The first of these that fits: Google's code for a plan without
// Antigravity, in the message or the error's data; no answer in time to the request the step waits on Google through; an error
// inside Antigravity as it opens the session after the sign-in; else a refusal.
function signInTrouble(failure,step){
  const said=messageOf(failure);
  if(new Set([said,...dataStrings(failure?.data)].flatMap(wordsOf)).has(NO_SUBSCRIPTION_CODE))return "no-subscription";
  const waitedOn=WAITS_ON_GOOGLE[step];
  if(waitedOn&&said.trim()===`${waitedOn} timed out`)return "no-answer";
  if(step==="session"&&failure?.code===JSON_RPC_INTERNAL_ERROR)return "no-session";
  return "refused";
}

// A sentence followed by the agent's own words, or by the fact that it gave none.
const followedBy=(sentence,words)=>words?`${sentence}: ${words}`:`${sentence}, and it gave no reason.`;
// What the person reads for each, given the agent's words (agentWords).
const SIGN_IN_SENTENCES={
  "no-subscription":()=>`Google says this account's plan does not include Antigravity (${NO_SUBSCRIPTION_CODE}). Sign in with an account whose plan includes it, or set Antigravity to run on a Google Gemini API key.`,
  "no-answer":()=>UNREACHABLE,
  "no-session":words=>followedBy("The sign-in went through, but Antigravity failed to open a session and read the account's models",words),
  refused:words=>followedBy("Antigravity could not sign in",words),
};

// The agent's own words, for the person to read: its message with secrets and home folders hidden, both ends trimmed.
const agentWords=failure=>redactSecretText(messageOf(failure),{redactHomes:true,trim:true});

// Why Antigravity's own sign-in failed, as the person reads it in Settings: the IPv6 explanation when that is why, else the
// sentence for the trouble signInTrouble names. The new error keeps the failure as its cause and its JSON-RPC code.
function explainSignInFailure(failure,step){
  return antigravityIpv6Failure(failure)
    ??failureExplained(SIGN_IN_SENTENCES[signInTrouble(failure,step)](agentWords(failure)),failure,failure?.code);
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
  }catch(error){throw explainSignInFailure(error,step)}
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
