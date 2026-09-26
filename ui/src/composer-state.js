export function restoreQueuedDraft({prompt="",attachments=[],contextChips=[],queued=[],maxAttachments=100}={}){
  const returnedText=queued.map(item=>String(item?.text||"")).filter(Boolean).join("\n\n");
  const nextPrompt=returnedText?(prompt?`${prompt}\n\n${returnedText}`:returnedText):prompt;
  const nextAttachments=[...new Set([...(attachments||[]),...queued.flatMap(item=>item?.attachments||[])])].slice(0,maxAttachments);
  const chips=new Map();
  for(const chip of [...(contextChips||[]),...queued.flatMap(item=>item?.contextChips||[])]){
    const key=chip?.path||chip?.id;if(key)chips.set(key,chip);
  }
  return {prompt:nextPrompt,attachments:nextAttachments,contextChips:[...chips.values()].slice(-maxAttachments)};
}

export function isVideoAttachment(path){return /\.(mp4|mov|mkv|webm|avi|m4v|mpeg|mpg)$/i.test(String(path||""))}
