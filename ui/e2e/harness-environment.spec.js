import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A runtime profile's editor says what its harness starts with: a harness on this computer now gets the person's proxy and toolchain
// variables (runtime-environment.mjs), one on an SSH or WSL environment only the baseline, its runtime's names and the approved
// ones, so the editor says both; and it tells the person that a proxy or toolchain value holding a password or token needs its name
// listed, as mise's __MISE_DIFF does (a CLI started through a mise x wrapper needs it, and it can hold the secrets mise sets). Codex is
// the harness here because the server makes it active without its CLI (offline E2E has none); every harness's editor says the same.
const shots=fileURLToPath(new URL("../../visual-audit/polish/harness-environment/",import.meta.url));mkdirSync(shots,{recursive:true});
const SAID="Trebell passes only a safe OS baseline, this runtime's own settings (its home, config and endpoint) and the names listed here, and to a harness on this computer (not on an SSH or WSL environment) also your proxy and toolchain variables (HTTPS_PROXY, JAVA_HOME and the like).";
// No key or sign-in token passes by a listed name: how a harness signs in is the profile's own choice.
const NO_KEYS="No API key or sign-in token passes, listed or not: a harness signs in with its own login or, set to API key, its provider's key.";
const APPROVE="A proxy or toolchain value that holds a password or token passes only when its name is listed, as does mise's __MISE_DIFF, which can hold mise's secrets and which a CLI started through a mise x wrapper needs.";
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("a harness profile's editor says a harness on this computer gets the proxy and toolchain variables, and which values need their names listed",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const before=await (await request.get("/api/settings")).json();
  const chosen=await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai"}});
  expect(chosen.status(),await chosen.text()).toBe(200);
  try{
    await page.goto("/");
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const add=page.getByRole("button",{name:"Add profile",exact:true});
    await expect(add).toBeEnabled({timeout:15_000});
    await add.click();
    const editor=page.locator(".runtime-profile-editor");
    await expect(editor).toBeVisible();
    // Codex's own field, so this is that harness's profile.
    await expect(editor.getByLabel("CODEX_HOME")).toBeVisible();
    const note=editor.locator("p").filter({hasText:"Trebell passes only a safe OS baseline"});
    await expect(note).toHaveText(SAID+" "+APPROVE+" "+NO_KEYS+" Values are read from the parent process at launch time and are not stored in the profile.");
    // The profile's own choice of how it signs in, Sign in by default.
    await expect(editor.getByLabel("Signs in with")).toHaveValue("sign-in");
    await expect(editor).not.toContainText("this runtime's own credential variables");
    // A proxy with a password in it: the person lists its name, typed as they would.
    const keys=editor.getByRole("textbox",{name:"Approved inherited environment variables"});
    await keys.click();await page.keyboard.type("HTTPS_PROXY",{delay:15});
    await expect(keys).toHaveValue("HTTPS_PROXY");
    for(const [mode,width] of [["dark",1280],["light",1280],["light",760]]){
      await switchMode(page,mode);await page.setViewportSize({width,height:800});
      await note.scrollIntoViewIfNeeded();
      await expect(note).toBeInViewport({ratio:1});
      const box=await editor.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
      expect(box.scroll,"the editor does not scroll sideways").toBeLessThanOrEqual(box.client+1);
      await page.screenshot({animations:"disabled",path:shots+`codex-profile-environment-${mode}-${width}x800.png`});
    }
    await switchMode(page,"dark");
    await editor.getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(editor).toHaveCount(0);
  }finally{
    await request.post("/api/settings",{data:{...(before.agentRuntime?{agentRuntime:before.agentRuntime}:{}),...(before.agentRuntimeInstanceId?{agentRuntimeInstanceId:before.agentRuntimeInstanceId}:{}),appearanceMode:before.appearanceMode||"dark"}});
  }
});
