import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
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

// The diagnostics ask every code host's CLI how it is (gh, glab, tea, fj, az: the Azure CLI alone took seconds here), but the list
// of pull requests needs only the host the remote names. Held diagnostics must not hold the list: it shows while they still check.
test("the pull requests show while the code host diagnostics are still checking",async({page,request})=>{
  test.setTimeout(35_000);
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  const {project:registered}=await (await request.post("/api/projects",{data:{path:boot.cwd,name:"Source control pull requests first"}})).json();
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const capabilities={create:true,comment:true,review:true,merge:true};
  const prs=[1,2].map(number=>({provider:"github",number,title:"Fixture pull request "+number,state:"OPEN",url:"https://example.test/pr/"+number,headRefName:"feature-"+number,baseRefName:"main"}));
  let releaseDiagnostics=()=>{};const diagnosticsHeld=new Promise(resolve=>{releaseDiagnostics=resolve});
  const prRequests=[];
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",kind:"fetch",url:"https://github.com/owner/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",async route=>{await diagnosticsHeld;return json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:capabilities}})});
  await page.route("**/api/source-control/prs?**",route=>{prRequests.push(new URL(route.request().url()).searchParams.get("provider"));return json(route,{ok:true,provider:"github",capabilities,items:prs})});
  try{
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    const project=page.locator(".project-card").filter({hasText:"Source control pull requests first"});
    await expect(project).toBeVisible();await project.locator(".project-open").click();
    await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();
    await page.getByTestId("right-panel-toggle").click();
    const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
    await expect(right.getByRole("button",{name:/#1 Fixture pull request 1/})).toBeVisible();
    await expect(right.getByRole("button",{name:/#2 Fixture pull request 2/})).toBeVisible();
    await expect(right.getByText("Loading pull requests…")).toHaveCount(0);
    await expect(right.getByText("Git: checking…",{exact:true})).toBeVisible();
    await right.screenshot({animations:"disabled",path:auditDir+"source-control-prs-before-diagnostics.png"});
    // With no host chosen the server lists the remote's own (github here), as the diagnostics would have chosen.
    expect(prRequests).toEqual([null]);
    releaseDiagnostics();
    await expect(right.getByText("Git: git version fixture",{exact:true})).toBeVisible();
    await expect(right.getByRole("button",{name:/#1 Fixture pull request 1/})).toBeVisible();
  }finally{
    releaseDiagnostics();await page.unrouteAll({behavior:"ignoreErrors"});
    if(registered?.id)await request.delete("/api/projects?id="+encodeURIComponent(registered.id)).catch(()=>{});
  }
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
  // before its parent and a cut name is in two parts. The copy goes to a clipboard of the page's own: Ctrl+C is kept from the
  // machine's clipboard, and the copy event the browser would send goes, with the page's own data, to where the selection starts.
  // What the row hands over, or the selection when nothing takes the event, is what was copied; nativeCopies counts the copies the
  // browser itself made.
  await page.evaluate(()=>{
    window.__clipboard={text:null,nativeCopies:0};
    document.addEventListener("copy",event=>{if(event.isTrusted)window.__clipboard.nativeCopies++},true);
    document.addEventListener("keydown",event=>{
      if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=="c")return;
      event.preventDefault();
      const selection=getSelection(),start=selection.rangeCount?selection.getRangeAt(0).startContainer:document.body,data=new DataTransfer();
      const taken=!(start.nodeType===Node.ELEMENT_NODE?start:start.parentElement).dispatchEvent(new ClipboardEvent("copy",{clipboardData:data,bubbles:true,cancelable:true,composed:true}));
      window.__clipboard.text=taken?data.getData("text/plain"):selection.toString();
    },true);
  });
  const copy=async()=>{await page.keyboard.press("Control+C");return page.evaluate(()=>window.__clipboard.text)};
  const copied=async locator=>{
    await locator.evaluate(node=>{const selection=getSelection();selection.removeAllRanges();selection.selectAllChildren(node)});
    return copy();
  };
  expect(await copied(rows.nth(1).locator("code"))).toBe(worktrees[1].path);
  expect(await copied(rows.nth(5).locator("code"))).toBe(worktrees[5].path);
  expect(await copied(rows.nth(4).locator(":scope > span"))).toBe("feature/inspector-review-panels");
  // The same by hand: a drag across the drawn path (folder first, so its end is the parent's), a triple-click on a cut folder name
  // and a double-click on a cut branch each select the whole path or branch and copy it as written.
  for(const [index,backwards] of [[1,false],[2,true]]){
    const box=await rows.nth(index).locator("code").boundingBox(),y=box.y+box.height/2,[from,to]=backwards?[box.x+box.width-1,box.x+1]:[box.x+1,box.x+box.width-1];
    await page.mouse.move(from,y);await page.mouse.down();await page.mouse.move(to,y,{steps:6});await page.mouse.up();
    expect(await copy()).toBe(worktrees[index].path);
  }
  await rows.nth(4).locator(".worktree-name").click({clickCount:3});
  expect(await copy()).toBe(worktrees[4].path);
  await rows.nth(5).locator(":scope > span").click({clickCount:2});
  expect(await copy()).toBe(worktrees[5].branch);
  expect(await page.evaluate(()=>window.__clipboard.nativeCopies),"copies to the machine's clipboard").toBe(0);
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

// Opens the Git panel of a project registered under `name` (the checkout, or the folder at `path`).
async function openGitPanel(page,request,name,path=null){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:path||boot.cwd,name}});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const project=page.locator(".project-card").filter({hasText:name});
  await expect(project).toBeVisible();await project.locator(".project-open").click();
  await page.getByTestId("right-panel-toggle").click();
  const right=page.getByTestId("right-panel");await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  return {boot,right,changes:right.locator(".sc-card").filter({has:page.getByRole("heading",{name:/^Changes/})}),repository:right.locator(".sc-card").filter({has:page.getByRole("heading",{name:"Repository"})}),pulls:right.locator(".pr-card")};
}
// What the panel must never say before the matching read has answered ("Detected: unknown" is the answer once detection failed).
const EMPTY_CLAIMS=[/Git: not found/,/^Changes\s*0$/,/Root: —/,/Upstream: —/,/No pull requests found/,/Working tree clean/,/client\/credentials missing/,/Detected: unknown/];
async function expectNoEmptyClaims(right,claims=EMPTY_CLAIMS){
  const text=await right.locator(".source-control").evaluate(node=>[...node.querySelectorAll("h3,p,strong,option")].map(item=>item.textContent.replace(/\s+/g," ").trim()));
  for(const claim of claims)expect(text.filter(line=>claim.test(line)),String(claim)).toEqual([]);
}

test("the Git panel says what it is still reading, and never an empty answer, until each read answers",async({page,request})=>{
  test.setTimeout(45_000);
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  // Each read waits for its own release, so every stage of the first load can be read.
  const gate=()=>{let open;const opened=new Promise(resolve=>{open=resolve});return {opened,open}};
  const infoGate=gate(),diagnosticsGate=gate(),prsGate=gate();
  const capabilities={create:true,comment:true,review:true,merge:true};
  let prs={provider:"github",capabilities,items:[]};
  const boot=await (await request.get("/api/bootstrap")).json();
  await page.route("**/api/git/info?**",async route=>{await infoGate.opened;return json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[{code:" M",path:"src/app.js"}],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]})});
  await page.route("**/api/source-control/diagnostics?**",async route=>{await diagnosticsGate.opened;return json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:capabilities}})});
  await page.route("**/api/source-control/prs?**",async route=>{await prsGate.opened;return json(route,prs)});
  const {right,changes,repository,pulls}=await openGitPanel(page,request,"Source control first load");

  // Nothing has answered: each part says it is loading.
  await expect(changes.locator(".sc-loading")).toHaveText("Loading changes…");
  await expect(changes.getByRole("heading")).toHaveText("Changes");
  await expect(repository).toContainText("Root: checking…");
  await expect(repository).toContainText("Upstream: checking…");
  await expect(repository).toContainText("Git: checking…");
  await expect(repository).toContainText("Detecting the code host…");
  await expect(pulls.locator(".pr-loading")).toHaveText("Loading pull requests…");
  await expect(pulls.locator(".pr-loading")).toHaveAttribute("aria-busy","true");
  await expectNoEmptyClaims(right);
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-first-load-dark-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-first-load-light-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

  // The repository answers: its changes, root and upstream show at once, while Git, the code host and the pull requests are still read.
  infoGate.open();
  await expect(changes.getByRole("heading")).toHaveText("Changes 1");
  await expect(changes.locator(".status-list > div")).toHaveCount(1);
  await expect(repository.locator("p").filter({hasText:"Root:"}).locator("code")).toHaveText(boot.cwd);
  await expect(repository.locator("p").filter({hasText:"Upstream:"}).locator("code")).toHaveText("origin/main");
  await expect(repository).toContainText("Git: checking…");
  await expect(pulls.locator(".pr-loading")).toBeVisible();
  await expectNoEmptyClaims(right);
  diagnosticsGate.open();
  await expect(repository).toContainText("Git: git version fixture");
  await expect(repository).toContainText("GitHub · authenticated");
  await expect(pulls.locator(".pr-loading")).toBeVisible();
  await expectNoEmptyClaims(right);
  await pulls.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-loading-light-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-loading-dark-1280x800.png",fullPage:true});
  // Only the answered list says it is empty.
  prsGate.open();
  await expect(pulls.locator(".pr-empty-state")).toContainText("No pull requests found");
  await expect(pulls.locator(".pr-loading")).toHaveCount(0);
  // A host client that could not list them answers ok:false: that is a failure, not an empty list. Refreshing keeps the last answer
  // on screen until the new one lands.
  prs={ok:false,provider:"github",capabilities,items:[],error:"gh: To get started with GitHub CLI, please run: gh auth login"};
  await pulls.getByRole("button",{name:"Refresh pull requests"}).click();
  const failed=pulls.locator(".pr-empty-state.error");
  await expect(failed).toContainText("Could not list pull requests");
  await expect(failed).toContainText("gh auth login");
  await expect(right.getByText("No pull requests found")).toHaveCount(0);
  await pulls.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-failed-dark-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-failed-light-1280x800.png",fullPage:true});
});

test("a Git panel whose first reads fail says so, instead of loading for ever or answering empty",async({page,request})=>{
  test.setTimeout(35_000);
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  let failInfo=true;const boot=await (await request.get("/api/bootstrap")).json();
  const info={isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:null,status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git"}]};
  await page.route("**/api/git/info?**",route=>failInfo?json(route,{error:"Deliberate repository read failure"},400):json(route,info));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{error:"Deliberate diagnostics failure"},400));
  await page.route("**/api/source-control/prs?**",route=>json(route,{provider:"github",capabilities:{create:true},items:[]}));
  const {right,changes,repository,pulls}=await openGitPanel(page,request,"Source control failed load");
  await expect(right.locator(".source-control-error")).toHaveText("Could not refresh repository information: Deliberate repository read failure");
  await expect(changes.locator(".sc-unavailable")).toHaveText("Changes unavailable.");
  await expect(right.getByRole("combobox",{name:"Current branch"})).not.toHaveAttribute("aria-busy","true");
  await expect(right.getByRole("combobox",{name:"Current branch"}).locator("option")).toHaveText(["Branches unavailable"]);
  await expect(repository).toContainText("Root: unknown");
  await expect(repository).toContainText("Git: unknown");
  // The pull requests were never asked for: the card says they wait on the repository and leaves its failure to the banner, and Git
  // (never checked) names no failure of its own.
  const unread=pulls.locator(".pr-empty-state");
  await expect(unread).toContainText("Pull requests unavailable");
  await expect(unread).toContainText("They are listed once the repository can be read.");
  await expect(unread).not.toHaveClass(/error/);
  await expect(right.getByText("Deliberate repository read failure")).toHaveCount(1);
  await expect(right.getByText("Could not list pull requests")).toHaveCount(0);
  await expect(repository.locator("p").filter({hasText:"Git:"})).not.toHaveAttribute("title",/.+/);
  await expect(right.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(right.getByText(/checking…|Loading/)).toHaveCount(0);
  await expectNoEmptyClaims(right,EMPTY_CLAIMS.filter(claim=>!claim.test("Detected: unknown")));
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-first-load-failed-dark-1280x800.png",fullPage:true});
  await pulls.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-first-load-failed-pulls-light-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  // Once the repository reads, its parts answer; Git stays unknown (its check failed) and names the failure in its title.
  failInfo=false;
  await pulls.getByRole("button",{name:"Refresh pull requests"}).click();
  await expect(changes.locator(".sc-clean")).toHaveText("Working tree clean.");
  await expect(repository.locator("p").filter({hasText:"Upstream:"}).locator("code")).toHaveText("none");
  const git=repository.locator("p").filter({hasText:"Git:"});
  await expect(git).toHaveText("Git: unknown");
  await expect(git).toHaveAttribute("title","Could not check Git: Deliberate diagnostics failure");
  await expect(pulls.locator(".pr-empty-state")).toContainText("No pull requests found");
});

test("a pull-request list that fails for a repository with a remote is named once, by the banner",async({page,request})=>{
  test.setTimeout(35_000);
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  const boot=await (await request.get("/api/bootstrap")).json(),reason="Could not identify this Git host. Choose GitHub, GitLab, Forgejo/Gitea, Bitbucket, or Azure DevOps.";
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://git.example.invalid/owner/repo.git"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:null,detectedProvider:"unknown",git:{version:"git version fixture"},providers:{},capabilities:{}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{error:reason},400));
  const {right,pulls}=await openGitPanel(page,request,"Source control pull requests failed");
  await expect(right.locator(".source-control-error")).toHaveText("Could not refresh pull requests: "+reason);
  // The card says the list is unavailable and points at the banner, which stays pinned above it, instead of repeating the reason.
  const unavailable=pulls.locator(".pr-empty-state");
  await expect(unavailable).toContainText("Pull requests unavailable");
  await expect(unavailable).toContainText("the message above says why");
  await expect(unavailable).not.toHaveClass(/error/);
  await expect(right.getByText(reason)).toHaveCount(1);
  await expect(right.getByText("No pull requests found")).toHaveCount(0);
  await page.setViewportSize({width:1600,height:980});
  await pulls.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-failed-with-remote-dark-1600x980.png"});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-pull-requests-failed-with-remote-light-1600x980.png"});
});

