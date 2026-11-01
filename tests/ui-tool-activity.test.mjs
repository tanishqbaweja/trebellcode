import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, dynamicToolLabel, searchToolLabel } from "../ui/src/tool-activity.js";

test("Native's own tool calls are named by what they do",()=>{
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"read_file",arguments:{path:"src/slug.js"}}),"Read src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"read_source",arguments:{path:"src/slug.js",startLine:1,endLine:40}}),"Read src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_code",arguments:{query:"slugify",regex:false}}),"Looked for slugify");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_files",arguments:{query:"slug"}}),"Looked for slug");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"list",arguments:{path:"src/"}}),"Looked in src");
  assert.equal(dynamicToolLabel({namespace:"trebell_terminal",tool:"run",arguments:{command:"node",args:["--test"],cwd:"."}}),"node --test");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"replace_text",arguments:{path:"src/slug.js",old_text:"a",new_text:"b"}}),"Edited src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"write_file",arguments:{path:"test/new.test.js",content:"x"}}),"Wrote test/new.test.js");
});

test("an edit or write that failed or was declined names what it attempted, not a change that happened",()=>{
  const write={namespace:"trebell_workspace",tool:"write_file",arguments:{path:"tour-readonly.txt",content:"hello"}};
  const edit={namespace:"trebell_workspace",tool:"replace_text",arguments:{path:"src/slug.js",old_text:"a",new_text:"b"}};
  assert.equal(dynamicToolLabel({...write,status:"failed"}),"Write tour-readonly.txt");
  assert.equal(dynamicToolLabel({...edit,status:"declined"}),"Edit src/slug.js");
  for(const status of ["completed","inProgress",undefined]){
    assert.equal(dynamicToolLabel({...write,status}),"Wrote tour-readonly.txt");
    assert.equal(dynamicToolLabel({...edit,status}),"Edited src/slug.js");
  }
  // Reads, searches and commands do not claim an outcome, so a failed one keeps its name.
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"read_source",arguments:{path:"greet.py"},status:"failed"}),"Read greet.py");
});

test("a listing or search whose arguments name no query, files or folder is \"Looked through the files\"",()=>{
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"list",arguments:{depth:2}}),"Looked through the files");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_code",arguments:{regex:false}}),"Looked through the files");
});

test("tools whose name says nothing about the action keep their name, and missing arguments never invent one",()=>{
  assert.equal(dynamicToolLabel({namespace:"trebell_process",tool:"start",arguments:{command:"npm",args:["run","dev"]}}),undefined);
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"invoke",arguments:{capability:"diagnostics"}}),undefined);
  // A run outside Native's terminal namespace is not assumed to be a command.
  assert.equal(dynamicToolLabel({namespace:"github",tool:"run",arguments:{command:"x"}}),undefined);
  // Server-prefixed MCP names are not local reads.
  assert.equal(classifyToolCall({namespace:"mcp",tool:"github.read_file"}),"other");
  assert.equal(classifyToolCall({namespace:"mcp",tool:"mcp__db__find"}),"other");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"read_file",arguments:{}}),"Read file");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"replace_text",arguments:{}}),undefined);
  assert.equal(dynamicToolLabel({namespace:"trebell_terminal",tool:"run",arguments:{}}),undefined);
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_code",arguments:{}}),undefined);
});

test("arguments sent as a JSON string or a command array are read the same way",()=>{
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:JSON.stringify({path:"README.md"})}),"Read README.md");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"shell",arguments:{command:["git","status","--short"]}}),"git status --short");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:"not json"}),"Read file");
});

test("search rows use one wording for query, glob and folder",()=>{
  assert.equal(searchToolLabel({pattern:"TODO",path:"src/components"}),"Looked for TODO in components");
  assert.equal(searchToolLabel({glob:"*.{js,jsx}",path:"ui/src"}),"Listed *.{js,jsx} in src");
  assert.equal(searchToolLabel({glob:"*.md"}),"Listed *.md");
  assert.equal(searchToolLabel({cwd:"."}),undefined);
  assert.equal(searchToolLabel({}),undefined);
});

