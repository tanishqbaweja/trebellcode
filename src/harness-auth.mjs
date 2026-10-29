// How each official harness signs in: with its own login in its own home (Sign in, the default), or, when the person picks it in
// Settings for a runtime profile, on its vendor's API key from Trebell's one key per provider (the Model provider card's store, else
// the environment variable Trebell Native reads for that provider). Nothing else decides it: a key in .env, in Trebell's own
// environment or in a profile's approved names never reaches a harness on Sign in, and never moves one to its key method by being
// there (runtime-environment.mjs keeps every credential out). A harness on API key gets only its own vendor's key, in the variable
// its official CLI reads, and signs in with its key method where it has one (Grok's xai.api_key, Antigravity's gemini-api-key).
// Cursor has no API key: it signs in only. Trebell never reads the credentials a harness keeps for its own sign-in.

export const HARNESS_SIGN_IN="sign-in";
export const HARNESS_API_KEY="api-key";

// The Native providers whose key each harness can run on, and the variable it reads that key from. OpenCode takes each saved key
// of a provider it supports (models.dev names them so), any of them enough to start.
export const HARNESS_KEY_VARIABLES=Object.freeze({
  claude:Object.freeze({anthropic:"ANTHROPIC_API_KEY"}),
  codex:Object.freeze({openai:"OPENAI_API_KEY"}),
  muse:Object.freeze({meta:"META_API_KEY"}),
  grok:Object.freeze({xai:"XAI_API_KEY"}),
  antigravity:Object.freeze({gemini:"GEMINI_API_KEY"}),
  opencode:Object.freeze({openai:"OPENAI_API_KEY",anthropic:"ANTHROPIC_API_KEY",gemini:"GEMINI_API_KEY",xai:"XAI_API_KEY"}),
});

// Whether a harness can run on an API key at all (every official one but Cursor; Trebell Native always does, in its own way).
export function harnessTakesApiKey(kind){return Object.hasOwn(HARNESS_KEY_VARIABLES,String(kind||""))}

// A profile's method as Settings saved it: API key only where the harness takes one and the profile says so, else Sign in.
export function harnessAuthMethod(instance){
  return harnessTakesApiKey(instance?.kind)&&instance?.auth===HARNESS_API_KEY?HARNESS_API_KEY:HARNESS_SIGN_IN;
}

export function normalizeHarnessAuthMethod(kind,value){
  if(value==null||value==="")return null;
  const method=String(value).trim().toLowerCase();
  if(method!==HARNESS_SIGN_IN&&method!==HARNESS_API_KEY)throw new Error("A harness signs in with its own sign-in (sign-in) or an API key (api-key).");
  if(method===HARNESS_API_KEY&&!harnessTakesApiKey(kind))throw new Error(kind==="cursor"?"Cursor has no API key: it signs in with its own login only.":"This harness does not run on an API key.");
  return method;
}

// An OpenCode profile with a server URL runs on the server it names, started elsewhere with that server's own sign-in: Trebell starts
// no OpenCode for it, so it has no launch to hand a key to, and such a profile cannot be set to an API key.
export const OPENCODE_SERVER_KEY_MESSAGE="OpenCode at a server URL runs on that server's own sign-in: Trebell Code cannot hand it a key. Clear the profile's server URL to run OpenCode on an API key, or set it to Sign in.";
export function harnessApiKeyProfileRefusal(instance){return instance?.kind==="opencode"&&String(instance?.serverUrl||"").trim()?OPENCODE_SERVER_KEY_MESSAGE:null}

// The key method a harness on its API key signs in with as an ACP session of it starts, a chat's or Git text's: Grok's xai.api_key,
// when its initialize lists it and its launch has XAI_API_KEY, so a login Grok cached itself (`grok login`) never stands in for the
// key the person chose. Antigravity's key method is named in its home's settings (prepareAntigravityHome).
export function acpApiKeyMethod({runtime,authMethod,env,initializeResult}={}){
  if(authMethod!==HARNESS_API_KEY||runtime!=="grok"||!String(env?.XAI_API_KEY||"").trim())return null;
  const methods=Array.isArray(initializeResult?.authMethods)?initializeResult.authMethods:[];
  return methods.some(method=>String(method?.id||"").trim()==="xai.api_key")?"xai.api_key":null;
}

// The keys a harness on API key starts with: {env:{VARIABLE:key}, providers:[{provider, variable, source}], missing:[provider ids]}.
// keyFor: the provider key reader (ProviderManager.keyFor). Never a key of another vendor.
export function harnessKeyEnvironment(kind,keyFor){
  const variables=HARNESS_KEY_VARIABLES[kind]||{},env={},providers=[],missing=[];
  for(const [provider,variable] of Object.entries(variables)){
    let found=null;try{found=typeof keyFor==="function"?keyFor(provider):null}catch{found=null}
    if(found?.key){env[variable]=found.key;providers.push({provider,variable,source:found.source||null})}
    else missing.push(provider);
  }
  return {env,providers,missing,ready:providers.length>0};
}

// A provider's key as Settings names it: "Anthropic API" -> "Anthropic API key", "AgentRouter" -> "AgentRouter API key".
export function providerKeyLabel(name){const text=String(name||"Provider").trim();return /\bAPI$/i.test(text)?text+" key":text+" API key"}
// Each harness's own sign-in, as Settings tells the person to run it.
export const HARNESS_SIGN_IN_COMMANDS=Object.freeze({codex:"codex login",claude:"claude auth login",grok:"grok login",opencode:"opencode auth login",muse:"muse login",antigravity:"Antigravity's own sign-in"});
// What a harness on API key in a WSL or SSH environment says: a key saved in Trebell stays on this machine (a host would show it in
// its process list), and a key the host's shell holds never stands in for it.
export function harnessRemoteKeyMessage(name,kind){
  const command=HARNESS_SIGN_IN_COMMANDS[kind];
  return `${name} runs on an API key only on this machine: Trebell Code never sends a saved key to a WSL or SSH environment. In this environment, set ${name} to Sign in and sign in there${command?" with "+command:""}.`;
}
// What a harness on API key without its key says, in Settings and in its status: plainly that the key is missing and where to add it.
// providerNames: the providers it can run on (OpenCode's several, any one enough).
export function harnessKeyMissingMessage(name,providerNames){
  const names=providerNames.map(String),list=names.length>1?names.slice(0,-1).join(", ")+" or "+names[names.length-1]+" key":providerKeyLabel(names[0]);
  return `${name} is set to run on ${names.length>1?"an "+list:"the "+list}, and Trebell Code has none. Add it under ${name} in Settings → Agents & models, or set ${name} to Sign in.`;
}