test("a detached HEAD is the branch list's selection, not the first branch",async({page,request})=>{
  test.setTimeout(35_000);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const boot=await (await request.get("/api/bootstrap")).json();
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:null,branches:["backup/pre-benchmark-message-cleanup","main"],upstream:null,status:[],remotes:[],worktrees:[{path:boot.cwd,head:"359de2e5c0ffee0123456789abcdef0123456789"},{path:boot.cwd+"-other",head:"0123456789abcdef0123456789abcdef01234567",branch:"main"}]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:null,detectedProvider:"unknown",git:{version:"git version fixture"},providers:{},capabilities:{}}));
  await page.route("**/api/source-control/prs?**",route=>json(route,{items:[]}));
  const {right}=await openGitPanel(page,request,"Source control detached head");
  const branch=right.getByRole("combobox",{name:"Current branch"});
  await expect(branch).toBeEnabled();
  await expect(branch).toHaveValue("");
  await expect(branch.locator("option:checked")).toHaveText("detached");
  await expect(branch.locator("option")).toHaveText(["detached","backup/pre-benchmark-message-cleanup","main"]);
  await expect(branch.locator("option").first()).toBeDisabled();
  await expect(branch).toHaveAttribute("title","detached at 359de2e5 · switch branch");
  await expect(page.locator(".branch-control")).toHaveText("detached");
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-detached-head-dark-1280x800.png"});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-detached-head-light-1280x800.png"});
  // Picking a branch still switches to it.
  let switched=null;
  await page.route("**/api/git/action",route=>{switched=route.request().postDataJSON();return json(route,{ok:true})});
  await branch.selectOption("main");
  await expect.poll(()=>switched&&switched.action+":"+switched.name).toBe("branch-switch:main");
});

test("a repository with no remote says it has none instead of failing to list pull requests",async({page,request})=>{
  test.setTimeout(35_000);
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  const boot=await (await request.get("/api/bootstrap")).json();
  await page.route("**/api/git/info?**",route=>json(route,{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:null,status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[]}));
  await page.route("**/api/source-control/diagnostics?**",route=>json(route,{selectedProvider:null,detectedProvider:"unknown",git:{version:"git version fixture"},providers:{},capabilities:{}}));
  // What the server answers when no code host can be named for the repository.
  await page.route("**/api/source-control/prs?**",route=>json(route,{error:"Could not identify this Git host. Choose GitHub, GitLab, Forgejo/Gitea, Bitbucket, or Azure DevOps."},400));
  const {right,pulls}=await openGitPanel(page,request,"Source control no remote");
  const empty=pulls.locator(".pr-empty-state");
  await expect(empty).toContainText("No remote yet");
  await expect(empty).not.toHaveClass(/error/);
  await expect(right.locator(".source-control-error")).toHaveCount(0);
  await expect(right.getByText("No pull requests found")).toHaveCount(0);
  await pulls.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:auditDir+"source-control-no-remote-dark-1280x800.png",fullPage:true});
});

