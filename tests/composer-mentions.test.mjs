import test from "node:test";
import assert from "node:assert/strict";
import {applyFileMention,fileMentionAt,movedFileMention,rankFileMentions} from "../ui/src/composer-mentions.js";

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

// The person types on while the picked file imports: the pick goes on its word where it is in the draft once the file is in.
test("a pick put into the draft typed on meanwhile finds its word again and keeps what was typed around it",()=>{
  const at={start:6,end:10,query:"log"};
  assert.equal(movedFileMention("Check @log",at,"Check @log",10),at);
  // Letters typed on at the word's end go after the file, the caret after them.
  assert.equal(movedFileMention("Check @log",at,"Check @lognow",13),at);
  assert.deepEqual(applyFileMention("Check @lognow",at,"src/login.js",13),{text:"Check @src/login.js now",caret:23});
  assert.deepEqual(applyFileMention("Check @log now",at,"src/login.js",14),{text:"Check @src/login.js now",caret:23});
  assert.equal(movedFileMention("Check @log",at,"Check @logg",11),at);
  // An edit before the word moves it, and the caret stays in what was typed there.
  const moved=movedFileMention("Check @log",at,"Please Check @log",7);
  assert.deepEqual(moved,{start:13,end:17,query:"log"});
  assert.deepEqual(applyFileMention("Please Check @log",moved,"src/login.js",7),{text:"Please Check @src/login.js ",caret:7});
  assert.deepEqual(movedFileMention("Now check @log",{start:10,end:14,query:"log"},"check @log",0),{start:6,end:10,query:"log"});
  assert.deepEqual(movedFileMention("Check @log",at,"Look @log",4),{start:5,end:9,query:"log"});
  // An edit in the word or over it leaves no word to put the file on: letters typed inside it (a g before its g), the word erased.
  assert.equal(movedFileMention("Check @log",at,"Check @lonowg",12),null);
  assert.equal(movedFileMention("Check @log",at,"Check @logg",10),null);
  assert.equal(movedFileMention("Check @log",at,"Check @",7),null);
  assert.equal(movedFileMention("Check @log",at,"",0),null);
});

test("file mention ranking prefers exact and prefix filename matches",()=>{
  const items=[
    {name:"Other.jsx",relativePath:"ui/AppHelper/Other.jsx"},
    {name:"App.test.jsx",relativePath:"ui/App.test.jsx"},
    {name:"App.jsx",relativePath:"ui/src/App.jsx"},
  ];
  assert.deepEqual(rankFileMentions(items,"App").map(item=>item.name),["App.jsx","App.test.jsx","Other.jsx"]);
});
