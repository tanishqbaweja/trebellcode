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
