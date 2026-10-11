export const KEYBINDING_COMMANDS=[
  {id:"newChat",label:"New thread",defaultKey:"Ctrl+N",defaultWhen:"!modalOpen"},
  {id:"commandPalette",label:"Command palette",defaultKey:"Ctrl+K",defaultWhen:""},
  {id:"navigationBack",label:"Navigate back",defaultKey:"Mod+[",defaultWhen:"!textInputFocus && !terminalFocus && !modalOpen"},
  {id:"navigationForward",label:"Navigate forward",defaultKey:"Mod+]",defaultWhen:"!textInputFocus && !terminalFocus && !modalOpen"},
  {id:"sidebarToggle",label:"Toggle main sidebar",defaultKey:"Ctrl+B",defaultWhen:"!modalOpen"},
  {id:"threadStop",label:"Stop running thread",defaultKey:"",defaultWhen:"threadOpen && running && !terminalFocus && !modalOpen"},
  {id:"threadSettle",label:"Settle / un-settle thread",defaultKey:"Ctrl+Shift+S",defaultWhen:"threadOpen && !terminalFocus && !modalOpen"},
  {id:"threadPin",label:"Pin / unpin thread",defaultKey:"",defaultWhen:"threadOpen && !terminalFocus && !modalOpen"},
  {id:"threadPrevious",label:"Previous thread",defaultKey:"Mod+Shift+[",defaultWhen:"threadOpen && !textInputFocus && !terminalFocus && !modalOpen"},
  {id:"threadNext",label:"Next thread",defaultKey:"Mod+Shift+]",defaultWhen:"threadOpen && !textInputFocus && !terminalFocus && !modalOpen"},
  {id:"threadFind",label:"Find in current thread",defaultKey:"Mod+F",defaultWhen:"threadOpen && chatFocus && threadSearch && !terminalFocus && !modalOpen"},
  ...Array.from({length:9},(_,index)=>({id:"threadJump"+(index+1),label:"Open thread "+(index+1),defaultKey:"Mod+"+(index+1),defaultWhen:"desktop && !modelPickerOpen && !textInputFocus && !terminalFocus && !modalOpen"})),
  {id:"stash",label:"Stash prompt",defaultKey:"Ctrl+S",defaultWhen:"chatFocus && !terminalFocus && !modalOpen"},
  {id:"terminal",label:"Toggle terminal",defaultKey:"Ctrl+Shift+T",defaultWhen:"projectOpen && !modalOpen"},
  {id:"terminalFocus",label:"Focus terminal",defaultKey:"Ctrl+`",defaultWhen:"projectOpen && !terminalFocus && !modalOpen"},
  {id:"composerFocus",label:"Focus composer",defaultKey:"Ctrl+`",defaultWhen:"terminalFocus && !modalOpen"},
  {id:"terminalSplit",label:"Split terminal horizontally",defaultKey:"Mod+D",defaultWhen:"terminalFocus && !modalOpen"},
  {id:"terminalSplitVertical",label:"Split terminal vertically",defaultKey:"Mod+Shift+D",defaultWhen:"terminalFocus && !modalOpen"},
  {id:"terminalNew",label:"New terminal",defaultKey:"Mod+N",defaultWhen:"projectOpen && terminalFocus && !modalOpen"},
  {id:"rightPanelClose",label:"Close right panel",defaultKey:"Mod+W",defaultWhen:"desktop && rightPanelOpen && !terminalFocus && !modalOpen"},
  {id:"terminalClose",label:"Close focused terminal",defaultKey:"Mod+W",defaultWhen:"desktop && terminalFocus && !modalOpen"},
  {id:"rightPanelToggle",label:"Toggle right panel",defaultKey:"Mod+Alt+B",defaultWhen:"!terminalFocus && !modalOpen"},
  {id:"rightPanelMaximize",label:"Maximize right panel",defaultKey:"",defaultWhen:"rightPanelOpen && !terminalFocus && !modalOpen"},
  {id:"diffToggle",label:"Toggle diff",defaultKey:"Mod+D",defaultWhen:"!terminalFocus && !modalOpen"},
  {id:"previewToggle",label:"Toggle preview",defaultKey:"Mod+Shift+J",defaultWhen:"!terminalFocus && !modalOpen"},
  {id:"previewRefresh",label:"Refresh preview",defaultKey:"Mod+R",defaultWhen:"previewFocus && !terminalFocus && !modalOpen"},
  {id:"previewFocusUrl",label:"Focus preview URL",defaultKey:"Mod+L",defaultWhen:"previewFocus && !terminalFocus && !modalOpen"},
  {id:"previewZoomIn",label:"Zoom preview in",defaultKey:"Mod+=",defaultWhen:"previewFocus && !terminalFocus && !modalOpen"},
  {id:"previewZoomOut",label:"Zoom preview out",defaultKey:"Mod+-",defaultWhen:"previewFocus && !terminalFocus && !modalOpen"},
  {id:"previewResetZoom",label:"Reset preview zoom",defaultKey:"Mod+0",defaultWhen:"previewFocus && !terminalFocus && !modalOpen"},
  {id:"projectSearch",label:"Search threads/projects",defaultKey:"Mod+Shift+F",defaultWhen:"!terminalFocus && !modalOpen"},
  {id:"files",label:"Workspace files",defaultKey:"Ctrl+P",defaultWhen:"projectOpen && !modalOpen"},
  {id:"source",label:"Source control",defaultKey:"Ctrl+Shift+G",defaultWhen:"projectOpen && !modalOpen"},
  {id:"goal",label:"Thread goal",defaultKey:"Ctrl+Shift+L",defaultWhen:"threadOpen && !modalOpen"},
  {id:"projects",label:"Projects",defaultKey:"Ctrl+Shift+P",defaultWhen:"!modalOpen"},
  {id:"settings",label:"Settings",defaultKey:"Ctrl+,",defaultWhen:"!modalOpen"},
  {id:"environments",label:"Environments",defaultKey:"Ctrl+Shift+E",defaultWhen:"!modalOpen"},
  {id:"steerQueued",label:"Send oldest queued message now",defaultKey:"Ctrl+Shift+Enter",defaultWhen:"threadOpen && running && !modalOpen"},
  {id:"undoThreadAction",label:"Undo recent thread action",defaultKey:"Mod+Z",defaultWhen:"undoAvailable && !textInputFocus && !modalOpen"},
  {id:"copyReference",label:"Copy Link or Thread ID",defaultKey:"Mod+Shift+C",defaultWhen:"(threadOpen || pullRequestOpen) && !terminalFocus && !modalOpen"},
  {id:"copyPullRequestNumber",label:"Copy Number",defaultKey:"Mod+Shift+K",defaultWhen:"pullRequestOpen && !terminalFocus && !modalOpen"},
  {id:"modelPicker",label:"Choose model",defaultKey:"Mod+Shift+M",defaultWhen:"!terminalFocus && !modalOpen"},
  ...Array.from({length:9},(_,index)=>({id:"modelJump"+(index+1),label:"Choose model "+(index+1),defaultKey:"Mod+"+(index+1),defaultWhen:"desktop && modelPickerOpen && !terminalFocus && !modalOpen"})),
  {id:"cycleTheme",label:"Cycle theme",defaultKey:"Ctrl+Alt+A",defaultWhen:"!modalOpen"},
  {id:"cycleAppearance",label:"Cycle appearance mode",defaultKey:"Ctrl+Alt+Shift+A",defaultWhen:"!modalOpen"},
];

