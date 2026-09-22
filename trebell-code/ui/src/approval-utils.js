export function approvalResponse(request,decision){
  if(request?.method==="item/permissions/requestApproval")return {permissions:decision==="decline"?{}:(request.params?.permissions||{}),scope:decision==="acceptForSession"?"session":"turn"};
  if(request?.method==="applyPatchApproval"||request?.method==="execCommandApproval")return {decision:decision==="decline"?{denied:{rejection:"rejected by user"}}:decision==="acceptForSession"?"approved_for_session":"approved"};
  return {decision};
}
