import test from "node:test";
import assert from "node:assert/strict";
import { specializedToolNamespaceNames, specializedToolSelection } from "../ui/src/lazy-tool-exposure.js";

const all={browser:true,computer:true,device:true,sourceControl:true,delegation:true};

test("plain coding tasks do not receive unrelated specialized tool groups",()=>{
  assert.deepEqual(specializedToolSelection("Fix the parser bug and add targeted tests",all),{browser:false,computer:false,device:false,sourceControl:false,delegation:false});
});

test("specialized task language exposes only relevant capability groups",()=>{
  assert.deepEqual(specializedToolSelection("Fix the responsive CSS layout and verify it with a browser screenshot",all),{browser:true,computer:false,device:false,sourceControl:false,delegation:false});
  assert.deepEqual(specializedToolSelection("Check this Android app in the emulator",all),{browser:false,computer:false,device:true,sourceControl:false,delegation:false});
  assert.deepEqual(specializedToolSelection("Create a git branch, commit the fix, and open a pull request",all),{browser:false,computer:false,device:false,sourceControl:true,delegation:false});
  assert.deepEqual(specializedToolSelection("Use computer use to click the Windows desktop with the mouse",all),{browser:false,computer:true,device:false,sourceControl:false,delegation:false});
  assert.deepEqual(specializedToolSelection("Delegate two independent subtasks and run them in parallel",all),{browser:false,computer:false,device:false,sourceControl:false,delegation:true});
});

test("unavailable capability groups never become exposed from task wording",()=>{
  assert.deepEqual(specializedToolSelection("Take a browser screenshot, then push a git branch",{}),{browser:false,computer:false,device:false,sourceControl:false,delegation:false});
});

test("specialized task selection maps to stable Trebell namespace names for later-turn expansion",()=>{
  assert.deepEqual(specializedToolNamespaceNames("Now verify the responsive page in a browser and commit the fix",all),["trebell_browser","trebell_source_control"]);
  assert.deepEqual(specializedToolNamespaceNames("Keep debugging the parser",all),[]);
});
