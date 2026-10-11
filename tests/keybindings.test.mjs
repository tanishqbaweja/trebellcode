import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KEYBINDING_CONTEXTS,
  defaultKeybindingRules,
  evaluateWhen,
  normalizeKeybindingRules,
  resolveKeybinding,
  shadowedKeybindings,
  shortcutMatches,
  shortcutProblem,
  shortcutSignature,
  whenProblem,
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

test("find in thread uses Mod+F for runtimes that expose thread search",()=>{
  const context={threadOpen:true,chatFocus:true,threadSearch:true,terminalFocus:false,modalOpen:false};
  assert.equal(resolveKeybinding(event("f",{ctrlKey:true}),{},context),"threadFind");
  assert.equal(resolveKeybinding(event("f",{metaKey:true}),{},context),"threadFind");
  assert.equal(resolveKeybinding(event("f",{ctrlKey:true}),{}, {...context,threadSearch:false}),null);
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

// A key event for a shortcut as the rules write it, with Mod pressed as Ctrl (Windows and Linux).
function eventFor(value){
  const parts=String(value).split("+").map(part=>part.trim().toLowerCase());
  const key=parts.pop();
  return event(key,{ctrlKey:parts.includes("mod")||parts.includes("ctrl"),metaKey:parts.includes("cmd")||parts.includes("meta"),shiftKey:parts.includes("shift"),altKey:parts.includes("alt")});
}
const contextNames=expression=>String(expression||"").match(/[A-Za-z_][A-Za-z0-9_.-]*/g)||[];

test("a shortcut that stops on a modifier or names a modifier that does not exist says what to change",()=>{
  for(const value of ["","Ctrl+B","Escape","Mod+Shift+[","Ctrl+,","Ctrl+Alt+Shift+A","F5","Ctrl + B"])assert.equal(shortcutProblem(value,false),"",value);
  assert.equal(shortcutProblem("Ctrl+",false),"Add a key after “Ctrl+”.");
  assert.equal(shortcutProblem("Ctrl",false),"Add a key after “Ctrl+”.");
  assert.equal(shortcutProblem("ctrl+shift+",false),"Add a key after “Ctrl+Shift+”.");
  assert.equal(shortcutProblem("Ctrl+Shift",false),"Add a key after “Ctrl+Shift+”.");
  assert.equal(shortcutProblem("Mod+",false),"Add a key after “Ctrl+”.");
  assert.equal(shortcutProblem("Mod+",true),"Add a key after “⌘+”.");
  assert.equal(shortcutProblem("+",false),"Type a key, such as F2 or Ctrl+Alt+K.");
  assert.equal(shortcutProblem("Ctlr+B",false),"“Ctlr” is not a modifier key. Use Ctrl, Alt, Shift or Mod.");
  // The matcher never answers to an unfinished shortcut, and answers to "Ctlr+B" as a bare B: both are refused for that reason.
  assert.equal(shortcutMatches(event("b",{ctrlKey:true}),"Ctrl+"),false);
  assert.equal(shortcutMatches(event("b"),"Ctlr+B"),true);
});

test("a shortcut naming a key the browser names otherwise, or no key at all, is refused with the name that works",()=>{
  for(const value of ["Ctrl+ArrowUp","Mod+Shift+Enter","Ctrl+Space","Esc","Ctrl+Delete","Ctrl+PageDown","F12","Shift+F24","Ctrl+`","Mod+=","Alt+é","Ctrl+comma","Ctrl+ContextMenu"])assert.equal(shortcutProblem(value,false),"",value);
  assert.equal(shortcutProblem("Ctrl+Up",false),"“Up” is not a key name. Use ArrowUp.");
  assert.equal(shortcutProblem("ctrl+left",false),"“left” is not a key name. Use ArrowLeft.");
  assert.equal(shortcutProblem("Ctrl+Del",false),"“Del” is not a key name. Use Delete.");
  assert.equal(shortcutProblem("Ctrl+Return",false),"“Return” is not a key name. Use Enter.");
  assert.equal(shortcutProblem("Ctrl+PgUp",false),"“PgUp” is not a key name. Use PageUp.");
  assert.equal(shortcutProblem("Ctrl+Plus",false),"“Plus” is not a key name. Use a letter, a digit or a name such as F2, Enter or ArrowUp.");
  assert.equal(shortcutProblem("F25",false),"“F25” is not a key name. Use a letter, a digit or a name such as F2, Enter or ArrowUp.");
  // A refused name is one the matcher never answers to; the name it suggests is one it does.
  assert.equal(shortcutMatches(event("ArrowUp",{ctrlKey:true}),"Ctrl+Up"),false);
  assert.equal(shortcutMatches(event("ArrowUp",{ctrlKey:true}),"Ctrl+ArrowUp"),true);
  assert.equal(shortcutMatches(event("Delete",{ctrlKey:true}),"Ctrl+Del"),false);
  assert.equal(shortcutMatches(event("Delete",{ctrlKey:true}),"Ctrl+Delete"),true);
  assert.equal(shortcutMatches(event(" ",{ctrlKey:true}),"Ctrl+Space"),true);
  assert.equal(shortcutSignature("Ctrl+Up",false),"");
  // Every shipped shortcut names a key the matcher sees.
  for(const rule of defaultKeybindingRules())assert.equal(shortcutProblem(rule.key,false),"",rule.command+" "+rule.key);
});

test("a condition the parser refuses says what to change, and a finished one passes",()=>{
  for(const value of ["","!modalOpen","threadOpen && !modalOpen","(threadOpen || pullRequestOpen) && !terminalFocus && !modalOpen","!(running || sidebarOpen)"])assert.equal(whenProblem(value),"",value);
  assert.equal(whenProblem("!modalOpen &&"),"Add a context after “&&”.");
  assert.equal(whenProblem("threadOpen ||"),"Add a context after “||”.");
  assert.equal(whenProblem("!"),"Add a context after “!”.");
  assert.equal(whenProblem("&& threadOpen"),"Add a context before “&&”.");
  assert.equal(whenProblem("()"),"Add a context before “)”.");
  assert.equal(whenProblem("!modalOpen && (projectOpen"),"Add a “)” to close the condition.");
  assert.equal(whenProblem("threadOpen)"),"Remove the extra “)”.");
  assert.equal(whenProblem("threadOpen running"),"“running” is out of place. Join contexts with && or ||.");
  assert.equal(whenProblem("threadOpen & running"),"“&” can't be used in a condition. Join contexts with &&, || and !.");
  // Each refused condition is one the resolver skips, so the shortcut would stop working.
  assert.throws(()=>evaluateWhen("!modalOpen &&",{}));
});

test("a condition naming a context the app never sets is refused, with the context meant when it is close",()=>{
  assert.equal(whenProblem("Always"),"“Always” is not a context. Leave When empty to use the shortcut everywhere.");
  assert.equal(whenProblem("!modalOpen && projectopen"),"“projectopen” is not a context. Use projectOpen.");
  assert.equal(whenProblem("threadOpn && !modalOpen"),"“threadOpn” is not a context. Use threadOpen.");
  assert.equal(whenProblem("!(runing || sidebarOpen)"),"“runing” is not a context. Use running.");
  assert.equal(whenProblem("!modalOpen && somewhere"),"“somewhere” is not a context. Use one from Available contexts below.");
  // Such a name is false in every context the app sets, so the shortcut would never run.
  assert.equal(evaluateWhen("Always",Object.fromEntries(KEYBINDING_CONTEXTS.map(name=>[name,true]))),false);
  // A parse error is said first.
  assert.equal(whenProblem("somewhere &&"),"Add a context after “&&”.");
  // Every shipped condition names contexts the app sets.
  for(const rule of defaultKeybindingRules())assert.equal(whenProblem(rule.when),"",rule.command+" "+rule.when);
  assert.equal(whenProblem("projectOpen && !modalOpen"),"","the condition a project action starts with");
});

test("the contexts Settings accepts are the ones the app sets for a key press",()=>{
  const app=readFileSync(new URL("../ui/src/App.jsx",import.meta.url),"utf8");
  const end=app.indexOf("const command=resolveKeybinding(event,");
  const start=app.lastIndexOf("const context={",end);
  assert.ok(end>0&&start>0,"the keydown handler's context object");
  const names=[...app.slice(start,end).matchAll(/^\s*([A-Za-z]+):/gm)].map(match=>match[1]);
  assert.deepEqual([...names].sort(),[...KEYBINDING_CONTEXTS].sort());
});

test("one shortcut has one signature however it is written, with Mod as Ctrl off macOS and as Cmd on it",()=>{
  assert.equal(shortcutSignature("Mod+N",false),shortcutSignature("ctrl+n",false));
  assert.notEqual(shortcutSignature("Mod+N",true),shortcutSignature("Ctrl+N",true));
  assert.equal(shortcutSignature("Mod+N",true),shortcutSignature("Cmd+N",true));
  assert.equal(shortcutSignature("Ctrl+,",false),shortcutSignature("Ctrl+comma",false));
  assert.equal(shortcutSignature("Shift+Ctrl+K",false),shortcutSignature("Ctrl+Shift+K",false));
  assert.equal(shortcutSignature("Ctrl+Alt+Shift+A",false),shortcutSignature("Ctrl+Shift+Alt+A",false));
  assert.notEqual(shortcutSignature("Ctrl+K",false),shortcutSignature("Ctrl+Shift+K",false));
  for(const value of ["","Ctrl+","Ctlr+B"])assert.equal(shortcutSignature(value,false),"",value);
});

test("the shipped shortcuts never shadow each other: each one runs in some context",()=>{
  const rules=defaultKeybindingRules();
  assert.deepEqual([...shadowedKeybindings(rules,false).keys()],[]);
  assert.deepEqual([...shadowedKeybindings(rules,true).keys()],[]);
  // The defaults reuse keys on purpose, under conditions that never meet, or for a narrower context that should win.
  const shared=new Map();
  for(const rule of rules.filter(rule=>rule.key)){const signature=shortcutSignature(rule.key,false);shared.set(signature,[...(shared.get(signature)||[]),rule])}
  const reused=[...shared.values()].filter(group=>group.length>1).map(group=>group.map(rule=>rule.command).join("/"));
  for(const group of ["terminalSplit/diffToggle","rightPanelClose/terminalClose","terminalFocus/composerFocus","newChat/terminalNew","threadJump1/modelJump1"])assert.ok(reused.includes(group),group+" in "+reused.join(" "));
  // Proof by the resolver itself: for every bound default there is a context in which its key runs it.
  for(const rule of rules.filter(rule=>rule.key)){
    const names=[...new Set(shared.get(shortcutSignature(rule.key,false)).flatMap(other=>contextNames(other.when)))];
    let runs=false;
    for(let mask=0;mask<2**names.length&&!runs;mask++){
      const context=Object.fromEntries(names.map((name,bit)=>[name,Boolean(mask>>bit&1)]));
      runs=resolveKeybinding(eventFor(rule.key),{},context)===rule.command;
    }
    assert.ok(runs,rule.command+" never runs on "+rule.key);
  }
});

test("a rule is flagged only when later rules on its key take every context it runs in",()=>{
  const withRules=(...changes)=>normalizeKeybindingRules({keybindingRules:changes});
  // New thread on Ctrl+K: Command palette is read later and always on, so New thread never runs.
  const clash=shadowedKeybindings(withRules({command:"newChat",key:"Ctrl+K",when:"!modalOpen"}),false);
  assert.deepEqual(clash.get("newChat"),{key:"Ctrl+K",by:["commandPalette"]});
  assert.equal(clash.size,1);
  assert.equal(resolveKeybinding(event("k",{ctrlKey:true}),{keybindingRules:[{command:"newChat",key:"Ctrl+K",when:"!modalOpen"}]},{modalOpen:false}),"commandPalette");
  // A later rule that only overlaps part of the time leaves New thread running elsewhere, so it is not flagged.
  assert.equal(shadowedKeybindings(withRules({command:"newChat",key:"Ctrl+K",when:"!modalOpen"},{command:"commandPalette",key:"Ctrl+K",when:"threadOpen"}),false).size,0);
  // Command palette on Mod+N takes Ctrl+N from New thread off macOS (New terminal takes it in a focused terminal); on macOS Mod+N is ⌘N.
  const palette=withRules({command:"commandPalette",key:"Mod+N",when:""});
  assert.deepEqual(shadowedKeybindings(palette,false).get("newChat"),{key:"Ctrl+N",by:["commandPalette","terminalNew"]});
  assert.equal(shadowedKeybindings(palette,false).size,1);
  assert.equal(shadowedKeybindings(palette,true).size,0);
  // Later rules can share the contexts between them: Toggle main sidebar on Ctrl+` in an open project never runs, since Focus
  // terminal takes the key outside the terminal and Focus composer inside it. Outside a project it still runs, so that is not flagged.
  const grave=String.fromCharCode(96);
  assert.deepEqual(shadowedKeybindings(withRules({command:"sidebarToggle",key:"Ctrl+"+grave,when:"projectOpen && !modalOpen"}),false).get("sidebarToggle"),{key:"Ctrl+"+grave,by:["terminalFocus","composerFocus"]});
  assert.equal(shadowedKeybindings(withRules({command:"sidebarToggle",key:"Ctrl+"+grave,when:"!modalOpen"}),false).size,0);
  // A project action is read last, so it wins over a command with the same key and condition.
  const action="script.dev-server.run";
  assert.deepEqual(shadowedKeybindings(withRules({command:"terminal",key:"Alt+T",when:"projectOpen && !modalOpen"},{command:action,key:"Alt+T",when:"projectOpen && !modalOpen"}),false).get("terminal"),{key:"Alt+T",by:[action]});
  // Unfinished shortcuts and conditions answer to nothing, so they neither shadow nor are shadowed.
  assert.equal(shadowedKeybindings(withRules({command:"newChat",key:"Ctrl+K",when:"!modalOpen &&"}),false).size,0);
  assert.equal(shadowedKeybindings(withRules({command:"commandPalette",key:"Ctrl+",when:""},{command:"newChat",key:"Ctrl+",when:""}),false).size,0);
});
