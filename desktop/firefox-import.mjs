import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export function parseFirefoxProfiles(ini,root,{requireCookies=true}={}){
  const profiles=[];let current=null;
  const flush=()=>{
    if(!current?.path){current=null;return}
    const relativePath=current.isRelative===undefined||current.isRelative==="1";
    if(current.isRelative!==undefined&&!/^[01]$/.test(current.isRelative)){current=null;return}
    let directory=null;
    if(relativePath&&!isAbsolute(current.path)){
      const candidate=resolve(root,current.path);const rel=relative(root,candidate);
      if(rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel))directory=candidate;
    }else if(!relativePath&&isAbsolute(current.path))directory=normalize(current.path);
    if(directory&&(!requireCookies||existsSync(join(directory,"cookies.sqlite"))))profiles.push({id:directory,name:String(current.name||directory).trim(),directory});
    current=null;
  };
  for(const raw of String(ini||"").split(/\r?\n/)){
    const line=raw.trim();
    if(line.startsWith("[")){flush();current=/^\[Profile\d+\]$/i.test(line)?{}:null;continue}
    if(!current)continue;
    const index=line.indexOf("=");if(index<0)continue;const key=line.slice(0,index).trim().toLowerCase(),value=line.slice(index+1).trim();
    if(key==="name")current.name=value;else if(key==="path")current.path=value;else if(key==="isrelative")current.isRelative=value;
  }
  flush();return profiles;
}

export function firefoxSameSite(value,rawValue){
  if(value==null)return "unspecified";
  if(value===1&&rawValue===0)return "unspecified";
  if(value===0)return "no_restriction";
  if(value===1)return "lax";
  if(value===2)return "strict";
  return "unspecified";
}

export function firefoxExpirySeconds(expiry,schemaVersion){
  const value=Number(expiry||0);if(!(value>0))return undefined;
  return Number(schemaVersion)>=16?Math.floor(value/1000):value;
}

export async function readFirefoxCookieDatabase(database){
  if(!existsSync(database))throw new Error("Firefox cookies.sqlite was not found for that profile.");
  const temp=mkdtempSync(join(tmpdir(),"trebell-firefox-"));const snapshot=join(temp,"cookies.sqlite");
  try{
    copyFileSync(database,snapshot);
    for(const suffix of ["-wal","-shm"]){const source=database+suffix;if(existsSync(source))copyFileSync(source,snapshot+suffix)}
    const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(snapshot,{readOnly:true});
    try{
      const schemaVersion=Number(db.prepare("pragma user_version").get()?.user_version||0);const hasRaw=schemaVersion>=10&&schemaVersion<=14;
      const query=hasRaw
        ?"select host,name,value,path,expiry,isSecure,isHttpOnly,sameSite,rawSameSite from moz_cookies where originAttributes = ''"
        :"select host,name,value,path,expiry,isSecure,isHttpOnly,sameSite,null as rawSameSite from moz_cookies where originAttributes = ''";
      return db.prepare(query).all().slice(0,10000).map(row=>{
        const host=String(row.host||"");const bare=host.replace(/^\./,"");const pathValue=String(row.path||"/");const secure=Number(row.isSecure)===1;const expirationDate=firefoxExpirySeconds(row.expiry,schemaVersion);
        return {
          url:`${secure?"https":"http"}://${bare}${pathValue.startsWith("/")?pathValue:"/"+pathValue}`,
          name:String(row.name||""),value:String(row.value||""),...(host.startsWith(".")?{domain:host}:{}),path:pathValue,secure,
          httpOnly:Number(row.isHttpOnly)===1,sameSite:firefoxSameSite(row.sameSite,row.rawSameSite),...(expirationDate?{expirationDate}:{})
        };
      });
    }finally{db.close()}
  }finally{rmSync(temp,{recursive:true,force:true})}
}
