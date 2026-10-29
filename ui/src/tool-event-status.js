// A finished tool keeps its own outcome: Codex items end completed, failed or declined, and harness tool updates end completed or
// failed (a denied, disabled or unavailable tool reports failed). A harness's call its stopped or failed turn cut off while it was still
// pending ends stopped (agent-relay.mjs finishTurn), which it keeps too. Any other item counts as completed.
const FAILED_ITEM_STATUSES=new Set(["failed","declined"]);

export function completedItemStatus(item){
  return FAILED_ITEM_STATUSES.has(item?.status)||item?.status==="stopped"?item.status:"completed";
}

// A timeline row that did not succeed: error events and failed or declined tools share the error styling, while the row keeps
// its own status text.
export function toolEventFailed(event){
  return event?.kind==="error"||event?.status==="error"||FAILED_ITEM_STATUSES.has(event?.status);
}
