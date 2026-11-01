import test from "node:test";
import assert from "node:assert/strict";
import { FakeMuse, INIT, fakeChild, fakeStop, settle, until } from "./fixtures/muse/fake-host.mjs";
import { museModelCatalog, museModelEfforts, museModelName, readMuseModelCatalog, resolveMuseReasoningEffort } from "../src/muse-model-catalog.mjs";

// The rules of Muse Code's model list that tests/muse-model-catalog.test.mjs does not reach: which of model/list's rows Trebell
// keeps and what each keeps, names, levels and their descriptions, the level a turn runs at, and the read's host, bounds and
// Muse home. The rows are written here (the fields of Muse 1.4.13's ModelCatalogEntry), not taken from the shared fixture.
const entry=(fields={})=>({modelId:"muse-a",displayLabel:"",providerId:"meta",profileId:null,description:null,contextLimit:null,outputLimit:null,cost:null,releaseDate:null,isActive:false,isDefault:false,variants:["low","high"],defaultReasoningEffort:"high",...fields});
const metaList=(...models)=>({providerId:"meta",profileId:null,source:"providerCatalog",models});
const UNLISTED=["low","medium","high","xhigh","max"];

test("only Meta's catalog is taken: another provider is named, and a blank, missing or non-string one is said to be missing",()=>{
  assert.throws(()=>museModelCatalog({providerId:" openrouter ",models:[]}),{message:"Muse Code listed the models of openrouter, not Meta's."});
  assert.throws(()=>museModelCatalog({providerId:"Meta",models:[]}),{message:"Muse Code listed the models of Meta, not Meta's."},"exactly meta, as Muse routes it");
  for(const result of [{providerId:"  "},{providerId:7},{},null,undefined])assert.throws(()=>museModelCatalog(result),{message:"Muse Code listed models without a provider, not Meta's."},JSON.stringify(result));
  assert.deepEqual(museModelCatalog({providerId:" meta ",models:"none"}),{models:[],metadata:[],preferred:null},"a trimmed provider counts; models that are not a list are none");
});

test("Meta's rows are kept once each by their trimmed id: the first Meta row of an id wins, a foreign row never takes an id, and rows without an id are left out",()=>{
  const catalog=museModelCatalog(metaList(
    null,"muse-x",5,
    entry({modelId:"   "}),entry({modelId:7}),
    entry({modelId:"muse-b",providerId:"local",displayLabel:"Local B"}),
    entry({modelId:" muse-b ",providerId:" meta ",displayLabel:"Meta B"}),
    entry({modelId:"muse-b",displayLabel:"Meta B again"}),
    entry({modelId:"muse-c",providerId:"openrouter"}),
  ));
  assert.deepEqual(catalog.models,["muse-b"]);
  assert.deepEqual([catalog.metadata[0].id,catalog.metadata[0].name],["muse-b","Meta B"]);
  assert.equal(catalog.preferred,null,"no row is the catalog's default");
});

test("a row keeps a trimmed description, a whole context limit above 0, and isDefault only when it is exactly true; the first default row is preferred",()=>{
  const {metadata,preferred}=museModelCatalog(metaList(
    entry({modelId:"muse-a",description:"  Fast and small  ",contextLimit:"131072",isDefault:"true"}),
    entry({modelId:"muse-b",description:"   ",contextLimit:0,isDefault:1}),
    entry({modelId:"muse-c",description:5,contextLimit:1.5,isDefault:true,reasoningEffortVariants:[{tier:"low",description:"Quick"}]}),
    entry({modelId:"muse-d",contextLimit:-4096,isDefault:true}),
    entry({modelId:"muse-e",contextLimit:null}),
  ));
  const [a,b,c,d,e]=metadata;
  assert.deepEqual(a,{id:"muse-a",name:"Muse A",provider:"muse",agent:"Muse Code",description:"Fast and small",contextWindow:131072,reasoningEfforts:["low","high"],defaultReasoningEffort:"high"});
  for(const [row,key] of [[b,"description"],[b,"contextWindow"],[b,"isDefault"],[c,"description"],[c,"contextWindow"],[d,"contextWindow"],[e,"contextWindow"],[a,"isDefault"],[a,"reasoningEffortDescriptions"]])
    assert.equal(Object.hasOwn(row,key),false,`${row.id} has no ${key}`);
  assert.deepEqual([c.isDefault,d.isDefault],[true,true]);
  assert.equal(preferred,"muse-c","the first of two default rows");
  // The key order the model list keeps, which the Settings and composer lists receive as it is.
  assert.deepEqual(Object.keys(a),["id","name","provider","agent","description","contextWindow","reasoningEfforts","defaultReasoningEffort"]);
  assert.deepEqual(Object.keys(c),["id","name","provider","agent","reasoningEfforts","defaultReasoningEffort","reasoningEffortDescriptions","isDefault"]);
});

