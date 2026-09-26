const SOURCE_EXTENSIONS=/\.(?:[cm]?[jt]sx?|pyi?|go)$/i;

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

function browserReceipts(traces=[]){
  const rows=[];
  for(const trace of array(traces)){
    if(trace?.name!=="verification.browser_evidence")continue;
    const data=trace?.data;if(!data||data.namespace!=="trebell_browser"||!String(data.tool||"").trim())continue;
    rows.push(data);
  }
  return rows.slice(-120);
}

function browserEvidence(plan,traces=[]){
  const receipts=browserReceipts(traces);if(!receipts.length)return [];
  const evidence=[];
  for(const step of array(plan?.steps)){
    if(step?.kind==="browser"){
      const interactions=receipts.filter(item=>item.interaction===true);if(!interactions.length)continue;
      const latest=interactions.at(-1),passed=latest.success!==false&&latest.passed!==false;
      evidence.push({stepId:step.id,status:passed?"passed":"failed",passed,source:"browser-receipt",interactionCount:interactions.length,toolCallIds:interactions.map(item=>item.callId).filter(Boolean).slice(-40)});
      continue;
    }
    if(step?.kind==="browser-runtime"){
      const latest=receipts.filter(item=>item.tool==="runtime").at(-1);if(!latest)continue;
      if(latest.success===false){evidence.push({stepId:step.id,status:"failed",source:"browser-receipt",toolCallId:latest.callId||null});continue}
      evidence.push({stepId:step.id,status:"passed",consoleErrorCount:Math.max(0,Number(latest.consoleErrorCount)||0),networkFailureCount:Math.max(0,Number(latest.networkFailureCount)||0),source:"browser-receipt",toolCallId:latest.callId||null});
      continue;
    }
    if(step?.kind==="visual"){
      const screenshots=receipts.filter(item=>item.tool==="screenshot"&&item.success!==false&&item.screenshot===true),viewportKeys=new Set();
      for(const item of screenshots){const width=Number(item.width),height=Number(item.height);if(width>0&&height>0)viewportKeys.add(`${Math.trunc(width)}x${Math.trunc(height)}`)}
      const viewports=viewportKeys.size,viewportCalls=receipts.filter(item=>{
        if(item.tool!=="set_viewport"||item.success===false)return false;
        const width=Number(item.width),height=Number(item.height);return width>0&&height>0&&viewportKeys.has(`${Math.trunc(width)}x${Math.trunc(height)}`);
      });
      if(!screenshots.length&&!viewports)continue;
      evidence.push({stepId:step.id,screenshots:screenshots.length,viewports,source:"browser-receipt",toolCallIds:[...screenshots,...viewportCalls].map(item=>item.callId).filter(Boolean).slice(-40)});
    }
  }
  return evidence;
}

export function collectVerificationEvidence({plan,turnItems=[],traces=[]}={}){
  const evidence=[],diagnostics=diagnosticsEvidence(plan,turnItems);if(diagnostics)evidence.push(diagnostics);
  const commands=commandCandidates(turnItems,traces);
  for(const step of array(plan?.steps)){
    if(!["command","tests"].includes(step?.kind)||!String(step?.command||"").trim())continue;
    const match=[...commands].reverse().find(item=>commandMatches(item.command,step.command));if(!match)continue;
    evidence.push({stepId:step.id,status:match.exitCode===0?"passed":"failed",exitCode:match.exitCode,source:match.source,toolCallId:match.id});
  }
  evidence.push(...browserEvidence(plan,traces));
  return evidence;
}
