// One place that turns thread timestamps into text. Harness catalogs report seconds, while Trebell's own thread
// metadata (and some fixtures) store Date.now() milliseconds; a value past 1e11 is read as milliseconds (1e11 s is
// the year 5138, 1e11 ms is 1973), so both units show the same date instead of a year like 58744.
export function epochSeconds(value){
  const number=Number(value);
  if(!Number.isFinite(number)||number<=0)return 0;
  return number>1e11?number/1000:number;
}

// Sidebar meta: "now", "5m", "3h", "2d". A timestamp a little in the future (clock skew) reads "now".
export function relativeTime(value,nowMs=Date.now()){
  const epoch=epochSeconds(value);if(!epoch)return "";
  const seconds=Math.max(0,nowMs/1000-epoch);
  if(seconds<60)return "now";
  if(seconds<3600)return Math.floor(seconds/60)+"m";
  if(seconds<86400)return Math.floor(seconds/3600)+"h";
  return Math.floor(seconds/86400)+"d";
}

function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}

// History rows: "Today 19:21", "Yesterday 08:05", "Oct 3" (this year) or "Oct 3, 2025".
export function compactDateTime(value,nowMs=Date.now(),locale=undefined){
  const epoch=epochSeconds(value);if(!epoch)return "";
  const date=new Date(epoch*1000),now=new Date(nowMs),yesterday=new Date(nowMs-86400000);
  const time=date.toLocaleTimeString(locale,{hour:"2-digit",minute:"2-digit"});
  if(sameDay(date,now))return "Today "+time;
  if(sameDay(date,yesterday))return "Yesterday "+time;
  return date.toLocaleDateString(locale,date.getFullYear()===now.getFullYear()?{month:"short",day:"numeric"}:{month:"short",day:"numeric",year:"numeric"});
}

// The full local date and time, for tooltips and <time dateTime>.
export function fullDateTime(value,locale=undefined){
  const epoch=epochSeconds(value);if(!epoch)return "";
  return new Date(epoch*1000).toLocaleString(locale);
}

export function isoDateTime(value){
  const epoch=epochSeconds(value);if(!epoch)return undefined;
  return new Date(epoch*1000).toISOString();
}
