import test from "node:test";
import assert from "node:assert/strict";
import { latestTurnRowsStart } from "../ui/src/conversation-order.js";

const user=(id,turnId)=>({id,role:"user",turnId}),reply=(id,turnId)=>({id,role:"assistant",turnId}),thought=(id,turnId)=>({id,role:"reasoning",turnId});

test("a turn started by a new message moves its reply below the activity card",()=>{
  const messages=[user("u1","t1"),reply("a1","t1"),user("u2","t2"),thought("r2","t2"),reply("a2","t2")];
  assert.equal(latestTurnRowsStart(messages,"t2"),3);
  // The message sent a moment ago has no turn yet, and neither has the card: the rows after it still move.
  assert.equal(latestTurnRowsStart([user("u1","t1"),reply("a1","t1"),user("u2",null),reply("a2",null)],null),3);
  // Nothing after the last user message yet: nothing moves.
  assert.equal(latestTurnRowsStart([user("u1","t1"),reply("a1","t1"),user("u2",null)],"t2"),-1);
});

test("a turn started without a new message keeps the previous reply above its card",()=>{
  const goal=[user("u1","t1"),reply("a1","t1")];
  assert.equal(latestTurnRowsStart(goal,"t2"),-1);
  assert.equal(latestTurnRowsStart([...goal,thought("r2","t2"),reply("a2","t2")],"t2"),2);
  // Once the previous turn's own card is shown, its reply moves as before.
  assert.equal(latestTurnRowsStart(goal,"t1"),1);
});

test("a steer in the running turn keeps the rows before it in place",()=>{
  const steered=[user("u1","t1"),reply("a1","t1"),user("s1","t1"),reply("a2","t1")];
  assert.equal(latestTurnRowsStart(steered,"t1"),3);
  assert.equal(latestTurnRowsStart([],"t1"),-1);
});