// The desktop app: Electron's renderer throws on window.prompt, so every question is asked in Trebell's own dialog, and a link the
// panel opens is noted instead of opening a tab.
async function asInDesktopApp(page){
  await page.addInitScript(()=>{window.prompt=()=>{throw new Error("prompt() is and will not be supported.")};window.__opened=[];window.open=url=>{window.__opened.push(String(url));return null}});
}
// A repository on a scripted code host: /api/git/info answers host.info (changed in place by a test; info:false leaves Git real), and
// every /api/source-control/* read and action answers as a host would, its pull requests changing with the actions. host.calls lists
// what the panel sent; host.fail[action] fails the next such action with that reason, and host.hold[action] holds it until that
// promise settles (a read such as "thread-link" is held by its path).
async function scriptCodeHost(page,{boot,prs=[],capabilities={},info={}}){
  const host={prs,calls:[],fail:{},hold:{},info:{isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],worktrees:[{path:boot.cwd,branch:"main"}],remotes:[{name:"origin",url:"https://github.com/owner/repo.git",kind:"fetch"}],...info},
    capabilities:{create:true,edit:true,comment:true,editComments:true,review:true,merge:true,autoMerge:true,checkout:true,reviewers:true,publish:true,...capabilities}};
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  const identity=pr=>({provider:"github",host:"github.com",repository:"owner/repo",number:pr.number});
  if(info!==false)await page.route("**/api/git/info?**",route=>json(route,host.info));
  await page.route(/\/api\/source-control\//,async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace(/^.*\/api\/source-control\//,"");let body=null;try{body=request.postDataJSON()}catch{}
    host.calls.push({path,method:request.method(),query:Object.fromEntries(url.searchParams),body});
    const action=body?.action,held=host.hold[path==="pr-action"?action:path];if(held)await held;
    if(path==="pr-action"&&host.fail[action]!=null){const reason=host.fail[action];delete host.fail[action];return json(route,{ok:false,error:reason},400)}
    if(path==="diagnostics")return json(route,{selectedProvider:url.searchParams.get("provider")||"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:host.capabilities}});
    if(path==="prs")return json(route,{ok:true,provider:"github",capabilities:host.capabilities,items:host.prs.map(pr=>({provider:"github",...pr,identity:identity(pr)}))});
    if(path==="pr-detail"){const pr=host.prs.find(item=>String(item.number)===url.searchParams.get("number"));return pr?json(route,{ok:true,provider:"github",capabilities:host.capabilities,item:{body:"",comments:[],reviews:[],files:[],statusCheckRollup:[],provider:"github",...pr,identity:identity(pr)}}):json(route,{error:"Pull request not found"},400)}
    if(path==="pr-viewed")return json(route,{ok:true,provider:"github",store:"host",files:[]});
    if(path==="thread-link")return json(route,{threads:[],links:[]});
    if(path==="branch-reviews")return json(route,{items:[]});
    if(path==="settlements")return json(route,{enabled:false,items:[]});
    if(path==="pr-action"){
      const pr=host.prs.find(item=>item.number===body.number);
      if(action==="edit"){if("title" in body)pr.title=body.title;if("body" in body)pr.body=body.body}
      if(action==="edit-comment")pr.comments.find(item=>item.id===body.commentId).body=body.body;
      if(action==="merge"&&body.auto)pr.autoMergeRequest={mergeMethod:String(body.method).toUpperCase(),enabledBy:{login:"me"}};
      else if(action==="merge")Object.assign(pr,{state:"MERGED",mergedAt:"2026-10-12T10:00:00Z",mergeCommitSha:"abc1234"});
      if(action==="request-reviewer")(pr.reviewRequests||=[]).push({login:body.reviewer});
      return json(route,{ok:true,provider:"github"});
    }
    if(path==="pr"){const number=100+host.prs.length;host.prs.unshift({number,title:body.title,body:body.body,state:"OPEN",url:"https://example.test/pr/"+number,headRefName:"feature/one",baseRefName:"main"});return json(route,{ok:true,provider:"github",url:"https://example.test/pr/"+number})}
    if(path==="publish")return json(route,{ok:true,provider:body.provider,url:"https://example.test/"+body.name,pushed:true});
    return json(route,{error:"The scripted host does not answer "+path},400);
  });
  host.actions=()=>host.calls.filter(call=>call.path==="pr-action").map(call=>call.body);
  return host;
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
const samplePr=(number,extra={})=>({number,title:"Scratch PR "+number,state:"OPEN",url:"https://example.test/pr/"+number,headRefName:"feature/"+number,baseRefName:"main",body:"",comments:[],reviews:[],files:[],statusCheckRollup:[],...extra});

test("a description or a comment keeps its line breaks, and a field left as it was is not sent",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const description="First paragraph of the description.\n\n- point one\n- point two",written="## Summary\n- first point\n- second point\n\n## Testing\nRan the scratch checks.";
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one",body:description,comments:[{id:"c-mine",body:"My comment\nsecond line",author:{login:"me"},canEdit:true}]})]});
  await page.route("**/api/git/review-text",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({title:"Add the scratch change",body:written})}));
  const {pulls}=await openGitPanel(page,request,"Source control multi-line text");
  const dialog=page.locator("dialog.inspector-text-prompt"),box=dialog.locator("textarea"),detail=pulls.locator(".pr-detail");
  await pulls.getByRole("button",{name:/#11 Feature one/}).click();
  await expect(detail.locator("h3")).toHaveText("#11 Feature one");
  const edit=detail.getByRole("button",{name:"Edit",exact:true});
  const editTitle=async title=>{await edit.click();await expect(dialog).toContainText("PR title");if(title)await page.keyboard.type(title,{delay:15});await page.keyboard.press("Enter")};

  // A new title, and the description left as it was: only the title is sent.
  await editTitle("Feature one renamed");
  await expect(dialog).toContainText("PR description");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(description);
  await page.keyboard.press("Control+Enter");
  await expect(detail.locator("h3")).toHaveText("#11 Feature one renamed");
  expect(host.actions()).toEqual([{action:"edit",number:11,title:"Feature one renamed",cwd:boot.cwd,provider:"github",environmentId:null}]);

  // The description dialog holds every line; Enter adds one, and the title, left as it was, is not sent.
  await editTitle("");
  await expect(box).toHaveValue(description);
  await shootBothModes(page,"source-control-description-dialog",{close:()=>page.keyboard.press("Escape"),reopen:async()=>{await editTitle("");await expect(box).toHaveValue(description)}});
  await page.keyboard.press("Enter");await page.keyboard.type("- point three",{delay:15});
  await page.keyboard.press("Control+Enter");
  await expect.poll(()=>host.actions().length).toBe(2);
  expect(host.actions()[1]).toEqual({action:"edit",number:11,body:description+"\n- point three",cwd:boot.cwd,provider:"github",environmentId:null});
  // Nothing changed at all: nothing is sent. OK on an unchanged comment sends nothing either, and an added line is sent with it.
  await editTitle("");await expect(box).toHaveValue(description+"\n- point three");await page.keyboard.press("Control+Enter");await expect(dialog).toHaveCount(0);
  const editComment=detail.getByRole("button",{name:"Edit comment"});
  await editComment.click();await expect(dialog).toContainText("Edit comment");await expect(box).toHaveValue("My comment\nsecond line");
  await dialog.getByRole("button",{name:"OK"}).click();await expect(dialog).toHaveCount(0);
  await editComment.click();await expect(box).toHaveValue("My comment\nsecond line");
  await page.keyboard.press("Enter");await page.keyboard.type("third line",{delay:15});await dialog.getByRole("button",{name:"OK"}).click();
  await expect.poll(()=>host.actions().length).toBe(3);
  expect(host.actions()[2]).toEqual({action:"edit-comment",number:11,commentId:"c-mine",body:"My comment\nsecond line\nthird line",cwd:boot.cwd,provider:"github",environmentId:null});
  // The description and the comment read as written, line by line.
  await expect(detail.locator(".review-list p").first()).toHaveText("My comment\nsecond line\nthird line",{useInnerText:true});
  await expect(detail.locator(":scope > p").first()).toHaveText(description+"\n- point three",{useInnerText:true});
  await detail.locator(".review-list").first().scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-multi-line-detail");

  // A written pull request description is sent as written.
  await pulls.getByRole("button",{name:"Generate PR",exact:true}).click();
  await expect(dialog).toContainText("PR title");await page.keyboard.press("Enter");
  await expect(dialog).toContainText("PR description");await expect(box).toHaveValue(written);await page.keyboard.press("Control+Enter");
  await expect.poll(()=>host.calls.filter(call=>call.path==="pr").length).toBe(1);
  expect(host.calls.find(call=>call.path==="pr").body).toMatchObject({title:"Add the scratch change",body:written});
});

