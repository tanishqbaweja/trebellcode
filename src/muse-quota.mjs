// Muse Code's subscription quota: whether a failed turn is the quota's stop, and when the limit lifts again.

const asText=value=>typeof value==="string"?value:value==null?"":String(value);

// The last instant a JavaScript Date holds, in milliseconds.
export const MUSE_LAST_DATE_MS=8.64e15;

// A turn the quota stopped: Muse types its error with a quota, and a refusal relayed without one is an HTTP 429 that speaks of the
// quota or a usage limit. A plain 429 rate limit stays an ordinary failure.
export function museQuotaStop(error={},message=""){
  if(error?.quota&&typeof error.quota==="object")return true;
  const words=asText(message);
  if(!/\b429\b/.test(words))return false;
  const lower=words.toLowerCase();
  return lower.includes("quota")||lower.includes("usage limit");
}

const isDigit=char=>char!==undefined&&char>="0"&&char<="9";
const isWordChar=char=>isDigit(char)||char==="_"||(char>="a"&&char<="z")||(char>="A"&&char<="Z");
// The fixed part of an ISO 8601 time: 9 is a digit, T is T or t, anything else is itself.
const STAMP_SHAPE="9999-99-99T99:99:99";
// The ISO 8601 date and time that starts at index from (the fixed part, an optional fraction, then Z or an offset of +HH:MM or
// -HH:MM, letters in any case), or "" when none starts there.
function stampAt(text,from){
  let at=from;
  for(const want of STAMP_SHAPE){
    const got=text[at];
    const fits=want==="9"?isDigit(got):want==="T"?got==="T"||got==="t":got===want;
    if(!fits)return "";
    at++;
  }
  if(text[at]==="."&&isDigit(text[at+1])){at++;while(isDigit(text[at]))at++}
  const zone=text[at];
  if(zone==="Z"||zone==="z")return text.slice(from,at+1);
  if(zone!=="+"&&zone!=="-")return "";
  const offset=text.slice(at+1,at+6);
  return offset.length===5&&isDigit(offset[0])&&isDigit(offset[1])&&offset[2]===":"&&isDigit(offset[3])&&isDigit(offset[4])?text.slice(from,at+6):"";
}
// The time a refusal names for its reset ("... resets at 2026-11-03T06:30:00Z ..."): the first "resets at" (a word of its own, in
// any case) followed by an ISO 8601 time, or "" when it names none.
const RESET_WORDS="resets at ";
function namedReset(message){
  const folded=message.replace(/[A-Z]/g,char=>char.toLowerCase());
  for(let at=folded.indexOf(RESET_WORDS);at>=0;at=folded.indexOf(RESET_WORDS,at+1)){
    if(at>0&&isWordChar(message[at-1]))continue;
    const stamp=stampAt(message,at+RESET_WORDS.length);
    if(stamp)return stamp;
  }
  return "";
}

// When the limit lifts: the latest reset still to come among the used-up windows of Muse's last usage report (the current window and
// the week, at 100% or more), the quota's own reset and the time the refusal names; null when none is known.
export function museLimitLiftsAt(usage,nowMs=Date.now(),{quota=null,message=""}={}){
  const resets=[];
  for(const window of [usage?.window,usage?.weekly])if(window&&window.usedPercent>=100)resets.push(window.resetsAtMs);
  resets.push(quota?.resetsAtMs);
  const named=namedReset(asText(message));
  if(named)resets.push(Date.parse(named));
  let latest=null;
  for(const ms of resets){
    const ahead=typeof ms==="number"&&Number.isFinite(ms)&&ms>nowMs&&ms<=MUSE_LAST_DATE_MS;
    if(ahead&&(latest===null||ms>latest))latest=ms;
  }
  return latest===null?null:new Date(latest).toISOString();
}
