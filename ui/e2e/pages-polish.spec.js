import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

// The secondary pages met the way a person meets them: every Usage control has a name and shows where focus is, a long
// History title or delegated-agent name can be read in full without breaking the rows' columns, a focused History row
// shows its whole ring, and small labels and helper lines read at 4.5:1 in dark and light. Screenshots:
// visual-audit/polish/pages-polish/.
const shots=fileURLToPath(new URL("../../visual-audit/polish/pages-polish/",import.meta.url));mkdirSync(shots,{recursive:true});
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"};
const MODES=["dark","light"];
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function open(page,request,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Polish Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.dataset.mode)).toBe(mode);
}
test.afterEach(async({request})=>{await request.post("/api/settings",{data:BASE})});

async function tabTo(page,target,limit=20){
  for(let i=0;i<limit;i++){
    await page.keyboard.press("Tab");
    if(await target.evaluate(element=>element===document.activeElement))return;
  }
  throw new Error("Tab never reached the element");
}
const around=(box,pad)=>({x:Math.max(0,Math.floor(box.x-pad)),y:Math.max(0,Math.floor(box.y-pad)),width:Math.ceil(box.width+pad*2),height:Math.ceil(box.height+pad*2)});

// How much of each edge of a box changed between two screenshots of the same clip (before and after it took focus): a
// focus ring that shows all round changes about all of every edge, one covered by a neighbour leaves that edge unchanged.
// The PNGs are decoded in a blank page so the app page is left alone.
async function ringEdges(page,clip,box,before,after){
  const decoder=await page.context().newPage();
  try{
    return await decoder.evaluate(async({before,after,clip,box})=>{
      const pixels=async source=>{const image=new Image();image.src="data:image/png;base64,"+source;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext("2d");context.drawImage(image,0,0);return context.getImageData(0,0,image.width,image.height)};
      const a=await pixels(before),b=await pixels(after);
      const changed=(x,y)=>{if(x<0||y<0||x>=a.width||y>=a.height)return false;const i=(y*a.width+x)*4;return Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>36};
      const left=Math.round(box.x-clip.x),top=Math.round(box.y-clip.y),right=Math.round(box.x+box.width-clip.x)-1,bottom=Math.round(box.y+box.height-clip.y)-1;
      const band=4,corner=12;
      const share=(from,to,hit)=>{let hits=0,total=0;for(let p=from;p<=to;p++){total++;if(hit(p))hits++}return total?Math.round(hits/total*100)/100:0};
      const across=(y,x)=>{for(let d=-band;d<=band;d++)if(changed(x,y+d))return true;return false};
      const down=(x,y)=>{for(let d=-band;d<=band;d++)if(changed(x+d,y))return true;return false};
      return {
        top:share(left+corner,right-corner,x=>across(top,x)),
        bottom:share(left+corner,right-corner,x=>across(bottom,x)),
        left:share(top+corner,bottom-corner,y=>down(left,y)),
        right:share(top+corner,bottom-corner,y=>down(right,y)),
      };
    },{before:before.toString("base64"),after:after.toString("base64"),clip,box});
  }finally{await decoder.close()}
}
// Clicks a spot that is not a control (focus then starts there), screenshots the element, Tabs to it and screenshots it
// again: the share of each edge the focus ring covers.
async function focusRingByTab(page,target,startAt){
  await startAt.click();
  const box=await target.boundingBox();const clip=around(box,8);
  const before=await page.screenshot({animations:"disabled",clip});
  await tabTo(page,target);
  expect(await target.evaluate(element=>element.matches(":focus-visible")),"the element took keyboard focus").toBe(true);
  const after=await page.screenshot({animations:"disabled",clip});
  return ringEdges(page,clip,box,before,after);
}

// ============ Usage ============
test("the Usage period picker is named, so a screen reader says what it picks",async({page,request})=>{
  await open(page,request);
  await nav(page,"Usage").click();
  const period=page.getByRole("combobox",{name:"Period",exact:true});
  await expect(period).toBeVisible();
  await expect(period).toHaveValue("30");
  await period.selectOption("7");
  await expect(period).toHaveValue("7");
  await expect(page.locator(".usage-grid .capability-card-head em").first()).toHaveText("7d");
});

for(const mode of MODES){
  test(`Tab to the Usage environment filter shows a ring all round it, like the period picker beside it (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await nav(page,"Usage").click();
    const filter=page.locator(".usage-environment-filter>summary");
    await expect(filter).toHaveText("All environments");
    const edges=await focusRingByTab(page,filter,page.getByRole("heading",{name:"Usage",level:2}));
    await page.screenshot({animations:"disabled",path:shots+`usage-filter-focus-${mode}-1280.png`});
    console.log("USAGE-FILTER-RING "+mode+" "+JSON.stringify(edges));
    for(const [edge,share] of Object.entries(edges))expect(share,`the ${edge} edge of the focused filter shows the ring`).toBeGreaterThan(.9);
    // The period picker's keyboard focus looks the same.
    const period=page.locator(".usage-toolbar select");
    await page.keyboard.press("Tab");
    await expect(period).toBeFocused();
    const look=element=>{for(const animation of element.getAnimations())animation.finish();const style=getComputedStyle(element);return {shadow:style.boxShadow,border:style.borderTopColor}};
    const periodLook=await period.evaluate(look);
    await page.keyboard.press("Shift+Tab");
    await expect(filter).toBeFocused();
    await expect.poll(()=>filter.evaluate(look)).toEqual(periodLook);
    // Enter opens the menu, and Enter again closes it with focus still on the filter.
    await page.keyboard.press("Enter");
    await expect(page.locator(".usage-environment-filter")).toHaveAttribute("open","");
    await page.keyboard.press("Enter");
    await expect(page.locator(".usage-environment-filter")).not.toHaveAttribute("open","");
    await expect(filter).toBeFocused();
    await page.setViewportSize({width:900,height:800});
    await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(filter).toBeFocused();
    await page.screenshot({animations:"disabled",path:shots+`usage-filter-focus-${mode}-900.png`});
  });
}

