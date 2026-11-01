// Plan usage meters. Each harness reports its plan's usage in its own shape; the Usage page draws rows of one shape for all of them:
// {id, kind, label, usedPercent (0-100), resetsAt?, windowDurationMins?}, inside {checkedAt, windows}. When there is nothing to draw
// the answer says why instead: {checkedAt, windows: [], unavailable: {reason, message?}}.

const MINUTES_PER_WEEK=7*24*60;
const CLAUDE_UNREAD="Claude Code could not read usage limits.";
const OPENCODE_UNREAD="Trebell could not read OpenCode Go's usage.";

const nowText=()=>new Date().toISOString();
const meterAnswer=(checkedAt,windows)=>({checkedAt,windows});
function meterRefusal(checkedAt,reason,message){
  return {checkedAt,windows:[],unavailable:message?{reason,message}:{reason}};
}

// A reading as a meter percentage: what Number() makes of it (so null reads 0), held to 0..100 with zero always +0, or null when that
// is not a finite number.
function asPercent(reading){
  const value=Number(reading);
  if(!Number.isFinite(value))return null;
  if(value<=0)return 0;
  return value<100?value:100;
}

// part of whole as a meter percentage, for a finite part of at least 0 and a finite whole above 0; null for anything else.
function percentOfWhole(part,whole){
  if(!(Number.isFinite(part)&&Number.isFinite(whole))||part<0||whole<=0)return null;
  return asPercent(part/whole*100);
}

// A reset time as ISO text in UTC. A reading that is a positive number (or numeric text) counts epoch milliseconds; anything else is
// handed to the date parser as text. Absent readings and times the parser cannot place give none.
function resetText(reading){
  if(reading===undefined||reading===null||reading==="")return undefined;
  const millis=Number(reading);
  const when=new Date(millis>0?millis:Date.parse(String(reading)));
  return Number.isNaN(when.getTime())?undefined:when.toISOString();
}
const withReset=(row,resetsAt)=>resetsAt?{...row,resetsAt}:row;

// ---- Grok Build
// Its billing answer is {config: {creditUsagePercent, currentPeriod: {type, start, end}}}, the type an enum value written by its full
// name (USAGE_PERIOD_TYPE_WEEKLY) or bare (WEEKLY).
const GROK_TYPE_PREFIX="USAGE_PERIOD_TYPE_";
const GROK_PERIOD_LOOKS=new Map([["WEEKLY",{kind:"weekly",label:"Weekly"}],["MONTHLY",{kind:"monthly",label:"Monthly"}]]);
const GROK_ANY_PERIOD={kind:"other",label:"Subscription"};

function grokPeriodLook(type){
  const name=type?String(type):"";
  return GROK_PERIOD_LOOKS.get(name.startsWith(GROK_TYPE_PREFIX)?name.slice(GROK_TYPE_PREFIX.length):name);
}

// Days in a month of the proleptic Gregorian calendar (the one JavaScript dates count in).
function monthLength(year,month){
  if(month===2)return year%4===0&&(year%100!==0||year%400===0)?29:28;
  return [4,6,9,11].includes(month)?30:31;
}

