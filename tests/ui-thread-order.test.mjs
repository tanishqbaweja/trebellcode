import test from "node:test";
import assert from "node:assert/strict";
import { threadMoveAvailability, threadOrderGroup } from "../ui/src/thread-order.js";

const pinned={name:"Pinned",id:"pinned"};

test("a thread alone in its section can move neither up nor down",()=>{
  const moves=threadMoveAvailability([{id:"only"}]);
  assert.deepEqual(moves.get("only"),{up:false,down:false});
});

test("threads move within their own section: the first cannot move up and the last cannot move down",()=>{
  const threads=[{id:"a"},{id:"p1",section:pinned},{id:"b"},{id:"p2",section:pinned},{id:"c",section:{name:"Active"}}];
  const moves=threadMoveAvailability(threads);
  assert.deepEqual(moves.get("a"),{up:false,down:true});
  assert.deepEqual(moves.get("b"),{up:true,down:true});
  assert.deepEqual(moves.get("c"),{up:true,down:false});
  assert.deepEqual(moves.get("p1"),{up:false,down:true});
  assert.deepEqual(moves.get("p2"),{up:true,down:false});
  assert.deepEqual(threadOrderGroup(threads,threads[1]).map(thread=>thread.id),["p1","p2"]);
  assert.deepEqual(threadOrderGroup(threads,threads[0]).map(thread=>thread.id),["a","b","c"]);
});

test("a thread that is not in the ordered list has no moves",()=>{
  assert.equal(threadMoveAvailability([{id:"a"}]).get("elsewhere"),undefined);
  assert.equal(threadMoveAvailability(null).size,0);
});
