import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";

function readJson(path){try{return JSON.parse(readFileSync(path,"utf8"))}catch{return null}}

export class RemoteAccessSecretStore{
  constructor(env=process.env){
    this.path=join(trebellHome(env),"remote-access-secret.json");this.uiStatePath=join(trebellHome(env),"ui-state.json");mkdirSync(dirname(this.path),{recursive:true});
  }
  getToken(){return String(readJson(this.path)?.token||"").trim()}
  setToken(value){
    const token=String(value||"").trim(),tmp=this.path+".tmp";
    writeFileSync(tmp,JSON.stringify({version:1,token},null,2),{encoding:"utf8",mode:0o600});renameSync(tmp,this.path);return token;
  }
  migrateLegacyUiState(){
    if(!existsSync(this.uiStatePath))return {migrated:false,removed:false};
    const parsed=readJson(this.uiStatePath),settings=parsed?.settings;
    if(!settings||typeof settings!=="object"||!Object.prototype.hasOwnProperty.call(settings,"remoteAccessToken"))return {migrated:false,removed:false};
    const legacy=String(settings.remoteAccessToken||"").trim();let migrated=false;
    if(legacy&&!this.getToken()){this.setToken(legacy);migrated=true}
    delete settings.remoteAccessToken;
    const tmp=this.uiStatePath+".tmp";writeFileSync(tmp,JSON.stringify(parsed,null,2),{encoding:"utf8",mode:0o600});renameSync(tmp,this.uiStatePath);
    return {migrated,removed:true};
  }
}
