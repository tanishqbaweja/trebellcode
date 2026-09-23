const DEFAULT_MAX_CHARS=64*1024;
const DEFAULT_MAX_FIELDS=1024;
const DEFAULT_MAX_DEPTH=16;

export function boundDiagnosticText(value,maxChars=DEFAULT_MAX_CHARS){
  const text=String(value??"");
  const max=Math.max(256,Math.trunc(Number(maxChars)||DEFAULT_MAX_CHARS));
  if(text.length<=max)return text;
  const marker="\n… Trebell truncated "+(text.length-max)+" diagnostic characters …\n";
  const head=Math.min(8192,Math.floor((max-marker.length)/3));
  const tail=Math.max(0,max-marker.length-head);
  return text.slice(0,head)+marker+text.slice(-tail);
}

export function boundDiagnosticValue(value,{maxChars=DEFAULT_MAX_CHARS,maxFields=DEFAULT_MAX_FIELDS,maxDepth=DEFAULT_MAX_DEPTH}={}){
  let characters=Math.max(256,Math.trunc(Number(maxChars)||DEFAULT_MAX_CHARS));
  let fields=Math.max(16,Math.trunc(Number(maxFields)||DEFAULT_MAX_FIELDS));
  const depthLimit=Math.max(2,Math.trunc(Number(maxDepth)||DEFAULT_MAX_DEPTH));
  const ancestors=new WeakSet();
  const visit=(current,depth)=>{
    if(typeof current==="string"){
      if(current.length<=characters){characters-=current.length;return current}
      const preview=boundDiagnosticText(current,Math.max(256,Math.min(characters,8192)));
      characters=Math.max(0,characters-preview.length);
      return {truncated:true,omittedCharacters:Math.max(0,current.length-preview.length),preview};
    }
    if(current==null||typeof current==="number"||typeof current==="boolean")return current;
    if(typeof current==="bigint")return String(current);
    if(typeof current!=="object")return String(current);
    if(depth>=depthLimit||ancestors.has(current))return {truncated:true};
    ancestors.add(current);
    try{
      if(Array.isArray(current)){
        const out=[];
        for(let index=0;index<current.length;index++){
          if(fields<=0||characters<=0){out.push({truncated:true,omittedItems:current.length-index});break}
          fields--;out.push(visit(current[index],depth+1));
        }
        return out;
      }
      const out={};const keys=Object.keys(current);
      for(let index=0;index<keys.length;index++){
        if(fields<=0||characters<=0){out.__trebellTruncated={omittedFields:keys.length-index};break}
        const key=keys[index];fields--;characters=Math.max(0,characters-key.length);
        try{out[key]=visit(Reflect.get(current,key),depth+1)}catch{out[key]={truncated:true}}
      }
      return out;
    }finally{ancestors.delete(current)}
  };
  return visit(value,0);
}
