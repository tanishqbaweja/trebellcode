import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

// A user can drag the sidebar anywhere in 210-420px (layout-preferences.js). At every one of those widths each secondary
// destination shows its whole name, or the row turns into icons (236px and below): a half-width cell too narrow for
// "Environments" must give way to one column instead of cutting the name to "Environme…".
test("sidebar destination names are never cut at any sidebar width",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  const names=page.locator(".sidebar-nav-secondary .sidebar-utility>span");
  await expect(names.filter({hasText:"Environments"})).toBeVisible();
  // Each cut name with the sidebar widths it is cut at, as ranges ("Environments at 237-261px").
  const cut=await page.evaluate(()=>{
    const shell=document.querySelector(".app-shell"),widths=new Map();
    for(let width=210;width<=420;width++){
      shell.style.setProperty("--sidebar-width",width+"px");
      for(const name of document.querySelectorAll(".sidebar-nav-secondary .sidebar-utility>span")){
        if(name.offsetParent&&name.scrollWidth>name.clientWidth)widths.set(name.textContent,[...(widths.get(name.textContent)||[]),width]);
      }
    }
    shell.style.setProperty("--sidebar-width","258px");
    return [...widths].map(([name,list])=>name+" at "+list.reduce((ranges,width)=>{
      const last=ranges.at(-1);if(last&&last[1]===width-1)last[1]=width;else ranges.push([width,width]);return ranges;
    },[]).map(([from,to])=>from===to?from+"px":from+"-"+to+"px").join(", "));
  });
  expect(cut).toEqual([]);
  await page.setViewportSize({width:1280,height:800});
  await page.locator(".sidebar").screenshot({animations:"disabled",path:auditDir+"sidebar-destinations-258px-1280x800.png"});
});

// With Codex there are six secondary destinations (Browser, Agents, History, Usage, Tools, Environments). Wherever their names
// give way to icons (a sidebar of 236px or less: the 196px one of a window 900px wide or less, the 224px one up to 1120px, one
// dragged that narrow; and any sidebar in a window under 720px tall) the icons are one row, so Environments is not left alone on
// a second row under the others.
test("with Codex the destination icons stay one row in a 900px window and wherever the names give way to icons",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.setViewportSize({width:900,height:800});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  const nav=page.getByRole("navigation",{name:"Destinations"}),icons=nav.locator(".sidebar-nav-secondary>button");
  await expect(icons).toHaveCount(6);
  // The icons as the rows they sit in, top to bottom, each by its name, marked when the sidebar's edge cuts it.
  const rows=()=>icons.evaluateAll(buttons=>{
    const edge=buttons[0].parentElement.getBoundingClientRect().right,rows=new Map();
    for(const button of buttons){const box=button.getBoundingClientRect(),top=Math.round(box.top);rows.set(top,[...(rows.get(top)||[]),button.getAttribute("aria-label")+(box.right>edge+1?" (cut)":"")])}
    return [...rows.values()];
  });
  const oneRow=[["Browser","Agents","History","Usage","Tools","Environments"]];
  await expect.poll(rows,{message:"the icons in the 196px sidebar of a 900px window"}).toEqual(oneRow);
  await page.locator(".sidebar").screenshot({animations:"disabled",path:auditDir+"sidebar-destinations-codex-icons-900x800.png"});
  // Environments opens from that row.
  const environments=nav.getByRole("button",{name:"Environments",exact:true});
  await environments.click();
  await expect(environments).toHaveAttribute("aria-current","page");
  await page.setViewportSize({width:1000,height:800});
  await expect.poll(rows,{message:"the icons in the 224px sidebar of a 1000px window"}).toEqual(oneRow);
  // At 1280 the names show until the person drags the sidebar as narrow as it goes.
  await page.setViewportSize({width:1280,height:800});
  await expect.poll(rows,{message:"the names in the 258px sidebar"}).not.toEqual(oneRow);
  let handle=await page.getByTestId("sidebar-resizer").boundingBox();
  await page.mouse.move(handle.x+3,handle.y+200);await page.mouse.down();await page.mouse.move(handle.x-57,handle.y+200,{steps:5});await page.mouse.up();
  await expect.poll(async()=>Math.round((await page.locator(".sidebar").boundingBox()).width)).toBe(210);
  await expect.poll(rows,{message:"the icons in a sidebar dragged to 210px"}).toEqual(oneRow);
  await page.locator(".sidebar").screenshot({animations:"disabled",path:auditDir+"sidebar-destinations-codex-icons-210px-1280x800.png"});
  // Dragged wide again, a window under 720px tall still shows them as one row of icons.
  handle=await page.getByTestId("sidebar-resizer").boundingBox();
  await page.mouse.move(handle.x+3,handle.y+200);await page.mouse.down();await page.mouse.move(handle.x+93,handle.y+200,{steps:5});await page.mouse.up();
  await page.setViewportSize({width:1280,height:700});
  await expect.poll(rows,{message:"the icons in a 1280x700 window"}).toEqual(oneRow);
});