test("Enter held from the PR title gives that box OK and adds no lines to the description box it opens; Enter held in the description adds one a repeat",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one",body:"First paragraph of the description."})]});
  const {pulls}=await openGitPanel(page,request,"Source control held Enter");
  const dialog=page.locator("dialog.inspector-text-prompt"),box=dialog.locator("textarea"),detail=pulls.locator(".pr-detail");
  await pulls.getByRole("button",{name:/#11 Feature one/}).click();
  await expect(detail.locator("h3")).toHaveText("#11 Feature one");
  const edit=detail.getByRole("button",{name:"Edit",exact:true});
  let body="First paragraph of the description.";
  for(const [index,mode] of ["dark","light"].entries()){
    if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
    const title="Feature one, pass "+(index+1);
    await edit.click();await expect(dialog).toContainText("PR title");await page.keyboard.type(title,{delay:15});
    // Enter gives the title box OK and opens the description box, where the key, still held, goes on repeating.
    await page.keyboard.down("Enter");await expect(dialog).toContainText("PR description");await expect(box).toBeFocused();
    await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");
    await expect(box).toHaveValue(body);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"source-control-held-enter-description-"+mode+"-"+width+"x800.png"})}
    await page.setViewportSize({width:1280,height:800});
    // Enter pressed and held in the box adds a line for the press and one for each repeat.
    await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");
    await expect(box).toHaveValue(body+"\n\n\n");
    await page.keyboard.type("- pass "+(index+1),{delay:15});await page.keyboard.press("Control+Enter");await expect(dialog).toHaveCount(0);
    body+="\n\n\n- pass "+(index+1);
    await expect.poll(()=>host.actions().length).toBe(index+1);
    expect(host.actions()[index]).toEqual({action:"edit",number:11,title,body,cwd:boot.cwd,provider:"github",environmentId:null});
    await expect(detail.locator("h3")).toHaveText("#11 "+title);
  }
});

test("Publish asks public, private or cancel, and Cancel or Escape publishes nothing",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,info:{upstream:null,remotes:[]}});
  const {repository}=await openGitPanel(page,request,"Source control publish choice");
  const dialog=page.locator("dialog.inspector-text-prompt"),publishes=()=>host.calls.filter(call=>call.path==="publish").map(call=>call.body);
  const name=boot.cwd.split(/[\\/]/).filter(Boolean).pop();
  const ask=async()=>{await repository.getByRole("button",{name:"Publish repository"}).click();await expect(dialog).toContainText("Repository name");await page.keyboard.press("Enter");await expect(dialog.getByRole("button",{name:"Public",exact:true})).toBeVisible()};
  await ask();
  // The question names the repository and the host, offers each answer as its own button, and opens on Cancel.
  await expect(dialog.locator("p")).toHaveText("Publish "+name+" on GitHub?\n\nAnyone can see a public repository; a private one only you and the people you add can see.",{useInnerText:true});
  await expect(dialog.getByRole("button")).toHaveText(["Cancel","Private","Public"]);
  await expect(dialog.getByRole("button",{name:"Cancel"})).toBeFocused();
  await shootBothModes(page,"source-control-publish-choice",{close:()=>page.keyboard.press("Escape"),reopen:ask});
  // Escape, and Cancel, publish nothing.
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
  await ask();await dialog.getByRole("button",{name:"Cancel"}).click();await expect(dialog).toHaveCount(0);
  await ask();await dialog.getByRole("button",{name:"Private",exact:true}).click();
  await expect.poll(publishes).toHaveLength(1);
  await expect(repository.getByRole("button",{name:"Publish repository"})).toBeEnabled();
  await ask();await dialog.getByRole("button",{name:"Public",exact:true}).click();
  await expect.poll(publishes).toHaveLength(2);
  expect(publishes().map(body=>[body.name,body.visibility])).toEqual([[name,"private"],[name,"public"]]);
});

test("Merge and Auto-merge ask first, naming the pull request, the method and the checks that failed or are pending",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const checks=[{__typename:"CheckRun",name:"unit-tests",status:"COMPLETED",conclusion:"FAILURE"},{__typename:"CheckRun",name:"lint",status:"IN_PROGRESS",conclusion:""},{__typename:"CheckRun",name:"build",status:"COMPLETED",conclusion:"SUCCESS"},{__typename:"StatusContext",context:"ci/deploy",state:"PENDING"}];
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(7,{title:"Checks fixture",statusCheckRollup:checks})]});
  const {right,pulls}=await openGitPanel(page,request,"Source control merge question");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),merges=()=>host.actions().filter(body=>body.action==="merge");
  await pulls.getByRole("button",{name:/#7 Checks fixture/}).click();
  // The checks read as a list of names and states, not as the host's JSON.
  const rows=detail.locator(".pr-checks li");
  await expect(rows).toHaveText([/^unit-tests\s*failed$/,/^lint\s*pending$/,/^build\s*passed$/,/^ci\/deploy\s*pending$/]);
  await expect(detail.locator("pre")).toHaveCount(0);
  await expect(detail.getByText("__typename")).toHaveCount(0);
  await rows.first().scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-pr-checks");

  const question="Merge #7 “Checks fixture” into main using squash?\n\n1 check failed: unit-tests.\n2 checks are still pending: lint, ci/deploy.";
  const ask=async(button,text)=>{await detail.getByRole("button",{name:button,exact:true}).click();await expect(dialog.locator("p")).toHaveText(text,{useInnerText:true})};
  await ask("Merge",question);
  await expect(dialog.getByRole("button")).toHaveText(["Cancel","Merge"]);
  await expect(dialog.getByRole("button",{name:"Cancel"})).toBeFocused();
  await shootBothModes(page,"source-control-merge-question",{close:()=>page.keyboard.press("Escape"),reopen:()=>ask("Merge",question)});
  // Escape and Cancel merge nothing.
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
  await ask("Merge",question);await dialog.getByRole("button",{name:"Cancel"}).click();await expect(dialog).toHaveCount(0);
  // Auto-merge asks too, and turns on only when the person says so.
  await ask("Auto-merge","Turn on auto-merge for #7 “Checks fixture” into main using squash? The host merges it once its required checks pass.\n\n1 check failed: unit-tests.\n2 checks are still pending: lint, ci/deploy.");
  await dialog.getByRole("button",{name:"Turn on auto-merge"}).click();
  await expect.poll(()=>merges().length).toBe(1);
  expect(merges()[0]).toMatchObject({number:7,method:"squash",auto:true});
  // Merge, said yes to, merges and says so.
  await ask("Merge",question);await dialog.getByRole("button",{name:"Merge",exact:true}).click();
  const notice=right.locator(".source-control-notice");
  await expect(notice).toHaveText("Pull request #7 was merged.");
  await expect(notice).toHaveAttribute("role","status");
  expect(merges()[1]).toEqual({action:"merge",number:7,method:"squash",cwd:boot.cwd,provider:"github",environmentId:null});
  await expect(pulls.locator(".pr-list em")).toHaveText("MERGED");
  await shootBothModes(page,"source-control-merged-notice");
});

