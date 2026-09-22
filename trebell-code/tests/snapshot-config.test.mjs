import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SNAPSHOT_CONFIG, normalizeSnapshotConfig } from "../desktop/snapshot-config.mjs";

test("SnapShot feedback defaults match the desktop capture experience",()=>{
  assert.deepEqual(DEFAULT_SNAPSHOT_CONFIG,{enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,playSound:true,sound:"soft-pop",flash:true,animations:true});
});

test("SnapShot config preserves omitted values and validates sound names",()=>{
  const current={...DEFAULT_SNAPSHOT_CONFIG,enabled:true,sound:"camera-shutter",flash:false};
  assert.deepEqual(normalizeSnapshotConfig({includeText:true,sound:"invalid"},current),{...current,includeText:true,sound:"camera-shutter"});
  assert.equal(normalizeSnapshotConfig({playSound:false,animations:false},current).playSound,false);
  assert.equal(normalizeSnapshotConfig({playSound:false,animations:false},current).animations,false);
});
