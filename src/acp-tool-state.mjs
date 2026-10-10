// ACP agents send a tool call once (tool_call) and then partial updates (tool_call_update) that
// only carry the fields that changed. Like T3's mergeToolCallState, every update is merged into
// the tool's last known state before Trebell maps it, so kind, title and rawInput survive later
// frames that omit them. The merged frame also carries normalized output fields the relay reads:
// aggregatedOutput / exitCode for commands and changes for file diffs.

const OUTPUT_LIMIT=256*1024;
const CHANGE_TEXT_LIMIT=16*1024;

function present(value){return value!==undefined&&value!==null}

export function mergeAcpToolUpdate(previous,update={}){
  const merged=previous&&typeof previous==="object"?{...previous}:{};
  for(const [key,value] of Object.entries(update||{}))if(present(value))merged[key]=value;
  return merged;
}

function decodeBytes(value){
  if(!Array.isArray(value)||!value.length||!value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<256))return null;
  return Buffer.from(value).toString("utf8");
}

// Command output in the shapes the ACP harnesses use: a plain string, Cursor's
// {stdout, stderr, exitCode}, Antigravity's {combinedOutput, exitCode} and Grok's Bash
// {output:[bytes], output_for_prompt, exit_code} or TaskOutput {Result:{output, exit_code}}.
export function acpToolOutputText(raw){
  if(typeof raw==="string")return raw;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  for(const key of ["combinedOutput","combined_output"])if(typeof raw[key]==="string")return raw[key];
  if(typeof raw.stdout==="string"||typeof raw.stderr==="string"){
    const out=typeof raw.stdout==="string"?raw.stdout:"",err=typeof raw.stderr==="string"?raw.stderr:"";
    return out&&err?(out.endsWith("\n")?out:out+"\n")+err:out||err;
  }
  if(typeof raw.output==="string")return raw.output;
  const bytes=decodeBytes(raw.output);if(bytes!=null)return bytes;
  if(typeof raw.output_for_prompt==="string")return raw.output_for_prompt;
  if(raw.Result&&typeof raw.Result==="object"&&typeof raw.Result.output==="string")return raw.Result.output;
  return null;
}

export function acpToolExitCode(raw){
  if(!raw||typeof raw!=="object")return null;
  for(const value of [raw.exitCode,raw.exit_code,raw.Result?.exitCode,raw.Result?.exit_code])if(Number.isInteger(value))return value;
  return null;
}

function bounded(value){
  const text=String(value??"");
  return text.length>CHANGE_TEXT_LIMIT?text.slice(0,CHANGE_TEXT_LIMIT)+"\n[truncated]":text;
}

// ACP diff content: {type:"diff", path, oldText, newText}; oldText is absent for a new file.
export function acpDiffChanges(content){
  if(!Array.isArray(content))return [];
  return content.filter(entry=>entry?.type==="diff"&&String(entry.path||"").trim()).map(entry=>({
    path:String(entry.path),
    kind:present(entry.oldText)?"update":"add",
    ...(present(entry.oldText)?{oldText:bounded(entry.oldText)}:{}),
    newText:bounded(entry.newText),
  }));
}

// Adds the normalized fields to a merged tool frame. Plain-string rawOutput is left to the relay.
export function acpToolFrame(merged){
  const frame={...merged};
  if(typeof merged.rawOutput!=="string"){
    const text=acpToolOutputText(merged.rawOutput);
    if(text!=null)frame.aggregatedOutput=text.slice(0,OUTPUT_LIMIT);
  }
  const exitCode=acpToolExitCode(merged.rawOutput);if(exitCode!=null)frame.exitCode=exitCode;
  const changes=acpDiffChanges(merged.content);if(changes.length)frame.changes=changes;
  return frame;
}
