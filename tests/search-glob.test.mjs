import test from "node:test";
import assert from "node:assert/strict";
import { compileSearchGlob } from "../src/search-glob.mjs";

const matches=(glob,path,scope=null)=>compileSearchGlob(glob).test(path,scope);

test("a search glob without a slash matches the file name at any depth",()=>{
  assert.equal(matches("*.py","setup.py"),true);
  assert.equal(matches("*.py","astropy/io/ascii/core.py"),true);
  assert.equal(matches("*.py","astropy/io/ascii/core.pyc"),false);
  assert.equal(matches("test_*.py","astropy/io/ascii/tests/test_html.py"),true);
  assert.equal(matches("test_*.py","astropy/io/ascii/html.py"),false);
  assert.equal(matches("core.?y","pkg/core.py"),true);
  assert.equal(matches("*.md","README.MD"),false,"matching is case-sensitive, as in ripgrep");
});

test("a search glob with a slash matches the repository-relative path, with ** spanning folders",()=>{
  assert.equal(matches("src/**/*.ts","src/a.ts"),true);
  assert.equal(matches("src/**/*.ts","src/deep/er/a.ts"),true);
  assert.equal(matches("src/**/*.ts","lib/src/a.ts"),false);
  assert.equal(matches("src/*.ts","src/deep/a.ts"),false,"one * stays inside one folder");
  assert.equal(matches("**/tests/*.py","astropy/io/ascii/tests/test_html.py"),true);
  assert.equal(matches("**/tests/*.py","tests/test_x.py"),true,"**/ also matches no folder");
  assert.equal(matches("docs/","docs/api/index.rst"),true,"a trailing slash means everything under the folder");
  assert.equal(matches("/*.py","setup.py"),true);
  assert.equal(matches("/*.py","pkg/setup.py"),false,"a leading slash anchors the glob at the repository root");
  assert.equal(matches("./src/*.js","src/a.js"),true);
  assert.equal(matches("src\\*.js","src/a.js"),true,"backslash separators are read as folders");
});

test("a search glob with a slash also matches inside the searched folder",()=>{
  assert.equal(matches("ascii/*.py","astropy/io/ascii/core.py","astropy/io"),true);
  assert.equal(matches("ascii/*.py","astropy/io/ascii/core.py"),false);
  assert.equal(matches("ascii/*.py","astropy/table/ascii/core.py","astropy/io"),false);
});

test("a search glob supports classes, alternatives and a leading ! that excludes",()=>{
  assert.equal(matches("*.{ts,tsx}","ui/App.tsx"),true);
  assert.equal(matches("*.{ts,tsx}","ui/App.ts"),true);
  assert.equal(matches("*.{ts,tsx}","ui/App.js"),false);
  assert.equal(matches("{src,lib}/**/*.js","lib/x/y.js"),true);
  assert.equal(matches("{src,lib}/**/*.js","test/x/y.js"),false);
  assert.equal(matches("file[0-9].txt","a/file7.txt"),true);
  assert.equal(matches("file[!0-9].txt","a/file7.txt"),false);
  assert.equal(matches("file[!0-9].txt","a/fileA.txt"),true);
  assert.equal(matches("app/[[]id]/*.tsx","app/[id]/page.tsx"),true,"[[] matches a literal bracket");
  assert.equal(matches("!*.test.js","src/a.test.js"),false);
  assert.equal(matches("!*.test.js","src/a.js"),true);
  assert.equal(matches("!tests/**","tests/a.py"),false);
  assert.equal(matches("!tests/**","src/a.py"),true);
});

test("a search glob is matched without backtracking blow-up",()=>{
  const started=Date.now();
  const glob=compileSearchGlob("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"),path="x/"+"a".repeat(4000);
  assert.equal(glob.test(path),false);
  assert.ok(Date.now()-started<1000,"a pathological glob must not stall the search");
});

test("an empty search glob is rejected",()=>{
  assert.throws(()=>compileSearchGlob("   "),/glob/i);
  assert.throws(()=>compileSearchGlob("!"),/glob/i);
});
