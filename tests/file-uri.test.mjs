import test from "node:test";
import assert from "node:assert/strict";
import { fileUri, fileUriPath } from "../src/file-uri.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { antigravityPromptParts } from "../src/acp-agent-session.mjs";

test("file links are percent-encoded file: URLs that keep each path's own style",()=>{
  const cases=[
    ["H:\\Github Repositories\\Trebell\\src\\a b#1%.mjs","file:///H:/Github%20Repositories/Trebell/src/a%20b%231%25.mjs"],
    ["/home/dev/my repo/x?.py","file:///home/dev/my%20repo/x%3F.py"],
    ["\\\\server\\share\\dir\\f.txt","file://server/share/dir/f.txt"],
  ];
  for(const [path,href] of cases){
    assert.equal(fileUri(path),href,path);
    assert.equal(fileUriPath(href),path,href);
  }
  assert.equal(fileUriPath("https://example.com/a.txt"),null,"only file: URLs name a path");
  assert.equal(fileUriPath("not a url"),null);
  assert.equal(fileUriPath(undefined),null);
});

test("a mentioned file reaches harnesses as an encoded file link that Antigravity can still open",async()=>{
  const path="H:\\Github Repositories\\Trebell\\README.md";
  const prompt=await contextualAgentPrompt([{type:"text",text:"Summarize"},{type:"mention",name:"README.md",path}]);
  assert.deepEqual(prompt[1],{type:"resource_link",uri:"file:///H:/Github%20Repositories/Trebell/README.md",name:"README.md"});
  // Antigravity reads the linked file to embed it; a missing file keeps its link instead of failing the prompt.
  const missing={type:"resource_link",uri:fileUri("H:\\no such folder\\notes.md"),name:"notes.md"};
  assert.deepEqual(await antigravityPromptParts([missing]),[missing]);
});
