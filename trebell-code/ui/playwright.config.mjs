import { defineConfig } from "@playwright/test";
import { randomInt } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eHome } from "./e2e/test-home.js";

const hostedBaseUrl=String(process.env.TREBELL_E2E_BASE_URL||"").trim();
const browserChannel=String(process.env.TREBELL_E2E_BROWSER_CHANNEL||"").trim();
const configuredPort=Number(process.env.TREBELL_E2E_PORT);
const localPort=Number.isInteger(configuredPort)&&configuredPort>=1024&&configuredPort<=65535?configuredPort:randomInt(32000,60000);
process.env.TREBELL_E2E_PORT=String(localPort);
const localBaseUrl="http://127.0.0.1:"+localPort;
const localTestHome=e2eHome();
const localTestUiDist=join(localTestHome,"ui-dist");
if(process.platform==="win32"&&process.env.COMSPEC) process.env.COMSPEC=process.env.COMSPEC.trim();
if(!hostedBaseUrl){
  rmSync(localTestHome,{recursive:true,force:true});
  mkdirSync(localTestHome,{recursive:true});
  cpSync(fileURLToPath(new URL("./dist/",import.meta.url)),localTestUiDist,{recursive:true});
  process.env.TREBELL_E2E_HOME=localTestHome;
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  workers: 1,
  expect: { timeout: 5000 },
  use: {
    baseURL: hostedBaseUrl||localBaseUrl,
    viewport: { width: 1600, height: 980 },
    trace: "off",
    ...(browserChannel?{channel:browserChannel}:{}),
  },
  webServer: hostedBaseUrl?undefined:{
    command: "node src/gui-server.mjs --port "+localPort,
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env:{...process.env,TREBELL_GUI_MOCK:"1",TREBELL_HOME:localTestHome,TREBELL_UI_DIST:localTestUiDist},
    url: localBaseUrl+"/api/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
  reporter: [["line"]],
});
