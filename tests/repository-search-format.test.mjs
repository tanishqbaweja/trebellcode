import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine } from "../src/context-engine.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { formatRepositorySearchResult } from "../src/repository-search-format.mjs";

const execFileAsync=promisify(execFile);
const utf8Bytes=text=>Buffer.byteLength(text,"utf8");

test("code search results list each file's path once, then line: text",()=>{
  const text=formatRepositorySearchResult("search_code",{
    query:"rotateRefreshToken",regex:false,caseSensitive:false,source:"git-grep",complete:true,truncated:false,totalMatches:3,matchedFiles:2,
    data:[
      {path:"src/auth/session.js",line:1,text:'import { rotateRefreshToken } from "./token.js";'},
      {path:"src/auth/session.js",line:3,text:"  refresh(token) { return rotateRefreshToken(token); }   "},
      {path:"src/auth/token.js",line:1,text:"export function rotateRefreshToken(token) {",definition:true},
    ],
  });
  assert.equal(text,[
    "3 matches in 2 files",
    "src/auth/session.js",
    '  1: import { rotateRefreshToken } from "./token.js";',
    "  3:   refresh(token) { return rotateRefreshToken(token); }",
    "src/auth/token.js",
    "  1: export function rotateRefreshToken(token) {",
  ].join("\n"));
});

test("code search hits past the limit stay listed as line numbers under their file",()=>{
  const text=formatRepositorySearchResult("search_code",{
    query:"def write",source:"git-grep",complete:false,truncated:true,totalMatches:7,matchedFiles:3,path:"astropy/io",
    data:[
      {path:"astropy/io/ascii/core.py",line:1020,text:"    def write(self, lines):",definition:true},
      {path:"astropy/io/ascii/core.py",line:1472,text:"    def write(self, table):",definition:true},
      {path:"astropy/io/ascii/html.py",line:340,text:"    def write(self, table):",definition:true},
    ],
    more:[
      {path:"astropy/io/ascii/core.py",count:2,lines:[1468,1500]},
      {path:"astropy/io/ascii/ui.py",count:2,lines:[12,40]},
    ],
  });
  assert.equal(text,[
    "7 matches in 3 files (path: astropy/io); 3 shown with text, the rest by line number",
    "astropy/io/ascii/core.py",
    "  1020:     def write(self, lines):",
    "  1472:     def write(self, table):",
    "  +2 more at 1468, 1500",
    "astropy/io/ascii/html.py",
    "  340:     def write(self, table):",
    "astropy/io/ascii/ui.py",
    "  +2 more at 12, 40",
  ].join("\n"));
});

test("code search results say when line numbers, files or the regex were cut or replaced",()=>{
  const text=formatRepositorySearchResult("search_code",{
    query:"(foo",regex:false,regexFallback:"Invalid regular expression: /(foo/i: Unterminated group",glob:"*.py",source:"git-grep",complete:false,truncated:true,
    totalMatches:130,matchedFiles:2,skippedLargeFiles:1,listingCapped:true,
    data:[{path:"a.py",line:1,text:"(foo"}],
    more:[{path:"a.py",count:128,lines:[2,3,4]},{path:"b.py",count:1,lines:[]}],
    unreadFiles:Array.from({length:22},(_,index)=>"pkg/f"+index+".py"),
  });
  const lines=text.split("\n");
  assert.equal(lines[0],"130 matches in 2 files (glob: *.py); 1 shown with text, the rest by line number");
  assert.equal(lines[1],"Not a valid regular expression (Invalid regular expression: /(foo/i: Unterminated group), so this is a literal text search.");
  assert.match(text,/^22 more matching files not searched line by line: pkg\/f0\.py, pkg\/f1\.py, .*pkg\/f19\.py, \+2 more\. Narrow with path or glob to see their matches\.$/m);
  assert.match(text,/^More files match than were listed; narrow with path or glob\.$/m);
  assert.match(text,/^1 matching file was too large to read\.$/m);
  assert.match(text,/^  \+128 more at 2, 3, 4, …$/m);
  assert.match(text,/^b\.py\n  \+1 more$/m);
});

