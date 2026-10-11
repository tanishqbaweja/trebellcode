import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Settings › View licenses, met the way a person meets it: a slow or failed list says so (and Retry asks again) instead of
// claiming no package matched, the notice pane only ever shows the row picked last, every package name reads in full
// however narrow the list gets, and the light search field is one even box. Screenshots: visual-audit/polish/licenses/.
const shots=fileURLToPath(new URL("../../visual-audit/polish/licenses/",import.meta.url));mkdirSync(shots,{recursive:true});
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const BASE={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"};
const MODES=["dark","light"];

// Real names from the installed list, including the long ones that used to be cut and every dependency kind.
const PACKAGES=[
  ["@anthropic-ai/claude-agent-sdk","0.3.276","SEE LICENSE IN README.md","Runtime dependency"],
  ["@anthropic-ai/claude-agent-sdk-win32-x64","0.3.276","SEE LICENSE IN LICENSE.md","Transitive dependency"],
  ["@anthropic-ai/sdk","0.127.0","MIT","Transitive dependency"],
  ["@babel/helper-compilation-targets","7.29.7","MIT","Transitive dependency"],
  ["@babel/helper-module-transforms","7.29.7","MIT","Transitive dependency"],
  ["@esbuild/win32-x64","0.25.10","MIT","Optional runtime dependency"],
  ["react","19.1.1","MIT","Runtime dependency"],
].map(([name,version,license,component])=>({id:`${name}@${version}`,name,version,license,component,homepage:"https://www.npmjs.com/package/"+name}));
const LIST={items:PACKAGES,total:PACKAGES.length,filtered:PACKAGES.length};
const noticeOf=item=>({...item,text:`Notice of ${item.name} ${item.version}\n\nMIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.`});

async function open(page,request,{mode="dark",width=1280,height=800}={}){
  await page.setViewportSize({width,height});
  await request.post("/api/settings",{data:{...BASE,appearanceMode:mode}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Licenses Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.dataset.mode)).toBe(mode);
}
async function openLicenses(page){
  await nav(page,"Settings").click();
  await page.getByRole("button",{name:"View licenses"}).click();
  await expect(page.getByRole("heading",{name:"Open source licenses",level:1})).toBeVisible();
  await expect(page.locator(".licenses-page")).toBeVisible();
}
const count=page=>page.locator(".licenses-toolbar>span");
const rows=page=>page.locator(".licenses-list>button");
const sideways=page=>page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
test.afterEach(async({request})=>{await request.post("/api/settings",{data:BASE})});

for(const mode of MODES){
  test(`a late notice for the row picked first does not replace the row picked after it (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await page.route(/\/api\/licenses$/,route=>json(route,LIST));
    let lateSent;const late=new Promise(resolve=>lateSent=resolve);
    await page.route(/\/api\/licenses\/detail\?/,async route=>{
      const item=PACKAGES.find(entry=>entry.id===new URL(route.request().url()).searchParams.get("id"));
      if(item===PACKAGES[0]){await new Promise(resolve=>setTimeout(resolve,1200));await json(route,noticeOf(item));lateSent();return}
      return json(route,noticeOf(item));
    });
    await openLicenses(page);
    const [first,second]=[rows(page).nth(0),rows(page).nth(1)];
    const pane=page.locator(".license-detail"),head=pane.locator(".license-detail-head strong"),text=pane.locator("pre");
    await first.click();
    await second.click();
    await expect(text).toHaveText(noticeOf(PACKAGES[1]).text);
    await late;
    await page.waitForTimeout(400);
    await expect(second).toHaveClass(/active/);
    await expect(first).not.toHaveClass(/active/);
    await expect(head,"the late answer for the first row took over the pane").toHaveText(PACKAGES[1].name);
    await expect(text).toHaveText(noticeOf(PACKAGES[1]).text);
    await page.screenshot({animations:"disabled",path:shots+`notice-race-${mode}-1280.png`});
    // While a notice is on the way the pane already names the package picked, rather than "Select a package"...
    let release;const held=new Promise(resolve=>release=resolve);
    await page.unroute(/\/api\/licenses\/detail\?/);
    await page.route(/\/api\/licenses\/detail\?/,async route=>{await held;return json(route,noticeOf(PACKAGES[2]))});
    await rows(page).nth(2).click();
    await expect(head).toHaveText(PACKAGES[2].name);
    await expect(pane.getByRole("status")).toHaveText("Loading the notice…");
    await expect(pane).not.toContainText("Select a package");
    await page.screenshot({animations:"disabled",path:shots+`notice-loading-${mode}-1280.png`});
    // ...and an answer that comes after the pane was closed does not reopen it.
    await pane.getByRole("button",{name:"Close license"}).click();
    release();
    await page.waitForTimeout(400);
    await expect(pane).toContainText("Select a package");
    await expect(rows(page).nth(2)).not.toHaveClass(/active/);
  });

  test(`a notice that fails to load says so in the pane (${mode})`,async({page,request})=>{
    await open(page,request,{mode});
    await page.route(/\/api\/licenses$/,route=>json(route,LIST));
    await page.route(/\/api\/licenses\/detail\?/,route=>json(route,{error:"License entry was not found"},404));
    await openLicenses(page);
    await rows(page).nth(3).click();
    const pane=page.locator(".license-detail");
    await expect(pane.locator(".license-detail-head strong")).toHaveText(PACKAGES[3].name);
    await expect(pane.getByRole("alert")).toHaveText("Could not load this notice: License entry was not found");
    await expect(pane).not.toContainText("Select a package");
    await page.screenshot({animations:"disabled",path:shots+`notice-failed-${mode}-1280.png`});
  });
}
