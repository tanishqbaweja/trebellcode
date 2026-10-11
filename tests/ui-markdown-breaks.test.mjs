import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSoftBreaks, softBreaksToHardBreaks } from "../ui/src/markdown-breaks.js";

// The HTML ChatMarkdown renders: GitHub-flavored Markdown, with the soft-break step for a thought and without it for a reply.
const thought=markdown=>renderToStaticMarkup(createElement(ReactMarkdown,{remarkPlugins:[remarkGfm,remarkSoftBreaks]},markdown));
const reply=markdown=>renderToStaticMarkup(createElement(ReactMarkdown,{remarkPlugins:[remarkGfm]},markdown));

test("a single newline in a thought becomes one line break, in any phrasing and any line ending",()=>{
  assert.equal(thought("First thought\nSecond thought"),"<p>First thought<br/>\nSecond thought</p>");
  assert.equal(thought("one\r\ntwo\rthree"),"<p>one<br/>\ntwo<br/>\nthree</p>");
  assert.equal(thought("*one\ntwo* and **three\nfour**"),"<p><em>one<br/>\ntwo</em> and <strong>three<br/>\nfour</strong></p>");
  assert.equal(thought("- item line one\n  item line two"),"<ul>\n<li>item line one<br/>\nitem line two</li>\n</ul>");
  assert.equal(thought("> quoted one\n> quoted two"),"<blockquote>\n<p>quoted one<br/>\nquoted two</p>\n</blockquote>");
});

test("a hard break stays one break",()=>{
  assert.equal(thought("one\\\ntwo"),"<p>one<br/>\ntwo</p>");
  assert.equal(thought("one  \ntwo"),"<p>one<br/>\ntwo</p>");
});

test("lists, code and single-line text gain no breaks",()=>{
  for(const markdown of [
    "- First loose item\n\n- Second loose item",
    "- Parent item\n  - Child item\n- Sibling item",
    "1. First\n2. Second",
    "```js\nconst a=1;\nconst b=2;\n```",
    "`inline\ncode` stays code",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "One paragraph.\n\nAnother paragraph.",
  ])assert.equal(thought(markdown),reply(markdown),markdown);
  assert.doesNotMatch(thought("```\na\nb\n```"),/<br/);
});

test("a reply keeps Markdown's soft break as a newline in its text",()=>{
  assert.equal(reply("First line\nsame paragraph"),"<p>First line\nsame paragraph</p>");
});

test("only text nodes are split; code, inline code and nodes without children are left alone",()=>{
  const tree={type:"root",children:[
    {type:"paragraph",children:[{type:"text",value:"a\nb\n"},{type:"inlineCode",value:"c\nd"},{type:"text",value:"plain"}]},
    {type:"code",value:"e\nf"},{type:"thematicBreak"},
  ]};
  assert.deepEqual(softBreaksToHardBreaks(tree),{type:"root",children:[
    {type:"paragraph",children:[{type:"text",value:"a"},{type:"break"},{type:"text",value:"b"},{type:"break"},{type:"inlineCode",value:"c\nd"},{type:"text",value:"plain"}]},
    {type:"code",value:"e\nf"},{type:"thematicBreak"},
  ]});
  assert.equal(softBreaksToHardBreaks(null),null);
  assert.deepEqual(softBreaksToHardBreaks({type:"text",value:"x\ny"}),{type:"text",value:"x\ny"});
});
