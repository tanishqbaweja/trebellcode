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
  // git status --short: an untracked folder is reported as "name/", and "UU" is an unmerged (conflicted) path. A path with a space or
  // a non-ASCII letter is C-quoted, with the letter's UTF-8 bytes in octal, and each side of a rename is quoted on its own.
  const quoted=[["??",'"New folder/"'],["??",'"docs/my notes.txt"'],[" M",'"src/caf\\303\\251 menu.js"'],["R ",'"old name.txt" -> "new name.txt"']];
  const status=[["??","capture-output/"],["??","notes/todo.txt"],[" M","src/app.js"],["UU","src/merge.js"],["A ","src/new.js"],[" D","src/gone.js"],...quoted];
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
  // Quoted paths read as their names: no quote marks, and the folder, file and rename split like any other path.
  const row=path=>right.locator(".changed-file-row").filter({has:page.getByRole("button",{name:path,exact:true})});
  for(const [path,name,dir] of [["New folder/","New folder/",null],["docs/my notes.txt","my notes.txt","docs"],["src/café menu.js","café menu.js","src"],["old name.txt -> new name.txt","old name.txt -> new name.txt",null]]){
    await expect(row(path).locator(".changed-file-name")).toHaveText(name);
    if(dir)await expect(row(path).locator(".changed-file-dir")).toHaveText(dir);else await expect(row(path).locator(".changed-file-dir")).toHaveCount(0);
  }
  expect(await nameStyle(row("New folder/").locator(".changed-file-name"))).toBe(await nameStyle(row("src/app.js").locator(".changed-file-name")));
  await expect(right.locator(".changed-files")).not.toContainText('"');

  // One label per status in both lists: untracked is "N", never git's "??" nor the "U" of an unmerged path.
  const expected={"capture-output/":["N","added",/^Untracked/],"notes/todo.txt":["N","added",/^Untracked/],"src/merge.js":["UU","conflict",/^Conflict/],"src/app.js":["M","modified",/^Modified/],"src/new.js":["A","added",/^Added/],"src/gone.js":["D","deleted",/^Deleted/],
    "New folder/":["N","added",/^Untracked/],"docs/my notes.txt":["N","added",/^Untracked/],"src/café menu.js":["M","modified",/^Modified/],"old name.txt -> new name.txt":["R","renamed",/^Renamed/]};
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
  await expect(right.locator(".status-list")).not.toContainText('"');
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-status-labels-light-1280x800.png",fullPage:true});
});

test("the Files viewer colours code with its own language's grammar and shows prose as plain text",async({page,request})=>{
  test.setTimeout(45_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Workspace syntax"}});
  // Each code file lists tokens its grammar finds ([class, text]); prose, logs and a licence have none. In Python "//" is floor
  // division, which the JavaScript grammar read as a comment.
  const files=[
    ["main.go","package main\n\nimport \"fmt\"\n\n// Entry point\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(\"hello\", i)\n\t}\n}\n",[["comment","// Entry point"],["string","\"fmt\""],["keyword","import"],["keyword","func"]]],
    ["tool.py","def halve(total):\n    # integer half\n    return total // 2\n",[["comment","# integer half"],["keyword","def"],["operator","//"]]],
    ["Main.java","public class Main {\n  // entry\n  public static void main(String[] args) { System.out.println(\"hi\"); }\n}\n",[["comment","// entry"],["keyword","class"],["string","\"hi\""]]],
    ["module.mts","export const n: number = 1; // typed\n",[["keyword","export"],["comment","// typed"]]],
    ["legacy.cts","const fs = require(\"fs\");\n",[["keyword","const"],["string","\"fs\""]]],
    ["tsconfig.jsonc","{\n  // strict mode\n  \"strict\": true\n}\n",[["comment","// strict mode"],["boolean","true"]]],
    ["theme.less","@accent: #f00;\n.a { color: @accent; }\n",[["selector",".a"],["property","color"]]],
    ["Dockerfile","FROM node:20\n# deps\nRUN npm ci\n",[["keyword","FROM"],["comment","# deps"]]],
    ["build.sh","#!/bin/sh\n# build it\nif [ -f out ]; then echo built; fi\n",[["comment","# build it"],["keyword","if"]]],
    ["config.yaml","name: trebell # app\nport: 8080\n",[["key","name"],["comment","# app"]]],
    ["main.rs","fn main() {\n    let x = 1; // rust\n}\n",[["keyword","fn"],["comment","// rust"]]],
    ["lib.c","#include <stdio.h>\nint main(void) { return 0; }\n",[["keyword","int"],["string","<stdio.h>"]]],
    ["notes.txt","keep this file\nif (this) return <b>x</b>; // not code\n",[]],
    ["server.log","INFO started in 3ms // ok\n",[]],
    ["LICENSE","MIT License\nCopyright (c) 2026\n",[]],
  ];
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/workspace/tree?**",route=>json(route,{root:boot.cwd,entries:files.map(([name])=>({name,path:name,relativePath:name,isFile:true,isDirectory:false,depth:0})),truncated:false}));
  await page.route("**/api/workspace/file?**",route=>{const name=new URL(route.request().url()).searchParams.get("path");return json(route,{name,path:name,content:files.find(file=>file[0]===name)[1]})});

  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Workspace syntax"});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Files",exact:true}).click();
  for(const [name,content,expected] of files){
    await right.locator("[data-workspace-entry]").filter({has:page.getByText(name,{exact:true})}).click();
    await expect(right.locator(".file-head strong")).toHaveText(name);
    const code=right.locator(".syntax-view code");
    expect(await code.evaluate(node=>node.textContent)).toBe(content);
    const tokens=await code.evaluate(node=>[...node.querySelectorAll(".token")].map(token=>({classes:[...token.classList],text:token.textContent})));
    if(!expected.length)expect(tokens,name).toEqual([]);
    for(const [kind,text] of expected)expect(tokens.some(token=>token.classes.includes(kind)&&token.text===text),`${name}: a ${kind} token "${text}"`).toBe(true);
    if(name==="main.go")await page.screenshot({animations:"disabled",path:auditDir+"workspace-syntax-go-dark-1280x800.png"});
    if(name==="tool.py"){
      await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
      await page.screenshot({animations:"disabled",path:auditDir+"workspace-syntax-python-light-1280x800.png"});
      await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    }
    if(name==="notes.txt")await page.screenshot({animations:"disabled",path:auditDir+"workspace-syntax-plain-text-dark-1280x800.png"});
  }
});

