import test from "node:test";
import assert from "node:assert/strict";
import {allowedWindowsSetupModes,windowsSandboxStatus,worldWritableWarningText} from "../ui/src/windows-sandbox.js";

test("Windows sandbox readiness keeps Codex protocol states explicit",()=>{
  assert.equal(windowsSandboxStatus("ready").label,"Ready");
  assert.equal(windowsSandboxStatus("notConfigured").label,"Not configured");
  assert.equal(windowsSandboxStatus("updateRequired").label,"Update required");
});

test("managed Windows sandbox implementations constrain setup buttons",()=>{
  assert.deepEqual(allowedWindowsSetupModes(null),["unelevated","elevated"]);
  assert.deepEqual(allowedWindowsSetupModes({allowedWindowsSandboxImplementations:["unelevated"]}),["unelevated"]);
  assert.deepEqual(allowedWindowsSetupModes({allowedWindowsSandboxImplementations:["mxc"]}),[]);
});

test("world-writable warnings remain concrete without overstating protection",()=>{
  assert.match(worldWritableWarningText({samplePaths:["C:\\Temp","D:\\Shared"],extraCount:2}),/C:\\Temp/);
  assert.match(worldWritableWarningText({failedScan:true}),/could not fully scan/i);
  assert.equal(worldWritableWarningText({samplePaths:[],extraCount:0}),"");
});
