import { test,expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync,symlinkSync } from "node:fs";
import { mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir,userInfo } from "node:os";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

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
  // The panel tab, not the Files | Changes switch the workspace panel draws once it loads (both are named Files).
  await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Files",exact:true}).click();
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

// Opens a project registered under `name` (the checkout, or the folder at `path`) and the inspector beside it.
async function openProjectInspector(page,request,name,path=null){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:path||boot.cwd,name}});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:name});
  await expect(project).toBeVisible();
  await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");
  return {boot,right,top:right.locator(".context-panel-tab-scroll"),inner:right.locator(".workspace-panel .panel-tabs")};
}

// A real folder holding `files` (relative path: text or bytes), opened as a project with the Files view beside it, and removed when
// the test ends; a Git read the server still runs in it holds it on Windows, so the removal waits for that and never fails the test.
// row(name) is the tree row a person clicks to open that file.
const folders=[];
test.afterEach(async()=>{for(const dir of folders.splice(0))await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{})});
async function openFilesFolder(page,request,name,files){
  const dir=await mkdtemp(join(tmpdir(),"trebell-files-"));folders.push(dir);
  for(const [relative,content] of Object.entries(files)){await mkdir(dirname(join(dir,relative)),{recursive:true});await writeFile(join(dir,relative),content)}
  await page.setViewportSize({width:1280,height:800});
  const opened=await openProjectInspector(page,request,name,dir);
  const row=file=>opened.right.locator("[data-workspace-entry]").filter({hasText:new RegExp("^"+file.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"$")});
  await expect(row(Object.keys(files)[0].split("/").pop())).toBeVisible();
  return {...opened,dir,row};
}

