import { defineConfig } from "@playwright/test";
import { randomInt } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eHome } from "./e2e/test-home.js";

const hostedBaseUrl=String(process.env.TREBELL_E2E_BASE_URL||"").trim();
const browserChannel=String(process.env.TREBELL_E2E_BROWSER_CHANNEL||"").trim();
const allowExternalNetwork=String(process.env.TREBELL_E2E_ALLOW_NETWORK||"").trim()==="1";
const configuredPort=Number(process.env.TREBELL_E2E_PORT);
const localPort=Number.isInteger(configuredPort)&&configuredPort>=1024&&configuredPort<=65535?configuredPort:randomInt(32000,60000);
process.env.TREBELL_E2E_PORT=String(localPort);
process.env.TREBELL_E2E_OFFLINE=allowExternalNetwork?"0":"1";
const localBaseUrl="http://127.0.0.1:"+localPort;
const localTestHome=e2eHome();
const localTestUiDist=join(localTestHome,"ui-dist");
const workerProcess=process.env.TEST_WORKER_INDEX!=null;
if(process.platform==="win32"&&process.env.COMSPEC) process.env.COMSPEC=process.env.COMSPEC.trim();
if(!hostedBaseUrl&&!workerProcess){
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
    ...(!allowExternalNetwork?{proxy:{server:"http://127.0.0.1:9",bypass:"127.0.0.1,localhost"}}:{}),
    ...(browserChannel?{channel:browserChannel}:{}),
  },
  webServer: hostedBaseUrl?undefined:{
    command: "node src/gui-server.mjs --port "+localPort,
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env:{
      ...process.env,
      TREBELL_GUI_MOCK:"1",
      TREBELL_E2E_OFFLINE:allowExternalNetwork?"0":"1",
      TREBELL_HOME:localTestHome,
      TREBELL_UI_DIST:localTestUiDist,
      OPENAI_API_KEY:"",
      ANTHROPIC_API_KEY:"",
      GEMINI_API_KEY:"",
      GOOGLE_API_KEY:"",
    },
    url: localBaseUrl+"/api/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
  reporter: [["line"]],
});
