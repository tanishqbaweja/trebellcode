import test from "node:test";
import assert from "node:assert/strict";
import { acpPlanEvent, agentToolLifecycle } from "../src/agent-relay.mjs";

// An ACP harness's plan entries and tool locations are lists of objects. One entry that is not (null, a string, a list) used to throw in
// the relay's mapping, and the ACP client then dropped the whole update with a warning (acp-client.mjs): the plan or the tool row
// went missing. Only that entry is left out now.
test("a plan or a tool update with one entry that is not an object leaves that entry out instead of the whole update",()=>{
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan",entries:[null,{content:"Write the test",status:"in_progress",priority:"high"},"stray",["nested"],{content:"Run it",status:"pending"}]}),
    {planId:null,plan:[{step:"Write the test",status:"inProgress",priority:"high"},{step:"Run it",status:"pending",priority:null}]});
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan_update",plan:{type:"items",entries:[{content:"One"},null]}}).plan,[{step:"One",status:"pending",priority:null}]);
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan",entries:{content:"not a list"}}).plan,[]);
  const edit=agentToolLifecycle({toolCallId:"edit-1",kind:"edit",status:"completed",locations:[null,{path:"src/app.mjs"},7,{uri:"file:///repo/b.mjs"}]});
  assert.deepEqual(edit.item.changes,[{path:"src/app.mjs",kind:"edit"},{path:"file:///repo/b.mjs",kind:"edit"}]);
  assert.deepEqual(agentToolLifecycle({toolCallId:"run-1",kind:"execute",status:"completed",rawOutput:"ok",locations:[null,{path:"x"}]}).item.locations,[{path:"x"}]);
  assert.deepEqual(agentToolLifecycle({toolCallId:"read-1",kind:"read",status:"completed",locations:"x"}).item.locations,[]);
  // A file change none of whose locations is left names no file: it is the call by its title, as any other tool shows.
  for(const locations of [[null],{path:"not a list"}]){
    const {item}=agentToolLifecycle({toolCallId:"delete-1",title:"Delete old-notes.txt",kind:"delete",status:"completed",locations});
    assert.deepEqual({type:item.type,namespace:item.namespace,tool:item.tool,status:item.status,locations:item.locations},{type:"dynamicToolCall",namespace:"agent",tool:"Delete old-notes.txt",status:"completed",locations:[]});
  }
  // Well-formed updates map as before, a file change that names no file yet among them (pending, as ACP says it has not started).
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan",entries:[{content:"A",status:"completed"}]}).plan,[{step:"A",status:"completed",priority:null}]);
  assert.deepEqual(agentToolLifecycle({toolCallId:"edit-2",kind:"edit",status:"completed",locations:[{path:"a.txt"}]}).item.changes,[{path:"a.txt",kind:"edit"}]);
  for(const locations of [undefined,[]])assert.deepEqual(agentToolLifecycle({toolCallId:"edit-3",title:"Edit",kind:"edit",status:"pending",locations}).item,{type:"fileChange",id:"edit-3",status:"pending",changes:[],rawInput:undefined,rawOutput:undefined});
});