// Whether text is a whole ISO 8601 date-time with its zone, as a billing period's bounds are written: a calendar date (a 4-digit
// year, or a signed 6-digit one other than -000000) on a day that exists and that a JavaScript date can hold; T; hh:mm, optionally
// :ss and then a fraction, or the day's end 24:00 (optionally :00 and a zero fraction); then Z or an offset +hh:mm / -hh:mm.
function isWholeZonedTime(text){
  let pos=0;
  const isDigitAt=index=>{const code=text.charCodeAt(index);return code>=48&&code<=57};
  const field=width=>{
    let value=0;
    for(const stop=pos+width;pos<stop;pos++){
      if(!isDigitAt(pos))return NaN;
      value=value*10+text.charCodeAt(pos)-48;
    }
    return value;
  };
  const passes=mark=>{
    if(text[pos]!==mark)return false;
    pos++;return true;
  };
  const sign=text[0]==="+"||text[0]==="-"?text[0]:"";
  if(sign)pos=1;
  const yearDigits=field(sign?6:4);
  if(Number.isNaN(yearDigits)||(sign==="-"&&yearDigits===0)||!passes("-"))return false;
  const year=sign==="-"?-yearDigits:yearDigits;
  const month=field(2);
  if(!(month>=1&&month<=12)||!passes("-"))return false;
  const day=field(2);
  if(!(day>=1&&day<=monthLength(year,month)))return false;
  if(Number.isNaN(new Date(0).setUTCFullYear(year,month-1,day))||!passes("T"))return false;
  const hour=field(2);
  if(!passes(":"))return false;
  const minute=field(2);
  let second=0,fraction="";
  if(passes(":")){
    second=field(2);
    if(passes(".")){
      const from=pos;
      while(isDigitAt(pos))pos++;
      if(pos===from)return false;
      fraction=text.slice(from,pos);
    }
  }
  const dayEnd=hour===24&&minute===0&&second===0&&!/[1-9]/.test(fraction);
  if(!dayEnd&&!(hour<=23&&minute<=59&&second<=59))return false;
  if(passes("Z"))return pos===text.length;
  if(!passes("+")&&!passes("-"))return false;
  const offsetHours=field(2);
  if(!passes(":"))return false;
  const offsetMinutes=field(2);
  return offsetHours<=23&&offsetMinutes<=59&&pos===text.length;
}
const periodInstant=bound=>typeof bound==="string"&&isWholeZonedTime(bound)?Date.parse(bound):NaN;

export function grokUsageResponseToLimits(response,at=nowText()){
  const config=response?.config,period=config?.currentPeriod,look=grokPeriodLook(period?.type);
  // xAI sends no percentage until the period has used something. A weekly or monthly period whose whole bounds are in order is then
  // that period at 0%; with anything less there is no meter, and the read still worked.
  const untouched=config?.creditUsagePercent===undefined&&look!==undefined&&periodInstant(period?.start)<periodInstant(period?.end);
  const usedPercent=untouched?0:asPercent(config?.creditUsagePercent);
  if(usedPercent===null)return meterAnswer(at,[]);
  const {kind,label}=look||GROK_ANY_PERIOD;
  return meterAnswer(at,[withReset({id:"subscription",kind,label,usedPercent},resetText(period?.end))]);
}

// ---- Claude Code
// The SDK's usage request answers rate_limits_available (false for an API key, Bedrock, Vertex and other sessions without plan
// limits) and rate_limits: rolling windows {utilization 0-100, resets_at ISO}, model_scoped [{display_name, utilization, resets_at}],
// extra_usage {is_enabled, used_credits, monthly_limit, utilization}, and on Team and Enterprise seats a spend budget the SDK does
// not type yet, {enabled, used, limit, percent} with amounts {amount_minor, currency, exponent}.
const CLAUDE_ROLLING=[
  {key:"five_hour",kind:"session",label:"Session",minutes:5*60},
  {key:"seven_day",kind:"weekly",label:"Weekly",minutes:MINUTES_PER_WEEK},
];

function claudeWindow(id,kind,label,minutes,reading){
  const row={id,kind,label,windowDurationMins:minutes,usedPercent:asPercent(reading.utilization)};
  return withReset(row,resetText(reading.resets_at));
}
// A model window's row id: "weekly:" and the words of its name (runs of letters and digits of any script, lower case) joined by "-".
// The Usage page keys its cards by id, so a name whose id the answer has given already gets "~2", "~3" after it.
function modelWords(name){
  const words=[];let word="";
  for(const character of name.toLowerCase()){
    if(/\p{L}|\p{N}/u.test(character)){word+=character;continue}
    if(word)words.push(word);
    word="";
  }
  if(word)words.push(word);
  return words.join("-");
}
function claudeModelId(name,given){
  const id="weekly:"+modelWords(name);
  let shown=id;
  for(let count=2;given.has(shown);count++)shown=`${id}~${count}`;
  given.add(shown);
  return shown;
}

