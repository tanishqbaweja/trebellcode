import { chromium } from "@playwright/test";
import { createServer } from "node:http";

const cdpUrl = process.env.TREBELL_CDP_URL || "http://127.0.0.1:9333";
const fixturePort = Number(process.env.TREBELL_BROWSER_FIXTURE_PORT || 33333);

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

let browser;
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
      const hasBridge=await page.evaluate(()=>Boolean(window.trebellDesktop?.background&&window.trebellDesktop?.browser)).catch(()=>false);
      if(hasBridge){mainPage=page;break;}
    }
    if(!mainPage) await new Promise(r=>setTimeout(r,250));
  }
  if(!mainPage) throw new Error("Installed Trebell renderer did not expose the desktop preload bridge.");

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
    if(providerSwitch?.selected!=="vyceai"||!providerSwitch?.models?.includes("deepseek-v4.1")){
      throw new Error("Installed app could not switch to Vyce AI with deepseek-v4.1 available.");
    }
    let providerRuntime=null;
    for(let attempt=0;attempt<30;attempt++){
      providerRuntime=await mainPage.evaluate(()=>fetch("/api/runtime").then(r=>r.json())).catch(()=>null);
      if(providerRuntime?.provider==="vyceai"&&providerRuntime?.appServerReady)break;
      await new Promise(r=>setTimeout(r,500));
    }
    if(providerRuntime?.provider!=="vyceai"||!providerRuntime?.appServerReady){
      throw new Error("Bundled Codex rejected the Vyce AI provider config.");
    }
    providerCompatibility={skipped:false,selected:providerSwitch.selected,runtime:providerRuntime};
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

const desktopSnapshot=await mainPage.evaluate(()=>window.trebellDesktop.captureScreen());
  if(!desktopSnapshot?.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Desktop snapshot is not a PNG data URL.");
  if(!(desktopSnapshot.width>0&&desktopSnapshot.height>0)) throw new Error("Desktop snapshot dimensions are invalid.");

  const snapshotConfig=await mainPage.evaluate(()=>window.trebellDesktop.snapshots.configure({enabled:true,shortcut:"CommandOrControl+Shift+F11",includeText:false}));
  if(!snapshotConfig?.enabled||!snapshotConfig?.registered) throw new Error("SnapShot shortcut did not register in the packaged desktop app.");
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
  await mainPage.evaluate(()=>window.trebellDesktop.snapshots.configure({enabled:false,shortcut:"CommandOrControl+Shift+F11",includeText:false}));

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

  const disabled=await mainPage.evaluate(()=>window.trebellDesktop.background.set(false));
  if(disabled?.enabled!==false) throw new Error("Background mode did not disable after validation.");
  const afterDisable=await mainPage.evaluate(()=>window.trebellDesktop.background.get());
  if(afterDisable?.enabled!==false||afterDisable?.openAtLogin!==false) throw new Error("Windows startup registration was not cleaned up.");

  await mainPage.evaluate(()=>window.trebellDesktop.browser.close());

  console.log(JSON.stringify({
    ok:true,
    background:{initial,afterEnable,afterDisable},
    browser:{url:snapshot.url,title:snapshot.title,elements:snapshot.elements?.length||0,screenshotBytes:screenshot.dataUrl.length,cookieImport},
    desktopSnapshot:{width:desktopSnapshot.width,height:desktopSnapshot.height,bytes:desktopSnapshot.dataUrl.length},
    snapShot:{width:captured.width,height:captured.height,title:captured.title,process:captured.process,persistedBytes:persisted.dataBase64.length},
    zoom:{before:zoomBefore,afterCtrlWheelUp:zoomAfter,reset:zoomReset},
    voice,
    providerCompatibility,
  },null,2));
} finally {
  try{await browser?.close();}catch{}
  await new Promise(resolve=>fixture.close(()=>resolve()));
}
