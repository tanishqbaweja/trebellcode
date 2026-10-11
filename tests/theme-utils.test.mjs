import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, inkOn, luminance, normalizeCustomTheme, themeCssVariables } from "../ui/src/theme-utils.js";

const fills=variables=>[variables["--bg"],variables["--panel"],variables["--panel2"]];
const minContrast=(variables,name)=>Math.min(...fills(variables).map(fill=>contrastRatio(variables[name],fill)));
function assertReadable(variables,label){
  const floors={"--theme-foreground":7,"--muted":4.5,"--muted2":3.8,"--purple":3,"--green":4.5,"--theme-error":4.5,"--theme-warning":4.5};
  for(const [name,floor] of Object.entries(floors))assert.ok(minContrast(variables,name)>=floor,`${label}: ${name} ${variables[name]} is ${minContrast(variables,name).toFixed(2)}:1 on its fills, below ${floor}:1`);
}

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
  assert.notEqual(dark["--theme-canvas"],light["--theme-canvas"]);assert.ok(dark["--panel"]);assert.ok(light["--panel"]);
  // The violet accent already reads on the dark fills; on the light canvas made from the theme it is darkened just enough.
  assert.equal(dark["--purple"],"#9c6cff");
  assert.notEqual(light["--purple"],"#9c6cff");assert.ok(minContrast(light,"--purple")>=3&&minContrast(light,"--purple")<3.1);
  assertReadable(dark,"Dual dark");assertReadable(light,"Dual light");
});

test("a light theme shown in dark mode gets a dark canvas and readable secondary text",()=>{
  const warmPaper={name:"Warm paper",appearance:"light",canvas:"#f4efe6",accent:"#b0582f",colors:{}};
  const dark=themeCssVariables(warmPaper,"dark");
  assert.ok(luminance(dark["--theme-canvas"])<=.02,`canvas ${dark["--theme-canvas"]} is not dark`);
  assertReadable(dark,"Warm paper dark");
  // The tiers keep their order: foreground over muted over muted2.
  assert.ok(luminance(dark["--theme-foreground"])>luminance(dark["--muted"])&&luminance(dark["--muted"])>luminance(dark["--muted2"]));
  // In its own mode the theme keeps its canvas and accent, which already read there.
  const light=themeCssVariables(warmPaper,"light");
  assert.equal(light["--theme-canvas"],"#f4efe6");assert.equal(light["--purple"],"#b0582f");
  assertReadable(light,"Warm paper light");
});

test("a theme's foreground made for the other mode is moved until it reads instead of vanishing",()=>{
  const darkPlus=normalizeCustomTheme({name:"Dark+",type:"dark",colors:{"editor.background":"#1e1e1e","editor.foreground":"#d4d4d4","focusBorder":"#007fd4"}});
  const light=themeCssVariables(darkPlus,"light");
  assert.ok(luminance(light["--theme-foreground"])<luminance("#d4d4d4"));
  assertReadable(light,"Dark+ light");
  const githubLight=normalizeCustomTheme({name:"GitHub Light",type:"light",colors:{"editor.background":"#ffffff","editor.foreground":"#1f2328","focusBorder":"#0969da"}});
  assertReadable(themeCssVariables(githubLight,"dark"),"GitHub Light dark");
  // A theme's own colors are kept wherever they already read.
  const own=themeCssVariables(darkPlus,"dark");
  assert.equal(own["--theme-canvas"],"#1e1e1e");assert.equal(own["--theme-foreground"],"#d4d4d4");assert.equal(own["--purple"],"#007fd4");
});

test("every canvas, accent and foreground combination keeps readable text in both modes",()=>{
  const canvases=["#000000","#1e1e1e","#2e3440","#3f3f3f","#5a5a5a","#8a8a8a","#c8c8c8","#f4efe6","#ffffff"];
  const accents=["#b0582f","#2563eb","#88c0d0","#bd93f9","#ffcc00","#00ff00","#3a0ca3"];
  const foregrounds=[undefined,"#d4d4d4","#586e75","#000000","#ffffff"];
  for(const canvas of canvases)for(const accent of accents)for(const foreground of foregrounds)for(const appearance of [undefined,"light","dark"])for(const mode of ["dark","light"]){
    const theme={name:"Sweep",canvas,accent,appearance,colors:foreground?{foreground,error:foreground,warning:foreground,success:foreground}:{}};
    const variables=themeCssVariables(theme,mode),label=`${canvas} ${accent} ${foreground||"default"} ${appearance||"inferred"} in ${mode} mode`;
    assertReadable(variables,label);
    const order=["--theme-foreground","--muted","--muted2"].map(name=>luminance(variables[name]));
    assert.ok(mode==="dark"?order[0]>=order[1]&&order[1]>=order[2]:order[0]<=order[1]&&order[1]<=order[2],`${label}: text tiers out of order`);
  }
});

test("text on a fill a person picked stays white unless white reads under 4.5:1 there, where it turns black",()=>{
  assert.equal(inkOn("#1d2a6b"),"#ffffff");
  assert.equal(inkOn("#000"),"#ffffff");
  assert.equal(inkOn("#4f8cff"),"#000000");
  assert.equal(inkOn("#FFE680"),"#000000");
  assert.equal(inkOn("#fff"),"#000000");
  for(const fill of ["#1d2a6b","#4f8cff","#ffe680","#777777","#808080","#6a4df0","#2f6fe0","#1b7a57","#a8641f","#b04a69","#5b6b7f"]){
    assert.ok(contrastRatio(inkOn(fill),fill)>=4.5,`${inkOn(fill)} on ${fill} is ${contrastRatio(inkOn(fill),fill).toFixed(2)}:1`);
  }
  for(const fill of ["#6a4df0","#2f6fe0","#1b7a57","#a8641f","#b04a69","#5b6b7f"])assert.equal(inkOn(fill),"#ffffff",`the automatic tile colour ${fill} keeps white initials`);
  for(const fill of ["rebeccapurple","4f8cff","rgb(0,0,0)","",null,undefined])assert.equal(inkOn(fill),null);
});
