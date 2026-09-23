import test from "node:test";
import assert from "node:assert/strict";
import {applyFileMention,fileMentionAt,rankFileMentions} from "../ui/src/composer-mentions.js";

test("file mention parser targets only the active @ token",()=>{
  assert.deepEqual(fileMentionAt("check @App",10),{start:6,end:10,query:"App"});
  assert.deepEqual(fileMentionAt("one @src/App then",12),{start:4,end:12,query:"src/App"});
  assert.equal(fileMentionAt("mail@example.com",16),null);
  assert.equal(fileMentionAt("@old token more",15),null);
});

test("file mention insertion replaces the active token and preserves surrounding text",()=>{
  assert.deepEqual(applyFileMention("check @App please",{start:6,end:10},"ui/src/App.jsx"),{text:"check @ui/src/App.jsx please",caret:21});
});

test("file mention ranking prefers exact and prefix filename matches",()=>{
  const items=[
    {name:"Other.jsx",relativePath:"ui/AppHelper/Other.jsx"},
    {name:"App.test.jsx",relativePath:"ui/App.test.jsx"},
    {name:"App.jsx",relativePath:"ui/src/App.jsx"},
  ];
  assert.deepEqual(rankFileMentions(items,"App").map(item=>item.name),["App.jsx","App.test.jsx","Other.jsx"]);
});