// An amount as the spend budget writes it, a whole count of minor units at a whole scale in a named currency; null otherwise.
function moneyAmount(amount){
  const currency=typeof amount?.currency==="string"?amount.currency.trim():"";
  const {amount_minor:minor,exponent}=amount||{};
  if(!currency||!Number.isSafeInteger(minor)||minor<0||!Number.isSafeInteger(exponent)||exponent<0)return null;
  return {minor,currency,exponent};
}

// The spend budget's share of its cap from its exact amounts (its own percent is rounded), when it is on and both amounts are money
// in one currency and scale.
function budgetShare(budget){
  if(budget?.enabled!==true)return null;
  const spent=moneyAmount(budget.used),cap=moneyAmount(budget.limit);
  if(!spent||!cap||spent.currency!==cap.currency||spent.exponent!==cap.exponent)return null;
  return percentOfWhole(spent.minor,cap.minor);
}
// Extra usage's share of its month when it is on: its credits against its monthly limit, or else its utilization.
function extraUsageShare(extra){
  const on=extra?.is_enabled===true;
  const fromCredits=on?percentOfWhole(extra.used_credits,extra.monthly_limit):null;
  if(!on||fromCredits!==null)return fromCredits;
  const {utilization}=extra;
  return Number.isFinite(utilization)&&utilization>=0?asPercent(utilization):null;
}
// How much of the month's cap is spent: the budget first, then extra usage.
const claudeMonthlySpend=limits=>budgetShare(limits.spend)??extraUsageShare(limits.extra_usage);

export function claudeUsageResponseToLimits(response,at=nowText()){
  if(!response?.rate_limits_available)return meterRefusal(at,"unsupported");
  const limits=response.rate_limits;
  // Plan limits that apply but came without data are a read that failed, not an account without limits.
  if(limits===null||typeof limits!=="object")return meterRefusal(at,"probeFailed",CLAUDE_UNREAD);
  const rows=[];
  for(const {key,kind,label,minutes} of CLAUDE_ROLLING){
    const reading=limits[key];
    if(typeof reading?.utilization==="number")rows.push(claudeWindow(key,kind,label,minutes,reading));
  }
  const modelIds=new Set();
  for(const reading of Array.isArray(limits.model_scoped)?limits.model_scoped:[]){
    const name=reading?.display_name;
    if(typeof name!=="string"||typeof reading.utilization!=="number")continue;
    rows.push(claudeWindow(claudeModelId(name,modelIds),"weekly","Weekly · "+name,MINUTES_PER_WEEK,reading));
  }
  const spent=claudeMonthlySpend(limits);
  if(spent!==null)rows.push({id:"monthly_spend",kind:"monthly",label:"Monthly spend",usedPercent:spent});
  return meterAnswer(at,rows);
}

// ---- Cursor
// Its plan usage gives planUsage's percentages (the plan as a whole, Auto, the API models) for the billing cycle that ends at
// billingCycleEnd, epoch milliseconds as text. Each field is shown under its own name.
const CURSOR_PLAN_PARTS=new Map([["totalPercentUsed",""],["autoPercentUsed"," · Auto"],["apiPercentUsed"," · API"]]);

export function cursorUsageResponseToLimits(response,at=nowText()){
  const plan=response?.planUsage,resetsAt=resetText(response?.billingCycleEnd),rows=[];
  if(plan!==null&&typeof plan==="object"){
    for(const [field,part] of CURSOR_PLAN_PARTS){
      const usedPercent=asPercent(plan[field]);
      if(usedPercent!==null)rows.push(withReset({id:field,kind:"monthly",label:"Monthly"+part,usedPercent},resetsAt));
    }
  }
  return rows.length?meterAnswer(at,rows):meterRefusal(at,"unsupported");
}

