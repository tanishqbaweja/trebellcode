import React from "react";
import { ShieldCheck } from "lucide-react";
import { guardianActionSummary } from "../guardian-review.js";

// The approval a harness waits on, and an action auto review denied, as App shows them in the conversation and on the Runtime tab.
// App loads them with the first one instead of with the app (B11).

// threadLabel names the task that asked when it is not the open thread, so nobody approves a command without knowing whose it is.
export function ApprovalCard({request,onResolve,threadLabel=""}){
  if(!request)return null;
  const p=request.params||{};
  const permissions=request.method==="item/permissions/requestApproval";
  const network=permissions?p.permissions?.network:null;const fileSystem=permissions?p.permissions?.fileSystem:null;
  const title=permissions?"Additional access requested":request.method.includes("fileChange")||request.method==="applyPatchApproval"?"File changes need approval":p.networkApprovalContext?.host?"Network access needs approval":"Command needs approval";
  // The command is shown even when the harness gives a reason, so nobody approves "Run the tests" without seeing what runs.
  const commandText=Array.isArray(p.command)?p.command.map(part=>String(part)).join(" "):typeof p.command==="string"?p.command:"";
  const networkTarget=p.networkApprovalContext?.host?`${p.networkApprovalContext.protocol||"network"}://${p.networkApprovalContext.host}`:"";
  const detail=permissions?[network&&"Network access",fileSystem&&"Filesystem access"].filter(Boolean).join(" + "):(networkTarget||p.reason||commandText||p.path||request.method);
  const showCommand=!permissions&&Boolean(commandText.trim())&&detail!==commandText;
  const approvalOptions=Array.isArray(p.approvalOptions)?p.approvalOptions.filter(option=>option&&typeof option.decision==="string"&&option.label):[];
  return <div className="approval-card"><div className="card-title"><ShieldCheck size={16}/><strong>{title}</strong></div>{threadLabel&&<p className="approval-thread" data-testid="approval-thread">Waiting in {threadLabel}</p>}<p>{detail||p.reason||request.method}</p>{showCommand&&<pre className="approval-command" data-testid="approval-command"><code>{commandText}</code></pre>}{permissions&&<pre className="approval-permissions">{JSON.stringify(p.permissions||{},null,2)}</pre>}{approvalOptions.filter(option=>option.warning).map(option=><small key={"warning-"+option.decision}>{option.label}: {option.warning}</small>)}<div className="approval-actions">{approvalOptions.length
    // An ACP harness's own choices, in its order and wording (T3 grokApprovalOptions / antigravityApprovalOptions).
    ?approvalOptions.map(option=><button key={option.decision} className={option.decision==="accept"?"approve":undefined} onClick={()=>onResolve(request,option.decision)}>{option.label}</button>)
    :<><button onClick={()=>onResolve(request,"decline")}>Deny</button><button onClick={()=>onResolve(request,"acceptForSession")}>Allow session</button><button className="approve" onClick={()=>onResolve(request,"accept")}>Allow once</button></>}</div></div>;
}
export function GuardianDenialCard({review,busy,onApprove,onDismiss}){
  if(!review)return null;
  const detail=guardianActionSummary(review.action||{});
  const risk=review.review?.riskLevel;
  return <div className="approval-card guardian-denial-card" data-testid="guardian-denial-card"><div className="card-title"><ShieldCheck size={16}/><strong>Auto review denied this action</strong></div><p>{detail}</p>{review.review?.rationale&&<p>{review.review.rationale}</p>}{risk&&<small>Risk assessment: {risk}</small>}<div className="approval-actions"><button onClick={()=>onDismiss(review)} disabled={busy}>Dismiss</button><button className="approve" onClick={()=>onApprove(review)} disabled={busy}>{busy?"Allowing…":"Allow anyway"}</button></div></div>;
}
