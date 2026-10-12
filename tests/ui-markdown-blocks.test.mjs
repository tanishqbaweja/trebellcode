import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatMarkdown,{ StreamingMarkdown } from "../ui/src/components/ChatMarkdown.jsx";
import { finishedThrough, markdownStream } from "../ui/src/markdown-blocks.js";
import { markdownReply } from "../scripts/perf/lib/fake-openai.mjs";

// StreamingMarkdown shows a streaming reply as finished blocks, each its own render, and the open tail, joined as one render of the
// whole text joins top-level blocks. For every text the stream passes through, that must be exactly what one render of the whole
// text gives, which is what the finished reply shows.
// React's server render puts a preload hint for each image at the front of its output; the page itself has no such element.
const markup=element=>renderToStaticMarkup(element).replace(/<link rel="preload" as="image"[^>]*>/g,"");
const whole=text=>markup(createElement(ChatMarkdown,{text}));
function shown(stream,text){
  let view=stream.step(text);
  const render=()=>view.whole?whole(text):[...view.blocks.map(block=>whole(block.text)),markup(createElement(ChatMarkdown,{text:text.slice(view.from),record:stream.record}))].join("\n");
  let html=render();
  // As StreamingMarkdown's layout effect does: a tail that defines a link or a footnote renders the reply whole before it is drawn.
  if(stream.wantsWhole()){view=stream.step(text);html=render()}
  return {html,blocks:view.blocks.length,whole:view.whole};
}
// Streams text in pieces of `size` characters and checks every text shown; returns the last view.
function streamEqualsWhole(text,size,label){
  const stream=markdownStream();let last=null;
  for(let end=Math.min(size,text.length);;end=Math.min(end+size,text.length)){
    const prefix=text.slice(0,end);last=shown(stream,prefix);
    assert.equal(last.html,whole(prefix),label+": the render differs at "+end+" of "+text.length+" characters, after "+JSON.stringify(prefix.slice(-60)));
    if(end>=text.length)break;
  }
  return last;
}

const EDGE_CASES={
  "fences with blank lines":"Intro paragraph.\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter the fence.\n\n~~~\nx\n\ny\n~~~\n\n````md\n```\ninner\n```\n\n````\n\nEnd.",
  "nested lists":"- one\n  - nested a\n\n  - nested b\n- two\n\n  continued paragraph in two\n\n1. first\n\n2. second\n   1. inner\n\n   inner paragraph\n\nDone.\n\n- [ ] todo\n- [x] done\n\nAfter the tasks.",
  "lists that go on after a blank line":"1. a\n\n2. b\n\n3. c\n\n- d\n\n- e\n\n* f\n\n+ g\n\n10) h\n\n11) i\n\n-\n\nlast",
  tables:"| a | b |\n| - | - |\n| 1 | 2 |\n\nText between tables.\n\n| c |\n|:---:|\n| 3 |\nrow without pipes\n\n| not | a table |\n\nEnd.",
  links:"See [the docs](https://example.com/docs \"Docs\") and <https://example.com/a> and www.example.com and mail@example.com.\n\n[relative](src/a.js) text and ![image](https://example.com/i.png).\n\n[unresolved][ref] and [^note] stay text.",
  "cut mid-fence":"Start.\n\n```python\nprint(1)\n\nprint(2)\n\n\n    indented inside",
  "indented code":"Paragraph.\n\n    code line\n\n    more code\n\n      deeper\n\nAfter the code.\n\n    tail code",
  quotes:"> quote\n> more\n\n> second quote\nlazy line\n\n>\n\n> > nested\n\ntext",
  "html blocks":"<div>\n\ntext inside\n\n</div>\n\n<!-- a comment\n\nstill the comment -->\n\n<pre>\n\nx\n\n</pre>\n\n<script>\nlet a = 1;\n\n</script>\n\nafter",
  "headings and breaks":"# H1\n\n## H2\npara right after\n\nTitle\n=====\n\nSubtitle\n---\n\n***\n\n- - -\n\n### H3 ###\n\n#hash not heading\n\nline one  \nline two\\\nline three",
  inline:"*em\nphasis* and **strong\ntext** and `code\nspan` and ~~struck~~.\n\nA line with trailing spaces   \n\n&amp; &copy; &#35; entities\n\n\\# escaped",
  "blank lines with spaces":"para one\n   \n\t\npara two\n\n \n- item\n  \n- item two\n\n    \nend",
  // A list item or a quote whose last line is a lone tag: a lazy line of its paragraph before a line ending, a block of HTML at the
  // very end of a text, so a finished block keeps its line ending.
  "a lone tag after a list item or a quote":"## Install\n\n- Install the CLI\n<br>\n\nThen sign in with the CLI.\n\n> **Note:** the relay keeps order\n<br>\n\nAfter the note.\n\n- bold <b>\n</b>\n\nDone.",
  // micromark reads the line after indented code and blank lines by what came before the code, so no cut is made next to it. The
  // last three are texts a fuzzer found.
  "lists next to indented code":"Run this first:\n\n    npm install\n\n2. Start the server.\n3. Open the page.\n\nDone.",
  "an ordered list after indented code after a list":"   \n\n> ==```</pre>\nbeta beta 1.\n\n  -      <div>\n   - alpha+alpha<pre>\n\n    -\n \n3) ",
  "an ordered list after indented code after a table":"| a | b |\n| - | - |\n| beta > x | x |\n*\n\n\t3. +\n\n4) <!--\n",
  "indented code after a list with a tab":"- \t *em*\n    - - </pre> <div> ~~~\n\n    1. [link](https://x.io) &amp; x\n    &amp;\n\nend",
};

