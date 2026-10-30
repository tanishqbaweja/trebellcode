// The comment over ignorePressRest (ThreadSidebar.jsx) lists the controls that take only a press of their own, each with the file that
// draws it: it is where a person looks for them. Round 13 added three (Settings' Check again and the desktop app's Check now, the Usage
// page's Refresh) without listing them, and History's Retry and Load older threads had moved to ThreadHistoryPage.jsx while the list
// still named App.jsx. Every file that calls ignorePressRest is named there.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ui=fileURLToPath(new URL("../ui/src/",import.meta.url));
function sources(folder){
  return readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(folder,entry.name)):/\.(jsx?|tsx?)$/.test(entry.name)?[join(folder,entry.name)]:[]);
}

test("the comment over ignorePressRest names every file whose controls take only a press of their own",()=>{
  const sidebar=readFileSync(join(ui,"components","ThreadSidebar.jsx"),"utf8");
  const comment=/((?:^\/\/.*\n)+)export function ignorePressRest\(/m.exec(sidebar)?.[1]||"";
  assert.ok(comment,"the comment over ignorePressRest");
  // A call, not the import or a comment that names it.
  const callers=sources(ui).filter(path=>!path.endsWith("ThreadSidebar.jsx")&&readFileSync(path,"utf8").split("\n").some(line=>!/^\s*(\/\/|\/\*|\*)/.test(line)&&/\bignorePressRest\(/.test(line)&&!/^\s*import\b/.test(line)));
  assert.ok(callers.length>=10,"the files that call it: "+callers.length);
  const named=name=>comment.includes("("+name+")")||comment.includes(", "+name+")")||comment.includes("("+name+",");
  assert.deepEqual(callers.map(path=>path.split(/[\\/]/).pop()).filter(name=>!named(name)).sort(),[],"files that call ignorePressRest but are not in its comment");
});
