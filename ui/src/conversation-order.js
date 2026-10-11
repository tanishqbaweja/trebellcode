// The latest turn reads top-down: its user message, the activity card, then its reply. The rows that move below the card start
// after the last user message, past any row of an earlier turn: a turn that starts without a new message (a goal continuation)
// leaves the previous turn's reply above its card. -1 when no row moves.
export function latestTurnRowsStart(messages=[],cardTurnId=null){
  const list=messages||[];
  let start=list.length;
  while(start>0&&list[start-1]?.role!=="user")start--;
  const card=cardTurnId==null?"":String(cardTurnId);
  if(card)while(start<list.length&&list[start]?.turnId&&String(list[start].turnId)!==card)start++;
  return start<list.length?start:-1;
}
