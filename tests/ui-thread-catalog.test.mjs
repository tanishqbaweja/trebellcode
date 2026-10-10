import test from "node:test";
import assert from "node:assert/strict";
import { catalogMetaPatch, mergeThreadCatalog, missingRuntimeThreadError, openThreadTitleSource, threadCatalogRuntime, threadKeptBySwitch, threadOwnerElsewhere, threadsFromCatalogMeta, threadTitle } from "../ui/src/thread-catalog.js";

test("thread catalog preserves rows from other runtimes when the active runtime reloads",()=>{
  const existing=[
    {id:"codex-1",name:"Codex task",updatedAt:30,trebellRuntime:"codex"},
    {id:"claude-1",name:"Claude task",updatedAt:20,trebellRuntime:"claude"},
  ];
  const merged=mergeThreadCatalog(existing,[{id:"codex-2",name:"New Codex task",updatedAt:40}],{runtime:"codex",provider:"vyceai"});
  assert.deepEqual(merged.map(item=>item.id),["codex-2","codex-1","claude-1"]);
  assert.equal(merged.find(item=>item.id==="codex-2").trebellRuntime,"codex");
  assert.equal(merged.find(item=>item.id==="claude-1").trebellRuntime,"claude");
});

test("provider changes inside the same runtime cannot erase the existing conversation catalog",()=>{
  const existing=[{id:"codex-provider-thread",name:"Keep me",updatedAt:25,trebellRuntime:"codex",trebellProvider:"openai"}];
  const merged=mergeThreadCatalog(existing,[],{runtime:"codex",provider:"vyceai"});
  assert.equal(merged.length,1);assert.equal(merged[0].id,"codex-provider-thread");assert.equal(merged[0].trebellRuntime,"codex");
});

test("hidden or ephemeral runtime rows stay out even when the provider lists them again",()=>{
  const incoming=[{id:"phantom",name:"Phantom",updatedAt:50},{id:"validation",name:"Validation",updatedAt:60},{id:"real",name:"Real",updatedAt:70}];
  const merged=mergeThreadCatalog([],incoming,{runtime:"codex",provider:"vyceai",threadMeta:{phantom:{catalogHidden:true},validation:{ephemeral:true}}});
  assert.deepEqual(merged.map(item=>item.id),["real"]);
});

test("Trebell Native thread identity stays separate from the inference provider",()=>{
  const existing=[{id:"native-thread",name:"Keep Native history",updatedAt:35,trebellRuntime:"native",trebellProvider:"agentrouter"}];
  const merged=mergeThreadCatalog(existing,[],{runtime:"native",provider:"hcnsec"});
  assert.equal(merged.length,1);assert.equal(merged[0].id,"native-thread");assert.equal(merged[0].trebellRuntime,"native");
  const patch=catalogMetaPatch({id:"native-thread",name:"Keep Native history",updatedAt:35},{runtime:"native",provider:"hcnsec",runtimeInstanceId:"native-default"});
  assert.equal(threadCatalogRuntime({id:"native-thread"},patch,"codex"),"native");
});

test("thread catalog reconstructs durable rows from thread metadata and omits archived/deleted rows",()=>{
  const rows=threadsFromCatalogMeta({
    a:{runtime:"claude",cwd:"C:/repo",threadSnapshot:{id:"a",name:"Remembered task",preview:"Fix parser",updatedAt:50,model:"claude-x",runtime:"claude"}},
    b:{runtime:"codex",archived:true,threadSnapshot:{id:"b",name:"Archived",updatedAt:60}},
    c:{runtime:"codex",deletedAt:100,threadSnapshot:{id:"c",name:"Deleted",updatedAt:70}},
    d:{runtime:"codex",ephemeral:true,threadSnapshot:{id:"d",name:"Ephemeral validation",updatedAt:80}},
    e:{runtime:"codex",catalogHidden:true,threadSnapshot:{id:"e",name:"Stale shortcut",updatedAt:90}},
  });
  assert.deepEqual(rows.map(item=>item.id),["a"]);assert.equal(rows[0].trebellRuntime,"claude");assert.equal(rows[0].cwd,"C:/repo");
});

test("catalog metadata keeps runtime identity separate from inference provider",()=>{
  const patch=catalogMetaPatch({id:"t1",name:"Provider-independent thread",cwd:"C:/repo",model:"deepseek-v4.1",updatedAt:100,status:{type:"active"}},{runtime:"codex",provider:"vyceai",runtimeInstanceId:"codex-default"});
  assert.equal(patch.runtime,"codex");assert.equal(patch.provider,"vyceai");assert.equal(patch.threadSnapshot.status.type,"idle");
  assert.equal(threadCatalogRuntime({id:"t1"},patch,"claude"),"codex");
});

test("legacy metadata can recover runtime ownership without a modern thread snapshot",()=>{
  const rows=threadsFromCatalogMeta({
    claudeLegacy:{cwd:"C:/repo",runtimeInstanceId:"claude-default",trebellContext:{runtime:"claude"}},
    codexLegacy:{cwd:"C:/repo",runtimeInstanceId:"codex-profile-2"},
    nativeLegacy:{cwd:"C:/repo",runtimeInstanceId:"native-default"},
  });
  assert.equal(rows.find(item=>item.id==="claudeLegacy").trebellRuntime,"claude");
  assert.equal(rows.find(item=>item.id==="codexLegacy").trebellRuntime,"codex");
  assert.equal(rows.find(item=>item.id==="nativeLegacy").trebellRuntime,"native");
});

test("missing runtime thread errors recognize Codex rollout loss even for durable catalog rows",()=>{
  assert.equal(missingRuntimeThreadError(new Error("no rollout found for thread id 01a0dea1")),true);
  assert.equal(missingRuntimeThreadError(new Error("Thread abc not found")),true);
  assert.equal(missingRuntimeThreadError(new Error("network connection failed")),false);
});

