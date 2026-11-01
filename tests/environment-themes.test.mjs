import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostThemeReader, localThemeReader, publishedThemeFromText, readThemeFolder, THEME_FOLDER_LIMITS } from "../src/environment-themes.mjs";
import { EnvironmentManager } from "../src/environment-manager.mjs";

const KIB=1024;
// A theme file's text of exactly bytes bytes (ASCII), padded in a field the app does not read.
function themeText(bytes,fields={}){
  const base=JSON.stringify({...fields,canvas:fields.canvas||"#10151f",pad:""});
  assert.ok(bytes>=base.length,"theme too small for its fields");
  return base.replace('"pad":""','"pad":"'+"x".repeat(bytes-base.length)+'"');
}
async function withFolder(run){
  const folder=await mkdtemp(join(tmpdir(),"trebell-env-themes-"));
  try{return await run(folder)}finally{await rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
}

test("an environment's theme folder publishes, in name order, the .json files whose names the app can keep, but none named like a built-in",async()=>{
  await withFolder(async folder=>{
    const files={
      "b-theme.json":{name:"Bee"},"A-theme.JSON":{name:"Ay"},"Dark.json":{name:"Hides the built-in"},"SYSTEM.json":{name:"Hides a mode"},"midnight.json":{},
      "not allowed.json":{},["x".repeat(81)+".json"]:{},["y".repeat(80)+".json"]:{name:"Longest id"},"_lead.json":{},"9.lives_ok-1.json":{name:"Digits"},"notes.txt":{},".json":{},
      // Letters outside ASCII are not id letters, even those a case change turns into ASCII ones (the Kelvin sign into "k").
      "Kelvin.json":{},"café.json":{},
    };
    for(const [name,fields] of Object.entries(files))await writeFile(join(folder,name),JSON.stringify({canvas:"#111827",...fields}));
    await writeFile(join(folder,"broken.json"),"{not json");
    await writeFile(join(folder,"no-canvas.json"),JSON.stringify({name:"No canvas",accent:"#8b5cf6"}));
    const themes=await readThemeFolder(localThemeReader(folder));
    assert.deepEqual(themes.map(theme=>theme.id),["9.lives_ok-1","A-theme","b-theme","y".repeat(80)]);
    assert.deepEqual(themes.map(theme=>theme.name),["Digits","Ay","Bee","Longest id"]);
    assert.equal(themes.every(theme=>theme.published===true&&theme.canvas==="#111827"),true);
  });
});

test("a theme folder is read within Trebell's limits: 24 files, 96 KiB each, 512 KiB in all",async()=>{
  assert.deepEqual({...THEME_FOLDER_LIMITS},{files:24,bytesPerFile:96*KIB,bytesInAll:512*KIB});
  await withFolder(async folder=>{
    // One byte over the per-file limit is skipped; exactly the limit is read.
    await writeFile(join(folder,"a-over.json"),themeText(96*KIB+1));
    await writeFile(join(folder,"b-exact.json"),themeText(96*KIB));
    // Four more of 96 KiB make 480 KiB; the next 96 KiB would pass 512 KiB, so reading stops there, small files after it included.
    for(const name of ["c1","c2","c3","c4"])await writeFile(join(folder,name+".json"),themeText(96*KIB));
    await writeFile(join(folder,"d-stops.json"),themeText(96*KIB));
    await writeFile(join(folder,"e-small.json"),themeText(200));
    assert.deepEqual((await readThemeFolder(localThemeReader(folder))).map(theme=>theme.id),["b-exact","c1","c2","c3","c4"]);
  });
  await withFolder(async folder=>{
    for(let index=0;index<30;index++)await writeFile(join(folder,`theme-${String(index).padStart(2,"0")}.json`),themeText(120));
    const themes=await readThemeFolder(localThemeReader(folder));
    assert.equal(themes.length,24);
    assert.equal(themes.at(-1).id,"theme-23");
  });
});

test("a theme folder skips links, folders and other entries that are not plain files",async()=>{
  await withFolder(async folder=>{
    const outside=join(folder,"outside");await mkdir(outside);
    await writeFile(join(outside,"target.json"),themeText(200,{name:"Through a link"}));
    await writeFile(join(folder,"plain.json"),themeText(200,{name:"Plain"}));
    await mkdir(join(folder,"folder.json"));
    // A file link where this machine allows one; a junction (a link to a folder) otherwise.
    let linked=true;
    try{await symlink(join(outside,"target.json"),join(folder,"file-link.json"),"file")}catch{linked=false}
    await symlink(outside,join(folder,"folder-link.json"),process.platform==="win32"?"junction":"dir");
    const themes=await readThemeFolder(localThemeReader(folder));
    assert.deepEqual(themes.map(theme=>theme.name),["Plain"],linked?"file link skipped":"junction skipped");
  });
});

test("a missing theme folder publishes nothing",async()=>{
  assert.deepEqual(await readThemeFolder(localThemeReader(join(tmpdir(),"trebell-no-such-theme-folder-"+process.pid))),[]);
});

test("a host's theme folder is read through argv commands and never measures a name the app cannot keep",async()=>{
  const sizes={"/srv/themes/a.json":"   120 /srv/themes/a.json\n","/srv/themes/B.JSON":"80\t/srv/themes/B.JSON","/srv/themes/grown.json":"100 /srv/themes/grown.json","/srv/themes/gone.json":null,"/srv/themes/odd.json":"total"};
  const bodies={"/srv/themes/a.json":JSON.stringify({name:"Ay",canvas:"#123"}),"/srv/themes/B.JSON":JSON.stringify({colors:{"editor.background":"#1e1e1e"}}),"/srv/themes/grown.json":themeText(96*KIB+1)};
  const calls=[];
  const run=async options=>{
    calls.push([options.command,...options.args]);
    if(options.command==="test")return {exitCode:0,stdout:"",stderr:""};
    if(options.command==="find")return {exitCode:0,stdout:"/srv/themes/z bad.json\n/srv/themes/grown.json\r\n/srv/themes/dark.json\n/srv/themes/B.JSON\n/srv/themes/a.json\n\n/srv/themes/gone.json\n/srv/themes/odd.json\n",stderr:""};
    if(options.command==="wc"){const out=sizes[options.args[1]];return out==null?{exitCode:1,stdout:"",stderr:"wc: No such file"}:{exitCode:0,stdout:out,stderr:""}}
    if(options.command==="cat"){assert.equal(options.maxOutput,96*KIB+1);return {exitCode:0,stdout:bodies[options.args[0]],stderr:""}}
    throw new Error("the host was asked to run "+options.command);
  };
  const themes=await readThemeFolder(hostThemeReader(run,"/srv/themes","Build box"));
  assert.deepEqual(themes.map(theme=>[theme.id,theme.name]),[["B","B"],["a","Ay"]]);
  assert.deepEqual(calls[0],["test","-d","/srv/themes"]);
  assert.deepEqual(calls[1],["find","/srv/themes","-maxdepth","1","-type","f","-name","*.[jJ][sS][oO][nN]"]);
  // Names the app cannot keep (a space, a built-in's) are never measured; a file grown past the limit since wc is skipped.
  assert.deepEqual(calls.slice(2),[["wc","-c","/srv/themes/B.JSON"],["cat","/srv/themes/B.JSON"],["wc","-c","/srv/themes/a.json"],["cat","/srv/themes/a.json"],
    ["wc","-c","/srv/themes/gone.json"],["wc","-c","/srv/themes/grown.json"],["cat","/srv/themes/grown.json"],["wc","-c","/srv/themes/odd.json"]]);
});

test("a host without the theme folder publishes nothing, and a listing the host refuses is an error",async()=>{
  const calls=[];
  assert.deepEqual(await readThemeFolder(hostThemeReader(async options=>{calls.push(options.command);return {exitCode:1,stdout:"",stderr:""}},".trebell/themes","Ubuntu")),[]);
  assert.deepEqual(calls,["test"]);
  const refusing=stderr=>hostThemeReader(async options=>options.command==="test"?{exitCode:0,stdout:"",stderr:""}:{exitCode:1,stdout:"",stderr},"/srv/themes","Build box");
  await assert.rejects(readThemeFolder(refusing("find: '/srv/themes': Permission denied\n")),{message:"find: '/srv/themes': Permission denied"});
  await assert.rejects(readThemeFolder(refusing("")),{message:"Could not list the theme folder on Build box"});
});

test("a theme file is published when it names a hex canvas color, with its own fields, its id and a name",()=>{
  for(const canvas of ["#abc","#ABCD","#a1b2c3","#a1b2c3d4"])assert.equal(publishedThemeFromText("t",JSON.stringify({canvas}))?.canvas,canvas,canvas);
  for(const canvas of ["#abcde","#a1b2c3d","abc","#ggg","",null,7,["#abc"]])assert.equal(publishedThemeFromText("t",JSON.stringify({canvas})),null,JSON.stringify(canvas));
  assert.ok(publishedThemeFromText("t",JSON.stringify({colors:{"editor.background":"#1e1e1e"}})));
  assert.ok(publishedThemeFromText("t",JSON.stringify({colors:{canvas:"#1e1e1e"}})));
  assert.ok(publishedThemeFromText("t",JSON.stringify({colors:{"editor.background":"red",canvas:"#1e1e1e"}})));
  assert.equal(publishedThemeFromText("t",JSON.stringify({colors:["#1e1e1e"]})),null);
  for(const text of ["[]","null","\"#abc\"","{"])assert.equal(publishedThemeFromText("t",text),null,text);
  const theme=publishedThemeFromText("nightfall",JSON.stringify({id:"other",name:"  Nightfall  ",label:"Label",canvas:"#111827",accent:"#8b5cf6",published:false,extra:{kept:true}}));
  assert.deepEqual(theme,{id:"nightfall",name:"Nightfall",label:"Label",canvas:"#111827",accent:"#8b5cf6",published:true,extra:{kept:true}});
  assert.equal(publishedThemeFromText("t",JSON.stringify({label:"From label",canvas:"#000"})).name,"From label");
  assert.equal(publishedThemeFromText("t",JSON.stringify({name:"   ",label:"Not used",canvas:"#000"})).name,"t");
  assert.equal(publishedThemeFromText("t",JSON.stringify({name:"n".repeat(90),canvas:"#000"})).name,"n".repeat(80));
  assert.equal(publishedThemeFromText("plain-id",JSON.stringify({canvas:"#000"})).name,"plain-id");
});

test("an environment's theme catalog reports Trebell's limits and its environment",async()=>{
  const manager=new EnvironmentManager({state:{environments:()=>[{id:"ssh",name:"Build box",type:"ssh",host:"example.invalid",port:22,themeDirectory:"/srv/themes"}]}});
  manager.executeArgv=async()=>({exitCode:1,stdout:"",stderr:""});
  const catalog=await manager.themeCatalog("ssh");
  assert.deepEqual(catalog,{environmentId:"ssh",environmentKey:"ssh",environmentName:"Build box",environmentType:"ssh",directory:"/srv/themes",themes:[],limits:{files:24,bytesPerFile:96*KIB,bytesInAll:512*KIB}});
  await assert.rejects(manager.themeCatalog("missing"),{message:"Environment profile was not found"});
});
