import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_WINDOW_SIZE, activityWindow, nextActivityWindowEnd, previousActivityWindowEnd } from "../ui/src/activity-window.js";

const events=Array.from({length:300},(_,index)=>({id:"event-"+index}));

test("activity window mounts only the newest bounded page by default",()=>{
  const latest=activityWindow(events);
  assert.equal(latest.items.length,ACTIVITY_WINDOW_SIZE);
  assert.equal(latest.items[0].id,"event-180");
  assert.equal(latest.items.at(-1).id,"event-299");
  assert.equal(latest.latest,true);
  assert.equal(latest.hasOlder,true);
});

test("activity windows page backward and forward without exceeding the mount bound",()=>{
  const latest=activityWindow(events),older=activityWindow(events,{end:previousActivityWindowEnd(latest)});
  assert.equal(older.items.length,ACTIVITY_WINDOW_SIZE);
  assert.equal(older.items[0].id,"event-60");
  assert.equal(older.items.at(-1).id,"event-179");
  assert.equal(older.latest,false);
  assert.equal(nextActivityWindowEnd(older),null);
  const oldest=activityWindow(events,{end:previousActivityWindowEnd(older)});
  assert.equal(oldest.items.length,60);
  assert.equal(oldest.items[0].id,"event-0");
  assert.equal(oldest.hasOlder,false);
});

test("an older activity window stays anchored when live events append",()=>{
  const older=activityWindow(events,{end:180}),extended=[...events,{id:"event-300"},{id:"event-301"}];
  const anchored=activityWindow(extended,{end:older.end});
  assert.deepEqual(anchored.items.map(item=>item.id),older.items.map(item=>item.id));
  assert.equal(anchored.hasNewer,true);
});
