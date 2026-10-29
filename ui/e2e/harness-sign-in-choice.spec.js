import { test,expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code, shared with Trebell Native.");
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
    await expect(again.getByTestId("harness-auth-claude")).toContainText("Uses the Anthropic API key, saved in Trebell Code, shared with Trebell Native.");
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
    await expect(openPanel).toContainText("Uses each saved key, shared with Trebell Native: OpenAI API key (none), Anthropic API key (saved), Google Gemini API key (none), xAI API key (none).");
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

// A key saved in Trebell Code is removed on a harness row as on the Model provider card, which only Trebell Native's Settings draw:
// from the one store, so Native has none either, and the row then says none is saved. A key that is not saved offers no Remove.
test("a key saved in Trebell Code is removed on a harness's row, from the store Trebell Native reads too",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0}})).status()).toBe(200);
  expect((await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"api-key"}})).status()).toBe(200);
  expect((await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"opencode",instanceId:"opencode-default",method:"api-key"}})).status()).toBe(200);
  expect((await request.post("/api/providers",{data:{provider:"anthropic",apiKey:KEY,select:false}})).status()).toBe(200);
  try{
    await openAgents(page);
    const claude=harnessRow(page,"Claude Code"),panel=claude.getByTestId("harness-auth-claude");
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code, shared with Trebell Native.");
    // OpenCode offers Remove for the saved key it picks, and none for one that is not saved.
    const openPanel=harnessRow(page,"OpenCode").getByTestId("harness-auth-opencode"),pick=openPanel.getByLabel("Key for OpenCode",{exact:true});
    await expect(pick).toHaveValue("openai");await expect(openPanel.getByRole("button",{name:"Remove key"})).toHaveCount(0);
    await pick.selectOption("anthropic");await expect(openPanel.getByRole("button",{name:"Remove key"})).toBeEnabled();
    const remove=panel.getByRole("button",{name:"Remove key"});
    await expect(remove).toBeEnabled();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-remove-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // At a phone's width the field and both buttons wrap inside the row, nothing cut off; and every row with the choice keeps its
    // name whole and its status readable beside an Install, Update or Switch: its first button takes the line, its buttons the next
    // (the rule that shrinks that button first on a wide row left its name and status about 30 px wide, a word to a line).
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:900});await switchMode(page,mode);
      await page.setViewportSize({width:390,height:844});await remove.scrollIntoViewIfNeeded();
      await expect(remove).toBeVisible();
      expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1),"the row's key panel fits its width").toBe(true);
      for(const name of WITH_CHOICE){
        const head=await harnessRow(page,name).locator("button").first().evaluate(node=>{const title=node.querySelector("strong"),said=node.querySelector("small");
          return {clipped:title.scrollWidth>title.clientWidth+1,said:said?Math.round(said.getBoundingClientRect().width):null,row:Math.round(node.parentElement.getBoundingClientRect().width),head:Math.round(node.getBoundingClientRect().width)}});
        expect(head.clipped,name+"'s name is whole at 390 px: "+JSON.stringify(head)).toBe(false);
        expect(head.said,name+"'s status is readable at 390 px: "+JSON.stringify(head)).toBeGreaterThan(100);
      }
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-remove-${mode}-390.png`});
      await harnessRow(page,"OpenCode").scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`opencode-api-keys-${mode}-390.png`});
    }
    await page.setViewportSize({width:1280,height:900});await switchMode(page,"dark");
    await remove.click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("API key removed.");
    await expect(panel).toContainText("Uses the Anthropic API key: none saved yet.");
    await expect(panel.getByRole("button",{name:"Remove key"})).toHaveCount(0);
    await expect(panel.getByRole("button",{name:"Save key"})).toBeDisabled();
    await expect(panel.getByLabel("Anthropic API key for Claude Code")).toHaveAttribute("placeholder","Paste Anthropic API key");
    await expect(openPanel).toContainText("Anthropic API key (none)");await expect(openPanel.getByRole("button",{name:"Remove key"})).toHaveCount(0);
    // Gone from the one store: Native has no Anthropic key either, and Claude Code stays on its API key.
    const providers=await (await request.get("/api/providers")).json();
    expect(providers.providers.find(item=>item.id==="anthropic").hasKey).toBe(false);
    expect((await (await request.get("/api/agent-runtimes")).json()).instances.find(item=>item.id==="claude-default").signIn).toEqual({method:"api-key",keys:[{provider:"anthropic",name:"Anthropic API",variable:"ANTHROPIC_API_KEY",saved:false,source:null,from:null}]});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-removed-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{
    await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"sign-in"}});
    await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"opencode",instanceId:"opencode-default",method:"sign-in"}});
    await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}});
  }
});

// A key saved or removed on a harness's row for the provider Trebell Native calls is Native's key too: the app's readiness and model
// list follow it at once, as after the Model provider card (which only Native's Settings draw), not at the next start-up read; and the
// row says when chats open on that key stopped, as its Sign in / API key choice does. The server's answer is the mock's, with the
// model list it read after the key and one stopped chat stood in for, so each answer can be told apart in the composer.
test("a key saved or removed on a harness's row for Native's provider brings Native's model list along, and says the open chats on it stopped",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"anthropic"}})).status()).toBe(200);
  expect((await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"api-key"}})).status()).toBe(200);
  expect((await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}})).status()).toBe(200);
  const answered=[],providersRoute=/\/api\/providers$/;
  await page.route(providersRoute,async route=>{
    if(route.request().method()!=="POST")return route.fallback();
    const response=await route.fetch(),body=await response.json(),model="claude-e2e-row-key-"+(answered.length+1);
    answered.push({selected:body.selected,agentRuntime:body.agentRuntime});
    return route.fulfill({response,json:{...body,models:[model],defaultModel:model,metadata:null,stoppedChats:1}});
  });
  const toAgents=async()=>{
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(harnessRow(page,"Claude Code")).toBeVisible({timeout:15_000});
  };
  try{
    await openAgents(page);
    const claude=harnessRow(page,"Claude Code"),panel=claude.getByTestId("harness-auth-claude"),message=page.getByTestId("agent-runtime-message");
    await panel.getByLabel("Anthropic API key for Claude Code").click();await page.keyboard.type(KEY,{delay:2});
    await panel.getByRole("button",{name:"Save key"}).click();
    await expect(message).toContainText("API key saved. Open chats on it stopped.");
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code, shared with Trebell Native.");
    expect(answered).toEqual([{selected:"anthropic",agentRuntime:"native"}]);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-row-key-saved-native-provider-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
    // The composer already lists what the server read after the key, with no reload.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    const picker=page.getByTestId("model-picker");
    await expect(picker).toContainText("claude-e2e-row-key-1",{timeout:15_000});
    // Removed on the row: Native's list follows again, and the row says so with the chats that stopped.
    await toAgents();
    await panel.getByRole("button",{name:"Remove key"}).click();
    await expect(message).toContainText("API key removed. Open chats on it stopped.");
    await expect(panel).toContainText("Uses the Anthropic API key: none saved yet.");
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(picker).toContainText("claude-e2e-row-key-2",{timeout:15_000});
    expect(answered.length).toBe(2);
  }finally{
    await page.unroute(providersRoute).catch(()=>{});
    await request.post("/api/agent-runtime-auth",{data:{action:"method",runtime:"claude",instanceId:"claude-default",method:"sign-in"}});
    await request.post("/api/providers",{data:{provider:"anthropic",apiKey:"",select:false}});
    await request.post("/api/settings",{data:{modelProvider:"openai"}});
  }
});

// A key Trebell reads from its environment (the variable Native reads) is no key saved in Trebell Code: the row says where it comes
// from, offers Save key rather than Replace, and says that a key saved there takes its place for Trebell Native too.
test("a key from the environment shows as from its variable with Save key, and says a key saved there replaces it for Native too",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:900});
  expect((await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0}})).status()).toBe(200);
  // This run's mock server has no key in its environment: its listing answers as one whose environment holds ANTHROPIC_API_KEY,
  // with Claude Code and OpenCode on their keys.
  const listing=/\/api\/agent-runtimes(?:\?|$)/;
  await page.route(listing,async route=>{
    if(route.request().method()!=="GET")return route.fallback();
    const response=await route.fetch(),body=await response.json();
    const fromEnvironment=key=>key.provider==="anthropic"?{...key,saved:true,source:"environment",from:"ANTHROPIC_API_KEY"}:key;
    for(const item of body.instances||[])if(item.signIn&&["claude-default","opencode-default"].includes(item.id))item.signIn={...item.signIn,method:"api-key",keys:item.signIn.keys.map(fromEnvironment)};
    return route.fulfill({response,json:body});
  });
  try{
    await openAgents(page);
    const claude=harnessRow(page,"Claude Code"),panel=claude.getByTestId("harness-auth-claude");
    await expect(panel).toContainText("Uses the Anthropic API key from ANTHROPIC_API_KEY; a key saved here replaces it, for Trebell Native too.");
    await expect(panel.getByLabel("Anthropic API key for Claude Code")).toHaveAttribute("placeholder","Paste Anthropic API key");
    await expect(panel.getByRole("button",{name:"Save key"})).toBeDisabled();
    await expect(panel.getByRole("button",{name:"Replace key"})).toHaveCount(0);
    const openPanel=harnessRow(page,"OpenCode").getByTestId("harness-auth-opencode");
    await expect(openPanel).toContainText("Uses each saved key, shared with Trebell Native: OpenAI API key (none), Anthropic API key (from ANTHROPIC_API_KEY), Google Gemini API key (none), xAI API key (none).");
    await openPanel.getByLabel("Key for OpenCode",{exact:true}).selectOption("anthropic");
    await expect(openPanel.getByLabel("Anthropic API key for OpenCode")).toHaveAttribute("placeholder","Paste Anthropic API key");
    await expect(openPanel.getByRole("button",{name:"Save key"})).toBeDisabled();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);await claude.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:shots+`claude-api-key-from-environment-${mode}-1280.png`});
    }
    await switchMode(page,"dark");
  }finally{await page.unroute(listing)}
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
    expect(launches,"with no key, Claude Code's own sign-in check does not run, which would read the person's own login").toEqual([]);
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
    await expect(panel).toContainText("Uses the Anthropic API key, saved in Trebell Code, shared with Trebell Native.");
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

// What the app shows of the harness that runs, its composer and model picker and its row in Settings, follows a Settings action that
// makes it ready or not ready at once, with no reload: Antigravity's own sign-in from its row, a sign-in finished in the harness's
// terminal (Claude Code's from its row) and Settings opened again, one made outside Trebell and Settings' Refresh (Grok Build's), a
// sign-in method chosen on a row, a key saved or removed there, and Trebell Native's Model provider card. The app runs outside mock
// mode on a machine of the test's own: its start-up read, runtime poll, model list, harness list, sign-in and key routes answer as the
// server does, from AgentRuntimeManager over a ProviderManager of the test's own (a managed Antigravity install, whose own sign-in
// leaves its method and token file in its home; Claude Code's `claude auth status` and Grok Build's `grok models` stubbed, signed in
// once `signedIn` says so, or on an API key with the key in their launch). The model list names a model only for a harness that is
// ready, as one signed out lists none. No transport is opened (no wsUrl), so the composer goes by the harness alone.
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const missingCommand=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
const READY_MODELS={native:["gpt-fixture","GPT Fixture"],claude:["claude-fixture","Claude Fixture"],grok:["grok-fixture","Grok Fixture"],antigravity:["gemini-fixture-flash","Gemini Fixture Flash"]};
const READY_LABELS={native:"OpenAI API",claude:"Claude Code",grok:"Grok Build",antigravity:"Antigravity"};
async function readyMachine(page,{runtime,keys={}}){
  const home=mkdtempSync(join(tmpdir(),"trebell-e2e-ready-")),trebell=join(home,"trebell"),signedIn={claude:false,grok:false};
  const current=join(trebell,"agent-runtimes","antigravity","current");mkdirSync(current,{recursive:true});
  for(const name of ["agy_acp_server.exe","agy_acp_server.par"])writeFileSync(join(current,name),"fixture");
  writeFileSync(join(current,"install.json"),JSON.stringify({runtime:"antigravity",version:"1.4.3"}));
  const bin=name=>{const path=join(home,name);writeFileSync(path,"fixture");return path},claude=bin("claude.exe"),grok=bin("grok.exe");
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",
    agentRuntimeInstances:[{id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,binaryPath:claude,environment:{}},{id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true,binaryPath:grok,environment:{}}]};
  const env={PATH:"/usr/bin",HOME:home,USERPROFILE:home,TREBELL_HOME:trebell},providers=new ProviderManager({env});
  for(const [provider,key] of Object.entries(keys))providers.setKey(provider,key);
  const runFn=async(command,args,options)=>{
    if(args[0]==="--version")return command===claude?answered("2.1.311 (Claude Code)\n"):command===grok?answered("grok 1.0.0\n"):missingCommand(command);
    if(command===claude){const key=options?.env?.ANTHROPIC_API_KEY;return signedIn.claude||key?answered(JSON.stringify({loggedIn:true,authMethod:key?"api_key":"claude.ai",apiProvider:"firstParty"})):{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""}}
    if(command===grok&&args[0]==="models")return answered(signedIn.grok?"You are logged in.\n":"You are not logged in. Run grok login.\n");
    return missingCommand(command);
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env,providers,runFn,fetchImpl:async url=>{throw new Error("offline e2e: no request to "+url)}});
  // The harness that runs as the server reads it: its status, and whether Native's provider has its key.
  const active=async()=>{const instance=manager.activeInstance();return {instance,status:await manager.probe(instance).catch(()=>null),providerReady:providers.hasKey("openai")}};
  const catalog=({instance,status,providerReady})=>{
    const kind=instance.kind,native=kind==="native",ready=native?providerReady:Boolean(status?.available),[id,name]=READY_MODELS[kind];
    return {...(native?{provider:"openai"}:{}),agentRuntime:kind,ready:native?providerReady:true,models:ready?[id]:[],defaultModel:ready?id:null,metadata:{models:ready?[{id,name,provider:native?"openai":kind}]:[]},error:ready?null:native?"API key required":status?.message||null};
  };
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/bootstrap$/,async route=>{const {instance,status,providerReady}=await active();return json(route,{mock:false,provider:"openai",providerReady,agentRuntime:instance.kind,agentRuntimeInstanceId:instance.id,runtimeCapabilities:manager.capabilities(instance),agentRuntimeReady:Boolean(status?.available),agentRuntimeStatus:status,appServerReady:false,wsUrl:"",cwd:home,platform:process.platform,version:"ready-follows-settings",activeEnvironment:null,appServerError:null})});
  await page.route(/\/api\/runtime$/,async route=>{const {instance,status,providerReady}=await active();return json(route,{agentRuntime:instance.kind,agentRuntimeInstanceId:instance.id,agentRuntimeStatus:status,provider:"openai",providerReady,appServerReady:false,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]})});
  await page.route(/\/api\/models$/,async route=>json(route,catalog(await active())));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/agent-runtimes$/,async route=>route.request().method()==="GET"?json(route,await manager.snapshot()):json(route,{error:"Not part of this test."},400));
  // A key saved or removed, on a harness's row or Native's card, as the server keeps it: the profiles on it are read again.
  await page.route(/\/api\/providers$/,async route=>{
    const body=route.request().method()==="POST"?route.request().postDataJSON()||{}:{};
    if("apiKey" in body){providers.setKey(body.provider,body.apiKey);manager.forgetProbes(manager.instances().map(item=>item.id))}
    return json(route,{selected:"openai",providers:providers.definitions(),status:providers.status("openai"),...catalog(await active()),ready:providers.hasKey("openai")});
  });
  // The method a row sets, and a row's Sign in: Antigravity's own, as the agent leaves it (its method in its home's settings, and its
  // token file there); another harness's opens in a terminal, where the person finishes it (the test's signedIn).
  await page.route(/\/api\/agent-runtime-auth$/,async route=>{
    const body=route.request().postDataJSON()||{};
    if(body.action==="method"){const {instance}=manager.setAuthMethod(body.instanceId,body.method);return json(route,{ok:true,instanceId:instance.id,method:instance.auth||"sign-in",stoppedChats:0,agentSnapshot:await manager.snapshot()})}
    if(body.runtime==="antigravity"){
      const agyAcp=join(trebell,"antigravity-home","antigravity-acp");mkdirSync(agyAcp,{recursive:true});
      writeFileSync(join(agyAcp,"settings.json"),JSON.stringify({auth:{type:"oauth-personal"}}));writeFileSync(join(agyAcp,"acp_token.json"),"fixture");
      return json(route,{ok:true,authenticated:true,auth:{runtime:"antigravity",instanceId:"antigravity-default",methodId:"oauth-personal",methodName:"Log in with Google"},stoppedChats:0,agentSnapshot:await manager.snapshot()});
    }
    return json(route,{ok:true,auth:{runtime:body.runtime,instanceId:body.instanceId,name:READY_LABELS[body.runtime]},session:{id:"e2e-sign-in-"+body.runtime,name:READY_LABELS[body.runtime]+" sign in",cwd:home,environmentId:null,environmentName:"Local machine",environmentType:"local",running:true}});
  });
  // The page is left first, so no read of the app's still runs in the home. Windows can hold the home a moment longer (it was free
  // again within a second, with no process left in it), so it is removed again until it goes, for up to 10 s.
  return {signedIn,close:async()=>{
    await page.goto("about:blank").catch(()=>{});
    for(let attempt=1;;attempt++){try{rmSync(home,{recursive:true,force:true});return}catch(error){if(attempt>=40)throw error;await new Promise(resolve=>setTimeout(resolve,250))}}
  }};
}
async function toAgentsHere(page){
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
}
async function toNewTask(page){await page.getByRole("button",{name:"New task",exact:true}).first().click();await expect(page.getByTestId("composer")).toBeVisible()}
const rowSaid=row=>row.locator("button").first().locator("small");
// The composer as the harness that runs is ready (it takes a message, and the model picker shows the model the server lists; with no
// transport open it says it is connecting) or not (it asks for the harness to be set up, its Configure in place of a model picker).
async function expectReady(page,kind,ready){
  const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),configure=page.locator(".composer-wrap").getByRole("button",{name:"Configure "+READY_LABELS[kind],exact:true});
  if(ready){await expect(composer,READY_LABELS[kind]+" takes a message").toBeEnabled();await expect(composer).not.toHaveAttribute("placeholder",/^Configure /);await expect(picker).toContainText(READY_MODELS[kind][1]);await expect(configure).toHaveCount(0)}
  else{await expect(composer,READY_LABELS[kind]+" takes no message").toBeDisabled();await expect(composer).toHaveAttribute("placeholder",`Configure ${READY_LABELS[kind]} in Settings…`);await expect(configure).toBeVisible();await expect(picker).toHaveCount(0)}
}
async function shootComposer(page,name){
  for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`})}
  await switchMode(page,"dark");
}

