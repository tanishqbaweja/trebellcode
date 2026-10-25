// When a snooze ends, as the Snooze dialog reads it from what the person picked: only the dialog needs these, so they load with it
// rather than with the app (B11). What the sidebar says of a snoozed thread, and when App wakes one, are thread-snooze.js's.
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
