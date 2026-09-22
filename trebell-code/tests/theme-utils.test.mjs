import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCustomTheme, themeCssVariables } from "../ui/src/theme-utils.js";

test("normalizes compact Trebell themes",()=>{
  const theme=normalizeCustomTheme({name:"Nightfall",appearance:"dark",canvas:"#1a1b26",accent:"#7aa2f7",colors:{error:"#f7768e"}},{id:"nightfall"});
  assert.deepEqual(theme,{id:"nightfall",name:"Nightfall",appearance:"dark",canvas:"#1a1b26",accent:"#7aa2f7",colors:{error:"#f7768e"}});
});

test("imports VS Code color-theme JSON into Trebell palette fields",()=>{
  const theme=normalizeCustomTheme({name:"Fixture Code",type:"dark",colors:{"editor.background":"#101218","editor.foreground":"#d8dee9","focusBorder":"#88c0d0","editorError.foreground":"#bf616a","testing.iconPassed":"#a3be8c"}},{id:"fixture"});
  assert.equal(theme.canvas,"#101218");assert.equal(theme.accent,"#88c0d0");assert.equal(theme.colors.foreground,"#d8dee9");assert.equal(theme.colors.error,"#bf616a");assert.equal(theme.colors.success,"#a3be8c");
});

test("custom theme variables derive usable light and dark counterparts",()=>{
  const theme=normalizeCustomTheme({name:"Dual",canvas:"#151925",accent:"#9c6cff"},{id:"dual"});
  const dark=themeCssVariables(theme,"dark"),light=themeCssVariables(theme,"light");
  assert.equal(dark["--purple"],"#9c6cff");assert.equal(light["--purple"],"#9c6cff");assert.notEqual(dark["--theme-canvas"],light["--theme-canvas"]);assert.ok(dark["--panel"]);assert.ok(light["--panel"]);
});
