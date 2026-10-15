import { test,expect } from "@playwright/test";

function catalogThreads(count,cwd){
  const now=Date.now()/1000,meta={};
  for(let index=0;index<count;index++){
    const id="sidebar-thread-"+String(index).padStart(4,"0"),name="Thread "+String(index).padStart(4,"0"),updatedAt=now-index;
    meta[id]={projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id,name,preview:"Saved task "+index,cwd,model:"test/coding-fast",createdAt:updatedAt-100,updatedAt,status:{type:"idle"},runtime:"codex",provider:"openai"}};
  }
  return meta;
}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
// The page opened on the saved threads in threadMeta, Codex ready and nothing else to load.
async function openCatalog(page,threadMeta,cwd){
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,cwd,platform:process.platform,version:"sidebar-virtualization-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta}));
  await page.route(/\/api\/models$/,route=>json(route,{provider:"openai",agentRuntime:"codex",ready:true,models:["test/coding-fast"],metadata:{provider:"openai",agentRuntime:"codex",models:[{id:"test/coding-fast",name:"Coding Fast",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/thread-meta$/,async route=>{
    const body=route.request().postDataJSON();threadMeta[body.threadId]={...(threadMeta[body.threadId]||{}),...(body.patch||{})};return json(route,threadMeta[body.threadId]);
  });
  await page.goto("/");
}

test("thousand-thread sidebar mounts bounded rows while search and active-thread navigation stay reachable",async({page})=>{
  test.setTimeout(30_000);
  const cwd=process.cwd();
  await openCatalog(page,catalogThreads(1000,cwd),cwd);

  const rows=page.locator(".thread-row"),chunks=page.locator("[data-sidebar-chunk]"),sections=page.locator(".thread-sections");
  await expect(chunks).toHaveCount(25);
  await expect.poll(()=>rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(180);
  await expect(page.locator('.thread-main[title="Thread 0000"]')).toBeVisible();

  const search=page.locator(".search-box input");
  await search.fill("Thread 0500");
  await expect(page.locator('.thread-main[title="Thread 0500"]')).toBeVisible();
  await page.locator('.thread-main[title="Thread 0500"]').click();
  await search.fill("");
  const active=page.locator('.thread-row.active[data-thread-id="sidebar-thread-0500"]');
  await expect(active).toBeVisible({timeout:5000});
  expect(await rows.count()).toBeLessThan(180);

  await sections.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
  await expect.poll(async()=>await chunks.last().getAttribute("class")).toContain("mounted");
  await expect(page.locator('.thread-main[title="Thread 0999"]')).toBeVisible({timeout:5000});
  expect(await rows.count()).toBeLessThan(180);

  await page.screenshot({animations:"disabled",path:"visual-audit/thousand-thread-sidebar-dark-1280x800.png",fullPage:true});
});

test("End on the thousand-thread list shows the last thread at the bottom with one press, in dark and in light",async({page})=>{
  test.setTimeout(60_000);
  const cwd=process.cwd();
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.setViewportSize({width:1280,height:800});
  await openCatalog(page,catalogThreads(1000,cwd),cwd);
  const sections=page.locator(".thread-sections"),html=page.locator("html");
  await expect(page.locator('.thread-main[title="Thread 0000"]')).toBeVisible();
  // Where Thread 0999 is: whole in the list's view with the list scrolled to its end, below the end, or not mounted at all.
  const lastThread=()=>sections.evaluate(list=>{
    const row=[...list.querySelectorAll(".thread-main")].find(node=>node.title==="Thread 0999");if(!row)return "not in the list";
    const box=row.getBoundingClientRect(),view=list.getBoundingClientRect(),below=Math.round(box.bottom-view.bottom);
    return below<=1&&box.top>=view.top-1&&list.scrollHeight-list.clientHeight-list.scrollTop<=1?"at the bottom":below+" px below the list's end";
  });
  for(const mode of ["dark","light"]){
    // The header's theme button, as a person switches.
    if(await html.getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode)}
    // In light the wheel first goes down the whole list from its top (the dark End left it at its end), a frame drawn after each turn,
    // so every row has been drawn and measured; it takes some 180 turns. The list keeps its length all the way: chunks mount, their
    // rows are drawn and they go back to placeholders without the list growing or shrinking (a chunk that grew as it went back to its
    // placeholder, below the view, left End a few pixels short of the last thread).
    if(mode==="light"){
      await page.locator(".thread-sections h4").first().click();
      await page.keyboard.press("Home");await expect.poll(()=>sections.evaluate(list=>list.scrollTop)).toBe(0);
      const box=await sections.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      const lengths=new Set();let turns=0;
      for(;turns<800;turns++){
        const {length,left}=await sections.evaluate(list=>({length:list.scrollHeight,left:list.scrollHeight-list.clientHeight-list.scrollTop}));
        lengths.add(length);if(left<=1)break;
        await page.mouse.wheel(0,300);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      }
      expect(turns,"wheel turns down the list").toBeGreaterThan(100);
      expect(Math.max(...lengths)-Math.min(...lengths),"how much the list's length changed as the wheel went down it").toBeLessThanOrEqual(1);
      await expect(page.locator('.thread-main[title="Thread 0999"]')).toBeInViewport();
    }
    // The list's heading clicked, Home to its top, then End once.
    await page.locator(".thread-sections h4").first().click();
    await page.keyboard.press("Home");await expect.poll(()=>sections.evaluate(list=>list.scrollTop)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(lastThread,{message:"Thread 0999 after End ("+mode+")"}).toBe("at the bottom");
    // It stays there once the rows the scroll passed have gone back to placeholders.
    await expect.poll(()=>page.locator("[data-sidebar-chunk].mounted").count()).toBeLessThanOrEqual(3);
    expect(await lastThread()).toBe("at the bottom");
    await page.screenshot({animations:"disabled",path:"visual-audit/thousand-thread-sidebar-end-"+mode+"-1280x800.png"});
  }
});
