export const WORKSPACE_TREE_PAGE_SIZE=120;
export const WORKSPACE_CHANGED_PAGE_SIZE=80;
export const WORKSPACE_DIFF_CHUNK_CHARS=120_000;

export function workspaceListWindow(items=[],{limit,pageSize=WORKSPACE_TREE_PAGE_SIZE}={}){
  const source=Array.isArray(items)?items:[];
  const size=Math.max(1,Math.trunc(Number(pageSize)||WORKSPACE_TREE_PAGE_SIZE));
  const safeLimit=Math.max(1,Math.trunc(Number(limit)||size));
  const shown=Math.min(source.length,safeLimit);
  return {
    visible:source.slice(0,shown),
    total:source.length,
    shown,
    hasMore:shown<source.length,
    nextCount:Math.min(size,Math.max(0,source.length-shown)),
  };
}

export function workspaceTextWindow(value="",{limit=WORKSPACE_DIFF_CHUNK_CHARS,chunkSize=WORKSPACE_DIFF_CHUNK_CHARS}={}){
  const text=String(value||"");
  const size=Math.max(1000,Math.trunc(Number(chunkSize)||WORKSPACE_DIFF_CHUNK_CHARS));
  const safeLimit=Math.max(1000,Math.trunc(Number(limit)||size));
  const shown=Math.min(text.length,safeLimit);
  return {
    text:text.slice(0,shown),
    total:text.length,
    shown,
    hasMore:shown<text.length,
    nextCount:Math.min(size,Math.max(0,text.length-shown)),
  };
}