test("Antigravity signed in from its row in Settings takes a message at once, with its models, with no reload",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  const machine=await readyMachine(page,{runtime:"antigravity"});
  try{
    await page.goto("/");
    await expectReady(page,"antigravity",false);
    await shootComposer(page,"ready-antigravity-not-signed-in");
    await toAgentsHere(page);
    const row=harnessRow(page,"Antigravity");
    await expect(rowSaid(row)).toHaveText("Antigravity is not signed in. Press Sign in to sign in with Antigravity's own sign-in, or set it to run on a Google Gemini API key.");
    await row.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(page.getByTestId("agent-runtime-message")).toContainText("Antigravity signed in (Log in with Google).");
    await expect(rowSaid(row)).toHaveText("1.4.3 · Signed in with Antigravity's own sign-in.");
    // A person goes to New task right after it: the composer takes a message, and the model picker lists Antigravity's models.
    await toNewTask(page);
    await expectReady(page,"antigravity",true);
    await shootComposer(page,"ready-antigravity-signed-in");
  }finally{await machine.close()}
});

test("Claude Code made ready in Settings, by its sign-in finished in its terminal or a key saved on its row, takes a message at once, and its API key chosen with none or removed stops it, with no reload",async({page})=>{
  test.setTimeout(150_000);
  await page.setViewportSize({width:1280,height:900});
  const machine=await readyMachine(page,{runtime:"claude"});
  try{
    await page.goto("/");
    await expectReady(page,"claude",false);
    // Sign in on its row opens its sign-in in a terminal, where the person finishes it; Settings, opened again, reads it signed in.
    await toAgentsHere(page);
    const claude=harnessRow(page,"Claude Code"),panel=claude.getByTestId("harness-auth-claude"),message=page.getByTestId("agent-runtime-message");
    await expect(rowSaid(claude)).toHaveText("Claude Code is not authenticated. Run `claude auth login` and try again.");
    await claude.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(page.getByTestId("drawer")).toBeVisible();
    machine.signedIn.claude=true;
    await toAgentsHere(page);
    await expect(rowSaid(claude)).toHaveText("2.1.311 (Claude Code)");
    await toNewTask(page);
    await expectReady(page,"claude",true);
    await shootComposer(page,"ready-claude-signed-in");
    // Set to its API key with no Anthropic key: it takes no message any more.
    await toAgentsHere(page);
    await claude.getByRole("radiogroup",{name:"Claude Code signs in with"}).getByRole("radio",{name:"API key"}).check();
    await expect(message).toContainText("Claude Code runs on its API key.");
    await expect(rowSaid(claude)).toHaveText("Claude Code is set to run on the Anthropic API key, and Trebell Code has none. Add it under Claude Code in Settings → Agents & models, or set Claude Code to Sign in.");
    await toNewTask(page);
    await expectReady(page,"claude",false);
    // A key saved on its row makes it ready, and removed there, not ready again.
    await toAgentsHere(page);
    await panel.getByLabel("Anthropic API key for Claude Code").click();await page.keyboard.type(KEY,{delay:2});
    await panel.getByRole("button",{name:"Save key"}).click();
    await expect(message).toContainText("API key saved.");
    await expect(rowSaid(claude)).toHaveText("2.1.311 (Claude Code) · Runs on the Anthropic API key.");
    await toNewTask(page);
    await expectReady(page,"claude",true);
    await shootComposer(page,"ready-claude-key-saved");
    await toAgentsHere(page);
    await panel.getByRole("button",{name:"Remove key"}).click();
    await expect(message).toContainText("API key removed.");
    await toNewTask(page);
    await expectReady(page,"claude",false);
    await shootComposer(page,"ready-claude-key-removed");
  }finally{await machine.close()}
});

