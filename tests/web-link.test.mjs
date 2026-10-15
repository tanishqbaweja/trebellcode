import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openWebLink, webLinkHref } from "../ui/src/web-link.js";

test("a link from the server opens only when it is a web or mail link, in a new tab that cannot reach back",()=>{
  const opened=[],open=(...args)=>opened.push(args);
  assert.equal(openWebLink("https://github.com/tanishqbaweja/trebellcode/pull/7",{open}),true);
  assert.equal(openWebLink("http://localhost:5173/",{open}),true);
  assert.equal(openWebLink("mailto:someone@example.com",{open}),true);
  assert.deepEqual(opened,[
    ["https://github.com/tanishqbaweja/trebellcode/pull/7","_blank","noopener,noreferrer"],
    ["http://localhost:5173/","_blank","noopener,noreferrer"],
    ["mailto:someone@example.com","_blank","noopener,noreferrer"],
  ]);
  for(const refused of ["javascript:alert(document.domain)"," JavaScript:alert(1)","data:text/html,<script>alert(1)</script>","file:///C:/Windows/win.ini","vbscript:msgbox(1)","/api/state","","not a link",null,undefined]){
    assert.equal(openWebLink(refused,{open}),false,`refused: ${refused}`);
    assert.equal(webLinkHref(refused),null);
  }
  assert.equal(opened.length,3,"nothing else was opened");
});

// Every window.open in the UI goes through the helper, except the MCP link request, which checks its own (stricter) rule.
test("the UI opens server-supplied links only through the web-link helper",async()=>{
  const { readdir }=await import("node:fs/promises");
  const root=new URL("../ui/src/",import.meta.url),files=[];
  const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const url=new URL(entry.name+(entry.isDirectory()?"/":""),dir);if(entry.isDirectory())await walk(url);else if(/\.(jsx?|mjs)$/.test(entry.name))files.push(url)}};
  await walk(root);
  const direct=[];
  for(const file of files){
    if(file.pathname.endsWith("/web-link.js")||file.pathname.endsWith("/McpElicitationModal.jsx"))continue;
    const text=await readFile(file,"utf8");
    for(const [index,line] of text.split("\n").entries())if(/window\.open\(/.test(line))direct.push(`${file.pathname.split("/ui/src/")[1]}:${index+1}`);
  }
  assert.deepEqual(direct,[],"window.open outside the helper");
});
