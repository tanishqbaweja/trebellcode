import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const BUILD_BOX={id:"build-box",name:"Build box",type:"ssh",host:"build.example.test",cwd:"/srv/projects",enabled:true};

// The app shell around a Projects page whose project list, environments and Git answers each test supplies.
async function routeProjectsShell(page,{projects:items,environments={profiles:[]},git,mode="dark"}){
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd:"C:/empty",platform:"win32",version:"project-card-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"codex",ready:true,models:["test/coding-fast"],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:"test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:items}));
  await page.route(/\/api\/environments$/,route=>json(route,environments));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/git\/info\?/,async route=>{
    const path=new URL(route.request().url()).searchParams.get("path");
    return json(route,String(path||"").startsWith("C:/repos/")?await git(path):{isGit:false,root:path,branch:null,remotes:[]});
  });
  await page.route(/\/api\/project-actions\/suggestions\?/,route=>json(route,{scripts:[],t3:{present:false},packageManager:null}));
}

test("project cards use one local-or-remote rule and leave out a missing time",async({page})=>{
  test.setTimeout(30_000);
  const opened=Date.UTC(2026,8,23,10,0,0),probed=[];
  await routeProjectsShell(page,{
    projects:[
      // What the periodic-refresh fixture sends: no environment details and no last-opened time.
      {id:"bare-local",name:"Bare Local Project",path:"C:/repos/bare-local",environmentId:null,scripts:[]},
      {id:"named-remote",name:"Named Remote Project",path:"/srv/named",environmentId:"build-box",environment:{id:"build-box",name:"Build box",type:"ssh"},scripts:[],lastOpenedAt:opened},
      {id:"id-only-remote",name:"Id Only Remote Project",path:"/srv/id-only",environmentId:"build-box",scripts:[],lastOpenedAt:"not a time"},
    ],
    environments:{profiles:[BUILD_BOX]},
    git:async path=>{probed.push(path);return {isGit:true,root:path,branch:"main",remotes:[]}},
  });
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const card=name=>page.locator(".project-card").filter({hasText:name});
  const openedText=await page.evaluate(value=>new Date(value).toLocaleString(),opened);
  await expect(card("Bare Local Project").locator(".project-open>div>span")).toHaveText("Local machine · C:/repos/bare-local");
  await expect(card("Bare Local Project").locator(".project-open small")).toHaveText("main");
  await expect(card("Named Remote Project").locator(".project-open>div>span")).toHaveText("Build box · /srv/named");
  await expect(card("Named Remote Project").locator(".project-open small")).toHaveText("remote workspace · "+openedText);
  // A project that names an environment without its details is remote too, named from the environments list.
  await expect(card("Id Only Remote Project").locator(".project-open>div>span")).toHaveText("Build box · /srv/id-only");
  await expect(card("Id Only Remote Project").locator(".project-open small")).toHaveText("remote workspace");
  await expect(page.locator(".projects-page")).not.toContainText("Invalid Date");
  // Only the local checkout is probed for Git; a remote path is never looked up on this machine.
  expect([...new Set(probed)]).toEqual(["C:/repos/bare-local"]);
  await page.screenshot({animations:"disabled",path:auditDir+"projects-card-rule-1280x800.png"});
});

test("the Clone card shows when environments answer, and a card says nothing about Git until Git answers",async({page})=>{
  test.setTimeout(30_000);
  let releaseGit=()=>{};const gitAnswered=new Promise(resolve=>{releaseGit=resolve});
  const opened=Date.UTC(2026,8,23,10,0,0);
  await routeProjectsShell(page,{
    projects:[{id:"pending-git",name:"Pending Git Project",path:"C:/repos/pending-git",environmentId:null,environment:{id:null,name:"Local machine",type:"local"},scripts:[],lastOpenedAt:opened}],
    environments:{profiles:[BUILD_BOX]},
    git:async path=>{await gitAnswered;return {isGit:true,root:path,branch:"main",remotes:[{name:"origin",kind:"fetch",url:"https://example.test/pending-git.git"}]}},
  });
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    const card=page.locator(".project-card").filter({hasText:"Pending Git Project"}),detail=card.locator(".project-open small");
    const openedText=await page.evaluate(value=>new Date(value).toLocaleString(),opened);
    await expect(card).toBeVisible();
    // Git is still loading: environments have answered, so the Clone card is already there with their names.
    const clone=page.locator(".clone-card");
    await expect(clone).toBeVisible();
    await expect(clone.getByLabel("Clone environment")).toContainText("Build box");
    // The card says nothing about Git yet: not "not a Git checkout" and not a branch.
    await expect(detail).toHaveText(openedText);
    await page.screenshot({animations:"disabled",path:auditDir+"projects-git-pending-1280x800.png"});
    releaseGit();
    await expect(detail).toHaveText("main · "+openedText);
    await expect(page.locator(".project-group-head").first()).toContainText("https://example.test/pending-git.git");
    await page.screenshot({animations:"disabled",path:auditDir+"projects-git-answered-1280x800.png"});
  }finally{releaseGit()}
});

