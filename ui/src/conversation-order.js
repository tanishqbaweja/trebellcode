// The latest turn reads top-down: its user message, the activity card, then its reply. The rows that move below the card start
// after the last user message, past any row of an earlier turn: a turn that starts without a new message (a goal continuation)
// leaves the previous turn's reply above its card, and a card of no turn (a send that has no turn yet, or a notice of none, as a
// send its own file check refused) leaves every turn's rows above it. A message still waiting to be sent (waits: the automatic
// compaction before it runs) moves below the card of a turn that runs meanwhile, which comes before it (Codex's or Grok's
// compaction, a turn of its own). -1 when no row moves.
export function latestTurnRowsStart(messages=[],cardTurnId=null){
  const list=messages||[];
  let start=list.length;
  while(start>0&&list[start-1]?.role!=="user")start--;
  const card=cardTurnId==null?"":String(cardTurnId);
  if(card&&list[start-1]?.waits)start--;
  while(start<list.length&&list[start]?.turnId&&String(list[start].turnId)!==card)start++;
  return start<list.length?start:-1;
}
