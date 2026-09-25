import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

test("large source control collections mount bounded windows",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control stress"}});

  const status=Array.from({length:200},(_,index)=>({code:" M",path:"src/generated/file-"+String(index).padStart(3,"0")+".js"}));
  const prs=Array.from({length:150},(_,index)=>({
    provider:"github",number:index+1,title:"Stress PR "+String(index+1).padStart(3,"0"),state:"OPEN",
    url:"https://example.test/pr/"+(index+1),headRefName:"feature-"+(index+1),baseRefName:"main",
  }));
  const files=Array.from({length:180},(_,index)=>({
    path:"src/changed/file-"+String(index).padStart(3,"0")+".js",additions:index+1,deletions:index%7,patch:"+ fixture",
  }));
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status,worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://example.test/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:prs}));
  await page.route("**/api/source-control/pr-detail?**",route=>{
    const number=Number(new URL(route.request().url()).searchParams.get("number"))||1;
    const pr=prs.find(item=>item.number===number)||prs[0];
    return json(route,{provider:"github",item:{...pr,body:"Large deterministic pull request fixture.",comments:[],reviews:[],files,statusCheckRollup:[]}});
  });
  await page.route("**/api/source-control/pr-viewed?**",route=>json(route,{provider:"github",store:"host",files:[]}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control stress"});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();

  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await right.getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(60);
  await expect(right.locator(".pr-list > button")).toHaveCount(60);
  await expect(right.getByRole("button",{name:"Show 60 more changes"})).toBeVisible();
  await expect(right.getByRole("button",{name:"Show 60 more PRs"})).toBeVisible();

  await right.getByRole("button",{name:"Show 60 more changes"}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(120);
  await right.getByRole("button",{name:"Show 60 more PRs"}).click();
  await expect(right.locator(".pr-list > button")).toHaveCount(120);

  await right.getByRole("button",{name:/#1 Stress PR 001/}).click();
  await expect(right.locator(".pr-file")).toHaveCount(60);
  await expect(right.getByRole("button",{name:"Show 60 more files"})).toBeVisible();
  await right.getByRole("button",{name:"Show 60 more files"}).click();
  await expect(right.locator(".pr-file")).toHaveCount(120);

  await page.setViewportSize({width:1280,height:800});
  await right.scrollIntoViewIfNeeded();
  const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-windowing-dark-1280x800.png",fullPage:true});
});
