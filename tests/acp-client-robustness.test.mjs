// What an ACP client cannot handle no longer ends the server (T3 559c4b1f2, one malformed session update no longer ends the session):
// an update a listener throws on, such as the relay's plan mapping on a null entry, or a JSON line that is not a message, such as
// null, is dropped with one warning for each kind, without the update's values, and the client reads on. The throw was an unhandled
// rejection, which Node's default turns into the end of a Trebell server.
import test from "node:test";
import assert from "node:assert/strict";
import { inlineAcpAgent, unhandledRejections, within } from "./fixtures/inline-acp-agent.mjs";
import { acpRelay, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const LS=String.fromCharCode(0x2028);

test("an update a listener throws on is dropped with one warning for its kind, the next update arrives and nothing goes unhandled",{timeout:30000},async t=>{
  const rejections=unhandledRejections(t),updates=[],notifications=[];
  const {client,warnings}=await inlineAcpAgent(t,`
    if(m.method==="session/prompt"){
      const id=m.params.sessionId;
      update(id,{sessionUpdate:"plan",entries:[null]});
      update(id,{sessionUpdate:"plan",entries:[null]});
      update(id,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"after the plans"}});
      send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
    }
  `);
  // A listener that reads every plan entry, as the relay's plan mapping does, throws on a null entry.
  client.on("sessionUpdate",params=>{const update=params.update;if(update.sessionUpdate==="plan")update.entries.map(entry=>entry.content);updates.push(update)});
  client.on("notification",message=>notifications.push(message.params.update.sessionUpdate));
  await client.start();
  assert.deepEqual(await within(client.prompt("s",[{type:"text",text:"plan it"}]),8000,"the turn's answer"),{stopReason:"end_turn"});
  assert.deepEqual(updates,[{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"after the plans"}}],"the update after the bad ones arrives");
  assert.deepEqual(notifications,["plan","plan","agent_message_chunk"],"each notification reaches its own listeners");
  assert.deepEqual(await rejections(),[]);
  assert.equal(warnings.length,1,"the same failure is told once");
  assert.equal(warnings[0].method,"session/update");
  assert.match(warnings[0].message,/^Dropped an ACP session\/update notification that Trebell could not handle: .*Cannot read properties of null/);
  assert.doesNotMatch(JSON.stringify(warnings[0]),/after the plans|entries/,"the warning carries none of the update's values");
});

test("a JSON line that is not a message, such as null, is dropped with a warning and the next message is read",{timeout:30000},async t=>{
  const rejections=unhandledRejections(t);
  const {client,warnings}=await inlineAcpAgent(t,`
    if(m.method==="session/prompt"){
      for(const line of ["null","42","[1,2]",JSON.stringify("text")])raw(line+String.fromCharCode(10));
      send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
    }
  `);
  await client.start();
  assert.deepEqual(await within(client.prompt("s",[{type:"text",text:"hi"}]),8000,"the turn's answer after the lines that are not messages"),{stopReason:"end_turn"});
  assert.deepEqual(await rejections(),[]);
  assert.deepEqual(warnings.map(warning=>[warning.message,warning.raw]),["null","42","[1,2]",JSON.stringify("text")].map(raw=>["ACP stdout contained JSON that is not a JSON-RPC message",raw]));
});

// Through the relay, as in a Trebell server: Cursor's plan update with a null entry, which the relay's plan mapping throws on, was an
// unhandled rejection that ends the server; the update is dropped, and the rest of the turn, its reply with a line separator in it
// too, reaches the thread.
test("a thread's turn goes on past an update the relay cannot map, and its reply keeps its line separator",{timeout:60000},async t=>{
  const rejections=unhandledRejections(t);
  const chunk=text=>({update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}});
  const fx=await scriptedAcp(t,{initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]},prompts:[
    {steps:[chunk(`Read the file${LS}and the notes.`),{update:{sessionUpdate:"plan",entries:[null]}},chunk(" Both are fine.")]},
  ]});
  const {rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"check the file"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const reply=threadStore.get(started.thread.id).turns.at(-1).items.find(item=>item.type==="agentMessage");
  assert.equal(reply?.text,`Read the file${LS}and the notes. Both are fine.`);
  assert.deepEqual(await rejections(),[]);
});