test("a row's levels: its own list read trimmed and in lower case, once each, without None or words Trebell does not know; the unlisted set, High by default, for 'unknown', a missing or a null list",()=>{
  assert.deepEqual(museModelEfforts({variants:[" High ","LOW","high","none","turbo",3,null,"Ultra"],defaultReasoningEffort:" ULTRA "}),{efforts:["high","low","ultra"],defaultEffort:"ultra",descriptions:{}});
  for(const variants of ["unknown",undefined,null,5])
    assert.deepEqual(museModelEfforts({variants,defaultReasoningEffort:"low"}),{efforts:UNLISTED,defaultEffort:"high",descriptions:{}},String(variants));
  assert.deepEqual(museModelEfforts(null),{efforts:UNLISTED,defaultEffort:"high",descriptions:{}});
  assert.deepEqual(museModelEfforts({variants:["none"],defaultReasoningEffort:"none"}),{efforts:[],defaultEffort:null,descriptions:{}},"a row that offers only None has no level");
  assert.equal(museModelEfforts({variants:["medium","max"],defaultReasoningEffort:"high"}).defaultEffort,"medium","a default the row does not list: its first level");
  assert.equal(museModelEfforts({variants:["medium","max"],defaultReasoningEffort:4}).defaultEffort,"medium");
  assert.equal(museModelEfforts({variants:["medium","max"]}).defaultEffort,"medium");
});

test("Muse's words for a level: trimmed, the first for each level, only for levels the row offers, never blank, in the order Muse gave them",()=>{
  const {descriptions}=museModelEfforts({variants:["low","high"],defaultReasoningEffort:"low",reasoningEffortVariants:[
    {tier:" HIGH ",description:"  Deep  "},{tier:"high",description:"Deeper"},{tier:"low",description:"   "},
    {tier:"max",description:"Not offered"},{tier:"none",description:"Never"},null,{description:"No level"},{tier:"low"},{tier:"low",description:"Quick"},
  ]});
  assert.deepEqual(descriptions,{high:"Deep",low:"Quick"});
  assert.deepEqual(Object.keys(descriptions),["high","low"]);
  assert.deepEqual(museModelEfforts({variants:"unknown",reasoningEffortVariants:[{tier:"max",description:"Longest"}]}).descriptions,{max:"Longest"},"the unlisted set's levels can be described too");
  assert.deepEqual(museModelEfforts({variants:["low"],reasoningEffortVariants:"low"}).descriptions,{});
});

test("a row's name: its trimmed label unless that only repeats the id; Muse's own ids read as words",()=>{
  assert.equal(museModelName(" muse-spark-1.3 ","  Spark  "),"Spark");
  assert.equal(museModelName("muse-spark-1.3"," muse-spark-1.3 "),"Muse Spark 1.3");
  assert.equal(museModelName("muse-a.b-c_d"),"Muse A.B C_d","a word is a run of letters, digits and underscores");
  assert.equal(museModelName("muse-x-2b"),"Muse X 2b","a letter after a digit does not begin a word");
  assert.equal(museModelName("muse-ALPHA-beta"),"Muse ALPHA Beta");
  assert.equal(museModelName("Muse-x"),"Muse-x","only an id that starts with muse- in lower case is Muse's own");
  assert.equal(museModelName("llama-3",""),"llama-3");
  assert.equal(museModelName("muse-x",7),"Muse X","a label that is not a string reads as none");
  assert.equal(museModelName(null,null),"");
  assert.equal(museModelName(42),"");
});

test("a turn's level: the choice read trimmed and in lower case; a listed row whose default it does not list falls to its first level; a choice that is not a string is none",()=>{
  const row={reasoningEfforts:["medium","xhigh"],defaultReasoningEffort:"high"};
  assert.equal(resolveMuseReasoningEffort(row,"  XHIGH "),"xhigh");
  assert.equal(resolveMuseReasoningEffort(row,"max"),"medium");
  assert.equal(resolveMuseReasoningEffort(row,5),null);
  assert.equal(resolveMuseReasoningEffort(row,"   "),null);
  assert.equal(resolveMuseReasoningEffort({reasoningEfforts:"high"},"max"),"max","a row without a level list takes Low to Max");
  assert.equal(resolveMuseReasoningEffort(undefined,"none"),"high","None is never sent");
  assert.equal(resolveMuseReasoningEffort(null," Medium "),"medium");
});

test("the read's host keeps the read-only arguments whatever options it is given, passes the others on, and is closed before the answer",async()=>{
  const child=fakeChild(),muse=new FakeMuse(child,{handlers:{"model/list":()=>metaList(entry({isDefault:true}))}});
  let launch=null;
  const catalog=await readMuseModelCatalog({command:"muse-dev",env:{PATH:"",META_API_KEY:"a-test-key"},cwd:process.cwd(),version:"2.1.0",args:["serve","--allow-everything"],authMethod:"api-key",
    spawnFn:(command,args,options)=>{launch={line:[command,...args].join(" "),key:options.env.META_API_KEY};return child},stopTree:fakeStop});
  assert.equal(launch.line,"muse-dev serve --disable-shell --disable-write --no-session-log");
  assert.equal(launch.key,"a-test-key","an API-key profile's key reaches its read (authMethod passed on)");
  assert.equal(muse.sent("initialize")[0].params.clientInfo.version,"2.1.0");
  assert.equal(child.exitCode,0,"closed before the read answered");
  assert.deepEqual(Object.keys(catalog),["models","metadata","preferred","museHome"]);
  assert.deepEqual([catalog.models,catalog.preferred],[["muse-a"],"muse-a"]);
  const signedIn=fakeChild(),seen=[];
  new FakeMuse(signedIn,{handlers:{"model/list":()=>metaList()}});
  await readMuseModelCatalog({command:"muse",env:{PATH:"",META_API_KEY:"a-test-key"},spawnFn:(command,args,options)=>{seen.push(options.env);return signedIn},stopTree:fakeStop});
  assert.equal(Object.hasOwn(seen[0],"META_API_KEY"),false,"on its sign-in (the default) no Meta key reaches the read");
});

