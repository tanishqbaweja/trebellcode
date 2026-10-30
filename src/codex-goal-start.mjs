// The first turn of a Codex goal asks Codex for the work: sent alone, the objective reads like a statement, and
// the model echoed it back. Only Codex gets these words. The person's message, its checkpoint and the thread's title keep the
// objective as it was typed, also once Codex's own record of the message (its history, the thread's preview) is read back.
export const CODEX_GOAL_START="Start working toward this goal: ";

// A message Codex was sent, in the person's words: without the goal start before its objective.
export function withoutCodexGoalStart(text){
  const value=String(text??"");
  return value.startsWith(CODEX_GOAL_START)&&value.length>CODEX_GOAL_START.length?value.slice(CODEX_GOAL_START.length):value;
}
