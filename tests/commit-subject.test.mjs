import test from "node:test";
import assert from "node:assert/strict";
import { commitSubjectIn } from "../src/commit-subject.mjs";

// The commit subject Trebell takes from a model's answer to its commit-message prompt (/api/git/commit-message): the first line with
// words once Markdown fence markers are out, without the quote marks and backticks around it.
test("the commit subject is the answer's first line with words, without fences or the quotes around it",()=>{
  for(const [answer,subject] of [
    ["feat: add the parser","feat: add the parser"],
    ["\n\"feat: harness subject\"\n","feat: harness subject"],
    ["```\nfix: close the socket\n```","fix: close the socket"],
    ["```text\r\n  'chore: bump the lockfile'  \r\n```","chore: bump the lockfile"],
    ["```commit-msg feat: inline fence```","feat: inline fence"],
    ["`refactor: split the loader`\nBody line","refactor: split the loader"],
    ["\"\"`docs: quoted twice`\"\"","docs: quoted twice"],
    ["\"  spaced inside  \"","spaced inside"],
    ["a \"quoted\" word stays","a \"quoted\" word stays"],
    ["it's fine","it's fine"],
    ["``````\n\nperf: after two fences","perf: after two fences"],
    ["````","" ],
    ["\"\"\"",""],
    [" \t\n \r\n",""],
    ["",""],
    [null,""],
    [undefined,""],
  ])assert.equal(commitSubjectIn(answer),subject,JSON.stringify(answer));
});

// A word written right after a fence is its language word, so it goes with the fence; what comes after a space stays.
test("a fence's language word is taken out with it, and text after it past a space stays",()=>{
  assert.equal(commitSubjectIn("```js-1_x fix: tail"),"fix: tail");
  assert.equal(commitSubjectIn("before```after"),"before");
  assert.equal(commitSubjectIn("x```y```z"),"x");
  assert.equal(commitSubjectIn("x``` y"),"x y");
});
