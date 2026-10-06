import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir,mkdtemp,rm,stat,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const cdpUrl = process.env.TREBELL_CDP_URL || "http://127.0.0.1:9333";
const fixturePort = Number(process.env.TREBELL_BROWSER_FIXTURE_PORT || 33333);
const visualDir = String(process.env.TREBELL_RELEASE_VISUAL_DIR||"").trim();
const execFileAsync=promisify(execFile);

const fixture = createServer((req,res)=>{
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
  res.end(`<!doctype html>
<html>
<head><title>Trebell Browser Fixture</title></head>
<body>
  <h1>Agent Browser Fixture</h1>
  <input name="q" placeholder="Type here" />
  <button id="go" onclick="document.querySelector('#result').textContent='clicked:'+document.querySelector('input[name=q]').value">Commit</button>
  <p id="result">idle</p>
  <p id="cookie">cookie:none</p>
  <script>document.querySelector('#cookie').textContent='cookie:'+(document.cookie.match(/(?:^|; )trebell_test=([^;]*)/)?.[1]||'none')</script>
</body>
</html>`);
});

await new Promise((resolve,reject)=>{
  fixture.once("error",reject);
  fixture.listen(fixturePort,"127.0.0.1",resolve);
});

let browser,visualProjectRoot=null;
try {
  let lastError;
  for(let attempt=0;attempt<40;attempt++){
    try{
      browser=await chromium.connectOverCDP(cdpUrl);
      break;
    }catch(error){
      lastError=error;
      await new Promise(r=>setTimeout(r,500));
    }
  }
  if(!browser) throw lastError || new Error("Could not connect to installed Trebell Code over CDP.");

  let mainPage=null;
  for(let attempt=0;attempt<40&&!mainPage;attempt++){
    const pages=browser.contexts().flatMap(context=>context.pages());
    for(const page of pages){
      const hasBridge=await page.evaluate(()=>Boolean(window.trebellDesktop?.background&&window.trebellDesktop?.browser&&window.trebellDesktop?.updates)).catch(()=>false);
      if(hasBridge){mainPage=page;break;}
    }
    if(!mainPage) await new Promise(r=>setTimeout(r,250));
  }
  if(!mainPage) throw new Error("Installed Trebell renderer did not expose the desktop preload bridge.");

  const updater=await mainPage.evaluate(()=>window.trebellDesktop.updates.get());
  if(updater?.supported!==true)throw new Error(`Packaged updater is unavailable: ${JSON.stringify(updater)}`);
  if(!updater.currentVersion)throw new Error("Packaged updater did not report the installed version.");

  const vyceKeyAvailable=Boolean(
    process.env.TREBELL_TEST_VYCE_API_KEY||
    process.env.VYCEAI_API_KEY||
    process.env.VYCE_API_KEY
  );
  let providerCompatibility={skipped:!vyceKeyAvailable,reason:vyceKeyAvailable?null:"No Vyce key supplied to installer validation."};
  if(vyceKeyAvailable){
    const providerSwitch=await mainPage.evaluate(async()=>{
      const response=await fetch("/api/providers",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({provider:"vyceai"}),
      });
      return await response.json();
    });
    if(providerSwitch?.selected!=="vyceai"||providerSwitch?.status?.hasKey!==true){
      throw new Error("Installed app could not persist the configured Trebell Native Vyce provider.");
    }
    let providerRuntime=null;
    for(let attempt=0;attempt<30;attempt++){
      providerRuntime=await mainPage.evaluate(()=>fetch("/api/runtime").then(r=>r.json())).catch(()=>null);
      if(providerRuntime?.provider==="vyceai"&&providerRuntime?.agentRuntime==="codex"&&providerRuntime?.appServerReady)break;
      await new Promise(r=>setTimeout(r,500));
    }
    if(providerRuntime?.provider!=="vyceai"||providerRuntime?.agentRuntime!=="codex"||!providerRuntime?.appServerReady){
      throw new Error("Changing the Trebell Native provider disturbed the packaged Codex runtime.");
    }
    const codexCatalog=await mainPage.evaluate(()=>fetch("/api/models").then(r=>r.json()));
    if(codexCatalog?.metadata?.provider!=="codex"||codexCatalog?.provider!==undefined){
      throw new Error("Packaged Codex model discovery was incorrectly coupled to the Trebell Native provider.");
    }
    providerCompatibility={skipped:false,selected:providerSwitch.selected,runtime:providerRuntime,codexCatalogProvider:codexCatalog.metadata.provider};
    await mainPage.evaluate(()=>fetch("/api/providers",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({provider:"freebuff"}),
    }).then(r=>r.json()));
  }

  const initial=await mainPage.evaluate(()=>window.trebellDesktop.background.get());
  if(typeof initial?.enabled!=="boolean") throw new Error("Background-mode state is unavailable.");

  const enabled=await mainPage.evaluate(()=>window.trebellDesktop.background.set(true));
  if(enabled?.enabled!==true) throw new Error("Background mode did not enable.");

  const afterEnable=await mainPage.evaluate(()=>window.trebellDesktop.background.get());
  if(afterEnable?.enabled!==true) throw new Error("Background mode was not persisted in the desktop runtime.");
  if(afterEnable?.openAtLogin!==true) throw new Error("Windows startup registration did not become active.");

  await mainPage.evaluate(()=>window.trebellDesktop.notify({title:"Trebell installer validation",body:"Native notification IPC is reachable.",silent:true}));

  const fixtureUrl=`http://127.0.0.1:${fixturePort}`;
  const cookieImport=await mainPage.evaluate(url=>window.trebellDesktop.browser.importCookies({cookies:[{url,name:"trebell_test",value:"cookie-ok",path:"/"}]}),fixtureUrl);
  if(!cookieImport?.ok||cookieImport.imported!==1||cookieImport.failed!==0)throw new Error("Agent browser cookie import failed.");

  const opened=await mainPage.evaluate(url=>window.trebellDesktop.browser.navigate(url),fixtureUrl);
  if(!opened?.ok) throw new Error("Agent browser failed to navigate.");

  let snapshot=await mainPage.evaluate(()=>window.trebellDesktop.browser.snapshot());
  if(snapshot?.title!=="Trebell Browser Fixture") throw new Error("Agent browser snapshot returned the wrong document.");
  if(!snapshot?.text?.includes("cookie:cookie-ok")) throw new Error("Imported cookie was not visible inside the isolated agent browser session.");
  const input=snapshot.elements?.find(element=>element.name==="q");
  const button=snapshot.elements?.find(element=>element.tag==="button"&&element.text==="Commit");
  if(!input?.ref||!button?.ref) throw new Error("Agent browser did not expose addressable fixture elements.");

  const typed=await mainPage.evaluate(({ref,text})=>window.trebellDesktop.browser.type(ref,text),{ref:input.ref,text:"hello"});
  if(!typed?.ok||typed.value!=="hello") throw new Error("Agent browser type operation failed.");

  const clicked=await mainPage.evaluate(ref=>window.trebellDesktop.browser.click(ref),button.ref);
  if(!clicked?.ok) throw new Error("Agent browser click operation failed.");

  snapshot=await mainPage.evaluate(()=>window.trebellDesktop.browser.snapshot());
  if(!snapshot?.text?.includes("clicked:hello")) throw new Error("Agent browser click did not affect the page.");

  const screenshot=await mainPage.evaluate(()=>window.trebellDesktop.browser.screenshot());
  if(!screenshot?.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Agent browser screenshot is not a PNG data URL.");
  if(visualDir){
    await mkdir(visualDir,{recursive:true});
    await writeFile(join(visualDir,"09-agent-browser-page.png"),Buffer.from(screenshot.dataUrl.split(",",2)[1],"base64"));
  }

  const viewportState=await mainPage.evaluate(()=>window.trebellDesktop.browser.setViewport(390,844));
  if(viewportState?.width!==390||viewportState?.height!==844) throw new Error(`Agent browser viewport resize failed: ${viewportState?.width}x${viewportState?.height}`);
  const secondUrl=fixtureUrl+"/second";
  await mainPage.evaluate(url=>window.trebellDesktop.browser.navigate(url),secondUrl);
  let navigationState=await mainPage.evaluate(()=>window.trebellDesktop.browser.state());
  if(!navigationState?.url?.endsWith("/second")||!navigationState.canGoBack) throw new Error("Agent browser navigation state did not expose back history.");
  navigationState=await mainPage.evaluate(()=>window.trebellDesktop.browser.back());
  if(new URL(navigationState.url).pathname!=="/") throw new Error("Agent browser back navigation failed.");
  navigationState=await mainPage.evaluate(()=>window.trebellDesktop.browser.forward());
  if(!navigationState.url.endsWith("/second")) throw new Error("Agent browser forward navigation failed.");
  navigationState=await mainPage.evaluate(()=>window.trebellDesktop.browser.reload());
  if(!navigationState.url.endsWith("/second")) throw new Error("Agent browser reload changed the active URL.");

  const browserRecording=await mainPage.evaluate(async fixtureUrl=>{
    await window.trebellDesktop.browser.armRecording();
    const stream=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{frameRate:{ideal:15,max:15}}});
    const types=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4;codecs=avc1"];
    const mimeType=types.find(type=>MediaRecorder.isTypeSupported(type))||"";
    const chunks=[];const recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined);recorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data)};recorder.start(250);
    await window.trebellDesktop.browser.setViewport(844,390);
    await new Promise(resolve=>setTimeout(resolve,450));
    await window.trebellDesktop.browser.navigate(fixtureUrl+"/recording-frame");
    await new Promise(resolve=>setTimeout(resolve,450));
    await window.trebellDesktop.browser.setViewport(390,844);
    const deadline=Date.now()+5000;
    while(!chunks.some(chunk=>chunk.size>0)&&Date.now()<deadline){
      try{recorder.requestData()}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    const track=stream.getVideoTracks()[0]||null;
    let stopTimedOut=false;
    await Promise.race([
      new Promise(resolve=>{
        recorder.addEventListener("stop",()=>setTimeout(resolve,50),{once:true});
        if(recorder.state!=="inactive")try{recorder.stop()}catch{resolve()}
        else resolve();
      }),
      new Promise(resolve=>setTimeout(()=>{stopTimedOut=true;resolve()},3000)),
    ]);
    const settings=track?.getSettings?.()||{};
    const trackState={readyState:track?.readyState||null,muted:Boolean(track?.muted),enabled:Boolean(track?.enabled)};
    for(const item of stream.getTracks())try{item.stop()}catch{}
    const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0]?.type||"video/webm"});
    return {bytes:blob.size,type:blob.type,width:settings.width||null,height:settings.height||null,chunks:chunks.length,stopTimedOut,trackState};
  },fixtureUrl);
  if(browserRecording.stopTimedOut)throw new Error(`Agent browser recording did not stop within 3s (chunks=${browserRecording.chunks}, track=${JSON.stringify(browserRecording.trackState)}).`);
  if(!(browserRecording.bytes>1000)||!browserRecording.type.startsWith("video/")) throw new Error(`Agent browser recording did not produce encoded video (${browserRecording.bytes} bytes, ${browserRecording.type}, chunks=${browserRecording.chunks}, track=${JSON.stringify(browserRecording.trackState)}).`);

