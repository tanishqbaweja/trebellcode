import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { externalUrl, isAppUrl } from "../desktop/navigation-policy.mjs";

test("only web and mail links leave the app for the default browser",()=>{
  assert.equal(externalUrl("https://github.com/tanishqbaweja/trebellcode/pull/1"),"https://github.com/tanishqbaweja/trebellcode/pull/1");
  assert.equal(externalUrl("http://localhost:5173/"),"http://localhost:5173/");
  assert.equal(externalUrl("mailto:someone@example.com"),"mailto:someone@example.com");
  for(const refused of ["file:///C:/Windows/System32/calc.exe","ms-msdt:/id PCWDiagnostic","javascript:alert(1)","vscode://file/C:/x","search-ms:query=x","\\\\server\\share\\x.exe","C:\\Windows\\notepad.exe","","not a url",null,undefined])
    assert.equal(externalUrl(refused),null,`refused: ${refused}`);
});

test("the app window stays on the app's own origin",()=>{
  const app="http://127.0.0.1:41873/";
  assert.equal(isAppUrl("http://127.0.0.1:41873/#/settings",app),true);
  assert.equal(isAppUrl("http://127.0.0.1:41873/api/state",app),true);
  for(const other of ["http://127.0.0.1:41874/","http://localhost:41873/","https://127.0.0.1:41873/","https://example.com/","file:///C:/Users/x/page.html","data:text/html,<b>x</b>","about:blank","",null])
    assert.equal(isAppUrl(other,app),false,`not the app: ${other}`);
  assert.equal(isAppUrl("http://127.0.0.1:41873/",null),false,"no app URL yet means nothing is the app");
});

// The wiring itself runs only in Electron; these lines are what keeps the bridge to the app's own pages.
test("the desktop shell guards the app window's navigation, new windows and IPC",async()=>{
  const main=await readFile(new URL("../desktop/main.mjs",import.meta.url),"utf8");
  assert.match(main,/webContents\.on\("will-navigate",/,"the app window refuses navigation away from the app");
  assert.match(main,/setWindowOpenHandler\(\(\{url\}\)=>\{\s*const external=externalUrl\(url\)/,"new windows open only web and mail links");
  assert.doesNotMatch(main,/shell\.openExternal\(url\)/,"no unfiltered openExternal");
  assert.doesNotMatch(main,/ipcMain\.(handle|on)\("/,"every bridge channel goes through the sender check");
  assert.match(main,/function fromApp\(event\)/);
});
