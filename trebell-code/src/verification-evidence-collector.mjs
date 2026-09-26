const SOURCE_EXTENSIONS=/\.(?:[cm]?[jt]sx?)$/i;

function array(value){return Array.isArray(value)?value:[]}
function slash(value){return String(value||"").replace(/\\/g,"/")}
function normalizeCommand(value){
  const parts=Array.isArray(value)?value.map(String):[String(value||"")];
  let command=parts.join(" ").trim().replace(/\s+/g," ").toLowerCase();
  command=command.replace(/^npm (test|start|stop|restart)(?=$| )/,"npm run $1");
  return command;
}
function actualItemCommand(item={}){
  if(item.type==="dynamicToolCall"&&item.namespace==="trebell_terminal"&&item.tool==="run")return [item.arguments?.command,...array(item.arguments?.args)].filter(value=>value!=null&&String(value)!=="");
  return item.command||null;
}
function actualTraceCommand(trace={}){return trace?.data?.item?.command||null}
function commandMatches(actual,expected){
  const left=normalizeCommand(actual),right=normalizeCommand(expected);if(!left||!right)return false;
  return left===right||left.startsWith(right+" ");
}
function finiteExitCode(value){const number=Number(value);return Number.isFinite(number)?Math.trunc(number):null}
function terminalItem(item={}){return ["completed","failed"].includes(String(item.status||"").toLowerCase())}

function commandCandidates(turnItems=[],traces=[]){
  const rows=[];
  for(const item of array(turnItems)){
    if(!terminalItem(item))continue;const command=actualItemCommand(item),exitCode=finiteExitCode(item?.rawOutput?.exitCode??item.exitCode);if(!command||exitCode==null)continue;
    rows.push({id:item.id==null?null:String(item.id),command,exitCode,source:"turn-tool"});
  }
  for(const trace of array(traces)){
    if(trace?.name!=="item/completed")continue;const item=trace?.data?.item||{},command=actualTraceCommand(trace),exitCode=finiteExitCode(item.exitCode);if(!command||exitCode==null)continue;
    rows.push({id:item.id==null?null:String(item.id),command,exitCode,source:"runtime-trace"});
  }
  return rows;
}

function diagnosticsEvidence(plan,turnItems=[]){
  const step=array(plan?.steps).find(item=>item?.kind==="diagnostics"&&item.required!==false);if(!step)return null;
  const targets=array(plan?.paths).map(slash).filter(path=>SOURCE_EXTENSIONS.test(path)),byPath=new Map();
  for(const item of array(turnItems)){
    if(item?.type!=="dynamicToolCall"||item.namespace!=="trebell_repo"||item.tool!=="diagnostics"||!terminalItem(item))continue;
    const result=item.rawOutput&&typeof item.rawOutput==="object"?item.rawOutput:null,path=slash(result?.path||item.arguments?.path||"");if(!path)continue;
    const errors=array(result?.diagnostics).length+array(result?.semanticDiagnostics).length;byPath.set(path,{id:item.id==null?null:String(item.id),errors});
  }
  if(!targets.length||targets.some(path=>!byPath.has(path)))return null;
  const records=targets.map(path=>byPath.get(path)),errorCount=records.reduce((sum,item)=>sum+item.errors,0);
  return {stepId:step.id,status:errorCount===0?"passed":"failed",errorCount,source:"turn-tool",toolCallIds:records.map(item=>item.id).filter(Boolean),coveredPaths:targets.slice(0,80)};
}

export function collectVerificationEvidence({plan,turnItems=[],traces=[]}={}){
  const evidence=[],diagnostics=diagnosticsEvidence(plan,turnItems);if(diagnostics)evidence.push(diagnostics);
  const commands=commandCandidates(turnItems,traces);
  for(const step of array(plan?.steps)){
    if(!["command","tests"].includes(step?.kind)||!String(step?.command||"").trim())continue;
    const match=[...commands].reverse().find(item=>commandMatches(item.command,step.command));if(!match)continue;
    evidence.push({stepId:step.id,status:match.exitCode===0?"passed":"failed",exitCode:match.exitCode,source:match.source,toolCallId:match.id});
  }
  return evidence;
}
