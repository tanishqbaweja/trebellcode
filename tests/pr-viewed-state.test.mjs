import test from "node:test";
import assert from "node:assert/strict";
import { prViewedKey, updateViewedRecord, viewedStates } from "../src/pr-viewed-state.mjs";

test("local PR viewed marks become stale after a new head revision",()=>{
  const files=[{path:"src/a.js",additions:2,deletions:1},{path:"src/b.js",additions:1,deletions:0}];
  const record=updateViewedRecord(files,{},"head-1",[{path:"src/a.js",viewed:true}]);
  assert.deepEqual(viewedStates(files,record,"head-1"),[{path:"src/a.js",state:"viewed"},{path:"src/b.js",state:"unviewed"}]);
  assert.deepEqual(viewedStates(files,record,"head-2"),[{path:"src/a.js",state:"dismissed"},{path:"src/b.js",state:"unviewed"}]);
});

test("unmarking a PR file removes its local viewed mark",()=>{
  const files=[{path:"README.md",patch:"@@ fixture"}];let record=updateViewedRecord(files,{},null,[{path:"README.md",viewed:true}]);
  record=updateViewedRecord(files,record,null,[{path:"README.md",viewed:false}]);
  assert.deepEqual(viewedStates(files,record,null),[{path:"README.md",state:"unviewed"}]);
  assert.equal(prViewedKey("GitLab",12),"gitlab:12");
});