test("a Native edit sent as an edits list is named by its file like a single replacement",()=>{
  const edit={namespace:"trebell_workspace",tool:"replace_text",arguments:{path:"src/slug.js",edits:[{old_text:"a",new_text:"b"},{old_text:"c",new_text:"d"}]}};
  assert.equal(dynamicToolLabel(edit),"Edited src/slug.js");
  assert.equal(dynamicToolLabel({...edit,status:"failed"}),"Edit src/slug.js");
});

// The names come from the harnesses' documented tool schemas, Trebell Native's own first: file path, file_path, notebook_path,
// filePath; text query, pattern; file pattern glob, include; folder path, dir_path. Names no harness documents (cwd, directory,
// fileName, globPattern, needle, oldPath, relativePath, root, searchTerm, target_directory and the like) are not read.
test("a file is read from each harness's documented names, Native's first, the first that holds text winning, trimmed",()=>{
  const read=args=>dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:args});
  for(const name of ["path","file_path","notebook_path","filePath"])assert.equal(read({[name]:"notes.md"}),"Read notes.md",name);
  assert.equal(read({filePath:"oc.md",notebook_path:"nb.ipynb",file_path:"cc.md",path:"p.md"}),"Read p.md");
  assert.equal(read({filePath:"oc.md",notebook_path:"nb.ipynb",file_path:"cc.md"}),"Read cc.md");
  assert.equal(read({filePath:"oc.md",notebook_path:"nb.ipynb"}),"Read nb.ipynb");
  // Both spellings at once: Claude Code's file_path is read before OpenCode's filePath (the other way round before).
  assert.equal(read({file_path:"snake.md",filePath:"camel.md"}),"Read snake.md");
  // A blank or non-text value is passed over for the next name; a value is shown trimmed.
  assert.equal(read({path:"   ",file_path:42,notebook_path:null,filePath:"  docs/a.md  "}),"Read docs/a.md");
  assert.equal(read({Path:"a.md",relative_path:"b.md"}),"Read file");
  for(const name of ["filename","fileName","newPath","oldPath","relativePath","target_file"])assert.equal(read({[name]:"notes.md"}),"Read file",name);
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"write_file",arguments:{content:"x"}}),undefined);
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"write_file",arguments:{fileName:"notes.md",content:"x"}}),undefined);
});

test("a search's text, file pattern and folder are each read from their documented names, Native's first",()=>{
  for(const name of ["query","pattern"])assert.equal(searchToolLabel({[name]:"TODO"}),"Looked for TODO",name);
  for(const name of ["glob","include"])assert.equal(searchToolLabel({[name]:"*.md"}),"Listed *.md",name);
  for(const name of ["path","dir_path"])assert.equal(searchToolLabel({[name]:"docs/guides"}),"Looked in guides",name);
  // Native's query is read before the pattern the other harnesses document (the pattern was read first before).
  assert.equal(searchToolLabel({pattern:"p",query:"q"}),"Looked for q");
  assert.equal(searchToolLabel({include:"*.i",glob:"*.g"}),"Listed *.g");
  assert.equal(searchToolLabel({dir_path:"d",path:"p"}),"Looked in p");
  for(const name of ["cwd","directory","file_pattern","filePattern","glob_pattern","globPattern","grep","needle","regex","root","searchTerm","target_directory","targetDirectory"])
    assert.equal(searchToolLabel({[name]:"src/x"}),undefined,name);
  // Native's regex flag is a boolean, not a query.
  assert.equal(searchToolLabel({query:"slugify",regex:true}),"Looked for slugify");
  assert.equal(searchToolLabel({regex:false,path:"src"}),"Looked in src");
});

test("a search names its folder by the last part, and a first folder of only dots names none",()=>{
  assert.equal(searchToolLabel({query:"x",dir_path:"C:\\work\\repo\\lib\\"}),"Looked for x in lib");
  assert.equal(searchToolLabel({query:"x",path:"./src/./"}),"Looked for x in src");
  assert.equal(searchToolLabel({query:"x",path:" src/ "}),"Looked for x in src");
  assert.equal(searchToolLabel({query:"x",path:"./"}),"Looked for x");
  // The first folder name that holds text is the folder, even when it names none and a later name does.
  assert.equal(searchToolLabel({query:"x",path:".",dir_path:"repo"}),"Looked for x");
  assert.equal(searchToolLabel({path:".",dir_path:"src"}),undefined);
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"list",arguments:{path:"."}}),"Looked through the files");
});

