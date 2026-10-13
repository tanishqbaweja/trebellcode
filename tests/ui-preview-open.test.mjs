import test from "node:test";
import assert from "node:assert/strict";
import { requestPreview, takeRequestedPreview } from "../ui/src/preview-open.js";

// A target that records the events sent to it, as the window would deliver them to a Browser panel already drawn.
function recorder(){const events=[];return {events,dispatchEvent:event=>{events.push({type:event.type,detail:event.detail});return true}}}

test("an address asked for before the Browser panel listens waits for the panel, once",()=>{
  takeRequestedPreview();
  const target=recorder();
  requestPreview("  http://127.0.0.1:5173/dev  ",target);
  assert.deepEqual(target.events,[{type:"trebell:preview-open",detail:"http://127.0.0.1:5173/dev"}]);
  assert.equal(takeRequestedPreview(),"http://127.0.0.1:5173/dev","the panel drawn next opens on it");
  assert.equal(takeRequestedPreview(),"","a panel drawn after that opens on its own default address");
});

test("the latest address asked for is the one the panel opens on, and an empty one asks for nothing",()=>{
  takeRequestedPreview();
  const target=recorder();
  requestPreview("http://localhost:3000/a",target);requestPreview("http://localhost:3000/b",target);requestPreview("   ",target);requestPreview(null,target);
  assert.deepEqual(target.events.map(event=>event.detail),["http://localhost:3000/a","http://localhost:3000/b"]);
  assert.equal(takeRequestedPreview(),"http://localhost:3000/b");
});
