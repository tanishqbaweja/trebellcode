import test from "node:test";
import assert from "node:assert/strict";
import { externalHref } from "../ui/src/markdown-links.js";

test("only absolute web and mail links in a reply become links",()=>{
  assert.equal(externalHref("https://github.com/tanishqbaweja/trebellcode"),"https://github.com/tanishqbaweja/trebellcode");
  assert.equal(externalHref(" http://localhost:3000/docs "),"http://localhost:3000/docs");
  assert.equal(externalHref("mailto:team@example.com"),"mailto:team@example.com");
  // File paths and relative links would load inside the app window.
  for(const href of ["src/slug.js","./README.md","/abs/path/file.ts","src/slug.js:12","C:\repo\a.js","file:///C:/repo/a.js","#section","",null,undefined])assert.equal(externalHref(href),null,String(href));
  assert.equal(externalHref("javascript:alert(1)"),null);
  assert.equal(externalHref("data:text/html,<b>x</b>"),null);
});
