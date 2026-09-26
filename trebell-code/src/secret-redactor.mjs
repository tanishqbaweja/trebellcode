import { homedir } from "node:os";

const PAIRING_URL_PATTERN=/https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const URL_USERINFO_PATTERN=/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi;
const BEARER_TOKEN_PATTERN=/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const BASIC_AUTH_PATTERN=/\bAuthorization:\s*Basic\s+\S+/gi;
const API_KEY_HEADER_PATTERN=/\bx-api-key:\s*\S+/gi;
const SECRET_TOKEN_PATTERN=/\b(?:sk-[A-Za-z0-9][A-Za-z0-9-]{7,}|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;
const SECRET_ASSIGNMENT_PATTERN=/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret|credential)\b\s*(?:=|:)\s*)[^\s,;]+/gi;
const SECRET_FLAG_PATTERN=/(--(?:api-key|token|password|secret|credential)\s+)[^\s]+/gi;
const SECRET_ENV_KEY=/(?:^|_)(?:api_?key|token|secret|password|credential|authorization|cookie)(?:$|_)/i;
const SENSITIVE_KEYS=new Set([
  "authorization","apikey","xapikey","cookie","password","secret","accesstoken","refreshtoken","authtoken",
  "bearertoken","credential","credentials","proof","challenge","privatekey","clientsecret",
]);
const SECRET_FLAGS=new Set(["--api-key","--token","--password","--secret","--credential"]);

function normalizedKey(value){return String(value||"").replace(/[^a-z0-9]/gi,"").toLowerCase()}
export function isSecretEnvironmentName(value){return SECRET_ENV_KEY.test(String(value||""))}
export function isSecretCliFlag(value){return SECRET_FLAGS.has(String(value||"").trim().toLowerCase())}
export function isSecretCliArgument(value){return /^--(?:api-key|token|password|secret|credential)(?:=|$)/i.test(String(value||"").trim())}
export function withoutSecretEnvironment(value={}){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([key])=>!isSecretEnvironmentName(key)));
}
function exactEnvironmentSecrets(environment={}){
  const values=[];
  for(const [key,value] of Object.entries(environment||{})){
    const secret=typeof value==="string"?value:"";
    if(isSecretEnvironmentName(key)&&secret.length>=6)values.push(secret);
  }
  return [...new Set(values)].sort((a,b)=>b.length-a.length);
}

export function redactSecretText(text,{environment=process.env,redactHomes=false,trim=false}={}){
  let result=String(text??"").replaceAll("\0","");
  if(redactHomes){
    const homes=[environment?.HOME,environment?.USERPROFILE,homedir()].filter(value=>typeof value==="string"&&value.length>1);
    for(const home of new Set(homes))result=result.split(home).join("~");
  }
  for(const secret of exactEnvironmentSecrets(environment))result=result.split(secret).join("[redacted]");
  result=result
    .replace(PAIRING_URL_PATTERN,"[pairing-url]")
    .replace(URL_USERINFO_PATTERN,"$1[redacted]@")
    .replace(BEARER_TOKEN_PATTERN,"Bearer [redacted]")
    .replace(BASIC_AUTH_PATTERN,"Authorization: Basic [redacted]")
    .replace(API_KEY_HEADER_PATTERN,"x-api-key: [redacted]")
    .replace(SECRET_TOKEN_PATTERN,"[redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN,"$1[redacted]")
    .replace(SECRET_FLAG_PATTERN,"$1[redacted]");
  return trim?result.trim():result;
}

export function redactSecretValue(value,{environment=process.env,maxDepth=10,maxArray=100,maxFields=200}={},depth=0){
  if(depth>maxDepth)return "[bounded]";
  if(typeof value==="string")return redactSecretText(value,{environment});
  if(value==null||typeof value==="number"||typeof value==="boolean")return value;
  if(Array.isArray(value))return value.slice(0,maxArray).map((item,index,array)=>{
    if(index>0&&isSecretCliFlag(array[index-1]))return "[redacted]";
    return redactSecretValue(item,{environment,maxDepth,maxArray,maxFields},depth+1);
  });
  if(typeof value!=="object")return redactSecretText(String(value),{environment});
  const out={};
  for(const [key,item] of Object.entries(value).slice(0,maxFields)){
    if(SENSITIVE_KEYS.has(normalizedKey(key))){out[key]="[redacted]";continue}
    out[key]=redactSecretValue(item,{environment,maxDepth,maxArray,maxFields},depth+1);
  }
  return out;
}
