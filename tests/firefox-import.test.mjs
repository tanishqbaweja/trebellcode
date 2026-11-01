import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

async function firefoxFolder(prefix,profiles){
  const root=await mkdtemp(join(tmpdir(),prefix));
  for(const [relativePath,withCookies] of Object.entries(profiles)){
    const folder=join(root,...relativePath.split("/"));await mkdir(folder,{recursive:true});
    if(withCookies)await writeFile(join(folder,"cookies.sqlite"),"");
  }
  return root;
}
const removeFolder=root=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});

test("Firefox profile parser reads [ProfileN] sections and keys in any letter case and skips every other section",async()=>{
  const root=await firefoxFolder("trebell-firefox-sections-",{"Profiles/work":false,"Profiles/second":false,"Profiles/install":false,"Profiles/plain":false,"Profiles/stray":false});
  try{
    const ini=["﻿[profile0]","  NAME = Work  ","isrelative=1","PATH=Profiles/work","","[General]","StartWithLastProfile=1","Version=2",
      "[PROFILE12]","Name=Second","Path = Profiles/second ","[Install308046B0AF4A39CB]","Default=Profiles/install","Path=Profiles/install",
      "[Profile]","Path=Profiles/plain","[Profile0 ]","Path=Profiles/plain","[Profile0] note","Path=Profiles/plain","[BackgroundTasksProfiles]",
      "Path=Profiles/plain","[Profile1"," Path=Profiles/plain","[Profile12","Path=Profiles/plain","[Profile1x","Path=Profiles/plain"].join("\r\n");
    const profiles=parseFirefoxProfiles("Name=Stray\nPath=Profiles/stray\n"+ini,root,{requireCookies:false});
    const work=join(root,"Profiles","work"),second=join(root,"Profiles","second");
    assert.deepEqual(profiles,[{id:work,name:"Work",directory:work},{id:second,name:"Second",directory:second}]);
  }finally{await removeFolder(root)}
});

test("Firefox profile parser takes IsRelative 1 or missing as relative, 0 as a full path, and drops any other value",async()=>{
  const root=await firefoxFolder("trebell-firefox-relative-",{"Profiles/a":false,"elsewhere/full":false});
  try{
    const full=join(root,"elsewhere","full"),relative=join(root,"Profiles","a"),written=full.replace(/\\/g,"/");
    const ini=`[Profile0]\nName=Missing\nPath=Profiles/a\n[Profile1]\nName=Zero with a relative path\nIsRelative=0\nPath=Profiles/a\n`+
      `[Profile2]\nName=One with a full path\nIsRelative=1\nPath=${written}\n[Profile3]\nName=Two\nIsRelative=2\nPath=Profiles/a\n`+
      `[Profile4]\nName=Word\nIsRelative=true\nPath=Profiles/a\n[Profile5]\nName=Empty\nIsRelative=\nPath=Profiles/a\n`+
      `[Profile6]\nName=Padded number\nIsRelative=01\nPath=Profiles/a\n[Profile7]\nName=Full\nIsRelative=0\nPath=${written}  \n`+
      `[Profile8]\nName=Spaced one\nIsRelative = 1 \nPath=Profiles/a\n[Profile9]\nName=No path\nIsRelative=1\n[Profile10]\nName=Empty path\nPath=\n`;
    const profiles=parseFirefoxProfiles(ini,root,{requireCookies:false});
    assert.deepEqual(profiles.map(profile=>profile.name),["Missing","Full","Spaced one"]);
    assert.deepEqual(profiles.map(profile=>profile.directory),[relative,full,relative]);
  }finally{await removeFolder(root)}
});

test("Firefox profile parser keeps relative profiles inside the Firefox folder",async()=>{
  const root=await firefoxFolder("trebell-firefox-inside-",{"Profiles/a":false,"..dots":false});
  try{
    const ini="[Profile0]\nName=Back in\nPath=Profiles/../Profiles/a\n[Profile1]\nName=Out\nPath=Profiles/../../a\n[Profile2]\nName=Parent\nPath=..\n"+
      "[Profile3]\nName=Dots\nPath=..dots\n[Profile4]\nName=Folder itself\nPath=.\n";
    const profiles=parseFirefoxProfiles(ini,root,{requireCookies:false});
    assert.deepEqual(profiles.map(profile=>[profile.name,profile.directory]),[["Back in",join(root,"Profiles","a")],["Dots",join(root,"..dots")],["Folder itself",root]]);
    // On Windows a drive-relative Path ("Z:profile") lands on another drive, outside the Firefox folder; elsewhere it is a plain name.
    const drive=root[0].toUpperCase()==="Z"?"Y":"Z";
    const onDrive=parseFirefoxProfiles(`[Profile0]\nName=Drive\nPath=${drive}:profile\n`,root,{requireCookies:false});
    assert.deepEqual(onDrive.map(profile=>profile.directory),process.platform==="win32"?[]:[join(root,`${drive}:profile`)]);
  }finally{await removeFolder(root)}
});

