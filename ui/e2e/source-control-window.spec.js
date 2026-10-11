import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const execFileAsync=promisify(execFile);

// A throwaway repository with one tracked change, registered as a project; close() restores the runtime and active-project settings and removes both.
async function commitWriterFixture(request,name){
  const root=await mkdtemp(join(tmpdir(),"trebell-source-writer-")),git=args=>execFileAsync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  await git(["init"]);await git(["config","user.email","trebell-test@example.invalid"]);await git(["config","user.name","Trebell Test"]);
  await writeFile(join(root,"notes.txt"),"before\n","utf8");await git(["add","notes.txt"]);await git(["commit","-m","Seed notes"]);await writeFile(join(root,"notes.txt"),"after\n","utf8");
  const previous=await (await request.get("/api/settings")).json();
  const {project}=await (await request.post("/api/projects",{data:{path:root,name}})).json();
  return {async close(){
    await request.post("/api/settings",{data:{agentRuntime:previous.agentRuntime||"codex",agentRuntimeInstanceId:previous.agentRuntimeInstanceId||null,modelProvider:previous.modelProvider||"openai",activeProjectId:previous.activeProjectId||null}}).catch(()=>{});
    if(project?.id)await request.delete("/api/projects?id="+encodeURIComponent(project.id)).catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }};
}

