import test from "node:test";
import assert from "node:assert/strict";
import { changedNameMarks, changedPathPlans, extensionStart, fitGlyphs, glyphLabel, glyphRuns, graphemes } from "../ui/src/changed-name-fit.js";

// One unit per Latin character and for the ellipsis, as in the list's monospace face; a CJK glyph is about 1.67 of them there.
const unit=glyph=>/[　-鿿]/.test(glyph)?1.67:1;
function labels(paths,room){
  return changedPathPlans(paths).map(plan=>glyphLabel(plan.glyphs,fitGlyphs(plan.glyphs,{widths:plan.glyphs.map(unit),ellipsis:1,available:room,marks:plan.marks,extension:plan.extension}).shown));
}
const readsAs=(label,name)=>new RegExp("^"+label.split("…").map(piece=>piece.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".+")+"$","u").test(name);

test("names that part far from their end keep where they part and their end, in the room a narrow row has",()=>{
  const paths=["visual-audit/workspace-diff-long-names-dark-1280x800.png","visual-audit/workspace-diff-long-names-light-1280x800.png","visual-audit/workspace-diff-long-names-dark-1600x980.png","visual-audit/workspace-diff-long-names-light-1600x980.png"];
  assert.deepEqual(labels(paths,14),["…dark…x800.png","…light…800.png","…dark…x980.png","…light…980.png"]);
  // Narrower still they read apart, by one character each where they part; wider, the cuts close up.
  for(const room of [9,10,11,12,13,14,16,18,20,24,30,40]){
    const shown=labels(paths,room);
    assert.equal(new Set(shown).size,shown.length,room+": "+shown);
    for(const [index,label] of shown.entries()){assert.ok(readsAs(label,paths[index].split("/").pop()),room+": "+label);assert.ok(label.endsWith(".png"),label)}
  }
  assert.deepEqual(labels(paths,40),["worksp…diff-long-names-dark-1280x800.png","works…diff-long-names-light-1280x800.png","worksp…diff-long-names-dark-1600x980.png","works…diff-long-names-light-1600x980.png"]);
  assert.deepEqual(labels(paths,44),paths.map(path=>path.split("/").pop()));
});

test("this checkout's long untracked names keep the end that tells them apart",()=>{
  const paths=["artifact_1791317470236_d6b22939.png","artifact_1791317477991_ae1a8b66.png","artifact_1791317484338_7c659e6b.png","artifact_1791317494127_7b87f9be.png","capcut-network-capture/","goal.md","google_startups_window.png",
    "ui/src/tool-activity.js","ui/src/tool-activity-summary.js","tests/ui-tool-activity.test.mjs","src/native-agent-session-recovery.mjs","src/native-agent-session-recorder.mjs","package.json","package-lock.json"];
  assert.deepEqual(labels(paths,14),["a…d6b22939.png","a…ae1a8b66.png","a…7c659e6b.png","a…7b87f9be.png","capcu…capture/","goal.md","goo…window.png","to…activity.js","too…summary.js","ui-to…test.mjs","n…recovery.mjs","n…recorder.mjs","package.json","pack…lock.json"]);
});

test("wide glyphs are measured as they are, so a CJK name keeps whole glyphs and its ellipsis",()=>{
  const paths=["设计稿-最终版-第二次修改.png","设计稿-最终版-第三次修改.png","résumé-final-version-2026.pdf","résumé-final-version-2025.pdf"];
  assert.deepEqual(labels(paths,14),["…第二次修改.png","…第三次修改.png","résum…2026.pdf","résum…2025.pdf"]);
  const plan=changedPathPlans(paths)[0],fit=fitGlyphs(plan.glyphs,{widths:plan.glyphs.map(unit),ellipsis:1,available:14,marks:plan.marks,extension:plan.extension});
  assert.ok(fit.width<=14,String(fit.width));
  // An accent written as a combining mark, or an emoji sequence, is one character: never cut in two.
  assert.deepEqual(graphemes("résumé.md"),["r","é","s","u","m","é",".","m","d"]);
  assert.deepEqual(graphemes("a👩‍💻b"),["a","👩‍💻","b"]);
});