test("a thread another harness owns is named by its owner, so a harness switch neither shows nor continues it",()=>{
  // The live tour: an OpenCode thread stayed open after the switch to Cursor, and the next message went to it with Cursor's model.
  const opencode={id:"oc-1",runtime:"opencode",model:"opencode/big-pickle"};
  assert.equal(threadOwnerElsewhere(opencode,{},"cursor"),"opencode");
  assert.equal(threadOwnerElsewhere(opencode,{runtime:"opencode",runtimeInstanceId:"opencode-default"},"cursor"),"opencode");
  assert.equal(threadOwnerElsewhere(opencode,{},"opencode"),null,"the owner's own thread stays open");
  // Codex threads carry no runtime field: the catalog's saved owner names it.
  assert.equal(threadOwnerElsewhere({id:"codex-1"},{runtime:"codex"},"claude"),"codex");
  assert.equal(threadOwnerElsewhere({id:"codex-1"},{runtimeInstanceId:"codex-work"},"claude"),"codex");
  // A thread with no owner on record belongs to the harness that shows it; no thread, or no harness, has no other owner.
  assert.equal(threadOwnerElsewhere({id:"plain"},{},"grok"),null);
  assert.equal(threadOwnerElsewhere(null,{},"grok"),null);
  assert.equal(threadOwnerElsewhere(opencode,{},null),null);
  assert.equal(threadOwnerElsewhere(opencode,undefined,"cursor"),"opencode");
});

test("the open thread's header title is the one its sidebar row shows once the first message names it",()=>{
  // The live tour: every harness's new thread kept "New Trebell task" in the header while its row showed the first message.
  const opened={id:"t1",name:null,preview:null,model:"haiku"};
  assert.deepEqual(openThreadTitleSource(opened,[{id:"t1",name:null,preview:"Reply with exactly TREBELL_TOUR_OK"}]),{...opened,preview:"Reply with exactly TREBELL_TOUR_OK"});
  assert.equal(openThreadTitleSource(opened,[{id:"t1",name:"Tour check",preview:"Reply"}]).name,"Tour check","a name the server gave later wins");
  assert.equal(openThreadTitleSource({...opened,name:"Renamed"},[{id:"t1",name:null,preview:"Reply"}]).name,"Renamed","a rename not yet listed is kept");
  assert.deepEqual(openThreadTitleSource(opened,[{id:"other",preview:"Other"}]),{...opened,name:null,preview:null},"another thread's row is not used");
  assert.deepEqual(openThreadTitleSource({id:"t2",preview:"Kept"},undefined),{id:"t2",name:null,preview:"Kept"});
  assert.equal(openThreadTitleSource(null,[{id:"t1"}]),null);
});

test("a saved thread with no name or first message is titled as its sidebar row, and only a new chat is a new task",()=>{
  // The live tour: an Antigravity thread saved untitled showed "Untitled task" in the sidebar and "New Trebell task" in the header.
  assert.equal(threadTitle({id:"t1",name:null,preview:null}),"Untitled task");
  assert.equal(threadTitle(openThreadTitleSource({id:"t1",name:null,preview:null},[{id:"t1",name:null,preview:null}])),"Untitled task");
  assert.equal(threadTitle(null),"New Trebell task");
  assert.equal(threadTitle({id:"t1",name:null,preview:"Reply with exactly TREBELL_TOUR_OK"}),"Reply with exactly TREBELL_TOUR_OK");
  assert.equal(threadTitle({id:"t1",name:"Tour check",preview:"Reply"}),"Tour check");
});

test("a harness switch keeps a thread of the harness it lands on that was opened while it ran, and closes the one it replaced",()=>{
  // The live tour: a Cursor thread opened while a switch to Cursor ran was closed when the switch landed.
  const cursor={id:"c1",runtime:"cursor"},untagged={id:"u1"};
  assert.equal(threadKeptBySwitch(cursor,{},{switchThreadId:null,landingRuntime:"cursor",openedUnder:"cursor"}),true);
  assert.equal(threadKeptBySwitch(cursor,{},{switchThreadId:"older",landingRuntime:"cursor",openedUnder:"codex"}),true,"the thread names its own harness");
  assert.equal(threadKeptBySwitch(cursor,{},{switchThreadId:"c1",landingRuntime:"cursor",openedUnder:"cursor"}),false,"the thread open when the switch began is the one it replaces");
  assert.equal(threadKeptBySwitch(cursor,{},{switchThreadId:null,landingRuntime:"opencode",openedUnder:"cursor"}),false,"a thread of another harness never stays open");
  assert.equal(threadKeptBySwitch({id:"c2"},{runtime:"opencode"},{switchThreadId:null,landingRuntime:"cursor",openedUnder:"cursor"}),false,"its saved owner decides");
  assert.equal(threadKeptBySwitch(untagged,{},{switchThreadId:null,landingRuntime:"grok",openedUnder:"grok"}),true,"a thread that names no harness belongs to the one it was opened under");
  assert.equal(threadKeptBySwitch(untagged,{},{switchThreadId:null,landingRuntime:"grok",openedUnder:"codex"}),false);
  assert.equal(threadKeptBySwitch(untagged,{runtimeInstanceId:"grok-work"},{switchThreadId:null,landingRuntime:"grok",openedUnder:"codex"}),true,"a saved profile names its harness");
  assert.equal(threadKeptBySwitch(null,{},{landingRuntime:"cursor",openedUnder:"cursor"}),false);
  assert.equal(threadKeptBySwitch(cursor,{},{switchThreadId:null,landingRuntime:null,openedUnder:"cursor"}),false);
});
