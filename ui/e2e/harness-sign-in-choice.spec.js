import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../../src/provider-manager.mjs";

// Each official harness signs in as the person sets it in Settings → Agents & models: Sign in, its own login (the default), or API
// key, its vendor's key from Trebell's one key per provider, which its row names and lets the person add or replace there, in the
// store the Model provider card uses. Cursor has no API key and shows no choice. The choice and the key go to the server (the mock
// GUI server of this run, which saves a key without contacting the provider), show on the row, and are there after a reload; the key
// itself never comes back to the page.
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-sign-in/",import.meta.url));mkdirSync(shots,{recursive:true});
const KEY="sk-ant-e2e-fixture-key-for-trebell-0123456789";
const WITH_CHOICE=["Codex","Claude Code","Grok Build","OpenCode","Antigravity","Muse Code"];
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
const harnessRow=(page,name)=>page.locator(".agent-runtime-option:not(.agent-runtime-skeleton)").filter({has:page.locator("strong",{hasText:new RegExp("^"+name+"$")})});
async function openAgents(page){
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
  await expect(harnessRow(page,"Claude Code")).toBeVisible({timeout:15_000});
}

test("each harness but Cursor offers Sign in or its provider's API key, the key is added on its row, and both survive a reload",async({page,request})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  // What this spec needs, whatever ran before it: its own sign-in on Claude Code, and no Anthropic key saved.
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0}})).status()).toBe(200);
  expect((await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"sign-in"}})).status()).toBe(200);
  expect((await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}})).status()).toBe(200);
  try{
    await openAgents(page);
    // Every harness that runs on an API key shows the choice, on Sign in; Cursor shows none.
    for(const name of WITH_CHOICE){
      const group=harnessRow(page,name).getByRole("radiogroup",{name:name+" signs in with"});
      await expect(group,name).toBeVisible();
      await expect(group.getByRole("radio",{name:"Sign in"}),name).toBeChecked();
      await expect(group.getByRole("radio",{name:"API key"}),name).not.toBeChecked();
    }
    await expect(harnessRow(page,"Cursor").getByRole("radiogroup")).toHaveCount(0);
    await expect(harnessRow(page,"Cursor").getByRole("radio")).toHaveCount(0);
    await expect(page.getByTestId("antigravity-key-form")).toHaveCount(0);
    await expect(harnessRow(page,"Antigravity").getByRole("button",{name:"Change key"})).toHaveCount(0);

    // Claude Code set to its API key: its row names the Anthropic key, says none is saved, and takes one.
    const claude=harnessRow(page,"Claude Code"),choice=claude.getByRole("radiogroup",{name:"Claude Code signs in with"});
    await choice.getByRole("radio",{name:"API key"}).check();
    await expect(choice.getByRole("radio",{name:"API key"})).toBeChecked();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("Claude Code runs on its API key.");
    const panel=claude.getByTestId("harness-auth-claude");
    await expect(panel).toContainText("Uses the Anthropic API key: none saved yet.");
    const field=panel.getByLabel("Anthropic API key for Claude Code");
    await expect(field).toHaveAttribute("type","password");await expect(field).toHaveAttribute("placeholder","Paste Anthropic API key");
    const save=panel.getByRole("button",{name:"Save key"});
    await expect(save).toBeDisabled();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-empty-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    await field.click();await page.keyboard.type(KEY,{delay:2});
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("API key saved.");
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code.");
    await expect(field).toHaveValue("");await expect(field).toHaveAttribute("placeholder","Saved key ••••••••");
    await expect(panel.getByRole("button",{name:"Replace key"})).toBeDisabled();
    // On its API key Claude Code offers no sign-in of its own.
    await expect(claude.getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
    expect(await page.evaluate(key=>document.body.innerText.includes(key)||[...document.querySelectorAll("input")].some(input=>input.value.includes(key)),KEY),"the key is nowhere on the page").toBe(false);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-saved-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // The server keeps both: the profile's choice and the key in the provider store, answered without the key.
    const listed=await (await request.get("/api/agent-runtimes")).json();
    expect(listed.instances.find(item=>item.id==="claude-default").signIn).toEqual({method:"api-key",keys:[{provider:"anthropic",name:"Anthropic API",variable:"ANTHROPIC_API_KEY",saved:true,source:"settings",from:null}]});
    expect(JSON.stringify(listed)).not.toContain(KEY);
    const providers=await (await request.get("/api/providers")).json();
    expect(providers.providers.find(item=>item.id==="anthropic").hasKey).toBe(true);expect(JSON.stringify(providers)).not.toContain(KEY);
    expect(providers.selected,"the key saved for a harness keeps the provider Native calls").not.toBe("anthropic");

    // After a reload the row still says so.
    await page.reload();await openAgents(page);
    const again=harnessRow(page,"Claude Code");
    await expect(again.getByRole("radiogroup",{name:"Claude Code signs in with"}).getByRole("radio",{name:"API key"})).toBeChecked();
    await expect(again.getByTestId("harness-auth-claude")).toContainText("Uses the Anthropic API key, saved in Trebell Code.");
    await expect(harnessRow(page,"Codex").getByRole("radiogroup",{name:"Codex signs in with"}).getByRole("radio",{name:"Sign in"})).toBeChecked();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await again.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-reloaded-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // Back to its own sign-in: the key field goes, and the key stays saved for Native and the other harnesses.
    await again.getByRole("radiogroup",{name:"Claude Code signs in with"}).getByRole("radio",{name:"Sign in"}).check();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("Claude Code signs in with its own sign-in.");
    await expect(again.getByTestId("harness-auth-claude").getByLabel("Anthropic API key for Claude Code")).toHaveCount(0);
    expect((await (await request.get("/api/agent-runtimes")).json()).instances.find(item=>item.id==="claude-default").signIn.method).toBe("sign-in");
    // OpenCode runs on each saved key of a provider it supports: its row lists them and lets the person pick which to add.
    const opencode=harnessRow(page,"OpenCode");
    await opencode.getByRole("radiogroup",{name:"OpenCode signs in with"}).getByRole("radio",{name:"API key"}).check();
    const openPanel=opencode.getByTestId("harness-auth-opencode");
    await expect(openPanel).toContainText("Uses each saved key: OpenAI API key (none), Anthropic API key (saved), Google Gemini API key (none), xAI API key (none).");
    await expect(openPanel.getByLabel("Key for OpenCode",{exact:true})).toHaveValue("openai");
    await opencode.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:shots+"opencode-api-keys-dark-1280.png"});
    await opencode.getByRole("radiogroup",{name:"OpenCode signs in with"}).getByRole("radio",{name:"Sign in"}).check();
    await expect(openPanel.getByLabel("Key for OpenCode",{exact:true})).toHaveCount(0);
  }finally{
    await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"sign-in"}});
    await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"opencode",instanceId:"opencode-default",method:"sign-in"}});
    await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}});
  }
});

