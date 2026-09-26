const BASELINE_KEYS=Object.freeze([
  "PATH","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","TMPDIR",
  "HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA","PROGRAMDATA",
  "XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME",
  "LANG","LC_ALL","LC_CTYPE","TERM","COLORTERM","SHELL","USER","USERNAME","LOGNAME",
  "SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS","NO_COLOR","FORCE_COLOR",
]);

const RUNTIME_KEYS=Object.freeze({
  native:Object.freeze([]),
  codex:Object.freeze(["OPENAI_API_KEY","OPENAI_BASE_URL","OPENAI_ORG_ID","OPENAI_PROJECT_ID","CODEX_API_KEY"]),
  claude:Object.freeze(["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_BASE_URL"]),
  cursor:Object.freeze(["CURSOR_API_KEY","CURSOR_AUTH_TOKEN","CURSOR_API_ENDPOINT"]),
  grok:Object.freeze([
    "XAI_API_KEY","GROK_AUTH","GROK_HOME","GROK_OIDC_ISSUER","GROK_OIDC_CLIENT_ID",
    "GROK_OAUTH2_ISSUER","GROK_OAUTH2_CLIENT_ID","GROK_OAUTH2_PRINCIPAL_TYPE","GROK_OAUTH2_PRINCIPAL_ID",
    "GROK_AUTH_PROVIDER_COMMAND","GROK_LOCAL_AUTH","GROK_CLI_CHAT_PROXY_BASE_URL","GROK_MODELS_BASE_URL",
    "GROK_CONFIG","GROK_CONFIG_PATH",
  ]),
  opencode:Object.freeze([
    "OPENCODE_API_KEY","OPENCODE_AUTH_CONTENT","OPENCODE_CONFIG","OPENCODE_CONFIG_DIR","OPENCODE_SERVER_USERNAME","OPENCODE_SERVER_PASSWORD",
    "OPENAI_API_KEY","ANTHROPIC_API_KEY","GOOGLE_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY",
    "NVIDIA_API_KEY","HF_TOKEN","HUGGINGFACE_API_KEY","DEEPSEEK_API_KEY","MISTRAL_API_KEY","GROQ_API_KEY","XAI_API_KEY",
    "COHERE_API_KEY","CEREBRAS_API_KEY","TOGETHER_API_KEY","FIREWORKS_API_KEY","PERPLEXITY_API_KEY",
    "AZURE_OPENAI_API_KEY","AZURE_OPENAI_ENDPOINT",
    "AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_REGION","AWS_DEFAULT_REGION",
  ]),
  antigravity:Object.freeze([
    "GEMINI_HOME","GOOGLE_API_KEY","GEMINI_API_KEY","GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION","CLOUDSDK_CORE_PROJECT",
  ]),
});

function keyName(value){return String(value||"").trim()}
function validName(value){return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)}

export function normalizeApprovedEnvironmentKeys(value){
  const source=Array.isArray(value)?value:typeof value==="string"?value.split(/[\s,]+/):[];
  return [...new Set(source.map(keyName).filter(validName))].slice(0,100);
}

export function runtimeEnvironmentKeys(kind,{approved=[]}={}){
  return [...new Set([...BASELINE_KEYS,...(RUNTIME_KEYS[String(kind||"").toLowerCase()]||[]),...normalizeApprovedEnvironmentKeys(approved)])];
}

function parentValue(parent,name,{caseInsensitive=false}={}){
  if(Object.prototype.hasOwnProperty.call(parent,name))return parent[name];
  if(!caseInsensitive)return undefined;
  const lower=name.toLowerCase(),found=Object.keys(parent).find(key=>key.toLowerCase()===lower);
  return found==null?undefined:parent[found];
}

export function buildRuntimeEnvironment(kind,{parent={},approved=[],overrides={},platform=process.platform}={}){
  const env={},caseInsensitive=platform==="win32";
  for(const name of runtimeEnvironmentKeys(kind,{approved})){
    const value=parentValue(parent,name,{caseInsensitive});
    if(value!=null&&String(value)!=="")env[name]=String(value);
  }
  for(const [name,value] of Object.entries(overrides||{})){
    if(!validName(name)||value==null)continue;
    env[name]=String(value);
  }
  return env;
}