// The page draws its cards before Git answers, each in a section of its own under the project's name. When Git answers, a section
// takes its repository's name and a second checkout of the repository moves into it, while the first card of each section stays
// the element it was: the field the person is in keeps the keyboard, and the card being looked at is not swapped for a new one.
test("a card stays the element it was when Git answers and its section takes the repository's name",async({page})=>{
  test.setTimeout(30_000);
  let releaseGit=()=>{};const gitAnswered=new Promise(resolve=>{releaseGit=resolve});
  const local={id:null,name:"Local machine",type:"local"};
  const remotes={"C:/repos/stable-card":"https://example.test/stable-card.git","C:/repos/other-repo":"https://example.test/other-repo.git","C:/repos/stable-card-second":"https://example.test/stable-card.git"};
  await routeProjectsShell(page,{
    projects:[
      {id:"stable-card",name:"Stable Card Project",path:"C:/repos/stable-card",environmentId:null,environment:local,scripts:[]},
      {id:"other-repo",name:"Other Repo Project",path:"C:/repos/other-repo",environmentId:null,environment:local,scripts:[]},
      {id:"stable-card-second",name:"Second Checkout Project",path:"C:/repos/stable-card-second",environmentId:null,environment:local,scripts:[]},
    ],
    git:async path=>{await gitAnswered;return {isGit:true,root:path,branch:"main",remotes:[{name:"origin",kind:"fetch",url:remotes[path]}]}},
  });
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    const labels=page.locator(".project-group-head strong"),counts=page.locator(".project-group-head span"),titles=page.locator(".project-card .project-open strong");
    const card=name=>page.locator(".project-card").filter({hasText:name});
    // Git has not answered: each card is a section of its own, under its project's name, and says nothing about Git.
    await expect(labels).toHaveText(["Stable Card Project","Other Repo Project","Second Checkout Project"]);
    await expect(counts).toHaveText(["Local machine · 1 checkout","Local machine · 1 checkout","Local machine · 1 checkout"]);
    await expect(card("Stable Card Project").locator(".project-open small")).toHaveText("");
    const first=await page.locator(".project-card").first().elementHandle(),other=await card("Other Repo Project").elementHandle();
    const permissions=card("Stable Card Project").getByRole("combobox",{name:"Permissions"});
    await permissions.focus();
    const field=await permissions.elementHandle();
    await page.screenshot({animations:"disabled",path:auditDir+"projects-sections-git-pending-1280x800.png"});
    releaseGit();
    await expect(labels).toHaveText(["https://example.test/stable-card.git","https://example.test/other-repo.git"]);
    await expect(counts).toHaveText(["Local machine · 2 checkouts","Local machine · 1 checkout"]);
    await expect(titles).toHaveText(["Stable Card Project","Second Checkout Project","Other Repo Project"]);
    await expect(card("Stable Card Project").locator(".project-open small")).toHaveText("main");
    await expect(card("Other Repo Project").locator(".project-open small")).toHaveText("main");
    expect(await first.evaluate(node=>node.isConnected),"the first card is the element it was").toBe(true);
    expect(await first.evaluate(node=>node.querySelector(".project-open strong").textContent)).toBe("Stable Card Project");
    expect(await other.evaluate(node=>node.isConnected),"the other repository's card is the element it was").toBe(true);
    expect(await field.evaluate(node=>node.isConnected&&node===document.activeElement),"the Permissions field keeps the keyboard").toBe(true);
    await page.screenshot({animations:"disabled",path:auditDir+"projects-sections-git-answered-1280x800.png"});
  }finally{releaseGit()}
});

