const STATUSES=new Set(["active","paused","complete"]);
const NON_TOOL_ITEM_TYPES=new Set(["usermessage","agentmessage","reasoning","reasoningmessage","plan","image","localimage"]);

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
function positiveNumber(value,{max=1_000_000}={}){
  if(value==null||value==="")return null;
  const number=Number(value);if(!Number.isFinite(number)||number<=0)throw new Error("Goal cost budget must be a positive number");
  return Math.min(max,number);
}
export function isToolCallItem(item){
  const type=String(item?.type||"").trim().toLowerCase();if(!type||NON_TOOL_ITEM_TYPES.has(type))return false;
  return type==="commandexecution"||type==="filechange"||type==="websearch"||type==="imagegeneration"||type==="computertoolcall"||type==="collabagenttoolcall"||type==="dynamictoolcall"||type==="mcptoolcall"||type.endsWith("toolcall");
}
function toolCallsFromTurns(turns=[]){
  const seen=new Set();let anonymous=0;
  for(const turn of turns)for(const item of Array.isArray(turn?.items)?turn.items:[]){
    if(!isToolCallItem(item))continue;
    const id=item?.id==null?"":String(item.id);if(id)seen.add(String(turn?.id||"")+":"+id);else anonymous++;
  }
  return seen.size+anonymous;
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
    turnBudget:Object.prototype.hasOwnProperty.call(patch,"turnBudget")?positiveInteger(patch.turnBudget,{max:500}):positiveInteger(prior.turnBudget,{max:500}),
    toolCallBudget:Object.prototype.hasOwnProperty.call(patch,"toolCallBudget")?positiveInteger(patch.toolCallBudget,{max:1000}):positiveInteger(prior.toolCallBudget,{max:1000}),
    childAgentBudget:Object.prototype.hasOwnProperty.call(patch,"childAgentBudget")?positiveInteger(patch.childAgentBudget,{max:100}):positiveInteger(prior.childAgentBudget,{max:100}),
    costBudgetUsd:Object.prototype.hasOwnProperty.call(patch,"costBudgetUsd")?positiveNumber(patch.costBudgetUsd):positiveNumber(prior.costBudgetUsd),
    createdAt,updatedAt:now,
    ...(status==="complete"?{completedAt:Number(prior.completedAt)||now}:{completedAt:null}),
  };
}

export function enrichGoal(goal,{usage=null,turns=[],toolCallsUsed=null,toolCallTelemetryComplete=true,childAgentsUsed=null,childAgentTelemetryComplete=false,now=Date.now()}={}){
  if(!goal)return null;
  const sinceSeconds=Math.floor((Number(goal.createdAt)||0)/1000),relevantTurns=(Array.isArray(turns)?turns:[]).filter(turn=>{
    const started=Number(turn?.startedAt)||0;return started&&started>=sinceSeconds;
  }),timeMs=relevantTurns.reduce((total,turn)=>{
    const started=Number(turn?.startedAt)||0;
    const hasDuration=turn?.durationMs!=null,duration=Number(turn?.durationMs);if(hasDuration&&Number.isFinite(duration)&&duration>=0)return total+duration;
    if(turn?.status==="inProgress")return total+Math.max(0,now-started*1000);
    const completed=Number(turn?.completedAt)||0;return total+(completed?Math.max(0,(completed-started)*1000):0);
  },0);
  const tokensUsed=Math.max(0,Number(usage?.totalTokens)||0),timeUsedSeconds=Math.floor(timeMs/1000),turnsUsed=relevantTurns.length;
  const derivedToolCalls=toolCallsFromTurns(relevantTurns),resolvedToolCalls=toolCallsUsed==null?derivedToolCalls:Math.max(0,Number(toolCallsUsed)||0),resolvedChildAgents=childAgentsUsed==null?null:Math.max(0,Number(childAgentsUsed)||0);
  const tokenBudget=Number(goal.tokenBudget)||null,timeBudgetMinutes=Number(goal.timeBudgetMinutes)||null,turnBudget=Number(goal.turnBudget)||null,toolCallBudget=Number(goal.toolCallBudget)||null,childAgentBudget=Number(goal.childAgentBudget)||null,costBudgetUsd=Number(goal.costBudgetUsd)||null;
  const usageRecords=Math.max(0,Number(usage?.records??usage?.turns)||0),costKnown=Math.max(0,Number(usage?.costKnown)||0),knownCost=Math.max(0,Number(usage?.costUsd)||0);
  const costUsedUsd=costKnown>0?knownCost:null,costTelemetryComplete=turnsUsed===0||(usageRecords>=turnsUsed&&costKnown>=turnsUsed);
  const tokenExhausted=tokenBudget!=null&&tokensUsed>=tokenBudget,timeExhausted=timeBudgetMinutes!=null&&timeUsedSeconds>=timeBudgetMinutes*60,turnExhausted=turnBudget!=null&&turnsUsed>=turnBudget;
  const toolCallExhausted=toolCallBudget!=null&&toolCallTelemetryComplete&&resolvedToolCalls>=toolCallBudget,childAgentExhausted=childAgentBudget!=null&&childAgentTelemetryComplete&&resolvedChildAgents!=null&&resolvedChildAgents>=childAgentBudget;
  const costExhausted=costBudgetUsd!=null&&costTelemetryComplete&&costUsedUsd!=null&&costUsedUsd>=costBudgetUsd;
  return {
    ...goal,tokensUsed,timeUsedSeconds,turnsUsed,toolCallsUsed:resolvedToolCalls,toolCallTelemetryComplete:Boolean(toolCallTelemetryComplete),childAgentsUsed:resolvedChildAgents,childAgentTelemetryComplete:Boolean(childAgentTelemetryComplete),costUsedUsd,costTelemetryComplete,
    tokenBudgetRemaining:tokenBudget==null?null:Math.max(0,tokenBudget-tokensUsed),
    timeBudgetRemainingMinutes:timeBudgetMinutes==null?null:Math.max(0,timeBudgetMinutes-timeUsedSeconds/60),
    turnBudgetRemaining:turnBudget==null?null:Math.max(0,turnBudget-turnsUsed),
    toolCallBudgetRemaining:toolCallBudget==null?null:Math.max(0,toolCallBudget-resolvedToolCalls),
    childAgentBudgetRemaining:childAgentBudget==null||resolvedChildAgents==null?null:Math.max(0,childAgentBudget-resolvedChildAgents),
    costBudgetRemainingUsd:costBudgetUsd==null||costUsedUsd==null?null:Math.max(0,costBudgetUsd-costUsedUsd),
    budgetExceeded:Boolean((tokenBudget!=null&&tokensUsed>tokenBudget)||(timeBudgetMinutes!=null&&timeUsedSeconds>timeBudgetMinutes*60)||(turnBudget!=null&&turnsUsed>turnBudget)||(toolCallBudget!=null&&toolCallTelemetryComplete&&resolvedToolCalls>toolCallBudget)||(childAgentBudget!=null&&childAgentTelemetryComplete&&resolvedChildAgents!=null&&resolvedChildAgents>childAgentBudget)||(costBudgetUsd!=null&&costTelemetryComplete&&costUsedUsd!=null&&costUsedUsd>costBudgetUsd)),
    budgetExhausted:Boolean(tokenExhausted||timeExhausted||turnExhausted||toolCallExhausted||childAgentExhausted||costExhausted),
  };
}

