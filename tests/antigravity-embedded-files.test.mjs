// With embedded context, Antigravity is sent a linked text file as its text, labelled by its extension's media type, when the file is
// valid UTF-8 without NUL characters, of at most 7 MB and 2,097,152 characters, and a PDF of at most 50 MB as a document link while
// the message has room for it; any other link stays as it is. An image it does not take, without a saved file, is said so in the
// text. The 7 MB and 50 MB are Google's limits for a text/plain file and a PDF on Vertex AI; 2,097,152 characters is half of the
// model's 1,048,576-token window at about 4 characters a token. Changed on purpose on 2026-11-01: a text file could be 1 MiB, and
// a PDF 50 MiB with a message's 50 MiB in all.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityPromptParts } from "../src/acp-agent-session.mjs";
import { fileUri } from "../src/file-uri.mjs";

const MB=1_000_000,EMBEDDED={embeddedContext:true};
const link=path=>({type:"resource_link",uri:fileUri(path),name:path.split(/[\\/]/).pop()});
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-embedded-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}

test("a linked file that holds text is embedded under its format's media type, plain text when its name gives none",async t=>{
  const root=await folder(t);
  const expected={"notes.MD":"text/markdown","page.html":"text/html","site.css":"text/css","rows.csv":"text/csv","data.json":"application/json",
    "lines.jsonl":"application/jsonl","feed.xml":"application/xml","config.yml":"application/yaml","app.ts":"text/plain","build.log":"text/plain"};
  for(const [name,mimeType] of Object.entries(expected)){
    const path=join(root,name);await writeFile(path,`${name}\n`);
    assert.deepEqual(await antigravityPromptParts([link(path)],EMBEDDED),[{type:"resource",resource:{uri:pathToFileURL(path).href,mimeType,text:`${name}\n`}}],name);
  }
  // What a file holds decides, not its name: text under any other name goes as plain text, and a file that holds anything else
  // (here bytes that are not UTF-8) stays a link.
  for(const name of ["Makefile","notes.rst","logo.svg","blob.bin"]){
    const path=join(root,name);await writeFile(path,`${name}\n`);
    assert.deepEqual(await antigravityPromptParts([link(path)],EMBEDDED),[{type:"resource",resource:{uri:pathToFileURL(path).href,mimeType:"text/plain",text:`${name}\n`}}],name);
  }
  const binary=join(root,"blob.dat");await writeFile(binary,Buffer.from([0x89,0x50,0x4e,0x47,0xff,0xfe]));
  assert.deepEqual(await antigravityPromptParts([link(binary)],EMBEDDED),[link(binary)],"a file that holds no text stays a link");
  // A document Trebell reads into text goes by its extracted text; one with none read stays a link, though its bytes are text.
  const rtf=join(root,"letter.rtf");await writeFile(rtf,"{\\rtf1\\ansi Dear Ada}");
  assert.deepEqual(await antigravityPromptParts([link(rtf)],EMBEDDED),[link(rtf)],"an RTF document without extracted text");
  const web={type:"resource_link",uri:"https://example.com/notes.md",name:"notes.md"};
  assert.deepEqual(await antigravityPromptParts([web],EMBEDDED),[web],"a link that names no local file stays as it is");
});

test("a text file that is not UTF-8, holds a NUL, passes 7 MB or 2,097,152 characters or is a folder stays a link, and a byte-order mark is dropped",async t=>{
  const root=await folder(t);
  const nul=join(root,"nul.txt"),latin=join(root,"latin.txt"),big=join(root,"big.txt"),long=join(root,"long.txt"),dir=join(root,"folder.md"),bom=join(root,"bom.json");
  await writeFile(nul,"a\0b");await writeFile(latin,Buffer.from([0x63,0x61,0x66,0xe9]));await writeFile(big,Buffer.alloc(7*MB+1,0x61));
  await writeFile(long,"x".repeat(2_097_153));await mkdir(dir);
  await writeFile(bom,Buffer.from([0xef,0xbb,0xbf,0x7b,0x7d]));
  for(const path of [nul,latin,big,long,dir])assert.deepEqual(await antigravityPromptParts([link(path)],EMBEDDED),[link(path)],path);
  // At the bound it goes: 2,097,152 characters, well within 7 MB.
  const most=join(root,"most.txt");await writeFile(most,"x".repeat(2_097_152));
  const [sent]=await antigravityPromptParts([link(most)],EMBEDDED);
  assert.equal(sent.type,"resource");assert.equal(sent.resource.text.length,2_097_152);
  assert.deepEqual(await antigravityPromptParts([link(bom)],EMBEDDED),[{type:"resource",resource:{uri:pathToFileURL(bom).href,mimeType:"application/json",text:"{}"}}]);
});

test("a PDF of at most 50 MB goes as a document link only while the model request has room for it",async t=>{
  const root=await folder(t),first=join(root,"first.pdf"),second=join(root,"second.pdf"),most=join(root,"most.pdf"),over=join(root,"over.pdf");
  for(const [path,size] of [[first,40*MB],[second,40*MB],[most,50*MB],[over,50*MB+1]]){await writeFile(path,"");await truncate(path,size)}
  // A PDF counts as base64 in the request's 96 MB: 40 MB is about 53.3 MB, so a second one would pass it.
  assert.deepEqual(await antigravityPromptParts([link(first),link(second)],EMBEDDED),[{...link(first),mimeType:"application/pdf"},link(second)]);
  assert.deepEqual(await antigravityPromptParts([link(most)],EMBEDDED),[{...link(most),mimeType:"application/pdf"}],"50 MB is the most one PDF may be");
  assert.deepEqual(await antigravityPromptParts([link(over)],EMBEDDED),[link(over)],"a byte more stays a plain link");
});

test("an image Antigravity does not take and that has no saved file is said so, and odd input sends nothing",async()=>{
  assert.deepEqual(await antigravityPromptParts([{type:"image",mimeType:"image/gif",data:"R0lG"}],{image:true}),
    [{type:"text",text:"[Image attachment not sent: Trebell Code has no saved copy of it]"}]);
  assert.deepEqual(await antigravityPromptParts("not a list",{image:true}),[]);
  const png={type:"image",mimeType:"image/png",data:"iVBO"};
  assert.deepEqual(await antigravityPromptParts([png],"image"),[{type:"text",text:"[Image attachment not sent: Trebell Code has no saved copy of it]"}],"capabilities that are not an object take nothing");
});
