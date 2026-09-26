import test from "node:test";
import assert from "node:assert/strict";
import { nativeCommandSemanticError, normalizeNativeCommandArguments } from "../src/native-command-argv.mjs";

test("Native command normalization converts common executable-plus-args strings without invoking a shell",()=>{
  assert.deepEqual(normalizeNativeCommandArguments({command:"node verify.mjs"}),{command:"node",args:["verify.mjs"]});
  assert.deepEqual(normalizeNativeCommandArguments({command:'node "my test.mjs"'}),{command:"node",args:["my test.mjs"]});
  assert.deepEqual(normalizeNativeCommandArguments({command:"node",args:"verify.mjs"}),{command:"node",args:["verify.mjs"]});
  assert.deepEqual(normalizeNativeCommandArguments({command:"git status",args:["--short"]}),{command:"git status",args:["--short"]});
});

test("Native command normalization never interprets shell syntax implicitly",()=>{
  const input={command:"npm test | findstr FAIL"};
  assert.deepEqual(normalizeNativeCommandArguments(input),input);
  assert.match(nativeCommandSemanticError(input),/explicit shell executable/i);
  assert.equal(nativeCommandSemanticError({command:"powershell",args:["-Command","npm test | findstr FAIL"]}),null);
});