test("the Clone repository form gives a repository URL room at desktop widths and wraps cleanly when narrow",async({page})=>{
  test.setTimeout(40_000);
  await routeProjectsShell(page,{
    projects:[{id:"clone-layout",name:"Clone Layout Project",path:"C:/repos/clone-layout",environmentId:null,environment:{id:null,name:"Local machine",type:"local"},scripts:[],lastOpenedAt:Date.now()}],
    environments:{profiles:[BUILD_BOX]},
    git:async path=>({isGit:true,root:path,branch:"main",remotes:[]}),
  });
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const clone=page.locator(".clone-card"),url=clone.getByLabel("Clone URL"),parent=clone.getByLabel("Clone parent directory");
  await expect(parent).toBeVisible();
  // A 50-character repository URL, longer than the 43-character example the form was first tuned to.
  await url.fill("https://github.com/openai/openai-agents-python.git");
  await parent.fill("/srv/projects");
  // 1424 and 1440 are just above the width where the local form keeps one row; 1416 is just below it.
  for(const [width,height,mode] of [[1600,980,"dark"],[1280,800,"dark"],[1600,980,"light"],[1280,800,"light"],[1920,1080,"dark"],[1440,900,"dark"],[1424,900,"dark"],[1416,900,"dark"],[1024,768,"dark"],[900,800,"dark"]]){
    await page.setViewportSize({width,height});
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    const metrics=await cloneLayout(clone),field=label=>metrics.fields.find(item=>item.label===label);
    // The whole URL fits in its field at desktop widths; narrower windows stack the fields without overlap or overflow.
    if(width>=1280)expect(metrics.url.scroll,`URL field at ${width}px`).toBeLessThanOrEqual(metrics.url.client+1);
    // A remote clone has a parent directory to fill as well, so its URL sits on a row of its own under the environment.
    if(width>=1024)expect(field("Clone URL").top,`URL under the environment at ${width}px`).toBeGreaterThanOrEqual(field("Clone environment").bottom-1);
    expect(metrics.card.scroll,`clone card at ${width}px`).toBeLessThanOrEqual(metrics.card.client+1);
    expect(fieldOverlaps(metrics.fields),`overlapping fields at ${width}px`).toEqual([]);
    for(const field of metrics.fields)expect(field.right,`${field.label} at ${width}px`).toBeLessThanOrEqual(metrics.card.right+1);
    await page.screenshot({animations:"disabled",path:auditDir+`projects-clone-form-${mode}-${width}x${height}.png`});
  }
});

test("a local clone keeps the Clone repository form on one row with room for a 50-character URL",async({page})=>{
  test.setTimeout(40_000);
  // The desktop app clones to this machine through its folder picker; a remote environment is still listed.
  await page.addInitScript(()=>{window.trebellDesktop={pickDirectory:async()=>null}});
  await routeProjectsShell(page,{
    projects:[{id:"clone-local",name:"Clone Local Project",path:"C:/repos/clone-local",environmentId:null,environment:{id:null,name:"Local machine",type:"local"},scripts:[],lastOpenedAt:Date.now()}],
    environments:{profiles:[BUILD_BOX]},
    git:async path=>({isGit:true,root:path,branch:"main",remotes:[]}),
  });
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const clone=page.locator(".clone-card"),url=clone.getByLabel("Clone URL");
  await expect(clone.getByLabel("Clone environment")).toHaveValue("local");
  await expect(clone.getByLabel("Clone parent directory")).toHaveCount(0);
  await url.fill("https://github.com/openai/openai-agents-python.git");
  for(const [width,height,mode] of [[1920,1080,"dark"],[1600,980,"dark"],[1600,980,"light"],[1440,900,"dark"],[1424,900,"dark"]]){
    await page.setViewportSize({width,height});
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    const metrics=await cloneLayout(clone),field=label=>metrics.fields.find(item=>item.label===label);
    expect(Math.abs(field("Clone URL").top-field("Clone environment").top),`one row at ${width}px`).toBeLessThan(2);
    expect(metrics.url.scroll,`URL field at ${width}px`).toBeLessThanOrEqual(metrics.url.client+1);
    expect(fieldOverlaps(metrics.fields),`overlapping fields at ${width}px`).toEqual([]);
    expect(metrics.card.scroll,`clone card at ${width}px`).toBeLessThanOrEqual(metrics.card.client+1);
    await page.screenshot({animations:"disabled",path:auditDir+`projects-clone-local-${mode}-${width}x${height}.png`});
  }
  // Switching to the remote environment adds the parent directory and moves the URL to its own row.
  await page.setViewportSize({width:1600,height:980});
  await clone.getByLabel("Clone environment").selectOption("build-box");
  await expect(clone.getByLabel("Clone parent directory")).toHaveValue("/srv/projects");
  const remote=await cloneLayout(clone),field=label=>remote.fields.find(item=>item.label===label);
  expect(field("Clone URL").top).toBeGreaterThanOrEqual(field("Clone environment").bottom-1);
  expect(remote.url.scroll).toBeLessThanOrEqual(remote.url.client+1);
});