export function goalBudgetGate(goal){
  const allowedResult={allowed:true,reason:null,tokenExhausted:false,timeExhausted:false,turnExhausted:false,toolCallExhausted:false,childAgentExhausted:false,costExhausted:false,toolCallTelemetryComplete:goal?.toolCallTelemetryComplete!==false,childAgentTelemetryComplete:goal?.childAgentTelemetryComplete===true,costTelemetryComplete:goal?.costTelemetryComplete!==false};
  if(!goal||goal.status!=="active")return allowedResult;
  const tokenBudget=Number(goal.tokenBudget)||null,timeBudgetMinutes=Number(goal.timeBudgetMinutes)||null,turnBudget=Number(goal.turnBudget)||null,toolCallBudget=Number(goal.toolCallBudget)||null,childAgentBudget=Number(goal.childAgentBudget)||null,costBudgetUsd=Number(goal.costBudgetUsd)||null;
  const tokensUsed=Math.max(0,Number(goal.tokensUsed)||0),timeUsedSeconds=Math.max(0,Number(goal.timeUsedSeconds)||0),turnsUsed=Math.max(0,Number(goal.turnsUsed)||0),toolCallsUsed=Math.max(0,Number(goal.toolCallsUsed)||0),childAgentsUsed=goal.childAgentsUsed==null?null:Math.max(0,Number(goal.childAgentsUsed)||0),costUsedUsd=goal.costUsedUsd==null?null:Math.max(0,Number(goal.costUsedUsd)||0);
  const toolCallTelemetryComplete=goal.toolCallTelemetryComplete!==false,childAgentTelemetryComplete=goal.childAgentTelemetryComplete===true,costTelemetryComplete=goal.costTelemetryComplete!==false;
  const tokenExhausted=tokenBudget!=null&&tokensUsed>=tokenBudget,timeExhausted=timeBudgetMinutes!=null&&timeUsedSeconds>=timeBudgetMinutes*60,turnExhausted=turnBudget!=null&&turnsUsed>=turnBudget,toolCallExhausted=toolCallBudget!=null&&toolCallTelemetryComplete&&toolCallsUsed>=toolCallBudget,childAgentExhausted=childAgentBudget!=null&&childAgentTelemetryComplete&&childAgentsUsed!=null&&childAgentsUsed>=childAgentBudget,costExhausted=costBudgetUsd!=null&&costTelemetryComplete&&costUsedUsd!=null&&costUsedUsd>=costBudgetUsd;
  if(!tokenExhausted&&!timeExhausted&&!turnExhausted&&!toolCallExhausted&&!childAgentExhausted&&!costExhausted)return {...allowedResult,toolCallTelemetryComplete,childAgentTelemetryComplete,costTelemetryComplete};
  const reasons=[];
  if(tokenExhausted)reasons.push(`token budget exhausted (${tokensUsed}/${tokenBudget})`);
  if(timeExhausted)reasons.push(`time budget exhausted (${Math.ceil(timeUsedSeconds/60)}/${timeBudgetMinutes} min)`);
  if(turnExhausted)reasons.push(`turn budget exhausted (${turnsUsed}/${turnBudget})`);
  if(toolCallExhausted)reasons.push(`tool-call budget exhausted (${toolCallsUsed}/${toolCallBudget})`);
  if(childAgentExhausted)reasons.push(`child-agent budget exhausted (${childAgentsUsed}/${childAgentBudget})`);
  if(costExhausted)reasons.push(`cost budget exhausted ($${costUsedUsd.toFixed(4)}/$${costBudgetUsd.toFixed(4)})`);
  return {allowed:false,reason:`Goal budget exhausted: ${reasons.join("; ")}. Increase the exhausted budget or pause, complete, or clear the goal before starting another turn.`,tokenExhausted,timeExhausted,turnExhausted,toolCallExhausted,childAgentExhausted,costExhausted,toolCallTelemetryComplete,childAgentTelemetryComplete,costTelemetryComplete};
}
