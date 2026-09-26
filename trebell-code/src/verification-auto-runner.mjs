import { mergeVerificationEvidence, nextVerificationAction } from "./verification-loop.mjs";

const DIAGNOSTIC_SOURCE=/\.(?:[cm]?[jt]sx?)$/i;

function array(value){return Array.isArray(value)?value:[]}
function slash(value){return String(value||"").replace(/\\/g,"/")}
function errorDiagnostics(value){return array(value).filter(item=>String(item?.severity||"error").toLowerCase()==="error")}
function boundedReason(value){return String(value||"").trim().slice(0,1200)}

export async function runAutomaticVerificationEvidence({contextEngine,plan,evidence=[],root,io=null,limit=100}={}){
  if(!contextEngine||typeof contextEngine.diagnostics!=="function")return {evidence:array(evidence),attempted:[],nextAction:nextVerificationAction({plan,evidence})};
  const initial=array(evidence),next=nextVerificationAction({plan,evidence:initial}),step=next?.nextStep;
  if(next.action!=="verify"||step?.kind!=="diagnostics")return {evidence:initial,attempted:[],nextAction:next};
  const targets=[...new Set(array(plan?.paths).map(slash).filter(path=>DIAGNOSTIC_SOURCE.test(path)))].slice(0,80);
  if(!targets.length){
    const update={stepId:step.id,status:"blocked",reason:"No changed JavaScript/TypeScript source paths were available for deterministic diagnostics.",source:"harness-diagnostics",coveredPaths:[]};
    const merged=mergeVerificationEvidence(initial,[update]);return {evidence:merged,attempted:[update],nextAction:nextVerificationAction({plan,evidence:merged})};
  }
  const attempted=[],engines=new Set();let errorCount=0,blockedReason="";
  for(const path of targets){
    try{
      const result=await contextEngine.diagnostics({root,path,limit,semantic:Boolean(step.semantic),io});
      if(!result?.supported){blockedReason=boundedReason(result?.reason||`Deterministic diagnostics are unavailable for ${path}.`);attempted.push({path,status:"blocked",engine:result?.engine||null});break}
      const errors=errorDiagnostics(result.diagnostics).length+errorDiagnostics(result.semanticDiagnostics).length;errorCount+=errors;if(result.engine)engines.add(String(result.engine));if(result.semanticEngine)engines.add(String(result.semanticEngine));attempted.push({path,status:errors?"failed":"passed",engine:result.engine||null,semanticEngine:result.semanticEngine||null,errorCount:errors});
    }catch(error){blockedReason=boundedReason(error?.message||error);attempted.push({path,status:"blocked",engine:null});break}
  }
  const update=blockedReason
    ?{stepId:step.id,status:"blocked",reason:blockedReason,source:"harness-diagnostics",coveredPaths:attempted.map(item=>item.path)}
    :{stepId:step.id,status:errorCount===0?"passed":"failed",errorCount,source:"harness-diagnostics",coveredPaths:targets,engines:[...engines].slice(0,10),semantic:Boolean(step.semantic)};
  const merged=mergeVerificationEvidence(initial,[update]);return {evidence:merged,attempted,nextAction:nextVerificationAction({plan,evidence:merged})};
}
