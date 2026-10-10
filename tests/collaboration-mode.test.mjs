import test from "node:test";
import assert from "node:assert/strict";
import {collaborationModePayload,normalizeCollaborationModes} from "../ui/src/collaboration-mode.js";

test("native Codex collaboration modes normalize and deduplicate by mode",()=>{
  assert.deepEqual(normalizeCollaborationModes([
    {name:"Plan",mode:"plan",reasoning_effort:"medium"},
    {name:"Plan duplicate",mode:"plan"},
    {name:"Default",mode:"default",reasoning_effort:null},
    {name:"Missing mode"},
  ]),[
    {name:"Plan",mode:"plan",reasoning_effort:"medium"},
    {name:"Default",mode:"default",reasoning_effort:null},
  ]);
});

test("collaboration mode payload uses the selected model and built-in instructions",()=>{
  const modes=normalizeCollaborationModes([
    {name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},
    {name:"Default",mode:"default",model:null,reasoning_effort:null},
  ]);
  assert.deepEqual(collaborationModePayload(modes,"plan","test/coding-fast"),{
    mode:"plan",
    settings:{model:"test/coding-fast",reasoning_effort:"medium",developer_instructions:null},
  });
  assert.deepEqual(collaborationModePayload(modes,"default","test/coding-large"),{
    mode:"default",
    settings:{model:"test/coding-large",reasoning_effort:null,developer_instructions:null},
  });
  assert.equal(collaborationModePayload(modes,"missing","test/coding-fast"),null);
});

test("the chosen reasoning effort rides in the collaboration mode, since Codex gives the mode precedence over effort",()=>{
  const modes=normalizeCollaborationModes([
    {name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},
    {name:"Default",mode:"default",model:null,reasoning_effort:null},
  ]);
  assert.deepEqual(collaborationModePayload(modes,"default","gpt-6-luna",{effort:"high"}),{
    mode:"default",settings:{model:"gpt-6-luna",reasoning_effort:"high",developer_instructions:null},
  });
  assert.equal(collaborationModePayload(modes,"plan","gpt-6-luna",{effort:"ultra"}).settings.reasoning_effort,"ultra");
  assert.equal(collaborationModePayload(modes,"plan","gpt-6-luna",{effort:null}).settings.reasoning_effort,"medium","without a pick the mode's own effort applies");
});
