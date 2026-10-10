import { normalizeGoal } from "./goal-state.mjs";

// Codex threads use Codex's own goal (thread/goal/get, set, clear), as T3 Code's runGoalCommand does: Codex owns the
// objective, status and token budget and keeps working toward an active goal across turns. Trebell keeps its own
// guidance (completion conditions, constraints, validation expectations) and extra budgets next to Codex's goal.

export const CODEX_GOAL_STATUSES=Object.freeze(["active","paused","blocked","usageLimited","budgetLimited","complete"]);
// The statuses a user sets; blocked, usageLimited and budgetLimited are Codex's own outcomes.
const USER_STATUSES=new Set(["active","paused","complete"]);
const STATUS_BY_KEY=new Map(CODEX_GOAL_STATUSES.map(status=>[status.toLowerCase(),status]));

export function codexGoalStatus(value){
  return STATUS_BY_KEY.get(String(value??"").trim().toLowerCase())||null;
}

function own(object,key){return Boolean(object)&&Object.prototype.hasOwnProperty.call(object,key)}

// Codex reports goal times in seconds; Trebell goal records use milliseconds.
function epochMs(value){
  const number=Number(value);if(!Number.isFinite(number)||number<=0)return null;
  return Math.round(number<1e11?number*1000:number);
}

// The Trebell record of a Codex goal: Codex's objective, status, token budget, times and accounting, with Trebell's
// guidance and extra budgets from the previous record and the patch. `native` marks a record mirrored from Codex.
export function codexGoalRecord(goal,{threadId,previous=null,patch={}}={}){
  const objective=String(goal?.objective??"").trim();if(!objective)return null;
  const base=normalizeGoal({threadId:threadId||goal.threadId,previous,patch:{...(patch||{}),objective,status:"paused",tokenBudget:null}});
  const status=codexGoalStatus(goal.status)||"active",updatedAt=epochMs(goal.updatedAt)||Date.now();
  return {
    ...base,status,
    tokenBudget:Number.isInteger(goal.tokenBudget)&&goal.tokenBudget>0?goal.tokenBudget:null,
    createdAt:epochMs(goal.createdAt)||base.createdAt,updatedAt,
    completedAt:status==="complete"?(Number(previous?.completedAt)||updatedAt):null,
    native:{tokensUsed:Math.max(0,Number(goal.tokensUsed)||0),timeUsedSeconds:Math.max(0,Number(goal.timeUsedSeconds)||0)},
  };
}

// What a Trebell goal patch sends to Codex. `current` is Codex's goal, `next` the validated Trebell goal (normalizeGoal).
// A new objective replaces the goal and its accounting (T3 and the Codex TUI clear it first), keeping only what the patch
// sets; otherwise only the fields the patch changes go, and a status Codex set itself is left to Codex.
export function codexGoalSetParams({threadId,patch={},current=null,next}){
  const replace=Boolean(current)&&next.objective!==String(current.objective??"").trim();
  const created=!current||replace,params={threadId:String(threadId)};
  if(created)params.objective=next.objective;
  const requested=own(patch,"status")?codexGoalStatus(patch.status):(created?codexGoalStatus(next.status):null);
  if(own(patch,"status")&&!requested)throw Object.assign(new Error(`Unsupported goal status: ${patch.status}`),{code:-32602});
  if(requested&&USER_STATUSES.has(requested)&&(created||requested!==current.status))params.status=requested;
  const tokenBudgetSet=created?next.tokenBudget!=null&&(!replace||own(patch,"tokenBudget")):own(patch,"tokenBudget")&&next.tokenBudget!==(current.tokenBudget??null);
  if(tokenBudgetSet)params.tokenBudget=next.tokenBudget;
  return {replace,params};
}
