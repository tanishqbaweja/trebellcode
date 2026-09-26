import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

test("large workspace trees and diffs render bounded progressive windows",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Workspace stress"}});

  const root=String(boot.cwd||"C:/fixture").replaceAll("\\","/");
  const entries=Array.from({length:500},(_,index)=>({
    name:"file-"+String(index).padStart(3,"0")+".js",
    path:root+"/src/file-"+String(index).padStart(3,"0")+".js",
    relativePath:"src/file-"+String(index).padStart(3,"0")+".js",
    isDirectory:false,isFile:true,depth:0,
  }));
  const changed=Array.from({length:220},(_,index)=>" M src/file-"+String(index).padStart(3,"0")+".js").join("\n");
  const diff=Array.from({length:420},(_,index)=>"diff --git a/src/file-"+index+".js b/src/file-"+index+".js\n"+"+"+"changed-content-".repeat(70)+"\n").join("");
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/workspace/tree?**",route=>json(route,{root,entries,truncated:true}));
  await page.route("**/api/workspace/diff?**",route=>json(route,{cwd:root,isGit:true,status:changed,diff,stderr:""}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Workspace stress"});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();

  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await page.setViewportSize({width:1280,height:800});
  await right.getByRole("button",{name:"Files",exact:true}).click();
  await expect(right.locator("[data-workspace-entry]")).toHaveCount(120);
  await expect(right.getByRole("button",{name:"Show 120 more files"})).toBeVisible();
  await right.getByRole("button",{name:"Show 120 more files"}).click();
  await expect(right.locator("[data-workspace-entry]")).toHaveCount(240);
  await right.locator(".tree-list").evaluate(node=>{node.scrollTop=node.scrollHeight});
  await expect(right.getByRole("button",{name:"Show 120 more files"})).toBeVisible();
  await page.screenshot({path:auditDir+"workspace-tree-windowing-dark-1280x800.png",fullPage:true});

  await right.getByRole("button",{name:"Diff",exact:true}).click();
  await expect(right.locator(".changed-file-row")).toHaveCount(80);
  await expect(right.getByRole("button",{name:"Show 80 more changed files"})).toBeVisible();
  const diffPreview=right.getByTestId("workspace-diff-preview");
  await expect(diffPreview).toBeVisible();
  const firstLength=await diffPreview.evaluate(node=>node.textContent.length);
  expect(firstLength).toBeGreaterThan(100_000);
  expect(firstLength).toBeLessThanOrEqual(120_000);
  await expect(right.getByRole("button",{name:"Show more diff"})).toBeVisible();

  await right.getByRole("button",{name:"Show 80 more changed files"}).click();
  await expect(right.locator(".changed-file-row")).toHaveCount(160);
  await right.getByRole("button",{name:"Show more diff"}).click();
  await expect.poll(()=>diffPreview.evaluate(node=>node.textContent.length)).toBeGreaterThan(120_000);

  const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"workspace-windowing-dark-1280x800.png",fullPage:true});

  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await right.locator(".workspace-panel .panel-tabs").getByRole("button",{name:"Files",exact:true}).click();
  await right.locator(".tree-list").evaluate(node=>{node.scrollTop=node.scrollHeight});
  const lightMore=right.getByRole("button",{name:"Show 120 more files"});
  await expect(lightMore).toBeVisible();
  expect(await lightMore.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.screenshot({path:auditDir+"workspace-tree-windowing-light-1280x800.png",fullPage:true});
});
