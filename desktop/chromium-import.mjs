import { createDecipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

const WEBKIT_EPOCH_OFFSET_SECONDS=11_644_473_600;

function safeProfileName(value){const text=String(value||"");return Boolean(text)&&text!=="."&&text!==".."&&!text.includes("/")&&!text.includes("\\")&&!text.includes(sep)}

export function chromiumCookieDatabase(profileDirectory){
  for(const path of [join(profileDirectory,"Network","Cookies"),join(profileDirectory,"Cookies")]){
    try{if(existsSync(path)&&statSync(path).isFile())return path}catch{}
  }
  return null;
}

export function discoverHeliumProfiles(root){
  if(!root||!existsSync(root))return [];
  const declared=new Map();
  try{
    const state=JSON.parse(readFileSync(join(root,"Local State"),"utf8"));
    for(const [directory,info] of Object.entries(state?.profile?.info_cache||{}))if(safeProfileName(directory))declared.set(directory,String(info?.name||directory).trim()||directory);
  }catch{}
  if(!declared.size){
    try{for(const directory of readdirSync(root))if(safeProfileName(directory)&&(directory==="Default"||/^Profile \d+$/i.test(directory)))declared.set(directory,directory)}catch{}
  }
  const profiles=[];
  for(const [directory,name] of declared){const absolute=join(root,directory);if(chromiumCookieDatabase(absolute))profiles.push({id:absolute,name,directory:absolute,profileDirectory:directory})}
  return profiles;
}

export function windowsChromiumSameSite(value){if(Number(value)===0)return "no_restriction";if(Number(value)===1)return "lax";if(Number(value)===2)return "strict";return "unspecified"}
export function webkitExpirySeconds(value){const seconds=Number(value||0);if(!(seconds>0))return undefined;const unix=seconds-WEBKIT_EPOCH_OFFSET_SECONDS;return unix>0?unix:undefined}

export function decryptWindowsChromiumValue(encrypted,key,domain,schemaVersion=23){
  const buffer=Buffer.from(encrypted||[]);if(!buffer.length)return "";
  if(buffer.subarray(0,3).toString("latin1")!=="v10")return null;
  const payload=buffer.subarray(3);if(payload.length<28||!Buffer.isBuffer(key)||key.length!==32)return null;
  try{
    const nonce=payload.subarray(0,12),ciphertext=payload.subarray(12,-16),tag=payload.subarray(-16);const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAuthTag(tag);
    let plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    if(Number(schemaVersion)>=24){const expected=createHash("sha256").update(String(domain)).digest();if(plaintext.length<32||!plaintext.subarray(0,32).equals(expected))return null;plaintext=plaintext.subarray(32)}
    return plaintext.toString("utf8");
  }catch{return null}
}

export async function windowsDpapiUnprotect(data,{execFileImpl=execFile}={}){
  if(process.platform!=="win32")throw new Error("Windows DPAPI is available only on Windows");
  const script=String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TrebellDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CryptUnprotectData(ref DATA_BLOB input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB output);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LocalFree(IntPtr memory);
  public static byte[] Unprotect(byte[] encrypted) {
    DATA_BLOB input=new DATA_BLOB(), output=new DATA_BLOB();
    input.cbData=encrypted.Length; input.pbData=Marshal.AllocHGlobal(encrypted.Length); Marshal.Copy(encrypted,0,input.pbData,encrypted.Length);
    try {
      if(!CryptUnprotectData(ref input,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,ref output)) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] clear=new byte[output.cbData]; Marshal.Copy(output.pbData,clear,0,output.cbData); return clear;
    } finally {
      if(input.pbData!=IntPtr.Zero) Marshal.FreeHGlobal(input.pbData);
      if(output.pbData!=IntPtr.Zero) LocalFree(output.pbData);
    }
  }
}
'@
$bytes=[Convert]::FromBase64String($env:TREBELL_DPAPI_INPUT)
$plain=[TrebellDpapi]::Unprotect($bytes)
[Convert]::ToBase64String($plain)
`;
  return await new Promise((resolve,reject)=>execFileImpl("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",script],{windowsHide:true,timeout:10000,env:{...process.env,TREBELL_DPAPI_INPUT:Buffer.from(data).toString("base64")}},(error,stdout,stderr)=>{
    if(error){reject(new Error(String(stderr||error.message||error).trim()));return}
    try{resolve(Buffer.from(String(stdout||"").trim(),"base64"))}catch(cause){reject(cause)}
  }));
}

export async function readWindowsChromiumKey(localStatePath,{unprotect=windowsDpapiUnprotect}={}){
  const parsed=JSON.parse(readFileSync(localStatePath,"utf8"));
  if(parsed?.os_crypt?.app_bound_encrypted_key)throw new Error("This Chromium profile uses App-Bound Encryption and cannot be imported safely");
  const encoded=parsed?.os_crypt?.encrypted_key;if(!encoded)throw new Error("Helium Local State does not contain an encrypted cookie key");
  const wrapped=Buffer.from(String(encoded),"base64");if(wrapped.subarray(0,5).toString("ascii")!=="DPAPI")throw new Error("Helium cookie key is not DPAPI-backed");
  const key=Buffer.from(await unprotect(wrapped.subarray(5)));if(key.length!==32)throw new Error("Helium cookie key has an unexpected length");return key;
}

export async function readChromiumCookieDatabase(database,key){
  if(!existsSync(database))throw new Error("Chromium Cookies database was not found for that profile");
  const temp=mkdtempSync(join(tmpdir(),"trebell-chromium-"));const snapshot=join(temp,"Cookies");
  try{
    copyFileSync(database,snapshot);for(const suffix of ["-wal","-shm"]){const source=database+suffix;if(existsSync(source))copyFileSync(source,snapshot+suffix)}
    const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(snapshot,{readOnly:true});
    try{
      const schemaVersion=Number(db.prepare("select value from meta where key = 'version' limit 1").get()?.value||0);const columns=new Set(db.prepare("pragma table_info(cookies)").all().map(row=>String(row.name)));
      const topFrame=columns.has("top_frame_site_key")?"top_frame_site_key":"'' as top_frame_site_key";const sameSite=columns.has("samesite")?"samesite":"-1 as samesite";
      const rows=db.prepare(`select host_key,name,value,encrypted_value,path,expires_utc / 1000000 as expires_seconds,is_secure,is_httponly,${sameSite},${topFrame} from cookies`).all().slice(0,10000);
      const cookies=[];let skipped=0;const skippedHosts=new Set();
      for(const row of rows){
        const host=String(row.host_key||"");if(String(row.top_frame_site_key||"")!==""){skipped++;skippedHosts.add(host.replace(/^\./,""));continue}
        const encrypted=Buffer.from(row.encrypted_value||[]);const value=encrypted.length?decryptWindowsChromiumValue(encrypted,key,host,schemaVersion):String(row.value||"");
        if(value==null){skipped++;skippedHosts.add(host.replace(/^\./,""));continue}
        const bare=host.replace(/^\./,"");const pathValue=String(row.path||"/");const secure=Number(row.is_secure)===1;const expirationDate=webkitExpirySeconds(row.expires_seconds);
        cookies.push({url:`${secure?"https":"http"}://${bare}${pathValue.startsWith("/")?pathValue:"/"+pathValue}`,name:String(row.name||""),value,...(host.startsWith(".")?{domain:host}:{}),path:pathValue,secure,httpOnly:Number(row.is_httponly)===1,sameSite:windowsChromiumSameSite(row.samesite),...(expirationDate?{expirationDate}:{})});
      }
      return {cookies,skipped,skippedHosts:[...skippedHosts].slice(0,20)};
    }finally{db.close()}
  }finally{rmSync(temp,{recursive:true,force:true})}
}

export async function readHeliumProfileCookies(profileDirectory,userDataRoot,options={}){
  const database=chromiumCookieDatabase(profileDirectory);if(!database)throw new Error("Helium Cookies database was not found for that profile");const key=await readWindowsChromiumKey(join(userDataRoot,"Local State"),options);return readChromiumCookieDatabase(database,key);
}
