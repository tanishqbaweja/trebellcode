const STATUSES=new Set(["active","paused","complete"]);

function text(value,max){return String(value??"").trim().slice(0,max)}
function list(value,{limit=20,max=1200}={}){
  const source=Array.isArray(value)?value:typeof value==="string"?value.split(/\r?\n/):[];
  return source.map(item=>text(item,max)).filter(Boolean).slice(0,limit);
}
function positiveInteger(value,{max=1_000_000_000}={}){
  if(value==null||value==="")return null;
  const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error("Goal budget must be a positive whole number");
  return Math.min(max,number);
}

export function normalizeGoal({threadId,previous=null,patch={},now=Date.now()}={}){
  const prior=previous&&typeof previous==="object"?previous:{},objective=Object.prototype.hasOwnProperty.call(patch,"objective")?text(patch.objective,4000):text(prior.objective,4000);
  if(!objective)throw new Error("Goal objective is required");
  const requestedStatus=Object.prototype.hasOwnProperty.call(patch,"status")?String(patch.status||"").trim().toLowerCase():String(prior.status||"active").toLowerCase(),status=STATUSES.has(requestedStatus)?requestedStatus:"active";
  const createdAt=Number(prior.createdAt)||now;
  return {
    threadId:String(threadId||prior.threadId||""),objective,status,
    completionConditions:Object.prototype.hasOwnProperty.call(patch,"completionConditions")?list(patch.completionConditions):list(prior.completionConditions),
    constraints:Object.prototype.hasOwnProperty.call(patch,"constraints")?list(patch.constraints):list(prior.constraints),
    validationExpectations:Object.prototype.hasOwnProperty.call(patch,"validationExpectations")?list(patch.validationExpectations):list(prior.validationExpectations),
    tokenBudget:Object.prototype.hasOwnProperty.call(patch,"tokenBudget")?positiveInteger(patch.tokenBudget):positiveInteger(prior.tokenBudget),
    timeBudgetMinutes:Object.prototype.hasOwnProperty.call(patch,"timeBudgetMinutes")?positiveInteger(patch.timeBudgetMinutes,{max:525_600}):positiveInteger(prior.timeBudgetMinutes,{max:525_600}),
    createdAt,updatedAt:now,
    ...(status==="complete"?{completedAt:Number(prior.completedAt)||now}:{completedAt:null}),
  };
}

export function enrichGoal(goal,{usage=null,turns=[],now=Date.now()}={}){
  if(!goal)return null;
  const sinceSeconds=Math.floor((Number(goal.createdAt)||0)/1000),timeMs=(Array.isArray(turns)?turns:[]).reduce((total,turn)=>{
    const started=Number(turn?.startedAt)||0;if(!started||started<sinceSeconds)return total;
    const hasDuration=turn?.durationMs!=null,duration=Number(turn?.durationMs);if(hasDuration&&Number.isFinite(duration)&&duration>=0)return total+duration;
    if(turn?.status==="inProgress")return total+Math.max(0,now-started*1000);
    const completed=Number(turn?.completedAt)||0;return total+(completed?Math.max(0,(completed-started)*1000):0);
  },0);
  const tokensUsed=Math.max(0,Number(usage?.totalTokens)||0),timeUsedSeconds=Math.floor(timeMs/1000),tokenBudget=Number(goal.tokenBudget)||null,timeBudgetMinutes=Number(goal.timeBudgetMinutes)||null;
  return {
    ...goal,tokensUsed,timeUsedSeconds,
    tokenBudgetRemaining:tokenBudget==null?null:Math.max(0,tokenBudget-tokensUsed),
    timeBudgetRemainingMinutes:timeBudgetMinutes==null?null:Math.max(0,timeBudgetMinutes-timeUsedSeconds/60),
    budgetExceeded:Boolean((tokenBudget!=null&&tokensUsed>tokenBudget)||(timeBudgetMinutes!=null&&timeUsedSeconds>timeBudgetMinutes*60)),
    budgetExhausted:Boolean((tokenBudget!=null&&tokensUsed>=tokenBudget)||(timeBudgetMinutes!=null&&timeUsedSeconds>=timeBudgetMinutes*60)),
  };
}

export function goalBudgetGate(goal){
  if(!goal||goal.status!=="active")return {allowed:true,reason:null,tokenExhausted:false,timeExhausted:false};
  const tokenBudget=Number(goal.tokenBudget)||null,timeBudgetMinutes=Number(goal.timeBudgetMinutes)||null,tokensUsed=Math.max(0,Number(goal.tokensUsed)||0),timeUsedSeconds=Math.max(0,Number(goal.timeUsedSeconds)||0);
  const tokenExhausted=tokenBudget!=null&&tokensUsed>=tokenBudget,timeExhausted=timeBudgetMinutes!=null&&timeUsedSeconds>=timeBudgetMinutes*60;
  if(!tokenExhausted&&!timeExhausted)return {allowed:true,reason:null,tokenExhausted:false,timeExhausted:false};
  const reasons=[];if(tokenExhausted)reasons.push(`token budget exhausted (${tokensUsed}/${tokenBudget})`);if(timeExhausted)reasons.push(`time budget exhausted (${Math.ceil(timeUsedSeconds/60)}/${timeBudgetMinutes} min)`);
  return {allowed:false,reason:`Goal budget exhausted: ${reasons.join("; ")}. Increase or clear the goal budget before starting another turn.`,tokenExhausted,timeExhausted};
}
