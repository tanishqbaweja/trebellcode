import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_CUE_TIMING, captureCueLifetime, captureCuePage } from "../desktop/capture-cue.mjs";

// The cue a SnapShot shows over the window it captured (desktop/main.mjs showSnapshotFeedback): one box over the whole window,
// tinted with a strong ring when Flash is on and a faint ring when only animations are, fading out when animations are on.
test("the capture cue is one fixed box over the window, its ring as Flash asks and its fade as animations ask",()=>{
  const both=captureCuePage({flash:true,animations:true});
  assert.match(both,/^<!doctype html>/);
  assert.match(both,/#cue\{position:fixed;inset:0;pointer-events:none;background:rgba\(255,255,255,\.1\);box-shadow:inset 0 0 0 3px rgba\(139,124,255,\.9\)\}/);
  assert.match(both,/animation:cue-fade 400ms ease-out forwards/);
  assert.match(both,/<div id="cue"><\/div>$/);
  const ringOnly=captureCuePage({flash:false,animations:true});
  assert.match(ringOnly,/box-shadow:inset 0 0 0 2px rgba\(139,124,255,\.6\)/);
  assert.doesNotMatch(ringOnly,/background:/);
  const still=captureCuePage({flash:true,animations:false});
  assert.doesNotMatch(still,/animation|@keyframes/);
  for(const page of [both,ringOnly,still]){
    assert.doesNotMatch(page,/html,body|overflow|cubic-bezier/,"no page reset and no easing curve of its own");
    assert.doesNotMatch(page,/<script/i,"the cue runs no script");
  }
});

test("the cue's window stays for the fade and a little after it, or a moment for a cue that does not move",()=>{
  assert.equal(captureCueLifetime({animations:true}),CAPTURE_CUE_TIMING.fadeMs+CAPTURE_CUE_TIMING.afterFadeMs);
  assert.equal(captureCueLifetime({animations:true}),480);
  assert.equal(captureCueLifetime({animations:false}),160);
  assert.equal(captureCueLifetime(),480);
});