test("Firefox profile parser lists only profiles with cookies.sqlite unless cookies are not required",async()=>{
  const root=await firefoxFolder("trebell-firefox-cookies-",{"Profiles/with":true,"Profiles/without":false});
  try{
    const ini="[Profile0]\nName=Without\nPath=Profiles/without\n[Profile1]\nName=With\nPath=Profiles/with\n";
    assert.deepEqual(parseFirefoxProfiles(ini,root).map(profile=>profile.name),["With"]);
    assert.deepEqual(parseFirefoxProfiles(ini,root,{requireCookies:undefined}).map(profile=>profile.name),["With"]);
    assert.deepEqual(parseFirefoxProfiles(ini,root,{requireCookies:false}).map(profile=>profile.name),["Without","With"]);
    for(const off of [null,0,""])assert.deepEqual(parseFirefoxProfiles(ini,root,{requireCookies:off}).map(profile=>profile.name),["Without","With"]);
  }finally{await removeFolder(root)}
});

test("Firefox profile parser names a profile by its folder without a Name, lets the last repeated key count and keeps file order",async()=>{
  const root=await firefoxFolder("trebell-firefox-names-",{"Profiles/a":false,"Profiles/b":false,"Profiles/c":false,"Profiles/d":false});
  try{
    const ini="[Profile5]\nPath=Profiles/a\n[Profile1]\nName=\nPath=Profiles/b\n[Profile0]\nName=Old\n;Name=Comment\n# a note\nName=New\nPath=Profiles/x\nPath=Profiles/c\n"+
      "[Profile2]\nName=a=b\nPath=Profiles/d\n";
    const profiles=parseFirefoxProfiles(ini,root,{requireCookies:false});
    const folder=name=>join(root,"Profiles",name);
    assert.deepEqual(profiles.map(profile=>[profile.id,profile.name]),[[folder("a"),folder("a")],[folder("b"),folder("b")],[folder("c"),"New"],[folder("d"),"a=b"]]);
    // A full path whose folder ends in a space: the name is that path without the space, the folder keeps it.
    const spaced=parseFirefoxProfiles(`[Profile0]\nIsRelative=0\nPath=${root.replace(/\\/g,"/")}/spaced /x/..\n`,root,{requireCookies:false});
    assert.deepEqual(spaced,[{id:join(root,"spaced "),name:join(root,"spaced"),directory:join(root,"spaced ")}]);
  }finally{await removeFolder(root)}
});

test("Firefox profile parser returns no profiles for empty text",()=>{
  for(const text of ["",undefined,null,"\r\n\r\n"])assert.deepEqual(parseFirefoxProfiles(text,tmpdir(),{requireCookies:false}),[]);
});


// ---- Cookies

// A cookies.sqlite in folder whose moz_cookies has the columns Firefox gives it at that schema version: those every version from 7
// on has, plus baseDomain up to 10, sameSite from 9, rawSameSite from 10 to 14, schemeMap from 12, isPartitionedAttributeSet
// from 13 and updateTime from 17. Each row is an object keyed by column; a row without originAttributes is a normal window's.
// With wal, the store runs in WAL mode with automatic checkpoints off and the open connection is returned, so the rows stay in
// the write-ahead log until the test closes it.
function cookieStore(folder,version,rows,{wal=false}={}){
  const file=join(folder,"cookies.sqlite"),db=new DatabaseSync(file);
  if(wal)db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  const columns=["id INTEGER PRIMARY KEY","originAttributes TEXT NOT NULL DEFAULT ''","name TEXT","value TEXT","host TEXT","path TEXT",
    "expiry INTEGER","lastAccessed INTEGER","creationTime INTEGER","isSecure INTEGER","isHttpOnly INTEGER","inBrowserElement INTEGER DEFAULT 0"];
  const versioned=[[0,10,"baseDomain TEXT"],[9,Infinity,"sameSite INTEGER DEFAULT 0"],[10,14,"rawSameSite INTEGER DEFAULT 0"],
    [12,Infinity,"schemeMap INTEGER DEFAULT 0"],[13,Infinity,"isPartitionedAttributeSet INTEGER DEFAULT 0"],[17,Infinity,"updateTime INTEGER"]];
  for(const [first,last,column] of versioned)if(version>=first&&version<=last)columns.push(column);
  db.exec(`PRAGMA user_version = ${version}; CREATE TABLE moz_cookies (${columns.join(", ")}, CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))`);
  const statements=new Map();
  db.exec("BEGIN");
  for(const row of rows){
    const keys=Object.keys(row).join(", ");
    if(!statements.has(keys))statements.set(keys,db.prepare(`INSERT INTO moz_cookies (${keys}) VALUES (${Object.keys(row).map(()=>"?").join(", ")})`));
    statements.get(keys).run(...Object.values(row));
  }
  db.exec("COMMIT");
  if(wal)return {file,db};
  db.close();
  return {file};
}