test("a search names its text before its file pattern, with a folder or without one",()=>{
  assert.equal(searchToolLabel({query:"slugify",glob:"*.js",path:"src"}),"Looked for slugify in src");
  // Without a folder the text still comes first (the file pattern did before: "Listed *.js").
  assert.equal(searchToolLabel({query:"slugify",glob:"*.js"}),"Looked for slugify");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_code",arguments:{query:"slugify",glob:"*.js"}}),"Looked for slugify");
  assert.equal(searchToolLabel({glob:"*.js",path:"src"}),"Listed *.js in src");
  assert.equal(searchToolLabel({query:"slugify"}),"Looked for slugify");
  assert.equal(searchToolLabel({path:"src"}),"Looked in src");
  assert.equal(searchToolLabel(undefined),undefined);
  assert.equal(searchToolLabel(undefined,"Glob"),undefined);
});

test("each harness's documented tool arguments name its rows",()=>{
  const row=(tool,args,extra={})=>dynamicToolLabel({namespace:"harness",tool,arguments:args,...extra});
  // Claude Code: Read, Write and Edit take file_path, NotebookEdit notebook_path; Grep takes pattern, glob and path.
  assert.equal(row("Read",{file_path:"/repo/README.md",offset:10,limit:40}),"Read /repo/README.md");
  assert.equal(row("Write",{file_path:"/repo/notes.txt",content:"x"}),"Wrote /repo/notes.txt");
  assert.equal(row("Edit",{file_path:"/repo/a.js",old_string:"a",new_string:"b",replace_all:false},{status:"declined"}),"Edit /repo/a.js");
  assert.equal(row("NotebookEdit",{notebook_path:"/repo/nb.ipynb",new_source:"x"},{kind:"edit"}),"Edited /repo/nb.ipynb");
  assert.equal(row("Grep",{pattern:"TODO",glob:"*.ts",path:"/repo/src",output_mode:"content","-n":true}),"Looked for TODO in src");
  assert.equal(row("Grep",{pattern:"TODO",type:"js"}),"Looked for TODO");
  // OpenCode: read, write and edit take filePath (1.x) or path; grep takes pattern, include and path; list takes path.
  assert.equal(row("read",{filePath:"/repo/notes.txt"}),"Read /repo/notes.txt");
  assert.equal(row("edit",{path:"src/a.ts",oldString:"a",newString:"b"}),"Edited src/a.ts");
  assert.equal(row("grep",{pattern:"slugify",include:"*.{ts,tsx}"}),"Looked for slugify");
  assert.equal(row("grep",{include:"*.{ts,tsx}",path:"packages/core"}),"Listed *.{ts,tsx} in core");
  assert.equal(row("list",{path:"src/tool"}),"Looked in tool");
  // ACP agents (Gemini CLI's file tools, which Antigravity carries on) report the kind; list_directory takes dir_path.
  assert.equal(row("read_file",{file_path:"/w/main.py"},{kind:"read"}),"Read /w/main.py");
  assert.equal(row("replace",{file_path:"/w/main.py",old_string:"a",new_string:"b"},{kind:"edit"}),"Edited /w/main.py");
  assert.equal(row("grep_search",{pattern:"def main",include:"*.py",path:"/w/app"},{kind:"search"}),"Looked for def main in app");
  assert.equal(row("list_directory",{dir_path:"/w/app/models"},{kind:"search"}),"Looked in models");
});

test("a file finder's pattern is its file pattern, every other search's pattern its text",()=>{
  // Claude Code's Glob, OpenCode's glob and the ACP agents' glob document "pattern" as the files to match (it read as text before).
  assert.equal(searchToolLabel({pattern:"**/*.ts",path:"src/components"},"Glob"),"Listed **/*.ts in components");
  assert.equal(searchToolLabel({pattern:"*.md"},"glob"),"Listed *.md");
  assert.equal(dynamicToolLabel({namespace:"harness",tool:"Glob",arguments:{pattern:"src/**/*.tsx"}}),"Listed src/**/*.tsx");
  assert.equal(dynamicToolLabel({namespace:"harness",tool:"glob",arguments:{pattern:"**/*.py",path:"/w/app"},kind:"search"}),"Listed **/*.py in app");
  // The finder's pattern is read before the other file pattern names; a finder still names a query as its text.
  assert.equal(searchToolLabel({pattern:"*.a",glob:"*.b"},"Glob"),"Listed *.a");
  assert.equal(searchToolLabel({glob:"*.b"},"Glob"),"Listed *.b");
  assert.equal(searchToolLabel({query:"x",pattern:"*.a"},"Glob"),"Looked for x");
  // Without the tool's name, or on a content search, the pattern is the text.
  assert.equal(searchToolLabel({pattern:"*.md"}),"Looked for *.md");
  assert.equal(searchToolLabel({pattern:"TODO",glob:"*.md"},"Grep"),"Looked for TODO");
  // A server's glob is no local file finder.
  assert.equal(dynamicToolLabel({namespace:"mcp",tool:"fs.glob",arguments:{pattern:"*.md"}}),undefined);
});