test("a name another changed file shares in full keeps the folder segments that tell them apart",()=>{
  const plans=changedPathPlans(["packages/alpha/docker-compose.yml","packages/beta/docker-compose.yml","apps/web/src/index.js","apps/desktop/src/index.js","index.js","lib/util.js"]);
  const kept=plans.map(plan=>plan.dirKeep==null?null:plan.dirGlyphs.slice(plan.dirKeep).join(""));
  assert.deepEqual(kept,["alpha","beta","web/src","desktop/src",null,null]);
  // A file at the top beside one in a folder is told apart by the other's folder.
  const top=changedPathPlans(["index.js","lib/index.js"]);
  assert.deepEqual(top.map(plan=>plan.dirKeep),[null,0]);
  // The folder keeps those segments and gives way from its start.
  const plan=plans[0],folder=room=>glyphLabel(plan.dirGlyphs,fitGlyphs(plan.dirGlyphs,{widths:plan.dirGlyphs.map(unit),ellipsis:1,available:room,extension:plan.dirKeep,lead:false}).shown);
  assert.deepEqual([4,6,7,9,14].map(folder),["…pha","…alpha","…/alpha","…es/alpha","packages/alpha"]);
});

test("each name keeps a character where it differs from every other name, and its extension",()=>{
  const names=["tool-activity.js","tool-activity-summary.js","ui-tool-activity.test.mjs","a.png","b.png"];
  const marks=changedNameMarks(names);
  for(const [index,{glyphs,marks:kept,extension}] of marks.entries()){
    const visible=new Set([...kept,...Array.from({length:glyphs.length-extension},(_,offset)=>extension+offset)]);
    if(extension===glyphs.length)visible.add(glyphs.length-1);
    for(const [other,them] of names.entries()){
      if(other===index)continue;
      // Some kept character differs from the other name at the same place counted from either end.
      const own=glyphs,theirs=graphemes(them);
      assert.ok([...visible].some(at=>own[at]!==theirs[at]||own[at]!==theirs[theirs.length-own.length+at]),names[index]+" vs "+them);
    }
  }
  assert.deepEqual(changedNameMarks(["same.txt","same.txt"]).map(plan=>plan.marks),[[],[]]);
  assert.deepEqual(changedNameMarks(),[]);
});

test("a name that fits is drawn whole, and nothing fits draws the end alone",()=>{
  const glyphs=graphemes("notes.txt"),widths=glyphs.map(()=>1);
  assert.deepEqual(fitGlyphs(glyphs,{widths,ellipsis:1,available:9}).shown,glyphs.map(()=>true));
  assert.equal(glyphLabel(glyphs,fitGlyphs(glyphs,{widths,ellipsis:1,available:3,extension:extensionStart(glyphs)}).shown),"…xt");
  assert.equal(glyphLabel(glyphs,fitGlyphs(glyphs,{widths,ellipsis:1,available:0,extension:extensionStart(glyphs)}).shown),"…");
  assert.deepEqual(glyphRuns(graphemes("abcdef"),[true,false,false,true,true,false]),[{text:"a",hidden:false},{text:"bc",hidden:true},{text:"de",hidden:false},{text:"f",hidden:true}]);
  // A run of one character is drawn rather than replaced by an ellipsis as wide.
  for(const room of [5,6,7,8]){const label=glyphLabel(graphemes("ab-cd-ef.txt"),fitGlyphs(graphemes("ab-cd-ef.txt"),{widths:Array(12).fill(1),ellipsis:1,available:room,extension:8}).shown);assert.ok(label.length<=room,label);assert.doesNotMatch(label,/…[^…]…/u)}
  assert.equal(extensionStart(graphemes(".gitignore")),10);
  assert.equal(extensionStart(graphemes("archive.verylongextension")),25);
});
