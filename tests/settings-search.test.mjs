import test from "node:test";
import assert from "node:assert/strict";
import { searchSettings, settingsSearchItems } from "../ui/src/settings-search.js";

const keybindings=[
  {id:"commandPalette",label:"Command palette",defaultKey:"Ctrl+K",defaultWhen:""},
  {id:"terminalSplit",label:"Split terminal horizontally",defaultKey:"Mod+D",defaultWhen:"terminalFocus"},
];

test("settings search finds targeted setting groups by plain-language terms",()=>{
  assert.equal(searchSettings("snapshots",{keybindings})[0].id,"desktop-snapshot");
  assert.equal(searchSettings("merge method",{keybindings})[0].id,"workspace-defaults");
  assert.equal(searchSettings("provider",{keybindings})[0].section,"agents");
});

test("settings search indexes individual keyboard shortcuts",()=>{
  const result=searchSettings("command palette",{keybindings})[0];
  assert.deepEqual(result,{id:"shortcut-commandPalette",section:"shortcuts",title:"Command palette",description:"Keyboard shortcut",terms:"commandPalette Ctrl+K shortcut keybinding keyboard"});
  assert.equal(searchSettings("mod d",{keybindings})[0].id,"shortcut-terminalSplit");
});

test("settings search can index project action shortcuts and ignores tiny queries",()=>{
  const items=settingsSearchItems({keybindings,projectScripts:[{id:"build",name:"Build docs"}]});
  assert.equal(items.some(item=>item.id==="project-action-build"),true);
  assert.deepEqual(searchSettings("b",{keybindings}),[]);
  assert.equal(searchSettings("build docs",{keybindings,projectScripts:[{id:"build",name:"Build docs"}]})[0].id,"project-action-build");
});
