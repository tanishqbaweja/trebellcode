import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes } from "../ui/src/format-bytes.js";

test("small sizes keep a readable unit instead of rounding to 0.0 MB",()=>{
  assert.equal(formatBytes(0),"0 B");
  assert.equal(formatBytes(512),"512 B");
  assert.equal(formatBytes(2048),"2.0 KB");
  assert.equal(formatBytes(45*1024),"45.0 KB");
  assert.equal(formatBytes(3.1*1024*1024),"3.1 MB");
  assert.equal(formatBytes(240*1024**3),"240 GB");
});

test("a missing or negative size is reported as unavailable",()=>{
  assert.equal(formatBytes(undefined),"Unavailable");
  assert.equal(formatBytes(-1),"Unavailable");
});
