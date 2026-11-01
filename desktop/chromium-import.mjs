import { createDecipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

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

// A profile's cookie store: the "Cookies" SQLite file Chromium keeps in the profile, read the way Chromium writes it on Windows.

// Chromium counts time from 1601-01-01 UTC (the Windows FILETIME epoch), Unix from 1970-01-01 UTC: 11,644,473,600 s apart.
const SECONDS_1601_TO_1970=-Date.UTC(1601,0,1)/1000;
// Electron's names for Chromium's same-site codes 0, 1 and 2; Chromium's -1 and anything else are "unspecified".
const SAME_SITE_NAMES=Object.freeze(["no_restriction","lax","strict"]);
// A "v10" value is AES-256-GCM under the profile key: the prefix, a 12-byte nonce, the ciphertext, a 16-byte tag.
const V10_PREFIX=Buffer.from("v10","latin1"),V10_NONCE_BYTES=12,V10_TAG_BYTES=16,PROFILE_KEY_BYTES=32;
// From this database version, a value's plaintext starts with the SHA-256 digest of its host_key, binding it to that host.
const HOST_BOUND_SINCE_VERSION=24;
const MAX_COOKIE_ROWS=10_000,MAX_SKIPPED_HOSTS_LISTED=20;

// Seconds since 1601 (Chromium's expiry, already divided down from microseconds) as Unix seconds; undefined when not after 1970.
export function webkitExpirySeconds(secondsSince1601){
  const unixSeconds=Number(secondsSince1601)-SECONDS_1601_TO_1970;
  return unixSeconds>0?unixSeconds:undefined;
}

export function windowsChromiumSameSite(code){
  return SAME_SITE_NAMES[Number(code)]??"unspecified";
}

// The plaintext of a v10 value, or null when the bytes are not one, are cut short, or do not authenticate under the key.
function openV10Value(sealed,key){
  if(!Buffer.isBuffer(key)||key.length!==PROFILE_KEY_BYTES)return null;
  if(!sealed.subarray(0,V10_PREFIX.length).equals(V10_PREFIX))return null;
  const nonceEnd=V10_PREFIX.length+V10_NONCE_BYTES,tagStart=sealed.length-V10_TAG_BYTES;
  if(tagStart<nonceEnd)return null;
  try{
    const decipher=createDecipheriv("aes-256-gcm",key,sealed.subarray(V10_PREFIX.length,nonceEnd),{authTagLength:V10_TAG_BYTES});
    decipher.setAuthTag(sealed.subarray(tagStart));
    return Buffer.concat([decipher.update(sealed.subarray(nonceEnd,tagStart)),decipher.final()]);
  }catch{
    return null;
  }
}

// The plaintext after the digest of the host it is bound to, or null when it does not start with that digest.
function afterHostDigest(plaintext,host){
  const digest=createHash("sha256").update(String(host)).digest();
  const lead=plaintext.subarray(0,digest.length);
  return lead.length===digest.length&&lead.equals(digest)?plaintext.subarray(digest.length):null;
}

function readSealedValue(sealed,key,host,hostBound){
  const opened=openV10Value(sealed,key);
  const clear=opened&&hostBound?afterHostDigest(opened,host):opened;
  return clear?clear.toString("utf8"):null;
}

// A cookie's encrypted_value as text: "" when there is none, null when it cannot be read with this key for this host.
export function decryptWindowsChromiumValue(encrypted,key,domain,schemaVersion=23){
  const sealed=Buffer.from(encrypted||[]);
  return sealed.length?readSealedValue(sealed,key,domain,Number(schemaVersion)>=HOST_BOUND_SINCE_VERSION):"";
}

// Copies the store, and its write-ahead log and shared-memory files when present, into a new private folder, so the browser's
// own files are never opened and changes it has not yet folded into the main file are still read.
function copyCookieStore(database){
  const folder=mkdtempSync(join(tmpdir(),"trebell-chromium-"));
  const removeCopy=()=>rmSync(folder,{recursive:true,force:true});
  const copy=join(folder,"Cookies");
  try{
    copyFileSync(database,copy);
    for(const companion of ["-wal","-shm"].filter(suffix=>existsSync(database+suffix)))copyFileSync(database+companion,copy+companion);
  }catch(error){
    removeCopy();
    throw error;
  }
  return {copy,removeCopy};
}

// The cookie columns this store has. Older stores lack samesite and top_frame_site_key, read as -1 and ''. expires_utc counts
// microseconds (about 1.3e16, past what node:sqlite returns as a number), so SQLite divides it down to seconds.
function cookieColumnsSql(db){
  const present=new Set(db.prepare("PRAGMA table_info(cookies)").all().map(column=>String(column.name)));
  const orDefault=(column,fallback)=>present.has(column)?column:`${fallback} AS ${column}`;
  return [
    "host_key","name","value","encrypted_value","path","is_secure","is_httponly",
    "expires_utc / 1000000 AS expiry_since_1601",orDefault("samesite","-1"),orDefault("top_frame_site_key","''"),
  ].join(", ");
}

async function readCookieStoreRows(copy){
  const {DatabaseSync}=await import("node:sqlite");
  const db=new DatabaseSync(copy,{readOnly:true});
  try{
    const version=Number(db.prepare("SELECT value FROM meta WHERE key = ?").get("version")?.value||0);
    const rows=db.prepare(`SELECT ${cookieColumnsSql(db)} FROM cookies LIMIT ?`).all(MAX_COOKIE_ROWS);
    return {version,rows};
  }finally{
    db.close();
  }
}

const withoutLeadingDot=host=>host.replace(/^\./,"");

// The cookie Electron is given for a row, or null when the row is skipped: a partitioned cookie, or a value that does not decrypt.
function electronCookieFromRow(row,key,version){
  if(String(row.top_frame_site_key||"")!=="")return null;
  const host=String(row.host_key||"");
  const sealed=Buffer.from(row.encrypted_value||[]);
  const value=sealed.length>0?decryptWindowsChromiumValue(sealed,key,host,version):String(row.value||"");
  if(value===null)return null;
  const path=String(row.path||"/"),secure=Number(row.is_secure)===1;
  const cookie={
    url:`${secure?"https":"http"}://${withoutLeadingDot(host)}${path.startsWith("/")?"":"/"}${path}`,
    name:String(row.name||""),value,path,secure,httpOnly:Number(row.is_httponly)===1,sameSite:windowsChromiumSameSite(row.samesite),
  };
  // A domain cookie keeps its dotted host as its domain; a host-only cookie has none, so Electron keeps it host-only.
  if(host.startsWith("."))cookie.domain=host;
  // A session cookie has no expiry, so Electron keeps it a session cookie.
  const expirationDate=webkitExpirySeconds(row.expiry_since_1601);
  if(expirationDate!==undefined)cookie.expirationDate=expirationDate;
  return cookie;
}

// Reads a copy of a profile's cookie store with the profile key: the cookies Electron can set, how many rows were skipped, and
// up to 20 of the hosts they belong to.
export async function readChromiumCookieFile(database,key){
  if(!existsSync(database))throw new Error("Chromium Cookies database was not found for that profile");
  const {copy,removeCopy}=copyCookieStore(database);
  try{
    const {version,rows}=await readCookieStoreRows(copy);
    const cookies=[],skippedHosts=new Set();let skipped=0;
    for(const row of rows){
      const cookie=electronCookieFromRow(row,key,version);
      if(cookie){cookies.push(cookie);continue}
      skipped+=1;skippedHosts.add(withoutLeadingDot(String(row.host_key||"")));
    }
    return {cookies,skipped,skippedHosts:[...skippedHosts].slice(0,MAX_SKIPPED_HOSTS_LISTED)};
  }finally{
    removeCopy();
  }
}

export async function readHeliumProfileCookies(profileDirectory,userDataRoot,options={}){
  const database=chromiumCookieDatabase(profileDirectory);if(!database)throw new Error("Helium Cookies database was not found for that profile");const key=await readWindowsChromiumKey(join(userDataRoot,"Local State"),options);return readChromiumCookieFile(database,key);
}
