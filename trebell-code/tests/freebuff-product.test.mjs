import test from "node:test";
import assert from "node:assert/strict";
import { extractBalance, normalizeModelId, priceForModel } from "../src/freebuff-product.mjs";

test("normalizes Freebuff provider-prefixed model ids", () => {
  assert.equal(normalizeModelId("freebuff/deepseek/deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
});

test("extracts Freebucks balance from common session shapes", () => {
  assert.equal(extractBalance({ freebucks: { balance: 42 } }), 42);
  assert.equal(extractBalance({ freebucks: 18 }), 18);
  assert.equal(extractBalance({ balance: 7 }), 7);
});

test("server pricing overrides documented fallback", () => {
  const price=priceForModel("freebuff/deepseek/deepseek-v4-flash", {
    "deepseek/deepseek-v4-flash": 12,
  }, new Date("2026-09-20T12:00:00Z"));
  assert.equal(price.current,12);
  assert.equal(price.source,"server");
});

test("documented DeepSeek off-peak fallback is 10 Freebucks between 22:00 and 06:00 UTC", () => {
  const offPeak=priceForModel("deepseek/deepseek-v4-flash", null, new Date("2026-09-20T23:00:00Z"));
  const peak=priceForModel("deepseek/deepseek-v4-flash", null, new Date("2026-09-20T12:00:00Z"));
  assert.equal(offPeak.current,10);
  assert.equal(offPeak.offPeakActive,true);
  assert.equal(peak.current,15);
  assert.equal(peak.offPeakActive,false);
});
