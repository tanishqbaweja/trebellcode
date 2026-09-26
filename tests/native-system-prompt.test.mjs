import test from "node:test";
import assert from "node:assert/strict";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";

test("Native system prompt teaches evidence-driven coding without inventing unavailable capabilities",()=>{
  const prompt=nativeSystemPrompt({
    permissionMode:"supervised",
    projectless:false,
    tools:[
      {name:"trebell_repo"},
      {name:"trebell_workspace"},
      {name:"trebell_terminal"},
      {name:"trebell_browser"},
    ],
  });
  assert.match(prompt,/first-party autonomous software-engineering agent/i);
  assert.match(prompt,/Inspect relevant state/i);
  assert.match(prompt,/Claim success only from Trebell evidence/i);
  assert.match(prompt,/exact paths, commands, URLs/i);
  assert.match(prompt,/Batch independent read-only/i);
  assert.match(prompt,/explicit user ordering constraints/i);
  assert.match(prompt,/exposed repository tools/i);
  assert.match(prompt,/semantic refactors/i);
  assert.match(prompt,/trebell_repo\/discover/i);
  assert.match(prompt,/trebell_repo\/invoke/i);
  assert.match(prompt,/isolated browser/i);
  assert.match(prompt,/Permission profile: supervised/);
  assert.doesNotMatch(prompt,/Delegate only/i);
  assert.doesNotMatch(prompt,/source-control tools/i);
  assert.match(prompt,/untrusted data/i);
});

test("Native system prompt describes only dynamically exposed specialized capabilities",()=>{
  const prompt=nativeSystemPrompt({
    permissionMode:"read-only",
    projectless:true,
    tools:[
      {name:"trebell_workspace"},
      {name:"trebell_terminal"},
      {name:"trebell_source_control"},
      {name:"trebell_delegate"},
      {name:"trebell_mcp"},
    ],
  });
  assert.match(prompt,/General chat/);
  assert.match(prompt,/source-control tools/i);
  assert.match(prompt,/Delegate only/i);
  assert.match(prompt,/MCP capabilities/i);
  assert.doesNotMatch(prompt,/isolated browser/i);
  assert.match(prompt,/Permission profile: read-only/);
});