test("a profile's approved names refuse a key on Save, saying how a harness signs in instead",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai"}})).status()).toBe(200);
  await openAgents(page);
  const add=page.getByRole("button",{name:"Add profile",exact:true});
  await expect(add).toBeEnabled({timeout:15_000});
  await add.click();
  const editor=page.locator(".runtime-profile-editor");
  await expect(editor.getByLabel("Signs in with")).toHaveValue("sign-in");
  const keys=editor.getByRole("textbox",{name:"Approved inherited environment variables"});
  await keys.click();await page.keyboard.type("HTTPS_PROXY\nOPENAI_API_KEY",{delay:5});
  await editor.getByRole("button",{name:"Save profile",exact:true}).click();
  const refusal=editor.getByRole("alert");
  await expect(refusal).toContainText("OPENAI_API_KEY holds an API key or sign-in, which a profile never passes to Codex. To run Codex on an API key, set it to API key under Codex in Agents & models, which uses the key saved for its provider. Keys for Trebell Native go in its Model provider card.");
  await refusal.scrollIntoViewIfNeeded();
  for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:shots+`profile-key-refused-${mode}-1280.png`})}
  await switchMode(page,"dark");
  // The refusal is the server's, whatever sends the profile.
  const direct=await request.post("/api/agent-runtimes",{data:{action:"upsert",instance:{id:"codex-e2e-key",kind:"codex",approvedEnvironmentKeys:["ANTHROPIC_API_KEY"]}}});
  expect(direct.status()).toBe(400);expect((await direct.json()).error).toContain("ANTHROPIC_API_KEY holds an API key or sign-in");
});