test("the line numbers of a broad code search share a byte budget, so the hits shown with text stay in hot context",()=>{
  const shownFiles=Array.from({length:20},(_,index)=>`src/acme_platform/service_layer/shown_${index}/request_handler_module.py`);
  const otherFiles=Array.from({length:220},(_,index)=>`src/acme_platform/service_layer/package_${index}/request_handler_module.py`);
  const data=shownFiles.flatMap(path=>[1,2,3,6].map(line=>({path,line,text:line===6?"    import json":"import os"})));
  const more=[
    ...shownFiles.map(path=>({path,count:2,lines:[40,52]})),
    ...otherFiles.map((path,index)=>({path,count:4,lines:[1,2,3,6],...(index===219?{definitions:[6]}:{})})),
  ];
  const text=formatRepositorySearchResult("search_code",{query:"import",source:"git-grep",complete:false,truncated:true,totalMatches:1000,matchedFiles:240,data,more,
    unreadFiles:Array.from({length:20},(_,index)=>`src/acme_platform/unread/module_${index}.py`),unreadFileCount:60});
  const lines=text.split("\n");
  assert.ok(utf8Bytes(text)<=15*1024,`the text has ${utf8Bytes(text)} bytes`);
  assert.equal(lines[0],"1000 matches in 240 files; 80 shown with text, the rest by line number");
  for(const path of shownFiles){
    const at=lines.indexOf(path);assert.ok(at>0,path);
    assert.deepEqual(lines.slice(at+1,at+6),["  1: import os","  2: import os","  3: import os","  6:     import json","  +2 more at 40, 52"],"every hit shown with text, then its file's other line numbers");
  }
  const listedOthers=otherFiles.filter(path=>lines.includes(path));
  assert.ok(listedOthers.length>0&&listedOthers.length<otherFiles.length,`${listedOthers.length} of the files with no hit shown are listed`);
  assert.deepEqual(listedOthers.slice(0,-1),otherFiles.slice(0,listedOthers.length-1),"files with only line numbers are listed in order until the budget runs out");
  const last=otherFiles.at(-1);
  assert.equal(lines[lines.indexOf(last)+1],"  +4 more at 6, …","a definition's line number is kept past the budget");
  const omitted=otherFiles.length-listedOthers.length;
  const summary=lines.find(line=>/more files with \d+ matches by line number, not listed here: /.test(line));
  assert.ok(summary,text.slice(-1200));
  assert.ok(summary.startsWith(`${omitted} more files with ${omitted*4} matches by line number, not listed here: ${otherFiles[listedOthers.length-1]}, `),summary);
  assert.ok(summary.endsWith(`, +${omitted-3} more.`),summary);
  assert.ok(lines.includes("Not every line number is listed; narrow with path or glob to see them all."));
  assert.match(text,/^60 more matching files not searched line by line: src\/acme_platform\/unread\/module_0\.py, .*, \+\d+ more\. Narrow with path or glob to see their matches\.$/m);
});

test("a broad code search of a real repository stays within the hot-context bound and is not previewed",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-search-budget-")),store=join(root,"..",root.split(/[\\/]/).at(-1)+"-store");
  try{
    for(let pkg=0;pkg<12;pkg++){
      const folder=join(root,"src","acme_platform","service_layer","package_"+pkg);await mkdir(folder,{recursive:true});
      for(let file=0;file<25;file++){
        await writeFile(join(folder,"request_handler_module_"+file+".py"),["import os","import sys","from typing import Any","","def handler_"+file+"(request: Any) -> Any:","    import json","    return json.dumps({'path': os.getcwd(), 'argv': sys.argv})",""].join("\n"),"utf8");
      }
    }
    await execFileAsync("git",["init","-q"],{cwd:root});await execFileAsync("git",["add","."],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","fixture"],{cwd:root});
    const outputs=new NativeToolOutputStore({directory:store});
    for(const query of ["import","handler"]){
      const result=await new ContextEngine().searchCode({root,query,limit:80}),text=formatRepositorySearchResult("search_code",result);
      assert.ok(result.data.length>=80,`${query}: the limit's 80 hits (and definitions past it) are shown with text`);
      assert.ok(utf8Bytes(text)<=16*1024,`${query}: ${utf8Bytes(text)} bytes`);
      for(const hit of result.data)assert.ok(text.includes(`  ${hit.line}: ${hit.text.replace(/\s+$/,"")}`),`${query}: ${hit.path}:${hit.line} is shown`);
      const shaped=await outputs.virtualize(text,{namespace:"trebell_repo",name:"search_code"});
      assert.equal(shaped.virtualized,false,`${query}: the model reads the whole result`);
      assert.equal(shaped.value,text);
    }
  }finally{await Promise.all([rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}),rm(store,{recursive:true,force:true,maxRetries:20,retryDelay:250})])}
});

