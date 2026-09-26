export function repositoryContextEntries(packet={}){
  const instructions=String(packet?.instructionInjection||"").trim();
  const evidence=String(packet?.untrustedInjection||"").trim();
  const entries={};
  if(instructions)entries["trebell.repo_instructions"]={kind:"application",value:instructions};
  if(evidence)entries["trebell.repo_evidence"]={kind:"untrusted",value:evidence};
  else if(!instructions){
    const legacy=String(packet?.injection||"").trim();
    if(legacy)entries["trebell.repo_evidence"]={kind:"untrusted",value:legacy};
  }
  return entries;
}
