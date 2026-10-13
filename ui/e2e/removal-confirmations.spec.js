import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Removals that lose what a person set up ask first, in the app's own dialog: Cancel (or Escape) changes nothing, and the dialog's
// own button removes. Used the way a person uses them: real clicks and keys, with the requests the page sends counted.
const shots=fileURLToPath(new URL("../../visual-audit/polish/removal-confirmations/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const question=page=>page.locator("dialog.inspector-text-prompt");
// The page as it is now, dark and light, at 1280 wide; left dark.
async function shootModes(page,name){
  await page.setViewportSize({width:1280,height:800});
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`});
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
}

test("Remove on a runtime profile asks first, and Cancel or Escape keeps the profile",async({page})=>{
  test.setTimeout(45_000);
  let instances=[
    {id:"codex-default",kind:"codex",displayName:"Codex",enabled:true},
    {id:"codex-spare",kind:"codex",displayName:"Codex Spare",enabled:true,homePath:"C:/codex-spare",binaryPath:"C:/tools/codex.exe"},
  ];
  const deletes=[];
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const snapshot=()=>({selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances,statuses:instances.map(item=>({id:item.id,kind:item.kind,name:item.displayName,available:true,installed:true,authenticated:true,version:"fixture"}))});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"removal-confirmations-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"codex",models:["fixture-model"],metadata:{models:[{id:"fixture-model",name:"Fixture model",agent:"codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>{
    if(route.request().method()==="GET")return json(route,snapshot());
    if(route.request().method()!=="DELETE")return json(route,snapshot());
    const id=new URL(route.request().url()).searchParams.get("id");deletes.push(id);instances=instances.filter(item=>item.id!==id);
    return json(route,{ok:true,resetTo:null,kind:"codex",...snapshot()});
  });
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const spare=page.locator(".runtime-profile-row").filter({hasText:"Codex Spare"}),remove=spare.getByRole("button",{name:"Remove",exact:true});
  const card=page.locator(".agent-runtime-settings");
  await remove.click();
  await expect(question(page)).toBeVisible();
  await expect(question(page).locator("p")).toHaveText("Remove the runtime profile “Codex Spare”? This cannot be undone: its paths and settings are lost.");
  await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  expect(deletes,"nothing is removed while the question is open").toEqual([]);
  await shootModes(page,"runtime-profile-remove-question");
  await question(page).getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(question(page)).toHaveCount(0);
  await expect(spare).toBeVisible();
  await expect(remove).toBeFocused();
  await expect(card).not.toContainText("Runtime profile removed.");
  // Escape is a Cancel too.
  await remove.click();await expect(question(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question(page)).toHaveCount(0);
  await expect(spare).toBeVisible();
  expect(deletes,"Cancel and Escape remove nothing").toEqual([]);
  // The dialog's own button removes it.
  await remove.click();
  await question(page).getByRole("button",{name:"Remove profile",exact:true}).click();
  await expect(spare).toHaveCount(0);
  await expect(card).toContainText("Runtime profile removed.");
  expect(deletes).toEqual(["codex-spare"]);
  await shootModes(page,"runtime-profile-removed");
});
