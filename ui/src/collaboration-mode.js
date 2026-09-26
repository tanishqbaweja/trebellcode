export function normalizeCollaborationModes(items=[]){
  const seen=new Set(),out=[];
  for(const item of items||[]){
    const mode=String(item?.mode||"").trim();if(!mode||seen.has(mode))continue;
    seen.add(mode);out.push({...item,mode,name:String(item?.name||mode)});
  }
  return out;
}

export function collaborationModePayload(items=[],selectedMode="default",model=""){
  const selected=(items||[]).find(item=>item?.mode===selectedMode);
  const resolvedModel=String(selected?.model||model||"").trim();
  if(!selected||!resolvedModel)return null;
  return {
    mode:selected.mode,
    settings:{
      model:resolvedModel,
      reasoning_effort:selected.reasoning_effort??null,
      developer_instructions:null,
    },
  };
}
