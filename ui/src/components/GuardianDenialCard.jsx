import React from "react";
import { ShieldCheck } from "lucide-react";
import { guardianActionSummary } from "../guardian-review.js";
import { guardianDeniedEvent } from "../guardian-denied-event.js";

// An action auto review denied, as App shows it in the conversation. App loads it with the first denial instead of with the app
// (B11); the approval card a harness waits on stays in App. Allow anyway sends the event built here, which is loaded once this
// card shows, so App takes it from this module, and with it the override itself (approveGuardianDenial): only this card asks for it.
export { guardianDeniedEvent };
// Allow anyway: Codex is asked to let the denied action run after all (thread/approveGuardianDeniedAction), the card goes once it
// has, and a row says so in the conversation; one that fails says why there. busy: the denial whose override is on its way.
export async function approveGuardianDenial({rpc,guardianBusy,setGuardianBusy,setGuardianDenials,setEvents},review){
  if(!rpc||!review?.threadId||guardianBusy)return;
  const reviewId=String(review.reviewId||crypto.randomUUID());setGuardianBusy(reviewId);
  try{
    await rpc.request("thread/approveGuardianDeniedAction",{threadId:review.threadId,event:guardianDeniedEvent(review)});
    setGuardianDenials(prev=>prev.filter(item=>item.reviewId!==review.reviewId));
    setEvents(prev=>[...prev,{id:"auto-review-override-"+Date.now(),kind:"autoReview",title:"Auto review denial overridden by user",status:"done",raw:{reviewId:review.reviewId}}]);
  }catch(error){
    setEvents(prev=>[...prev,{id:"auto-review-override-error-"+Date.now(),kind:"error",title:"Could not override auto review: "+(error.message||String(error)),status:"done",raw:{reviewId:review.reviewId}}]);
  }finally{setGuardianBusy("")}
}
export default function GuardianDenialCard({review,busy,onApprove,onDismiss}){
  if(!review)return null;
  const detail=guardianActionSummary(review.action||{});
  const risk=review.review?.riskLevel;
  return <div className="approval-card guardian-denial-card" data-testid="guardian-denial-card"><div className="card-title"><ShieldCheck size={16}/><strong>Auto review denied this action</strong></div><p>{detail}</p>{review.review?.rationale&&<p>{review.review.rationale}</p>}{risk&&<small>Risk assessment: {risk}</small>}<div className="approval-actions"><button onClick={()=>onDismiss(review)} disabled={busy}>Dismiss</button><button className="approve" onClick={()=>onApprove(review)} disabled={busy}>{busy?"Allowing…":"Allow anyway"}</button></div></div>;
}
