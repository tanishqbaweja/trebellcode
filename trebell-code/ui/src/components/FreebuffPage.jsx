import React from "react";
import { Coins, Flame, Gauge, Clock3, RefreshCw, Zap } from "lucide-react";

function price(freebuff,model){return freebuff?.derived?.priceByModel?.[model]||(freebuff?.derived?.selectedModel===model?freebuff?.derived?.selectedPrice:null)}
export default function FreebuffPage({freebuff,model,onRefresh}){
  const selected=price(freebuff,model);
  return <div className="freebuff-page">
    <div className="fb-hero"><div><span>Freebucks balance</span><strong>{freebuff?.derived?.balance??"—"}</strong><small>{freebuff?.user?.email||"Freebuff account"}</small></div><button onClick={onRefresh}><RefreshCw size={15}/> Refresh</button></div>
    <div className="fb-dashboard-grid">
      <div className="fb-dashboard-card"><Coins size={19}/><span>Selected model</span><strong>{model?.replace(/^freebuff\//,"")||"—"}</strong><small>{selected?.current!=null?selected.current+" Freebucks/hour":selected?.dynamic?"Dynamic price":"Price unavailable"}</small></div>
      <div className="fb-dashboard-card"><Clock3 size={19}/><span>Session</span><strong>{freebuff?.derived?.sessionStatus||"none"}</strong><small>{freebuff?.derived?.activeModel?.replace(/^freebuff\//,"")||"No active model"}</small></div>
      <div className="fb-dashboard-card"><Flame size={19}/><span>Usage streak</span><strong>{freebuff?.streak?.streak??"—"} days</strong><small>{freebuff?.streak?.freebucksDailyBonus!=null?"+"+freebuff.streak.freebucksDailyBonus+" daily bonus":"Bonus unavailable"}</small></div>
      <div className="fb-dashboard-card"><Gauge size={19}/><span>Rate limit</span><strong>{freebuff?.derived?.rateLimit?.remaining??"—"}</strong><small>{freebuff?.derived?.rateLimit?.limit!=null?"of "+freebuff.derived.rateLimit.limit+" remaining":"Live server limits"}</small></div>
    </div>
    {selected?.offPeakActive&&<div className="fb-offpeak"><Zap size={15}/> Off-peak pricing is active.</div>}
    <div className="fb-model-table"><div className="fb-table-head"><span>Freebuff model</span><span>Freebucks/hour</span><span>Source</span></div>{Object.entries(freebuff?.derived?.priceByModel||{}).map(([id,p])=><div key={id} className={id===model?"selected":""}><span>{id.replace(/^freebuff\//,"")}</span><span>{p.dynamic?"Dynamic":p.current??"—"}</span><span>{p.source==="server"?"Live":"Fallback"}</span></div>)}</div>
    <div className="fb-raw"><h3>Session details</h3><div><span>Instance</span><code>{freebuff?.instanceId||"—"}</code></div><div><span>Admitted</span><code>{freebuff?.derived?.admittedAt||"—"}</code></div><div><span>Reset</span><code>{freebuff?.derived?.resetTime||"—"}</code></div><div><span>Timezone</span><code>{freebuff?.derived?.timezone||"—"}</code></div></div>
  </div>;
}
