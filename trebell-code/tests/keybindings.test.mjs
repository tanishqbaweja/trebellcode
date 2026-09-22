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
