function array(value){return Array.isArray(value)?value:[]}
function integer(value,{min=0,max=100000}={}){const parsed=Math.trunc(Number(value));return Number.isFinite(parsed)?Math.max(min,Math.min(max,parsed)):null}
function text(value,max=300){const out=String(value??"").trim();return out?out.slice(0,max):null}

export function browserVerificationReceipt({tool,result=null,success=true,callId=null}={}){
  const name=String(tool||"").trim();if(!name)return null;const base={namespace:"trebell_browser",tool:name,success:Boolean(success)};if(callId)base.callId=text(callId,240);
  if(["open","click","type"].includes(name))return {...base,interaction:true,passed:Boolean(success&&result?.ok!==false)};
  if(name==="runtime")return {...base,consoleErrorCount:array(result?.consoleErrors).length,networkFailureCount:array(result?.networkFailures).length,width:integer(result?.width,{min:1,max:10000}),height:integer(result?.height,{min:1,max:10000}),viewportCount:array(result?.viewports).length};
  if(name==="screenshot")return {...base,screenshot:Boolean(success),width:integer(result?.width,{min:1,max:10000}),height:integer(result?.height,{min:1,max:10000})};
  if(name==="set_viewport")return {...base,viewport:Boolean(success),width:integer(result?.width,{min:1,max:10000}),height:integer(result?.height,{min:1,max:10000})};
  if(name==="snapshot")return {...base,snapshot:Boolean(success)};
  return base;
}

export function normalizeBrowserVerificationReceipt(value={}){
  if(value?.namespace!=="trebell_browser")throw new Error("Only Trebell browser evidence can be recorded here.");
  const tool=text(value.tool,120);if(!tool)throw new Error("Browser evidence requires a tool name.");
  const out={namespace:"trebell_browser",tool,success:Boolean(value.success)};
  if(value.callId)out.callId=text(value.callId,240);
  for(const key of ["interaction","passed","screenshot","viewport","snapshot"])if(typeof value[key]==="boolean")out[key]=value[key];
  for(const key of ["consoleErrorCount","networkFailureCount","width","height","viewportCount"]){const parsed=integer(value[key],{min:0,max:key==="width"||key==="height"?10000:1000});if(parsed!=null)out[key]=parsed}
  return out;
}
