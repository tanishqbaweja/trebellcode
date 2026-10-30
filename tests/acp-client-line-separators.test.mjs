// ACP's stdio messages are JSON lines split on "\n" alone (ndjson-lines.mjs): an agent's update, request or
// answer that holds U+2028 or U+2029 inside a string, which JSON.stringify leaves raw, arrives whole. readline split the line there
// into pieces that are not JSON, so the reply lost that part, and a lost permission request left the turn waiting for good.
import test from "node:test";
import assert from "node:assert/strict";
import { inlineAcpAgent, within } from "./fixtures/inline-acp-agent.mjs";

const LS=String.fromCharCode(0x2028),PS=String.fromCharCode(0x2029);

test("an agent's update, request and answer holding U+2028 or U+2029 inside a string arrive whole, and nothing is dropped",{timeout:30000},async t=>{
  const asked=[],updates=[];
  const {client,warnings}=await inlineAcpAgent(t,`
    if(m.method==="session/prompt"){
      update(m.params.sessionId,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"one"+LS+"two"+PS+"three"}});
      send({jsonrpc:"2.0",id:"agent-1",method:"session/request_permission",params:{sessionId:m.params.sessionId,toolCall:{toolCallId:"edit-1",title:"Edit notes"+LS+"and more"},options:[{optionId:"allow",kind:"allow_once",name:"Allow"}]}});
      globalThis.prompt=m.id;
    }
    if(m.id==="agent-1")send({jsonrpc:"2.0",id:globalThis.prompt,result:{stopReason:"end_turn",_meta:{summary:"done"+LS+"here",chosen:m.result.outcome.optionId}}});
  `,{onRequest:async(method,params)=>{asked.push([method,params.toolCall.title]);return {outcome:{outcome:"selected",optionId:"allow"}}}});
  client.on("sessionUpdate",params=>updates.push(params.update));
  await client.start();
  const result=await within(client.prompt("s",[{type:"text",text:"hi"}]),8000,"the turn's answer, which waits on the permission request,");
  assert.deepEqual(updates,[{sessionUpdate:"agent_message_chunk",content:{type:"text",text:`one${LS}two${PS}three`}}]);
  assert.deepEqual(asked,[["session/request_permission",`Edit notes${LS}and more`]]);
  assert.deepEqual(result,{stopReason:"end_turn",_meta:{summary:`done${LS}here`,chosen:"allow"}});
  assert.deepEqual(warnings,[],"no piece of a message was taken for output that is not JSON");
});

test("a message in CRLF lines, or split across writes in the middle of a character, arrives whole",{timeout:30000},async t=>{
  const updates=[];
  const {client,warnings}=await inlineAcpAgent(t,`
    if(m.method==="session/prompt"){
      const id=m.params.sessionId,line=Buffer.from(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:id,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"split"+LS+"char"}}}})+String.fromCharCode(13,10),"utf8");
      const at=line.indexOf(0xe2)+1;
      process.stdout.write(line.subarray(0,at));
      setTimeout(()=>{process.stdout.write(line.subarray(at));raw(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}})+String.fromCharCode(13,10))},50);
    }
  `);
  client.on("sessionUpdate",params=>updates.push(params.update));
  await client.start();
  assert.deepEqual(await within(client.prompt("s",[{type:"text",text:"hi"}]),8000,"the turn's answer"),{stopReason:"end_turn"});
  assert.deepEqual(updates,[{sessionUpdate:"agent_message_chunk",content:{type:"text",text:`split${LS}char`}}]);
  assert.deepEqual(warnings,[]);
});