// Each field of the Clone repository form with its box, and the URL field's text width against its own.
function cloneLayout(clone){
  return clone.evaluate(node=>{
    const box=element=>element.getBoundingClientRect(),card=box(node);
    const fields=[...node.querySelectorAll("input,select,button")].map(element=>({label:element.getAttribute("aria-label")||element.textContent.trim(),box:box(element)}));
    const field=node.querySelector('[aria-label="Clone URL"]');
    return {card:{left:card.left,right:card.right,scroll:node.scrollWidth,client:node.clientWidth},url:{scroll:field.scrollWidth,client:field.clientWidth},fields:fields.map(item=>({label:item.label,left:item.box.left,right:item.box.right,top:item.box.top,bottom:item.box.bottom}))};
  });
}
function fieldOverlaps(fields){return fields.flatMap((a,i)=>fields.slice(i+1).filter(b=>a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1).map(b=>a.label+" / "+b.label))}

function projects(count){
  return Array.from({length:count},(_,index)=>({
    id:"project-"+String(index).padStart(3,"0"),
    name:"Project "+String(index).padStart(3,"0"),
    path:"C:/repos/project-"+String(index).padStart(3,"0"),
    environmentId:null,
    environment:{id:"local",name:"Local machine",type:"local"},
    scripts:[],
    lastOpenedAt:Date.now()-index*1000,
  }));
}

test("large project lists paint before bounded enrichment finishes",async({page})=>{
  test.setTimeout(30_000);
  const items=projects(120);let projectLoads=0,activeEnrichment=0,maxActiveEnrichment=0,completedEnrichment=0;
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd:"C:/empty",platform:"win32",version:"project-enrichment-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"codex",ready:true,models:["test/coding-fast"],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:"test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>{projectLoads++;return json(route,{projects:projectLoads===1?[]:items})});
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  const enrich=async(route,value)=>{
    activeEnrichment++;maxActiveEnrichment=Math.max(maxActiveEnrichment,activeEnrichment);
    await new Promise(resolve=>setTimeout(resolve,80));
    activeEnrichment--;completedEnrichment++;return json(route,value);
  };
  await page.route(/\/api\/git\/info\?/,route=>{
    const path=new URL(route.request().url()).searchParams.get("path");
    if(!String(path||"").startsWith("C:/repos/project-"))return json(route,{isGit:false,root:path,branch:null,remotes:[]});
    return enrich(route,{isGit:true,root:path,branch:"main",remotes:[{name:"origin",kind:"fetch",url:"https://example.test/shared.git"}]});
  });
  await page.route(/\/api\/project-actions\/suggestions\?/,route=>enrich(route,{scripts:[{name:"Test",command:"npm test"}],t3:{present:false},packageManager:"npm"}));

  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.locator(".project-card .project-open").filter({hasText:"Project 000"}).first()).toBeVisible({timeout:1500});
  expect(completedEnrichment).toBeLessThan(240);
  await expect(page.locator(".project-card")).toHaveCount(24);
  await expect.poll(()=>completedEnrichment,{timeout:10_000}).toBe(240);
  expect(maxActiveEnrichment).toBeLessThanOrEqual(12);
  expect(projectLoads).toBe(2);
  await expect(page.locator(".project-card .project-open small").filter({hasText:"main"}).first()).toBeVisible();
  await expect(page.locator(".project-group-head").first()).toContainText("120 checkouts");
  const search=page.getByRole("textbox",{name:"Search projects"});
  await search.fill("Project 099");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await expect(page.locator(".project-card .project-open").filter({hasText:"Project 099"})).toBeVisible();
  await search.fill("");
  await expect(page.locator(".project-card")).toHaveCount(24);
  await page.getByRole("button",{name:"Show 24 more"}).click();
  await expect(page.locator(".project-card")).toHaveCount(48);
  await page.locator(".secondary-page").evaluate(node=>{node.scrollTop=0});
  await page.screenshot({animations:"disabled",path:"visual-audit/projects-bounded-enrichment-dark-1280x800.png"});
});
