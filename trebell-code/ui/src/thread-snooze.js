const UNIT_MS={minutes:60_000,hours:3_600_000,days:86_400_000};

export function snoozeUntilFromDuration(value,unit="hours",now=Date.now()){
  const amount=Number(value);const multiplier=UNIT_MS[unit];
  if(!Number.isFinite(amount)||amount<=0||!multiplier)return null;
  return Number(now)+amount*multiplier;
}

export function localDateTimeValue(timestamp=Date.now()+3_600_000){
  const date=new Date(Number(timestamp));if(Number.isNaN(date.getTime()))return "";
  const pad=value=>String(value).padStart(2,"0");
  return date.getFullYear()+"-"+pad(date.getMonth()+1)+"-"+pad(date.getDate())+"T"+pad(date.getHours())+":"+pad(date.getMinutes());
}

export function timestampFromLocalDateTime(value){
  const text=String(value||"").trim();if(!text)return null;
  const timestamp=new Date(text).getTime();
  return Number.isFinite(timestamp)?timestamp:null;
}

export function formatSnoozeUntil(timestamp){
  const value=Number(timestamp);if(!Number.isFinite(value))return "";
  return new Date(value).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

export function nextSnoozeWakeAt(threads=[],threadMeta={},now=Date.now()){
  const current=Number(now);let next=null;
  for(const thread of threads||[]){
    if(thread?.section?.name!=="Snoozed")continue;
    const value=Number(threadMeta?.[thread.id]?.snoozedUntil);if(!Number.isFinite(value)||value<=0)continue;
    const candidate=Math.max(current,value);
    if(next==null||candidate<next)next=candidate;
  }
  return next;
}
