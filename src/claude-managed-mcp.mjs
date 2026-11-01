import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

// Claude Code reads the settings an administrator manages for the whole machine from one folder per platform, and an
// administrator's managed-mcp.json from that same folder. While that file is there Claude Code starts only the servers it lists
// and stops at startup when handed --strict-mcp-config, so a run that wants no MCP server of its own (the capability probe, Git
// text) leaves that flag out there. Each entry: the platform's path rules, then the folder.
const MANAGED_SETTINGS_FOLDERS=new Map([
  ["darwin",[posix,"/Library/Application Support/ClaudeCode"]],
  ["win32",[win32,"C:\\Program Files\\ClaudeCode"]],
]);
// Linux, WSL and any platform not named above.
const UNIX_MANAGED_SETTINGS=[posix,"/etc/claude-code"];

export function adminMcpFilePath(platform=process.platform){
  const [paths,folder]=MANAGED_SETTINGS_FOLDERS.get(platform)??UNIX_MANAGED_SETTINGS;
  return paths.join(folder,"managed-mcp.json");
}

// Whether something is at path on this machine, through links; a look that fails counts as nothing there.
const somethingAt=path=>stat(path).then(()=>true,()=>false);

// Whether the administrator's file is there. exists(path) may answer in place of the look (tests pass their own); whatever it
// answers counts as yes or no, and one that throws or rejects counts as no, so this never fails.
export function adminMcpFilePresent({platform=process.platform,exists=somethingAt}={}){
  const path=adminMcpFilePath(platform);
  return Promise.resolve().then(()=>exists(path)).then(Boolean,()=>false);
}
