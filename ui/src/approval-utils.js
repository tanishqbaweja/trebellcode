export function approvalResponse(request,decision){
  if(request?.method==="item/permissions/requestApproval")return {permissions:decision==="decline"?{}:(request.params?.permissions||{}),scope:decision==="acceptForSession"?"session":"turn"};
  if(request?.method==="applyPatchApproval"||request?.method==="execCommandApproval")return {decision:decision==="decline"?{denied:{rejection:"rejected by user"}}:decision==="acceptForSession"?"approved_for_session":"approved"};
  return {decision};
}

// The second click of a double click whose first answered a request lands on the next request, which comes up in its place under the
// pointer. The browser counts it a click of its own (detail 1) once the pointer moved a few pixels between the clicks, so the next
// request takes no click near the one that answered (24 px) within the double-click time (500 ms, the Windows default). A key press
// clicks with detail 0 and is left alone: the next request's controls do not have the focus.
let lastAnswer=null;
export function answeringClick(event){
  if(!(event?.detail>0))return true;
  const {clientX:x,clientY:y,timeStamp:at}=event;
  if(lastAnswer&&at-lastAnswer.at<500&&Math.hypot(x-lastAnswer.x,y-lastAnswer.y)<24)return false;
  lastAnswer={x,y,at};return true;
}
