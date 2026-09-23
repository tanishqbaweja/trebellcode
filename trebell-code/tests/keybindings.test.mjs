import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWhen,
  normalizeKeybindingRules,
  resolveKeybinding,
  shortcutMatches,
} from "../ui/src/keybindings.js";

function event(key,mods={}){
  return {key,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,...mods};
}

test("when expressions support boolean contexts, negation and parentheses",()=>{
  assert.equal(evaluateWhen("threadOpen && !modalOpen",{threadOpen:true,modalOpen:false}),true);
  assert.equal(evaluateWhen("threadOpen && !modalOpen",{threadOpen:true,modalOpen:true}),false);
  assert.equal(evaluateWhen("(chatFocus || terminalFocus) && projectOpen",{chatFocus:false,terminalFocus:true,projectOpen:true}),true);
});

test("legacy shortcuts remain compatible while conditional rules override them",()=>{
  const rules=normalizeKeybindingRules({keyboardShortcuts:{search:"Ctrl+J"},keybindingRules:[
    {command:"terminal",key:"Alt+T",when:"projectOpen && !modalOpen"},
  ]});
  assert.equal(rules.find(x=>x.command==="commandPalette").key,"Ctrl+J");
  assert.deepEqual(rules.find(x=>x.command==="terminal"),{command:"terminal",key:"Alt+T",when:"projectOpen && !modalOpen"});
});

test("shortcut matching requires the exact modifier set",()=>{
  assert.equal(shortcutMatches(event("k",{ctrlKey:true}),"Ctrl+K"),true);
  assert.equal(shortcutMatches(event("k",{ctrlKey:true,shiftKey:true}),"Ctrl+K"),false);
  assert.equal(shortcutMatches(event(",",{ctrlKey:true}),"Ctrl+,"),true);
});

test("resolver skips a matching key when its when clause is false",()=>{
  const settings={keybindingRules:[
    {command:"files",key:"Ctrl+P",when:"projectOpen && !modalOpen"},
  ]};
  assert.equal(resolveKeybinding(event("p",{ctrlKey:true}),settings,{projectOpen:true,modalOpen:false}),"files");
  assert.equal(resolveKeybinding(event("p",{ctrlKey:true}),settings,{projectOpen:true,modalOpen:true}),null);
});

test("queued follow-up shortcut resolves only for a running thread",()=>{
  assert.equal(resolveKeybinding(event("Enter",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,running:true,modalOpen:false}),"steerQueued");
  assert.equal(resolveKeybinding(event("Enter",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,running:false,modalOpen:false}),null);
});

test("main sidebar toggle matches Ctrl+B outside modals",()=>{
  assert.equal(resolveKeybinding(event("b",{ctrlKey:true}),{}, {modalOpen:false}),"sidebarToggle");
  assert.equal(resolveKeybinding(event("b",{ctrlKey:true}),{}, {modalOpen:true}),null);
});

test("thread undo uses Mod+Z only when focus is outside text inputs",()=>{
  assert.equal(shortcutMatches(event("z",{ctrlKey:true}),"Mod+Z"),true);
  assert.equal(shortcutMatches(event("z",{metaKey:true}),"Mod+Z"),true);
  assert.equal(shortcutMatches(event("z",{ctrlKey:true,metaKey:true}),"Mod+Z"),false);
  assert.equal(resolveKeybinding(event("z",{ctrlKey:true}),{}, {undoAvailable:true,textInputFocus:false,modalOpen:false}),"undoThreadAction");
  assert.equal(resolveKeybinding(event("z",{ctrlKey:true}),{}, {undoAvailable:true,textInputFocus:true,modalOpen:false}),null);
  assert.equal(resolveKeybinding(event("z",{ctrlKey:true}),{}, {undoAvailable:false,textInputFocus:false,modalOpen:false}),null);
});

test("pull request copy shortcuts use mod bindings and respect terminal focus",()=>{
  assert.equal(resolveKeybinding(event("c",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,terminalFocus:false,modalOpen:false}),"copyReference");
  assert.equal(resolveKeybinding(event("c",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:false,pullRequestOpen:true,terminalFocus:false,modalOpen:false}),"copyReference");
  assert.equal(resolveKeybinding(event("k",{ctrlKey:true,shiftKey:true}),{}, {pullRequestOpen:true,terminalFocus:false,modalOpen:false}),"copyPullRequestNumber");
  assert.equal(resolveKeybinding(event("c",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,terminalFocus:true,modalOpen:false}),null);
  assert.equal(resolveKeybinding(event("k",{ctrlKey:true,shiftKey:true}),{}, {pullRequestOpen:true,terminalFocus:true,modalOpen:false}),null);
});

test("unbound commands stay editable and simply do not resolve until assigned",()=>{
  const rules=normalizeKeybindingRules({});
  assert.deepEqual(rules.find(rule=>rule.command==="threadStop"),{command:"threadStop",key:"",when:"threadOpen && running && !terminalFocus && !modalOpen"});
  assert.equal(resolveKeybinding(event("Escape"),{}, {threadOpen:true,running:true,terminalFocus:false,modalOpen:false}),null);
  const settings={keybindingRules:[{command:"threadStop",key:"Escape",when:"threadOpen && running && !terminalFocus && !modalOpen"}]};
  assert.equal(resolveKeybinding(event("Escape"),settings,{threadOpen:true,running:true,terminalFocus:false,modalOpen:false}),"threadStop");
});

test("shared numeric shortcuts prefer model jumps while the model picker is open",()=>{
  assert.equal(resolveKeybinding(event("1",{ctrlKey:true}),{}, {desktop:true,modelPickerOpen:false,textInputFocus:false,terminalFocus:false,modalOpen:false}),"threadJump1");
  assert.equal(resolveKeybinding(event("1",{ctrlKey:true}),{}, {desktop:true,modelPickerOpen:true,textInputFocus:false,terminalFocus:false,modalOpen:false}),"modelJump1");
});

