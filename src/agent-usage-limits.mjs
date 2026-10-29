function checkedAt(){return new Date().toISOString()}
function clampPercent(value){const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(100,number)):null}
function unavailable(reason="unsupported",message=null,at=checkedAt()){
  return {checkedAt:at,windows:[],unavailable:{reason,...(message?{message}:{})}};
}
function available(windows,at=checkedAt()){return {checkedAt:at,windows}}
function resetIso(value){
  if(value==null||value==="")return null;
  const numeric=Number(value);
  const date=Number.isFinite(numeric)&&numeric>0?new Date(numeric):new Date(String(value));
  return Number.isFinite(date.getTime())?date.toISOString():null;
}
export function cursorUsageResponseToLimits(response,at=checkedAt()){
  const usage=response?.planUsage&&typeof response.planUsage==="object"?response.planUsage:null;
  const resetsAt=resetIso(response?.billingCycleEnd);const windows=[];
  for(const [id,label] of [["totalPercentUsed","Monthly"],["autoPercentUsed","Monthly · Auto"],["apiPercentUsed","Monthly · API"]]){
    const usedPercent=clampPercent(usage?.[id]);if(usedPercent==null)continue;
    windows.push({id,kind:"monthly",label,usedPercent,...(resetsAt?{resetsAt}:{})});
  }
  return windows.length?available(windows,at):unavailable("unsupported",null,at);
}