test("definition hits past the limit keep their text only while the result stays in hot context, and the rest are listed by line number",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-search-extra-definitions-")),store=join(root,"..",root.split(/[\\/]/).at(-1)+"-store");
  try{
    const folder=join(root,"src","acme_platform","widgets");await mkdir(folder,{recursive:true});
    const files=Array.from({length:130},(_,index)=>`src/acme_platform/widgets/widget_${String(index).padStart(3,"0")}.py`);
    for(const [index,path] of files.entries())await writeFile(join(root,path),[`def render_widget_${index}(request, template_name="widgets/default.html", context=None, using=None, status=None):`,"    return None",""].join("\n"),"utf8");
    await execFileAsync("git",["init","-q"],{cwd:root});await execFileAsync("git",["add","."],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","fixture"],{cwd:root});
    const result=await new ContextEngine().searchCode({root,query:"render_widget",limit:80}),text=formatRepositorySearchResult("search_code",result);
    assert.equal(result.totalMatches,130);
    assert.ok(result.data.length>=80&&result.data.length<120,`${result.data.length} hits shown with text`);
    assert.ok(result.data.every(hit=>hit.definition===true));
    const shown=new Set(result.data.map(hit=>hit.path)),listed=(result.more||[]).filter(entry=>entry.definitions?.length===1&&entry.definitions[0]===1).map(entry=>entry.path);
    assert.deepEqual([...shown,...listed].sort(),files,"each definition is shown with text or listed by line number");
    assert.ok(utf8Bytes(text)<=16*1024,`${utf8Bytes(text)} bytes`);
    assert.ok(text.includes(`${listed[0]}\n  +1 more at 1\n`),"the first definition left without text is listed by its line number");
    const shaped=await new NativeToolOutputStore({directory:store}).virtualize(text,{namespace:"trebell_repo",name:"search_code"});
    assert.equal(shaped.virtualized,false,"the model reads the whole result");
  }finally{await Promise.all([rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}),rm(store,{recursive:true,force:true,maxRetries:20,retryDelay:250})])}
});

test("code search without git grep says that only indexed source was searched",()=>{
  const text=formatRepositorySearchResult("search_code",{query:"x",source:"index-sample",complete:false,truncated:true,totalMatches:0,matchedFiles:0,data:[]});
  assert.equal(text,"No matches.\nGit grep was unavailable, so only indexed source was searched; results may be incomplete.");
});

test("symbol search results are grouped by file and keep the remaining definitions as line numbers",()=>{
  const text=formatRepositorySearchResult("search_symbols",{
    query:"write",totalMatches:5,glob:"*.py",
    data:[
      {path:"pkg/core.py",name:"write",kind:"function",line:1472,signature:"def write(self, table):",parser:"regex",score:100},
      {path:"pkg/html.py",name:"write",kind:"function",line:340,signature:"def write(self, table):",parser:"regex",score:100},
      {path:"pkg/core.py",name:"write",kind:"function",line:1020,signature:"def write(self, lines):",parser:"regex",score:100},
    ],
    more:[{path:"pkg/core.py",count:1,lines:[1468]},{path:"pkg/ui.py",count:1,lines:[12]}],
  });
  assert.equal(text,[
    "5 definitions in 3 files (glob: *.py); 3 shown with text, the rest by line number",
    "pkg/core.py",
    "  1020: def write(self, lines):",
    "  1472: def write(self, table):",
    "  +1 more at 1468",
    "pkg/html.py",
    "  340: def write(self, table):",
    "pkg/ui.py",
    "  +1 more at 12",
  ].join("\n"));
  assert.equal(formatRepositorySearchResult("search_symbols",{query:"nothing",data:[],totalMatches:0,path:"src"}),"No definitions (path: src).");
});

test("file search results are one path per line and count what the limit left out",()=>{
  assert.equal(formatRepositorySearchResult("search_files",{query:"session",data:[{path:"src/auth/session.js",score:95,indexedSource:true,extension:".js"},{path:"docs/session.md",score:95,indexedSource:false,extension:".md"}],totalMatches:2}),"2 matching files\nsrc/auth/session.js\ndocs/session.md");
  assert.equal(formatRepositorySearchResult("search_files",{query:"a",data:[{path:"a.js",score:110}],totalMatches:40,path:"src"}),"40 matching files (path: src); 1 shown, narrow with path or glob to see the rest\na.js");
  assert.equal(formatRepositorySearchResult("search_files",{query:"zzz",data:[],totalMatches:0}),"No matching files.");
});

test("only the three search tools have a grouped text form",()=>{
  assert.equal(formatRepositorySearchResult("read_source",{path:"a.js",content:"x"}),null);
  assert.equal(formatRepositorySearchResult("search_code",null),null);
});
