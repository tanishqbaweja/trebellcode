const BASE_SETTINGS_SEARCH_ITEMS=[
  {id:"general-about",section:"general",title:"About & open source licenses",terms:"version licenses license open source about"},
  {id:"general-followups",section:"general",title:"Follow-up behavior",terms:"queue steer follow up running agent"},
  {id:"general-notifications",section:"general",title:"Desktop notifications",terms:"notifications notification sound alert"},
  {id:"general-recovery",section:"general",title:"Restart recovery",terms:"restart resume recover continue active threads"},
  {id:"general-updates",section:"general",title:"Updates",terms:"update download install release version"},
  {id:"agents-harness",section:"agents",title:"Agent harness",terms:"native trebell native codex claude cursor grok opencode antigravity runtime harness install authenticate sign in"},
  {id:"agents-profiles",section:"agents",title:"Runtime profiles",terms:"profile account codex home claude config auto compact shadow home multi account"},
  {id:"agents-provider",section:"agents",title:"Model provider",terms:"provider freebuff agentrouter justworker hcnsec vyce api key inference"},
  {id:"agents-models",section:"agents",title:"Custom models",terms:"model reasoning effort service tier pricing custom model"},
  {id:"agents-mcp",section:"agents",title:"MCP servers",terms:"mcp model context protocol tools stdio claude cursor grok antigravity server executable"},
  {id:"agents-runtime",section:"agents",title:"Runtime diagnostics",terms:"runtime app server bridge inference status diagnostics"},
  {id:"workspace-defaults",section:"workspace",title:"Project & environment defaults",terms:"permissions merge method git text style git text model custom git instructions pr template auto pull worktree cleanup submodule source control"},
  {id:"workspace-storage",section:"workspace",title:"Storage cleanup",terms:"storage retention attachment cache terminal history worktree cleanup"},
  {id:"workspace-pr-lifecycle",section:"workspace",title:"Pull request lifecycle",terms:"pull request pr settle merged closed auto settle review"},
  {id:"appearance-environment",section:"appearance",title:"Environment themes",terms:"environment theme published vscode colors"},
  {id:"appearance-theme",section:"appearance",title:"Appearance & themes",terms:"appearance light dark system theme animations motion panel accent"},
  {id:"desktop-computer",section:"desktop",title:"Computer use",terms:"computer use desktop mouse keyboard screenshot full access"},
  {id:"desktop-browser",section:"desktop",title:"Browser profiles",terms:"browser profile firefox helium cookies import"},
  {id:"desktop-snapshot",section:"desktop",title:"SnapShots",terms:"snapshot capture shortcut screenshot accessibility text flash sound"},
  {id:"desktop-background",section:"desktop",title:"Background mode",terms:"background tray startup login sign in"},
  {id:"shortcuts-overview",section:"shortcuts",title:"Keyboard shortcuts",terms:"shortcuts keybindings keyboard commands hotkeys keys"},
  {id:"diagnostics-runtime",section:"diagnostics",title:"Diagnostics",terms:"diagnostics health runtime provider agent"},
  {id:"diagnostics-log",section:"diagnostics",title:"Runtime log",terms:"runtime log logs diagnostics stderr stdout"},
];

function normalized(value){
  return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

function scoreItem(item,query){
  const title=normalized(item.title),terms=normalized(item.terms),section=normalized(item.section),description=normalized(item.description);
  if(title===query)return 0;
  if(title.startsWith(query))return 1;
  if(title.includes(query))return 2;
  if(terms.includes(query))return 3;
  if(description.includes(query))return 4;
  if(section.includes(query))return 5;
  const words=query.split(" ").filter(Boolean);
  if(words.length&&words.every(word=>(title+" "+terms+" "+description+" "+section).includes(word)))return 6;
  return null;
}

export function settingsSearchItems({keybindings=[],projectScripts=[]}={}){
  const shortcuts=keybindings.map(command=>({
    id:"shortcut-"+command.id,
    section:"shortcuts",
    title:command.label,
    description:"Keyboard shortcut",
    terms:[command.id,command.defaultKey,command.defaultWhen,"shortcut keybinding keyboard"].filter(Boolean).join(" "),
  }));
  const scripts=projectScripts.map(script=>({
    id:"project-action-"+script.id,
    section:"shortcuts",
    title:"Run "+script.name,
    description:"Project action shortcut",
    terms:[script.name,script.id,"project action script shortcut keybinding"].filter(Boolean).join(" "),
  }));
  return [...BASE_SETTINGS_SEARCH_ITEMS,...shortcuts,...scripts];
}

export function searchSettings(query,options={}){
  const q=normalized(query);
  if(q.length<2)return [];
  return settingsSearchItems(options)
    .map((item,index)=>({item,index,score:scoreItem(item,q)}))
    .filter(entry=>entry.score!==null)
    .sort((a,b)=>a.score-b.score||a.index-b.index)
    .map(entry=>entry.item);
}

