import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The sidebar's Search threads field over saved threads of two projects, as the thread catalog lists them before any harness
// answers (as sidebar-virtualization.spec.js does). Both projects live under one parent folder ("fixtures-search"), the way a
// person's repositories share a home or repos folder, and Beacon's folder is not named after it.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const root="C:/work/fixtures-search";
const projects=[
  {id:"search-atlas",name:"Atlas",path:root+"/atlas",environmentId:null,effectiveSettings:{}},
  {id:"search-beacon",name:"Beacon",path:root+"/b-repo",environmentId:null,effectiveSettings:{}},
];
const rows=[["Fix login redirect",projects[0].path],["Explain codebase",projects[0].path],["Fix timezone bug",projects[1].path],["Write release notes",projects[1].path],["Plan the roadmap",root+"/scratch/beacon-notes",true]];
// The sidebar's order: the General chat's group, then Active, newest first.
const everyThread=["Plan the roadmap","Fix login redirect","Explain codebase","Fix timezone bug","Write release notes"];

async function openCatalog(page){
  const now=Date.now()/1000;
  const threadMeta=Object.fromEntries(rows.map(([name,cwd,projectless],index)=>{
    const id="search-thread-"+index,updatedAt=now-index*60;
    return [id,{projectless:Boolean(projectless),environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id,name,preview:name,cwd,model:"test/coding-fast",createdAt:updatedAt-100,updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}}];
  }));
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd:projects[0].path,platform:process.platform,version:"sidebar-search-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects,threadMeta}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"codex",ready:true,models:["test/coding-fast"],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:"test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project:projects[0]}:{projects}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?(route.request().postDataJSON()?.patch||{}):{}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect.poll(()=>listed(page)).toEqual(everyThread);
}
const listed=page=>page.locator(".thread-sections .thread-main").evaluateAll(nodes=>nodes.map(node=>node.title));
// A person clicks into the field, types, and reads the list once it settles.
async function search(page,text){
  const field=page.getByRole("textbox",{name:"Search threads"});
  await field.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
  await page.keyboard.type(text,{delay:40});await expect(field).toHaveValue(text);
  return field;
}

// The header's theme button, as a person switches between dark and light, and the window at 1280x800 and 900x800 in that mode.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function shoot(page,name){
  const mode=await page.locator("html").getAttribute("data-mode");
  for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
  await page.setViewportSize({width:1280,height:800});
}

test("the sidebar search finds threads by their title or their project's name, not by the folders around the project",async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await openCatalog(page);
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    // Every folder holds "fixtures", so a search that read whole paths listed every thread for "fix".
    await search(page,"fix");
    await expect.poll(()=>listed(page)).toEqual(["Fix login redirect","Fix timezone bug"]);
    await shoot(page,"sidebar-search-title");
  }
  // Beacon's threads by the project's name, which its folder (b-repo) does not hold; the General chat, whose scratch folder is
  // named after Beacon, belongs to no project.
  await search(page,"beacon");
  await expect.poll(()=>listed(page)).toEqual(["Fix timezone bug","Write release notes"]);
  await search(page,"atlas");
  await expect.poll(()=>listed(page)).toEqual(["Fix login redirect","Explain codebase"]);
  // A word only the paths hold finds nothing.
  await search(page,"work");
  await expect.poll(()=>listed(page)).toEqual([]);
  await expect(page.locator(".sidebar-empty")).toHaveText("No matching threads.");
});

test("Clear search gives the list back and leaves focus in the search field, ready for the next search",async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await openCatalog(page);
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    const field=await search(page,"timezone");
    await expect.poll(()=>listed(page)).toEqual(["Fix timezone bug"]);
    await page.getByRole("button",{name:"Clear search",exact:true}).click();
    await expect(field).toHaveValue("");await expect(field).toBeFocused();
    await expect.poll(()=>listed(page)).toEqual(everyThread);
    await shoot(page,"sidebar-search-cleared");
    // The next search is typed straight in.
    await page.keyboard.type("release",{delay:40});
    await expect(field).toHaveValue("release");
    await expect.poll(()=>listed(page)).toEqual(["Write release notes"]);
  }
});
