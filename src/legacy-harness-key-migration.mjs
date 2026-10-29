import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { trebellHome } from "./paths.mjs";

// Antigravity's own Gemini key form kept the key it was given in <TREBELL_HOME>/harness-secrets.json ("antigravity.geminiApiKey").
// Trebell now keeps one key per provider, in Native's store (provider-secrets.json), and a harness runs on its vendor's key only when
// the person sets it to an API key. So, once, at start: a key saved for Antigravity moves into the Google Gemini slot when that slot
// has no key of its own (else the slot's key is kept), its entry goes (and the file with it, which holds nothing else), and
// Antigravity's profile starts on its API key, so a setup that worked keeps working. The key is never logged or answered.
export const LEGACY_HARNESS_SECRETS_FILE="harness-secrets.json";
const ANTIGRAVITY_ENTRY="antigravity.geminiApiKey";

export function migrateHarnessSecrets({env=process.env,providers,state}={}){
  const path=join(trebellHome(env),LEGACY_HARNESS_SECRETS_FILE);
  let secrets;
  try{secrets=JSON.parse(readFileSync(path,"utf8"))}catch(error){if(error?.code==="ENOENT")return {migrated:false};secrets={}}
  if(!secrets||typeof secrets!=="object"||Array.isArray(secrets))secrets={};
  const key=typeof secrets[ANTIGRAVITY_ENTRY]==="string"?secrets[ANTIGRAVITY_ENTRY].trim():"";
  let moved=false,keptSlot=false;
  if(key){
    if(providers?.keyFor?.("gemini")?.source==="settings")keptSlot=true;
    else{providers.setKey("gemini",key);moved=true}
    const settings=state.settings(),list=Array.isArray(settings.agentRuntimeInstances)?[...settings.agentRuntimeInstances]:[];
    const index=list.findIndex(item=>item?.id==="antigravity-default");
    const item={...(index>=0?list[index]:{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{}}),auth:"api-key"};
    if(index>=0)list[index]=item;else list.push(item);
    state.updateSettings({agentRuntimeInstances:list});
  }
  delete secrets[ANTIGRAVITY_ENTRY];
  if(!Object.keys(secrets).length)rmSync(path,{force:true});
  else{const temporary=`${path}.${randomUUID()}.tmp`;writeFileSync(temporary,JSON.stringify(secrets,null,2),{encoding:"utf8",mode:0o600});renameSync(temporary,path)}
  return {migrated:true,moved,keptSlot,antigravityOnApiKey:Boolean(key)};
}