test("Grok Build set to its API key, back to Sign in, then signed in outside Trebell and refreshed in Settings, takes a message or not at once, with no reload",async({page})=>{
  test.setTimeout(150_000);
  await page.setViewportSize({width:1280,height:900});
  const machine=await readyMachine(page,{runtime:"grok",keys:{xai:"xai-e2e-fixture-key-for-trebell-0123456789"}});
  try{
    await page.goto("/");
    await expectReady(page,"grok",false);
    await toAgentsHere(page);
    const grok=harnessRow(page,"Grok Build"),choice=grok.getByRole("radiogroup",{name:"Grok Build signs in with"}),message=page.getByTestId("agent-runtime-message");
    await expect(rowSaid(grok)).toHaveText("Grok CLI is installed but not logged in. Run grok login.");
    // By keys: API key, on the xAI key saved before.
    await choice.getByRole("radio",{name:"API key"}).focus();await page.keyboard.press("Space");
    await expect(message).toContainText("Grok Build runs on its API key.");
    await expect(rowSaid(grok)).toHaveText("grok 1.0.0 · Runs on the xAI API key.");
    await toNewTask(page);
    await expectReady(page,"grok",true);
    await shootComposer(page,"ready-grok-api-key");
    // Back to its own sign-in, which it does not have yet.
    await toAgentsHere(page);
    await choice.getByRole("radio",{name:"Sign in"}).check();
    await expect(message).toContainText("Grok Build signs in with its own sign-in.");
    await expect(rowSaid(grok)).toHaveText("Grok CLI is installed but not logged in. Run grok login.");
    await toNewTask(page);
    await expectReady(page,"grok",false);
    // Signed in outside Trebell (grok login in the person's own terminal), then Settings' Refresh.
    await toAgentsHere(page);
    machine.signedIn.grok=true;
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(rowSaid(grok)).toHaveText("grok 1.0.0");
    await toNewTask(page);
    await expectReady(page,"grok",true);
    await shootComposer(page,"ready-grok-signed-in");
  }finally{await machine.close()}
});

test("Trebell Native takes a message once a key is saved on its Model provider card, and none once it is removed there, with no reload",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:900});
  const machine=await readyMachine(page,{runtime:"native"});
  try{
    await page.goto("/");
    await expectReady(page,"native",false);
    await toAgentsHere(page);
    const card=page.getByTestId("provider-settings-card");
    await card.getByTestId("provider-api-key").click();await page.keyboard.type("sk-e2e-fixture-key-for-trebell-0123456789",{delay:2});
    await card.getByTestId("save-provider-key").click();
    await expect(page.getByTestId("provider-status")).toContainText("API key saved");
    await toNewTask(page);
    await expectReady(page,"native",true);
    await toAgentsHere(page);
    await card.getByRole("button",{name:"Remove key"}).click();
    await expect(page.getByTestId("provider-status")).toContainText("API key removed.");
    await toNewTask(page);
    await expectReady(page,"native",false);
  }finally{await machine.close()}
});
