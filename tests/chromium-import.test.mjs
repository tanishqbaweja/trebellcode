import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decryptWindowsChromiumValue,
  discoverHeliumProfiles,
  readChromiumCookieFile,
  readWindowsChromiumKey,
  webkitExpirySeconds,
  windowsChromiumSameSite,
  windowsDpapiUnprotect,
} from "../desktop/chromium-import.mjs";

// A cookie value as Chromium seals it on Windows: "v10", a 12-byte nonce, the AES-256-GCM ciphertext and its 16-byte tag. From
// database version 24 the sealed text starts with the SHA-256 digest of the cookie's host.
function sealV10Value(key,host,text,{schemaVersion=24,nonce=Buffer.alloc(12,7)}={}){
  const pieces=schemaVersion>=24?[createHash("sha256").update(host).digest(),Buffer.from(text,"utf8")]:[Buffer.from(text,"utf8")];
  const aes=createCipheriv("aes-256-gcm",key,nonce,{authTagLength:16});
  const body=aes.update(Buffer.concat(pieces));aes.final();
  return Buffer.concat([Buffer.from("v10","latin1"),nonce,body,aes.getAuthTag()]);
}

async function dpapiProtect(data){
  const script=String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TrebellDpapiProtect {
  [StructLayout(LayoutKind.Sequential)] public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CryptProtectData(ref DATA_BLOB input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB output);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LocalFree(IntPtr memory);
  public static byte[] Protect(byte[] clear) {
    DATA_BLOB input=new DATA_BLOB(), output=new DATA_BLOB();
    input.cbData=clear.Length; input.pbData=Marshal.AllocHGlobal(clear.Length); Marshal.Copy(clear,0,input.pbData,clear.Length);
    try {
      if(!CryptProtectData(ref input,"Trebell test",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,ref output)) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] encrypted=new byte[output.cbData]; Marshal.Copy(output.pbData,encrypted,0,output.cbData); return encrypted;
    } finally {
      if(input.pbData!=IntPtr.Zero) Marshal.FreeHGlobal(input.pbData);
      if(output.pbData!=IntPtr.Zero) LocalFree(output.pbData);
    }
  }
}
'@
$bytes=[Convert]::FromBase64String($env:TREBELL_DPAPI_PLAIN)
$encrypted=[TrebellDpapiProtect]::Protect($bytes)
[Convert]::ToBase64String($encrypted)
`;
  const encoded=Buffer.from(script,"utf16le").toString("base64");
  return await new Promise((resolve,reject)=>execFile("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand",encoded],{windowsHide:true,timeout:10000,env:{...process.env,TREBELL_DPAPI_PLAIN:Buffer.from(data).toString("base64")}},(error,stdout,stderr)=>{
    if(error){reject(new Error(String(stderr||error.message||error).trim()));return}
    resolve(Buffer.from(String(stdout||"").trim(),"base64"));
  }));
}

test("Helium profile discovery trusts only safe Local State profile directories with cookie jars",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-helium-profiles-"));
  try{
    await mkdir(join(root,"Default","Network"),{recursive:true});
    await writeFile(join(root,"Default","Network","Cookies"),"");
    await mkdir(join(root,"Profile 1"),{recursive:true});
    await writeFile(join(root,"Local State"),JSON.stringify({profile:{info_cache:{Default:{name:"Personal"},"../escape":{name:"Bad"},"Profile 1":{name:"Empty"}}}}));
    const profiles=discoverHeliumProfiles(root);
    assert.deepEqual(profiles.map(item=>[item.profileDirectory,item.name]),[["Default","Personal"]]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Helium Local State DPAPI key prefix is validated before unprotecting",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-helium-key-"));
  try{
    const wrapped=Buffer.from("encrypted-master-key");
    await writeFile(join(root,"Local State"),JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from("DPAPI"),wrapped]).toString("base64")}}));
    let received=null;const expected=Buffer.alloc(32,9);
    const key=await readWindowsChromiumKey(join(root,"Local State"),{unprotect:async data=>{received=Buffer.from(data);return expected}});
    assert.deepEqual(received,wrapped);assert.deepEqual(key,expected);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Windows DPAPI unprotect round-trips under the current user",{skip:process.platform!=="win32"},async()=>{
  const plain=Buffer.alloc(32,11);const encrypted=await dpapiProtect(plain);const clear=await windowsDpapiUnprotect(encrypted);assert.deepEqual(clear,plain);
});

test("App-Bound Chromium profiles are rejected before DPAPI unwrapping",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-helium-appbound-"));
  try{
    const wrapped=Buffer.concat([Buffer.from("DPAPI"),Buffer.from("legacy-key")]).toString("base64");
    await writeFile(join(root,"Local State"),JSON.stringify({os_crypt:{encrypted_key:wrapped,app_bound_encrypted_key:"present"}}));
    let called=false;
    await assert.rejects(()=>readWindowsChromiumKey(join(root,"Local State"),{unprotect:async()=>{called=true;return Buffer.alloc(32)}}),/App-Bound Encryption/i);
    assert.equal(called,false);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Windows Chromium v10 AES-GCM cookie decryption enforces schema-24 domain binding",()=>{
  const key=Buffer.alloc(32,3),domain=".example.com";
  const encrypted=sealV10Value(key,domain,"cookie-value");
  assert.equal(decryptWindowsChromiumValue(encrypted,key,domain,24),"cookie-value");
  assert.equal(decryptWindowsChromiumValue(encrypted,key,".wrong.example",24),null);
  assert.equal(decryptWindowsChromiumValue(Buffer.concat([Buffer.from("v20"),encrypted.subarray(3)]),key,domain,24),null);
});

test("Chromium cookie reader imports legacy Helium v10 and skips partitioned and app-bound records",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-helium-db-"));const database=join(root,"Cookies");const key=Buffer.alloc(32,5);
  try{
    const db=new DatabaseSync(database);
    db.exec("create table meta(key text primary key,value text); insert into meta values('version','24'); create table cookies(host_key text,name text,value text,encrypted_value blob,path text,expires_utc integer,is_secure integer,is_httponly integer,samesite integer,top_frame_site_key text);");
    const insert=db.prepare("insert into cookies values(?,?,?,?,?,?,?,?,?,?)");
    insert.run(".example.com","sid","",sealV10Value(key,".example.com","secret"),"/",0,1,1,1,"");
    insert.run("framed-site.example","part","",sealV10Value(key,"framed-site.example","partitioned"),"/",0,1,0,0,"https://top.example");
    insert.run("appbound.example","v20","",Buffer.concat([Buffer.from("v20"),Buffer.alloc(40,4)]),"/",0,1,0,0,"");
    db.close();
    const result=await readChromiumCookieFile(database,key);
    assert.equal(result.cookies.length,1);assert.equal(result.skipped,2);
    assert.deepEqual(result.cookies[0],{url:"https://example.com/",name:"sid",value:"secret",domain:".example.com",path:"/",secure:true,httpOnly:true,sameSite:"lax"});
    assert.deepEqual(new Set(result.skippedHosts),new Set(["framed-site.example","appbound.example"]));
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// The reader's own temporary folders (test folders below use other names).
const readerCopies=()=>readdirSync(tmpdir()).filter(name=>name.startsWith("trebell-chromium-"));
const COOKIE_COLUMNS="host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,top_frame_site_key";
function createCookieStore(database,{version="24",journal=null}={}){
  const db=new DatabaseSync(database);
  if(journal)db.exec(journal);
  db.exec(`create table meta(key text primary key,value text); insert into meta values('version','${version}'); create table cookies(host_key text not null,name text not null,value text not null,encrypted_value blob,path text not null,expires_utc integer not null,is_secure integer not null,is_httponly integer not null,samesite integer not null default -1,top_frame_site_key text not null default '');`);
  return {db,insert:db.prepare(`insert into cookies(${COOKIE_COLUMNS}) values(?,?,?,?,?,?,?,?,?,?)`)};
}

test("WebKit expiry seconds become Unix seconds, and nothing when not after 1970",()=>{
  assert.equal(-Date.UTC(1601,0,1)/1000,11_644_473_600);
  const unix=Date.UTC(2030,0,1)/1000;
  assert.equal(webkitExpirySeconds(unix+11_644_473_600),unix);
  assert.equal(webkitExpirySeconds(String(unix+11_644_473_600)),unix);
  for(const value of [0,-5,null,undefined,"","soon",1000,11_644_473_600])assert.equal(webkitExpirySeconds(value),undefined,String(value));
});

test("Chromium same-site codes map to Electron's names",()=>{
  assert.deepEqual([0,1,2,-1,3,"2",1.5,undefined,"lax"].map(value=>windowsChromiumSameSite(value)),
    ["no_restriction","lax","strict","unspecified","unspecified","strict","unspecified","unspecified","unspecified"]);
});

test("Chromium v10 values read empty, unbound before version 24, and not at all when cut short, changed or under another key",()=>{
  const key=Buffer.alloc(32,8),host="app.example";
  assert.equal(decryptWindowsChromiumValue(Buffer.alloc(0),key,host,24),"");
  assert.equal(decryptWindowsChromiumValue(null,key,host,24),"");
  const unbound=sealV10Value(key,host,"plain-value",{schemaVersion:23});
  assert.equal(decryptWindowsChromiumValue(unbound,key,host,23),"plain-value");
  assert.equal(decryptWindowsChromiumValue(unbound,key,host),"plain-value");
  const bound=sealV10Value(key,host,"bound-value");
  assert.equal(decryptWindowsChromiumValue(bound,key,host,"24"),"bound-value");
  assert.equal(decryptWindowsChromiumValue(bound,key,host,23).endsWith("bound-value"),true);
  assert.equal(decryptWindowsChromiumValue(bound,Buffer.alloc(16,8),host,24),null);
  assert.equal(decryptWindowsChromiumValue(bound,Buffer.alloc(32,9),host,24),null);
  assert.equal(decryptWindowsChromiumValue(bound,new Uint8Array(32).fill(8),host,24),null);
  const changed=Buffer.from(bound);changed[changed.length-1]^=1;
  assert.equal(decryptWindowsChromiumValue(changed,key,host,24),null);
  assert.equal(decryptWindowsChromiumValue(bound.subarray(0,30),key,host,24),null);
  const empty=sealV10Value(key,host,"",{schemaVersion:23});
  assert.equal(empty.length,31);
  assert.equal(decryptWindowsChromiumValue(empty,key,host,23),"");
  assert.equal(decryptWindowsChromiumValue(empty,key,host,24),null);
});

test("Chromium cookie reader gives Electron host-only, plain and expiring cookies, and leaves no copy behind",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cookie-store-shape-"));const database=join(root,"Cookies");const key=Buffer.alloc(32,6);
  const copiesBefore=readerCopies();
  try{
    const {db,insert}=createCookieStore(database);
    const expiresUnix=Date.UTC(2031,5,1)/1000;
    // expires_utc counts microseconds since 1601, past 2^53, as Chromium stores it.
    insert.run("app.example","plain","visible",Buffer.alloc(0),"account",(BigInt(expiresUnix)+11_644_473_600n)*1_000_000n,0,0,-1,"");
    insert.run(".example.org","bound","",sealV10Value(key,".example.org","hidden"),"/",0,1,0,2,"");
    insert.run("blank-path.example","nopath","x",null,"",0,0,1,0,"");
    db.close();
    const result=await readChromiumCookieFile(database,key);
    assert.equal(result.skipped,0);assert.deepEqual(result.skippedHosts,[]);
    assert.deepEqual(result.cookies,[
      {url:"http://app.example/account",name:"plain",value:"visible",path:"account",secure:false,httpOnly:false,sameSite:"unspecified",expirationDate:expiresUnix},
      {url:"https://example.org/",name:"bound",value:"hidden",domain:".example.org",path:"/",secure:true,httpOnly:false,sameSite:"strict"},
      {url:"http://blank-path.example/",name:"nopath",value:"x",path:"/",secure:false,httpOnly:true,sameSite:"no_restriction"},
    ]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  assert.deepEqual(readerCopies().filter(name=>!copiesBefore.includes(name)),[]);
});

test("Chromium cookie reader reads stores older than the same-site and partition columns, without host binding",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cookie-store-old-"));const database=join(root,"Cookies");const key=Buffer.alloc(32,4);
  try{
    const db=new DatabaseSync(database);
    db.exec("create table meta(key text primary key,value text); insert into meta values('version','12'); create table cookies(host_key text,name text,value text,encrypted_value blob,path text,expires_utc integer,is_secure integer,is_httponly integer);");
    db.prepare("insert into cookies values(?,?,?,?,?,?,?,?)").run(".old.example","legacy","",sealV10Value(key,".old.example","from-2019",{schemaVersion:12}),"/",0,1,1);
    db.close();
    const result=await readChromiumCookieFile(database,key);
    assert.equal(result.skipped,0);
    assert.deepEqual(result.cookies,[{url:"https://old.example/",name:"legacy",value:"from-2019",domain:".old.example",path:"/",secure:true,httpOnly:true,sameSite:"unspecified"}]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Chromium cookie reader reads a write-ahead log the browser has not folded into the store yet",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cookie-store-wal-"));const database=join(root,"Cookies");const key=Buffer.alloc(32,2);
  const {db,insert}=createCookieStore(database,{journal:"pragma journal_mode=wal; pragma wal_autocheckpoint=0;"});
  try{
    insert.run(".wal.example","pending","",sealV10Value(key,".wal.example","only-in-the-log"),"/",0,1,0,1,"");
    assert.equal(existsSync(database+"-wal"),true);
    const result=await readChromiumCookieFile(database,key);
    assert.deepEqual(result.cookies.map(cookie=>[cookie.name,cookie.value]),[["pending","only-in-the-log"]]);
  }finally{db.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Chromium cookie reader rejects a missing store and a file that is not one, leaving no copy behind",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cookie-store-bad-"));const key=Buffer.alloc(32,1);
  const copiesBefore=readerCopies();
  try{
    await assert.rejects(()=>readChromiumCookieFile(join(root,"Cookies"),key),/Chromium Cookies database was not found for that profile/);
    await writeFile(join(root,"Cookies"),"this is plain text and not a SQLite database at all, so it cannot be read as one");
    await assert.rejects(()=>readChromiumCookieFile(join(root,"Cookies"),key));
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  assert.deepEqual(readerCopies().filter(name=>!copiesBefore.includes(name)),[]);
});

test("Chromium cookie reader counts every skipped cookie, names 20 hosts once each, and reads at most 10,000 rows",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cookie-store-many-"));const database=join(root,"Cookies");const key=Buffer.alloc(32,3);
  try{
    const {db,insert}=createCookieStore(database);
    db.exec("begin");
    for(let index=0;index<25;index++)insert.run(`.site${index}.example`,"partitioned","",Buffer.alloc(0),"/",0,1,0,0,"https://top.example");
    insert.run("site0.example","undecryptable","",Buffer.concat([Buffer.from("v20"),Buffer.alloc(40,4)]),"/",0,1,0,0,"");
    for(let index=0;index<10_000;index++)insert.run("bulk.example",`c${index}`,"v",Buffer.alloc(0),"/",0,0,0,1,"");
    db.exec("commit");db.close();
    const result=await readChromiumCookieFile(database,key);
    assert.equal(result.skipped,26);
    assert.equal(result.skippedHosts.length,20);
    assert.deepEqual(result.skippedHosts.slice(0,3),["site0.example","site1.example","site2.example"]);
    assert.equal(new Set(result.skippedHosts).size,20);
    assert.equal(result.cookies.length,10_000-26);
    assert.equal(result.cookies.at(-1).name,`c${10_000-26-1}`);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
