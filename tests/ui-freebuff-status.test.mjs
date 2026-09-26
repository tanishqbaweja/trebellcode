import test from "node:test";
import assert from "node:assert/strict";
import { freebuffSessionLabel, freebuffSessionUnavailable } from "../ui/src/freebuff-status.js";

test("Freebuff status treats signed-in blocked sessions as unavailable",()=>{
  assert.equal(freebuffSessionUnavailable({loggedIn:true,derived:{sessionStatus:"banned"}}),true);
  assert.equal(freebuffSessionUnavailable({loggedIn:true,session:{status:"suspended"}}),true);
  assert.equal(freebuffSessionUnavailable({loggedIn:true,errors:{session:{status:403}},derived:{sessionStatus:"active"}}),true);
  assert.equal(freebuffSessionUnavailable({loggedIn:true,derived:{sessionStatus:"active"}}),false);
  assert.equal(freebuffSessionLabel({session:{status:"BANNED"}}),"banned");
});
