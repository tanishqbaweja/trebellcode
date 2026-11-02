// A finished tool keeps its own outcome: Codex items end completed, failed or declined, and harness tool updates end completed or
// failed (a denied, disabled or unavailable tool reports failed). A harness's call its stopped or failed turn cut off while it was still
// pending ends stopped (agent-relay.mjs finishTurn), which it keeps too. Any other item counts as completed.
const KEPT_ITEM_STATUSES=new Set(["failed","declined","stopped"]);

export function completedItemStatus(item){
  return KEPT_ITEM_STATUSES.has(item?.status)?item.status:"completed";
}

// A timeline row that did not succeed: error events and failed tools share the error styling, while the row keeps its own status
// text. A step that did not run because it was not allowed (declined, or not allowed by the access level) did not fail: it reads as
// what happened, in the row's usual colors, and its turn's card does not count it among the failed steps.
export function toolEventFailed(event){
  return event?.kind==="error"||event?.status==="error"||event?.status==="failed";
}