for(const [runtime,writer] of [["native","OpenAI API"],["codex","Codex"]]){
  test(`Generate names ${writer} as the commit text writer, as the server reports`,async({page,request})=>{
    test.setTimeout(40_000);
    const name="Source control writer "+runtime,fixture=await commitWriterFixture(request,name);
    try{
      await request.post("/api/settings",{data:{onboardingComplete:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai"}});
      await page.goto("/");await page.getByRole("button",{name:"Projects",exact:true}).click();
      const project=page.locator(".project-card").filter({hasText:name});await expect(project).toBeVisible();await project.locator(".project-open").click();
      await page.getByTestId("right-panel-toggle").click();const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
      // Trebell Native writes with its model provider; any other runtime writes with the harness itself.
      const generate=right.getByRole("button",{name:"Generate with "+writer,exact:true});await expect(generate).toBeVisible({timeout:10_000});
      const reply=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/git/commit-message");
      await generate.click();
      const response=await reply;expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({message:"Mock generated commit",runtime,generatedWith:writer});
      await expect(right.getByPlaceholder("Commit message")).toHaveValue("Mock generated commit");
    }finally{await fixture.close()}
  });
}

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

  // Footers count what is shown ("mounted" was a React word for it). A has: locator is matched inside each footer, so it starts
  // from page rather than from the panel.
  const footer=label=>right.locator(".source-window-footer").filter({has:page.getByRole("button",{name:label})}).locator("span");
  await expect(footer("Show 60 more changes")).toHaveText("60 of 200 shown");
  await expect(footer("Show 60 more PRs")).toHaveText("60 of 150 shown");
  await right.getByRole("button",{name:"Show 60 more changes"}).click();
  await expect(right.locator(".status-list > div")).toHaveCount(120);
  await expect(footer("Show 60 more changes")).toHaveText("120 of 200 shown");
  await right.getByRole("button",{name:"Show 60 more PRs"}).click();
  await expect(right.locator(".pr-list > button")).toHaveCount(120);
  await expect(footer("Show 30 more PRs")).toHaveText("120 of 150 shown");

  await right.getByRole("button",{name:/#1 Stress PR 001/}).click();
  await expect(right.locator(".pr-file")).toHaveCount(60);
  await expect(right.getByRole("button",{name:"Show 60 more files"})).toBeVisible();
  await expect(footer("Show 60 more files")).toHaveText("60 of 180 shown");
  await right.getByRole("button",{name:"Show 60 more files"}).click();
  await expect(right.locator(".pr-file")).toHaveCount(120);
  await expect(right.locator(".pr-detail .source-window-footer span")).toHaveText("120 of 180 shown");
  await expect(right.getByText(/\bmounted\b/)).toHaveCount(0);

  await page.setViewportSize({width:1280,height:800});
  await right.scrollIntoViewIfNeeded();
  const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-windowing-dark-1280x800.png",fullPage:true});
});

test("source control keeps the last-known Git version visible during diagnostics refresh",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control refresh state"}});

  const gitInfo={isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]};
  const diagnostics={selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  let diagnosticsCalls=0,resolveSecondStarted,resolveSecondRelease;
  const secondStarted=new Promise(resolve=>{resolveSecondStarted=resolve});
  const secondRelease=new Promise(resolve=>{resolveSecondRelease=resolve});
  await page.route("**/api/git/info?**",route=>json(route,gitInfo));
  await page.route("**/api/source-control/diagnostics?**",async route=>{
    diagnosticsCalls++;
    if(diagnosticsCalls===2){resolveSecondStarted();await secondRelease}
    return json(route,diagnostics);
  });
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:diagnostics.capabilities.github,items:[]}));
  await page.route("**/api/git/action",route=>json(route,{ok:true,result:{info:gitInfo}}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control refresh state"});
  await expect(project).toBeVisible();await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
  await expect(right.getByText("Git: git version fixture",{exact:true})).toBeVisible();

  await right.getByRole("button",{name:"Fetch",exact:true}).click();
  await secondStarted;
  await expect(right.getByText("Git: git version fixture",{exact:true})).toBeVisible();
  await expect(right.getByText("Git: checking…",{exact:true})).toHaveCount(0);
  resolveSecondRelease();
  await expect(right.getByRole("button",{name:"Fetch",exact:true})).toBeEnabled();
  expect(diagnosticsCalls).toBe(2);
});

test("linked thread refresh failures retain last-known-good data for the same pull request",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control reliability"}});

  const pr={provider:"github",number:7,title:"Reliability PR",state:"OPEN",url:"https://example.test/pr/7",headRefName:"reliability",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"owner/repo",number:7}};
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:[pr]}));
  await page.route("**/api/source-control/pr-detail?**",route=>json(route,{provider:"github",item:{...pr,body:"Reliability fixture.",comments:[],reviews:[],files:[],statusCheckRollup:[]}}));
  await page.route("**/api/source-control/pr-viewed?**",route=>json(route,{provider:"github",store:"host",files:[]}));
  let reverseReads=0;
  await page.route(/\/api\/source-control\/thread-link\?/,route=>{
    reverseReads++;
    if(reverseReads===1)return json(route,{threads:[{threadId:"thread-stable",title:"Stable review thread",archived:false}]});
    return json(route,{error:"Deliberate reverse-link refresh failure"},500);
  });

  await page.goto("/");await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control reliability"});await expect(project).toBeVisible();await project.locator(".project-open").click();await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
  const prButton=right.getByRole("button",{name:/#7 Reliability PR/});await expect(prButton).toBeVisible();await prButton.click();await expect(right.getByText("Stable review thread")).toBeVisible();
  await prButton.click();await expect(right.getByText("Stable review thread")).toBeVisible();await expect(right.getByRole("alert")).toHaveText("Could not load linked threads: Deliberate reverse-link refresh failure");expect(reverseReads).toBe(2);
  await page.setViewportSize({width:1280,height:800});await right.scrollIntoViewIfNeeded();const metrics=await right.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"source-control-linked-thread-refresh-failure-1280x800.png",fullPage:true});
});

