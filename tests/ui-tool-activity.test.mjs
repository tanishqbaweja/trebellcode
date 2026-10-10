import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, dynamicToolLabel, searchToolLabel } from "../ui/src/tool-activity.js";

test("Native's own tool calls are named by what they do, as T3 names tool rows",()=>{
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"read_file",arguments:{path:"src/slug.js"}}),"Read src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"read_source",arguments:{path:"src/slug.js",startLine:1,endLine:40}}),"Read src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_code",arguments:{query:"slugify",regex:false}}),"Searched slugify");
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"search_files",arguments:{query:"slug"}}),"Searched slug");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"list",arguments:{path:"src/"}}),"Searched in src");
  assert.equal(dynamicToolLabel({namespace:"trebell_terminal",tool:"run",arguments:{command:"node",args:["--test"],cwd:"."}}),"node --test");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"replace_text",arguments:{path:"src/slug.js",old_text:"a",new_text:"b"}}),"Edited src/slug.js");
  assert.equal(dynamicToolLabel({namespace:"trebell_workspace",tool:"write_file",arguments:{path:"test/new.test.js",content:"x"}}),"Wrote test/new.test.js");
});

test("tools whose name says nothing about the action keep their name, and missing arguments never invent one",()=>{
  assert.equal(dynamicToolLabel({namespace:"trebell_process",tool:"start",arguments:{command:"npm",args:["run","dev"]}}),undefined);
  assert.equal(dynamicToolLabel({namespace:"trebell_repo",tool:"invoke",arguments:{capability:"diagnostics"}}),undefined);
  // A run outside Native's terminal namespace is not assumed to be a command.
  assert.equal(dynamicToolLabel({namespace:"github",tool:"run",arguments:{command:"x"}}),undefined);
  // Server-prefixed MCP names are not local reads (T3's toolNameToken rule).
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

test("search rows use T3's wording for query, glob and folder",()=>{
  assert.equal(searchToolLabel({pattern:"TODO",path:"src/components"}),"Searched TODO in components");
  assert.equal(searchToolLabel({glob:"*.{ts,tsx}",target_directory:"apps/web"}),"Searched files *.{ts,tsx} in web");
  assert.equal(searchToolLabel({glob:"*.md"}),"Searched files *.md");
  assert.equal(searchToolLabel({cwd:"."}),undefined);
  assert.equal(searchToolLabel({}),undefined);
});
