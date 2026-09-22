import test from "node:test";
import assert from "node:assert/strict";
import { localDateTimeValue, snoozeUntilFromDuration, timestampFromLocalDateTime } from "../ui/src/thread-snooze.js";

test("snooze duration supports minutes, hours and 24-hour days",()=>{
  const now=1_700_000_000_000;
  assert.equal(snoozeUntilFromDuration(30,"minutes",now),now+30*60_000);
  assert.equal(snoozeUntilFromDuration(2,"hours",now),now+2*3_600_000);
  assert.equal(snoozeUntilFromDuration(3,"days",now),now+3*24*3_600_000);
  assert.equal(snoozeUntilFromDuration(0,"hours",now),null);
  assert.equal(snoozeUntilFromDuration(1,"weeks",now),null);
});

test("local date-time values round-trip in the host timezone",()=>{
  const source=new Date(2026,8,22,18,35,0,0).getTime();
  const value=localDateTimeValue(source);
  assert.equal(value,"2026-09-22T18:35");
  assert.equal(timestampFromLocalDateTime(value),source);
  assert.equal(timestampFromLocalDateTime(""),null);
});
