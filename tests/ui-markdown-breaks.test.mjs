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

test("raw HTML in a thought keeps its lines, and an HTML block is a paragraph of them",()=>{
  // Raw HTML stays text (no rehype-raw). Left alone, a block of it is a bare text node between blocks, run onto one line.
  assert.equal(thought("<plan>\nstep 1\nstep 2\n</plan>\n\nAfter the plan\nnext line"),"<p>&lt;plan&gt;<br/>\nstep 1<br/>\nstep 2<br/>\n&lt;/plan&gt;</p>\n<p>After the plan<br/>\nnext line</p>");
  assert.equal(thought("<plan>\r\nstep 1\r\n</plan>"),"<p>&lt;plan&gt;<br/>\nstep 1<br/>\n&lt;/plan&gt;</p>");
  assert.equal(thought("> <div>\n> raw\n> </div>"),"<blockquote>\n<p>&lt;div&gt;<br/>\nraw<br/>\n&lt;/div&gt;</p>\n</blockquote>");
  assert.equal(thought("<!--\nnote one\n\nnote two\n-->"),"<p>&lt;!--<br/>\nnote one<br/>\n<br/>\nnote two<br/>\n--&gt;</p>");
  assert.equal(thought("Para one\n\n<!-- note -->\n\nPara two"),"<p>Para one</p>\n<p>&lt;!-- note --&gt;</p>\n<p>Para two</p>");
  assert.equal(thought("Use <span\nclass=\"x\">this</span> here"),"<p>Use &lt;span<br/>\nclass=&quot;x&quot;&gt;this&lt;/span&gt; here</p>");
  assert.equal(thought("a <b>bold</b> word"),reply("a <b>bold</b> word"));
});

test("in a list item written without blank lines, an HTML block stays on the lines next to its paragraph",()=>{
  // A tight list shows an item's paragraphs as bare text joined by a space, so these keep one paragraph with breaks.
  assert.equal(thought("- item\n  <div>\n  raw\n  </div>\n- next"),"<ul>\n<li>item<br/>\n&lt;div&gt;<br/>\nraw<br/>\n&lt;/div&gt;</li>\n<li>next</li>\n</ul>");
  assert.equal(thought("- <!-- a -->\n  then this\n- next"),"<ul>\n<li>&lt;!-- a --&gt;<br/>\nthen this</li>\n<li>next</li>\n</ul>");
  assert.equal(thought("- <!-- a -->\n  <!-- b -->"),"<ul>\n<li>&lt;!-- a --&gt;<br/>\n&lt;!-- b --&gt;</li>\n</ul>");
  assert.equal(thought("- <div>\n  raw\n  </div>\n- next"),"<ul>\n<li>&lt;div&gt;<br/>\nraw<br/>\n&lt;/div&gt;</li>\n<li>next</li>\n</ul>");
  assert.equal(thought("- <thinking>\n- <answer>"),"<ul>\n<li>&lt;thinking&gt;</li>\n<li>&lt;answer&gt;</li>\n</ul>");
  assert.equal(thought("- item\n  <div>\n  raw\n  </div>\n\n- next"),"<ul>\n<li>\n<p>item<br/>\n&lt;div&gt;<br/>\nraw<br/>\n&lt;/div&gt;</p>\n</li>\n<li>\n<p>next</p>\n</li>\n</ul>");
  // A blank line between the blocks keeps them two paragraphs.
  assert.equal(thought("- item\n\n  <div>\n  raw\n  </div>"),"<ul>\n<li>\n<p>item</p>\n<p>&lt;div&gt;<br/>\nraw<br/>\n&lt;/div&gt;</p>\n</li>\n</ul>");
});

test("a reply keeps Markdown's soft break as a newline in its text",()=>{
  assert.equal(reply("First line\nsame paragraph"),"<p>First line\nsame paragraph</p>");
  assert.equal(reply("<plan>\nstep\n</plan>"),"&lt;plan&gt;\nstep\n&lt;/plan&gt;");
});

test("text and raw HTML are split, an HTML block becomes a paragraph, and code, inline code and childless nodes are left alone",()=>{
  const tree={type:"root",children:[
    {type:"paragraph",children:[{type:"text",value:"a\nb\n"},{type:"inlineCode",value:"c\nd"},{type:"html",value:"<i\nx>"},{type:"text",value:"plain"}]},
    {type:"code",value:"e\nf"},{type:"thematicBreak"},{type:"html",value:"<g>\nh"},{type:"html",value:""},
  ]};
  assert.deepEqual(softBreaksToHardBreaks(tree),{type:"root",children:[
    {type:"paragraph",children:[{type:"text",value:"a"},{type:"break"},{type:"text",value:"b"},{type:"break"},{type:"inlineCode",value:"c\nd"},{type:"text",value:"<i"},{type:"break"},{type:"text",value:"x>"},{type:"text",value:"plain"}]},
    {type:"code",value:"e\nf"},{type:"thematicBreak"},{type:"paragraph",children:[{type:"text",value:"<g>"},{type:"break"},{type:"text",value:"h"}]},
  ]});
  // Only an item written without blank lines (spread false) joins its paragraphs.
  const item=spread=>({type:"listItem",spread,children:[{type:"paragraph",children:[{type:"text",value:"item"}]},{type:"html",value:"<div>"}]});
  assert.deepEqual(softBreaksToHardBreaks(item(false)).children,[{type:"paragraph",children:[{type:"text",value:"item"},{type:"break"},{type:"text",value:"<div>"}]}]);
  assert.equal(softBreaksToHardBreaks(item(true)).children.length,2);
  assert.equal(softBreaksToHardBreaks(null),null);
  assert.deepEqual(softBreaksToHardBreaks({type:"text",value:"x\ny"}),{type:"text",value:"x\ny"});
});