// Screenshots in both modes at 1280x800 and 900 wide. The mode is switched with the header's toggle, at 1280 where the header shows
// it, as a person would; a dialog that keeps the header out of reach is closed for the switch and opened again. The page ends in the
// mode it started in.
async function shootBothModes(page,name,{close=null,reopen=null}={}){
  for(let pass=0;pass<2;pass++){
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-1280x800.png"});
    await page.setViewportSize({width:900,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-900x800.png"});
    await page.setViewportSize({width:1280,height:800});
    if(close)await close();
    await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode==="dark"?"light":"dark");
    if(reopen)await reopen();
  }
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

test("Changes for a folder that is not a Git repository says so in one line, and a long reason stays in its box under the switch",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,inner}=await openFilesFolder(page,request,"Workspace plain folder",{"notes.txt":"notes\n"});
  const empty=right.locator(".changes-empty"),changes=inner.getByRole("button",{name:/^Changes/}),files=inner.getByRole("button",{name:"Files",exact:true});
  await changes.click();
  await expect(empty).toHaveText("Could not load changesThis folder is not a Git repository");
  await shootBothModes(page,"workspace-changes-not-git");
  // A reason as long as git's whole usage text stays inside the box, below the Files | Changes switch, which can still be clicked.
  const long="git diff failed: "+"a reason that goes on and on ".repeat(160);
  await page.route("**/api/workspace/diff?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,status:"",diff:"",error:long})}));
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    await files.click();await changes.click();await expect(empty).toContainText("a reason that goes on");
    const place=await empty.evaluate(node=>{const own=node.getBoundingClientRect(),reason=node.querySelector("span").getBoundingClientRect(),tabs=node.closest(".workspace-panel").querySelector(".panel-tabs").getBoundingClientRect();return {startsInBox:reason.top>=own.top,belowSwitch:own.top>=tabs.bottom}});
    expect(place,"the long reason at "+width).toEqual({startsInBox:true,belowSwitch:true});
    await files.click();await expect(right.locator("[data-workspace-entry]").first()).toBeVisible();
  }
  await page.setViewportSize({width:1280,height:800});await changes.click();
  await shootBothModes(page,"workspace-changes-long-reason");
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

test("a working-tree read that answers after newer reads started still shows, and an older answer never replaces a newer one",async({page,request})=>{
  test.setTimeout(35_000);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  // Every diff read waits until the test answers it, as a large repository's reads do while an agent keeps changing files.
  const held=[];
  await page.route("**/api/workspace/diff?**",route=>{held.push(route)});
  const files=count=>({isGit:true,status:Array.from({length:count},(_,index)=>" M src/file-"+index+".js").join("\n"),diff:"diff --git a/src/file-0.js b/src/file-0.js\n",stderr:""});
  const answer=async(index,value)=>{await expect.poll(()=>held.length).toBeGreaterThan(index);const responded=page.waitForResponse(response=>response.request()===held[index].request());await json(held[index],value);await responded};
  const fileChanged=()=>page.evaluate(()=>window.dispatchEvent(new CustomEvent("trebell:rpc-notification",{detail:{method:"turn/diff/updated",params:{}}})));
  await page.setViewportSize({width:1280,height:800});
  const {right,top,inner}=await openProjectInspector(page,request,"Workspace diff stream");
  await top.getByRole("button",{name:"Diff",exact:true}).click();
  const rows=right.locator(".changed-file-row");
  // The reads the panel starts on opening (one or two, as the panel loads) are out, and two file changes start two more before any
  // answers.
  await expect(right.locator(".changes-loading")).toBeVisible();
  await expect.poll(()=>held.length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const opening=held.length;
  await fileChanged();
  await expect.poll(()=>held.length).toBe(opening+1);
  await fileChanged();
  await expect.poll(()=>held.length).toBe(opening+2);
  // The oldest answer shows although newer reads are out: a stream of changes no longer keeps the tab loading.
  await answer(0,files(1));
  await expect(rows).toHaveCount(1);
  await expect(inner.getByRole("button",{name:/^Changes/})).toHaveText("Changes (1)");
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-stream-first-answer-dark-1280x800.png",fullPage:true});
  // The newest answer replaces it, and the ones in between, answering last, do not bring an older list back.
  await answer(opening+1,files(3));
  await expect(rows).toHaveCount(3);
  for(let index=1;index<=opening;index++)await answer(index,files(2));
  await page.waitForTimeout(300);
  await expect(rows).toHaveCount(3);
  await expect(inner.getByRole("button",{name:/^Changes/})).toHaveText("Changes (3)");
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-stream-newest-light-1280x800.png",fullPage:true});
});

test("the Files editor asks before it drops unsaved edits, and a save never writes over a file that changed on disk",async({page,request})=>{
  test.setTimeout(90_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace unsaved edits",{"notes.txt":"line one\nline two\n","app.js":"console.log(1);\n"});
  const head=right.locator(".file-head strong"),editor=right.locator("textarea.file-editor"),notes=join(dir,"notes.txt");
  const button=name=>right.locator(".file-head").getByRole("button",{name,exact:true});
  const question=page.getByRole("dialog",{name:"Discard your changes to notes.txt?"});
  const editNotes=async text=>{await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type(text,{delay:20})};
  const openFile=async name=>{await row(name).click();await expect(head).toHaveText(name)};
  await openFile("notes.txt");
  await expect(right.locator(".syntax-view")).toContainText("line two");
  await editNotes("my edit");

  // Opening another file asks first, with focus on keeping the edits; Escape keeps them, as does Keep editing.
  await row("app.js").click();
  await expect(question).toBeVisible();
  await expect(question.getByRole("button",{name:"Keep editing"})).toBeFocused();
  await shootBothModes(page,"workspace-unsaved-question",{close:()=>page.keyboard.press("Escape"),reopen:async()=>{await row("app.js").click();await expect(question).toBeVisible()}});
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(head).toHaveText("notes.txt");await expect(editor).toHaveValue("line one\nline two\nmy edit");
  // Cancel closes the editor: it asks the same question.
  await button("Cancel").click();
  await question.getByRole("button",{name:"Keep editing"}).click();
  await expect(editor).toHaveValue("line one\nline two\nmy edit");
  // Discard changes drops them and opens the other file; the file on disk never had them.
  await row("app.js").click();
  await question.getByRole("button",{name:"Discard changes"}).click();
  await expect(head).toHaveText("app.js");
  expect(await readFile(notes,"utf8")).toBe("line one\nline two\n");
  // An editor with nothing changed closes and gives way with no question.
  await openFile("notes.txt");await button("Edit").click();await expect(editor).toBeVisible();
  await openFile("app.js");await expect(question).toHaveCount(0);

  // An agent writes the open file while it is edited: Save writes nothing, says so, and keeps the edit in the editor.
  await openFile("notes.txt");
  await editNotes("mine");
  await writeFile(notes,"line one\nline two\nagent line\n");
  await button("Save").click();
  const conflict=right.getByRole("alert").filter({hasText:"changed on disk"});
  await expect(conflict).toContainText("notes.txt changed on disk after you opened it.");
  expect(await readFile(notes,"utf8")).toBe("line one\nline two\nagent line\n");
  await expect(editor).toHaveValue("line one\nline two\nmine");
  await shootBothModes(page,"workspace-save-conflict");
  // Reload from disk shows the agent's version in place of the edit.
  await conflict.getByRole("button",{name:"Reload from disk"}).click();
  await expect(editor).toHaveCount(0);await expect(conflict).toHaveCount(0);
  await expect(right.locator(".syntax-view")).toContainText("agent line");
  // Overwrite saves the edit over a version that changed, and a later save of that version needs no question.
  await editNotes("mine again");
  await writeFile(notes,"agent rewrote it\n");
  await button("Save").click();
  await conflict.getByRole("button",{name:"Overwrite"}).click();
  await expect(editor).toHaveCount(0);
  await expect(right.locator(".syntax-view")).toContainText("mine again");
  expect(await readFile(notes,"utf8")).toBe("line one\nline two\nagent line\nmine again");
  await editNotes(" and more");await button("Save").click();
  await expect(editor).toHaveCount(0);
  expect(await readFile(notes,"utf8")).toBe("line one\nline two\nagent line\nmine again and more");
  // Closing the editor shows the file as it is on disk, with a change the agent made meanwhile.
  await editNotes(" dropped");
  await writeFile(notes,"agent again\n");
  await button("Cancel").click();
  await question.getByRole("button",{name:"Discard changes"}).click();
  await expect(editor).toHaveCount(0);
  await expect(right.locator(".syntax-view")).toContainText("agent again");await expect(right.locator(".syntax-view")).not.toContainText("dropped");
  // A file deleted on disk is not made again by a plain Save either: the panel says it is gone, and Overwrite writes it back.
  await editNotes("!");
  await rm(notes);
  await button("Save").click();
  const gone=right.getByRole("alert").filter({hasText:"deleted on disk"});
  await expect(gone).toContainText("notes.txt was deleted on disk after you opened it.");
  await expect.poll(()=>readFile(notes,"utf8").catch(()=>"(none)")).toBe("(none)");
  await gone.getByRole("button",{name:"Overwrite"}).click();
  await expect(editor).toHaveCount(0);
  expect(await readFile(notes,"utf8")).toBe("agent again\n!");
});

// A save on a slow connection (a remote environment): the server writes at once, and the page has the answer only once the test
// lets it through (release). answers lists each save's status as the server gave it; answered() waits for the page to have one.
async function holdSaves(page){
  let release=null;const gate=new Promise(resolve=>{release=resolve}),answers=[];
  await page.route("**/api/workspace/file",async route=>{
    if(route.request().method()!=="PUT")return route.continue();
    const response=await route.fetch();answers.push(response.status());await gate;await route.fulfill({response});
  });
  const answered=()=>page.waitForResponse(response=>response.url().includes("/api/workspace/file")&&response.request().method()==="PUT").then(response=>response.finished());
  return {answers,release,answered};
}

test("Save is busy until its answer comes, so a second press never reports the person's own save as a change on disk",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace busy save",{"notes.txt":"line one\n"});
  const editor=right.locator("textarea.file-editor"),button=name=>right.locator(".file-head").getByRole("button",{name,exact:true});
  const saves=await holdSaves(page);
  await row("notes.txt").click();
  await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("mine",{delay:20});
  await button("Save").click();
  await expect.poll(()=>readFile(join(dir,"notes.txt"),"utf8")).toBe("line one\nmine");
  // While the answer is on its way Save is busy: pressed again from the keyboard or with the mouse, it sends nothing.
  await expect(button("Save")).toBeDisabled();
  await page.keyboard.press("Enter");await button("Save").click({force:true});
  await page.waitForTimeout(300);
  expect(saves.answers).toEqual([200]);
  await shootBothModes(page,"workspace-save-busy");
  const answered=saves.answered();saves.release();await answered;
  await expect(editor).toHaveCount(0);
  await expect(right.locator(".syntax-view")).toContainText("mine");
  await expect(right.getByRole("alert")).toHaveCount(0);
  expect(saves.answers).toEqual([200]);
});

test("Ctrl+S in the Files editor saves the file, and in the inspector's fields leaves the composer's draft and attachment where they are",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace Ctrl+S",{"notes.txt":"first line\n","plan.md":"# plan\n"});
  const composer=page.getByTestId("composer"),editor=right.locator("textarea.file-editor"),shelf=page.locator(".attachment-shelf > span");
  const button=name=>right.locator(".file-head").getByRole("button",{name,exact:true}),draft="Compare the plan with my notes";
  // The person attaches plan.md, writes a draft about it, then edits notes.txt in the Files view and presses Ctrl+S, as in any editor.
  await right.getByRole("button",{name:"Attach plan.md to chat",exact:true}).click();await expect(shelf).toHaveCount(1);
  await composer.click();await page.keyboard.type(draft,{delay:15});
  await row("notes.txt").click();await expect(right.locator(".syntax-view")).toContainText("first line");
  await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("second line",{delay:15});
  await page.keyboard.press("Control+s");
  await expect.poll(()=>readFile(join(dir,"notes.txt"),"utf8")).toBe("first line\nsecond line");
  await expect(editor).toHaveCount(0);await expect(right.locator(".syntax-view")).toContainText("second line");
  await expect(composer).toHaveValue(draft);await expect(shelf).toHaveCount(1);
  // Ctrl+S in another of the inspector's fields, the file search, leaves the draft too.
  await right.getByPlaceholder("Search files…").click();await page.keyboard.press("Control+s");
  await page.waitForTimeout(300);
  await expect(composer).toHaveValue(draft);await expect(shelf).toHaveCount(1);
  await shootBothModes(page,"workspace-ctrl-s-saves");
  // From the composer, Ctrl+S still stashes the draft with its attachment, and once more brings them back.
  await composer.click();await page.keyboard.press("Control+s");
  await expect(composer).toHaveValue("");await expect(shelf).toHaveCount(0);
  await page.keyboard.press("Control+s");
  await expect(composer).toHaveValue(draft);await expect(shelf).toHaveCount(1);
});

test("text typed while a save is on its way stays in the editor, unsaved, and the next save writes it with no question",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace typed during save",{"notes.txt":"line one\n"});
  const editor=right.locator("textarea.file-editor"),button=name=>right.locator(".file-head").getByRole("button",{name,exact:true}),notes=join(dir,"notes.txt");
  const saves=await holdSaves(page);
  await row("notes.txt").click();
  await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("first",{delay:20});
  await button("Save").click();
  await expect.poll(()=>readFile(notes,"utf8")).toBe("line one\nfirst");
  // The person goes back into the editor and keeps typing while the answer is on its way.
  await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type(" second",{delay:20});
  const answered=saves.answered();saves.release();await answered;
  await expect(button("Save")).toBeEnabled();await page.waitForTimeout(300);
  await expect(editor).toHaveValue("line one\nfirst second");
  await shootBothModes(page,"workspace-typed-during-save");
  // Saving again writes the rest over the version just saved, with no word of a change on disk.
  await button("Save").click();
  await expect(editor).toHaveCount(0);
  await expect(right.locator(".syntax-view")).toContainText("first second");
  await expect(right.getByRole("alert")).toHaveCount(0);
  expect(await readFile(notes,"utf8")).toBe("line one\nfirst second");
});

test("a save answered after the person opened another project stays out of it, and its own project shows the file saved",async({page,request})=>{
  test.setTimeout(90_000);
  const other=await mkdtemp(join(tmpdir(),"trebell-files-"));folders.push(other);await writeFile(join(other,"other.txt"),"other\n");
  await request.post("/api/projects",{data:{path:other,name:"Workspace save project B"}});
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace save project A",{"notes.txt":"line one\n"});
  const editor=right.locator("textarea.file-editor"),head=right.locator(".file-head strong"),button=name=>right.locator(".file-head").getByRole("button",{name,exact:true}),notes=join(dir,"notes.txt");
  const openProject=async name=>{await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".project-card").filter({hasText:name}).locator(".project-open").click();await expect(right).toBeVisible()};
  const saves=await holdSaves(page);
  await row("notes.txt").click();
  await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("saved text",{delay:20});
  await button("Save").click();
  await expect.poll(()=>readFile(notes,"utf8")).toBe("line one\nsaved text");
  // The person opens project B while the save's answer is still on its way; B's Files view never takes A's file.
  await openProject("Workspace save project B");
  await expect(right.locator("[data-workspace-entry]").filter({hasText:/^other\.txt$/})).toBeVisible();
  const answered=saves.answered();saves.release();await answered;await page.waitForTimeout(300);
  await expect(head).toHaveCount(0);await expect(editor).toHaveCount(0);
  await shootBothModes(page,"workspace-save-answered-in-other-project");
  // Back in A the file is saved: no editor comes back with it, and a later edit saves with no word of a change on disk.
  await openProject("Workspace save project A");
  await expect(row("notes.txt")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await row("notes.txt").click();
  await expect(right.locator(".syntax-view")).toContainText("saved text");
  await button("Edit").click();await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type(" again",{delay:20});
  await button("Save").click();
  await expect(editor).toHaveCount(0);
  await expect(right.getByRole("alert")).toHaveCount(0);
  expect(await readFile(notes,"utf8")).toBe("line one\nsaved text again");
});

test("an edit to a file with Windows line ends keeps them on every line",async({page,request})=>{
  test.setTimeout(45_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace line ends",{"win.txt":"first\r\nsecond\r\nthird\r\n","unix.txt":"one\ntwo\n"});
  const editor=right.locator("textarea.file-editor"),button=name=>right.locator(".file-head").getByRole("button",{name,exact:true});
  // The first line gets a word at its end; the file keeps the line ends it had.
  for(const [name,saved] of [["win.txt","first line\r\nsecond\r\nthird\r\n"],["unix.txt","one line\ntwo\n"]]){
    await row(name).click();await expect(right.locator(".file-head strong")).toHaveText(name);
    await button("Edit").click();await editor.click();await page.keyboard.press("Control+Home");await page.keyboard.press("End");await page.keyboard.type(" line",{delay:20});
    await button("Save").click();
    await expect(editor).toHaveCount(0);
    expect(await readFile(join(dir,name),"utf8")).toBe(saved);
  }
});

test("a binary file opens as binary, with its size and no Edit, and its bytes stay as they were",async({page,request})=>{
  test.setTimeout(60_000);
  // Every byte value (NUL included), and a Latin-1 text whose "é" is not UTF-8.
  const blob=Buffer.from(Array.from({length:4096},(_,index)=>(index*37+11)%256)),latin=Buffer.from("café au lait\n","latin1");
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace binary files",{"bin/blob.bin":blob,"latin1.txt":latin,"notes.txt":"plain text\n"});
  const view=right.locator(".file-view"),button=name=>right.locator(".file-head").getByRole("button",{name,exact:true});
  for(const [name,path,bytes,size] of [["blob.bin","bin/blob.bin",blob,"4.0 KB"],["latin1.txt","latin1.txt",latin,"13 B"]]){
    await row(name).click();
    await expect(right.locator(".file-head strong")).toHaveText(name);
    await expect(view.locator(".file-empty")).toContainText("Binary file");
    await expect(view.locator(".file-empty")).toContainText(size);
    await expect(view).not.toContainText("�");
    await expect(button("Edit")).toHaveCount(0);await expect(button("Attach")).toBeVisible();
    // The file's head stays at the top of the view, over its size.
    const top=locator=>locator.evaluate(node=>Math.round(node.getBoundingClientRect().top));
    expect(await top(right.locator(".file-head"))).toBe(await top(view));
    expect((await readFile(join(dir,path))).equals(bytes),name+" keeps its bytes").toBe(true);
    if(name==="blob.bin")await shootBothModes(page,"workspace-binary-file");
  }
  // Text still opens as text, with Edit.
  await row("notes.txt").click();
  await expect(right.locator(".syntax-view")).toContainText("plain text");
  await expect(button("Edit")).toBeVisible();
});

test("a file that fails to open takes the place of the one in view, and Refresh reads the open file again",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace failed opens",{"notes.txt":"first version\n","app.js":"console.log(1);\n","style.css":"body{}\n","big.txt":"x".repeat(600*1024)});
  const head=right.locator(".file-head strong"),view=right.locator(".file-view"),edit=right.locator(".file-head").getByRole("button",{name:"Edit",exact:true});
  const attach=right.locator(".file-head").getByRole("button",{name:"Attach",exact:true}),attachToChat=view.getByRole("button",{name:"Attach to chat",exact:true});
  const refresh=()=>right.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  // A file deleted on disk while the tree still lists it: the view names it and says plainly that it was not found, without the
  // folder it was in, and offers nothing for it: no Edit and nothing to attach.
  await row("notes.txt").click();
  await expect(view.locator(".syntax-view")).toContainText("first version");
  await expect(attach).toBeVisible();
  await rm(join(dir,"style.css"));
  await row("style.css").click();
  await expect(head).toHaveText("style.css");
  await expect(view.getByRole("alert")).toHaveText("style.css was not found");
  await expect(view.locator(".syntax-view")).toHaveCount(0);await expect(edit).toHaveCount(0);
  await expect(attach,"Attach for a file that is not there").toHaveCount(0);await expect(attachToChat,"Attach to chat for a file that is not there").toHaveCount(0);
  await expect(right.getByRole("button",{name:"Attach style.css to chat",exact:true}),"the tree row's Attach for it").toHaveCount(0);
  await expect(right.getByRole("button",{name:"Attach notes.txt to chat",exact:true}),"the tree row's Attach for a file that is there").toHaveCount(1);
  await shootBothModes(page,"workspace-open-failed-deleted");
  // A file too large to preview, opened over another file, likewise, but it is there, so it can still be attached.
  await row("notes.txt").click();await expect(edit).toBeVisible();
  await row("big.txt").click();
  await expect(head).toHaveText("big.txt");
  await expect(view.getByRole("alert")).toContainText("File is too large to preview (600 KB)");
  await expect(view.locator(".syntax-view")).toHaveCount(0);await expect(edit).toHaveCount(0);
  await expect(attach).toBeVisible();await expect(attachToChat).toBeVisible();
  // Refresh reads the open file again: a change on disk shows, and a file deleted on disk shows that it could not be read.
  await row("notes.txt").click();
  await writeFile(join(dir,"notes.txt"),"second version\n");
  await refresh();
  await expect(view.locator(".syntax-view")).toContainText("second version");
  await row("app.js").click();await expect(view.locator(".syntax-view")).toContainText("console.log");
  await rm(join(dir,"app.js"));
  await refresh();
  await expect(head).toHaveText("app.js");
  await expect(view.getByRole("alert")).toHaveText("app.js was not found");
  await expect(view.locator(".syntax-view")).toHaveCount(0);await expect(edit).toHaveCount(0);await expect(attach).toHaveCount(0);await expect(attachToChat).toHaveCount(0);
  await expect(row("app.js")).toHaveCount(0);
  await shootBothModes(page,"workspace-open-file-deleted-refresh");
});

test("an image deleted on disk says it could not be opened, from the tree and on Refresh",async({page,request})=>{
  test.setTimeout(60_000);
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace deleted image",{"logo.png":png,"icon.png":png,"notes.txt":"notes\n"});
  const head=right.locator(".file-head strong"),view=right.locator(".file-view"),attach=right.locator(".file-view").getByRole("button",{name:/^Attach/});
  // Deleted while the tree still lists it, then opened: it was not found, and there is nothing to attach.
  await rm(join(dir,"icon.png"));
  await row("icon.png").click();
  await expect(head).toHaveText("icon.png");
  await expect(view.getByRole("alert")).toHaveText("icon.png was not found");
  await expect(view.locator(".media-preview")).toHaveCount(0);await expect(attach).toHaveCount(0);
  // Open, then deleted: Refresh says so in place of the picture.
  await row("logo.png").click();
  await expect(view.locator(".media-preview img")).toBeVisible();
  await rm(join(dir,"logo.png"));
  await right.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  await expect(row("logo.png")).toHaveCount(0);
  await expect(head).toHaveText("logo.png");
  await expect(view.getByRole("alert")).toHaveText("logo.png was not found");
  await expect(view.locator(".media-preview")).toHaveCount(0);await expect(attach).toHaveCount(0);
  await shootBothModes(page,"workspace-open-image-deleted-refresh");
});

test("a picture or text file reached through a link out of the project is refused by the Files view and by its raw address",async({page,request})=>{
  test.setTimeout(60_000);
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");
  const base=await mkdtemp(join(tmpdir(),"trebell-files-link-"));folders.push(base);
  const project=join(base,"proj"),outside=join(base,"outside");
  await mkdir(project,{recursive:true});await mkdir(outside,{recursive:true});
  await writeFile(join(project,"logo.png"),png);await writeFile(join(outside,"secret.txt"),"outside secret\n");await writeFile(join(outside,"secret.png"),png);
  symlinkSync(outside,join(project,"linked"),"junction");
  // In a Git checkout, Files search lists what git lists, the files behind the link among them.
  execFileSync("git",["init","-q","."],{cwd:project,windowsHide:true});
  // The raw address a picture, video, sound or PDF shows from refuses them as the editor's read does, and serves a picture inside.
  const raw=path=>request.get("/api/workspace/raw?"+new URLSearchParams({root:project,path}));
  for(const name of ["secret.txt","secret.png"]){
    const answer=await raw(join(project,"linked",name));
    expect(answer.ok(),name+" through the link").toBe(false);expect((await answer.json()).error,name).toBe("File is outside the active workspace");
  }
  expect((await raw(join(project,"logo.png"))).status(),"a picture inside the project").toBe(200);
  const {right}=await openProjectInspector(page,request,"Workspace linked picture",project);
  const view=right.locator(".file-view"),head=right.locator(".file-head strong"),hit=name=>right.locator("[data-workspace-entry]").filter({hasText:name});
  await right.getByPlaceholder("Search files…").click();await page.keyboard.type("secret",{delay:30});
  await expect(hit("secret.txt")).toBeVisible();await expect(hit("secret.png")).toBeVisible();
  await hit("secret.txt").click();
  await expect(view.getByRole("alert")).toHaveText("Could not open secret.txt: File is outside the active workspace");
  await hit("secret.png").click();
  await expect(head).toHaveText("secret.png");
  await expect(view.getByRole("alert")).toHaveText("Could not open secret.png: File is outside the active workspace");
  await expect(view.locator(".media-preview")).toHaveCount(0);await expect(view.getByRole("button",{name:/^Attach/})).toHaveCount(0);
  await shootBothModes(page,"workspace-linked-picture-refused");
});

test("a file the system will not let Trebell read says so plainly, without the system's error or the folder's full path",async({page,request})=>{
  test.skip(process.platform!=="win32","icacls denies the read here");
  test.setTimeout(60_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace locked file",{"notes.txt":"notes\n","locked.txt":"private\n"});
  const locked=join(dir,"locked.txt"),user=userInfo().username,view=right.locator(".file-view");
  execFileSync("icacls",[locked,"/deny",user+":(R)"],{windowsHide:true});
  try{
    await row("locked.txt").click();
    await expect(right.locator(".file-head strong")).toHaveText("locked.txt");
    await expect(view.getByRole("alert")).toHaveText("Could not open locked.txt: Trebell is not allowed to read this file");
    await expect(view.getByRole("button",{name:/^Attach/})).toHaveCount(0);
    await shootBothModes(page,"workspace-locked-file");
  }finally{execFileSync("icacls",[locked,"/remove:d",user],{windowsHide:true})}
});

test("Edit pressed while Refresh still reads the open file keeps the editor and what is typed",async({page,request})=>{
  test.setTimeout(45_000);
  const {right,row,dir}=await openFilesFolder(page,request,"Workspace refresh then edit",{"notes.txt":"first\n"});
  const editor=right.locator("textarea.file-editor"),notes=join(dir,"notes.txt");
  await row("notes.txt").click();
  await expect(right.locator(".syntax-view")).toContainText("first");
  // An agent changes the file, the person presses Refresh, and the file's read again is held until they have started typing.
  let release=null,held=0;const gate=new Promise(resolve=>{release=resolve});
  await page.route("**/api/workspace/file?**",async route=>{if(held++===0)await gate;await route.continue()});
  await writeFile(notes,"second\n");
  await right.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  await expect.poll(()=>held).toBe(1);
  await right.getByRole("button",{name:"Edit",exact:true}).click();
  await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("mine",{delay:20});
  const reread=page.waitForResponse(response=>response.url().includes("/api/workspace/file?")&&response.request().method()==="GET");
  release();await (await reread).finished();
  // The read that lands after Edit leaves the editor and the typing alone; Save, made from the text first shown, finds the change.
  await right.getByRole("button",{name:"Save",exact:true}).click();
  const conflict=right.getByRole("alert").filter({hasText:"changed on disk"});
  await expect(conflict).toContainText("notes.txt changed on disk after you opened it.");
  await expect(editor).toHaveValue("first\nmine");
  expect(await readFile(notes,"utf8")).toBe("second\n");
  await shootBothModes(page,"workspace-refresh-then-edit-conflict");
});

test("Refresh pressed while another file opens shows that file, never the one before it",async({page,request})=>{
  test.setTimeout(45_000);
  const {right,row}=await openFilesFolder(page,request,"Workspace refresh while opening",{"notes.txt":"notes\n","todo.txt":"todo\n"});
  const head=right.locator(".file-head strong");
  await row("notes.txt").click();
  await expect(right.locator(".syntax-view")).toContainText("notes");
  // todo.txt's read is held until Refresh has asked again; the reads name the file they ask for.
  let release=null;const gate=new Promise(resolve=>{release=resolve}),asked=[];
  await page.route("**/api/workspace/file?**",async route=>{asked.push(new URL(route.request().url()).searchParams.get("path").split(/[\\/]/).pop());if(asked.length===1)await gate;await route.continue()});
  await row("todo.txt").click();
  await expect.poll(()=>asked.length).toBe(1);
  await right.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  await expect.poll(()=>asked).toEqual(["todo.txt","todo.txt"]);
  release();
  await expect(head).toHaveText("todo.txt");
  await expect(right.locator(".syntax-view")).toContainText("todo");
});

test("an unsaved edit is still in the editor after another inspector tab and after the panel is closed",async({page,request})=>{
  test.setTimeout(60_000);
  const {right,row,top,dir}=await openFilesFolder(page,request,"Workspace kept edits",{"notes.txt":"kept\n","todo.txt":"todo\n"});
  const editor=right.locator("textarea.file-editor"),notes=join(dir,"notes.txt"),toggle=page.getByTestId("right-panel-toggle");
  await row("notes.txt").click();
  await right.getByRole("button",{name:"Edit",exact:true}).click();
  await editor.click();await page.keyboard.press("Control+End");await page.keyboard.type("typed",{delay:20});
  // Git, then Files again: the editor is back with what was typed.
  await top.getByRole("button",{name:"Git",exact:true}).click();
  await expect(editor).toHaveCount(0);
  await top.getByRole("button",{name:"Files",exact:true}).click();
  await expect(editor).toHaveValue("kept\ntyped");
  await expect(right.locator(".file-head strong")).toHaveText("notes.txt");
  // The panel closed and opened again, likewise; nothing was written meanwhile.
  await toggle.click();await expect(right).toBeHidden();
  await toggle.click();
  await expect(editor).toHaveValue("kept\ntyped");
  expect(await readFile(notes,"utf8")).toBe("kept\n");
  await shootBothModes(page,"workspace-kept-edit");
  // Saved, the edit is no longer kept: the next visit shows the file, not an editor.
  await right.getByRole("button",{name:"Save",exact:true}).click();
  await expect(editor).toHaveCount(0);
  expect(await readFile(notes,"utf8")).toBe("kept\ntyped");
  await top.getByRole("button",{name:"Git",exact:true}).click();
  await top.getByRole("button",{name:"Files",exact:true}).click();
  await expect(right.locator(".file-head")).toHaveCount(0);await expect(editor).toHaveCount(0);
  // An edit dropped with Discard changes is not kept either.
  await row("notes.txt").click();
  await right.getByRole("button",{name:"Edit",exact:true}).click();
  await editor.click();await page.keyboard.type("x",{delay:20});
  await row("todo.txt").click();
  await page.getByRole("dialog").getByRole("button",{name:"Discard changes",exact:true}).click();
  await expect(right.locator(".file-head strong")).toHaveText("todo.txt");
  await top.getByRole("button",{name:"Git",exact:true}).click();
  await top.getByRole("button",{name:"Files",exact:true}).click();
  await expect(editor).toHaveCount(0);
});

test("a file search with no match says that no files match",async({page,request})=>{
  test.setTimeout(45_000);
  const {right,row}=await openFilesFolder(page,request,"Workspace empty search",{"notes.txt":"notes\n","src/app.js":"app\n"});
  const list=right.locator(".tree-list"),search=right.getByPlaceholder("Search files…");
  await search.click();
  await page.keyboard.type("zzz-no-such-file",{delay:25});
  await expect(list).toContainText("No files match “zzz-no-such-file”.");
  await expect(right.locator("[data-workspace-entry]")).toHaveCount(0);
  await shootBothModes(page,"workspace-search-no-match");
  // A query with a match lists it, with no message.
  await search.click();await page.keyboard.press("Control+A");await page.keyboard.type("notes",{delay:25});
  await expect(row("notes.txt")).toBeVisible();
  await expect(list).not.toContainText("No files match");
  // A query of only spaces searches for nothing, so the tree shows.
  await search.click();await page.keyboard.press("Control+A");await page.keyboard.type("  ",{delay:25});
  await expect(row("app.js")).toBeVisible();await expect(row("notes.txt")).toBeVisible();
  await expect(list).not.toContainText("No files match");
  await shootBothModes(page,"workspace-search-spaces");
});

test("the Markdown preview draws bold, italic and inline code, and shows markup in the file as text",async({page,request})=>{
  test.setTimeout(45_000);
  const readme="# Notes\nA **bold** word, an *italic* one and `inline code`, but 2 * 3 * 4 stays as it is.\n- a list item with **bold `code`** in it\n> a quote with *italic* text\nMarkup stays text: <b>not bold</b> <img src=x onerror=\"window.__injected=1\">\n```\n**not bold in a fence**\n```\n";
  const {right,row}=await openFilesFolder(page,request,"Workspace markdown",{"README.md":readme});
  await row("README.md").click();
  const md=right.locator(".markdown-preview");
  await expect(md.locator("h1")).toHaveText("Notes");
  await expect(md.locator("p").first()).toHaveText("A bold word, an italic one and inline code, but 2 * 3 * 4 stays as it is.");
  await expect(md.locator("strong")).toHaveText(["bold","bold code"]);
  await expect(md.locator("em")).toHaveText(["italic","italic"]);
  // The app's fonts have no italic face, so italic text is drawn slanted only where the browser may slant it.
  expect(await md.locator("em").first().evaluate(node=>getComputedStyle(node).fontSynthesisStyle)).toBe("auto");
  await expect(md.locator("code")).toHaveText(["inline code","code"]);
  await expect(md.locator("blockquote em")).toHaveText("italic");
  await expect(md).toContainText("Markup stays text: <b>not bold</b> <img src=x onerror=\"window.__injected=1\">");
  await expect(md.locator("b,img")).toHaveCount(0);
  expect(await page.evaluate(()=>window.__injected)).toBeUndefined();
  await expect(md.locator("pre")).toHaveText("**not bold in a fence**");
  await shootBothModes(page,"workspace-markdown-inline");
});

test("the Markdown preview draws bold inside italic and bold italic with no asterisks left over",async({page,request})=>{
  test.setTimeout(45_000);
  const readme="An *italic run with **bold** inside* here.\nAnd ***bold italic*** text.\nA **bold run with *italic* inside** too.\n";
  const {right,row}=await openFilesFolder(page,request,"Workspace markdown nesting",{"README.md":readme});
  await row("README.md").click();
  const lines=right.locator(".markdown-preview p");
  await expect(lines).toHaveText(["An italic run with bold inside here.","And bold italic text.","A bold run with italic inside too."]);
  await expect(lines.nth(0).locator("em strong")).toHaveText("bold");
  await expect(lines.nth(1).locator("em strong")).toHaveText("bold italic");
  await expect(lines.nth(2).locator("strong em")).toHaveText("italic");
  await shootBothModes(page,"workspace-markdown-nested");
});

test("the tree's attach control and the attachment's remove button are named controls the keyboard reaches",async({page,request})=>{
  test.setTimeout(45_000);
  const {right,row}=await openFilesFolder(page,request,"Workspace attach keys",{"notes.txt":"notes\n","readme.txt":"readme\n"});
  // Tab from the search field reaches the first file's row, then its attach control: a button of its own, not one inside the row.
  await right.getByPlaceholder("Search files…").click();
  await page.keyboard.press("Tab");
  await expect(row("notes.txt")).toBeFocused();
  await page.keyboard.press("Tab");
  const attach=right.getByRole("button",{name:"Attach notes.txt to chat",exact:true});
  await expect(attach).toBeFocused();
  await expect.poll(()=>attach.evaluate(node=>getComputedStyle(node).opacity)).toBe("1");
  expect(await attach.evaluate(node=>Boolean(node.parentElement.closest("button")))).toBe(false);
  await shootBothModes(page,"workspace-tree-attach-focus",{reopen:async()=>{await right.getByPlaceholder("Search files…").click();await page.keyboard.press("Tab");await page.keyboard.press("Tab");await expect(attach).toBeFocused()}});
  await page.keyboard.press("Enter");
  const chip=page.locator(".attachment-shelf > span").filter({hasText:"notes.txt"});
  await expect(chip).toBeVisible();
  // The attachment's remove button is named for its file; Shift+Tab from the composer reaches it and Enter removes the file.
  await page.getByTestId("composer").click();
  await page.keyboard.press("Shift+Tab");
  const remove=page.getByRole("button",{name:"Remove notes.txt",exact:true});
  await expect(remove).toBeFocused();
  await shootBothModes(page,"workspace-attachment-remove-focus",{reopen:async()=>{await page.getByTestId("composer").click();await page.keyboard.press("Shift+Tab");await expect(remove).toBeFocused()}});
  await page.keyboard.press("Enter");
  await expect(chip).toHaveCount(0);
});

// A Codex app server holding the given threads: enough for the sidebar to list them and for the app to open them.
async function startThreadHarness(threads){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    const thread=threads.find(item=>item.id===message.params?.threadId)||threads[0];
    const result=message.method==="initialize"?{userAgent:"workspace-fixture"}:message.method==="thread/list"?{data:threads,nextCursor:null}:message.method==="thread/resume"?{thread}
      :message.method==="thread/goal/get"?{goal:null}:message.method==="thread/continuity/get"?{continuity:null}:message.method==="thread/runtimeInstances/list"?{supported:false,currentInstanceId:null,items:[]}
      :message.method==="thread/unsubscribe"?{status:"unsubscribed"}:/\/list$/.test(message.method)?{data:[],nextCursor:null}:{};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  await new Promise((resolve,reject)=>http.listen(0,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+http.address().port+"/api/agent/ws",async close(){for(const ws of sockets)ws.terminate();wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("Back leaves a general chat opened while the Diff tab was shown, which keeps the Diff tab and says there is nothing to diff",async({page})=>{
  test.setTimeout(45_000);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const cwd=process.cwd(),now=Date.now()/1000;
  const project={id:"history-project",name:"History Project",path:cwd,environmentId:null};
  const thread=(id,name,age)=>({id,name,preview:name,cwd,model:"fixture-model",status:{type:"idle"},createdAt:now-age-60,updatedAt:now-age,turns:[]});
  const a=thread("thread-a","Project thread A",30),b=thread("thread-b","General thread B",10);
  const meta={[a.id]:{projectless:false,environmentId:null},[b.id]:{projectless:true,environmentId:null}};
  const harness=await startThreadHarness([a,b]);
  try{
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project.id};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"workspace-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],threadMeta:meta}));
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,{...settings,...(route.request().postDataJSON()||{})}):route.fallback());
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["fixture-model"],metadata:{provider:"openai",models:[{id:"fixture-model",name:"Fixture Model",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/thread-meta(?:\?|$)/,route=>{const id=new URL(route.request().url()).searchParams.get("threadId")||route.request().postDataJSON?.()?.threadId;return json(route,meta[id]||{projectless:false,environmentId:null})});
    await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,route.request().method()==="GET"?{checkpoints:[]}:{supported:false}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[project],project}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:true,root:cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],remotes:[],worktrees:[{path:cwd,branch:"main"}]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route("**/api/workspace/tree?**",route=>json(route,{entries:[{name:"notes.txt",path:"notes.txt",relativePath:"notes.txt",isFile:true,isDirectory:false,depth:0}],truncated:false}));
    await page.route("**/api/workspace/diff?**",route=>json(route,{isGit:true,status:" M notes.txt",diff:"diff --git a/notes.txt b/notes.txt\n",stderr:""}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=name=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
    const open=async item=>{await row(item.name).locator(".thread-main").click();await expect(row(item.name)).toHaveClass(/active/)};
    // The shortcuts act only when no text field has focus, as for a person who clicked away from the composer.
    const press=async keys=>{await page.evaluate(()=>document.activeElement?.blur?.());await page.keyboard.press(keys)};
    await open(a);
    await page.getByTestId("right-panel-toggle").click();
    const right=page.getByTestId("right-panel"),top=right.locator(".context-panel-tab-scroll"),inner=right.locator(".workspace-panel .panel-tabs");
    const diffTab=top.getByRole("button",{name:"Diff",exact:true}),filesTab=top.getByRole("button",{name:"Files",exact:true}),filesButton=inner.getByRole("button",{name:"Files",exact:true});
    const nothingToDiff=right.locator(".changes-empty").filter({hasText:"No repository changes"});
    await diffTab.click();
    await expect(right.locator(".changed-file-row")).toHaveCount(1);
    // The general chat keeps the Diff tab, as it keeps the Git tab, and says why it is empty; nothing claims Files.
    await open(b);
    await expect(diffTab).toHaveClass(/active/);await expect(diffTab).toBeDisabled();
    await expect(nothingToDiff).toContainText("General chats are not attached to a repository");
    await expect(inner.locator(".workspace-seg button")).toHaveText(["Files"]);
    await expect(filesButton).not.toHaveClass(/active/);
    await page.screenshot({animations:"disabled",path:auditDir+"workspace-general-chat-diff-dark-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"workspace-general-chat-diff-light-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Back returns to the project thread and its changes, and Forward to the general chat.
    await press("Control+BracketLeft");
    await expect(row(a.name)).toHaveClass(/active/);
    await expect(diffTab).toHaveClass(/active/);
    await expect(right.locator(".changed-file-row")).toHaveCount(1);
    await press("Control+BracketRight");
    await expect(row(b.name)).toHaveClass(/active/);
    await expect(nothingToDiff).toBeVisible();
    // Files there is one more step, and Back walks through the general chat's Diff step and on to the project thread.
    await filesTab.click();
    await expect(filesButton).toHaveClass(/active/);
    await expect(right.locator("[data-workspace-entry]")).toHaveText(["notes.txt"]);
    await press("Control+BracketLeft");
    await expect(row(b.name)).toHaveClass(/active/);
    await expect(nothingToDiff).toBeVisible();
    await press("Control+BracketLeft");
    await expect(row(a.name)).toHaveClass(/active/);
    await expect(diffTab).toHaveClass(/active/);
    await expect(right.locator(".changed-file-row")).toHaveCount(1);
    await page.screenshot({animations:"disabled",path:auditDir+"workspace-general-chat-back-to-project-dark-1280x800.png"});
  }finally{await harness.close()}
});

// The text a reader sees in each changed-file row's name (or, with `part` "path", its name and folder), left to right: the characters
// drawn inside every clipping box around them (a folder wrapped onto the row's hidden second line is not drawn), "…" for each run the
// list leaves out and for the browser's own ellipsis at the end of a clipped box, "▒" for a character drawn only in part, and a space
// wherever a visible gap parts two drawn pieces. Characters are measured one by one (one grapheme at a time), so a wide glyph counts
// as drawn only when all of it is.
function drawnChangedNames(right,part="name"){
  return right.locator(".changed-file-row .changed-file-"+part).evaluateAll(parts=>parts.map(element=>{
    const canvas=document.createElement("canvas").getContext("2d"),row=element.closest(".changed-file-row"),pieces=[];
    const inside=(rect,clip)=>rect.left>=clip.left-0.5&&rect.right<=clip.right+0.5&&rect.top>=clip.top-0.5&&rect.bottom<=clip.bottom+0.5;
    const overlaps=(rect,clip)=>rect.right>clip.left+0.5&&rect.left<clip.right-0.5&&rect.bottom>clip.top+0.5&&rect.top<clip.bottom-0.5;
    const clipOf=start=>{let clip={left:-Infinity,right:Infinity,top:-Infinity,bottom:Infinity};for(let box=start;box&&box!==row;box=box.parentElement){const style=getComputedStyle(box);if(style.overflowX!=="visible"||style.overflowY!=="visible"){const rect=box.getBoundingClientRect();clip={left:Math.max(clip.left,rect.left),right:Math.min(clip.right,rect.right),top:Math.max(clip.top,rect.top),bottom:Math.min(clip.bottom,rect.bottom)}}}return clip};
    const segmenter=new Intl.Segmenter(undefined,{granularity:"grapheme"}),walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      let box=node.parentElement;while(box!==element&&getComputedStyle(box).overflowX==="visible")box=box.parentElement;
      const style=getComputedStyle(box),own=box.getBoundingClientRect(),clip=clipOf(node.parentElement);
      const ellipsis=box.scrollWidth>box.clientWidth&&style.textOverflow==="ellipsis";
      canvas.font=style.font;const mark=ellipsis?canvas.measureText("…").width:0,limit={...clip,right:ellipsis?Math.min(clip.right,own.right-mark):clip.right},shown=[];
      for(const {segment,index} of segmenter.segment(node.data)){
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+segment.length);const rect=range.getBoundingClientRect();
        if(!rect.width)continue;
        if(inside(rect,limit))shown.push({text:segment,left:rect.left,right:rect.right});
        else if(!ellipsis&&overlaps(rect,clip))shown.push({text:"▒",left:rect.left,right:rect.right});
      }
      // A browser ellipsis never replaces the first character of its line: a box too narrow for both shows that character clipped.
      if(ellipsis&&!shown.length&&overlaps(own,clip))shown.push({text:"▒",left:own.left,right:own.left});
      if(ellipsis&&shown.length){const last=Math.max(...shown.map(piece=>piece.right));pieces.push({text:"…",left:last,right:last+mark})}
      pieces.push(...shown);
    }
    for(const cut of element.querySelectorAll(".changed-file-cut")){const rect=cut.getBoundingClientRect();if(rect.width&&inside(rect,clipOf(cut)))pieces.push({text:"…",left:rect.left,right:rect.right})}
    let text="",edge=null;
    for(const piece of pieces.sort((a,b)=>a.left-b.left)){if(edge!==null&&piece.left-edge>2)text+=" ";text+=piece.text;edge=piece.right}
    return text;
  }));
}

test("changed files too long for the Diff list keep the end that tells them apart in view",async({page,request})=>{
  test.setTimeout(60_000);
  // This checkout's untracked files as they stood when the list cut them all to "artifact_179…", beside long names that share their
  // start or their end, names that part far from a long shared end, and names shared in full by files in other folders.
  const status=[["??","artifact_1791317470236_d6b22939.png"],["??","artifact_1791317477991_ae1a8b66.png"],["??","artifact_1791317484338_7c659e6b.png"],["??","artifact_1791317494127_7b87f9be.png"],
    ["??","capcut-network-capture/"],["??","goal.md"],["??","google_startups_window.png"],[" M","ui/src/tool-activity.js"],["??","ui/src/tool-activity-summary.js"],[" M","tests/ui-tool-activity.test.mjs"],
    [" M","src/native-agent-session-recovery.mjs"],["??","src/native-agent-session-recorder.mjs"],[" M","package.json"],[" M","package-lock.json"],
    ["??","visual-audit/workspace-diff-long-names-dark-1280x800.png"],["??","visual-audit/workspace-diff-long-names-light-1280x800.png"],["??","visual-audit/workspace-diff-long-names-dark-1600x980.png"],["??","visual-audit/workspace-diff-long-names-light-1600x980.png"],
    [" M","packages/alpha/docker-compose.yml"],[" M","packages/beta/docker-compose.yml"],[" M","apps/web/playwright.config.mjs"],[" M","apps/desktop/playwright.config.mjs"],[" M","index.js"],[" M","lib/index.js"]];
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
    const drawn=await drawnChangedNames(right),rowsDrawn=await drawnChangedNames(right,"path"),shown=tag+": "+JSON.stringify(rowsDrawn);
    // No row shows half a character, every name reads as its own, and no two rows read alike, folders included.
    expect(rowsDrawn.filter(name=>name.includes("▒")),shown).toEqual([]);
    expect(new Set(rowsDrawn).size,shown).toBe(rowsDrawn.length);
    for(const [index,name] of names.entries())expect(name,tag).toMatch(readAs(drawn[index]));
    // A cut name keeps its extension: the four artifacts end in their own hashes, the tool-activity files in their own words, and the
    // four screenshots keep where they part ("dark" or "light") as well as their size.
    for(const [index,name] of names.entries())if(/\.\w+$/.test(name))expect(drawn[index],tag+": "+name).toMatch(/\.\w+$/);
    for(const index of [0,1,2,3])expect(drawn[index],shown).toMatch(/…\w{6,}\.png$/);
    for(const [index,end] of [[7,/activity\.js$/],[8,/summary\.js$/],[9,/test\.mjs$/]])expect(drawn[index],shown).toMatch(end);
    for(const [index,mode] of [[14,"dark"],[15,"light"],[16,"dark"],[17,"light"]])expect(drawn[index],shown).toMatch(new RegExp("…"+mode+"….*\\.png$"));
    // A name another file shares in full shows the folder that tells the two apart beside it, and so does the one at the top's twin.
    for(const [index,folder] of [[18,/alpha$/],[19,/beta$/],[20,/web$/],[21,/desktop$/],[23,/lib$/]])expect(rowsDrawn[index],shown).toMatch(folder);
    expect(rowsDrawn[22],shown).toBe("index.js");
    // The row still names the whole path, for the tooltip and for screen readers.
    for(const [index,[,path]] of status.entries())await expect(rows.nth(index).locator("button").first()).toHaveAttribute("aria-label",path);
    // The row's text is still the path: what the list leaves out is hidden, not removed.
    for(const [index,[,path]] of status.entries())await expect(rows.nth(index).locator(".changed-file-path")).toHaveText(path);
    await page.screenshot({animations:"disabled",path:auditDir+"workspace-diff-long-names-"+tag+".png",fullPage:true});
    await right.locator(".changed-files").screenshot({animations:"disabled",path:auditDir+"workspace-diff-long-names-list-"+tag+".png"});
  }
});

test.describe("at three times the pixel density",()=>{
  test.use({deviceScaleFactor:3});
  test("wide glyphs in a cut name are drawn whole, with the ellipsis where characters are left out",async({page,request})=>{
    test.setTimeout(45_000);
    const status=[["??","设计稿-最终版-第二次修改.png"],["??","设计稿-最终版-第三次修改.png"],["??","résumé-final-version-2026.pdf"],["??","résumé-final-version-2025.pdf"]];
    await page.route("**/api/workspace/diff?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,status:status.map(([code,path])=>code+" "+path).join("\n"),diff:"diff --git a/x b/x\n",stderr:""})}));
    await page.setViewportSize({width:1280,height:800});
    const {right,top}=await openProjectInspector(page,request,"Workspace wide glyphs");
    await top.getByRole("button",{name:"Diff",exact:true}).click();
    await expect(right.locator(".changed-file-row")).toHaveCount(status.length);
    for(const mode of ["dark","light"]){
      await page.evaluate(mode=>{document.documentElement.dataset.mode=mode},mode);
      await expect.poll(async()=>(await drawnChangedNames(right)).every(name=>name.includes("…")),mode+": the names are cut").toBe(true);
      const drawn=await drawnChangedNames(right),shown=mode+": "+JSON.stringify(drawn);
      expect(drawn.filter(name=>name.includes("▒")),shown).toEqual([]);
      expect(new Set(drawn).size,shown).toBe(drawn.length);
      expect(drawn[0],shown).toMatch(/…[^…]*第二次修改\.png$/);expect(drawn[1],shown).toMatch(/…[^…]*第三次修改\.png$/);
      expect(drawn[2],shown).toMatch(/^résu.*…2026\.pdf$/u);expect(drawn[3],shown).toMatch(/^résu.*…2025\.pdf$/u);
      // Nothing is drawn past the row's own box.
      const overflow=await right.locator(".changed-file-row .changed-file-name").evaluateAll(names=>names.map(name=>name.scrollWidth-name.clientWidth));
      expect(overflow,shown).toEqual(overflow.map(()=>0));
      await right.locator(".changed-files").screenshot({animations:"disabled",path:auditDir+"workspace-diff-wide-glyphs-list-"+mode+"-1280x800-x3.png"});
    }
  });
});
