import test from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../src/codex-model-catalog.mjs";
import { codexReasoningEffortLabel, codexStartingModel } from "../src/codex-model-catalog.mjs";

// The model a new Codex thread starts on and the labels of the reasoning levels, beyond the cases codex-harness-parity covers.
// Re-pinned with this unit's rewrite: the pick no longer ranks model families from a fixed list. It is Codex's own rule
// (codex-rs/models-manager/src/manager.rs at rust-v0.155.1): the row model/list flags, else its first row. Before, a fixed family
// list beat the flag, and a list with no flag and none of those families gave no model at all.

// [model/list's rows in Codex's order, the model a new thread starts on, why]
const STARTS = [
  [[{id:"gpt-6-luna"},{id:"gpt-6.1-sol",isDefault:true},{id:"gpt-6-mini"}], "gpt-6.1-sol", "the flagged row, wherever Codex lists it"],
  [[{id:"gpt-6-mini"},{id:"gpt-6-luna"}], "gpt-6-mini", "no flag: Codex's first row"],
  [[{id:"gpt-6-mini",isDefault:true},{id:"gpt-6-luna",isDefault:true}], "gpt-6-mini", "two flags: the first, as Codex reads its list"],
  [[{id:"openai.gpt-6-luna"},{id:"gpt-6-luna",isDefault:true}], "gpt-6-luna", "no name is read into an id: the flag decides"],
  [[{id:"gpt-6-mini"},{id:"gpt-6-luna",isDefault:"true"}], "gpt-6-mini", "a string is not Codex's flag"],
  [[{id:"gpt-6-mini"},{id:"gpt-6-luna",isDefault:1}], "gpt-6-mini", "a number is not Codex's flag"],
  [[{id:"gpt-6-mini",isDefault:false},{id:"gpt-6-luna"}], "gpt-6-mini", "a false flag is no flag"],
  [[{model:"gpt-6-luna",isDefault:true}], "gpt-6-luna", "a row with only a model is listed under it"],
  [[{id:"",model:"gpt-6-mini"}], "gpt-6-mini", "an empty id gives way to the model"],
  [[{id:"  gpt-6-luna\t"}], "gpt-6-luna", "the blanks around an id are not part of it"],
  [[{id:"gpt-6-luna",model:"gpt-6-mini",isDefault:true}], "gpt-6-luna", "the id decides when it is set"],
  [[null,"gpt-6-luna",7,{isDefault:true},{id:" ",model:"gpt-6-mini",isDefault:true},{id:"gpt-6-nano"}], "gpt-6-nano", "a row with no id is not a model, flagged or not"],
  [[], null, "an empty list: no model"],
  [undefined, null, "no list"],
  [null, null, "no list"],
  [{data:[{id:"gpt-6-luna"}]}, null, "model/list's whole answer is not its rows"],
  ["gpt-6-luna", null, "a string is not a list"],
  [{length:1,0:{id:"gpt-6-luna"}}, null, "only a real array is a list"],
];

// [level id, how the composer shows it]: the levels Codex's own picker names, other ids (object property names included), and no id.
// Re-pinned: xhigh reads "Extra high" as in Codex's picker (it read "Extra High"), and persistent "Persistent" (it read as its id).
const LABELS = [
  ["none", "None"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"],
  ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"], ["ultra", "Ultra"], ["persistent", "Persistent"],
  ["turbo", "turbo"], ["HIGH", "HIGH"], ["High", "High"], [" high", " high"], ["x-high", "x-high"], ["default", "default"],
  ["constructor", "constructor"], ["toString", "toString"], ["__proto__", "__proto__"], ["hasOwnProperty", "hasOwnProperty"],
  [undefined, ""], [null, ""], ["", ""], [false, ""], [0, ""],
];

test("a new Codex thread starts on the model Codex flags, else on Codex's first, else on none",()=>{
  const before=JSON.stringify(STARTS);
  for(const [rows,expected,why] of STARTS)assert.equal(codexStartingModel(rows),expected,why);
  assert.equal(JSON.stringify(STARTS),before,"the pick only reads the rows");
});

test("the module keeps no list of model names of its own: its exports are functions",()=>{
  assert.deepEqual(Object.keys(catalog).sort(),["codexReasoningEffortLabel","codexStartingModel","withConfiguredCodexServiceTier"]);
  for(const value of Object.values(catalog))assert.equal(typeof value,"function");
});

test("every named reasoning level has its label, any other id reads exactly as given, and no id reads as nothing",()=>{
  for(const [id,label] of LABELS)assert.equal(codexReasoningEffortLabel(id),label,String(id));
});
