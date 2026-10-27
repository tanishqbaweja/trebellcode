import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Antigravity's sign-in in Settings is a Gemini API key from Google AI Studio, the route Google recommends for third-party apps: the
// Antigravity row says it needs one and where to get one, its Sign in opens the key form, which says why Trebell offers no Google
// sign-in, and the key typed there goes to the server's sign-in and is never shown again. A sign-in that fails (Google out of reach)
// is said in the form; one that works closes it, says so and takes the harness list it answers with, without asking for the list
// again. Once a key is saved the form offers Remove key. The harness lists are the server's own reading (AgentRuntimeManager's
// snapshot of a managed Antigravity install in a home of the test's own); /api/agent-runtime-auth is the test's, saving the key as
// the server does once Antigravity has signed in with it.
const shots=fileURLToPath(new URL("../../visual-audit/polish/antigravity-sign-in/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const KEY="AIzaSyE2eFixtureKeyForTrebell0123456789";
const NEEDED="Antigravity needs a Gemini API key. Create one in Google AI Studio (aistudio.google.com/apikey), then add it to Antigravity in Settings.";
const UNREACHABLE="Antigravity did not finish signing in with the Gemini API key within 5 minutes: it could not reach Google. Check this machine's network connection, then try again. Broken IPv6 is a common cause, as Antigravity has no IPv4 fallback.";
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
const said=row=>row.locator("button").first().locator("small");
const action=row=>row.locator("button").first().locator("em");

test("Antigravity signs in with a Gemini API key typed in Settings, which is never shown again, and says why a sign-in failed",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-agy-key-")),trebell=join(home,"trebell");
  // A managed Antigravity install (its install.json and executable); no other harness is on this machine.
  const current=join(trebell,"agent-runtimes","antigravity","current");mkdirSync(current,{recursive:true});
  for(const name of ["agy_acp_server.exe","agy_acp_server.par"])writeFileSync(join(current,name),"fixture");
  writeFileSync(join(current,"install.json"),JSON.stringify({runtime:"antigravity",version:"1.4.3"}));
  const saveKey=key=>writeFileSync(join(trebell,"harness-secrets.json"),JSON.stringify(key?{"antigravity.geminiApiKey":key}:{}));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},env:{PATH:"/usr/bin",HOME:home,USERPROFILE:home,TREBELL_HOME:trebell},runFn:async command=>missing(command)});
  const native=(await manager.snapshot()).statuses.find(item=>item.kind==="native");
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,{...settings,...saved})});
  await page.route(/\/api\/state$/,route=>json(route,{settings:{...settings,...saved},projects:[],threadMeta:{}}));
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeReady:true,agentRuntimeStatus:native,appServerReady:false,wsUrl:"",cwd:home,platform:process.platform,version:"antigravity-sign-in",settings:{...settings,...saved},logs:[]}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:native,provider:"openai",providerReady:true,appServerReady:false,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"native",ready:true,models:["gpt-fixture"],metadata:{provider:"openai",models:[{id:"gpt-fixture",name:"GPT Fixture",provider:"openai"}]}}));
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  let listings=0;
  await page.route(/\/api\/agent-runtimes$/,async route=>{if(route.request().method()!=="GET")return route.continue();listings++;return json(route,await manager.snapshot())});
  // The sign-in: each answer as the server gives it. A held answer waits for release().
  const posts=[];let plan=[],release=null;
  await page.route(/\/api\/agent-runtime-auth$/,async route=>{
    const body=route.request().postDataJSON();posts.push(body);
    if(body.action==="remove-key"){saveKey(null);return json(route,{ok:true,authenticated:false,agentSnapshot:await manager.snapshot()})}
    const next=plan.shift();
    if(next==="held")await new Promise(resolve=>{release=resolve});
    if(next==="refuse"||next==="held")return json(route,{ok:false,error:UNREACHABLE},400);
    saveKey(body.apiKey);
    return json(route,{ok:true,authenticated:true,auth:{runtime:"antigravity",instanceId:"antigravity-default",methodId:"gemini-api-key",methodName:"Gemini API key"},agentSnapshot:await manager.snapshot()});
  });
  // Get a key opens Google AI Studio in a new tab: the tabs asked for are kept instead.
  await page.addInitScript(()=>{window.__opened=[];window.open=(...args)=>{window.__opened.push(args[0]);return null}});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    const antigravity=harnessRow(page,"Antigravity"),form=page.getByTestId("antigravity-key-form");
    // Without a key: why it is not ready and where to get one, and Sign in.
    await expect(said(antigravity)).toHaveText(NEEDED);
    await expect(action(antigravity)).toHaveText("Not ready");
    const signIn=antigravity.getByRole("button",{name:"Sign in",exact:true});
    await expect(signIn).toBeEnabled();
    await signIn.click();
    // The key form, its field taking the keyboard, says why there is no Google sign-in.
    await expect(form).toBeVisible();
    const field=form.getByLabel("Antigravity · Gemini API key");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type","password");await expect(field).toHaveAttribute("placeholder","Paste a Gemini API key");
    await expect(form).toContainText("Trebell Code runs Antigravity on a Gemini API key from Google AI Studio, billed to that key: the route Google recommends for third-party apps. A Google account's sign-in through a third-party app falls under Google's Antigravity terms, so Trebell Code does not offer it.");
    const save=form.getByRole("button",{name:"Save key and sign in"});
    await expect(save).toBeDisabled();
    await expect(form.getByRole("button",{name:"Remove key"})).toHaveCount(0);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await form.scrollIntoViewIfNeeded();await expect(form).toBeInViewport({ratio:1});
      await page.screenshot({animations:"disabled",path:shots+`key-form-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    await field.click();
    await page.keyboard.type(KEY,{delay:5});
    await expect(save).toBeEnabled();
    // Google out of reach: the form waits while Antigravity starts, then says why, and the key stays in the field to try again.
    plan=["held"];
    await page.keyboard.press("Enter");
    await expect(form.getByRole("button",{name:"Checking key…"})).toBeDisabled();
    await expect(form.getByRole("status")).toHaveText("Antigravity is starting with the key. This takes about half a minute, and up to 5 minutes on a slow network.");
    await expect(field).toBeDisabled();
    await page.screenshot({animations:"disabled",path:shots+"key-checking-dark-1280.png"});
    release();
    await expect(form.getByRole("alert")).toHaveText(UNREACHABLE);
    await expect(field).toBeEnabled();await expect(field).toHaveValue(KEY);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"key-unreachable-dark-1280.png"});
    expect(posts).toEqual([{action:"login",runtime:"antigravity",instanceId:"antigravity-default",apiKey:KEY}]);
    // Tried again, it signs in: the form closes, the line under the list says so, and the row takes the list the answer brought.
    const listingsBefore=listings;
    await save.click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId("agent-runtime-message")).toHaveText(" · Gemini API key saved, and Antigravity opened a session with it. Google checks the key with the first chat message.");
    await expect(said(antigravity)).toHaveText("1.4.3");
    await expect(action(antigravity)).toHaveText("Switch");
    expect(listings-listingsBefore,"the harness list came with the answer").toBe(0);
    expect(posts.at(-1)).toEqual({action:"login",runtime:"antigravity",instanceId:"antigravity-default",apiKey:KEY});
    expect(await page.evaluate(key=>document.body.innerText.includes(key)||[...document.querySelectorAll("input")].some(input=>input.value.includes(key)),KEY),"the key is nowhere on the page").toBe(false);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await antigravity.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`key-saved-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // Sign in again: the form says a key is saved without showing it, and offers Remove key and Google AI Studio.
    await signIn.click();
    await expect(field).toBeFocused();await expect(field).toHaveValue("");await expect(field).toHaveAttribute("placeholder","Saved key ••••••••");
    await form.getByRole("button",{name:"Get a key in Google AI Studio"}).click();
    expect(await page.evaluate(()=>window.__opened)).toEqual(["https://aistudio.google.com/apikey"]);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"key-form-saved-dark-1280.png"});
    // Escape in the field closes the form; Remove key takes the key out, and the row says a key is needed again.
    await field.press("Escape");
    await expect(form).toHaveCount(0);
    await signIn.click();
    await form.getByRole("button",{name:"Remove key"}).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId("agent-runtime-message")).toHaveText(" · Antigravity: Gemini API key removed.");
    await expect(said(antigravity)).toHaveText(NEEDED);
    expect(posts.at(-1)).toEqual({action:"remove-key",runtime:"antigravity",instanceId:"antigravity-default"});
  }finally{
    rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
