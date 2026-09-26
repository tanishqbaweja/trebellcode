function snake(value){
  return String(value||"").replace(/([a-z0-9])([A-Z])/g,"$1_$2").replace(/-/g,"_").toLowerCase();
}

function snakeKeys(value){
  if(Array.isArray(value))return value.map(snakeKeys);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[snake(key),snakeKeys(item)]));
}

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

function coreGuardianAction(action={}){
  if(action.type==="command")return {type:"command",source:snake(action.source),command:String(action.command||""),cwd:action.cwd};
  if(action.type==="execve")return {type:"execve",source:snake(action.source),program:String(action.program||""),argv:Array.isArray(action.argv)?action.argv:[],cwd:action.cwd};
  if(action.type==="writeStdin")return {type:"write_stdin",approval_id:String(action.approvalId||""),process_id:String(action.processId||""),stdin:String(action.stdin||""),cwd:action.cwd};
  if(action.type==="applyPatch")return {type:"apply_patch",cwd:action.cwd,files:Array.isArray(action.files)?action.files:[]};
  if(action.type==="networkAccess")return {type:"network_access",target:String(action.target||""),host:String(action.host||""),protocol:snake(action.protocol),port:Number(action.port)||0};
  if(action.type==="mcpToolCall")return {type:"mcp_tool_call",server:String(action.server||""),tool_name:String(action.toolName||""),connector_id:action.connectorId??null,connector_name:action.connectorName??null,tool_title:action.toolTitle??null};
  if(action.type==="requestPermissions")return {type:"request_permissions",reason:action.reason??null,permissions:snakeKeys(action.permissions||{})};
  throw new Error("Unsupported auto-review action: "+String(action.type||"unknown"));
}

export function guardianDeniedEvent(notification={}){
  const review=notification.review||{};
  if(review.status!=="denied")throw new Error("Only denied auto-review decisions can be overridden.");
  return {
    id:String(notification.reviewId||""),
    ...(notification.targetItemId?{target_item_id:String(notification.targetItemId)}:{}),
    turn_id:String(notification.turnId||""),
    started_at_ms:Number(notification.startedAtMs)||0,
    ...(notification.completedAtMs!=null?{completed_at_ms:Number(notification.completedAtMs)||0}:{}),
    status:"denied",
    ...(review.riskLevel?{risk_level:snake(review.riskLevel)}:{}),
    ...(review.userAuthorization?{user_authorization:snake(review.userAuthorization)}:{}),
    ...(review.rationale?{rationale:String(review.rationale)}:{}),
    ...(notification.decisionSource?{decision_source:snake(notification.decisionSource)}:{}),
    action:coreGuardianAction(notification.action||{}),
  };
}
