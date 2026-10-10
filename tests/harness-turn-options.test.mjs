import test from "node:test";
import assert from "node:assert/strict";
import {harnessInventory,harnessThreadOptions,harnessTurnOptions,relayHarness,serviceTierPickerTitle} from "../ui/src/harness-turn-options.js";
import {agentPermissionModeFromStart,agentPermissionProfilePatch} from "../src/agent-relay.mjs";

test("every relay harness starts its thread in the composer's access level, Auto-accept edits included",()=>{
  for(const runtime of ["claude","opencode","cursor","grok","antigravity"]){
    assert.equal(relayHarness(runtime),true,runtime);
    const options=harnessThreadOptions(runtime,{permissionMode:"edits"});
    assert.deepEqual(options,{permissionProfile:"edits"},runtime);
    // The relay reads the profile as sent; from a Codex-style sandbox and approval policy it could not tell edits from supervised.
    assert.equal(agentPermissionModeFromStart(options),"edits",runtime);
  }
  assert.deepEqual(harnessThreadOptions("cursor"),{permissionProfile:"supervised"},"no choice starts supervised");
  for(const runtime of ["codex","native","",null,undefined]){
    assert.equal(relayHarness(runtime),false,String(runtime));
    assert.deepEqual(harnessThreadOptions(runtime,{permissionMode:"full"}),{},"Codex and Native take the sandbox and approval policy instead");
  }
});

test("each harness's turn carries the access level and only the composer choices it takes",()=>{
  const choices={permissionMode:"edits",reasoningEffort:"high",serviceTier:"fast",modelOptions:{context:"1m",thinking:"true"}};
  assert.deepEqual(harnessTurnOptions("claude",choices),{permissionProfile:"edits",reasoningEffort:"high",serviceTier:"fast"});
  assert.deepEqual(harnessTurnOptions("opencode",choices),{permissionProfile:"edits",reasoningEffort:"high"});
  assert.deepEqual(harnessTurnOptions("grok",choices),{permissionProfile:"edits",reasoningEffort:"high"});
  assert.deepEqual(harnessTurnOptions("cursor",choices),{permissionProfile:"edits",reasoningEffort:"high",serviceTier:"fast",modelOptions:{context:"1m",thinking:"true"}});
  assert.deepEqual(harnessTurnOptions("antigravity",choices),{permissionProfile:"edits"},"Antigravity offers no effort, speed or model settings");
  assert.deepEqual(harnessTurnOptions("codex",choices),{});
  assert.deepEqual(harnessTurnOptions("native",choices),{});
  // Every turn carries the access level, so a mode changed between turns reaches the relay's turn/start permission patch.
  assert.deepEqual(agentPermissionProfilePatch(harnessTurnOptions("antigravity",{permissionMode:"full"})),{permissionProfile:"full"});
});

test("a turn with no effort, speed or model settings tells the harness to use its own defaults",()=>{
  assert.deepEqual(harnessTurnOptions("claude"),{permissionProfile:"supervised",reasoningEffort:null,serviceTier:null});
  assert.deepEqual(harnessTurnOptions("cursor",{permissionMode:"",reasoningEffort:"",serviceTier:undefined,modelOptions:null}),{permissionProfile:"supervised",reasoningEffort:null,serviceTier:null,modelOptions:{}});
  assert.deepEqual(harnessTurnOptions("cursor",{modelOptions:["context"]}).modelOptions,{},"only a settings object is sent");
});

test("a new chat shows the harness's own menus and drops another harness's",()=>{
  const claude={commands:[{name:"compact"}],agents:[{name:"reviewer"}],skills:[{name:"pdf"}]};
  assert.deepEqual(harnessInventory(claude),claude);
  // The next harness lists no agents or skills: they are cleared, not left from the previous harness.
  assert.deepEqual(harnessInventory({commands:[{name:"init"}]}),{commands:[{name:"init"}],agents:[],skills:[]});
  assert.deepEqual(harnessInventory(null),{commands:[],agents:[],skills:[]});
  // Codex lists its skills itself, so its menus leave them alone.
  assert.deepEqual(harnessInventory(null,null,{withSkills:false}),{commands:[],agents:[]});
});

test("an opened thread shows what its session listed over the harness's menus",()=>{
  const runtime={commands:[{name:"compact"}],agents:[{name:"build"},{name:"plan"}],skills:[{name:"pdf"}]};
  const providerMeta={
    available_commands_update:{commands:[{name:"review"}]},
    config_option_update:{configOptions:[],agents:[{name:"ask"}]},
    session_info_update:{title:"Fix tests"},
    initialize:{agentCapabilities:{}},
  };
  assert.deepEqual(harnessInventory(runtime,providerMeta),{commands:[{name:"review"}],agents:[{name:"ask"}],skills:[{name:"pdf"}]});
  assert.deepEqual(harnessInventory(null,{available_commands_update:{commands:"bad"}}),{commands:[],agents:[],skills:[]},"a malformed list is empty");
  assert.deepEqual(harnessInventory(runtime,"bad"),runtime,"malformed metadata leaves the harness's menus");
});

test("the Speed picker names what it changes for the harness",()=>{
  assert.equal(serviceTierPickerTitle("codex"),"Codex service tier");
  assert.equal(serviceTierPickerTitle("claude"),"Claude Code Fast mode");
  assert.equal(serviceTierPickerTitle("cursor"),"Cursor Fast mode");
  assert.equal(serviceTierPickerTitle("native"),"OpenAI processing speed tier");
});