const desktopSnapshot=await mainPage.evaluate(()=>window.trebellDesktop.captureScreen());
  if(!desktopSnapshot?.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Desktop snapshot is not a PNG data URL.");
  if(!(desktopSnapshot.width>0&&desktopSnapshot.height>0)) throw new Error("Desktop snapshot dimensions are invalid.");

  const snapshotConfig=await mainPage.evaluate(()=>window.trebellDesktop.snapshots.configure({enabled:true,shortcut:"CommandOrControl+Shift+F11",includeText:false,playSound:false,sound:"camera-shutter",flash:false,animations:false}));
  if(!snapshotConfig?.enabled||!snapshotConfig?.registered||snapshotConfig.playSound!==false||snapshotConfig.sound!=="camera-shutter"||snapshotConfig.flash!==false||snapshotConfig.animations!==false) throw new Error("SnapShot settings did not persist in the packaged desktop app.");
  await mainPage.bringToFront();
  await mainPage.waitForTimeout(150);
  const captured=await mainPage.evaluate(()=>window.trebellDesktop.snapshots.capture());
  if(!captured?.id||!(captured.width>0&&captured.height>0)) throw new Error("Foreground SnapShot capture did not return valid metadata.");
  const persisted=await mainPage.evaluate(id=>window.trebellDesktop.snapshots.read(id),captured.id);
  if(!persisted?.dataBase64||persisted.id!==captured.id) throw new Error("SnapShot was not persisted for renderer recovery.");
  const pendingBeforeAck=await mainPage.evaluate(()=>window.trebellDesktop.snapshots.pending());
  const wasPending=pendingBeforeAck.some(item=>item.id===captured.id);
  if(wasPending){
    await mainPage.evaluate(id=>window.trebellDesktop.snapshots.ack(id),captured.id);
    const pendingAfterAck=await mainPage.evaluate(()=>window.trebellDesktop.snapshots.pending());
    if(pendingAfterAck.some(item=>item.id===captured.id)) throw new Error("SnapShot ACK did not remove persisted capture files.");
  }else{
    await mainPage.waitForTimeout(250);
    const attached=await mainPage.locator('.context-chip').filter({hasText:'SnapShot'}).count();
    if(!attached) throw new Error("SnapShot disappeared from pending storage without being attached to the draft.");
  }
  await mainPage.evaluate(()=>window.trebellDesktop.snapshots.configure({enabled:false,shortcut:"CommandOrControl+Shift+F11",includeText:false,playSound:false,flash:false,animations:false}));

  await mainPage.evaluate(()=>window.trebellDesktop.zoom.reset());
  const zoomBefore=(await mainPage.evaluate(()=>window.trebellDesktop.zoom.get())).factor;
  await mainPage.keyboard.down("Control");
  await mainPage.mouse.wheel(0,-600);
  await mainPage.keyboard.up("Control");
  await mainPage.waitForTimeout(250);
  const zoomAfter=(await mainPage.evaluate(()=>window.trebellDesktop.zoom.get())).factor;
  if(!(zoomAfter>zoomBefore)) throw new Error(`Ctrl+mouse-wheel up did not increase app zoom: ${zoomBefore} -> ${zoomAfter}`);
  const zoomReset=(await mainPage.evaluate(()=>window.trebellDesktop.zoom.reset())).factor;
  if(Math.abs(zoomReset-1)>0.001) throw new Error("Desktop zoom reset did not return to 100%.");

  const voice=await mainPage.evaluate(()=>{
    const supported=Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);
    const button=document.querySelector(".mic-btn");
    return {supported,disabled:button?button.disabled:null};
  });
  if(voice.disabled===null) throw new Error("Voice dictation control was not rendered.");
  if(voice.supported===voice.disabled) throw new Error("Voice dictation availability is not reflected by the UI.");

  const visualAudit=[];
  if(visualDir){
    const visualCdp=await mainPage.context().newCDPSession(mainPage);
    const captureVisual=async(name)=>{
      await mkdir(visualDir,{recursive:true});
      const path=join(visualDir,name+".png");
      const capture=await visualCdp.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
      await writeFile(path,Buffer.from(capture.data,"base64"));
      const info=await stat(path);
      if(info.size<8000)throw new Error(`Packaged visual screenshot ${name} is unexpectedly small (${info.size} bytes).`);
      visualAudit.push({name,path,bytes:info.size});
    };
    const assertNoActionError=async(label)=>{
      const errors=await mainPage.locator('[data-testid="app-action-error"]:visible,.app-action-error:visible,.sidebar-action-error:visible').allTextContents();
      if(errors.length)throw new Error(`Packaged visual audit surfaced an app error on ${label}: ${errors.join(" · ")}`);
    };
    const openUtility=async(label,name,waitFor=null)=>{
      const control=mainPage.getByRole("button",{name:label,exact:true});
      if(await control.count()===0)throw new Error(`Packaged visual audit could not find the ${label} navigation control.`);
      await control.click();
      if(waitFor)await waitFor();
      else await mainPage.waitForTimeout(400);
      await assertNoActionError(label);
      await captureVisual(name);
    };

    visualProjectRoot=await mkdtemp(join(tmpdir(),"trebell-release-visual-"));
    await mkdir(join(visualProjectRoot,"src"),{recursive:true});
    await writeFile(join(visualProjectRoot,"README.md"),"# Trebell release visual fixture\n");
    await writeFile(join(visualProjectRoot,"src","app.js"),'export const releaseVisual = "baseline";\n');
    await execFileAsync("git",["init","-q"],{cwd:visualProjectRoot});
    await execFileAsync("git",["config","user.email","release-visual@trebell.invalid"],{cwd:visualProjectRoot});
    await execFileAsync("git",["config","user.name","Trebell Release Visual"],{cwd:visualProjectRoot});
    await execFileAsync("git",["add","."],{cwd:visualProjectRoot});
    await execFileAsync("git",["commit","-q","-m","Visual fixture"],{cwd:visualProjectRoot});
    await writeFile(join(visualProjectRoot,"src","app.js"),'export const releaseVisual = "changed";\n');
    const addedProject=await mainPage.evaluate(async path=>{
      const response=await fetch("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path,name:"Release visual fixture",activate:true,environmentId:null})});
      return await response.json();
    },visualProjectRoot);
    if(!addedProject?.project?.id)throw new Error("Packaged visual audit could not register its temporary Git project.");

    await mainPage.reload({waitUntil:"domcontentloaded"});
    await mainPage.getByRole("button",{name:"Projects",exact:true}).waitFor({state:"visible",timeout:15000});
    await mainPage.waitForTimeout(800);
    await assertNoActionError("Chat");
    await captureVisual("01-chat-workspace");

    await mainPage.getByTestId("terminal-toggle").click();
    await mainPage.getByTestId("drawer").waitFor({state:"visible",timeout:10000});
    const createTerminal=mainPage.getByRole("button",{name:"Create terminal",exact:true});
    if(await createTerminal.count())await createTerminal.click();
    await mainPage.waitForTimeout(800);
    await assertNoActionError("Terminal");
    await captureVisual("02-terminal");
    await mainPage.getByTestId("terminal-toggle").click();

    await mainPage.getByTestId("right-panel-toggle").click();
    await mainPage.locator(".right-panel").waitFor({state:"visible",timeout:10000});
    await mainPage.waitForTimeout(500);
    await assertNoActionError("Workspace panel");
    await captureVisual("03-workspace-files");

    const sourceControl=mainPage.locator(".branch-control");
    if(await sourceControl.count()===0)throw new Error("Packaged visual audit did not detect Git source control for its fixture project.");
    await sourceControl.click();
    await mainPage.waitForTimeout(700);
    await assertNoActionError("Source control");
    await captureVisual("04-source-control");

    await openUtility("Projects","05-projects",()=>mainPage.getByRole("heading",{name:"Projects",exact:true}).waitFor({state:"visible",timeout:10000}));
    await openUtility("History","06-history",()=>mainPage.getByRole("heading",{name:"Thread history",exact:true}).waitFor({state:"visible",timeout:10000}));
    await openUtility("Usage","07-usage",()=>mainPage.getByRole("heading",{name:"Usage",exact:true}).waitFor({state:"visible",timeout:10000}));
    await openUtility("Environments","08-environments",()=>mainPage.getByText("Environments",{exact:true}).first().waitFor({state:"visible",timeout:10000}));
    await openUtility("Browser","10-browser-panel");

    for(const [label,name] of [["Agents","11-agents"],["Tools","12-tools"]]){
      const control=mainPage.getByRole("button",{name:label,exact:true});
      if(await control.count())await openUtility(label,name);
    }

    await openUtility("Settings","13-settings-general",()=>mainPage.getByRole("heading",{name:"Settings",exact:true}).waitFor({state:"visible",timeout:10000}));
    const settingsNav=mainPage.getByRole("navigation",{name:"Settings categories"});
    for(const [label,name] of [
      ["Agents & models","14-settings-agents-models"],
      ["Workspace","15-settings-workspace"],
      ["Appearance","16-settings-appearance"],
      ["Desktop","17-settings-desktop"],
      ["Shortcuts","18-settings-shortcuts"],
      ["Diagnostics","19-settings-diagnostics"],
    ]){
      const control=settingsNav.getByRole("button",{name:new RegExp("^"+label)});
      if(await control.count()===0)throw new Error(`Packaged Settings is missing the ${label} category.`);
      await control.click();
      await mainPage.locator(".settings-section-head h2").filter({hasText:label}).waitFor({state:"visible",timeout:10000});
      await mainPage.waitForTimeout(250);
      await assertNoActionError("Settings / "+label);
      await captureVisual(name);
    }

    await mainPage.setViewportSize({width:1280,height:800}).catch(()=>{});
    await mainPage.waitForTimeout(250);
    await captureVisual("20-settings-responsive-1280x800");
  }

  const disabled=await mainPage.evaluate(()=>window.trebellDesktop.background.set(false));
  if(disabled?.enabled!==false) throw new Error("Background mode did not disable after validation.");
  const afterDisable=await mainPage.evaluate(()=>window.trebellDesktop.background.get());
  if(afterDisable?.enabled!==false||afterDisable?.openAtLogin!==false) throw new Error("Windows startup registration was not cleaned up.");

  await mainPage.evaluate(()=>window.trebellDesktop.browser.close());

  console.log(JSON.stringify({
    ok:true,
    background:{initial,afterEnable,afterDisable},
    browser:{url:snapshot.url,title:snapshot.title,elements:snapshot.elements?.length||0,screenshotBytes:screenshot.dataUrl.length,cookieImport},
    browserViewport:{width:viewportState.width,height:viewportState.height},
    browserRecording,
    desktopSnapshot:{width:desktopSnapshot.width,height:desktopSnapshot.height,bytes:desktopSnapshot.dataUrl.length},
    snapShot:{width:captured.width,height:captured.height,title:captured.title,process:captured.process,persistedBytes:persisted.dataBase64.length},
    zoom:{before:zoomBefore,afterCtrlWheelUp:zoomAfter,reset:zoomReset},
    voice,
    providerCompatibility,
    visualAudit,
  },null,2));
} finally {
  try{await browser?.close();}catch{}
  if(visualProjectRoot)await rm(visualProjectRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>{});
  await new Promise(resolve=>fixture.close(()=>resolve()));
}
