import React from "react";
import { ShieldCheck } from "lucide-react";
import { guardianActionSummary } from "../guardian-review.js";

// An action auto review denied, as App shows it in the conversation. App loads it with the first denial instead of with the app
// (B11); the approval card a harness waits on stays in App. Allow anyway sends the event built here, which is loaded once this
// card shows, so App takes it from this module.
export { guardianDeniedEvent } from "../guardian-denied-event.js";
export default function GuardianDenialCard({review,busy,onApprove,onDismiss}){
  if(!review)return null;
  const detail=guardianActionSummary(review.action||{});
  const risk=review.review?.riskLevel;
  return <div className="approval-card guardian-denial-card" data-testid="guardian-denial-card"><div className="card-title"><ShieldCheck size={16}/><strong>Auto review denied this action</strong></div><p>{detail}</p>{review.review?.rationale&&<p>{review.review.rationale}</p>}{risk&&<small>Risk assessment: {risk}</small>}<div className="approval-actions"><button onClick={()=>onDismiss(review)} disabled={busy}>Dismiss</button><button className="approve" onClick={()=>onApprove(review)} disabled={busy}>{busy?"Allowing…":"Allow anyway"}</button></div></div>;
}
