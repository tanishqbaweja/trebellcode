import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { firefoxExpirySeconds, firefoxSameSite, parseFirefoxProfiles, readFirefoxCookieDatabase } from "../desktop/firefox-import.mjs";

test("Firefox profile parser accepts valid relative profiles and rejects traversal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-firefox-profiles-"));
  try{
    const valid=join(root,"Profiles","good.default");await mkdir(valid,{recursive:true});
    const absolute=join(root,"absolute.profile");await mkdir(absolute,{recursive:true});
    const ini=`[Profile0]\nName=Good\nIsRelative=1\nPath=Profiles/good.default\n\n[Profile1]\nName=Escape\nIsRelative=1\nPath=../outside\n\n[Profile2]\nName=Absolute\nIsRelative=0\nPath=${absolute.replace(/\\/g,"/")}\n`;
    const profiles=parseFirefoxProfiles(ini,root,{requireCookies:false});
    assert.deepEqual(profiles.map(profile=>profile.name),["Good","Absolute"]);
    assert.equal(profiles.some(profile=>profile.name==="Escape"),false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Firefox cookie helpers preserve SameSite and expiry semantics",()=>{
  assert.equal(firefoxSameSite(0,null),"no_restriction");
  assert.equal(firefoxSameSite(1,0),"unspecified");
  assert.equal(firefoxSameSite(1,1),"lax");
  assert.equal(firefoxSameSite(2,null),"strict");
  assert.equal(firefoxExpirySeconds(1_800_000_000_000,16),1_800_000_000);
  assert.equal(firefoxExpirySeconds(1_800_000_000,15),1_800_000_000);
});

test("Firefox cookie reader snapshots SQLite and converts host cookies",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-firefox-db-"));
  const database=join(root,"cookies.sqlite");
  try{
    const db=new DatabaseSync(database);
    db.exec("pragma user_version=16; create table moz_cookies(host text,name text,value text,path text,expiry integer,isSecure integer,isHttpOnly integer,sameSite integer,originAttributes text);");
    db.prepare("insert into moz_cookies values(?,?,?,?,?,?,?,?,?)").run(".example.com","sid","abc","/",1_800_000_000_000,1,1,1,"");
    db.prepare("insert into moz_cookies values(?,?,?,?,?,?,?,?,?)").run("container.example","skip","x","/",1_800_000_000_000,0,0,0,"^userContextId=1");
    db.close();
    const cookies=await readFirefoxCookieDatabase(database);
    assert.equal(cookies.length,1);
    assert.deepEqual(cookies[0],{url:"https://example.com/",name:"sid",value:"abc",domain:".example.com",path:"/",secure:true,httpOnly:true,sameSite:"lax",expirationDate:1_800_000_000});
  }finally{await rm(root,{recursive:true,force:true})}
});