test("the Git panel lines its loading and clean text up with its rows, ends a long branch in an ellipsis and leads worktrees with their folder",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control layout"}});

  const branch="feature/inspector-review/keep-the-current-branch-readable-when-it-is-long",parent="C:/Users/developer/AppData/Local/Trebell/devspace/worktrees/";
  // The last two follow the common <repo>-<branch> layout: folder and branch names that differ only at their end.
  const worktrees=[{path:boot.cwd,branch},{path:parent+"Trebell-0c178972",branch:"trebell/thread-0c178972"},{path:parent+"Trebell-0d63a1b4",branch:"trebell/thread-0d63a1b4-review-the-inspector-panels"},{path:parent+"docs",branch:"docs"},
    {path:parent+"trebell-feature-inspector-review-panels",branch:"feature/inspector-review-panels"},{path:parent+"trebell-feature-inspector-review-polish",branch:"feature/inspector-review-polish"}];
  let status=[],releaseInfo;const infoHeld=new Promise(resolve=>{releaseInfo=resolve});
  const info=()=>({isGit:true,root:boot.cwd,branch,branches:["main",branch],upstream:"origin/"+branch,status,worktrees,remotes:[{name:"origin",url:"https://example.test/repo.git"}]});
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",async route=>{await infoHeld;return json(route,info())});
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:[]}));
  await page.route("**/api/git/action",route=>json(route,{ok:true,result:{info:info()}}));

  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control layout"});
  await expect(project).toBeVisible();await project.locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();

  // Where a reader sees text start: the drawn text of a line, and the inside of the commit message box under the list.
  const textLeft=locator=>locator.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().left});
  const messageLeft=await right.locator(".commit-box textarea").evaluate(node=>{const style=getComputedStyle(node);return node.getBoundingClientRect().left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)});
  const loading=right.locator(".status-list > .sc-loading");
  await expect(loading).toHaveText("Loading changes…");
  expect(Math.abs(await textLeft(loading)-messageLeft)).toBeLessThanOrEqual(1);
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-loading-dark-1280x800.png",fullPage:true});
  releaseInfo();
  const clean=right.locator(".status-list > .sc-clean");
  await expect(clean).toHaveText("Working tree clean.");
  const cleanLeft=await textLeft(clean);
  expect(Math.abs(cleanLeft-messageLeft)).toBeLessThanOrEqual(1);
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-clean-dark-1280x800.png",fullPage:true});
  // The clean text starts where a changed row's badge does once the tree has a change.
  status=[{code:" M",path:"src/app.js"}];
  await right.getByRole("button",{name:"Fetch",exact:true}).click();
  const badge=right.locator(".status-list > div code");
  await expect(badge).toHaveText("M");
  expect(Math.abs(await badge.evaluate(node=>node.getBoundingClientRect().left)-cleanLeft)).toBeLessThanOrEqual(1);

  // The branch is too long for its select: it ends in an ellipsis, and the tooltip names all of it.
  const select=right.getByRole("combobox",{name:"Current branch"});
  await expect(select).toHaveValue(branch);
  expect(await select.getAttribute("title")).toContain(branch);
  const fit=await select.evaluate(node=>{
    const style=getComputedStyle(node),probe=document.createElement("span");probe.textContent=node.selectedOptions[0].text;
    Object.assign(probe.style,{position:"absolute",visibility:"hidden",whiteSpace:"pre",fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,letterSpacing:style.letterSpacing});
    document.body.append(probe);const text=probe.getBoundingClientRect().width;probe.remove();
    return {text,room:node.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),textOverflow:style.textOverflow};
  });
  expect(fit.text).toBeGreaterThan(fit.room);
  expect(fit.textOverflow).toBe("ellipsis");

  // Worktrees share one long parent folder: each row leads with its own folder and its tooltip is the full path. The parent follows
  // on the same line only where it fits or has room for a few characters before its ellipsis.
  const rows=right.locator(".worktree-row");
  await expect(rows).toHaveCount(worktrees.length);
  for(const [index,worktree] of worktrees.entries())await expect(rows.nth(index)).toHaveAttribute("title",worktree.path);
  await expect(rows.locator(".worktree-name")).toHaveText([/./,"Trebell-0c178972","Trebell-0d63a1b4","docs","trebell-feature-inspector-review-panels","trebell-feature-inspector-review-polish"]);
  // The text a reader sees in an element: the characters drawn inside every clipping box, with "…" where an ellipsis cuts a part.
  const drawn=locator=>locator.evaluate(element=>{
    const canvas=document.createElement("canvas").getContext("2d"),row=element.closest(".worktree-row");let text="";
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      const parent=node.parentElement,style=getComputedStyle(parent);if(style.display==="none")continue;
      let clip=parent.getBoundingClientRect();
      for(let box=parent.parentElement;box&&box!==row.parentElement;box=box.parentElement)if(getComputedStyle(box).overflowX!=="visible"){const rect=box.getBoundingClientRect();clip={left:Math.max(clip.left,rect.left),right:Math.min(clip.right,rect.right)}}
      const cut=parent.scrollWidth>parent.clientWidth;canvas.font=style.font;
      const end=cut?parent.getBoundingClientRect().right-canvas.measureText("…").width:clip.right;let shown="";
      for(let index=0;index<node.length;index++){const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);const rect=range.getBoundingClientRect();if(rect.left>=clip.left-0.5&&rect.right<=Math.min(clip.right,end)+0.5)shown+=node.data[index]}
      // An ellipsis never replaces the first character of a line: a box with no room for both shows that character, clipped.
      text+=cut&&!shown?node.data.slice(0,1):shown+(cut?"…":"");
    }
    return text;
  });
  // The text a drawn one can stand for: its pieces in order, with at least one character left out where an ellipsis stands.
  const readAs=shown=>new RegExp("^"+shown.split("…").map(piece=>piece.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".+")+"$");
  const placement=()=>rows.locator("code").evaluateAll(nodes=>nodes.map(node=>{
    const name=node.querySelector(".worktree-name"),dir=node.querySelector(".worktree-dir"),box=node.getBoundingClientRect(),own=name.getBoundingClientRect(),rest=dir.getBoundingClientRect();
    const shown=rest.width>0&&rest.top<box.bottom-1,room=parseFloat(getComputedStyle(dir).fontSize)*4.5;
    return {inside:own.right<=box.right+1,first:own.left<=rest.left,parent:!shown?"hidden":dir.scrollWidth>dir.clientWidth?"cut":"whole",
      fits:!shown||(rest.right<=box.right+1&&rest.width>=Math.min(room,dir.scrollWidth)-1)};
  }));
  const checkPlacement=async()=>{
    const placed=await placement();
    expect(placed.map(({inside,first,fits})=>({inside,first,fits}))).toEqual(worktrees.map(()=>({inside:true,first:true,fits:true})));
    expect(placed[3].parent).toBe("cut");
    // Short folders show whole. Folder and branch names too long for the row keep the end where they differ from their sibling in
    // view, after an ellipsis that stands for the start they share, so the two rows never read alike.
    for(const index of [1,2,3])expect(await drawn(rows.nth(index).locator(".worktree-name"))).toBe(worktrees[index].path.split("/").pop());
    const names=[await drawn(rows.nth(4).locator(".worktree-name")),await drawn(rows.nth(5).locator(".worktree-name"))];
    expect(names[0]).toMatch(/^trebell-.+…panels$/);expect(names[1]).toMatch(/^trebell-.+…polish$/);
    const branches=[await drawn(rows.nth(4).locator(":scope > span")),await drawn(rows.nth(5).locator(":scope > span"))];
    expect(branches[0]).toMatch(/^feature\/.+…panels$/);expect(branches[1]).toMatch(/^feature\/.+…polish$/);
    // Every folder and branch reads as itself, from its own start: a cut start shows its ellipsis and never runs into the end it
    // keeps ("f" + "review/…" would read "freview/…"). A start with room beside the part that differs is not cut at all.
    for(const [index,worktree] of worktrees.entries()){
      expect(worktree.path.split(/[\\/]/).pop()).toMatch(readAs(await drawn(rows.nth(index).locator(".worktree-name"))));
      expect(worktree.branch).toMatch(readAs(await drawn(rows.nth(index).locator(":scope > span"))));
    }
    expect(await drawn(rows.nth(2).locator(":scope > span"))).toMatch(/^trebell\/thread-0d63a1b4.*…$/);
  };
  await checkPlacement();
  // A cut branch names itself in full in its tooltip, as the row does with its path.
  await expect(rows.nth(4).locator(":scope > span")).toHaveAttribute("title","feature/inspector-review-panels");
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-layout-dark-1280x800.png",fullPage:true});
  const worktreeShot=async path=>{const first=await rows.first().boundingBox(),last=await rows.last().boundingBox();await page.screenshot({animations:"disabled",path,clip:{x:first.x-8,y:first.y-8,width:first.width+16,height:last.y+last.height-first.y+16}})};
  await rows.last().scrollIntoViewIfNeeded();
  await worktreeShot(auditDir+"source-control-worktrees-dark-1280x800.png");

  // Copying a path or a branch from its row gives it as written, on one line, separators included, although the folder is drawn
  // before its parent and a cut name is in two parts.
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  const copied=async locator=>{
    await locator.evaluate(node=>{const selection=getSelection();selection.removeAllRanges();selection.selectAllChildren(node)});
    await page.keyboard.press("Control+C");
    return page.evaluate(()=>navigator.clipboard.readText());
  };
  expect(await copied(rows.nth(1).locator("code"))).toBe(worktrees[1].path);
  expect(await copied(rows.nth(5).locator("code"))).toBe(worktrees[5].path);
  expect(await copied(rows.nth(4).locator(":scope > span"))).toBe("feature/inspector-review-panels");
  // The same by hand: a drag across the drawn path (folder first, so its end is the parent's), a triple-click on a cut folder name
  // and a double-click on a cut branch each select the whole path or branch and copy it as written.
  const copy=async()=>{await page.keyboard.press("Control+C");return page.evaluate(()=>navigator.clipboard.readText())};
  for(const [index,backwards] of [[1,false],[2,true]]){
    const box=await rows.nth(index).locator("code").boundingBox(),y=box.y+box.height/2,[from,to]=backwards?[box.x+box.width-1,box.x+1]:[box.x+1,box.x+box.width-1];
    await page.mouse.move(from,y);await page.mouse.down();await page.mouse.move(to,y,{steps:6});await page.mouse.up();
    expect(await copy()).toBe(worktrees[index].path);
  }
  await rows.nth(4).locator(".worktree-name").click({clickCount:3});
  expect(await copy()).toBe(worktrees[4].path);
  await rows.nth(5).locator(":scope > span").click({clickCount:2});
  expect(await copy()).toBe(worktrees[5].branch);
  await page.evaluate(()=>getSelection().removeAllRanges());

  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await checkPlacement();
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-layout-light-1280x800.png",fullPage:true});
  await worktreeShot(auditDir+"source-control-worktrees-light-1280x800.png");
});