// Opens a project registered under `name` and the inspector beside it.
async function openProjectInspector(page,request,name){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name}});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:name});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  return {boot,right,top:right.locator(".context-panel-tab-scroll"),inner:right.locator(".workspace-panel .panel-tabs")};
}

test("the Diff tab says it is loading until the working tree answers, and the inspector tabs and the Files | Changes switch agree",async({page,request})=>{
  test.setTimeout(45_000);
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/workspace/tree?**",route=>json(route,{entries:["app.js","notes.txt","readme.md"].map(name=>({name,path:name,relativePath:name,isFile:true,isDirectory:false,depth:0})),truncated:false}));
  await page.route("**/api/workspace/file?**",route=>{const path=new URL(route.request().url()).searchParams.get("path");return json(route,{name:path,path,content:"// "+path+"\n"})});
  // Every diff read waits until the test answers it, so the panel can be read while the working tree is still being read.
  const held=[];
  await page.route("**/api/workspace/diff?**",route=>{held.push(route)});
  const answer=async(value,status=200)=>{await expect.poll(()=>held.length).toBeGreaterThan(0);for(const route of held.splice(0))await json(route,value,status)};
  const dirty={isGit:true,status:" M src/app.js\n?? notes.txt",diff:"diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n",stderr:""};
  await page.setViewportSize({width:1280,height:800});
  const {right,top,inner}=await openProjectInspector(page,request,"Workspace diff loading");
  const changesButton=inner.getByRole("button",{name:/^Changes/}),filesButton=inner.getByRole("button",{name:"Files",exact:true});
  const diffTab=top.getByRole("button",{name:"Diff",exact:true}),filesTab=top.getByRole("button",{name:"Files",exact:true});
  await diffTab.click();

  // Nothing has answered: the Diff tab says it is loading, never that the tree is clean, and the switch counts nothing yet.
  const loading=right.locator(".changes-loading");
  await expect(loading).toHaveText("Loading changes…");
  await expect(loading).toHaveAttribute("aria-busy","true");
  await expect(right.getByText("Working tree clean")).toHaveCount(0);
  await expect(right.locator(".changes-empty")).toHaveCount(0);
  await expect(changesButton).toHaveText("Changes");
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-loading-dark-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-loading-light-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

  // A failed read is an error, not a clean tree, and a retry reads as loading again until it answers.
  await answer({error:"Deliberate working tree read failure"},500);
  const failed=right.locator(".changes-empty.error");
  await expect(failed).toContainText("Could not load changes");
  await expect(failed).toContainText("Deliberate working tree read failure");
  await right.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  await expect(loading).toBeVisible();
  await expect(right.getByText("Working tree clean")).toHaveCount(0);
  await answer(dirty);
  await expect(right.locator(".changed-file-row")).toHaveCount(2);
  await expect(changesButton).toHaveText("Changes (2)");

  // The tabs above and the switch inside are one choice: each follows the other, and switching keeps the panel as it was.
  const panel=await right.locator(".workspace-panel").elementHandle();
  await expect(diffTab).toHaveClass(/active/);await expect(changesButton).toHaveClass(/active/);
  await filesButton.click();
  await expect(filesTab).toHaveClass(/active/);await expect(diffTab).not.toHaveClass(/active/);await expect(filesButton).toHaveClass(/active/);
  await right.locator("[data-workspace-entry]").filter({hasText:"notes.txt"}).click();
  await expect(right.locator(".file-head strong")).toHaveText("notes.txt");
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-tabs-agree-files-dark-1280x800.png",fullPage:true});
  // Opening Changes from the tabs above reads the working tree again; the last answer stays on screen until the new one lands.
  await diffTab.click();
  await expect(changesButton).toHaveClass(/active/);await expect(filesButton).not.toHaveClass(/active/);
  await expect.poll(()=>held.length).toBe(1);
  await expect(right.locator(".changed-file-row")).toHaveCount(2);
  await answer({isGit:true,status:"",diff:"",stderr:""});
  await expect(right.locator(".changes-empty")).toContainText("Working tree clean");
  await expect(changesButton).toHaveText("Changes");
  // Back to Files from above: the file is still open, in the same panel.
  await filesTab.click();
  await expect(filesButton).toHaveClass(/active/);
  await expect(right.locator(".file-head strong")).toHaveText("notes.txt");
  expect(await panel.evaluate(node=>node.isConnected)).toBe(true);
  // The switch inside opens Changes and reads the tree again, and the tab above follows.
  await changesButton.click();
  await expect(diffTab).toHaveClass(/active/);await expect(filesTab).not.toHaveClass(/active/);
  await answer(dirty);
  await expect(right.locator(".changed-file-row")).toHaveCount(2);
  expect(await panel.evaluate(node=>node.isConnected)).toBe(true);
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-tabs-agree-changes-light-1280x800.png",fullPage:true});
});