export function defaultKeybindingRules(){
  return KEYBINDING_COMMANDS.map(item=>({command:item.id,key:item.defaultKey,when:item.defaultWhen}));
}

export function normalizeKeybindingRules(settings={}){
  const legacy=settings.keyboardShortcuts||{};
  const configured=Array.isArray(settings.keybindingRules)?settings.keybindingRules:[];
  const byCommand=new Map(configured.filter(Boolean).map(rule=>[String(rule.command||""),rule]));
  const staticRules=KEYBINDING_COMMANDS.map(item=>{
    const rule=byCommand.get(item.id)||{};
    const legacyKey=item.id==="commandPalette"?legacy.search:legacy[item.id];
    return {
      command:item.id,
      key:String(rule.key??legacyKey??item.defaultKey).trim(),
      when:String(rule.when??item.defaultWhen).trim(),
    };
  });
  const staticIds=new Set(KEYBINDING_COMMANDS.map(item=>item.id));
  const dynamicRules=configured.filter(rule=>{
    const command=String(rule?.command||"").trim();
    return !staticIds.has(command)&&/^script\.[a-z0-9][a-z0-9-]{0,63}\.run$/i.test(command);
  }).map(rule=>({command:String(rule.command),key:String(rule.key||"").trim(),when:String(rule.when||"projectOpen && !modalOpen").trim()}));
  return [...staticRules,...dynamicRules];
}

// A parse error says what went wrong (code) and where (token, and the token before it), so Settings can say how to fix it.
function whenError(message,code,token,previous){return Object.assign(new Error(message),{code,token,previous})}