// An installed Claude Code set to its API key with no Anthropic key anywhere: its row says plainly that the key is missing and where
// to add it, offers no sign-in of its own and cannot be switched to, and is ready once the key is saved on that row. The harness list
// is the server's own reading of it (AgentRuntimeManager's snapshot over a ProviderManager of the test's own, Claude Code's answers
// stubbed as Claude Code 2.x gives them: `claude auth status` signed in on the key only when its launch has ANTHROPIC_API_KEY).
test("an installed harness on its API key with no key says so on its row and is ready once the key is saved there",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-key-missing-"));
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,HOME:home,USERPROFILE:home,TEMP:home,TMP:home,TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex")};
  const providers=new ProviderManager({env}),launches=[];
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[{id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,binaryPath:process.execPath,environment:{},auth:"api-key"}]};
  const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
  const runFn=async(command,args,options)=>{
    if(command!==process.execPath)return {ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""};
    if(args[0]==="--version")return answered("2.1.311 (Claude Code)\n");
    launches.push(options?.env?.ANTHROPIC_API_KEY||null);
    return options?.env?.ANTHROPIC_API_KEY?answered(JSON.stringify({loggedIn:true,authMethod:"api_key",apiProvider:"firstParty",apiKeySource:"ANTHROPIC_API_KEY"}))
      :{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env,runFn,providers,fetchImpl:async url=>{throw new Error("offline e2e: no request to "+url)}});
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}})).status()).toBe(200);
  await page.route(/\/api\/agent-runtimes$/,async route=>route.request().method()==="GET"?json(route,await manager.snapshot()):route.continue());
  // The row's Save key goes to the real server (its store, as the Model provider card's), and the test's own store takes it too.
  const posted=[];
  await page.route(/\/api\/providers$/,async route=>{
    if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};posted.push(body);if("apiKey" in body)providers.setKey(body.provider,body.apiKey)}
    return route.continue();
  });
  try{
    await openAgents(page);
    const claude=harnessRow(page,"Claude Code"),said=claude.locator("button").first().locator("small"),chip=claude.locator("button").first().locator("em");
    const MISSING="Claude Code is set to run on the Anthropic API key, and Trebell Code has none. Add it under Claude Code in Settings → Agents & models, or set Claude Code to Sign in.";
    await expect(said).toHaveText(MISSING);
    await expect(chip).toHaveText("Not ready");
    await expect(claude.locator("button").first()).toBeDisabled();
    await expect(claude.getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
    await expect(claude.getByRole("radiogroup",{name:"Claude Code signs in with"}).getByRole("radio",{name:"API key"})).toBeChecked();
    const panel=claude.getByTestId("harness-auth-claude");
    await expect(panel).toContainText("Uses the Anthropic API key: none saved yet.");
    expect(launches.length,"Claude Code's own check ran").toBeGreaterThan(0);
    expect(launches.every(key=>key===null),"with no key, none reached it").toBe(true);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-installed-key-missing-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    await panel.getByLabel("Anthropic API key for Claude Code").click();await page.keyboard.type(KEY,{delay:2});
    await panel.getByRole("button",{name:"Save key"}).click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("API key saved.");
    // The list read again: ready on the key, with what it runs on beside its version.
    await expect(said).toHaveText("2.1.311 (Claude Code) · Runs on the Anthropic API key.");
    await expect(chip).toHaveText("Switch");
    await expect(claude.locator("button").first()).toBeEnabled();
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code.");
    await expect(claude.getByRole("button",{name:"Sign in",exact:true})).toHaveCount(0);
    expect(launches.at(-1),"its check now runs with the key saved on its row").toBe(KEY);
    expect(posted).toEqual([{provider:"anthropic",apiKey:KEY,select:false}]);
    expect(await page.evaluate(key=>document.body.innerText.includes(key)||[...document.querySelectorAll("input")].some(input=>input.value.includes(key)),KEY),"the key is nowhere on the page").toBe(false);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-installed-key-saved-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await page.unroute(/\/api\/providers$/).catch(()=>{});
    await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}});
    rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
