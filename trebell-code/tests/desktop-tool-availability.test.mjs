import test from "node:test";
import assert from "node:assert/strict";
import { desktopBridgeToolAvailability } from "../ui/src/desktop-tool-availability.js";

test("desktop tool availability advertises computer control only on Windows",()=>{
  const computer={screenshot(){}},browser={navigate(){}};
  assert.deepEqual(desktopBridgeToolAvailability({platform:"win32",computer,browser}),{browser:true,computer:true});
  assert.deepEqual(desktopBridgeToolAvailability({platform:"darwin",computer,browser}),{browser:true,computer:false});
  assert.deepEqual(desktopBridgeToolAvailability({platform:"linux",computer,browser}),{browser:true,computer:false});
  assert.deepEqual(desktopBridgeToolAvailability({platform:"win32",browser}),{browser:true,computer:false});
  assert.deepEqual(desktopBridgeToolAvailability(null),{browser:false,computer:false});
});
