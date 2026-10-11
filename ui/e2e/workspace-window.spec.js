import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

// Diff lines whose text runs outside their own row, or whose row overlaps the next one: a wrapped line that keeps a one-line row
// paints its continuation over the lines under it.
function overprintedDiffLines(diff){
  return diff.evaluate(node=>[...node.querySelectorAll(".diff-line")].filter((line,index,lines)=>{
    const range=document.createRange();range.selectNodeContents(line);
    const text=range.getBoundingClientRect(),box=line.getBoundingClientRect(),next=lines[index+1]?.getBoundingClientRect();
    return text.height>0&&(text.bottom>box.bottom+1||Boolean(next&&next.top<box.bottom-1));
  }).length);
}

test("large workspace trees and diffs render bounded progressive windows",async({page,request})=>{
  test.setTimeout(35_000);
  // The light-mode check below reads the default theme's colors; settings persist between tests, so set that theme here.
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
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
  // Each file is a real hunk: its "-" and long "+" lines are deleted and added lines (a line before any @@ is a header line).
  const diff=Array.from({length:420},(_,index)=>"diff --git a/src/file-"+index+".js b/src/file-"+index+".js\n--- a/src/file-"+index+".js\n+++ b/src/file-"+index+".js\n@@ -1 +1 @@\n-old-content-"+index+"\n+"+"changed-content-".repeat(70)+"\n").join("");
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
  // The footer counts what is shown, in the words the diff footer uses ("characters shown").
  await expect(right.locator(".tree-list .workspace-window-footer span")).toHaveText("240 of 500 shown");
  await right.locator(".tree-list").evaluate(node=>{node.scrollTop=node.scrollHeight});
  await expect(right.getByRole("button",{name:"Show 120 more files"})).toBeVisible();
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-tree-windowing-dark-1280x800.png",fullPage:true});

  await right.getByRole("button",{name:"Diff",exact:true}).click();
  await expect(right.locator(".changed-file-row")).toHaveCount(80);
  await expect(right.getByRole("button",{name:"Show 80 more changed files"})).toBeVisible();
  await expect(right.locator(".changed-files .workspace-window-footer span")).toHaveText("80 of 220 shown");
  const diffPreview=right.getByTestId("workspace-diff-preview");
  await expect(diffPreview).toBeVisible();
  const firstLength=await diffPreview.evaluate(node=>node.textContent.length);
  expect(firstLength).toBeGreaterThan(100_000);
  expect(firstLength).toBeLessThanOrEqual(120_000);
  await expect(right.getByRole("button",{name:"Show more diff"})).toBeVisible();
  // Lines wrap by default, and each wrapped line takes the rows its text needs: none paints over the lines under it.
  await expect(diffPreview).toHaveClass(/\bwrap\b/);
  expect(await overprintedDiffLines(diffPreview)).toBe(0);

  await right.getByRole("button",{name:"Show 80 more changed files"}).click();
  await expect(right.locator(".changed-file-row")).toHaveCount(160);
  await expect(right.locator(".changed-files .workspace-window-footer span")).toHaveText("160 of 220 shown");
  await right.getByRole("button",{name:"Show more diff"}).click();
  await expect.poll(()=>diffPreview.evaluate(node=>node.textContent.length)).toBeGreaterThan(120_000);
  await expect(right.locator(".workspace-diff-preview .workspace-window-footer span")).toHaveText("240k of "+Math.round(diff.length/1000)+"k characters shown");
  expect(await overprintedDiffLines(diffPreview)).toBe(0);

  const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-windowing-dark-1280x800.png",fullPage:true});

  // Without wrapping each line keeps one row and the diff scrolls sideways instead.
  await right.getByRole("button",{name:"Disable diff line wrapping"}).click();
  await expect(diffPreview).not.toHaveClass(/\bwrap\b/);
  // The changed lines, long ones included, are one line tall each; the count guards against measuring no lines at all.
  const unwrapped=await diffPreview.evaluate(node=>{const heights=[...node.querySelectorAll(".diff-line:is(.add,.del)")].map(line=>line.getBoundingClientRect().height);return {client:node.clientWidth,scroll:node.scrollWidth,lines:heights.length,tallest:Math.max(0,...heights),lineHeight:parseFloat(getComputedStyle(node).lineHeight)}});
  expect(unwrapped.scroll).toBeGreaterThan(unwrapped.client);
  expect(unwrapped.lines).toBeGreaterThan(100);
  expect(unwrapped.tallest).toBeLessThanOrEqual(unwrapped.lineHeight+1);
  expect(await overprintedDiffLines(diffPreview)).toBe(0);
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-windowing-nowrap-dark-1280x800.png",fullPage:true});
  await right.getByRole("button",{name:"Enable diff line wrapping"}).click();
  await expect(diffPreview).toHaveClass(/\bwrap\b/);

  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  expect(await overprintedDiffLines(diffPreview)).toBe(0);
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-windowing-light-1280x800.png",fullPage:true});
  await right.locator(".workspace-panel .panel-tabs").getByRole("button",{name:"Files",exact:true}).click();
  await right.locator(".tree-list").evaluate(node=>{node.scrollTop=node.scrollHeight});
  const lightMore=right.getByRole("button",{name:"Show 120 more files"});
  await expect(lightMore).toBeVisible();
  expect(await lightMore.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-tree-windowing-light-1280x800.png",fullPage:true});
});

test("the Diff and Git lists name an untracked folder and label untracked paths apart from conflicts",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Workspace status labels"}});
  // git status --short: an untracked folder is reported as "name/", and "UU" is an unmerged (conflicted) path.
  const status=[["??","capture-output/"],["??","notes/todo.txt"],[" M","src/app.js"],["UU","src/merge.js"],["A ","src/new.js"],[" D","src/gone.js"]];
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/workspace/diff?**",route=>json(route,{cwd:boot.cwd,isGit:true,status:status.map(([code,path])=>code+" "+path).join("\n"),diff:"diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n",stderr:""}));
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:null,status:status.map(([code,path])=>({code,path})),worktrees:[{path:boot.cwd,branch:"main"}],remotes:[]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"",detectedProvider:"unknown",git:{version:"git version fixture"},providers:{},capabilities:{}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{items:[],capabilities:{}}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Workspace status labels"});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await page.setViewportSize({width:1280,height:800});
  await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Diff",exact:true}).click();
  await expect(right.locator(".changed-file-row")).toHaveCount(status.length);

  // The untracked folder shows its name in the name style, like its siblings, not as a muted folder hint with no name.
  const folder=right.locator(".changed-file-row").filter({hasText:"capture-output"});
  await expect(folder.locator(".changed-file-name")).toHaveText("capture-output/");
  await expect(folder.locator(".changed-file-dir")).toHaveCount(0);
  const nameStyle=locator=>locator.evaluate(node=>{const style=getComputedStyle(node);return style.fontSize+" "+style.color});
  expect(await nameStyle(folder.locator(".changed-file-name"))).toBe(await nameStyle(right.locator(".changed-file-row").filter({hasText:"app.js"}).locator(".changed-file-name")));
  await expect(right.locator(".changed-file-row").filter({hasText:"todo.txt"}).locator(".changed-file-name")).toHaveText("todo.txt");

  // One label per status in both lists: untracked is "N", never git's "??" nor the "U" of an unmerged path.
  const expected={"capture-output/":["N","added",/^Untracked/],"notes/todo.txt":["N","added",/^Untracked/],"src/merge.js":["UU","conflict",/^Conflict/],"src/app.js":["M","modified",/^Modified/],"src/new.js":["A","added",/^Added/],"src/gone.js":["D","deleted",/^Deleted/]};
  for(const [path,[label,kind,title]] of Object.entries(expected)){
    const badge=right.locator(".changed-file-row").filter({has:page.getByRole("button",{name:path,exact:true})}).locator(".changed-file-code");
    await expect(badge).toHaveText(label);await expect(badge).toHaveAttribute("data-kind",kind);await expect(badge).toHaveAttribute("title",title);
  }
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-status-labels-1280x800.png",fullPage:true});

  await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(status.length);
  for(const [path,[label,kind,title]] of Object.entries(expected)){
    const badge=right.locator(".status-list > div").filter({has:page.getByText(path,{exact:true})}).locator("code");
    await expect(badge).toHaveText(label);await expect(badge).toHaveAttribute("data-state",kind);await expect(badge).toHaveAttribute("title",title);
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-status-labels-light-1280x800.png",fullPage:true});
});
