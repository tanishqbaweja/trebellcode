import test from "node:test";
import assert from "node:assert/strict";
import { applyReplaceTextHunks, compactReplaceDiff, replaceTextHunks } from "../src/native-replace-text.mjs";

const GREETER=[
  "import os",
  "",
  "",
  "class Greeter:",
  "    def __init__(self, name):",
  "        self.name = name",
  "",
  "    def greet(self):",
  "        prefix = 'Hello'",
  "        suffix = '!'",
  "        parts = []",
  "        parts.append(prefix)",
  "        if self.name:",
  "            parts.append(self.name)",
  "        return ' '.join(parts) + suffix",
  "",
  "",
  "def helper(value):",
  "    return value * 2",
  "",
  "",
  "def main():",
  "    greeter = Greeter('x')",
  "    print(greeter.greet())",
  "    print(helper(2))",
  "",
].join("\n");

const fails=(content,args)=>{
  try{applyReplaceTextHunks(content,replaceTextHunks(args),{path:"greet.py"})}catch(error){return error.message}
  assert.fail("the replacement should not apply");
};

test("an edits list applies every hunk in order to one file and the diff shows each hunk with its context and enclosing def",()=>{
  const applied=applyReplaceTextHunks(GREETER,replaceTextHunks({edits:[
    {old_text:"            parts.append(self.name)",new_text:"            parts.append(self.name.title())"},
    {old_text:"    print(helper(2))\n",new_text:"    print(helper(3))\n    print('done')\n"},
  ]}),{path:"greet.py"});
  assert.equal(applied.replacements,2);
  assert.match(applied.content,/parts\.append\(self\.name\.title\(\)\)/);assert.match(applied.content,/print\(helper\(3\)\)\n    print\('done'\)\n$/);
  assert.equal(compactReplaceDiff(GREETER,applied.content),[
    "@@ -11,7 +11,7 @@ def greet(self):",
    "         parts = []",
    "         parts.append(prefix)",
    "         if self.name:",
    "-            parts.append(self.name)",
    "+            parts.append(self.name.title())",
    "         return ' '.join(parts) + suffix",
    " ",
    " ",
    "@@ -22,4 +22,5 @@",
    " def main():",
    "     greeter = Greeter('x')",
    "     print(greeter.greet())",
    "-    print(helper(2))",
    "+    print(helper(3))",
    "+    print('done')",
  ].join("\n"),"the def/class header is named only when it is above the shown context");
});

test("each hunk applies to the text the earlier hunks produced, and an expected count covers every match of that hunk",()=>{
  const applied=applyReplaceTextHunks("a = 1\nb = 1\n",replaceTextHunks({edits:[
    {old_text:"= 1",new_text:"= 2",expected_replacements:2},
    {old_text:"b = 2",new_text:"b = 3"},
  ]}),{path:"values.py"});
  assert.deepEqual(applied,{content:"a = 2\nb = 3\n",replacements:3});
});

test("the single old_text/new_text form is unchanged, and the two forms cannot be mixed",()=>{
  assert.deepEqual(replaceTextHunks({path:"x",old_text:"a",new_text:"b",expected_replacements:2}),[{label:null,oldText:"a",newText:"b",expected:2}]);
  assert.throws(()=>replaceTextHunks({path:"x",old_text:"",new_text:"b"}),/old_text must not be empty/);
  assert.throws(()=>replaceTextHunks({path:"x",old_text:"a",new_text:"b",edits:[{old_text:"a",new_text:"b"}]}),/either old_text\/new_text or edits/);
  assert.throws(()=>replaceTextHunks({path:"x",expected_replacements:2,edits:[{old_text:"a",new_text:"b"}]}),/expected_replacements inside each edit/);
  assert.throws(()=>replaceTextHunks({path:"x",edits:[]}),/non-empty list/);
  assert.throws(()=>replaceTextHunks({path:"x",edits:[{old_text:"a",new_text:"b"},{old_text:"",new_text:"c"}]}),/edits\[1\]\.old_text must not be empty/);
  assert.throws(()=>replaceTextHunks({path:"x",edits:Array.from({length:51},()=>({old_text:"a",new_text:"b"}))}),/at most 50/);
});

test("an old_text that matches only when whitespace is ignored is answered with the exact current text and its line numbers",()=>{
  const message=fails(GREETER,{old_text:"def greet(self):\n    prefix = 'Hello'",new_text:"x"});
  assert.equal(message,[
    "Expected 1 exact replacement in greet.py, found 0. No changes were written.",
    "old_text matches lines 8-9 when whitespace is ignored. The exact current text there:",
    "8|     def greet(self):",
    "9|         prefix = 'Hello'",
  ].join("\n"));
});

test("an old_text with no exact or whitespace-only match gets the closest region with line numbers, or says there is none",()=>{
  assert.equal(fails(GREETER,{old_text:"    def greet(self):\n        prefix = 'Hello'\n        suffix = '?'\n        parts = []",new_text:"x"}),[
    "Expected 1 exact replacement in greet.py, found 0. No changes were written.",
    "Closest region, lines 8-11 (3 of 4 old_text lines match it when whitespace is ignored):",
    "8|     def greet(self):",
    "9|         prefix = 'Hello'",
    "10|         suffix = '!'",
    "11|         parts = []",
  ].join("\n"));
  assert.equal(fails(GREETER,{old_text:"return value * 3",new_text:"x"}),[
    "Expected 1 exact replacement in greet.py, found 0. No changes were written.",
    "Closest region, line 19 (2 of 2 names in old_text appear there):",
    "19|     return value * 2",
  ].join("\n"));
  assert.equal(fails(GREETER,{old_text:"zzz qqq",new_text:"x"}),"Expected 1 exact replacement in greet.py, found 0. No changes were written.\nNo similar region was found in the file.");
});

