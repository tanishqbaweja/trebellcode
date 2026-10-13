export function guardianActionSummary(action={}){
  if(action.type==="command")return String(action.command||"command");
  if(action.type==="execve"){
    const argv=Array.isArray(action.argv)&&action.argv.length?action.argv:[action.program].filter(Boolean);
    return argv.join(" ")||"command";
  }
  if(action.type==="writeStdin")return "input to process "+(action.processId||"process");
  if(action.type==="applyPatch"){
    const files=Array.isArray(action.files)?action.files:[];
    return files.length===1?"apply patch to "+files[0]:"apply patch to "+files.length+" files";
  }
  if(action.type==="networkAccess")return "network access to "+(action.target||action.host||"remote host");
  if(action.type==="mcpToolCall")return "MCP "+(action.toolName||"tool")+" on "+(action.connectorName||action.server||"server");
  if(action.type==="requestPermissions")return String(action.reason||"additional permissions");
  return "requested action";
}
