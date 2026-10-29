import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// OpenCode 2 sends session.tool.input.started as the model starts a call, session.tool.called once the call's input is whole and its tool
// runs, then session.tool.success or session.tool.failed, and names a call only by its tool. Its rows read running from the first event,
// as a tool that runs, carried OpenCode's raw tool names ("bash", "read", "question") where OpenCode 1.x's rows read "Run command",
// "Read file" and OpenCode's own titles, and lost the call's input at its end (a read's arguments {}, a command's line gone).
const shown=updates=>id=>updates.filter(update=>update.toolCallId===id).map(({sessionUpdate,title,kind,status,rawInput,rawOutput,textOutput})=>({sessionUpdate,title,kind,status,rawInput,...(rawOutput===undefined?{}:{rawOutput}),...(textOutput?{textOutput}:{})}));

test("an OpenCode 2 call reads pending while its input streams and running once called, titled from its input as OpenCode 1.x titles it, which its last update keeps",async()=>{
  const fake=fakeOpenCode2Client(),updates=[];
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update)});
  await session.start({});
  try{
    const turn=session.prompt([{type:"text",text:"Run the tests and read the notes"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    const tool=(type,id,data)=>fake.emit({type:`session.tool.${type}`,data:{sessionID:"ses_main",assistantMessageID:"msg_a1",id,...data}});
    const QUESTIONS=[{question:"Which color should the theme use?",header:"Color",options:[{label:"Amber",description:"Warm accents"}]}];
    tool("input.started","call_bash",{name:"bash"});tool("called","call_bash",{input:{command:"npm test"},executed:false});
    tool("success","call_bash",{content:[{type:"text",text:"12 passing"}],executed:true});
    tool("input.started","call_lint",{name:"shell"});tool("called","call_lint",{input:{command:"npm run lint",description:"Lints the sources"},executed:false});
    tool("failed","call_lint",{error:{type:"unknown",message:"exit 1"},executed:true});
    tool("input.started","call_read",{name:"read"});tool("called","call_read",{input:{filePath:"/repo/src/notes.txt"},executed:false});
    tool("success","call_read",{content:[{type:"text",text:"Read file src/notes.txt, lines 1-1\n1: alpha line"}],executed:true});
    tool("input.started","call_outside",{name:"read"});tool("called","call_outside",{input:{filePath:"/etc/hosts"},executed:false});
    tool("success","call_outside",{content:[{type:"text",text:"1: 127.0.0.1 localhost"}],executed:true});
    tool("input.started","call_question",{name:"question"});tool("called","call_question",{input:{questions:QUESTIONS},executed:false});
    tool("success","call_question",{content:[{type:"text",text:"User has answered your questions: \"Which color should the theme use?\"=\"Amber\". You can now continue with the user's answers in mind."}],metadata:{answers:[["Amber"]]},executed:true});
    // An MCP server's tool whose arguments hold a description of their own, and OpenCode's task tool, which OpenCode titles by its description.
    tool("input.started","call_mcp",{name:"linear_create_issue"});tool("called","call_mcp",{input:{title:"Safari login",description:"Login fails on Safari"},executed:false});
    tool("success","call_mcp",{content:[{type:"text",text:"Created LIN-42"}],executed:true});
    tool("input.started","call_task",{name:"task"});tool("called","call_task",{input:{description:"Explore the parser",prompt:"Find where the parser reads numbers.",subagent_type:"explore"},executed:false});
    tool("success","call_task",{content:[{type:"text",text:"The parser reads numbers in lexer.js."}],executed:true});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});await turn;
    const rows=shown(updates);
    assert.deepEqual(rows("call_bash"),[
      {sessionUpdate:"tool_call",title:"Run command",kind:"execute",status:"pending",rawInput:{}},
      {sessionUpdate:"tool_call_update",title:"Run command",kind:"execute",status:"in_progress",rawInput:{command:"npm test"}},
      {sessionUpdate:"tool_call_update",title:"Run command",kind:"execute",status:"completed",rawInput:{command:"npm test"},rawOutput:"12 passing"},
    ]);
    // A command its input describes is titled by the description, as OpenCode 1.x titles it.
    assert.deepEqual(rows("call_lint").map(row=>[row.title,row.status,row.rawInput.command??null,row.rawOutput??null]),[["Run command","pending",null,null],["Lints the sources","in_progress","npm run lint",null],["Lints the sources","failed","npm run lint","exit 1"]]);
    assert.deepEqual(rows("call_read"),[
      {sessionUpdate:"tool_call",title:"Read file",kind:"read",status:"pending",rawInput:{},textOutput:true},
      {sessionUpdate:"tool_call_update",title:"Read src/notes.txt",kind:"read",status:"in_progress",rawInput:{filePath:"/repo/src/notes.txt"},textOutput:true},
      {sessionUpdate:"tool_call_update",title:"Read src/notes.txt",kind:"read",status:"completed",rawInput:{filePath:"/repo/src/notes.txt"},rawOutput:"Read file src/notes.txt, lines 1-1\n1: alpha line",textOutput:true},
    ]);
    assert.equal(rows("call_outside").at(-1).title,"Read /etc/hosts","a read outside the thread's folder names the whole path");
    assert.deepEqual(rows("call_question").map(row=>[row.title,row.status,row.rawOutput??null]),[
      ["Ask a question","pending",null],
      ["Asked 1 question","in_progress","Which color should the theme use?"],
      ["Asked 1 question","completed","Which color should the theme use?\nAnswer: Amber"],
    ]);
    // A tool OpenCode does not title by its description keeps its name, whatever its arguments say, as OpenCode 1.x shows an MCP tool.
    assert.deepEqual(rows("call_mcp").map(row=>row.title),["linear_create_issue","linear_create_issue","linear_create_issue"]);
    assert.deepEqual(rows("call_task").map(row=>row.title),["task","Explore the parser","Explore the parser"],"a task is titled by its description, as OpenCode 1.x titles it");
  }finally{await session.close()}
});
