import test from "node:test";
import assert from "node:assert/strict";
import { paletteActions } from "../ui/src/palette-actions.js";

// The command palette's commands, which come with the palette's code instead of with the app (palette-actions.js, B11): which ones
// show for what App's render hands them (app), and what each one runs.
function palette(overrides={},desktop=undefined){
  const ran=[],record=name=>(...args)=>{ran.push([name,...args])};
  const app={
    commandKey:command=>({newChat:"Mod+N",terminal:"Ctrl+`"}[command]||""),newTask:record("newTask"),newGeneralChat:record("newGeneralChat"),
    pickWorkspace:record("pickWorkspace"),projectPath:"/work/widget",navigateSection:record("navigateSection"),openRightPanel:record("openRightPanel"),
    projectlessMode:false,gitInfo:{isGit:true,branch:"feature/palette"},paletteThread:true,askText:async question=>{ran.push(["askText",question]);return "https://github.com/acme/widget/pull/7"},
    linkPullRequestUrl:record("linkPullRequestUrl"),panel:null,setPanel:record("setPanel"),focusTerminalDrawer:record("focusTerminalDrawer"),
    currentProject:{scripts:[{id:"tests",name:"Tests",command:"npm test"}]},runProjectAction:record("runProjectAction"),runtimeCapabilities:{delegation:true,harnessTools:true},
    goal:{objective:"Ship the palette"},agentRuntimeLabel:"Codex",startReview:record("startReview"),saveAppSettings:record("saveAppSettings"),
    settings:{customThemes:[{id:"custom-dusk",name:"Dusk",appearance:"light"}]},messages:[{id:"m1",role:"user"}],shareThread:record("shareThread"),
    ...overrides,
  };
  const before=globalThis.window;globalThis.window=desktop?{trebellDesktop:desktop}:{};
  try{return {actions:paletteActions(app),ran,app}}finally{globalThis.window=before}
}
const ids=actions=>actions.map(action=>action.id);
const run=async(actions,id)=>{const action=actions.find(item=>item.id===id);assert.ok(action,"command "+id);await action.onRun()};

test("an open thread of a Git project offers every command, in the palette's order, with its keys and its state",()=>{
  const {actions}=palette();
  assert.deepEqual(ids(actions),["new","new-general","projects","files","diff","git","context","link-pr","terminal","project-action:tests","browser","agents","goal","review","tools","environments","usage","licenses","appearance-system","appearance-light","appearance-dark","theme-trebell","theme-midnight","theme-black","theme-custom:custom-dusk","settings","copy"]);
  const by=id=>actions.find(action=>action.id===id);
  assert.equal(by("new").shortcut,"Ctrl+N");assert.equal(by("new").keywords,"New task");
  assert.equal(by("terminal").shortcut,"Ctrl+`");
  assert.equal(by("git").detail,"feature/palette");
  assert.equal(by("goal").detail,"Ship the palette");
  assert.equal(by("review").detail,"Ask Codex to review uncommitted changes");
  assert.deepEqual([by("project-action:tests").label,by("project-action:tests").detail],["Run Tests","npm test"]);
  assert.deepEqual([by("theme-custom:custom-dusk").label,by("theme-custom:custom-dusk").detail],["Theme: Dusk","Custom light theme"]);
  assert.equal(by("browser").detail,"Open hosted preview and local dev-server tools");
  assert.equal(by("settings").detail,"Providers, permissions and workspace behavior");
});

test("a general chat, a thread still opening and a harness without delegation or tools offer only the commands that apply",()=>{
  const {actions}=palette({projectlessMode:true,paletteThread:false,gitInfo:null,runtimeCapabilities:{},currentProject:null,settings:{},messages:[],goal:null});
  assert.deepEqual(ids(actions),["new","new-general","projects","files","terminal","browser","environments","usage","licenses","appearance-system","appearance-light","appearance-dark","theme-trebell","theme-midnight","theme-black","settings"]);
  // The terminal's key is offered only while the terminal is closed, as that key closes an open one.
  assert.equal(palette({panel:"terminal"}).actions.find(action=>action.id==="terminal").shortcut,"");
  // A thread with no messages has nothing to copy; a project that is not a Git checkout has no review.
  assert.ok(!ids(palette({messages:[]}).actions).includes("copy"));
  assert.ok(!ids(palette({gitInfo:{isGit:false}}).actions).includes("review"));
});

test("the desktop app adds Open workspace folder and names its own browser and settings",()=>{
  const {actions}=palette({},{pickDirectory:()=>null,browser:{}});
  assert.deepEqual(ids(actions).slice(0,3),["new","new-general","folder"]);
  const by=id=>actions.find(action=>action.id===id);
  assert.equal(by("folder").detail,"/work/widget");
  assert.equal(palette({projectPath:""},{pickDirectory:()=>null}).actions.find(action=>action.id==="folder").detail,"Choose a local folder");
  assert.equal(by("browser").detail,"Open Trebell Agent Browser");
  assert.equal(by("settings").detail,"Providers, permissions and desktop behavior");
});

test("each command runs what App handed the palette",async()=>{
  const {actions,ran,app}=palette();
  assert.equal(actions.find(action=>action.id==="new").onRun,app.newTask);
  assert.equal(actions.find(action=>action.id==="copy").onRun,app.shareThread);
  for(const id of ["projects","files","diff","git","context","terminal","project-action:tests","browser","agents","goal","review","tools","environments","usage","licenses","appearance-system","appearance-light","appearance-dark","theme-trebell","theme-midnight","theme-black","theme-custom:custom-dusk","settings","link-pr"])await run(actions,id);
  assert.deepEqual(ran,[
    ["navigateSection","projects"],["openRightPanel","files"],["openRightPanel","diff"],["openRightPanel","source"],["openRightPanel","context"],
    ["setPanel","terminal"],["focusTerminalDrawer"],["runProjectAction",{id:"tests",name:"Tests",command:"npm test"}],["openRightPanel","preview"],
    ["openRightPanel","agents"],["openRightPanel","goal"],["startReview"],["navigateSection","tools"],["navigateSection","environments"],
    ["navigateSection","usage"],["navigateSection","licenses"],["saveAppSettings",{appearanceMode:"system"}],["saveAppSettings",{appearanceMode:"light"}],
    ["saveAppSettings",{appearanceMode:"dark"}],["saveAppSettings",{appearance:"dark"}],["saveAppSettings",{appearance:"midnight"}],
    ["saveAppSettings",{appearance:"black"}],["saveAppSettings",{appearance:"custom-dusk"}],["navigateSection","settings"],
    ["askText","Pull request URL"],["linkPullRequestUrl","https://github.com/acme/widget/pull/7","manual"],
  ]);
  // Link pull request asked and cancelled links nothing.
  const cancelled=palette({askText:async()=>""});await run(cancelled.actions,"link-pr");
  assert.deepEqual(cancelled.ran,[]);
});
