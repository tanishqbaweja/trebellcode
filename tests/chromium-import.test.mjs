import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decryptWindowsChromiumValue,
  discoverHeliumProfiles,
  readChromiumCookieDatabase,
  readWindowsChromiumKey,
  windowsDpapiUnprotect,
} from "../desktop/chromium-import.mjs";

function encryptV10(key,domain,value,{schemaVersion=24,nonce=Buffer.alloc(12,7)}={}){
  const clear=Buffer.from(value,"utf8");
  const plaintext=schemaVersion>=24?Buffer.concat([createHash("sha256").update(domain).digest(),clear]):clear;
  const cipher=createCipheriv("aes-256-gcm",key,nonce);
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return Buffer.concat([Buffer.from("v10"),nonce,encrypted,cipher.getAuthTag()]);
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
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Helium Local State DPAPI key prefix is validated before unprotecting",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-helium-key-"));
  try{
    const wrapped=Buffer.from("encrypted-master-key");
    await writeFile(join(root,"Local State"),JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from("DPAPI"),wrapped]).toString("base64")}}));
    let received=null;const expected=Buffer.alloc(32,9);
    const key=await readWindowsChromiumKey(join(root,"Local State"),{unprotect:async data=>{received=Buffer.from(data);return expected}});
    assert.deepEqual(received,wrapped);assert.deepEqual(key,expected);
  }finally{await rm(root,{recursive:true,force:true})}
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
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Windows Chromium v10 AES-GCM cookie decryption enforces schema-24 domain binding",()=>{
  const key=Buffer.alloc(32,3),domain=".example.com";
  const encrypted=encryptV10(key,domain,"cookie-value");
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
    insert.run(".example.com","sid","",encryptV10(key,".example.com","secret"),"/",0,1,1,1,"");
    insert.run("partitioned.example","part","",encryptV10(key,"partitioned.example","partitioned"),"/",0,1,0,0,"https://top.example");
    insert.run("appbound.example","v20","",Buffer.concat([Buffer.from("v20"),Buffer.alloc(40,4)]),"/",0,1,0,0,"");
    db.close();
    const result=await readChromiumCookieDatabase(database,key);
    assert.equal(result.cookies.length,1);assert.equal(result.skipped,2);
    assert.deepEqual(result.cookies[0],{url:"https://example.com/",name:"sid",value:"secret",domain:".example.com",path:"/",secure:true,httpOnly:true,sameSite:"lax"});
    assert.deepEqual(new Set(result.skippedHosts),new Set(["partitioned.example","appbound.example"]));
  }finally{await rm(root,{recursive:true,force:true})}
});
