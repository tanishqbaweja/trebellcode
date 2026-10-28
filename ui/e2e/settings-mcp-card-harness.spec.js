import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Settings' MCP servers card shows for Muse Code since Muse Code's sessions take Trebell's MCP servers (its mcpInjection), and it
// said "Inject stdio MCP servers into ACP sessions" there, a protocol Muse Code does not speak (Muse Code's is MSP). The card now
// names the harness whose sessions get the servers, for each harness it shows for: Muse Code's, Claude Code's and each ACP harness's
// own (Cursor here). A search for Muse finds the card too, as a search for Cursor or Grok does. The person picks each harness in
// Agents & models as in the app; the harness list and the switch are page.route answers, so no harness CLI of this machine runs.
const shots=fileURLToPath(new URL("../../visual-audit/settings-mcp-card/",import.meta.url));mkdirSync(shots,{recursive:true});
const HARNESSES=[["native","Trebell Native",false],["codex","Codex",true],["claude","Claude Code",true],["cursor","Cursor",true],["grok","Grok Build",true],["opencode","OpenCode",true],["antigravity","Antigravity",false],["muse","Muse Code",true]];
function harnessList(selected){
  return {selectedRuntime:selected,selectedInstanceId:selected+"-default",definitions:HARNESSES.map(([id,name,multipleInstances])=>({id,name,protocol:id,multipleInstances})),
    instances:HARNESSES.map(([id,name])=>({id:id+"-default",kind:id,displayName:name,enabled:true})),
    statuses:HARNESSES.map(([id,name])=>({id:id+"-default",kind:id,name,available:true,installed:true,authenticated:true,version:"fixture"}))};
}
// The header's mode button, clicked as a person switches between dark and light.
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
async function shoot(page,card,name){
  for(const mode of ["dark","light"]){await switchMode(page,mode);await card.scrollIntoViewIfNeeded();await expect(card).toBeInViewport();await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280x800.png`})}
  await switchMode(page,"dark");
}

test("Settings' MCP servers card names Muse Code's sessions with Muse Code active, a search for Muse finds it, and Cursor's card names Cursor's",async({page,request})=>{
  test.setTimeout(90_000);
  let selected="codex";
  // The harness list, and a switch as the server answers it. The settings and state the mock server keeps say the harness picked
  // here, so a save (the mode button's) keeps it.
  await page.route(/\/api\/agent-runtimes$/,async route=>{
    if(route.request().method()!=="POST")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(harnessList(selected))});
    const body=route.request().postDataJSON()||{};
    if(body.action!=="select")return route.fallback();
    selected=body.runtime;const listed=harnessList(selected);
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...listed,selected:{runtime:selected,instance:listed.instances.find(item=>item.kind===selected),status:listed.statuses.find(item=>item.kind===selected)}})});
  });
  await page.route(/\/api\/settings$/,async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),agentRuntime:selected,agentRuntimeInstanceId:selected+"-default"}})});
  await page.route(/\/api\/state$/,async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,settings:{...body.settings,agentRuntime:selected,agentRuntimeInstanceId:selected+"-default"}}})});
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"MCP Card Workspace",activate:true}});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.locator(".settings-nav").getByRole("button",{name:/Agents & models/}).click();
  const card=page.locator('[data-setting-target="agents-mcp"]'),row=name=>page.locator(".agent-runtime-option").filter({hasText:name});
  // Codex takes no MCP servers from Trebell: no card.
  await expect(row("Codex").getByText("Active",{exact:true})).toBeVisible();
  await expect(card).toHaveCount(0);

  await row("Muse Code").getByRole("button").first().click();
  await expect(row("Muse Code").getByText("Active",{exact:true})).toBeVisible();
  await expect(card.getByRole("heading",{name:"MCP servers"})).toBeVisible();
  await expect(card).toContainText("Inject stdio MCP servers into Muse Code sessions on Local machine.");
  await expect(card).not.toContainText("ACP");
  await shoot(page,card,"muse-mcp-card");

  // Searching for Muse offers the card beside the harness list, and choosing it opens it.
  const search=page.getByRole("textbox",{name:"Search settings"}),results=page.getByTestId("settings-search-results");
  await search.click();await page.keyboard.type("muse",{delay:20});
  await expect(results.getByRole("button")).toHaveText([/^Agent harness/,/^MCP servers/]);
  await results.getByRole("button",{name:/^MCP servers/}).click();
  await expect(card).toBeInViewport();
  await expect(card).toContainText("Muse Code sessions");

  // An ACP harness's card names that harness.
  await search.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
  await page.locator(".settings-nav").getByRole("button",{name:/Agents & models/}).click();
  await row("Cursor").getByRole("button").first().click();
  await expect(row("Cursor").getByText("Active",{exact:true})).toBeVisible();
  await expect(card).toContainText("Inject stdio MCP servers into Cursor sessions on Local machine.");
  await expect(card).not.toContainText("ACP");
  // The search's highlight of the card has gone, so the shots show the card as it stands.
  await expect(card).not.toHaveClass(/settings-search-hit/);
  await shoot(page,card,"cursor-mcp-card");
});
