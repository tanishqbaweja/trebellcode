import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAYOUT, clampLayoutValue, normalizeLayoutPreferences } from "../ui/src/layout-preferences.js";

test("layout preferences default to useful coding-workspace proportions",()=>{
  assert.deepEqual(normalizeLayoutPreferences(),DEFAULT_LAYOUT);
});

test("layout preferences clamp panes to usable bounds",()=>{
  assert.equal(clampLayoutValue("sidebarWidth",20),210);
  assert.equal(clampLayoutValue("sidebarWidth",999),420);
  assert.equal(clampLayoutValue("rightPanelWidth",10),340);
  assert.equal(clampLayoutValue("terminalHeight",900),620);
  assert.deepEqual(normalizeLayoutPreferences({sidebarWidth:333.4,rightPanelWidth:512.7,terminalHeight:"280"}),{sidebarWidth:333,rightPanelWidth:513,terminalHeight:280});
});
