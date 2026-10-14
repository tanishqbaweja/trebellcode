import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A Codex profile whose CODEX_HOME is typed as ~name/... for a user this machine does not have. Codex's sign-in writes its auth.json
// into the profile's home, which Trebell took as a folder named ~name where it runs. Sign in is refused and says why, and no sign-in
// terminal opens. The harness list is fixed (Codex installed and not signed in, on this profile) so the row does not depend on what
// this machine has installed; the profile is saved on the server and the sign-in is the server's.
const shots=fileURLToPath(new URL("../../visual-audit/polish/runtime-profile-home/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const PROFILE={id:"codex-named-home",kind:"codex",displayName:"Named home",enabled:true,binaryPath:null,homePath:"~trebell-no-such-user-7f3a/.codex",shadowHomePath:null,serverUrl:null,environment:{}};
const MESSAGE="Trebell could not find the home folder of the user trebell-no-such-user-7f3a on this machine, so it cannot use ~trebell-no-such-user-7f3a/.codex.";
const HARNESSES={
  selectedRuntime:"native",selectedInstanceId:"native-default",compatibleInstanceIds:["native-default"],
  definitions:[
    {id:"native",name:"Trebell Native",protocol:"native",multipleInstances:false},
    {id:"codex",name:"Codex",protocol:"codex",multipleInstances:true,canAuthenticate:true},
  ],
  instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true},PROFILE],
  statuses:[
    {id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true,version:"Built in"},
    {id:PROFILE.id,kind:"codex",name:"Codex",available:true,installed:true,authenticated:false,version:"0.46.0",message:"Not signed in"},
  ],
};
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}

test("Sign in for a Codex profile whose home is under a user this machine does not have says why, and opens no terminal",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  // Trebell Native runs, and the profile is saved as Save profile keeps it; the settings write stores it without checking every
  // harness on this machine.
  const before=await (await request.get("/api/settings")).json();
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai",agentRuntimeInstances:[PROFILE]}});
  await page.route(/\/api\/agent-runtimes$/,route=>route.request().method()==="GET"?json(route,HARNESSES):route.continue());
  const signIns=[];page.on("request",request=>{if(new URL(request.url()).pathname==="/api/agent-runtime-auth")signIns.push(request.postDataJSON())});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const row=page.locator(".agent-runtime-option").filter({hasText:"Codex"});
    const signIn=row.getByRole("button",{name:"Sign in",exact:true});
    await expect(signIn).toBeVisible();
    const answered=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/agent-runtime-auth"&&response.request().method()==="POST");
    await signIn.click();
    const response=await answered;
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe(MESSAGE);
    expect(signIns).toEqual([expect.objectContaining({action:"login",runtime:"codex",instanceId:PROFILE.id})]);
    const said=page.getByTestId("agent-runtime-message");
    await expect(said).toHaveText(" · Codex: "+MESSAGE);
    await expect(said).toHaveAttribute("role","alert");
    // Nothing opened to sign in: no terminal drawer, and the button is ready to be pressed again.
    await expect(page.locator(".terminal-drawer")).toHaveCount(0);
    await expect(signIn).toBeEnabled();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        await said.scrollIntoViewIfNeeded();await expect(said).toBeInViewport();
        await page.screenshot({animations:"disabled",path:shots+`codex-sign-in-refused-${mode}-${width}.png`});
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
  }finally{
    await request.post("/api/settings",{data:{agentRuntimeInstances:before.agentRuntimeInstances||[],appearanceMode:before.appearanceMode||"dark"}});
  }
});
