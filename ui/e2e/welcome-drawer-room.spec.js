import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// A new task's welcome with the terminal drawer open: the hero fits the room the drawer leaves above the composer, its parts giving
// way as the room shrinks, so none of it is cut. With the drawer at its tallest the mark showed cut in half behind the composer
// (tour L10-23).
const auditDir=fileURLToPath(new URL("../../visual-audit/welcome-drawer-room/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const PARTS={mark:".welcome-mark",title:"h1",subtitle:"p",starters:".suggestions"};
// Each part of the hero: hidden, or shown, and then whether it lies whole inside the scroller that holds it (not cut by its edges,
// over which the composer and the header stand), with the scroller's room for the record.
const readHero=page=>page.evaluate(parts=>{
  const scroller=document.querySelector(".chat-workspace .conversation-scroll"),welcome=scroller?.querySelector(":scope>.conversation-column>.welcome");
  if(!welcome)return {missing:true};
  const room=scroller.getBoundingClientRect(),style=getComputedStyle(scroller),top=room.top+parseFloat(style.borderTopWidth),bottom=room.bottom-parseFloat(style.borderBottomWidth);
  const out={room:Math.round(scroller.clientHeight),scrolled:scroller.scrollTop};
  for(const [name,selector] of Object.entries(parts)){
    const node=welcome.querySelector(":scope>"+selector),box=node?.getBoundingClientRect();
    out[name]=!node||!box.width||!box.height||getComputedStyle(node).display==="none"?"hidden":box.top>=top-0.5&&box.bottom<=bottom+0.5?"whole":`cut (${Math.round(box.top)}-${Math.round(box.bottom)} in ${Math.round(top)}-${Math.round(bottom)})`;
  }
  return out;
},PARTS);
// The drawer opened as a person does: the header's Toggle terminal, or Ctrl+` where the header has folded it away (a narrow window).
async function openDrawer(page){
  const toggle=page.getByTestId("terminal-toggle");
  if(await toggle.isVisible())await toggle.click();else await page.keyboard.press("Control+Backquote");
}
// The header's appearance toggle, which a narrow window folds away: pressed at 1280 wide there, and the window then narrow again.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  const toggle=page.getByTestId("appearance-toggle").first(),size=page.viewportSize(),folded=!await toggle.isVisible();
  if(folded)await page.setViewportSize({width:1280,height:size.height});
  await toggle.click();await expect(html).toHaveAttribute("data-mode",mode);
  if(folded){await page.setViewportSize(size);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
}

for(const [width,height] of [[1280,900],[1280,800],[390,844]])test(`a new task's welcome fits the room the terminal drawer leaves, none of it cut, from a short drawer to its tallest (${width}x${height})`,async({page})=>{
  test.setTimeout(90_000);
  const harness=await startRelayHarness({replies:[]});
  try{
    await routeRelayApp(page,harness);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    // The drawer's stored height, beyond its tallest: it opens at its tallest.
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:2000})));
    await page.setViewportSize({width,height});
    await page.goto("/");
    await expect(page.locator(".welcome h1")).toBeVisible();
    // Without the drawer the whole hero shows.
    expect(await readHero(page),"the welcome without the drawer").toMatchObject({mark:"whole",title:"whole"});
    await openDrawer(page);
    await expect(page.locator(".main-frame.terminal-open")).toHaveCount(1);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const tallest=await readHero(page);
    expect.soft(Object.entries(tallest).filter(([key,value])=>key in PARTS&&value!=="hidden"&&value!=="whole"),"parts cut with the drawer at its tallest: "+JSON.stringify(tallest)).toEqual([]);
    expect.soft(tallest.mark,"the mark with the drawer at its tallest: "+JSON.stringify(tallest)).toBe("hidden");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}drawer-tallest-${mode}-${width}x${height}.png`})}
    await switchMode(page,"dark");
    // Every height of the drawer from its tallest down to its shortest: no part of the hero is cut.
    for(const drawer of [560,480,400,330,260,190]){
      await page.evaluate(next=>{const prefs=JSON.parse(localStorage.getItem("trebell-layout-v1")||"{}");localStorage.setItem("trebell-layout-v1",JSON.stringify({...prefs,terminalHeight:next}))},drawer);
      await page.reload();await expect(page.locator(".welcome h1")).toHaveCount(1);
      if(!await page.locator(".main-frame.terminal-open").count())await openDrawer(page);
      await expect(page.locator(".main-frame.terminal-open")).toHaveCount(1);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const hero=await readHero(page);
      expect.soft(Object.entries(hero).filter(([key,value])=>key in PARTS&&value!=="hidden"&&value!=="whole"),`parts cut with the drawer ${drawer}px tall: `+JSON.stringify(hero)).toEqual([]);
      expect.soft(hero.title==="whole"||hero.room<60,`the title shows where there is room for it, drawer ${drawer}px: `+JSON.stringify(hero)).toBe(true);
      if(drawer===330)for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}drawer-330-${mode}-${width}x${height}.png`})}
      await switchMode(page,"dark");
    }
  }finally{await harness.close()}
});