function periodBoundary(value){
  if(typeof value!=="string"||!/^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return NaN;
  const date=value.slice(0,value.indexOf("T")),day=new Date(date+"T00:00:00.000Z");
  return day.getUTCMonth()+1===Number(date.slice(-5,-3))&&day.getUTCDate()===Number(date.slice(-2))?Date.parse(value):NaN;
}

export function grokUsageResponseToLimits(response,at=checkedAt()){
  const period=response?.config?.currentPeriod,rawType=String(period?.type||"").replace(/^USAGE_PERIOD_TYPE_/,"");
  const kind=rawType==="WEEKLY"?"weekly":rawType==="MONTHLY"?"monthly":"other";
  // xAI leaves the percentage out until something is metered: a weekly or monthly period whose start comes before its end is that
  // period with nothing used yet, at 0% (T3 79f2bae6a); without one, a successful read is an account with no window to show.
  const unused=response?.config?.creditUsagePercent===undefined&&kind!=="other"&&periodBoundary(period?.start)<periodBoundary(period?.end);
  const usedPercent=unused?0:clampPercent(response?.config?.creditUsagePercent);
  if(usedPercent==null)return available([],at);
  const resetsAt=resetIso(period?.end);
  return available([{id:"subscription",kind,label:kind==="weekly"?"Weekly":kind==="monthly"?"Monthly":"Subscription",usedPercent,...(resetsAt?{resetsAt}:{})}],at);
}

export function openCodeUsageResponseToLimits(response,at=checkedAt()){
  const source=response?.usage;
  if(!source||typeof source!=="object")return unavailable("probeFailed","OpenCode Go could not read usage.",at);
  const definitions=[
    ["rolling","go_rolling","session","Go · Session",5*60],
    ["weekly","go_weekly","weekly","Go · Weekly",7*24*60],
    ["monthly","go_monthly","monthly","Go · Monthly",null],
  ];
  const windows=[];
  for(const [key,id,kind,label,windowDurationMins] of definitions){
    const usedPercent=clampPercent(source[key]?.percent);const resetsAt=resetIso(source[key]?.resetsAt);
    if(usedPercent==null||!resetsAt)return unavailable("probeFailed","OpenCode Go could not read usage.",at);
    windows.push({id,kind,label,usedPercent,resetsAt,...(windowDurationMins?{windowDurationMins}:{})});
  }
  return available(windows,at);
}

// Claude Code reports its plan windows through the SDK's usage request (T3 Code's claudeUsageResponseToLimits): percentages
// are already 0-100, the account-wide windows are keyed by rateLimitType, and model-scoped weeklies add a row each.
const CLAUDE_USAGE_WINDOWS=Object.freeze([["five_hour","session","Session",5*60],["seven_day","weekly","Weekly",7*24*60]]);
function amountPercent(used,limit){
  if(typeof used!=="number"||typeof limit!=="number"||!Number.isFinite(used)||!Number.isFinite(limit)||used<0||limit<=0)return null;
  const percent=used/limit*100;return Number.isFinite(percent)?clampPercent(percent):null;
}
// A Team or Enterprise monthly spend limit (T3 Code's readSpendPercent). The spend budget, which the SDK does not type yet, is used
// when its amounts share one currency and scale (its own percent is rounded); otherwise enabled extra usage's credits against its
// monthly limit, or its utilization.
function claudeSpendPercent(limits){
  const spend=limits.spend,money=value=>Number.isSafeInteger(value?.amount_minor)&&value.amount_minor>=0&&typeof value.currency==="string"&&value.currency.length>0&&Number.isSafeInteger(value.exponent)&&value.exponent>=0;
  if(spend?.enabled===true&&money(spend.used)&&money(spend.limit)&&spend.used.currency.trim()&&spend.used.currency.trim()===spend.limit.currency.trim()&&spend.used.exponent===spend.limit.exponent){
    const percent=amountPercent(spend.used.amount_minor,spend.limit.amount_minor);if(percent!=null)return percent;
  }
  const extra=limits.extra_usage;if(extra?.is_enabled!==true)return null;
  const percent=amountPercent(extra.used_credits,extra.monthly_limit)??extra.utilization;
  return typeof percent==="number"&&Number.isFinite(percent)&&percent>=0?clampPercent(percent):null;
}
export function claudeUsageResponseToLimits(response,at=checkedAt()){
  const limits=response?.rate_limits;
  // Plan limits that apply but came without data are a read that failed, not an account without limits (T3 Code).
  if(!response?.rate_limits_available||!limits||typeof limits!=="object")return response?.rate_limits_available?unavailable("probeFailed","Claude Code could not read usage limits.",at):unavailable("unsupported",null,at);
  const windows=[];
  for(const [id,kind,label,windowDurationMins] of CLAUDE_USAGE_WINDOWS){
    const window=limits[id];if(typeof window?.utilization!=="number")continue;
    const resetsAt=resetIso(window.resets_at);
    windows.push({id,kind,label,windowDurationMins,usedPercent:clampPercent(window.utilization),...(resetsAt?{resetsAt}:{})});
  }
  for(const entry of Array.isArray(limits.model_scoped)?limits.model_scoped:[]){
    if(typeof entry?.display_name!=="string"||typeof entry.utilization!=="number")continue;
    const resetsAt=resetIso(entry.resets_at);
    windows.push({id:"seven_day_"+entry.display_name.toLowerCase().replace(/[^a-z0-9]+/g,"_"),kind:"weekly",label:"Weekly · "+entry.display_name,windowDurationMins:7*24*60,usedPercent:clampPercent(entry.utilization),...(resetsAt?{resetsAt}:{})});
  }
  const spendPercent=claudeSpendPercent(limits);
  if(spendPercent!=null)windows.push({id:"monthly_spend",kind:"monthly",label:"Monthly spend",usedPercent:spendPercent});
  return available(windows,at);
}

// readCapabilities runs (or reuses) the no-prompt Claude Code capability probe, which asks the CLI for its plan usage.
export async function readClaudeUsageLimits({readCapabilities}={}){
  const at=checkedAt();
  if(typeof readCapabilities!=="function")return unavailable("unsupported",null,at);
  let probe;
  try{probe=await readCapabilities()}catch{return unavailable("probeFailed","Claude Code could not read usage limits.",at)}
  if(!probe?.usage)return probe?.usageError?unavailable("probeFailed","Claude Code could not read usage limits.",at):unavailable("unsupported",null,at);
  return claudeUsageResponseToLimits(probe.usage,probe.checkedAt||at);
}

// Claude Code reports its plan usage itself (its capability probe). Cursor's, Grok Build's and OpenCode Go's would be read with the
// sign-in each keeps for itself (its stored login, or a token in the environment), which Trebell never reads: their meters say so. The
// mappers above stay for a harness that reports its usage over its own protocol.
export async function readAgentRuntimeUsage(runtime,options={}){
  if(runtime==="claude")return readClaudeUsageLimits(options);
  if(["cursor","grok","opencode"].includes(runtime)){
    const name=String(options.name||runtime);
    return unavailable("unsupported",`${name} does not report its usage to Trebell Code, which never reads the sign-in ${name} keeps.`,checkedAt());
  }
  return unavailable("unsupported",null,checkedAt());
}
