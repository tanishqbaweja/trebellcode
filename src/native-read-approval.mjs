import { POLICY_CONFIRM } from "./policy-engine.mjs";

// The reads Trebell Native runs without an approval in Supervised and Auto-accept edits (decided 2026-10-13): reading, listing and
// searching inside the thread's project root, as Codex (on-request), Claude Code and the ACP harnesses read without asking. Each is
// Trebell's own tool (source), with the argument that holds its path and that path's default, or no path for a search of the
// project's own index.
const PROJECT_READS=new Map([
  ["trebell_workspace/read_file",{source:"shared",path:"path"}],
  ["trebell_workspace/list",{source:"shared",path:"path",defaultPath:"."}],
  ["trebell_repo/read_source",{source:"repository",path:"path"}],
  ["trebell_repo/search_code",{source:"repository",path:null}],
  ["trebell_repo/search_files",{source:"repository",path:null}],
  ["trebell_repo/search_symbols",{source:"repository",path:null}],
]);
const ASKING_PROFILES=new Set(["supervised","workspace-write"]);

// Whether a Native call that its permission profile would put to the person is such a read: the profile asks (no explicit policy
// rule does), the tool is one of these, and its path, placed on disk through '..' and links by inside(path) (the Native workspace
// tools' own placement), is in the project root. A path that leads out of the root (by '..', an absolute path elsewhere, another
// drive, or a junction or symlink) still asks, as does every other tool: desktop screenshots and browser capture are reads too, but
// not of the project. Read only, Auto and Full access never ask for these reads, so they are unchanged.
// The stored output of one of these reads (one too long for the model's context, which Trebell keeps for trebell_output/inspect) opens
// without asking too, storedRead(handle) saying the session stored it from such a read: it is that read's own result, and the read ran
// without asking, or with the person's approval for a path outside the project, so inspecting it reads nothing new. A long attached
// document's text is such a read (tour L10's fix check, 2026-11-02: in Supervised its inspect asked, Read only's did not). Every other
// stored output (a command's, a web page's, an MCP tool's, or one this session did not store) still asks.
export function nativeReadTool(namespace,name){return PROJECT_READS.has(`${namespace||""}/${name||""}`)}
export async function nativeProjectReadNeedsNoApproval(call={},authorization={},{inside=null,storedRead=null}={}){
  if(authorization?.decision!==POLICY_CONFIRM||authorization.rule||!ASKING_PROFILES.has(authorization.profile))return false;
  if(call?.namespace==="trebell_output"&&call?.name==="inspect")return authorization.action?.kind==="read"&&typeof storedRead==="function"&&storedRead(String(authorization.arguments?.handle??call.arguments?.handle??""))===true;
  const read=PROJECT_READS.get(`${call?.namespace||""}/${call?.name||""}`);
  if(!read||authorization.definition?.source!==read.source||authorization.action?.kind!=="read"||authorization.action?.pathInsideWorkspace===false)return false;
  if(!read.path)return true;
  const args=authorization.arguments&&typeof authorization.arguments==="object"&&!Array.isArray(authorization.arguments)?authorization.arguments:{};
  const value=args[read.path]??read.defaultPath;
  if(typeof value!=="string"||!value.trim()||typeof inside!=="function")return false;
  try{return (await inside(value))===true}catch{return false}
}
