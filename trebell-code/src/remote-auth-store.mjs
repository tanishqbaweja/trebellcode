import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { DEFAULT_REMOTE_SCOPES, normalizeRemoteScopes } from "./remote-scopes.mjs";

function clone(value){return JSON.parse(JSON.stringify(value))}
function token(prefix){return `${prefix}_${randomBytes(32).toString("base64url")}`}
function digest(value){return createHash("sha256").update(String(value||"")).digest("hex")}
function sameDigest(left,right){
  const a=Buffer.from(String(left||""),"hex"),b=Buffer.from(String(right||""),"hex");
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}

export class RemoteAuthStore{
  constructor(env=process.env){
    this.path=join(trebellHome(env),"remote-auth.json");mkdirSync(dirname(this.path),{recursive:true});this.data=this.#load();
  }
  #load(){try{
    const parsed=JSON.parse(readFileSync(this.path,"utf8"));
    const pairings=(Array.isArray(parsed.pairings)?parsed.pairings:[]).map(item=>({...item,scopes:normalizeRemoteScopes(item.scopes)}));
    const devices=(Array.isArray(parsed.devices)?parsed.devices:[]).map(item=>({...item,scopes:normalizeRemoteScopes(item.scopes)}));
    return {version:2,pairings,devices};
  }catch{return {version:2,pairings:[],devices:[]}}}
  #save(){const tmp=this.path+".tmp";writeFileSync(tmp,JSON.stringify(this.data,null,2),{encoding:"utf8",mode:0o600});renameSync(tmp,this.path)}
  #purge(){const now=Date.now();this.data.pairings=this.data.pairings.filter(item=>!item.usedAt&&item.expiresAt>now);}
  createPairing({ttlMs=10*60_000,scopes=DEFAULT_REMOTE_SCOPES}={}){
    this.#purge();const raw=token("pair");const item={id:randomBytes(8).toString("hex"),tokenHash:digest(raw),createdAt:Date.now(),expiresAt:Date.now()+Math.max(60_000,Math.min(60*60_000,Number(ttlMs)||10*60_000)),usedAt:null,scopes:normalizeRemoteScopes(scopes)};
    this.data.pairings.push(item);this.#save();return {id:item.id,token:raw,createdAt:item.createdAt,expiresAt:item.expiresAt,scopes:clone(item.scopes)};
  }
  exchangePairing(raw,{name="Remote device",userAgent=""}={}){
    this.#purge();const hash=digest(raw);const grant=this.data.pairings.find(item=>sameDigest(item.tokenHash,hash));
    if(!grant)throw new Error("Pairing link is invalid or expired");
    grant.usedAt=Date.now();const sessionToken=token("device");const device={id:randomBytes(10).toString("hex"),name:String(name||"Remote device").trim().slice(0,120)||"Remote device",tokenHash:digest(sessionToken),createdAt:Date.now(),lastSeenAt:Date.now(),userAgent:String(userAgent||"").slice(0,300),scopes:normalizeRemoteScopes(grant.scopes)};
    this.data.devices.push(device);this.#save();return {token:sessionToken,device:this.#publicDevice(device)};
  }
  authenticate(raw){
    const hash=digest(raw);const device=this.data.devices.find(item=>sameDigest(item.tokenHash,hash));if(!device)return null;
    const now=Date.now();if(now-Number(device.lastSeenAt||0)>30_000){device.lastSeenAt=now;this.#save()}
    return this.#publicDevice(device);
  }
  #publicDevice(device){const {tokenHash,...safe}=device;return clone(safe)}
  listDevices(){return this.data.devices.map(device=>this.#publicDevice(device)).sort((a,b)=>(b.lastSeenAt||0)-(a.lastSeenAt||0))}
  revokeDevice(id){const before=this.data.devices.length;this.data.devices=this.data.devices.filter(item=>item.id!==id);if(this.data.devices.length!==before)this.#save();return before!==this.data.devices.length}
  revokeAll(){const count=this.data.devices.length;this.data.devices=[];this.#save();return count}
}
