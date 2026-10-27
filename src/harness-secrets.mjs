import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";

// The keys a harness signs in with that Trebell keeps for the person (Antigravity's Gemini API key), by name, in one owner-only file
// beside provider-secrets.json: mode 0600, written whole to a temporary file that is renamed over it, and read again where a launch
// needs a key, so a key saved in another Trebell window is the one the next launch uses. A key is never written to settings.json, a
// snapshot or a log, and never sent back to a page: Settings hears only whether one is saved.
export function harnessSecretsPath(env=process.env){return join(trebellHome(env),"harness-secrets.json")}

function readSecrets(env){
  try{const value=JSON.parse(readFileSync(harnessSecretsPath(env),"utf8"));return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}
  catch{return {}}
}

export function harnessSecret(name,{env=process.env}={}){
  const value=readSecrets(env)[name];
  return typeof value==="string"&&value?value:null;
}

// value null (or empty) removes the key.
export function saveHarnessSecret(name,value,{env=process.env}={}){
  const path=harnessSecretsPath(env),secrets=readSecrets(env);
  if(value)secrets[name]=String(value);else delete secrets[name];
  mkdirSync(dirname(path),{recursive:true});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{writeFileSync(temporary,JSON.stringify(secrets,null,2),{encoding:"utf8",mode:0o600});renameSync(temporary,path)}
  catch(error){try{rmSync(temporary,{force:true})}catch{}throw error}
}