test("Firefox SameSite values become Electron's names, and a Lax that only Firefox's default gave stays unspecified",()=>{
  const cases=[[0,null,"no_restriction"],[1,0,"unspecified"],[1,1,"lax"],[2,null,"strict"],[1,null,"lax"],[0,0,"no_restriction"],[2,2,"strict"],
    [256,null,"unspecified"],[null,null,"unspecified"],[undefined,undefined,"unspecified"],[3,null,"unspecified"],["1",null,"unspecified"]];
  for(const [sameSite,rawSameSite,expected] of cases)assert.equal(firefoxSameSite(sameSite,rawSameSite),expected,`${sameSite} with ${rawSameSite}`);
});

test("Firefox expiry becomes whole seconds: milliseconds from schema 16, seconds before it, none when unset",()=>{
  assert.equal(firefoxExpirySeconds(1_800_000_000_000,16),1_800_000_000);
  assert.equal(firefoxExpirySeconds(1_800_000_000_999,17),1_800_000_000);
  assert.equal(firefoxExpirySeconds(1_800_000_000,15),1_800_000_000);
  assert.equal(firefoxExpirySeconds(1_800_000_000,undefined),1_800_000_000);
  for(const unset of [0,null,undefined,-1,"soon",NaN])assert.equal(firefoxExpirySeconds(unset,16),undefined,String(unset));
});

test("Firefox cookie reader turns a current store's normal-window cookies into Electron cookies and leaves the others out",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-firefox-store-"));
  try{
    const session={host:".example.com",name:"sid",value:"abc",path:"/",expiry:1_800_000_000_000,isSecure:1,isHttpOnly:1,sameSite:1};
    const {file}=cookieStore(folder,17,[
      session,
      {host:"app.example.org",name:"theme",value:"dark",path:"/settings",expiry:1_700_000_000_500,isSecure:0,isHttpOnly:0,sameSite:256},
      {host:"strict.example",name:"csrf",value:"",path:"",expiry:0,isSecure:1,isHttpOnly:0,sameSite:2},
      {host:".none.example",name:"ad",value:"1",path:"shop",expiry:1_800_000_000_000,isSecure:1,isHttpOnly:0,sameSite:0},
      ...["^userContextId=1","^privateBrowsingId=1","^firstPartyDomain=example.net","^partitionKey=%28https%2Cexample.net%29"]
        .map(originAttributes=>({...session,originAttributes}))
    ]);
    assert.deepEqual(await readFirefoxCookieDatabase(file),[
      {url:"https://example.com/",name:"sid",value:"abc",domain:".example.com",path:"/",secure:true,httpOnly:true,sameSite:"lax",expirationDate:1_800_000_000},
      {url:"http://app.example.org/settings",name:"theme",value:"dark",path:"/settings",secure:false,httpOnly:false,sameSite:"unspecified",expirationDate:1_700_000_000},
      {url:"https://strict.example/",name:"csrf",value:"",path:"/",secure:true,httpOnly:false,sameSite:"strict"},
      {url:"https://none.example/shop",name:"ad",value:"1",domain:".none.example",path:"shop",secure:true,httpOnly:false,sameSite:"no_restriction",expirationDate:1_800_000_000}
    ]);
  }finally{await removeFolder(folder)}
});

