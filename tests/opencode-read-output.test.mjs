import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, eventuallyReal, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// OpenCode's read tool wraps what it read in XML tags (T3 Code's cfbfbca6e shows the read without them). These are OpenCode 1.18.32's
// own outputs, recorded live for a file and a folder: the read row showed the tags around the file's lines and the folder's entries.
const FILE_READ="<path>H:\\work\\notes.txt</path>\n<type>file</type>\n<content>\n1: alpha line\n2: beta line\n\n(End of file - total 2 lines)\n</content>";
const FOLDER_READ="<path>H:\\work\\src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
// OpenCode can add text after the tags (a system reminder with the folder's instructions), and a file's numbered line can hold a tag.
const WITH_REMINDER="<path>/work/src/env.ts</path>\n<type>file</type>\n<content>1: hello\n\n(End of file - total 1 lines)\n</content>\n\n<system-reminder>\nProject instructions\n</system-reminder>";
const TAG_IN_LINE="<path>/work/src/env.ts</path>\n<type>file</type>\n<content>\n1: hello\n2: </content> literal\n3: world\n</content>";

test("a read's output is what it read: a file's lines or a folder's entries, with any text OpenCode added after them",async()=>{
  const {openCodeReadOutput}=await import("../src/opencode-agent-session.mjs");
  assert.equal(typeof openCodeReadOutput,"function");
  assert.equal(openCodeReadOutput(FILE_READ),"1: alpha line\n2: beta line\n\n(End of file - total 2 lines)");
  assert.equal(openCodeReadOutput(FOLDER_READ),"env.ts\nlib/\n\n(2 entries)");
  assert.equal(openCodeReadOutput(WITH_REMINDER),"1: hello\n\n(End of file - total 1 lines)\n\n<system-reminder>\nProject instructions\n</system-reminder>");
  // Only a closing tag on a line of its own ends the file's lines.
  assert.equal(openCodeReadOutput(TAG_IN_LINE),"1: hello\n2: </content> literal\n3: world");
  assert.equal(openCodeReadOutput(FILE_READ.replace(/\n/g,"\r\n")),"1: alpha line\r\n2: beta line\r\n\r\n(End of file - total 2 lines)");
  // Output in any other shape stays as it is: plain text, OpenCode 2.0.24's own read output, and a wrapping cut short.
  for(const output of ["---\nfile body","Read file notes.txt, lines 1-2\n1: alpha line\n2: beta line",FOLDER_READ.slice(FOLDER_READ.indexOf("<type>")),TAG_IN_LINE.slice(0,TAG_IN_LINE.lastIndexOf("\n</content>")),"",null,undefined])assert.equal(openCodeReadOutput(output),output);
});

test("an OpenCode 1.x read row carries what was read, without OpenCode's tags, and other tools keep their output",async()=>{
  const fake=await startFakeOpenCode1({onPrompt:async({part})=>{
    part({type:"tool",tool:"read",callID:"call_file",state:{status:"completed",input:{filePath:"H:\\work\\notes.txt"},output:FILE_READ,title:"notes.txt",metadata:{},time:{start:1,end:2}}});
    part({type:"tool",tool:"read",callID:"call_folder",state:{status:"completed",input:{filePath:"H:\\work\\src"},output:FOLDER_READ,title:"src",metadata:{},time:{start:1,end:2}}});
    part({type:"tool",tool:"bash",callID:"call_bash",state:{status:"completed",input:{command:"cat notes.xml"},output:FILE_READ,title:"cat notes.xml",metadata:{},time:{start:1,end:2}}});
    await new Promise(resolve=>setTimeout(resolve,100));return "Read them.";
  }});
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fake.url,onUpdate:params=>updates.push(params.update)});
  try{
    await session.start({model:FAKE_OPENCODE1_MODEL});
    await eventuallyReal(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
    await session.prompt([{type:"text",text:"Read notes.txt and src"}]);
    const outputs=await eventuallyReal(()=>{const done=updates.filter(update=>update.sessionUpdate==="tool_call_update"&&update.status==="completed");return done.length===3&&Object.fromEntries(done.map(update=>[update.toolCallId,update.rawOutput]))});
    assert.deepEqual(outputs,{call_file:"1: alpha line\n2: beta line\n\n(End of file - total 2 lines)",call_folder:"env.ts\nlib/\n\n(2 entries)",call_bash:FILE_READ});
    // A read's row names what it read (outside the thread's folder, the whole path) and opens to it as text; a command's row is its own.
    const rows=Object.fromEntries(updates.filter(update=>update.status==="completed").map(update=>[update.toolCallId,[update.title,update.textOutput===true]]));
    assert.deepEqual(rows,{call_file:["Read H:\\work\\notes.txt",true],call_folder:["Read H:\\work\\src",true],call_bash:["cat notes.xml",false]});
  }finally{await session.close();await fake.close()}
});

test("an OpenCode 2 read row carries what was read, without OpenCode's tags, and OpenCode 2.0.24's own read output is kept",async()=>{
  const fake=fakeOpenCode2Client(),updates=[];
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update)});
  await session.start({});
  try{
    const turn=session.prompt([{type:"text",text:"Read them"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    for(const [id,name,text] of [["call_1","read",WITH_REMINDER],["call_2","read","Read file notes.txt, lines 1-2\n1: alpha line\n2: beta line"],["call_3","shell",FOLDER_READ]]){
      fake.emit({type:"session.tool.input.started",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",id,name}});
      fake.emit({type:"session.tool.success",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",id,content:[{type:"text",text}],metadata:{truncated:false},executed:false}});
    }
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});await turn;
    const outputs=Object.fromEntries(updates.filter(update=>update.sessionUpdate==="tool_call_update"&&update.status==="completed").map(update=>[update.toolCallId,update.rawOutput]));
    assert.deepEqual(outputs,{call_1:"1: hello\n\n(End of file - total 1 lines)\n\n<system-reminder>\nProject instructions\n</system-reminder>",call_2:"Read file notes.txt, lines 1-2\n1: alpha line\n2: beta line",call_3:FOLDER_READ});
  }finally{await session.close()}
});

// A read in the thread's folder is titled from that folder however the model wrote the path: on Windows with forward slashes or
// backslashes, either case of the drive letter and folder names. A folder whose name only starts like the thread's is outside it, and a
// POSIX path keeps its case.
test("a read in the thread's folder is titled from the folder whichever separators and case the model wrote its path with",async()=>{
  const {openCodeToolTitle}=await import("../src/opencode-agent-session.mjs");
  const title=(filePath,cwd)=>openCodeToolTitle("read",{input:{filePath},cwd});
  assert.equal(title("H:/work/notes.txt","H:\\work"),"Read notes.txt");
  assert.equal(title("h:/Work/src/env.ts","H:\\work\\"),"Read src/env.ts");
  assert.equal(title("H:\\work\\notes.txt","H:/work"),"Read notes.txt");
  assert.equal(title("H:\\work\\src\\env.ts","H:\\work"),"Read src\\env.ts");
  assert.equal(title("H:/workbench/notes.txt","H:\\work"),"Read H:/workbench/notes.txt");
  assert.equal(title("/repo/src/a.js","/repo"),"Read src/a.js");
  assert.equal(title("/Repo/src/a.js","/repo"),"Read /Repo/src/a.js");
});
