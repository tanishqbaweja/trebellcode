import test from "node:test";
import assert from "node:assert/strict";
import { compactDateTime, epochSeconds, fullDateTime, relativeTime } from "../ui/src/time-format.js";
import { mergeThreadCatalog, threadsFromCatalogMeta } from "../ui/src/thread-catalog.js";

const NOW_MS=Date.UTC(2026,9,10,14,0,0);

test("thread timestamps read the same in seconds and in milliseconds",()=>{
  const seconds=NOW_MS/1000-300;
  assert.equal(epochSeconds(seconds),seconds);
  assert.equal(epochSeconds(seconds*1000),seconds);
  assert.equal(epochSeconds(0),0);
  assert.equal(epochSeconds("not a time"),0);
  assert.equal(relativeTime(seconds,NOW_MS),"5m");
  assert.equal(relativeTime(seconds*1000,NOW_MS),"5m");
  assert.equal(relativeTime(NOW_MS/1000-7200,NOW_MS),"2h");
  assert.equal(relativeTime(NOW_MS/1000-3*86400,NOW_MS),"3d");
  assert.equal(relativeTime(NOW_MS/1000+30,NOW_MS),"now");
  assert.equal(relativeTime(0,NOW_MS),"");
  // A millisecond value never turns into a date tens of thousands of years ahead.
  assert.equal(new Date(epochSeconds(NOW_MS)*1000).getUTCFullYear(),2026);
  assert.match(fullDateTime(NOW_MS),/2026/);
});

test("history rows show a compact day and time",()=>{
  const today=new Date(NOW_MS-60_000),yesterday=new Date(NOW_MS-86_400_000);
  assert.match(compactDateTime(today.getTime(),NOW_MS),/^Today /);
  assert.match(compactDateTime(yesterday.getTime()/1000,NOW_MS),/^Yesterday /);
  assert.doesNotMatch(compactDateTime(Date.UTC(2026,0,5,12)/1000,NOW_MS),/2026/);
  assert.match(compactDateTime(Date.UTC(2024,0,5,12)/1000,NOW_MS),/2024/);
  assert.equal(compactDateTime(null,NOW_MS),"");
});

test("catalog rows written with Date.now() milliseconds sort and date like second-based rows",()=>{
  const nowSeconds=Date.now()/1000;
  const rows=threadsFromCatalogMeta({
    ms:{runtime:"codex",updatedAt:Date.now()-60_000},
    seconds:{runtime:"codex",threadSnapshot:{id:"seconds",name:"Seconds",updatedAt:nowSeconds-10}},
  });
  const ms=rows.find(row=>row.id==="ms");
  assert.ok(Math.abs(ms.updatedAt-(nowSeconds-60))<5,"milliseconds become seconds");
  assert.deepEqual(rows.map(row=>row.id),["seconds","ms"]);
  const merged=mergeThreadCatalog([],[{id:"listed-ms",name:"Listed in ms",updatedAt:Date.now()-120_000},{id:"listed-s",name:"Listed in s",updatedAt:nowSeconds-30}],{runtime:"codex"});
  assert.deepEqual(merged.map(row=>row.id),["listed-s","listed-ms"]);
  assert.ok(merged.every(row=>row.updatedAt<1e11));
});