test("terminal focus and close shortcuts resolve by focus context",()=>{
  const grave=String.fromCharCode(96);
  assert.equal(resolveKeybinding(event(grave,{ctrlKey:true}),{}, {projectOpen:true,terminalFocus:false,modalOpen:false}),"terminalFocus");
  assert.equal(resolveKeybinding(event(grave,{ctrlKey:true}),{}, {projectOpen:true,terminalFocus:true,modalOpen:false}),"composerFocus");
  assert.equal(resolveKeybinding(event("w",{ctrlKey:true}),{}, {desktop:true,rightPanelOpen:true,terminalFocus:false,modalOpen:false}),"rightPanelClose");
  assert.equal(resolveKeybinding(event("w",{ctrlKey:true}),{}, {desktop:true,rightPanelOpen:true,terminalFocus:true,modalOpen:false}),"terminalClose");
});

test("settle shortcut is available from the composer but not the terminal",()=>{
  assert.equal(resolveKeybinding(event("s",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,terminalFocus:false,modalOpen:false}),"threadSettle");
  assert.equal(resolveKeybinding(event("s",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,terminalFocus:true,modalOpen:false}),null);
});

test("thread navigation and terminal-local new use context-specific defaults",()=>{
  assert.equal(resolveKeybinding(event("[",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,textInputFocus:false,terminalFocus:false,modalOpen:false}),"threadPrevious");
  assert.equal(resolveKeybinding(event("]",{ctrlKey:true,shiftKey:true}),{}, {threadOpen:true,textInputFocus:false,terminalFocus:false,modalOpen:false}),"threadNext");
  assert.equal(resolveKeybinding(event("n",{ctrlKey:true}),{}, {projectOpen:true,terminalFocus:true,modalOpen:false}),"terminalNew");
  assert.equal(resolveKeybinding(event("n",{ctrlKey:true}),{}, {projectOpen:true,terminalFocus:false,modalOpen:false}),"newChat");
});

test("find in thread uses Mod+F only for an open Codex chat",()=>{
  const context={threadOpen:true,chatFocus:true,codexRuntime:true,terminalFocus:false,modalOpen:false};
  assert.equal(resolveKeybinding(event("f",{ctrlKey:true}),{},context),"threadFind");
  assert.equal(resolveKeybinding(event("f",{metaKey:true}),{},context),"threadFind");
  assert.equal(resolveKeybinding(event("f",{ctrlKey:true}),{}, {...context,codexRuntime:false}),null);
  assert.equal(resolveKeybinding(event("f",{ctrlKey:true}),{}, {...context,terminalFocus:true}),null);
});

test("app navigation history uses Mod brackets without stealing editor or terminal input",()=>{
  assert.equal(resolveKeybinding(event("[",{ctrlKey:true}),{}, {textInputFocus:false,terminalFocus:false,modalOpen:false}),"navigationBack");
  assert.equal(resolveKeybinding(event("]",{metaKey:true}),{}, {textInputFocus:false,terminalFocus:false,modalOpen:false}),"navigationForward");
  assert.equal(resolveKeybinding(event("[",{ctrlKey:true}),{}, {textInputFocus:true,terminalFocus:false,modalOpen:false}),null);
  assert.equal(resolveKeybinding(event("]",{ctrlKey:true}),{}, {textInputFocus:false,terminalFocus:true,modalOpen:false}),null);
});

test("right panel and preview commands resolve only in their real contexts",()=>{
  assert.equal(resolveKeybinding(event("b",{ctrlKey:true,altKey:true}),{}, {terminalFocus:false,modalOpen:false}),"rightPanelToggle");
  assert.equal(resolveKeybinding(event("d",{ctrlKey:true}),{}, {terminalFocus:false,modalOpen:false}),"diffToggle");
  assert.equal(resolveKeybinding(event("j",{ctrlKey:true,shiftKey:true}),{}, {terminalFocus:false,modalOpen:false}),"previewToggle");
  assert.equal(resolveKeybinding(event("r",{ctrlKey:true}),{}, {previewFocus:true,terminalFocus:false,modalOpen:false}),"previewRefresh");
  assert.equal(resolveKeybinding(event("l",{ctrlKey:true}),{}, {previewFocus:true,terminalFocus:false,modalOpen:false}),"previewFocusUrl");
  assert.equal(resolveKeybinding(event("r",{ctrlKey:true}),{}, {previewFocus:false,terminalFocus:false,modalOpen:false}),null);
});

test("terminal split shortcuts take precedence over diff while terminal focus is active",()=>{
  assert.equal(resolveKeybinding(event("d",{ctrlKey:true}),{}, {terminalFocus:true,modalOpen:false}),"terminalSplit");
  assert.equal(resolveKeybinding(event("d",{ctrlKey:true,shiftKey:true}),{}, {terminalFocus:true,modalOpen:false}),"terminalSplitVertical");
  assert.equal(resolveKeybinding(event("d",{ctrlKey:true}),{}, {terminalFocus:false,modalOpen:false}),"diffToggle");
});

test("dynamic project action keybindings survive normalization and resolve",()=>{
  const command="script.01234567-89ab-cdef-0123-456789abcdef.run";
  const settings={keybindingRules:[{command,key:"Alt+1",when:"projectOpen && !modalOpen"}]};
  const rule=normalizeKeybindingRules(settings).find(item=>item.command===command);
  assert.deepEqual(rule,{command,key:"Alt+1",when:"projectOpen && !modalOpen"});
  assert.equal(resolveKeybinding(event("1",{altKey:true}),settings,{projectOpen:true,modalOpen:false}),command);
});
