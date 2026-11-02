import { MODEL_PROVIDERS, providerErrorMessage } from "./provider-manager.mjs";

// A Trebell Native turn that a model provider refused ends with the provider manager's "<provider> HTTP <status>: <body>", whose
// body is whatever the provider sent: often JSON (a relay's Cloudflare page, Meta's {"error":{...}}). People read it in plain
// words instead: what happened, the provider's own reason (the message its body gives, never the body), and what to do next.
// Any other text is left as it is.
const NAMES=Object.values(MODEL_PROVIDERS).map(provider=>provider.name);

function happened(name,status){
  if(status===401)return [`${name} refused the API key`,"Check the key in Settings, Agents & models."];
  if(status===402)return [`${name} refused the request because of the account's balance or plan`,""];
  if(status===429)return [`${name} is limiting requests right now`,"Try again in a minute."];
  if(status===408||status>=500)return [`${name} cannot be reached right now`,"Try again in a few minutes."];
  return [`${name} refused the request`,""];
}

// What a Native turn says while its provider has not answered a request for a while (the relay's providerWaits).
export function providerWaitNotice(providerId){
  const id=String(providerId||"");
  return `Still waiting for ${Object.hasOwn(MODEL_PROVIDERS,id)?MODEL_PROVIDERS[id].name:"the model provider"} to answer.`;
}

export function plainProviderFailure(message){
  const text=String(message??""),name=NAMES.find(item=>text.startsWith(item+" HTTP "));
  const match=name?/^ HTTP (\d{3}): ?([\s\S]*)$/.exec(text.slice(name.length)):null;
  if(!match)return text;
  const status=Number(match[1]),reason=providerErrorMessage(match[2],{maxChars:600}),[lead,next]=happened(name,status);
  return `${lead} (HTTP ${status})${reason?": "+(/[.!?]$/.test(reason)?reason:reason+"."):"."}${next?" "+next:""}`;
}
