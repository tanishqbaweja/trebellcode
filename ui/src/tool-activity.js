// Activity-row names for tool calls that arrive without a title of their own: a read names its path, a search its query and
// folder, and a command its command
// line. Trebell Native's first-party tools (trebell_workspace, trebell_repo, trebell_terminal) are named the same way.
// A harness that titles its own tool calls keeps that title; any other tool keeps its own name.

function asRecord(value){
  if(value&&typeof value==="object"&&!Array.isArray(value))return value;
  // Some harnesses send tool arguments as a JSON string.
  if(typeof value==="string"&&value.trim().startsWith("{")){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:undefined}catch{return undefined}}
  return undefined;
}
function trimmed(value){return typeof value==="string"&&value.trim()?value.trim():undefined}
function firstString(record,keys){if(!record)return undefined;for(const key of keys){const value=trimmed(record[key]);if(value)return value}return undefined}

const PATH_KEYS=["path","filePath","file_path","relativePath","filename","fileName","newPath","oldPath"];
const SEARCH_QUERY_KEYS=["pattern","query","searchTerm","regex","grep","needle"];
const SEARCH_GLOB_KEYS=["glob","globPattern","glob_pattern","include","filePattern","file_pattern"];
const SEARCH_TARGET_KEYS=["path","target_directory","targetDirectory","directory","cwd","root"];

// The tool-name token: server-prefixed MCP names (github.read_file, mcp__db__find) are not local reads or searches.
function toolToken(value){
  const name=trimmed(value);
  if(!name||/__|[./]/.test(name))return undefined;
  return name.replace(/[_\s-]/g,"").toLowerCase();
}
const READ_TOKENS=new Set(["read","readfile","readsource"]);
const SEARCH_TOKENS=new Set(["find","grep","glob","rg","ls","list","searchcode","searchfiles","searchsymbols"]);
const COMMAND_TOKENS=new Set(["terminal","bash","shell"]);
const EDIT_TOKENS=new Set(["replacetext","editfile","edit"]),WRITE_TOKENS=new Set(["writefile","write"]);

export function classifyToolCall({namespace,tool,kind}={}){
  const token=toolToken(tool),k=trimmed(kind)?.toLowerCase();
  if(k==="execute"||COMMAND_TOKENS.has(token)||(namespace==="trebell_terminal"&&token==="run"))return "command";
  if(k==="edit"||EDIT_TOKENS.has(token))return "edit";
  if(WRITE_TOKENS.has(token))return "write";
  if(k==="search"||SEARCH_TOKENS.has(token))return "search";
  if(k==="read"||READ_TOKENS.has(token))return "read";
  return "other";
}

function commandLine(input){
  const command=input?.command;
  if(Array.isArray(command))return command.map(String).join(" ").trim()||undefined;
  const head=trimmed(command);if(!head)return undefined;
  const args=Array.isArray(input.args)?input.args.map(String):[];
  return [head,...args].join(" ");
}
function targetName(value){return value?.split(/[\\/]/).findLast(part=>part.length>0&&part!==".")}

// "Looked for slugify in src", "Listed *.js", "Looked in src".
export function searchToolLabel(input){
  const query=firstString(input,SEARCH_QUERY_KEYS),glob=firstString(input,SEARCH_GLOB_KEYS),target=targetName(firstString(input,SEARCH_TARGET_KEYS));
  if(query&&target)return `Looked for ${query} in ${target}`;
  if(glob&&target)return `Listed ${glob} in ${target}`;
  if(glob)return `Listed ${glob}`;
  if(query)return `Looked for ${query}`;
  if(target)return `Looked in ${target}`;
  return undefined;
}

// The row name for a dynamic (harness or Native) tool call, or undefined when the tool's own name is the best there is.
// An edit or write that failed or was declined is named by what it attempted ("Write notes.txt"): the row never claims a
// change that did not happen. A search whose arguments name no query, files or folder is "Looked through the files".
export function dynamicToolLabel(item={}){
  const input=asRecord(item.arguments)??asRecord(item.input)??{};
  const action=classifyToolCall({namespace:item.namespace,tool:item.tool,kind:item.kind});
  const path=firstString(input,PATH_KEYS),attempted=item.status==="failed"||item.status==="declined";
  if(action==="read")return `Read ${path||"file"}`;
  if(action==="edit")return path?`${attempted?"Edit":"Edited"} ${path}`:undefined;
  if(action==="write")return path?`${attempted?"Write":"Wrote"} ${path}`:undefined;
  if(action==="search")return searchToolLabel(input)||(Object.keys(input).length?"Looked through the files":undefined);
  if(action==="command")return commandLine(input);
  return undefined;
}
