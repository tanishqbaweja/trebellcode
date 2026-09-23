import test from "node:test";
import assert from "node:assert/strict";
import { threadListParams } from "../ui/src/thread-list-query.js";

test("thread listing is provider-independent",()=>{
  const params=threadListParams(100);
  assert.deepEqual(params,{limit:100,sortKey:"updated_at",sortDirection:"desc"});
  assert.equal(Object.prototype.hasOwnProperty.call(params,"modelProviders"),false);
});