test("Generate failures name the text that could not be written, unless the writer already did",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control text errors"}});
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[{code:" M",path:"src/app.js"}],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://example.test/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:[]}));
  // What the server answers when the writer fails: a Native provider's bare reason, or a harness writer's own sentence.
  let reason="fetch failed";
  await page.route("**/api/git/commit-message",route=>json(route,{error:reason},400));
  await page.route("**/api/git/review-text",route=>json(route,{error:reason},400));

  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:"Source control text errors"});
  await expect(project).toBeVisible();await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
  const generate=right.getByRole("button",{name:/^Generate with /}),generatePr=right.getByRole("button",{name:"Generate PR",exact:true}),alert=right.locator(".source-control-error");
  await expect(right.locator(".status-list > div")).toHaveCount(1);

  await generate.click();
  await expect(alert).toHaveText("Could not generate the commit message: fetch failed");
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-generate-error-1280x800.png"});
  await generatePr.click();
  await expect(alert).toHaveText("Could not generate the pull request text: fetch failed");
  // A harness reply that says nothing of what it was writing gets the action too.
  reason="OpenCode returned an empty reply. Try again.";
  await generate.click();
  await expect(alert).toHaveText("Could not generate the commit message: OpenCode returned an empty reply. Try again.");
  // A harness writer's own error already names the Git text it could not write, so it is not prefixed a second time.
  for(const harnessError of ["OpenCode could not write the Git text: Payment Required: Insufficient balance.","OpenCode did not return the Git text within 90 seconds. Try again, or choose a faster OpenCode model."]){
    reason=harnessError;
    await generate.click();
    await expect(alert).toHaveText(harnessError);
    await generatePr.click();
    await expect(alert).toHaveText(harnessError);
  }
});
