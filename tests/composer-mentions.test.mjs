import test from "node:test";
import assert from "node:assert/strict";
import {applyFileMention,fileMentionAt,rankFileMentions} from "../ui/src/composer-mentions.js";

test("file mention parser targets only the active @ token",()=>{
  assert.deepEqual(fileMentionAt("check @App",10),{start:6,end:10,query:"App"});
  assert.deepEqual(fileMentionAt("one @src/App then",12),{start:4,end:12,query:"src/App"});
  assert.equal(fileMentionAt("mail@example.com",16),null);
  assert.equal(fileMentionAt("@old token more",15),null);
});

test("file mention parser takes the whole word with the caret inside it, the query up to the caret",()=>{
  assert.deepEqual(fileMentionAt("Check @log",9),{start:6,end:10,query:"lo"});
  assert.deepEqual(fileMentionAt("Check @log please",7),{start:6,end:10,query:""});
  assert.deepEqual(fileMentionAt("one @src/App.jsx then",8),{start:4,end:16,query:"src"});
});

test("file mention insertion replaces the active token and preserves surrounding text",()=>{
  assert.deepEqual(applyFileMention("check @App please",{start:6,end:10},"ui/src/App.jsx"),{text:"check @ui/src/App.jsx please",caret:21});
});

test("a file picked with the caret inside its word replaces the whole word",()=>{
  assert.deepEqual(applyFileMention("Check @log",fileMentionAt("Check @log",9),"src/login.js"),{text:"Check @src/login.js ",caret:20});
  assert.deepEqual(applyFileMention("Check @log please",fileMentionAt("Check @log please",8),"src/login.js"),{text:"Check @src/login.js please",caret:19});
});

test("file mention ranking prefers exact and prefix filename matches",()=>{
  const items=[
    {name:"Other.jsx",relativePath:"ui/AppHelper/Other.jsx"},
    {name:"App.test.jsx",relativePath:"ui/App.test.jsx"},
    {name:"App.jsx",relativePath:"ui/src/App.jsx"},
  ];
  assert.deepEqual(rankFileMentions(items,"App").map(item=>item.name),["App.jsx","App.test.jsx","Other.jsx"]);
});
