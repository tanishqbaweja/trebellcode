import test from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_AUTO_COLLAPSE_WIDTH, sidebarAutoCollapses } from "../ui/src/sidebar-layout.js";

test("the sidebar collapses on its own only in a window too narrow for it beside the conversation",()=>{
  for(const width of [360,480,700,SIDEBAR_AUTO_COLLAPSE_WIDTH-1])assert.equal(sidebarAutoCollapses(width),true,`${width}px`);
  for(const width of [SIDEBAR_AUTO_COLLAPSE_WIDTH,900,1280,1600])assert.equal(sidebarAutoCollapses(width),false,`${width}px`);
});

test("a width that was not measured never collapses the sidebar",()=>{
  for(const width of [0,-1,NaN,undefined,null,"wide"])assert.equal(sidebarAutoCollapses(width),false,String(width));
  assert.equal(sidebarAutoCollapses("700"),true);
});
