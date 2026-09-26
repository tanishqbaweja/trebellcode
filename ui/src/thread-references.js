export function threadReferenceValues(thread={},meta={}){
  return {
    threadId:String(thread?.id||""),
    branch:String(meta?.branch||""),
    path:String(thread?.cwd||meta?.cwd||""),
  };
}
