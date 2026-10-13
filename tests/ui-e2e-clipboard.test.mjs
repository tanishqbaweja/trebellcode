import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The browser tests run on the owner's own machine, so none of them may use its clipboard: none grants the clipboard permissions or
// reads or writes navigator.clipboard. A test that copies or pastes uses a clipboard of the page's own instead.
const e2e=fileURLToPath(new URL("../ui/e2e/",import.meta.url));

test("no browser test grants clipboard permissions or uses the machine's clipboard",()=>{
  const offenders=[];
  for(const name of readdirSync(e2e).filter(file=>file.endsWith(".js"))){
    readFileSync(join(e2e,name),"utf8").split(/\r?\n/).forEach((line,index)=>{
      if(/grantPermissions\([^)]*clipboard/.test(line)||/navigator\.clipboard\.(readText|writeText|read|write)\(/.test(line))offenders.push(name+":"+(index+1));
    });
  }
  assert.deepEqual(offenders,[]);
});
