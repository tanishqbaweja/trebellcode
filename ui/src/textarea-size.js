export function boundedTextareaHeight(scrollHeight,{min=40,max=160}={}){
  const value=Math.max(0,Number(scrollHeight)||0);
  return Math.max(min,Math.min(max,Math.ceil(value)));
}

// Measured without its scrollbar, the draft scrolls once it shows less than it holds: over max, or where its box gives it less room
// (the composer above the terminal drawer, shell.css).
export function resizeTextarea(node,options={}){
  if(!node)return null;
  const min=Number(options.min)||40,max=Number(options.max)||160;
  node.style.overflowY="hidden";node.style.height="0px";
  const measured=Math.max(0,Number(node.scrollHeight)||0);
  const height=boundedTextareaHeight(measured,{min,max});
  node.style.height=height+"px";
  node.style.overflowY=measured>Math.min(height,node.clientHeight??height)?"auto":"hidden";
  return height;
}