test("a tool's name is read whatever its case, spaces, hyphens or underscores, and a server's tool is never a local read or search",()=>{
  for(const [tool,action] of [["Read","read"],["READ_FILE","read"],["read-source","read"],["Read File","read"],["Grep","search"],["LS","search"],["rg","search"],["Search_Symbols","search"],["find","search"],["Glob","search"],["Bash","command"],["Terminal","command"],["Edit","edit"],["edit-file","edit"],["Write","write"],["WriteFile","write"]])
    assert.equal(classifyToolCall({namespace:"codex",tool}),action,tool);
  for(const tool of ["server/grep","mcp__fs__read_file","github.search_code","files.ls","read__file"]){
    assert.equal(classifyToolCall({namespace:"mcp",tool}),"other",tool);
    assert.equal(dynamicToolLabel({namespace:"mcp",tool,arguments:{path:"src/app.js",query:"x"}}),undefined,tool);
  }
  // "run" is a command only as Native's terminal tool.
  assert.equal(classifyToolCall({namespace:"trebell_terminal",tool:"Run"}),"command");
  assert.equal(classifyToolCall({namespace:"trebell_process",tool:"run"}),"other");
});

test("an ACP kind names the action when the tool's name does not, and the stronger of the two wins when both do",()=>{
  for(const [kind,action] of [["execute","command"],["edit","edit"],["search","search"],["read","read"],[" Execute ","command"],["EDIT","edit"],["delete","other"],["move","other"],["fetch","other"],["think","other"]])
    assert.equal(classifyToolCall({namespace:"codex",tool:"snapshot",kind}),action,kind);
  assert.equal(classifyToolCall({namespace:"codex",tool:"read_file",kind:"edit"}),"edit");
  assert.equal(classifyToolCall({namespace:"codex",tool:"write",kind:"search"}),"write");
  assert.equal(classifyToolCall({namespace:"codex",tool:"grep",kind:"read"}),"search");
  assert.equal(classifyToolCall({namespace:"codex",tool:"replace_text",kind:"execute"}),"command");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"View",kind:"read",arguments:{file_path:"README.md"}}),"Read README.md");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"Exec",kind:"execute",arguments:{command:"ls -la"}}),"ls -la");
});

test("arguments come from the item's input when its arguments are not an object, and JSON text that is no object counts as none",()=>{
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:"not json",input:{path:"a.md"}}),"Read a.md");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",input:"\n  {\"filePath\":\"b.md\"}"}),"Read b.md");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:"[{\"path\":\"c.md\"}]"}),"Read file");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:"{\"path\":"}),"Read file");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"read_file",arguments:["d.md"]}),"Read file");
  assert.equal(dynamicToolLabel({namespace:"codex",tool:"grep",arguments:"{}"}),undefined);
});

test("a command line is a listed command's items joined by spaces, or a command's text followed by its args",()=>{
  const run=args=>dynamicToolLabel({namespace:"trebell_terminal",tool:"run",arguments:args});
  assert.equal(run({command:["git",1,null,"x"]}),"git 1 null x");
  assert.equal(run({command:["  npm ","test  "],args:["ignored"]}),"npm  test");
  assert.equal(run({command:[]}),undefined);
  assert.equal(run({command:[" "]}),undefined);
  assert.equal(run({command:"  npm  ",args:["run",1]}),"npm run 1");
  assert.equal(run({command:"npm",args:"run"}),"npm");
  assert.equal(run({command:42}),undefined);
});