test("a streamed reply renders exactly as the whole text at every delta: the perf corpus",()=>{
  for(const seed of [1,2,3]){
    const text=markdownReply(6000,{seed}),last=streamEqualsWhole(text,24,"corpus seed "+seed);
    // The cut does happen: most of the reply sits in finished blocks by the end.
    assert.ok(last.blocks>=15,"corpus seed "+seed+" ends with "+last.blocks+" finished blocks");
    assert.equal(last.whole,false);
  }
});

test("a streamed reply renders exactly as the whole text at every character: fences, lists, tables, links, a cut fence and more",()=>{
  for(const [label,text] of Object.entries(EDGE_CASES)){
    streamEqualsWhole(text,1,label);
    for(const size of [7,24])streamEqualsWhole(text,size,label+" in pieces of "+size);
  }
});

test("link and footnote definitions and carriage returns render the reply whole",()=>{
  for(const text of [
    "Use [the link][ref] here.\n\nMore text.\n\n[ref]: https://example.com\n\nAfter.",
    "Text with a note[^1].\n\nMore.\n\n[^1]: The note.\n\nAfter.",
    "- item\n\n  > [quoted]: https://example.com\n\nSee [quoted].\n\nend",
    "a\r\n\r\nb\r\n\r\n- c\r\n- d\r\n\r\ne",
  ]){
    const last=streamEqualsWhole(text,1,JSON.stringify(text.slice(0,24)));
    assert.equal(last.whole,true,JSON.stringify(text.slice(0,24))+" renders whole");
  }
});

test("a stream that starts again is cut afresh",()=>{
  const stream=markdownStream(),first="First reply.\n\nSecond paragraph.\n\n- a list\n";
  for(let end=1;end<=first.length;end++)shown(stream,first.slice(0,end));
  assert.ok(shown(stream,first).blocks>0);
  const again="Another reply.\n\n";
  assert.deepEqual(shown(stream,again),{html:whole(again),blocks:0,whole:false});
  assert.equal(shown(stream,"x").html,whole("x"));
});

test("a child is finished only after a blank line and the next child's complete first line",()=>{
  // The second child's first line is still arriving: "2" could become "2. b" and join the list.
  assert.equal(finishedThrough({text:"1. a\n\n2",children:[[0,4],[6,7]]}),null);
  assert.deepEqual(finishedThrough({text:"1. a\n\n2\n",children:[[0,4],[6,7]]}),{end:4,next:6});
  // No blank line between them: the paragraph could still take a setext underline.
  assert.equal(finishedThrough({text:"# a\npara\nmore",children:[[0,3],[4,13]]}),null);
  // The last finished child wins; the open one stays in the tail.
  assert.deepEqual(finishedThrough({text:"a\n\nb\n\nc",children:[[0,1],[3,4],[6,7]]}),{end:1,next:3});
  assert.deepEqual(finishedThrough({text:"a\n\nb\n\nc\n",children:[[0,1],[3,4],[6,7]]}),{end:4,next:6});
  // An indented child starts at its line, so the tail keeps its indentation.
  assert.deepEqual(finishedThrough({text:"a\n\n    code\n",children:[[0,1],[7,11]]}),{end:1,next:3});
  // No cut on either side of a child that begins or ends with indented code (the third field).
  const code={text:"a\n\n    code\n\nb\n\nc",children:[[0,1,false],[3,11,true],[13,14,false],[16,17,false]]};
  assert.equal(finishedThrough(code),null);
  assert.deepEqual(finishedThrough({...code,text:code.text+"\n"}),{end:14,next:16});
});

test("StreamingMarkdown's first render of a text is the whole render",()=>{
  for(const text of [...Object.values(EDGE_CASES),markdownReply(3000,{seed:5})])assert.equal(markup(createElement(StreamingMarkdown,{text})),whole(text));
});