test("an old_text with several matches lists each match's line with one line of context",()=>{
  assert.equal(fails(GREETER,{old_text:"parts.append(",new_text:"x"}),[
    "Expected 1 exact replacement in greet.py, found 2. No changes were written.",
    "Matches (add nearby text to old_text so it matches once, or set expected_replacements to 2):",
    "  line 12, after line 11: parts = []",
    "  line 14, after line 13: if self.name:",
  ].join("\n"));
  assert.equal(fails("x = f(a)\ny = f(a)\n",{old_text:"f(a)",new_text:"g(a)",expected_replacements:3}),[
    "Expected 3 exact replacements in greet.py, found 2. No changes were written.",
    "Matches (set expected_replacements to 2, or correct old_text):",
    "  line 1: x = f(a)",
    "  line 2: y = f(a)",
  ].join("\n"));
  const many=Array.from({length:15},(_,index)=>`value_${index} = 0`).join("\n")+"\n",message=fails(many,{old_text:" = 0",new_text:" = 1"});
  assert.match(message,/found 15\./);assert.match(message,/line 12: value_11 = 0\n {2}\+3 more at lines 13, 14, 15$/,"matches past the listed ones keep their line numbers");
});

test("a later hunk that fails names itself, writes nothing, and gives line numbers as they are on disk where it can",()=>{
  const message=fails(GREETER,{edits:[{old_text:"import os\n",new_text:"import os\nimport sys\n"},{old_text:"def helper(value):\n  return value * 2",new_text:"x"}]});
  assert.equal(message,[
    "edits[1]: Expected 1 exact replacement in greet.py, found 0. No changes were written (edits are all or nothing).",
    "old_text matches lines 18-19 when whitespace is ignored. The exact current text there:",
    "18| def helper(value):",
    "19|     return value * 2",
  ].join("\n"));
  const between=fails("a\nbravo\ncharlie\nd\n",{edits:[{old_text:"a\n",new_text:"a\nA\n"},{old_text:"d\n",new_text:"d\nD\n"},{old_text:"bravo\ncharlie\nzulu",new_text:"x"}]});
  assert.match(between,/^edits\[2\]: Expected 1 exact replacement in greet\.py, found 0\./);
  assert.match(between,/\n\(Line numbers count the edits before edits\[2\] as applied\.\)$/,"a region between earlier hunks keeps the as-applied numbering and says so");
});

test("the diff shows a two-line change inside one hunk as two changes, not a block rewrite",()=>{
  const before="start\none\ntwo\nthree\nfour\nfive\nend\n",after="start\nONE\ntwo\nthree\nfour\nFIVE\nend\n";
  assert.equal(compactReplaceDiff(before,after),["@@ -1,7 +1,7 @@"," start","-one","+ONE"," two"," three"," four","-five","+FIVE"," end"].join("\n"));
});

test("the diff stays compact: long added runs are shortened, a missing final newline is marked, and an unchanged file says so",()=>{
  const added=Array.from({length:30},(_,index)=>`    line_${index} = ${index}`).join("\n")+"\n";
  const diff=compactReplaceDiff("def build():\n    pass\n","def build():\n"+added+"    pass\n").split("\n");
  assert.equal(diff[0],"@@ -1,2 +1,32 @@");
  assert.deepEqual(diff.slice(1,3),[" def build():","+    line_0 = 0"]);
  assert.ok(diff.includes("[Trebell: 17 more added lines]"));assert.ok(diff.includes("+    line_29 = 29"));assert.ok(!diff.includes("+    line_15 = 15"));
  assert.equal(compactReplaceDiff("a\nb","a\nc"),["@@ -1,2 +1,2 @@"," a","-b","\\ No newline at end of file","+c","\\ No newline at end of file"].join("\n"));
  assert.equal(compactReplaceDiff("same\n","same\n"),"No lines changed.");
});

test("a very large diff is cut with a note instead of flooding the result",()=>{
  const before=Array.from({length:400},(_,index)=>`row ${index}`).join("\n")+"\n",after=before.replace(/row (\d+)\n/g,(line,index)=>Number(index)%2?`row ${index} changed\n`:line);
  const diff=compactReplaceDiff(before,after),lines=diff.split("\n");
  assert.ok(lines.length<=201);assert.ok(diff.length<=12_400);assert.match(lines.at(-1),/^\[Trebell: diff truncated; \d+ more diff lines\. Read the file for the rest\.\]$/);
});

test("the enclosing header is found across languages by climbing to smaller indentation",()=>{
  const js=["export class Store {","  constructor() {","    this.items = [];","  }","","  add(item) {","    if (!item) {","      return;","    }","    this.items.push(item);","    this.count = this.items.length;","  }","}",""].join("\n");
  assert.match(compactReplaceDiff(js,js.replace("this.count = this.items.length;","this.count += 1;")),/^@@ -8,6 \+8,6 @@ add\(item\) \{$/m);
  const control=["function run() {","  const a = 1;","  const b = 2;","  const c = 3;","  if (a) {","    work(a);","    more(b);","    done(c);","  }","}",""].join("\n");
  assert.match(compactReplaceDiff(control,control.replace("done(c);","done(a);")),/^@@ -5,6 \+5,6 @@ function run\(\) \{$/m,"control blocks are climbed through");
  const top="A = 1\nB = 2\nC = 3\nD = 4\nE = 5\n";
  assert.match(compactReplaceDiff(top,top.replace("E = 5","E = 6")),/^@@ -2,4 \+2,4 @@$/m,"a top-level change names no header");
});