test("a general chat keeps its Files view, with no Changes switch beside the disabled Diff tab",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/workspace/tree?**",route=>json(route,{entries:[{name:"scratch.md",path:"scratch.md",relativePath:"scratch.md",isFile:true,isDirectory:false,depth:0}],truncated:false}));
  await page.route("**/api/workspace/file?**",route=>json(route,{name:"scratch.md",path:"scratch.md",content:"# Scratch\n"}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".general-chat-card").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel"),top=right.locator(".context-panel-tab-scroll"),inner=right.locator(".workspace-panel .panel-tabs");
  await top.getByRole("button",{name:"Files",exact:true}).click();
  await expect(top.getByRole("button",{name:"Files",exact:true})).toHaveClass(/active/);
  await expect(top.getByRole("button",{name:"Diff",exact:true})).toBeDisabled();
  await expect(inner.locator(".workspace-seg button")).toHaveText(["Files"]);
  await expect(inner.getByRole("button",{name:"Files",exact:true})).toHaveClass(/active/);
  await right.locator("[data-workspace-entry]").filter({hasText:"scratch.md"}).click();
  await expect(right.locator(".file-head strong")).toHaveText("scratch.md");
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-general-chat-files-1280x800.png",fullPage:true});
});

// The text a reader sees in each changed file's name, left to right: the characters drawn inside every clipping box, "…" where an
// ellipsis stands (after the last character kept, or before the first in a right-to-left box), "▒" for a character drawn only in
// part, and a space wherever a visible gap parts two drawn pieces.
function drawnChangedNames(right){
  return right.locator(".changed-file-row .changed-file-name").evaluateAll(names=>names.map(element=>{
    const canvas=document.createElement("canvas").getContext("2d"),row=element.closest(".changed-file-row"),pieces=[];
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      let box=node.parentElement;while(box!==element&&getComputedStyle(box).overflowX==="visible")box=box.parentElement;
      const style=getComputedStyle(box),own=box.getBoundingClientRect();let clip={left:own.left,right:own.right};
      for(let outer=box.parentElement;outer&&outer!==row;outer=outer.parentElement)if(getComputedStyle(outer).overflowX!=="visible"){const rect=outer.getBoundingClientRect();clip={left:Math.max(clip.left,rect.left),right:Math.min(clip.right,rect.right)}}
      const ellipsis=box.scrollWidth>box.clientWidth&&style.textOverflow==="ellipsis",rtl=style.direction==="rtl";
      canvas.font=style.font;const mark=ellipsis?canvas.measureText("…").width:0;
      const from=ellipsis&&rtl?own.left+mark:clip.left,to=ellipsis&&!rtl?Math.min(clip.right,own.right-mark):clip.right,shown=[];
      for(let index=0;index<node.length;index++){
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);const rect=range.getBoundingClientRect();
        if(rect.left>=from-0.5&&rect.right<=to+0.5)shown.push({text:node.data[index],left:rect.left,right:rect.right});
        else if(!ellipsis&&rect.right>clip.left+0.5&&rect.left<clip.right-0.5)shown.push({text:"▒",left:rect.left,right:rect.right});
      }
      // An ellipsis never replaces the first character of its line: a box too narrow for both shows that character clipped.
      if(ellipsis&&!shown.length)shown.push({text:"▒",left:own.left,right:own.left});
      if(ellipsis&&rtl){const first=Math.min(...shown.map(piece=>piece.left));pieces.push({text:"…",left:first-mark,right:first})}
      if(ellipsis&&!rtl){const last=Math.max(...shown.map(piece=>piece.right));pieces.push({text:"…",left:last,right:last+mark})}
      pieces.push(...shown);
    }
    let text="",edge=null;
    for(const piece of pieces.sort((a,b)=>a.left-b.left)){if(edge!==null&&piece.left-edge>2)text+=" ";text+=piece.text;edge=piece.right}
    return text;
  }));
}

