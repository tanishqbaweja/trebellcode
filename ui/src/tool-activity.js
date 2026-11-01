// Names the activity row of a tool call that comes without a title of its own. What the call does is read from its tool's name
// or the ACP kind it reports, and what it acted on from its arguments: "Read src/app.js", "Looked for slugify in src",
// "npm test". Trebell Native's own tools (trebell_workspace, trebell_repo, trebell_terminal) are named this way. A harness that
// titles its calls keeps its title, and a call nothing here can name keeps its tool's name ("<namespace> / <tool>").

// The argument names each harness's documented tool schemas give the four things a row can name: file (what a read, edit or
// write acts on), text (what a search looks for), files (the file pattern a search keeps to) and folder (where it looks).
const DOCUMENTED_ARGUMENTS=[
  // Trebell Native (shared-tool-catalog.mjs, repository-tool-catalog.mjs): read_file, write_file, replace_text and read_source
  // take path; search_code, search_files and search_symbols take query, and glob and path as their scope; list takes path.
  // Codex calls Native's repository tools as its dynamic tools, so it sends these same names.
  {file:["path"],text:["query"],files:["glob"],folder:["path"]},
  // Claude Code (the Agent SDK's tool inputs): Read, Write and Edit take file_path, NotebookEdit notebook_path; Grep takes
  // pattern (its text), glob and path; Glob takes pattern (its file pattern, see FILE_FINDERS) and path.
  {file:["file_path","notebook_path"],text:["pattern"],files:["glob"],folder:["path"]},
  // OpenCode: read, write and edit take filePath (1.x) or path (its current tools); grep takes pattern, include and path; glob
  // takes pattern and path; list takes path.
  {file:["filePath","path"],text:["pattern"],files:["include"],folder:["path"]},
  // ACP leaves a call's raw input to its agent. Gemini CLI's file tools, which Antigravity carries on: read_file, write_file and
  // replace take file_path; grep_search takes pattern, include and path; glob takes pattern and path; list_directory dir_path.
  {file:["file_path"],text:["pattern"],files:["include"],folder:["path","dir_path"]},
];

// Each thing's names in the order they are read: Trebell Native's own first, then the other harnesses' in the order above, a
// name two harnesses share at its first place. A call that sends more than one is named by the first that holds text.
const READ_ORDER=Object.fromEntries(["file","text","files","folder"].map(thing=>
  [thing,[...new Set(DOCUMENTED_ARGUMENTS.flatMap(harness=>harness[thing]))]]));

// A tool that finds files by their names (Claude Code's Glob, OpenCode's glob, the ACP agents' glob) documents its file pattern as
// "pattern", the name every content search documents its text under.
const FILE_FINDERS=new Set(["glob"]);
const FINDER_PATTERN="pattern";

// Each action with the tool names that mean it, as plain words (see toolWord). When a call's name and its kind disagree, the
// action higher in this list is the one shown: a command can do anything, an edit or write changes files, a search or read
// only looks.
const ACTIONS=[
  ["command","bash shell terminal"],
  ["edit","edit editfile replacetext"],
  ["write","write writefile"],
  ["search","find glob grep list ls rg searchcode searchfiles searchsymbols"],
  ["read","read readfile readsource"],
];
const ACTION_OF_WORD=new Map(ACTIONS.flatMap(([action,words])=>words.split(" ").map(word=>[word,action])));
const PRECEDENCE=new Map(ACTIONS.map(([action],place)=>[action,place]));
// The kinds of the Agent Client Protocol that name one of these actions; its other kinds (delete, move, fetch, think) name none.
const ACTION_OF_KIND=new Map([["execute","command"],["edit","edit"],["search","search"],["read","read"]]);

const textOf=value=>typeof value==="string"?value.trim()||undefined:undefined;
const isPlainObject=value=>typeof value==="object"&&value!==null&&!Array.isArray(value);

// A call's arguments as an object: harnesses send them as one, or as the same object written as JSON text.
function argumentObject(value){
  let parsed=value;
  if(typeof value==="string"){
    if(!value.trim().startsWith("{"))return undefined;
    try{parsed=JSON.parse(value)}catch{return undefined}
  }
  return isPlainObject(parsed)?parsed:undefined;
}

// The trimmed text of the first of these argument names that holds any; a blank or non-text value is passed over.
const firstText=(args,names)=>names.reduce((found,name)=>found??textOf(args?.[name]),undefined);

