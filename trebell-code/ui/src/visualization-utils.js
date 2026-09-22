function htmlReference(value){
  const text=String(value||"").trim();
  return /\.html?$/i.test(text)?text:null;
}

function parseDirectiveAttributes(raw){
  const attributes={};
  const pattern=/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;
  let match;
  while((match=pattern.exec(String(raw||""))))attributes[match[1]]=match[2]??match[3]??match[4]??"";
  return attributes;
}

function normalizedVisualization(value={}){
  const path=htmlReference(value.path);
  const file=htmlReference(value.file);
  if(!path&&!file)return null;
  return {...(path?{path}:{}),...(file?{file}:{}),mode:String(value.mode||"").toLowerCase()==="wide"?"wide":"default"};
}

export function parseVisualizationMessage(input){
  let text=String(input||"");
  const visualizations=[];
  text=text.replace(/::codex-inline-vis\{([^}]*)\}/g,(full,raw)=>{
    const visualization=normalizedVisualization(parseDirectiveAttributes(raw));
    if(!visualization)return full;
    visualizations.push(visualization);return "";
  });
  text=text.replace(/[\uFFFC\uFFFD]visualize[\uFFFC\uFFFD](\{[^\r\n]*?\})[\uFFFC\uFFFD]/g,(full,json)=>{
    let parsed;try{parsed=JSON.parse(json)}catch{return full}
    const visualization=normalizedVisualization(parsed);
    if(!visualization)return full;
    visualizations.push(visualization);return "";
  });
  return {text:text.replace(/\n{3,}/g,"\n\n").trim(),visualizations};
}

export function visualizationUrl(visualization,{projectPath,environmentId,threadId}={}){
  if(!visualization)return "";
  const params=new URLSearchParams();
  if(projectPath)params.set("root",projectPath);
  if(environmentId)params.set("environmentId",environmentId);
  if(threadId)params.set("threadId",threadId);
  if(visualization.path)params.set("path",visualization.path);
  else if(visualization.file)params.set("file",visualization.file);
  return "/api/visualization?"+params.toString();
}