test("changed files too long for the Diff list keep the end that tells them apart in view",async({page,request})=>{
  test.setTimeout(45_000);
  // This checkout's untracked files as they stood when the list cut them all to "artifact_179…", beside long names that share their
  // start or their end.
  const status=[["??","artifact_1791317470236_d6b22939.png"],["??","artifact_1791317477991_ae1a8b66.png"],["??","artifact_1791317484338_7c659e6b.png"],["??","artifact_1791317494127_7b87f9be.png"],
    ["??","capcut-network-capture/"],["??","goal.md"],["??","google_startups_window.png"],[" M","ui/src/tool-activity.js"],["??","ui/src/tool-activity-summary.js"],[" M","tests/ui-tool-activity.test.mjs"],
    [" M","src/native-agent-session-recovery.mjs"],["??","src/native-agent-session-recorder.mjs"],[" M","package.json"],[" M","package-lock.json"]];
  await page.route("**/api/workspace/diff?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,status:status.map(([code,path])=>code+" "+path).join("\n"),diff:"diff --git a/goal.md b/goal.md\n--- a/goal.md\n+++ b/goal.md\n@@ -1 +1 @@\n-old\n+new\n",stderr:""})}));
  const {right,top}=await openProjectInspector(page,request,"Workspace long names");
  await top.getByRole("button",{name:"Diff",exact:true}).click();
  const rows=right.locator(".changed-file-row");
  await expect(rows).toHaveCount(status.length);
  const names=status.map(([,path])=>path.replace(/\/$/,"").split("/").pop()+(path.endsWith("/")?"/":""));
  // The text a drawn one can stand for: its pieces in order, with at least one character left out where an ellipsis stands.
  const readAs=shown=>new RegExp("^"+shown.split("…").map(piece=>piece.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".+")+"$");
  for(const [viewport,mode] of [[{width:1280,height:800},"dark"],[{width:1600,height:980},"light"],[{width:1280,height:800},"light"],[{width:1600,height:980},"dark"]]){
    await page.setViewportSize(viewport);await page.evaluate(mode=>{document.documentElement.dataset.mode=mode},mode);
    const tag=mode+"-"+viewport.width+"x"+viewport.height;
    await expect.poll(async()=>(await drawnChangedNames(right)).some(name=>name.includes("…")),tag+": the list is narrow enough to cut names").toBe(true);
    const drawn=await drawnChangedNames(right),shown=tag+": "+JSON.stringify(drawn);
    // No row shows half a character, every row reads as its own name and no two read alike.
    expect(drawn.filter(name=>name.includes("▒")),shown).toEqual([]);
    expect(new Set(drawn).size,shown).toBe(drawn.length);
    for(const [index,name] of names.entries())expect(name,tag).toMatch(readAs(drawn[index]));
    // A cut name keeps its extension, and the end after its ellipsis tells it apart from every other cut name: the four artifacts end in
    // their own hashes, and the tool-activity files in their own words.
    for(const [index,name] of names.entries())if(/\.\w+$/.test(name))expect(drawn[index],tag+": "+name).toMatch(/\.\w+$/);
    const ends=drawn.filter(name=>name.includes("…")).map(name=>name.slice(name.lastIndexOf("…")+1));
    expect(new Set(ends).size,tag+": "+JSON.stringify(ends)).toBe(ends.length);
    for(const index of [0,1,2,3])expect(drawn[index],shown).toMatch(/…\w{6,}\.png$/);
    for(const [index,end] of [[7,/activity\.js$/],[8,/summary\.js$/],[9,/test\.mjs$/]])expect(drawn[index],shown).toMatch(end);
    // The row still names the whole path, for the tooltip and for screen readers.
    for(const [index,[,path]] of status.entries())await expect(rows.nth(index).locator("button").first()).toHaveAttribute("aria-label",path);
    await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-long-names-"+tag+".png",fullPage:true});
  }
});