function tokenize(expression){
  const text=String(expression||"").trim();
  if(!text)return [];
  const tokens=[];
  let i=0;
  while(i<text.length){
    if(/\s/.test(text[i])){i++;continue}
    if(text.startsWith("&&",i)||text.startsWith("||",i)){tokens.push(text.slice(i,i+2));i+=2;continue}
    if(text[i]==="!"||text[i]==="("||text[i]===")"){tokens.push(text[i]);i++;continue}
    const match=text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
    if(!match)throw whenError("Invalid keybinding when expression near: "+text.slice(i),"character",text[i]);
    tokens.push(match[0]);i+=match[0].length;
  }
  return tokens;
}

export function evaluateWhen(expression,context={}){
  const tokens=tokenize(expression);
  if(!tokens.length)return true;
  let index=0;
  const peek=()=>tokens[index];
  const take=value=>peek()===value?(index++,true):false;
  function primary(){
    if(take("(")){const value=or();if(!take(")"))throw whenError("Missing ) in keybinding when expression","close");return value}
    const token=tokens[index++];
    if(!token||["&&","||",")"].includes(token))throw whenError("Expected context key in keybinding when expression","name",token,tokens[index-2]);
    return Boolean(context[token]);
  }
  function unary(){return take("!")?!unary():primary()}
  function and(){let value=unary();while(take("&&"))value=Boolean(unary()&&value);return value}
  function or(){let value=and();while(take("||"))value=Boolean(and()||value);return value}
  const result=or();
  if(index!==tokens.length)throw whenError("Unexpected token in keybinding when expression: "+tokens[index],"extra",tokens[index]);
  return Boolean(result);
}

// Why a typed condition cannot be used, or "" when it can (blank means always). The resolver skips a condition it cannot read,
// so saving one would switch the shortcut off; the message says how to finish it instead.
export function whenProblem(expression){
  try{evaluateWhen(expression,{});return ""}
  catch(error){
    if(error.code==="character")return `“${error.token}” can't be used in a condition. Join contexts with &&, || and !.`;
    if(error.code==="close")return "Add a “)” to close the condition.";
    if(error.code==="name")return error.token?`Add a context before “${error.token}”.`:`Add a context after “${error.previous}”.`;
    if(error.code==="extra")return error.token===")"?"Remove the extra “)”.":`“${error.token}” is out of place. Join contexts with && or ||.`;
    return "This condition can't be read.";
  }
}

function normalizedKey(value){
  const key=String(value||"").toLowerCase();
  if(key===" ")return "space";
  if(key==="esc")return "escape";
  return key;
}

export function shortcutMatches(event,value){
  if(!value)return false;
  const parts=String(value).toLowerCase().split("+").map(x=>x.trim()).filter(Boolean);
  const key=parts.pop();
  if(!key)return false;
  const wantsMod=parts.includes("mod");
  const wantsCtrl=parts.includes("ctrl")||parts.includes("control");
  const wantsMeta=parts.includes("cmd")||parts.includes("command")||parts.includes("meta");
  const wantsShift=parts.includes("shift");
  const wantsAlt=parts.includes("alt")||parts.includes("option");
  if(wantsMod){
    if(!Boolean(event.ctrlKey||event.metaKey)||Boolean(event.ctrlKey&&event.metaKey))return false;
  }else{
    if(Boolean(event.ctrlKey)!==wantsCtrl)return false;
    if(Boolean(event.metaKey)!==wantsMeta)return false;
  }
  if(Boolean(event.shiftKey)!==wantsShift)return false;
  if(Boolean(event.altKey)!==wantsAlt)return false;
  const eventKey=normalizedKey(event.key);
  const expected=normalizedKey(key);
  return eventKey===expected
    ||(expected==="["&&eventKey==="{")
    ||(expected==="]"&&eventKey==="}")
    ||(expected==="comma"&&eventKey===",")
    ||(expected==="period"&&eventKey===".")
    ||(expected==="slash"&&eventKey==="/");
}

const MAC_PLATFORM=typeof navigator!=="undefined"&&/Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform||navigator.platform||"");
// A keybinding as people read it: "Mod+Shift+P" shows "Ctrl+Shift+P" (or "⌘+Shift+P" on macOS). Used by the sidebar hints and
// the Settings > Shortcuts read state; the stored value keeps "Mod".
export function shortcutHint(value,mac=MAC_PLATFORM){
  const parts=String(value||"").split("+").map(part=>part.trim()).filter(Boolean);
  if(!parts.length)return "";
  const names={mod:mac?"⌘":"Ctrl",ctrl:"Ctrl",control:"Ctrl",cmd:"⌘",command:"⌘",meta:"⌘",shift:"Shift",alt:mac?"⌥":"Alt",option:"⌥"};
  return parts.map(part=>names[part.toLowerCase()]||(part.length===1?part.toUpperCase():part)).join("+");
}