// ---- OpenCode Go
// OpenCode's Go page gives each plan a 5-hour, a weekly and a monthly limit. A usage answer holds them under rolling, weekly and
// monthly, each {percent, resetsAt}, and one that lacks any of the three is a read that failed. Each row below is the meter's
// fixed part, with the answer's field it reads; a month has no fixed length, so its row has no window length.
const GO_LIMITS=Object.freeze([
  {field:"rolling",row:{id:"opencode-go-5h",kind:"session",label:"OpenCode Go 5-hour limit",windowDurationMins:5*60}},
  {field:"weekly",row:{id:"opencode-go-week",kind:"weekly",label:"OpenCode Go weekly limit",windowDurationMins:MINUTES_PER_WEEK}},
  {field:"monthly",row:{id:"opencode-go-month",kind:"monthly",label:"OpenCode Go monthly limit"}},
]);

export function openCodeUsageResponseToLimits(response,at=nowText()){
  const usage=response?.usage,unread=()=>meterRefusal(at,"probeFailed",OPENCODE_UNREAD);
  if(!usage||typeof usage!=="object")return unread();
  const meters=GO_LIMITS.map(({field,row})=>{
    const usedPercent=asPercent(usage[field]?.percent),resetsAt=resetText(usage[field]?.resetsAt);
    return usedPercent!==null&&resetsAt?{...row,usedPercent,resetsAt}:null;
  });
  return meters.includes(null)?unread():meterAnswer(at,meters);
}

// ---- Reads
// Claude Code's plan usage comes from its no-prompt capability probe (readCapabilities, which runs or reuses it). A probe that
// answered signed out (claude-capabilities.mjs) says so and how to sign in, whatever its usage read brought. configDir is the Claude
// config directory of the profile's own that its probe ran with (CLAUDE_CONFIG_DIR): the advice names it as a failed turn does
// (claudeSignedOutMessage), as `claude auth login` run as written signs in the person's default ~/.claude instead. Settings' Sign in
// runs it with that directory set.
function claudeSignInAdvice(configDir){
  const home=String(configDir||"").trim();
  const where=home?` with CLAUDE_CONFIG_DIR set to "${home}"`:"";
  return `Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login${where}, then press Refresh.`;
}

export async function readClaudeUsageLimits({readCapabilities,configDir=""}={}){
  const startedAt=nowText();
  if(typeof readCapabilities!=="function")return meterRefusal(startedAt,"unsupported");
  let probe;
  try{probe=await readCapabilities()}catch{return meterRefusal(startedAt,"probeFailed",CLAUDE_UNREAD)}
  if(probe?.signedOut)return meterRefusal(probe.checkedAt||startedAt,"signedOut",claudeSignInAdvice(configDir));
  if(probe?.usage)return claudeUsageResponseToLimits(probe.usage,probe.checkedAt||startedAt);
  return probe?.usageError?meterRefusal(startedAt,"probeFailed",CLAUDE_UNREAD):meterRefusal(startedAt,"unsupported");
}

// Only Claude Code reports its plan usage itself. Cursor's, Grok Build's and OpenCode Go's would be read with the sign-in each keeps
// for itself (its stored login, or a token in the environment), which Trebell never reads, so their meters say that; the readers above
// stay for a harness that reports its usage over its own protocol.
const SIGN_IN_KEEPERS=new Set(["cursor","grok","opencode"]);

export async function readAgentRuntimeUsage(runtime,options={}){
  if(runtime==="claude")return readClaudeUsageLimits(options);
  if(!SIGN_IN_KEEPERS.has(runtime))return meterRefusal(nowText(),"unsupported");
  const name=String(options.name||runtime);
  return meterRefusal(nowText(),"unsupported",`${name} does not report its usage to Trebell Code, which never reads the sign-in ${name} keeps.`);
}
