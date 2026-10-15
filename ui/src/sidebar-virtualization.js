export const SIDEBAR_VIRTUALIZE_AFTER=80;
export const SIDEBAR_CHUNK_SIZE=40;
// A row the browser has not drawn yet is 55 px tall (its contain-intrinsic-size, 48 px, with its padding and margin) and a drawn one a
// little less, so a chunk's placeholder is never shorter than its rows: rows mounting below the view do not lengthen the list, and End
// or the scrollbar taken to its end reaches the last thread instead of stopping short of it.
export const SIDEBAR_ROW_ESTIMATE=55;

export function sidebarVirtualChunks(items=[],{chunkSize=SIDEBAR_CHUNK_SIZE,rowHeight=SIDEBAR_ROW_ESTIMATE}={}){
  const source=Array.isArray(items)?items:[],size=Math.max(10,Math.min(100,Math.trunc(Number(chunkSize)||SIDEBAR_CHUNK_SIZE))),height=Math.max(32,Math.min(80,Number(rowHeight)||SIDEBAR_ROW_ESTIMATE));
  const chunks=[];let end=source.length;
  while(end>0){
    const start=Math.max(0,end-size),rows=source.slice(start,end);
    chunks.unshift({
      key:String(rows[0]?.id??start)+"::"+String(rows.at(-1)?.id??(end-1)),
      start,end,items:rows,estimatedHeight:Math.max(1,Math.ceil(rows.length*height)),
    });
    end=start;
  }
  return chunks;
}

export function sidebarChunkIndexForThread(chunks=[],threadId){
  const wanted=String(threadId??"");if(!wanted)return -1;
  return (Array.isArray(chunks)?chunks:[]).findIndex(chunk=>chunk.items.some(thread=>String(thread?.id)===wanted));
}

export function shouldVirtualizeSidebarGroup(items=[],threshold=SIDEBAR_VIRTUALIZE_AFTER){
  return Array.isArray(items)&&items.length>Math.max(20,Number(threshold)||SIDEBAR_VIRTUALIZE_AFTER);
}
