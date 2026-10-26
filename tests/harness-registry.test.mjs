import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentRuntimeManager, normalizeAgentRuntime } from "../src/agent-runtime-manager.mjs";
import { runtimeCapabilityKinds, sharedRuntimeCapabilities } from "../src/runtime-capabilities.mjs";
import { runtimeEnvironmentKeys } from "../src/runtime-environment.mjs";
import { runtimeHarnessLabel } from "../src/runtime-instructions.mjs";
import { normalizeRecipe } from "../src/recipes.mjs";
import { threadCatalogRuntime } from "../ui/src/thread-catalog.js";
import { harnessTurnOptions, relayHarness } from "../ui/src/harness-turn-options.js";
import { agentName } from "../ui/src/display-labels.js";
import { searchSettings } from "../ui/src/settings-search.js";

// Every harness kind is listed by hand in tables across the server and the UI. A kind left out of one of them is half registered:
// a Muse Code thread read as Codex, a sidebar row named by its id, a turn whose Thinking level never reaches the harness. This walks
// every kind of the runtime registry through every table, the UI's label maps and kind lists included (read from their source).
const KINDS=new AgentRuntimeManager({state:{settings:()=>({})},env:{PATH:""},platform:"linux"}).definitions().map(item=>({id:item.id,name:item.name}));
const SHORT={native:"Native",codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity",muse:"Muse"};
const ids=KINDS.map(kind=>kind.id),external=ids.filter(id=>id!=="native");
const source=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
// The literal ({...} or [...]) that follows marker in a file.
function literalAfter(text,marker){
  const at=text.indexOf(marker);assert.ok(at>=0,"marker not found: "+marker);
  const start=text.slice(at+marker.length).search(/[[{]/)+at+marker.length,open=text[start],close=open==="{"?"}":"]";
  let depth=0;for(let index=start;index<text.length;index++){if(text[index]===open)depth++;else if(text[index]===close&&--depth===0)return text.slice(start,index+1)}
  throw new Error("unclosed literal after "+marker);
}
const labels=(path,marker)=>Object.fromEntries([...literalAfter(source(path),marker).matchAll(/([a-z]+):"([^"]*)"/g)].map(match=>[match[1],match[2]]));
const strings=(path,marker)=>[...literalAfter(source(path),marker).matchAll(/"([^"]*)"/g)].map(match=>match[1]);
const sorted=list=>[...list].sort();

test("the harness registry lists Muse Code beside the other harnesses",()=>{
  assert.deepEqual(KINDS,[
    {id:"native",name:"Trebell Native"},{id:"codex",name:"Codex"},{id:"claude",name:"Claude Code"},{id:"cursor",name:"Cursor"},
    {id:"grok",name:"Grok Build"},{id:"opencode",name:"OpenCode"},{id:"antigravity",name:"Antigravity"},{id:"muse",name:"Muse Code"},
  ]);
});

test("every harness kind is read as itself and has its capabilities, environment, runtime notes' name, recipes and thread catalog entry",()=>{
  for(const {id,name} of KINDS){
    assert.equal(normalizeAgentRuntime(id),id,id);
    assert.ok(runtimeCapabilityKinds.includes(id),id+" has a capability row");
    assert.equal(typeof sharedRuntimeCapabilities(id).steering,"boolean",id);
    assert.equal(runtimeHarnessLabel(id),name,id+" in the runtime notes and the history handoff");
    assert.equal(normalizeRecipe({runtime:id,objective:"Ship it"}).runtime,id,id+" recipes");
    assert.equal(threadCatalogRuntime({id:"t",runtime:id}),id,id+" thread catalog");
    assert.equal(threadCatalogRuntime({id:"t"},{runtimeInstanceId:id+"-work"}),id,id+" thread catalog by profile");
    assert.ok(runtimeEnvironmentKeys(id).includes("PATH"),id);
  }
  assert.ok(runtimeEnvironmentKeys("muse").includes("MUSE_CHANNEL"),"Muse Code's own variables");
});

test("every harness kind is named in every label map the server and the UI keep",()=>{
  const long=Object.fromEntries(KINDS.map(kind=>[kind.id,kind.name]));
  for(const {id,name} of KINDS)assert.equal(agentName(id),name,id+" in display-labels.js (Usage, Tools, Settings, onboarding)");
  for(const [path,marker] of [
    ["ui/src/App.jsx","const AGENT_RUNTIME_LABELS="],
    ["ui/src/components/ThreadSidebar.jsx","const runtimeLabel=runtimeStarting?\"Starting…\":"],
    ["ui/src/components/EnvironmentsPage.jsx","const labels="],
  ])assert.deepEqual(labels(path,marker),long,path+" "+marker);
  for(const [path,marker] of [
    ["ui/src/App.jsx","const HISTORY_RUNTIME_LABELS="],
    ["ui/src/components/ThreadSidebar.jsx","const rowRuntimeLabel=("],
  ])assert.deepEqual(labels(path,marker),SHORT,path+" "+marker);
  assert.deepEqual(labels("src/harness-text-generation.mjs","const HARNESS_NAMES="),Object.fromEntries(KINDS.filter(kind=>kind.id!=="native").map(kind=>[kind.id,kind.name])));
  assert.deepEqual(strings("ui/src/components/SettingsPage.jsx","const AGENT_RUNTIME_SKELETON_ROWS="),KINDS.map(kind=>kind.name),"Settings' rows while the list loads");
});

test("every harness kind is in the kind lists it belongs to: custom models, sign-in, composer choices, lazy sessions, the Settings cards and search",()=>{
  assert.deepEqual(sorted(strings("src/gui-server.mjs","const mergeCustom=catalog=>{")),sorted(ids),"custom models of every harness");
  assert.deepEqual(sorted(strings("src/agent-runtime-manager.mjs","canAuthenticate:")),sorted(external),"every external harness signs in from Settings");
  assert.deepEqual(sorted(strings("ui/src/components/SettingsPage.jsx","\"agents-models\":")),sorted(external),"the custom models card");
  assert.deepEqual(sorted(strings("src/agent-relay.mjs","const LAZY_SESSION_RUNTIMES=new Set(")),sorted(["cursor","grok","antigravity","opencode","muse"]),"reopening their threads starts no harness");
  const relay=ids.filter(relayHarness);
  assert.deepEqual(sorted(relay),sorted(ids.filter(id=>!["native","codex"].includes(id))),"every harness on the agent relay gets the thread's access level");
  const effort=ids.filter(id=>Object.hasOwn(harnessTurnOptions(id,{reasoningEffort:"high"}),"reasoningEffort"));
  assert.deepEqual(sorted(effort),sorted(["claude","opencode","cursor","grok","muse"]),"the harnesses whose turns take the Thinking level");
  for(const {id} of KINDS)assert.ok(searchSettings(id).some(item=>item.id==="agents-harness"),id+" finds Agent harness in the Settings search");
});
