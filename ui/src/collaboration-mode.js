export function normalizeCollaborationModes(items=[]){
  const seen=new Set(),out=[];
  for(const item of items||[]){
    const mode=String(item?.mode||"").trim();if(!mode||seen.has(mode))continue;
    seen.add(mode);out.push({...item,mode,name:String(item?.name||mode)});
  }
  return out;
}

// Codex gives collaborationMode precedence over turn/start's effort, so the composer's reasoning effort goes into the
// mode settings (T3 Code sends reasoning_effort: effort). Without one, the mode preset's own effort applies.
export function collaborationModePayload(items=[],selectedMode="default",model="",{effort=null}={}){
  const selected=(items||[]).find(item=>item?.mode===selectedMode);
  const resolvedModel=String(selected?.model||model||"").trim();
  if(!selected||!resolvedModel)return null;
  const chosenEffort=String(effort||"").trim();
  return {
    mode:selected.mode,
    settings:{
      model:resolvedModel,
      reasoning_effort:chosenEffort||(selected.reasoning_effort??null),
      developer_instructions:null,
    },
  };
}
