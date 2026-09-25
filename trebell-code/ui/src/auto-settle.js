function pullRequestCount(meta={}){
  const attachments=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").length;
  const legacy=Array.isArray(meta.linkedPullRequests)?meta.linkedPullRequests.length:0;
  return Math.max(attachments,legacy);
}

export function hasAutoSettleCandidates(threads=[],threadMeta={}){
  for(const thread of threads||[]){
    const meta=threadMeta?.[thread?.id]||{};
    const section=thread?.section?.name||meta.sectionName||"Active";
    if(thread?.archived||meta.archived||section==="Settled"||thread?.status?.type==="active")continue;
    if(pullRequestCount(meta)>0)return true;
  }
  return false;
}