test("Firefox cookie reader reads rawSameSite and seconds from a schema 14 store, and SameSite as unspecified before schema 9",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-firefox-store-"));
  try{
    const cookie=(name,sameSite,rawSameSite)=>({host:".shop.example",name,value:"1",path:"/",expiry:1_800_000_000,isSecure:1,isHttpOnly:0,sameSite,rawSameSite});
    const {file}=cookieStore(folder,14,[cookie("lax-by-default",1,0),cookie("lax",1,1),cookie("none",0,0),cookie("strict",2,2)]);
    const read=await readFirefoxCookieDatabase(file);
    assert.deepEqual(read.map(({name,sameSite,expirationDate})=>[name,sameSite,expirationDate]),
      [["lax-by-default","unspecified",1_800_000_000],["lax","lax",1_800_000_000],["none","no_restriction",1_800_000_000],["strict","strict",1_800_000_000]]);
    const older=join(folder,"older");await mkdir(older);
    const old=cookieStore(older,8,[{host:"old.example",name:"kept",value:"1",path:"/",expiry:1_600_000_000,isSecure:0,isHttpOnly:1}]);
    assert.deepEqual(await readFirefoxCookieDatabase(old.file),
      [{url:"http://old.example/",name:"kept",value:"1",path:"/",secure:false,httpOnly:true,sameSite:"unspecified",expirationDate:1_600_000_000}]);
  }finally{await removeFolder(folder)}
});

test("Firefox cookie reader takes in changes still in the write-ahead log and leaves the profile's files as they were",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-firefox-store-"));
  const {file,db}=cookieStore(folder,17,[{host:".wal.example",name:"fresh",value:"1",path:"/",expiry:1_800_000_000_000,isSecure:1,isHttpOnly:1,sameSite:1}],{wal:true});
  const contents=async()=>{
    const names=(await readdir(folder)).sort();
    return {names,store:await readFile(file),log:await readFile(`${file}-wal`)};
  };
  try{
    const before=await contents();
    assert.ok(before.names.includes("cookies.sqlite-wal")&&before.log.length>0);
    assert.deepEqual((await readFirefoxCookieDatabase(file)).map(cookie=>[cookie.url,cookie.name]),[["https://wal.example/","fresh"]]);
    assert.deepEqual(await contents(),before);
  }finally{
    db.close();
    await removeFolder(folder);
  }
});

test("Firefox cookie reader imports at most 10,000 cookies, the first ones in the store's order",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-firefox-store-"));
  try{
    const rows=Array.from({length:10_005},(_,index)=>({host:"many.example",name:`c${index}`,value:"1",path:"/",expiry:1_800_000_000_000,isSecure:0,isHttpOnly:0,sameSite:1}));
    const read=await readFirefoxCookieDatabase(cookieStore(folder,16,rows).file);
    assert.equal(read.length,10_000);
    assert.deepEqual([read[0].name,read.at(-1).name],["c0","c9999"]);
  }finally{await removeFolder(folder)}
});

test("Firefox cookie reader deletes its private copy, and refuses a missing store or one without the columns it needs",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-firefox-store-")),temp=await mkdtemp(join(tmpdir(),"trebell-firefox-temp-"));
  const names=["TEMP","TMP","TMPDIR"],saved=names.map(name=>process.env[name]);
  for(const name of names)process.env[name]=temp;
  try{
    const {file}=cookieStore(folder,17,[{host:"copy.example",name:"a",value:"1",path:"/",expiry:1_800_000_000_000,isSecure:0,isHttpOnly:0,sameSite:0}]);
    assert.equal((await readFirefoxCookieDatabase(file)).length,1);
    assert.deepEqual(await readdir(temp),[]);
    const unreadable=/cookie store is in a format Trebell cannot read/;
    // Schema 5 kept appId and inBrowserElement where later versions keep originAttributes.
    const schema5=join(folder,"schema5.sqlite"),five=new DatabaseSync(schema5);
    five.exec("PRAGMA user_version = 5; CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, baseDomain TEXT, appId INTEGER DEFAULT 0, inBrowserElement INTEGER DEFAULT 0, "+
      "name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER)");
    five.close();
    await assert.rejects(readFirefoxCookieDatabase(schema5),unreadable);
    const empty=join(folder,"empty.sqlite"),blank=new DatabaseSync(empty);
    blank.exec("CREATE TABLE other (id INTEGER)");blank.close();
    await assert.rejects(readFirefoxCookieDatabase(empty),unreadable);
    assert.deepEqual(await readdir(temp),[]);
    await assert.rejects(readFirefoxCookieDatabase(join(folder,"missing.sqlite")),{message:"Firefox cookies.sqlite was not found for that profile."});
  }finally{
    names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index]});
    await removeFolder(folder);await removeFolder(temp);
  }
});
