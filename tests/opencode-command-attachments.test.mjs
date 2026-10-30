// A message that names one of OpenCode 1.x's commands runs that command with the person's text after it as its arguments and their
// attachments as its parts. An attachment OpenCode gets as no part, but as a line naming it (a document Trebell has no text
// of, audio, video), and the line that names a document's extracted text, go after the arguments, with every attachment's line
// in the text the command is read from: no attachment drops out of a command unsaid.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileUri } from "../src/file-uri.mjs";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { withPromptTextPath } from "../src/prompt-attachments.mjs";
import { FAKE_OPENCODE1_MODEL, eventuallyReal, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";

const link=path=>({type:"resource_link",uri:fileUri(path),name:path.split(/[\\/]/).pop()});

test("an OpenCode 1.x command names after its arguments the attachments it gets no part for, a document without text among them, and the file a document's text went to",async t=>{
  const fake=await startFakeOpenCode1({routes:{
    "GET /command":({json})=>json(200,[{name:"summarize",template:"Summarize $ARGUMENTS"}]),
    "POST /session/ses_main/command":({body,json})=>json(200,{info:{id:"msg_a1",parentID:body?.messageID,role:"assistant",tokens:{input:3,output:1}},parts:[{id:"prt_1",type:"text",text:"Summarized."}]}),
  }});
  t.after(()=>fake.close());
  const folder=join(tmpdir(),"trebell-opencode-command"),attachments=join(folder,"attachments");
  const broken=join(attachments,"1761500000000-ab12cd34-broken.docx"),report=join(attachments,"1761500000000-cd34ef56-report.docx"),memo=join(attachments,"1761500000000-ef56ab12-memo.mp3"),notes=join(folder,"notes.md");
  const session=new OpenCodeAgentSession({cwd:folder,serverUrl:fake.url,onUpdate:()=>{}});t.after(()=>session.close());
  await session.start({model:FAKE_OPENCODE1_MODEL});
  await eventuallyReal(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
  const result=await session.prompt([{type:"text",text:"/summarize the attached files"},link(broken),withPromptTextPath(link(report),report+".txt"),link(memo),link(notes)]);
  assert.equal(result.stopReason,"end_turn");
  const [sent]=fake.called("POST /session/ses_main/command").map(call=>call.body);
  assert.equal(fake.prompts().length,0,"it runs as the command, not as a message");
  assert.equal(sent.command,"summarize");
  assert.equal(sent.arguments,[
    "the attached files",
    `[Attached file "${link(broken).name}" is saved at: ${broken}]`,
    `[Attached file "${link(report).name}" is saved at: ${report} (text extracted to: ${report}.txt)]`,
    `[Attached audio "${link(memo).name}" is saved at: ${memo}]`,
  ].join("\n\n"));
  assert.deepEqual(sent.parts,[
    {type:"file",mime:"text/plain",filename:link(report).name+".txt",url:fileUri(report+".txt")},
    {type:"file",mime:"text/markdown",filename:"notes.md",url:fileUri(notes)},
  ],"the document's text and the Markdown file go as its parts, as before");
  // A command with no arguments of its own has the lines alone; one with no such attachment has its arguments alone.
  await session.prompt([{type:"text",text:"/summarize"},link(broken)]);
  await session.prompt([{type:"text",text:"/summarize the notes"},link(notes)]);
  assert.deepEqual(fake.called("POST /session/ses_main/command").slice(1).map(call=>call.body.arguments),[`[Attached file "${link(broken).name}" is saved at: ${broken}]`,"the notes"]);
});
