import { assessVerification } from "./verification-assessor.mjs";

const COST_ORDER=Object.freeze({low:0,medium:1,high:2});

function array(value){return Array.isArray(value)?value:[]}

export function mergeVerificationEvidence(existing=[],updates=[]){
  const map=new Map(),order=[];
  for(const entry of [...array(existing),...array(updates)]){
    const id=String(entry?.stepId||entry?.id||"").trim();if(!id)continue;
    if(!map.has(id))order.push(id);
    map.set(id,{...(map.get(id)||{}),...entry,stepId:id});
  }
  return order.map(id=>map.get(id));
}
export function nextVerificationAction({plan,evidence=[]}={}){
  const assessment=assessVerification({plan,evidence}),steps=array(plan?.steps);
  if(assessment.status==="failed")return {
    action:"repair",assessment,
    failedSteps:assessment.failures.map(item=>item.id),
    reason:"Required verification failed; repair the same work before spending more verification effort.",
    reviewRecommended:Boolean(plan?.independentReview),
  };
  if(assessment.status==="blocked")return {
    action:"resolve_blocker",assessment,
    blockedSteps:assessment.blocked.map(item=>item.id),
    reason:"Required verification is blocked; resolve the blocker before continuing.",
    reviewRecommended:Boolean(plan?.independentReview),
  };
  if(assessment.status==="incomplete"){
    const missing=new Set(assessment.missing.map(item=>item.id)),candidates=steps.filter(step=>step.required!==false&&missing.has(step.id));
    const next=candidates.map((step,index)=>({step,index,cost:COST_ORDER[step.cost]??1})).sort((a,b)=>a.cost-b.cost||a.index-b.index)[0]?.step||null;
    return {
      action:"verify",assessment,nextStep:next,
      remainingSteps:candidates.map(step=>step.id),
      reason:next?"Run the cheapest remaining required verification step.":"Required evidence is incomplete but no runnable planned step remains.",
      reviewRecommended:Boolean(plan?.independentReview),
    };
  }
  return {
    action:"complete",assessment,nextStep:null,remainingSteps:[],
    reason:"All required verification evidence passed.",
    reviewRecommended:Boolean(plan?.independentReview),
  };
}

\n