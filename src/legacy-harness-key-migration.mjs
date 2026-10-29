import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { trebellHome } from "./paths.mjs";

// Antigravity's own Gemini key form kept the key it was given in <TREBELL_HOME>/harness-secrets.json ("antigravity.geminiApiKey").
// Trebell now keeps one key per provider, in Native's store (provider-secrets.json), and a harness runs on its vendor's key only when
// the person sets it to an API key. So, once, at start: a key saved for Antigravity moves into the Google Gemini slot when that slot
// has no key saved of its own (else the slot's key is kept), its entry goes (and the file with it, which holds nothing else), and
// Antigravity's profile starts on its API key, so a setup that worked keeps working. The key is never logged or answered.
// What the person would not see happen is said once, on Antigravity's row in Settings (antigravityKeyNote, the status of Antigravity
// on its key, until the Gemini key or Antigravity's method next changes): the moved key now standing in for the environment variable
// Native read its Gemini key from, or a different key of the old form not kept because the slot had one saved.
export const LEGACY_HARNESS_SECRETS_FILE="harness-secrets.json";
const ANTIGRAVITY_ENTRY="antigravity.geminiApiKey";
export const ANTIGRAVITY_KEY_NOT_KEPT="The other key Antigravity's old key form held was not kept: one Google Gemini API key serves Trebell Native and Antigravity, and the one saved in Trebell Code stays.";
export function antigravityKeyReplacedVariable(variable){
  return `The key Antigravity's old key form held is now the Google Gemini API key saved in Trebell Code, which Trebell Native also uses now in place of ${variable}. Remove it in Trebell Native's Model provider card to go back to ${variable}.`;
}

export function migrateHarnessSecrets({env=process.env,providers,state}={}){
  const path=join(trebellHome(env),LEGACY_HARNESS_SECRETS_FILE);
  let secrets;
  // A file it cannot read or parse now (another program holding it, a write cut short) is left as it is, for the next start to try
  // again: a key in it is never removed unread.
  try{secrets=JSON.parse(readFileSync(path,"utf8"))}catch(error){return error?.code==="ENOENT"?{migrated:false}:{migrated:false,unreadable:true}}
  if(!secrets||typeof secrets!=="object"||Array.isArray(secrets))secrets={};
  const key=typeof secrets[ANTIGRAVITY_ENTRY]==="string"?secrets[ANTIGRAVITY_ENTRY].trim():"";
  let moved=false,keptSlot=false,note=null;
  if(key){
    let slot=null;try{slot=providers?.keyFor?.("gemini")||null}catch{slot=null}
    if(slot?.source==="settings"){keptSlot=true;if(slot.key!==key)note=ANTIGRAVITY_KEY_NOT_KEPT}
    else{providers.setKey("gemini",key);moved=true;if(slot?.source==="environment"&&slot.key!==key)note=antigravityKeyReplacedVariable(slot.variable||"GEMINI_API_KEY")}
    const settings=state.settings(),list=Array.isArray(settings.agentRuntimeInstances)?[...settings.agentRuntimeInstances]:[];
    const index=list.findIndex(item=>item?.id==="antigravity-default");
    const item={...(index>=0?list[index]:{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{}}),auth:"api-key"};
    if(index>=0)list[index]=item;else list.push(item);
    state.updateSettings({agentRuntimeInstances:list,...(note?{antigravityKeyNote:note}:{})});
  }
  delete secrets[ANTIGRAVITY_ENTRY];
  if(!Object.keys(secrets).length)rmSync(path,{force:true});
  else{const temporary=`${path}.${randomUUID()}.tmp`;writeFileSync(temporary,JSON.stringify(secrets,null,2),{encoding:"utf8",mode:0o600});renameSync(temporary,path)}
  return {migrated:true,moved,keptSlot,antigravityOnApiKey:Boolean(key),...(note?{note}:{})};
}
