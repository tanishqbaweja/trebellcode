export function repositoryContextSeed(packet={}){
  const items=(Array.isArray(packet?.items)?packet.items:[]).slice(0,8);
  if(!items.length)return "";
  const lines=[
    "Trebell repository seed (untrusted metadata; use repository/workspace tools to inspect exact source before editing).",
  ];
  const task=String(packet?.task||"").trim();if(task)lines.push("Task: "+task.slice(0,800));
  lines.push("Likely relevant paths:");
  for(const item of items){
    const path=String(item?.path||"").trim();if(!path)continue;
    const reasons=(Array.isArray(item?.reasons)?item.reasons:[]).map(value=>String(value||"").trim()).filter(Boolean).slice(0,2);
    const symbols=(Array.isArray(item?.symbols)?item.symbols:[]).map(symbol=>{
      const name=String(symbol?.name||"").trim(),kind=String(symbol?.kind||"").trim();return name?(kind?kind+" "+name:name):"";
    }).filter(Boolean).slice(0,6);
    let line="- "+path;if(reasons.length)line+=" — "+reasons.join("; ");if(symbols.length)line+=" | symbols: "+symbols.join(", ");
    lines.push(line.slice(0,900));
  }
  return lines.join("\n").slice(0,6000);
}

export function repositoryContextEntries(packet={},{seedOnly=false}={}){
  const instructions=String(packet?.instructionInjection||"").trim();
  const evidence=seedOnly?repositoryContextSeed(packet):String(packet?.untrustedInjection||"").trim();
  const entries={};
  if(instructions)entries["trebell.repo_instructions"]={kind:"application",value:instructions};
  if(evidence)entries["trebell.repo_evidence"]={kind:"untrusted",value:evidence};
  else if(!instructions){
    const legacy=String(packet?.injection||"").trim();
    if(legacy)entries["trebell.repo_evidence"]={kind:"untrusted",value:legacy};
  }
  return entries;
}