// A tool name as a plain word: "read_file", "Read File" and "read-file" are all "readfile". A name that carries its MCP server
// ("github.read_file", "mcp__db__find", "server/grep") gives none, so a server's tool is never taken for a local read or search.
function toolWord(name){
  const bare=textOf(name);
  if(bare===undefined||["__",".","/"].some(mark=>bare.includes(mark)))return undefined;
  return bare.toLowerCase().split(/[\s_-]+/).join("");
}

// A folder by its last part: "src/components" is "components" and "ui/src/" is "src". One made only of "." parts names none.
function lastFolderPart(folder){
  return folder?.split(/[\\/]+/).filter(part=>part!==""&&part!==".").pop();
}

// What a search says it looked for, which files it kept to and where. On a file finder "pattern" is the file pattern, read
// before the other file pattern names, and never the text.
function searchTerms(args,tool){
  const finder=FILE_FINDERS.has(toolWord(tool));
  const textNames=finder?READ_ORDER.text.filter(name=>name!==FINDER_PATTERN):READ_ORDER.text;
  const fileNames=finder?[FINDER_PATTERN,...READ_ORDER.files]:READ_ORDER.files;
  return {text:firstText(args,textNames),files:firstText(args,fileNames),folder:lastFolderPart(firstText(args,READ_ORDER.folder))};
}

// The line of a command: one given as a list is its items joined by spaces (its args are not read then), one given as text is
// followed by its args.
function commandLine({command,args}){
  if(Array.isArray(command))return command.map(String).join(" ").trim()||undefined;
  const program=textOf(command);
  if(program===undefined)return undefined;
  return Array.isArray(args)?[program,...args.map(String)].join(" "):program;
}

// What a call does: "command", "edit", "write", "search", "read", or "other" when neither its name nor its kind says.
export function classifyToolCall({namespace,tool,kind}={}){
  const word=toolWord(tool);
  // "run" is a command as Native's terminal tool only; another server's run could be anything.
  const byName=word==="run"&&namespace==="trebell_terminal"?"command":ACTION_OF_WORD.get(word);
  const byKind=ACTION_OF_KIND.get(textOf(kind)?.toLowerCase());
  const said=[byName,byKind].filter(action=>action!==undefined);
  if(!said.length)return "other";
  return said.reduce((first,action)=>PRECEDENCE.get(action)<PRECEDENCE.get(first)?action:first);
}

// A search's row. Its text comes first, else its file pattern: "Looked for <text>", "Listed <pattern>", followed by " in <folder>"
// when it names a folder. One that names only a folder is "Looked in <folder>", one that names none of them undefined. tool: the
// call's tool name, when there is one, so that a file finder's pattern reads as its file pattern.
export function searchToolLabel(args,tool){
  const {text,files,folder}=searchTerms(args,tool);
  const subject=text!==undefined?`Looked for ${text}`:files!==undefined?`Listed ${files}`:undefined;
  if(subject===undefined)return folder===undefined?undefined:`Looked in ${folder}`;
  return folder===undefined?subject:`${subject} in ${folder}`;
}

// An edit or write is named by its file. One that failed or was declined did not happen, so its row names what was attempted
// ("Write notes.txt"), never a change.
function fileChangeLabel(args,status,{done,attempted}){
  const file=firstText(args,READ_ORDER.file);
  if(file===undefined)return undefined;
  return `${status==="failed"||status==="declined"?attempted:done} ${file}`;
}

const LABEL_OF_ACTION={
  read:args=>`Read ${firstText(args,READ_ORDER.file)??"file"}`,
  edit:(args,{status})=>fileChangeLabel(args,status,{done:"Edited",attempted:"Edit"}),
  write:(args,{status})=>fileChangeLabel(args,status,{done:"Wrote",attempted:"Write"}),
  // A search whose arguments name no text, file pattern or folder, such as a listing given only a depth.
  search:(args,{tool})=>searchToolLabel(args,tool)??(Object.keys(args).length?"Looked through the files":undefined),
  command:args=>commandLine(args),
};

// The row name of a dynamic (harness or Native) tool call, or undefined when its tool's own name is the best there is. Reads,
// searches and commands claim no outcome, so a failed one keeps its name.
export function dynamicToolLabel(item={}){
  const args=argumentObject(item.arguments)??argumentObject(item.input)??{};
  return LABEL_OF_ACTION[classifyToolCall(item)]?.(args,item);
}
