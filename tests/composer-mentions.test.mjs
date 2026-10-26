import test from "node:test";
import assert from "node:assert/strict";
import {applyFileMention,fileMentionAt,movedFileMention,namesFileAt,offeredFileMentions,pickedFileMention,rankFileMentions} from "../ui/src/composer-mentions.js";
import {rankWorkspaceSearchItems} from "../src/workspace.mjs";

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

// The punctuation that ends the word (a full stop, a comma, a closing bracket or quote) is not part of it: a pick with the caret before
// it or inside the word keeps it after the file, where the whole word up to the next whitespace took it (round 8 repair).
test("a file picked with the caret before the punctuation after its word, or inside the word, keeps the punctuation",()=>{
  assert.deepEqual(fileMentionAt("Look at @log.",12),{start:8,end:12,query:"log"});
  assert.deepEqual(fileMentionAt("Look at @log.",11),{start:8,end:12,query:"lo"});
  assert.deepEqual(fileMentionAt("Check @log, then run it",10),{start:6,end:10,query:"log"});
  assert.deepEqual(fileMentionAt("Is it @log?!",9),{start:6,end:10,query:"lo"});
  assert.deepEqual(applyFileMention("Look at @log.",fileMentionAt("Look at @log.",12),"src/login.js"),{text:"Look at @src/login.js .",caret:22});
  assert.deepEqual(applyFileMention("Check @log, then run it",fileMentionAt("Check @log, then run it",10),"src/login.js"),{text:"Check @src/login.js , then run it",caret:20});
  assert.deepEqual(applyFileMention("(see @log) please",fileMentionAt("(see @log) please",9),"src/login.js"),{text:"(see @src/login.js ) please",caret:19});
  assert.deepEqual(applyFileMention('"see @log" now',fileMentionAt('"see @log" now',9),"src/login.js"),{text:'"see @src/login.js " now',caret:19});
  assert.deepEqual(applyFileMention("See @log... ok",fileMentionAt("See @log... ok",8),"src/login.js"),{text:"See @src/login.js ... ok",caret:18});
  // Punctuation inside the word is part of it: the dots of a path, a bracket with more of the path after it.
  assert.deepEqual(fileMentionAt("Open @src/App.jsx.",9),{start:5,end:17,query:"src"});
  assert.deepEqual(fileMentionAt("Open @app/(auth)/page.tsx now",10),{start:5,end:25,query:"app/"});
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

// Letters typed on both sides of the word while the file imports (after it, then before it with Home or a click, or the other way)
// read as one edit over it: the word, still whole between them, is found itself, and the file goes on it. It got nothing (round 9).
test("a pick put into a draft typed on before and after its word meanwhile finds the word between them",()=>{
  const at={start:6,end:10,query:"log"};
  const both=movedFileMention("Check @log",at,"Please Check @log now",7);
  assert.deepEqual(both,{start:13,end:17,query:"log"});
  assert.deepEqual(applyFileMention("Please Check @log now",both,"src/login.js",7),{text:"Please Check @src/login.js now",caret:7});
  assert.deepEqual(applyFileMention("Please Check @log now",both,"src/login.js",21),{text:"Please Check @src/login.js now",caret:30});
  const bang=movedFileMention("Check @log",at,"Now Check @log!",4);
  assert.deepEqual(bang,{start:10,end:14,query:"log"});
  assert.deepEqual(applyFileMention("Now Check @log!",bang,"src/login.js",4),{text:"Now Check @src/login.js !",caret:4});
  // Letters taken away before the word and typed after it.
  assert.deepEqual(movedFileMention("Please check @log",{start:13,end:17,query:"log"},"check @log now",14),{start:6,end:10,query:"log"});
  // The same word twice in the draft: the one picked, where what was around it is kept.
  assert.deepEqual(movedFileMention("Compare @log with @log",{start:18,end:22,query:"log"},"Please compare @log with @log now",7),{start:25,end:29,query:"log"});
  assert.deepEqual(movedFileMention("Compare @log with @log",{start:8,end:12,query:"log"},"Please compare @log with @log now",7),{start:15,end:19,query:"log"});
  // The word itself edited or gone as well: nothing to put the file on.
  assert.equal(movedFileMention("Check @log",at,"Please Check @lo now",7),null);
  assert.equal(movedFileMention("Check @log",at,"Please Check now",7),null);
  assert.equal(movedFileMention("Check @log",at,"Please Check @lonowg",20),null);
});

// Letters typed next to the word while the file imports that end with the word's own last letters (' then debug' after '@log', ' please'
// after '@service') or begin with its first ('@utils ' before '@log') are kept on their side of it: the word, whole, gets the file. Typed
// on both sides, they read as one edit reaching into the word, which was then not looked for; typed on one side with the caret moved off
// them meanwhile (Home, End, a click), they were put inside the word. Either way the file was dropped, and '@log' kept (round 9 repair).
test("a pick put into a draft typed on next to its word with letters like the word's own at its ends still finds the word",()=>{
  const at={start:6,end:10,query:"log"},service={start:6,end:14,query:"service"};
  // Both sides of the word.
  const debug=movedFileMention("Check @log",at,"Please Check @log then debug",7);
  assert.deepEqual(debug,{start:13,end:17,query:"log"});
  assert.deepEqual(applyFileMention("Please Check @log then debug",debug,"src/login.js",7),{text:"Please Check @src/login.js then debug",caret:7});
  assert.deepEqual(movedFileMention("Check @log",at,"Please Check @log, it keeps failing",7),{start:13,end:17,query:"log"});
  assert.deepEqual(movedFileMention("Check @service",service,"Hey Check @service please",4),{start:10,end:18,query:"service"});
  assert.deepEqual(movedFileMention("Check @log",at,"Check @utils @log now",21),{start:13,end:17,query:"log"});
  // One side, the caret moved off what was typed: Home, a click inside it, End after letters typed before the word, Home after
  // letters erased after it.
  assert.equal(movedFileMention("Check @log",at,"Check @log then debug",0),at);
  assert.equal(movedFileMention("Check @log",at,"Check @log then debug",15),at);
  assert.equal(movedFileMention("Check @log",at,"Check @log then debug",21),at);
  assert.equal(movedFileMention("Check @service",service,"Check @service please",0),service);
  assert.deepEqual(movedFileMention("Check @log",at,"Check @utils @log",17),{start:13,end:17,query:"log"});
  assert.deepEqual(movedFileMention("Check @log",at,"Check @utils @log",0),{start:13,end:17,query:"log"});
  assert.equal(movedFileMention("Check @log debug",at,"Check @log",0),at);
  assert.deepEqual(applyFileMention("Check @log then debug",at,"src/login.js",15),{text:"Check @src/login.js then debug",caret:24});
  // Still nothing for a word edited or gone, and a letter put at the caret inside the word is in it.
  assert.equal(movedFileMention("Check @log",at,"Check @logg",10),null);
  assert.equal(movedFileMention("Check @log",at,"Please Check @lo then debug",7),null);
  assert.equal(movedFileMention("Check @log",at,"Please Check then debug",7),null);
  assert.equal(movedFileMention("Check @log",at,"Check @lxog then debug",0),null);
  assert.equal(movedFileMention("Check @service",service,"Hey Check @servic please",4),null);
});

// The @ menu stays shut on a word that names a file picked from it, read from the word's @: the path of a file with a space in its name
// goes on past the @ word at a caret in its first part, which ends at the space, so that word never read as the file's path, and a
// click or a double click in the path's first part opened the menu offering the file again (round 10 repair).
test("a draft names a picked file from its @, a path with a space in it too, up to whitespace, the end or the punctuation after it",()=>{
  const draft="Check @docs/Release Notes.md please";
  assert.equal(namesFileAt(draft,fileMentionAt(draft,15).start,"docs/Release Notes.md"),true);
  assert.equal(namesFileAt(draft,fileMentionAt(draft,12).start,"docs/Release Notes.md"),true);
  assert.equal(namesFileAt("Check @docs/Release Notes.md",6,"docs/Release Notes.md"),true);
  assert.equal(namesFileAt("See @docs/Release Notes.md). Then",4,"docs/Release Notes.md"),true);
  // The draft has the path with its spaces one each, as the pick put it there.
  assert.equal(namesFileAt("Check @docs/Release Notes.md now",6,"docs/Release  Notes.md"),true);
  assert.equal(namesFileAt("Check @src/login.js now",6,"src/login.js"),true);
  assert.equal(namesFileAt("Check @src/login.js.",6,"src/login.js"),true);
  // Another word, a path edited or gone on past the file's, another @ word: not the file.
  assert.equal(namesFileAt("Check @docs/Release now",6,"docs/Release Notes.md"),false);
  assert.equal(namesFileAt("Check @docs/Release Notes.mdx now",6,"docs/Release Notes.md"),false);
  assert.equal(namesFileAt("Check @src/login.js.bak",6,"src/login.js"),false);
  assert.equal(namesFileAt("Check @src/login.js and @logout",24,"src/login.js"),false);
  assert.equal(namesFileAt("Check @src/login.js",6,""),false);
});

// A word that goes on past the path of a picked file, the space after it erased ('@src/login.jsnow'), names the file at a caret in the
// path or right after it, so the menu stays shut there, while a caret in the letters after it or a path edited does not; the pick on
// such a word goes on the path only, the letters after it kept after a space (round 11 repair).
test("a word that goes on past a picked file's path names the file at a caret in the path or right after it",()=>{
  const glued="Check @src/login.jsnow";
  assert.equal(namesFileAt(glued,6,"src/login.js"),false);
  assert.equal(namesFileAt(glued,fileMentionAt(glued,19).start,"src/login.js",19),true);
  assert.equal(namesFileAt(glued,fileMentionAt(glued,11).start,"src/login.js",11),true);
  assert.equal(namesFileAt("Check @src/login.js.now",6,"src/login.js",20),true);
  assert.equal(namesFileAt("Check @docs/Release Notes.mdplease",6,"docs/Release Notes.md",15),true);
  assert.equal(namesFileAt(glued,6,"src/login.js",21),false);
  assert.equal(namesFileAt("Check @src/login.j now",6,"src/login.js",18),false);
  assert.equal(namesFileAt("Check @src/login.jsx now",6,"src/login.js",20),false);
  assert.deepEqual(applyFileMention(glued,{start:6,end:19,query:"src/login.js"},"src/login.js",19),{text:"Check @src/login.js now",caret:20});
});

// The files found for a word stay until the search for the word as it is then answers, so on a word typed on glued to a picked file
// ('@src/login.jsnow') the menu offered the file found for its path, already attached: a file on the draft is not offered on a word
// that begins with its path, while an edited path or another @ word still offers it (round 11 repair, again).
const login={name:"login.js",relativePath:"src/login.js"},json={name:"login.json",relativePath:"src/login.json"},logout={name:"logout.js",relativePath:"src/logout.js"};
test("a file on the draft is not offered on a word that begins with its path, while an edited path or another @ word offers it",()=>{
  const glued="Check @src/login.jsnow",found=[login,logout];
  assert.deepEqual(offeredFileMentions([login],glued,6,["src/login.js"]),[]);
  assert.deepEqual(offeredFileMentions([login,json],"Check @src/login.json",6,["src/login.js"]),[json]);
  assert.deepEqual(offeredFileMentions([login],"Check @src/login.j now",6,["src/login.js"]),[login]);
  assert.deepEqual(offeredFileMentions(found,"Check @src/login.js and @log",24,["src/login.js"]),found);
  assert.equal(offeredFileMentions(found,glued,6,[]),found);
});

// The files found for an earlier word stay until the search for the word as it is then answers, so on a word typed on glued to a picked
// file ('@src/login.jsnow') the menu offered a file found before that the word no longer names, src/login.json found for the file's
// path or src/logout.js for '@src/l', and Enter imported it over the whole word: the menu offers of the files found only those the
// search for the word as it reads (its query) finds, by the search's own rule (round 12).
const guide={name:"login-guide.md",relativePath:"docs/login-guide.md"},dockerfile={name:"Dockerfile",relativePath:"Dockerfile"},dockerDev={name:"Dockerfile.dev",relativePath:"Dockerfile.dev"};
test("the @ menu offers of the files found for an earlier word only those the search finds for the word as it reads",()=>{
  const glued="Check @src/login.jsnow",found=[login,logout,json];
  for(const query of ["src/login.jsnow","src/login.jsno"])assert.deepEqual(offeredFileMentions(found,glued,6,["src/login.js"],query),[],query);
  assert.deepEqual(offeredFileMentions([dockerfile,dockerDev],"Check @Dockerfilenow",6,["Dockerfile"],"Dockerfilenow"),[]);
  assert.deepEqual(offeredFileMentions([login,logout,json,guide],"Check @zzz",6,[],"zzz"),[]);
  // A word that still names files found keeps them, in the order found: its letters and digits in order in the path, or, with none of
  // them, the word in it.
  assert.deepEqual(offeredFileMentions(found,"Check @src/login.jsn",6,["src/login.js"],"src/login.jsn"),[json]);
  assert.deepEqual(offeredFileMentions([login,logout,guide],"Check @logi",6,[],"logi"),[login,guide]);
  assert.deepEqual(offeredFileMentions([logout,guide,login],"Check @LGN",6,[],"LGN"),[guide,login]);
  assert.deepEqual(offeredFileMentions([login,{name:"Makefile",relativePath:"Makefile"},guide],"Check @.",6,[],"."),[login,guide]);
});

// What the menu keeps is what the workspace search (workspace.mjs) finds for the word, typed on, erased back or edited, with letters,
// digits, punctuation, a backslash or a letter of no a-z: a word with nothing typed after its @ asks for no search.
test("the @ menu keeps of the files found those the workspace search finds for the word as it reads",()=>{
  const entries=[login,logout,json,guide,dockerfile,dockerDev,{name:"README.md",relativePath:"README.md"},{name:"app.test.mjs",relativePath:"tests/unit/app.test.mjs"},{name:"Ünïcode.md",relativePath:"docs/Ünïcode.md"}].map(entry=>({...entry,path:"/repo/"+entry.relativePath,isFile:true}));
  for(const query of ["l","log","logi","src/l","src/login.js","src/login.jsn","src/login.jsno","src/login.jsnow","LGN","docs/","Dockerfile","Dockerfilen","dev",".","./","-","\\","src\\lo","md.","test/u","ü","zzz"]){
    const found=rankWorkspaceSearchItems(entries,query,{limit:500}).map(entry=>entry.relativePath).sort();
    assert.deepEqual(offeredFileMentions(entries,"Check @"+query,6,[],query).map(entry=>entry.relativePath).sort(),found,query);
  }
});

// A pick on a word that goes on past the picked file's path goes on the path only, what follows it kept, unless the whole word begins
// the path of a file found for it, a longer name ('@src/login.json', '@Dockerfile.dev', '@src/login.jso' on the way to it), which the
// pick then replaces whole: its rest stayed after the file as a word (round 11 repair, again).
test("a pick on a word that goes on past the file's path keeps what follows only when it begins no found file's name",()=>{
  const glued="Check @src/login.jsnow",found=[login,logout];
  // Glued letters stay; the rest of a longer found name goes with the word, by a caret in the path or right after it.
  assert.deepEqual(pickedFileMention(glued,fileMentionAt(glued,19),"src/login.js",found),{start:6,end:19,query:"src/login.js"});
  const longer="Check @src/login.json now";
  assert.deepEqual(pickedFileMention(longer,fileMentionAt(longer,19),"src/login.js",[login,json]),{start:6,end:21,query:"src/login.js"});
  assert.deepEqual(applyFileMention(longer,pickedFileMention(longer,fileMentionAt(longer,13),"src/login.js",[login,logout,json]),"src/login.js",21),{text:"Check @src/login.js now",caret:19});
  const docker="Check @Dockerfile.dev now",dockerfiles=[{name:"Dockerfile",relativePath:"Dockerfile"},{name:"Dockerfile.dev",relativePath:"Dockerfile.dev"}];
  assert.deepEqual(applyFileMention(docker,pickedFileMention(docker,fileMentionAt(docker,13),"Dockerfile",dockerfiles),"Dockerfile",21),{text:"Check @Dockerfile now",caret:17});
  assert.equal(pickedFileMention("Check @src/login.jso",fileMentionAt("Check @src/login.jso",19),"src/login.js",[login,json]).end,20);
  // Another file picked, or the word just the path: the whole word, as before. A path with a space picked on its first part: the path.
  assert.deepEqual(pickedFileMention(glued,fileMentionAt(glued,19),"src/logout.js",found),fileMentionAt(glued,19));
  assert.deepEqual(pickedFileMention("Check @src/login.js now",fileMentionAt("Check @src/login.js now",13),"src/login.js",found),{start:6,end:19,query:"src/lo"});
  const spaced="Check @docs/Release Notes.md please";
  assert.equal(pickedFileMention(spaced,fileMentionAt(spaced,15),"docs/Release Notes.md",[{name:"Release Notes.md",relativePath:"docs/Release Notes.md"}]).end,28);
});

test("file mention ranking prefers exact and prefix filename matches",()=>{
  const items=[
    {name:"Other.jsx",relativePath:"ui/AppHelper/Other.jsx"},
    {name:"App.test.jsx",relativePath:"ui/App.test.jsx"},
    {name:"App.jsx",relativePath:"ui/src/App.jsx"},
  ];
  assert.deepEqual(rankFileMentions(items,"App").map(item=>item.name),["App.jsx","App.test.jsx","Other.jsx"]);
});
