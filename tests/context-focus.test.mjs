import test from "node:test";
import assert from "node:assert/strict";
import { repositoryFocusPaths } from "../ui/src/context-focus.js";

test("repository focus keeps original source paths for imported file mentions",()=>{
  const imported="C:/Users/example/.trebell/attachments/copied-package.json";
  const source="C:/repo/package.json";
  const focus=repositoryFocusPaths([imported],[{path:imported,kind:"file",sourcePath:source}]);
  assert.deepEqual(focus,[imported,source]);
});

test("repository focus deduplicates direct workspace attachments and ignores non-file context without a source",()=>{
  const source="/srv/app/src/auth/session.js";
  const focus=repositoryFocusPaths([source],[{path:source,kind:"file",sourcePath:source},{path:"/tmp/screenshot.png",kind:"computer"}]);
  assert.deepEqual(focus,[source]);
});