test("museHome is the Muse home initialize names, as Muse wrote it, or null when it names none; a foreign list still closes the host",async()=>{
  for(const [museHome,expected] of [[" ~/.local/share/muse ",' ~/.local/share/muse '],["   ",null],[undefined,null],[42,null]]){
    const child=fakeChild();
    new FakeMuse(child,{handlers:{initialize:()=>({...INIT,museHome}),"model/list":()=>metaList()}});
    const catalog=await readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>child,stopTree:fakeStop});
    assert.equal(catalog.museHome,expected,JSON.stringify(museHome));
    assert.ok(child.exitCode!==null);
  }
  const foreign=fakeChild();
  new FakeMuse(foreign,{handlers:{"model/list":()=>({...metaList(),providerId:"local"})}});
  await assert.rejects(()=>readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>foreign,stopTree:fakeStop}),{message:"Muse Code listed the models of local, not Meta's."});
  assert.ok(foreign.exitCode!==null,"closed before the refusal");
});

test("a read past its bound is closed, and the request it gave up on fails quietly",async()=>{
  const unhandled=[],record=reason=>unhandled.push(reason);
  process.on("unhandledRejection",record);
  try{
    const child=fakeChild(),muse=new FakeMuse(child,{handlers:{"model/list":()=>undefined}});
    await assert.rejects(()=>readMuseModelCatalog({command:"muse",env:{},timeoutMs:50,shutdownTimeoutMs:50,spawnFn:()=>child,stopTree:fakeStop}),{message:"Muse Code did not list its models within 0 seconds."});
    assert.equal(muse.sent("model/list").length,1);
    assert.ok(child.exitCode!==null);
    for(let turn=0;turn<20;turn++)await settle();
    assert.deepEqual(unhandled,[]);
  }finally{process.off("unhandledRejection",record)}
});

test("with no bounds given, a host that does not answer initialize fails the read at 8 s, one that does not list fails it at 12 s in all, and one that does not exit is stopped 2 s after its input closes",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  // Moves the mock clock in steps of 100 ms, letting the hosts' real I/O run between them, until done() or `ms` have passed.
  const advance=async(ms,done)=>{for(let passed=0;passed<ms&&!done();passed+=100){t.mock.timers.tick(100);for(let turn=0;turn<5;turn++)await settle()}};
  const quiet=fakeChild(),quietMuse=new FakeMuse(quiet,{handlers:{initialize:()=>undefined}});
  let startFailure=null;
  const starting=readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>quiet,stopTree:fakeStop}).catch(error=>{startFailure=error});
  await until(()=>quietMuse.sent("initialize").length===1,"initialize");
  await advance(7_900,()=>startFailure);
  assert.equal(startFailure,null,"not before 8 s");
  await advance(3_000,()=>startFailure);
  assert.match(String(startFailure?.message),/^Muse Code did not start: it did not answer within 8 seconds/);
  await starting;
  assert.ok(quiet.exitCode!==null,"the host that did not start is closed");

  const silent=fakeChild(),silentMuse=new FakeMuse(silent,{handlers:{"model/list":()=>undefined}});
  let listFailure=null;
  const listing=readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>silent,stopTree:fakeStop}).catch(error=>{listFailure=error});
  await until(()=>silentMuse.sent("model/list").length===1,"model/list");
  await advance(11_900,()=>listFailure);
  assert.equal(listFailure,null,"not before 12 s");
  await advance(1_000,()=>listFailure);
  assert.equal(listFailure?.message,"Muse Code did not list its models within 12 seconds.");
  await listing;
  assert.ok(silent.exitCode!==null,"the host is closed");

  const stuck=fakeChild(),stuckMuse=new FakeMuse(stuck,{exitOnEof:false,handlers:{"model/list":()=>metaList(entry())}}),stops=[];
  let answered=null;
  const closing=readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>stuck,stopTree:async target=>{stops.push(target.pid);target.exit(1)}}).then(catalog=>{answered=catalog});
  await until(()=>stuckMuse.stdinEnded,"the host's input closed");
  await advance(1_900,()=>stops.length);
  assert.deepEqual(stops,[],"not before 2 s");
  await advance(1_000,()=>answered);
  assert.deepEqual(stops,[4242]);
  await closing;
  assert.deepEqual(answered.models,["muse-a"],"the list read before the close stands");
});
