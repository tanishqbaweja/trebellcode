import test from "node:test";
import assert from "node:assert/strict";
import { formatRepositorySearchResult } from "../src/repository-search-format.mjs";

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