// A GitHub stack's actions say that they worked in the notice a merged pull request shows, naming the layers as their question did:
// Rebase stack clicked, and Merge through from the keyboard in a narrow window (GitHub merges a stack after it answers).
test("Rebase stack and Merge through say they worked, as a merged pull request does",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const layers=[{position:1,number:21,title:"Stack layer one",state:"OPEN",isDraft:false,url:"https://example.test/pr/21",headRefName:"stack-one",baseRefName:"main"},{position:2,number:22,title:"Stack layer two",state:"OPEN",isDraft:false,url:"https://example.test/pr/22",headRefName:"stack-two",baseRefName:"stack-one"}];
  const stack=position=>({number:42,size:2,position,baseRefName:"main",layers});
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(21,{title:"Stack layer one",headRefName:"stack-one",stack:stack(1)}),samplePr(22,{title:"Stack layer two",headRefName:"stack-two",baseRefName:"stack-one",stack:stack(2)})]});
  const {right,pulls}=await openGitPanel(page,request,"Source control stack notices");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),notice=right.locator(".source-control-notice");
  await pulls.locator(".pr-list").getByRole("button",{name:/#22 Stack layer two/}).click();
  await expect(detail.locator(".pr-stack-head")).toContainText("GitHub stack #42");
  // Rebase stack, clicked and said yes to.
  await detail.getByRole("button",{name:"Rebase stack",exact:true}).click();
  await expect(dialog.locator("p")).toHaveText(/^Rebase stack #21 → #22\?/);
  await dialog.getByRole("button",{name:"Rebase stack",exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(notice).toHaveText("Stack #21 → #22 was rebased.");
  await expect(notice).toHaveAttribute("role","status");
  expect(host.actions()).toEqual([{action:"rebase-stack",number:22,cwd:boot.cwd,provider:"github",environmentId:null}]);
  await shootBothModes(page,"source-control-stack-rebased-notice");
  // Merge through, at 900 wide: Enter on it, Tab from Cancel to Merge through #22, Enter. Its notice takes the rebase's place.
  await page.setViewportSize({width:900,height:800});
  await detail.getByLabel("Stack merge method").selectOption("merge");
  const mergeThrough=detail.getByRole("button",{name:"Merge through #22",exact:true});
  await mergeThrough.focus();await page.keyboard.press("Enter");
  await expect(dialog.locator("p")).toHaveText(/^Merge #21 → #22 using merge as one GitHub stack operation\?/);
  await expect(dialog.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await page.keyboard.press("Tab");await expect(dialog.getByRole("button",{name:"Merge through #22",exact:true})).toBeFocused();
  await page.keyboard.press("Enter");await expect(dialog).toHaveCount(0);
  await expect(notice).toHaveText("GitHub is merging #21 → #22.");
  await expect(notice).toBeInViewport();
  expect(host.actions()[1]).toEqual({action:"merge",number:22,method:"merge",cwd:boot.cwd,provider:"github",environmentId:null});
  await shootBothModes(page,"source-control-stack-merging-notice");
});

// In a browser too, where window.prompt and window.confirm would work, the panel asks in the app's own dialog.
test("Revert PR asks in the app's own dialog, never the browser's: Escape opens nothing, and the keyboard opens the revert",async({page,request})=>{
  test.setTimeout(60_000);
  await page.addInitScript(()=>{window.__opened=[];window.open=url=>{window.__opened.push(String(url));return null}});
  const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,capabilities:{revert:true},prs:[samplePr(31,{title:"Merged change",state:"MERGED",mergedAt:"2026-10-12T10:00:00Z",mergeCommitSha:"abc1234"})]});
  const {pulls}=await openGitPanel(page,request,"Source control revert question");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),reverts=()=>host.actions().filter(body=>body.action==="revert");
  await pulls.getByRole("button",{name:/#31 Merged change/}).click();
  const revert=detail.getByRole("button",{name:"Revert PR",exact:true});
  const ask=async()=>{await revert.click();await expect(dialog.locator("p")).toHaveText("Open a new pull request that reverts #31?")};
  await ask();
  await expect(dialog.getByRole("button")).toHaveText(["Cancel","Open revert pull request"]);
  await expect(dialog.getByRole("button",{name:"Cancel"})).toBeFocused();
  await shootBothModes(page,"source-control-revert-question",{close:()=>page.keyboard.press("Escape"),reopen:ask});
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(revert).toBeFocused();
  await page.waitForTimeout(200);expect(reverts()).toEqual([]);
  // From the keyboard: Enter on Revert PR, Tab from Cancel to Open revert pull request, Enter.
  await page.keyboard.press("Enter");await expect(dialog.getByRole("button",{name:"Cancel"})).toBeFocused();
  await page.keyboard.press("Tab");await expect(dialog.getByRole("button",{name:"Open revert pull request"})).toBeFocused();
  await page.keyboard.press("Enter");await expect(dialog).toHaveCount(0);
  await expect.poll(()=>reverts().length).toBe(1);
  expect(reverts()[0]).toMatchObject({action:"revert",number:31});
  expect(nativeDialogs).toEqual([]);
});

// A merged pull request offers only what its host still does with one: no Checkout and no reviewer to ask (it can no longer be
// reviewed), and Edit only on a host that edits a merged one's title and description. Comments stay, and so does Revert PR.
test("a merged pull request offers only what still applies to it on its host",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,capabilities:{revert:true,editMerged:true},prs:[samplePr(41,{title:"Merged change",state:"MERGED",mergedAt:"2026-10-12T10:00:00Z",mergeCommitSha:"abc1234"}),samplePr(42,{title:"Open change"})]});
  const {pulls}=await openGitPanel(page,request,"Source control merged pull request");
  const detail=pulls.locator(".pr-detail"),actions=detail.locator(".pr-actions button"),composer=detail.locator(".pr-composer-trigger");
  // An open one, for comparison, offers everything.
  await pulls.getByRole("button",{name:/#42 Open change/}).click();
  await expect(detail.getByRole("heading",{name:"#42 Open change"})).toBeVisible();
  await expect(actions).toHaveText(["Open","Attach","Link to thread","Edit","Checkout","Request reviewer","Auto-merge","Merge"]);
  await expect(composer).toHaveText("Comment / review");
  await pulls.getByRole("button",{name:/#41 Merged change/}).click();
  await expect(detail.getByRole("heading",{name:"#41 Merged change"})).toBeVisible();
  await expect(actions).toHaveText(["Open","Attach","Link to thread","Edit","Revert PR"]);
  await expect(composer).toHaveText("Comment");
  await shootBothModes(page,"source-control-merged-pr-actions");
  // On a host that does not edit a merged pull request, it offers no Edit either.
  host.capabilities.editMerged=false;
  await pulls.getByRole("button",{name:"Refresh pull requests",exact:true}).click();
  await expect.poll(()=>host.calls.filter(call=>call.path==="prs").length).toBeGreaterThan(1);
  await pulls.getByRole("button",{name:/#42 Open change/}).click();await expect(detail.getByRole("heading",{name:"#42 Open change"})).toBeVisible();
  await pulls.getByRole("button",{name:/#41 Merged change/}).click();await expect(detail.getByRole("heading",{name:"#41 Merged change"})).toBeVisible();
  await expect(actions).toHaveText(["Open","Attach","Link to thread","Revert PR"]);
  await expect(composer).toHaveText("Comment");
});

test("auto-merge that is on says so and is not offered again, and requested reviewers are listed",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one",reviews:[{id:"r1",author:{login:"lead-dev"},state:"COMMENTED",body:"Looks close."}]})]});
  const {pulls}=await openGitPanel(page,request,"Source control auto-merge state");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),actions=detail.locator(".pr-actions");
  await pulls.getByRole("button",{name:/#11 Feature one/}).click();
  await expect(detail.locator(".pr-auto-merge")).toHaveCount(0);
  await actions.getByRole("button",{name:"Auto-merge",exact:true}).click();
  await dialog.getByRole("button",{name:"Turn on auto-merge"}).click();
  await expect(detail.locator(".pr-auto-merge")).toHaveText("Auto-merge is on (squash), turned on by me. It merges once its required checks pass.");
  await expect(actions.getByRole("button",{name:"Auto-merge",exact:true})).toHaveCount(0);
  await expect(actions.getByRole("button",{name:"Merge",exact:true})).toBeVisible();
  // A reviewer asked for is listed with the reviews, as requested.
  await actions.getByRole("button",{name:"Request reviewer"}).click();
  await expect(dialog).toContainText("Reviewer username");await page.keyboard.type("octocat",{delay:15});await page.keyboard.press("Enter");
  const reviews=detail.locator(".review-list").last().locator(":scope > div");
  await expect(reviews).toHaveText([/^lead-dev\s*COMMENTED\s*Looks close\.$/i,/^octocat\s*requested$/i]);
  expect(host.actions().map(body=>body.action)).toEqual(["merge","request-reviewer"]);
  await detail.locator(".pr-auto-merge").scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-auto-merge-on");
  await reviews.last().scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-reviewer-requested");
});

// Git under load (a busy disk, benchmarks on the same host) can take longer than expect's 5 s to answer a status read or a commit:
// the Commit tests below wait for what Git answers, up to 30 s each, instead of failing on a slow first read. So do the Initialize
// Git, Fetch, Pull and Push tests, as a person waits for the panel's first read and for each action and the read of the repository
// after it (a refused action says why once that read has answered; on a loaded host each of those reads took more than 5 s).
const GIT_WAIT={timeout:30_000};

// A real repository with one commit and `files` written over it (relative path: text), registered as a project; git runs Git in it,
// and it is removed when the test ends.
const repositories=[];
test.afterEach(async()=>{for(const dir of repositories.splice(0))await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{})});
async function realRepository(files={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-git-panel-"));repositories.push(root);
  const git=async args=>(await execFileAsync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"})).stdout.trim();
  await git(["init","-b","main"]);await git(["config","user.email","trebell-test@example.invalid"]);await git(["config","user.name","Trebell Test"]);
  await writeFile(join(root,"notes.txt"),"before\n","utf8");await git(["add","notes.txt"]);await git(["commit","-m","Seed notes"]);
  for(const [relative,content] of Object.entries(files)){await mkdir(dirname(join(root,relative)),{recursive:true});await writeFile(join(root,relative),content,"utf8")}
  return {root,git};
}

test("a commit a hook refuses, or one with nothing to commit, says why and keeps the message",async({page,request})=>{
  test.setTimeout(120_000);
  const {root,git}=await realRepository({".git/hooks/pre-commit":"#!/bin/sh\necho 'the project hook refuses this commit' >&2\nexit 1\n","notes.txt":"after\n"});
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  const {right,changes}=await openGitPanel(page,request,"Source control refused commit",root);
  const message=changes.getByPlaceholder("Commit message"),commit=changes.getByRole("button",{name:"Commit",exact:true}),alert=right.locator(".source-control-error");
  await expect(changes.getByRole("heading")).toHaveText("Changes 1",GIT_WAIT);
  await message.click();await page.keyboard.type("Refused by the hook",{delay:15});
  await commit.click();
  await expect(alert).toHaveText("Could not commit: the project hook refuses this commit",GIT_WAIT);
  await expect(message).toHaveValue("Refused by the hook");
  await expect(changes.getByRole("heading")).toHaveText("Changes 1");
  expect(await git(["log","--format=%s"])).toBe("Seed notes");
  await shootBothModes(page,"source-control-commit-refused");
  // With the change committed elsewhere, Commit says there is nothing to commit, and the message stays for the next change.
  await rm(join(root,".git","hooks","pre-commit"));await git(["commit","-am","Committed in a terminal"]);
  await commit.click();
  await expect(alert).toHaveText("Nothing to commit: the working tree has no changes.",GIT_WAIT);
  await expect(message).toHaveValue("Refused by the hook");
  await expect(changes.locator(".sc-clean")).toHaveText("Working tree clean.",GIT_WAIT);
  expect(await git(["log","--format=%s"])).toBe("Committed in a terminal\nSeed notes");
  await shootBothModes(page,"source-control-nothing-to-commit");
});

test("a commit that is made empties the message box, so the next message starts fresh",async({page,request})=>{
  test.setTimeout(120_000);
  const {root,git}=await realRepository({"notes.txt":"after\n"});
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  const {changes}=await openGitPanel(page,request,"Source control commit message",root);
  const message=changes.getByPlaceholder("Commit message"),commit=changes.getByRole("button",{name:"Commit",exact:true});
  await expect(changes.getByRole("heading")).toHaveText("Changes 1",GIT_WAIT);
  await message.click();await page.keyboard.type("First commit from the panel",{delay:15});
  await commit.click();
  await expect(changes.locator(".sc-clean")).toHaveText("Working tree clean.",GIT_WAIT);
  await expect(message).toHaveValue("");
  await expect(commit).toBeDisabled();
  expect(await git(["log","-1","--format=%s"])).toBe("First commit from the panel");
  await shootBothModes(page,"source-control-after-commit");
  // The next change gets its own message, not one appended to the last.
  await writeFile(join(root,"notes.txt"),"after again\n","utf8");
  await changes.getByRole("heading").scrollIntoViewIfNeeded();await page.getByTestId("right-panel").getByRole("button",{name:"Fetch",exact:true}).click();
  await expect(changes.getByRole("heading")).toHaveText("Changes 1",GIT_WAIT);
  await message.click();await page.keyboard.type("Second commit",{delay:15});await commit.click();
  await expect(message).toHaveValue("",GIT_WAIT);
  expect(await git(["log","-2","--format=%s"])).toBe("Second commit\nFirst commit from the panel");
});

test("Initialize Git that fails says why in the not-a-repository view",async({page,request})=>{
  test.setTimeout(60_000);
  // A folder whose .git file points at a folder that is gone: git can neither read it nor initialize it.
  const root=await mkdtemp(join(tmpdir(),"trebell-git-init-"));repositories.push(root);
  await writeFile(join(root,".git"),"gitdir: "+join(root,"missing-git-dir").replace(/\\/g,"/")+"\n","utf8");await writeFile(join(root,"hello.txt"),"hello\n","utf8");
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  const {right}=await openGitPanel(page,request,"Source control init failure",root);
  const view=right.locator(".source-control .empty-state");
  await expect(view).toContainText("Not a Git repository",GIT_WAIT);
  await view.getByRole("button",{name:"Initialize Git"}).click();
  const alert=right.getByRole("alert");
  await expect(alert).toHaveText(/^Could not initialize the Git repository: fatal: not a git repository: .*missing-git-dir$/,GIT_WAIT);
  await expect(view.getByRole("button",{name:"Initialize Git"})).toBeEnabled();
  await shootBothModes(page,"source-control-init-failed");
});

test("after Initialize Git the branch picker and the header show the new branch, before its first commit and after",async({page,request})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-git-unborn-"));repositories.push(root);await writeFile(join(root,"hello.txt"),"hello\n","utf8");
  const git=async args=>(await execFileAsync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"})).stdout.trim();
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  // The header's own reads of the folder's Git state (every 3.5 s; the panel's name an environment) are held, as on a slow disk:
  // what the header shows after the init is then what the panel read the moment the init was done.
  await page.route(/\/api\/git\/info\?/,route=>{if(new URL(route.request().url()).searchParams.has("environmentId"))return route.fallback()});
  const {right,changes}=await openGitPanel(page,request,"Source control unborn branch",root);
  const chip=page.locator("header.workspace-header .branch-control");
  await expect(right.locator(".source-control .empty-state")).toContainText("Not a Git repository",GIT_WAIT);
  await expect(chip,"no branch before the init").toHaveCount(0);
  await right.locator(".source-control .empty-state").getByRole("button",{name:"Initialize Git"}).click();
  await expect(changes.getByRole("heading")).toHaveText("Changes 1",GIT_WAIT);
  const branch=await git(["symbolic-ref","--short","HEAD"]);await git(["config","user.email","trebell-test@example.invalid"]);await git(["config","user.name","Trebell Test"]);
  await expect(chip,"the header's branch, right after the init").toHaveText(branch);
  const picker=right.getByRole("combobox",{name:"Current branch"});
  await expect(picker).toHaveValue(branch);
  await expect(picker.locator("option")).toHaveText([branch]);
  await expect(picker).toHaveAttribute("title",branch+" · no commits yet");
  await shootBothModes(page,"source-control-unborn-branch");
  // The first commit makes it a branch like any other.
  await changes.getByPlaceholder("Commit message").click();await page.keyboard.type("First commit",{delay:15});
  await changes.getByRole("button",{name:"Commit",exact:true}).click();
  await expect(changes.locator(".sc-clean")).toHaveText("Working tree clean.",GIT_WAIT);
  await expect(picker).toHaveAttribute("title",branch+" · switch branch");
  await expect(picker.locator("option")).toHaveText([branch]);
  await expect(picker).toHaveValue(branch);
});

test("Fetch shows how far the branch is behind or ahead, and a refused Pull, Push or branch name shows git's reason without its hints, and the changes as they are",async({page,request})=>{
  test.setTimeout(150_000);
  // A repository with a local bare remote, and a second clone that pushes to it.
  const base=await mkdtemp(join(tmpdir(),"trebell-git-sync-"));repositories.push(base);
  const run=(cwd,args)=>execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"}).then(result=>result.stdout.trim());
  const origin=join(base,"origin.git"),work=join(base,"work"),peer=join(base,"peer");
  await run(base,["init","--bare","-b","main",origin]);await run(base,["clone",origin,work]);
  for(const dir of [work])for(const [key,value] of [["user.email","trebell-test@example.invalid"],["user.name","Trebell Test"]])await run(dir,["config",key,value]);
  await writeFile(join(work,"shared.txt"),"base line\n","utf8");await run(work,["add","shared.txt"]);await run(work,["commit","-m","Base"]);await run(work,["push","-u","origin","main"]);
  await run(base,["clone",origin,peer]);for(const [key,value] of [["user.email","peer@example.invalid"],["user.name","Peer"]])await run(peer,["config",key,value]);
  await writeFile(join(peer,"shared.txt"),"base line\npeer line\n","utf8");await run(peer,["commit","-am","Peer change"]);await run(peer,["push"]);
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  const {right,changes,repository}=await openGitPanel(page,request,"Source control sync state",work);
  const upstream=repository.locator("p").filter({hasText:"Upstream:"}),alert=right.locator(".source-control-error");
  await expect(upstream).toHaveText("Upstream: origin/main up to date",GIT_WAIT);
  await right.getByRole("button",{name:"Fetch",exact:true}).click();
  await expect(upstream).toHaveText("Upstream: origin/main 1 commit behind",GIT_WAIT);
  await shootBothModes(page,"source-control-behind-after-fetch");
  // A local edit the incoming commit would overwrite: git refuses the pull, says why line by line, and Changes shows the edit.
  await writeFile(join(work,"shared.txt"),"base line\nmy local line\n","utf8");
  await right.getByRole("button",{name:"Pull",exact:true}).click();
  await expect(alert).toContainText("Could not pull:",GIT_WAIT);
  await expect.poll(()=>alert.innerText()).toMatch(/would be overwritten by merge:\n\s*shared\.txt\n/);
  await expect(changes.getByRole("heading")).toHaveText("Changes 1");
  await expect(changes.locator(".status-list > div")).toHaveText(/shared\.txt/);
  await shootBothModes(page,"source-control-pull-refused");
  // Committed locally, the branch has gone both ways. A refused Pull or Push says git's reason, each of its lines on a line of its
  // own, without the hints git adds for a terminal (the commands to run next, the setting that turns the hint off).
  await run(work,["commit","-am","My change"]);
  await right.getByRole("button",{name:"Pull",exact:true}).click();
  await expect(alert).toHaveText("Could not pull: fatal: Not possible to fast-forward, aborting.",GIT_WAIT);
  await expect(upstream).toHaveText("Upstream: origin/main 1 ahead, 1 behind");
  await shootBothModes(page,"source-control-pull-diverged");
  await right.getByRole("button",{name:"Push",exact:true}).click();
  await expect(alert).toContainText("Could not push:",GIT_WAIT);
  const lines=(await alert.innerText()).split("\n");
  expect(lines.filter(line=>/hint:/.test(line))).toEqual([]);
  expect(lines.some(line=>/^\s*! \[rejected\]\s+main -> main \(non-fast-forward\)$/.test(line))).toBe(true);
  expect(lines.some(line=>/^error: failed to push some refs to /.test(line))).toBe(true);
  await shootBothModes(page,"source-control-push-rejected");
  // A branch name git refuses says why the same way.
  await right.getByRole("button",{name:"Create branch",exact:true}).click();
  await expect(page.locator("dialog.inspector-text-prompt").getByRole("textbox",{name:"New branch name"})).toBeFocused();
  await page.keyboard.type("bad..name",{delay:15});await page.keyboard.press("Enter");
  await expect(alert).toHaveText("Could not create the branch: fatal: 'bad..name' is not a valid branch name",GIT_WAIT);
  await expect(right.getByRole("combobox",{name:"Current branch"})).toHaveValue("main");
  await shootBothModes(page,"source-control-branch-name-refused");
});

test("a refused Pull keeps git's reason on screen when the refresh after it cannot list the pull requests",async({page,request})=>{
  test.setTimeout(90_000);
  const base=await mkdtemp(join(tmpdir(),"trebell-git-sync-"));repositories.push(base);
  const run=(cwd,args)=>execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"}).then(result=>result.stdout.trim());
  const origin=join(base,"origin.git"),work=join(base,"work"),peer=join(base,"peer");
  await run(base,["init","--bare","-b","main",origin]);await run(base,["clone",origin,work]);
  for(const [key,value] of [["user.email","trebell-test@example.invalid"],["user.name","Trebell Test"]])await run(work,["config",key,value]);
  await writeFile(join(work,"shared.txt"),"base line\n","utf8");await run(work,["add","shared.txt"]);await run(work,["commit","-m","Base"]);await run(work,["push","-u","origin","main"]);
  await run(base,["clone",origin,peer]);for(const [key,value] of [["user.email","peer@example.invalid"],["user.name","Peer"]])await run(peer,["config",key,value]);
  await writeFile(join(peer,"shared.txt"),"base line\npeer line\n","utf8");await run(peer,["commit","-am","Peer change"]);await run(peer,["push"]);
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  // Once the host is out of reach its pull-request list fails, as the server answers when the host's list call throws.
  let hostDown=false;const unreachable="fetch failed: getaddrinfo ENOTFOUND code.example.test";
  await page.route("**/api/source-control/prs?**",route=>hostDown?route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({ok:false,items:[],error:unreachable})}):route.fallback());
  const {right,changes,repository,pulls}=await openGitPanel(page,request,"Source control pull refused offline",work);
  const alert=right.locator(".source-control-error"),upstream=repository.locator("p").filter({hasText:"Upstream:"});
  // Fetch is pressed once the panel's first read of the repository has answered, as a person presses it once the panel shows the
  // branch.
  await expect(upstream).toHaveText("Upstream: origin/main up to date",GIT_WAIT);
  await right.getByRole("button",{name:"Fetch",exact:true}).click();
  await expect(upstream).toHaveText("Upstream: origin/main 1 commit behind",GIT_WAIT);
  await writeFile(join(work,"shared.txt"),"base line\nmy local line\n","utf8");
  hostDown=true;
  await right.getByRole("button",{name:"Pull",exact:true}).click();
  // The view is read again (Changes shows the edit, the card says it could not list the pull requests) and the banner says why
  // git refused the pull.
  await expect(changes.getByRole("heading")).toHaveText("Changes 1",GIT_WAIT);
  await expect(pulls.locator(".pr-empty-state")).toContainText("Could not list pull requests",GIT_WAIT);
  await expect(pulls.locator(".pr-empty-state")).toContainText(unreachable);
  await expect(alert).toContainText("Could not pull:",GIT_WAIT);
  await expect(alert).toContainText("would be overwritten by merge");
  await expect(alert).not.toContainText("pull requests");
  await shootBothModes(page,"source-control-pull-refused-host-down");
  await pulls.locator(".pr-empty-state").scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-pull-refused-host-down-card");
});

test("a branch name of spaces is refused in the app as an empty one is, and a name typed with spaces around it is made without them",async({page,request})=>{
  test.setTimeout(120_000);
  const {root,git}=await realRepository();const tree=root+"-tree";repositories.push(tree);
  // The desktop app's folder picker, which Add worktree opens once it has the branch: it answers a folder beside the repository.
  await page.addInitScript(folder=>{window.trebellDesktop={pickDirectory:async()=>{window.__folderPicks=(window.__folderPicks||0)+1;return folder}}},tree);
  const boot=await (await request.get("/api/bootstrap")).json();
  await scriptCodeHost(page,{boot,info:false});
  const sent=[];page.on("request",item=>{if(new URL(item.url()).pathname==="/api/git/action")sent.push(item.postDataJSON())});
  const {right,repository}=await openGitPanel(page,request,"Source control blank branch",root);
  const question=page.locator("dialog.inspector-text-prompt"),field=question.getByRole("textbox"),picker=right.getByRole("combobox",{name:"Current branch"}),alert=right.locator(".source-control-error");
  const answer=async(button,text)=>{await button.click();await expect(field).toBeFocused();await page.keyboard.type(text,{delay:15});await page.keyboard.press("Enter");await expect(question).toHaveCount(0)};
  await expect(picker).toHaveValue("main",GIT_WAIT);
  // Three spaces name no branch: OK sends nothing, as with the box left empty. A name typed with spaces around it is made without them.
  const create=right.getByRole("button",{name:"Create branch",exact:true});
  await answer(create,"   ");await answer(create,"  feature/padded  ");
  await expect.poll(()=>sent.map(body=>body.action+":"+body.name)).toEqual(["branch-create:feature/padded"]);
  await expect(picker).toHaveValue("feature/padded",GIT_WAIT);await expect(alert).toHaveCount(0);
  expect(await git(["branch","--format=%(refname:short)"])).toBe("feature/padded\nmain");
  await shootBothModes(page,"source-control-branch-name-trimmed");
  // Add worktree asks for its branch the same way: spaces open no folder picker, and the name is made without the spaces around it.
  const add=repository.getByRole("button",{name:"Add worktree",exact:true});
  await answer(add,"   ");await answer(add,"  feature/tree  ");
  await expect.poll(()=>sent.filter(body=>body.action==="worktree-create").map(body=>body.branch)).toEqual(["feature/tree"]);
  expect(await page.evaluate(()=>window.__folderPicks)).toBe(1);
  await expect.poll(()=>git(["worktree","list","--porcelain"]),GIT_WAIT).toContain("branch refs/heads/feature/tree");
});

test("each project selects its detected code host every time it is opened",async({page,request})=>{
  test.setTimeout(90_000);
  const first=await mkdtemp(join(tmpdir(),"trebell-host-first-")),second=await mkdtemp(join(tmpdir(),"trebell-host-second-"));repositories.push(first,second);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,info:{upstream:null,remotes:[]}});
  await request.post("/api/projects",{data:{path:second,name:"Source control host second"}});
  const {right,repository}=await openGitPanel(page,request,"Source control host first",first);
  const codeHost=repository.locator(".source-provider-field select"),publish=repository.getByRole("button",{name:"Publish repository"});
  const open=async name=>{
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator(".project-card").filter({hasText:name}).locator(".project-open").click();
    if(!await right.isVisible())await page.getByTestId("right-panel-toggle").click();
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  };
  const prsAskedWith=()=>host.calls.filter(call=>call.path==="prs").at(-1)?.query.provider;
  await expect(codeHost).toHaveValue("github");await expect(publish).toBeVisible();
  for(const name of ["Source control host second","Source control host first","Source control host second","Source control host first"]){
    const asked=host.calls.filter(call=>call.path==="prs").length;
    await open(name);
    await expect.poll(()=>host.calls.filter(call=>call.path==="prs").length).toBeGreaterThan(asked);
    await expect(codeHost).toHaveValue("github");
    await expect(repository).toContainText("GitHub · authenticated");
    await expect(publish).toBeVisible();
    // The list read on opening goes out with the diagnostics, before they name the host: it leaves the host to the server's reading
    // of the remote, as the diagnostics do. The host they detect is then the project's choice, which the next read names.
    expect(prsAskedWith(),name).toBeUndefined();
    const before=host.calls.filter(call=>call.path==="prs").length;
    await right.getByRole("button",{name:"Refresh pull requests",exact:true}).click();
    await expect.poll(()=>host.calls.filter(call=>call.path==="prs").length).toBeGreaterThan(before);
    expect(prsAskedWith(),name).toBe("github");
  }
  await shootBothModes(page,"source-control-host-after-switches");
});

test("a pull request action that finishes after another one was opened keeps that one open and names its own pull request",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one"}),samplePr(13,{title:"Feature two"}),samplePr(15,{title:"Feature three"})]});
  const {right,pulls}=await openGitPanel(page,request,"Source control late actions");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),heading=detail.locator("h3");
  const openPr=async(number,title)=>{await pulls.locator(".pr-list").getByRole("button",{name:new RegExp("#"+number+" "+title)}).click();await expect(heading).toHaveText("#"+number+" "+title)};
  const held=()=>{let release;const promise=new Promise(resolve=>{release=resolve});return {promise,release}};
  const listReads=()=>host.calls.filter(call=>call.path==="prs").length;
  // A reviewer is still being requested for #11 when the person opens #13: #13 stays open once it is done.
  await openPr(11,"Feature one");
  let hold=held();host.hold["request-reviewer"]=hold.promise;
  await detail.getByRole("button",{name:"Request reviewer"}).click();await expect(dialog).toContainText("Reviewer username");
  await page.keyboard.type("octocat",{delay:15});await page.keyboard.press("Enter");
  await expect.poll(()=>host.actions().length).toBe(1);
  await openPr(13,"Feature two");
  let reads=listReads();hold.release();
  await expect.poll(listReads).toBeGreaterThan(reads);
  await expect(heading).toHaveText("#13 Feature two");
  expect(host.calls.filter(call=>call.path==="pr-detail").map(call=>call.query.number)).toEqual(["11","13"]);
  // A merge of #13 the host refuses after #15 was opened: #15 stays open, and the error names #13. It stays on screen when the
  // rest of #15's detail (its linked threads) arrives after it.
  hold=held();host.hold.merge=hold.promise;host.fail.merge="Pull request is not mergeable: the required check unit-tests has failed.";
  await detail.getByRole("button",{name:"Merge",exact:true}).click();await dialog.getByRole("button",{name:"Merge",exact:true}).click();
  await expect.poll(()=>host.actions().length).toBe(2);
  const links=held();host.hold["thread-link"]=links.promise;
  await openPr(15,"Feature three");
  hold.release();
  const alert=right.locator(".source-control-error"),refused="Could not merge pull request #13: Pull request is not mergeable: the required check unit-tests has failed.";
  await expect(alert).toHaveText(refused);
  delete host.hold["thread-link"];links.release();
  await expect.poll(()=>host.calls.filter(call=>call.path==="thread-link"&&call.query.number==="15").length).toBe(1);
  await expect(detail.getByRole("button",{name:"Merge",exact:true})).toBeEnabled();
  await expect(alert).toHaveText(refused);
  await expect(heading).toHaveText("#15 Feature three");
  await shootBothModes(page,"source-control-late-merge-failure");
});

test("a pull request opened again while its own action is on its way shows what the action did once it is done",async({page,request})=>{
  test.setTimeout(60_000);
  await asInDesktopApp(page);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one"})]});
  const {right,pulls}=await openGitPanel(page,request,"Source control same pull request again");
  const dialog=page.locator("dialog.inspector-text-prompt"),detail=pulls.locator(".pr-detail"),actions=detail.locator(".pr-actions");
  const listed=pulls.locator(".pr-list").getByRole("button",{name:/#11 Feature one/});
  const held=()=>{let release;const promise=new Promise(resolve=>{release=resolve});return {promise,release}};
  const detailReads=()=>host.calls.filter(call=>call.path==="pr-detail").length;
  // While a reviewer is being requested the person clicks the pull request in the list again: once asked, the reviewer is listed.
  await listed.click();await expect(detail.locator("h3")).toHaveText("#11 Feature one");
  let hold=held();host.hold["request-reviewer"]=hold.promise;
  await actions.getByRole("button",{name:"Request reviewer"}).click();
  await expect(dialog).toContainText("Reviewer username");await page.keyboard.type("octocat",{delay:15});await page.keyboard.press("Enter");
  await expect.poll(()=>host.actions().length).toBe(1);
  let reads=detailReads();await listed.click();await expect.poll(detailReads).toBe(reads+1);
  delete host.hold["request-reviewer"];hold.release();
  await expect(detail.locator(".review-list").last().locator(":scope > div")).toHaveText([/^octocat\s*requested$/i]);
  // Likewise a merge: once it is done the detail shows the pull request merged, with no Merge or Auto-merge left to offer.
  hold=held();host.hold.merge=hold.promise;
  await actions.getByRole("button",{name:"Merge",exact:true}).click();await dialog.getByRole("button",{name:"Merge",exact:true}).click();
  await expect.poll(()=>host.actions().length).toBe(2);
  reads=detailReads();await listed.click();await expect.poll(detailReads).toBe(reads+1);
  delete host.hold.merge;hold.release();
  await expect(right.locator(".source-control-notice")).toHaveText("Pull request #11 was merged.");
  await expect(actions.getByRole("button",{name:"Merge",exact:true})).toHaveCount(0);
  await expect(actions.getByRole("button",{name:"Auto-merge",exact:true})).toHaveCount(0);
  await detail.scrollIntoViewIfNeeded();
  await shootBothModes(page,"source-control-merged-after-reopen");
});

test("Link to thread with no thread open says to open one first",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(11,{title:"Feature one"})]});
  const {right,pulls}=await openGitPanel(page,request,"Source control link without thread");
  await pulls.getByRole("button",{name:/#11 Feature one/}).click();
  const link=pulls.locator(".pr-actions").getByRole("button",{name:"Link to thread"});
  await link.click();
  await expect(right.locator(".source-control-error")).toHaveText("Could not link the pull request: Open a thread before linking a pull request.");
  expect(host.calls.filter(call=>call.path==="thread-link"&&call.method==="POST")).toEqual([]);
  await expect(link).toBeEnabled();
  await shootBothModes(page,"source-control-link-without-thread");
});

test("attaching the same pull request again keeps one chip, holding its text as it is now, as a file attached twice does",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const host=await scriptCodeHost(page,{boot,prs:[samplePr(21,{title:"Only PR"}),samplePr(22,{title:"Second PR"})]});
  const {pulls}=await openGitPanel(page,request,"Source control attach twice");
  const chips=page.getByTestId("context-chips").getByTestId("context-chip"),shelf=page.locator(".attachment-shelf > span"),attachButton=pulls.locator(".pr-actions").getByRole("button",{name:"Attach"});
  const attach=async(number,title)=>{await pulls.locator(".pr-list").getByRole("button",{name:new RegExp("#"+number+" ")}).click();await expect(pulls.locator(".pr-detail h3")).toHaveText("#"+number+" "+title);await attachButton.click();await expect(attachButton).toBeEnabled()};
  await attach(21,"Only PR");
  await expect(chips).toHaveText([/PR #21\s*Only PR/]);
  // Renamed on the host and attached again, the pull request still has one chip, now with its new title and text.
  host.prs[0].title="Only PR, renamed";
  await attach(21,"Only PR, renamed");
  await expect(chips).toHaveText([/PR #21\s*Only PR, renamed/]);
  await expect(shelf).toHaveCount(0);
  // Another pull request is a chip of its own.
  await attach(22,"Second PR");
  await expect(chips).toHaveText([/PR #21\s*Only PR, renamed/,/PR #22\s*Second PR/]);
  await expect(shelf).toHaveCount(0);
  await shootBothModes(page,"source-control-attach-twice");
});
