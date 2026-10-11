import test from "node:test";
import assert from "node:assert/strict";
import {
  NAVIGATION_HISTORY_LIMIT,
  browserEntryIndex,
  browserState,
  createNavigationHistory,
  navigationKey,
  recordLocation,
  settleLocation,
  startNavigationHistory,
  stepTarget,
  storedNavigation,
} from "../ui/src/navigation-history.js";

const page=(section,extra={})=>({section,threadId:null,rightPanelOpen:false,rightPanelTab:"files",...extra});
const sections=nav=>nav.entries.map(entry=>entry.section);

test("the key names the page, the thread and the right panel tab only while the panel is open",()=>{
  assert.equal(navigationKey(page("chat",{threadId:"t1"})),"chat|t1|");
  assert.equal(navigationKey(page("chat",{rightPanelTab:"diff"})),"chat||");
  assert.equal(navigationKey(page("chat",{rightPanelOpen:true,rightPanelTab:"diff"})),"chat||diff");
});

test("a first open starts the history at the page shown",()=>{
  const nav=createNavigationHistory("doc");
  const entry=startNavigationHistory(nav,page("chat"),{browserEntryId:null,stored:null});
  assert.deepEqual(entry,{id:"doc-1",section:"chat",threadId:null,rightPanelOpen:false,rightPanelTab:"files"});
  assert.equal(nav.index,0);
});

test("pages moved to are pushed once each, and a page opened after going back drops the pages ahead",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("chat"));
  assert.equal(recordLocation(nav,page("projects")).action,"push");
  assert.equal(recordLocation(nav,page("projects")).action,"none");
  recordLocation(nav,page("usage"));
  assert.deepEqual(sections(nav),["chat","projects","usage"]);
  nav.index=1;
  assert.equal(recordLocation(nav,page("settings")).action,"push");
  assert.deepEqual(sections(nav),["chat","projects","settings"]);
  assert.equal(nav.index,2);
});

test("the history keeps its last entries only",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("p0"));
  for(let i=1;i<NAVIGATION_HISTORY_LIMIT+5;i++)recordLocation(nav,page("p"+i));
  assert.equal(nav.entries.length,NAVIGATION_HISTORY_LIMIT);
  assert.equal(nav.index,NAVIGATION_HISTORY_LIMIT-1);
  assert.equal(nav.entries[0].section,"p5");
});

test("the app's own Back and Forward stop at the ends and count a step still on its way",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("chat"));recordLocation(nav,page("projects"));
  assert.equal(stepTarget(nav,1),-1);
  assert.equal(stepTarget(nav,-1),0);
  nav.pending=0;
  assert.equal(stepTarget(nav,-1),-1,"a second quick Back from the first page would leave the app");
  assert.equal(stepTarget(nav,1),1);
});

test("a browser step lands on the entry its state names, and a state that is not the app's is ignored",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("chat"));
  const projects=recordLocation(nav,page("projects")).entry;recordLocation(nav,page("usage"));
  assert.equal(browserEntryIndex(nav,browserState(projects)),1);
  assert.equal(browserEntryIndex(nav,null),-1);
  assert.equal(browserEntryIndex(nav,{other:true}),-1);
  assert.equal(nav.entries.length,3);
});

test("an entry of the app's that the history does not hold becomes the history",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("chat"));
  const index=browserEntryIndex(nav,{trebellNav:{id:"old-4",section:"settings",threadId:null,rightPanelOpen:false,rightPanelTab:"files"}});
  assert.equal(index,0);
  assert.deepEqual(sections(nav),["settings"]);
  assert.equal(nav.entries[0].id,"old-4");
});

test("after a reload the entry reloaded shows the page the app opened on, and the entries around it stay",()=>{
  const before=createNavigationHistory("first");startNavigationHistory(before,page("chat"));
  recordLocation(before,page("projects"));const usage=recordLocation(before,page("usage")).entry;recordLocation(before,page("settings"));
  before.index=2;
  const stored=JSON.parse(JSON.stringify(storedNavigation(before)));
  const nav=createNavigationHistory("second");
  const entry=startNavigationHistory(nav,page("chat"),{browserEntryId:usage.id,stored});
  assert.equal(entry.id,usage.id);
  assert.deepEqual(sections(nav),["chat","projects","chat","settings"]);
  assert.equal(nav.index,2);
  assert.equal(recordLocation(nav,page("history")).entry.id,"second-1","new ids never repeat an earlier load's");
});

test("a stored history that does not hold the browser's entry, or is damaged, starts afresh",()=>{
  const nav=createNavigationHistory("doc");
  startNavigationHistory(nav,page("chat"),{browserEntryId:"gone-1",stored:{entries:[{id:"x-1",section:"projects"}],index:0}});
  assert.deepEqual(sections(nav),["chat"]);
  const damaged=createNavigationHistory("doc");
  startNavigationHistory(damaged,page("chat"),{browserEntryId:"x-1",stored:{entries:[null,{id:"x-1"},"text"],index:3}});
  assert.deepEqual(sections(damaged),["chat"]);
});

test("a Back that could not show its thread names what it showed instead",()=>{
  const nav=createNavigationHistory("doc");startNavigationHistory(nav,page("chat",{threadId:"gone"}));recordLocation(nav,page("projects"));
  nav.index=0;
  const settled=settleLocation(nav,page("chat"));
  assert.equal(settled.action,"replace");
  assert.equal(settled.entry.id,"doc-1");
  assert.equal(nav.entries[0].threadId,null);
  assert.equal(settleLocation(nav,page("chat")).action,"none");
});

test("the browser state keeps what else it holds",()=>{
  const entry={id:"doc-1",section:"chat",threadId:null,rightPanelOpen:false,rightPanelTab:"files"};
  assert.deepEqual(browserState(entry,{scroll:4}),{scroll:4,trebellNav:entry});
  assert.deepEqual(browserState(entry,null),{trebellNav:entry});
  assert.deepEqual(browserState(entry,"text"),{trebellNav:entry});
});
