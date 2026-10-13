// Whether the open workspace can answer a device-backed user verification request (an MCP elicitation that asks for a passkey).
// App asks it before the MCP request's modal loads, so it lives apart from mcp-elicitation.js, which only that modal needs: the
// rest of that module stays in the modal's chunk instead of the startup bundle.
export function userVerificationAvailability({runtime="",remote=false}={}){
  if(String(runtime||"").toLowerCase()!=="codex")return {available:false,reason:"Device-backed user verification is currently available only through Codex."};
  if(remote)return {available:false,reason:"Device verification is unavailable for remote workspaces."};
  return {available:true,reason:""};
}
