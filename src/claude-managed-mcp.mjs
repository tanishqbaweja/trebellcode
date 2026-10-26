import { access } from "node:fs/promises";

// An administrator's managed-mcp.json, where Claude Code reads it (its managed settings folder, as T3 Code's hasClaudeManagedMcpConfig
// checks it). Next to that file Claude Code loads only the managed MCP servers and exits at startup on --strict-mcp-config, so a run
// that wants no MCP servers of its own (the capability probe, Git text) leaves the flag out there.
export function claudeManagedMcpPath(platform=process.platform){
  if(platform==="darwin")return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if(platform==="win32")return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

const fileExists=path=>access(path).then(()=>true,()=>false);
// exists(path) says whether the file is there (tests pass their own); a check that fails counts as no file.
export async function hasClaudeManagedMcpConfig({platform=process.platform,exists=fileExists}={}){
  try{return Boolean(await exists(claudeManagedMcpPath(platform)))}catch{return false}
}
