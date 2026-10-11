import test from "node:test";
import assert from "node:assert/strict";
import { threadMoveAvailability, threadOrderGroup } from "../ui/src/thread-order.js";

const pinned={name:"Pinned",id:"pinned"};

test("a thread alone in its section can move neither up nor down",()=>{
  const moves=threadMoveAvailability([{id:"only"}]);
  assert.deepEqual(moves.get("only"),{up:false,down:false});
});

test("threads move within their own section: the first cannot move up and the last cannot move down",()=>{
  const threads=[{id:"a"},{id:"p1",section:pinned},{id:"b"},{id:"p2",section:pinned},{id:"c"}];
  const moves=threadMoveAvailability(threads);
  assert.deepEqual(moves.get("a"),{up:false,down:true});
  assert.deepEqual(moves.get("b"),{up:true,down:true});
  assert.deepEqual(moves.get("c"),{up:true,down:false});
  assert.deepEqual(moves.get("p1"),{up:false,down:true});
  assert.deepEqual(moves.get("p2"),{up:true,down:false});
  assert.deepEqual(threadOrderGroup(threads,threads[1]).map(thread=>thread.id),["p1","p2"]);
  assert.deepEqual(threadOrderGroup(threads,threads[0]).map(thread=>thread.id),["a","b","c"]);
});

test("General chats and project threads are separate groups, as the sidebar shows them",()=>{
  // Both have no section, so the harness lists them together; the sidebar puts a projectless chat under General.
  const meta={"general-chat":{projectless:true},"general-2":{projectless:true}};
  const lone=[{id:"general-chat"},{id:"project-thread"}];
  const loneMoves=threadMoveAvailability(lone,meta);
  assert.deepEqual(loneMoves.get("general-chat"),{up:false,down:false});
  assert.deepEqual(loneMoves.get("project-thread"),{up:false,down:false});
  assert.deepEqual(threadOrderGroup(lone,lone[1],meta).map(thread=>thread.id),["project-thread"]);
  // A General chat listed between two project threads is not a step for either of them.
  const mixed=[{id:"a"},{id:"general-chat"},{id:"b"},{id:"general-2"}];
  const moves=threadMoveAvailability(mixed,meta);
  assert.deepEqual(moves.get("a"),{up:false,down:true});
  assert.deepEqual(moves.get("b"),{up:true,down:false});
  assert.deepEqual(moves.get("general-chat"),{up:false,down:true});
  assert.deepEqual(moves.get("general-2"),{up:true,down:false});
  assert.deepEqual(threadOrderGroup(mixed,mixed[0],meta).map(thread=>thread.id),["a","b"]);
  assert.deepEqual(threadOrderGroup(mixed,mixed[3],meta).map(thread=>thread.id),["general-chat","general-2"]);
  // Pinned, Snoozed and Settled threads keep their own groups whether or not they have a project.
  const sectioned=[{id:"general-chat",section:pinned},{id:"a",section:pinned},{id:"b"}];
  assert.deepEqual(threadMoveAvailability(sectioned,meta).get("general-chat"),{up:false,down:true});
  assert.deepEqual(threadMoveAvailability(sectioned,meta).get("b"),{up:false,down:false});
});

test("a thread that is not in the ordered list has no moves",()=>{
  assert.equal(threadMoveAvailability([{id:"a"}]).get("elsewhere"),undefined);
  assert.equal(threadMoveAvailability(null).size,0);
  assert.deepEqual(threadOrderGroup([{id:"a"}],{id:"elsewhere"}),[]);
  assert.deepEqual(threadOrderGroup([{id:"a"}],null),[]);
});
