export const SOURCE_CONTROL_PAGE_SIZE=60;

export function sourceControlWindow(items=[],{limit=SOURCE_CONTROL_PAGE_SIZE,activeKey=null,keyOf=item=>item?.id}={}){
  const source=Array.isArray(items)?items:[];
  const safeLimit=Math.max(1,Math.trunc(Number(limit)||SOURCE_CONTROL_PAGE_SIZE));
  const visible=source.slice(0,safeLimit);
  if(activeKey!=null&&!visible.some(item=>String(keyOf(item))===String(activeKey))){
    const active=source.find(item=>String(keyOf(item))===String(activeKey));
    if(active)visible.push(active);
  }
  const shown=Math.min(source.length,safeLimit);
  return {
    visible,
    total:source.length,
    shown,
    hasMore:shown<source.length,
    nextCount:Math.min(SOURCE_CONTROL_PAGE_SIZE,Math.max(0,source.length-shown)),
  };
}