const MODIFIER_NAMES=new Set(["mod","ctrl","control","cmd","command","meta","shift","alt","option"]);
// Why a typed shortcut cannot be used, or "" when it can. Blank (unbound) and a key with any modifiers are fine. "Ctrl+" and
// "Ctrl+Shift" stop on a modifier and never match a key; "Ctlr+B" names a modifier that does not exist, which the matcher drops,
// so it would answer to a bare B. The message names the modifiers as the field shows them (Mod as Ctrl, or ⌘ on macOS).
export function shortcutProblem(value,mac=MAC_PLATFORM){
  const text=String(value??"").trim();
  if(!text)return "";
  const parts=text.split("+").map(part=>part.trim());
  const last=parts.pop();
  const modifiers=parts.filter(Boolean);
  const unknown=modifiers.find(part=>!MODIFIER_NAMES.has(part.toLowerCase()));
  if(unknown)return `“${unknown}” is not a modifier key. Use Ctrl, Alt, Shift or Mod.`;
  if(last&&!MODIFIER_NAMES.has(last.toLowerCase()))return "";
  const held=last?[...modifiers,last]:modifiers;
  return held.length?`Add a key after “${shortcutHint(held.join("+"),mac)}+”.`:"Type a key, such as F2 or Ctrl+Alt+K.";
}

const KEY_SPELLINGS={esc:"escape",comma:",",period:".",slash:"/","{":"[","}":"]"};
// The keys a shortcut answers to, in one spelling: Mod as Ctrl (⌘ on macOS), the modifiers in a fixed order and the key as the
// matcher reads it, so "Mod+N" and "ctrl+n" are one shortcut on Windows and Linux. A blank or unusable shortcut has none.
export function shortcutSignature(value,mac=MAC_PLATFORM){
  if(!String(value??"").trim()||shortcutProblem(value,mac))return "";
  const parts=String(value).toLowerCase().split("+").map(part=>part.trim()).filter(Boolean);
  const key=parts.pop();
  const has=(...names)=>names.some(name=>parts.includes(name));
  const ctrl=has("ctrl","control")||(!mac&&has("mod")),meta=has("cmd","command","meta")||(mac&&has("mod"));
  return [ctrl&&"ctrl",meta&&"meta",has("alt","option")&&"alt",has("shift")&&"shift",KEY_SPELLINGS[key]||key].filter(Boolean).join("+");
}

const conditionNames=expression=>tokenize(expression).filter(token=>!["&&","||","!","(",")"].includes(token));
const holds=(expression,context)=>{try{return evaluateWhen(expression,context)}catch{return false}};
// Rules that never run: every time such a rule's condition holds, a later rule on the same keys holds too, and the later one wins
// (resolveKeybinding reads the rules from the end). The defaults reuse keys only under conditions that never meet (Mod+D, Mod+W,
// Ctrl+`, Mod+1-9) or for a narrower context that should win (Mod+N in a focused terminal), so none of them is listed. Conditions
// are compared over every combination of the contexts they name. Returns a Map of command -> {key, by: commands that run instead}.
export function shadowedKeybindings(rules,mac=MAC_PLATFORM){
  const usable=rules.map((rule,index)=>({rule,index,signature:shortcutSignature(rule.key,mac)})).filter(item=>item.signature&&!whenProblem(item.rule.when));
  const shadowed=new Map();
  for(const item of usable){
    const later=usable.filter(other=>other.index>item.index&&other.signature===item.signature).reverse();
    if(!later.length)continue;
    const names=[...new Set([item,...later].flatMap(other=>conditionNames(other.rule.when)))];
    if(names.length>12)continue;
    const by=new Set();let runs=false,reachable=false;
    for(let mask=0;mask<2**names.length&&!runs;mask++){
      const context=Object.fromEntries(names.map((name,bit)=>[name,Boolean(mask>>bit&1)]));
      if(!holds(item.rule.when,context))continue;
      reachable=true;
      const winner=later.find(other=>holds(other.rule.when,context));
      if(winner)by.add(winner);else runs=true;
    }
    if(reachable&&!runs)shadowed.set(item.rule.command,{key:item.rule.key,by:[...by].sort((a,b)=>a.index-b.index).map(other=>other.rule.command)});
  }
  return shadowed;
}

export function resolveKeybinding(event,settings={},context={}){
  const rules=normalizeKeybindingRules(settings);
  for(let index=rules.length-1;index>=0;index--){
    const rule=rules[index];
    if(!shortcutMatches(event,rule.key))continue;
    try{if(evaluateWhen(rule.when,context))return rule.command}catch{}
  }
  return null;
}
