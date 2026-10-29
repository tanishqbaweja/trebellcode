import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../../src/provider-manager.mjs";

// Antigravity signs in as the person sets it, like every harness but Cursor: on Sign in (the default) its row says it is not signed in
// and its Sign in runs Antigravity's own sign-in (the agent opens Google's page itself; Trebell never reads the token it keeps), and
// once signed in the row says so and its Sign in stays, to sign in again. Set to its API key, it runs on the Google Gemini key of the Model
// provider card's store: with none the row says the key is missing and where to add it, with no Sign in of its own, and a key saved on
// the row makes it ready. There is no Antigravity key form any more. The harness lists are the server's own reading
// (AgentRuntimeManager's snapshot of a managed Antigravity install in a home of the test's own, over a ProviderManager of the test's
// own); /api/agent-runtime-auth and /api/providers are the test's, doing what the server does (Antigravity's own sign-in leaves its
// method and its token file in its home, as Antigravity does).
const shots=fileURLToPath(new URL("../../visual-audit/polish/antigravity-own-sign-in/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
// Nothing of this test reaches the network: the manager's release checks are refused.
const offline=async url=>{throw new Error("offline e2e: no request to "+url)};
const KEY="AIzaSyE2eFixtureKeyForTrebell0123456789";
const NOT_SIGNED_IN="Antigravity is not signed in. Press Sign in to sign in with Antigravity's own sign-in, or set it to run on a Google Gemini API key.";
const KEY_MISSING="Antigravity is set to run on the Google Gemini API key, and Trebell Code has none. Add it under Antigravity in Settings → Agents & models, or set Antigravity to Sign in.";
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
const said=row=>row.locator("button").first().locator("small");
const action=row=>row.locator("button").first().locator("em");
async function shoot(page,row,name){
  for(const mode of ["dark","light"]){await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`})}
  await switchMode(page,"dark");
}

test("Antigravity signs in with its own sign-in from its row, and set to its API key runs on the Gemini key saved there",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-agy-own-")),trebell=join(home,"trebell");
  try{
    // A managed Antigravity install (its install.json and executable); no other harness is on this machine.
    const current=join(trebell,"agent-runtimes","antigravity","current");mkdirSync(current,{recursive:true});
    for(const name of ["agy_acp_server.exe","agy_acp_server.par"])writeFileSync(join(current,name),"fixture");
    writeFileSync(join(current,"install.json"),JSON.stringify({runtime:"antigravity",version:"1.4.3"}));
    const agyAcp=join(trebell,"antigravity-home","antigravity-acp");
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
    const env={PATH:"/usr/bin",HOME:home,USERPROFILE:home,TREBELL_HOME:trebell};
    const providers=new ProviderManager({env});
    const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env,providers,runFn:async command=>missing(command),fetchImpl:offline});
    const native=(await manager.snapshot()).statuses.find(item=>item.kind==="native");
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeReady:true,agentRuntimeStatus:native,appServerReady:false,wsUrl:"",cwd:home,platform:process.platform,version:"antigravity-own-sign-in",settings,logs:[]}));
    await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:native,provider:"openai",providerReady:true,appServerReady:false,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
    await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"native",ready:true,models:["gpt-fixture"],metadata:{provider:"openai",models:[{id:"gpt-fixture",name:"GPT Fixture",provider:"openai"}]}}));
    const keyPosts=[];
    await page.route(/\/api\/providers$/,async route=>{
      if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};keyPosts.push(body);if("apiKey" in body)providers.setKey(body.provider,body.apiKey)}
      return json(route,{selected:"openai",agentRuntime:"native",providers:providers.definitions(),status:providers.status("openai"),ready:true,models:["gpt-fixture"],defaultModel:"gpt-fixture",metadata:null,error:null});
    });
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/agent-runtimes$/,async route=>route.request().method()==="GET"?json(route,await manager.snapshot()):route.continue());
    const authPosts=[];
    await page.route(/\/api\/agent-runtime-auth$/,async route=>{
      const body=route.request().postDataJSON()||{};authPosts.push(body);
      if(body.action==="method"){const {instance}=manager.setAuthMethod(body.instanceId,body.method);return json(route,{ok:true,instanceId:instance.id,method:instance.auth,stoppedChats:0,agentSnapshot:await manager.snapshot()})}
      // Antigravity's own sign-in, as the agent leaves it: the method in its home's settings and its token file there.
      mkdirSync(agyAcp,{recursive:true});
      writeFileSync(join(agyAcp,"settings.json"),JSON.stringify({auth:{type:"oauth-personal"}}));writeFileSync(join(agyAcp,"acp_token.json"),"fixture");
      return json(route,{ok:true,authenticated:true,auth:{runtime:"antigravity",instanceId:"antigravity-default",methodId:"oauth-personal",methodName:"Log in with Google"},stoppedChats:0,agentSnapshot:await manager.snapshot()});
    });
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    const antigravity=harnessRow(page,"Antigravity"),choice=antigravity.getByRole("radiogroup",{name:"Antigravity signs in with"});
    // On Sign in, not signed in yet: the row says so and offers its own sign-in; no key form, no key field.
    await expect(said(antigravity)).toHaveText(NOT_SIGNED_IN);
    await expect(action(antigravity)).toHaveText("Not ready");
    await expect(choice.getByRole("radio",{name:"Sign in"})).toBeChecked();
    await expect(antigravity.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByTestId("antigravity-key-form")).toHaveCount(0);
    await shoot(page,antigravity,"antigravity-not-signed-in");
    await antigravity.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("Antigravity signed in (Log in with Google).");
    expect(authPosts.at(-1)).toMatchObject({action:"login",runtime:"antigravity",instanceId:"antigravity-default"});
    expect(Object.keys(authPosts.at(-1)).includes("apiKey"),"the sign-in carries no key").toBe(false);
    await expect(said(antigravity)).toHaveText("1.4.3 · Signed in with Antigravity's own sign-in.");
    await expect(action(antigravity)).toHaveText("Switch");
    // Its Sign in stays, to sign in again (another account): only a chat checks Antigravity's sign-in.
    await expect(antigravity.getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
    await shoot(page,antigravity,"antigravity-signed-in");
    // Set to its API key with no Gemini key: plainly missing, where to add it, and no sign-in of its own.
    await choice.getByRole("radio",{name:"API key"}).check();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("Antigravity runs on its API key.");
    expect(authPosts.at(-1)).toEqual({action:"method",instanceId:"antigravity-default",method:"api-key"});
    await expect(said(antigravity)).toHaveText(KEY_MISSING);
    await expect(action(antigravity)).toHaveText("Not ready");
    await expect(antigravity.getByRole("button",{name:/^Sign in/})).toHaveCount(0);
    const panel=antigravity.getByTestId("harness-auth-antigravity");
    await expect(panel).toContainText("Uses the Google Gemini API key: none saved yet.");
    await shoot(page,antigravity,"antigravity-key-missing");
    await panel.getByLabel("Google Gemini API key for Antigravity").click();await page.keyboard.type(KEY,{delay:2});
    await panel.getByRole("button",{name:"Save key"}).click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("API key saved.");
    expect(keyPosts).toEqual([{provider:"gemini",apiKey:KEY,select:false}]);
    await expect(said(antigravity)).toHaveText("1.4.3 · Runs on the Google Gemini API key.");
    await expect(action(antigravity)).toHaveText("Switch");
    await expect(panel).toContainText("Uses the Google Gemini API key, saved in Trebell Code, shared with Trebell Native.");
    expect(await page.evaluate(key=>document.body.innerText.includes(key)||[...document.querySelectorAll("input")].some(input=>input.value.includes(key)),KEY),"the key is nowhere on the page").toBe(false);
    // The launch it now runs with carries that key as GEMINI_API_KEY, and its own sign-in stays in its home for Sign in.
    const launch=manager.childEnv(manager.instances().find(item=>item.id==="antigravity-default"));
    expect(launch.GEMINI_API_KEY).toBe(KEY);
    await shoot(page,antigravity,"antigravity-key-saved");
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});
