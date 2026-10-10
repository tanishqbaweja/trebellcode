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
