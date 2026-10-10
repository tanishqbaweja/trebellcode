// A reasoning item's text as Codex sends it (summary parts, then raw content parts) and as the relay sends a harness's thinking
// (one content part).
export function reasoningItemText(item){
  const parts=[...(Array.isArray(item?.summary)?item.summary:[]),...(Array.isArray(item?.content)?item.content:[])];
  return parts.map(part=>String(typeof part==="string"?part:part?.text||"").trim()).filter(Boolean).join("\n\n");
}

// The one line a collapsed thought shows, plain text as T3 Code's liveThoughtLine strips it: the latest line while it streams,
// else its first (Codex's summary heading).
export function reasoningPreview(text,{latest=false}={}){
  const lines=String(text||"").split(/\r?\n/).map(line=>line.replace(/!?\[([^\]]*)\]\([^)]*\)/g,"$1").replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+\.)[ \t]+/,"").replace(/`+|\*\*|__|~~/g,"").trim()).filter(Boolean);
  return (latest?lines.at(-1):lines[0])||"";
}

// A finished thought as a conversation row; a reasoning item without text (Codex's encrypted-only reasoning) shows none.
export function reasoningHistoryMessage(item,turnId=null,fallbackText=""){
  const text=reasoningItemText(item)||String(fallbackText||"").trim();
  return item?.id&&text?{id:String(item.id),role:"reasoning",text,turnId:turnId||null}:null;
}
