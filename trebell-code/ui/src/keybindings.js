export const KEYBINDING_COMMANDS=[
  {id:"newChat",label:"New thread",defaultKey:"Ctrl+N",defaultWhen:"!modalOpen"},
  {id:"commandPalette",label:"Command palette",defaultKey:"Ctrl+K",defaultWhen:""},
  {id:"sidebarToggle",label:"Toggle main sidebar",defaultKey:"Ctrl+B",defaultWhen:"!modalOpen"},
  {id:"stash",label:"Stash prompt",defaultKey:"Ctrl+S",defaultWhen:"chatFocus && !terminalFocus && !modalOpen"},
  {id:"terminal",label:"Toggle terminal",defaultKey:"Ctrl+Shift+T",defaultWhen:"projectOpen && !modalOpen"},
  {id:"files",label:"Workspace files",defaultKey:"Ctrl+P",defaultWhen:"projectOpen && !modalOpen"},
  {id:"source",label:"Source control",defaultKey:"Ctrl+Shift+G",defaultWhen:"projectOpen && !modalOpen"},
  {id:"goal",label:"Thread goal",defaultKey:"Ctrl+Shift+L",defaultWhen:"threadOpen && !modalOpen"},
  {id:"projects",label:"Projects",defaultKey:"Ctrl+Shift+P",defaultWhen:"!modalOpen"},
  {id:"settings",label:"Settings",defaultKey:"Ctrl+,",defaultWhen:"!modalOpen"},
  {id:"environments",label:"Environments",defaultKey:"Ctrl+Shift+E",defaultWhen:"!modalOpen"},
  {id:"steerQueued",label:"Send oldest queued message now",defaultKey:"Ctrl+Shift+Enter",defaultWhen:"threadOpen && running && !modalOpen"},
  {id:"undoThreadAction",label:"Undo recent thread action",defaultKey:"Mod+Z",defaultWhen:"undoAvailable && !textInputFocus && !modalOpen"},
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
  return KEYBINDING_COMMANDS.map(item=>{
    const rule=byCommand.get(item.id)||{};
    const legacyKey=item.id==="commandPalette"?legacy.search:legacy[item.id];
    return {
      command:item.id,
      key:String(rule.key??legacyKey??item.defaultKey).trim(),
      when:String(rule.when??item.defaultWhen).trim(),
    };
  }).filter(rule=>rule.key);
}

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
    if(!match)throw new Error("Invalid keybinding when expression near: "+text.slice(i));
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
    if(take("(")){const value=or();if(!take(")"))throw new Error("Missing ) in keybinding when expression");return value}
    const token=tokens[index++];
    if(!token||["&&","||",")"].includes(token))throw new Error("Expected context key in keybinding when expression");
    return Boolean(context[token]);
  }
  function unary(){return take("!")?!unary():primary()}
  function and(){let value=unary();while(take("&&"))value=Boolean(unary()&&value);return value}
  function or(){let value=and();while(take("||"))value=Boolean(and()||value);return value}
  const result=or();
  if(index!==tokens.length)throw new Error("Unexpected token in keybinding when expression: "+tokens[index]);
  return Boolean(result);
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
  return eventKey===expected||(expected==="comma"&&eventKey===",")||(expected==="period"&&eventKey===".")||(expected==="slash"&&eventKey==="/");
}

export function resolveKeybinding(event,settings={},context={}){
  for(const rule of normalizeKeybindingRules(settings)){
    if(!shortcutMatches(event,rule.key))continue;
    try{if(evaluateWhen(rule.when,context))return rule.command}catch{}
  }
  return null;
}
