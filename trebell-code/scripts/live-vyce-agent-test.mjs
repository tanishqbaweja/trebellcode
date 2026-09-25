import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { chromium } from "@playwright/test";
import { ProviderManager } from "../src/provider-manager.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { createGuiServer } from "../src/gui-server.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";

const MODEL = process.env.VYCE_MODEL || "deepseek-v4.1";
const PROOF = "TREBELL_BROWSER_PROOF_7842";
const liveGuard=createLiveSmokeGuard({provider:"vyceai",model:MODEL,runtime:"codex",maxTurns:2,timeoutMs:240_000});
const startedAt = Date.now();
let report = { ok: false, phase: "boot", model: MODEL, startedAt: new Date(startedAt).toISOString() };

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const reportServer = createServer((req, res) => {
  if (req.url === "/health") return json(res, report.ok ? 200 : 503, { ok: report.ok, phase: report.phase });
  if (req.url === "/report" || req.url === "/") return json(res, 200, report);
  res.writeHead(404); res.end();
});
await new Promise((resolve, reject) => reportServer.listen(Number(process.env.PORT || 3000), "0.0.0.0", resolve).once("error", reject));

async function freePort() {
  const s = createServer();
  await new Promise((resolve, reject) => s.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || "");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

class RpcClient {
  constructor(ws, onServerRequest) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.onServerRequest = onServerRequest;
    ws.on("message", data => this.#onMessage(data));
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out"));
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  respond(id, result) { this.ws.send(JSON.stringify({ id, result })); }
  reject(id, code, message) { this.ws.send(JSON.stringify({ id, error: { code, message } })); }
  waitFor(predicate, timeoutMs = 180000) {
    const existing = this.notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x.resolve !== resolve);
        reject(new Error("notification wait timed out"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
  async #onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      try {
        const result = await this.onServerRequest(msg);
        this.respond(msg.id, result);
      } catch (error) {
        this.reject(msg.id, -32000, error?.message || String(error));
      }
      return;
    }
    if (msg.method) {
      this.notifications.push(msg);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(msg)) continue;
        this.waiters = this.waiters.filter(x => x !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  }
}

const BROWSER_TOOLS = [{
  type: "namespace",
  name: "trebell_browser",
  description: "Control Trebell's isolated validation browser.",
  tools: [
    { type: "function", name: "open", description: "Open a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
    { type: "function", name: "snapshot", description: "Inspect current page text and interactive elements. Returns refs for click/type.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { type: "function", name: "click", description: "Click an element from the latest snapshot by ref.", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false } },
    { type: "function", name: "type", description: "Set text in an input or editable element from the latest snapshot.", inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"], additionalProperties: false } },
    { type: "function", name: "screenshot", description: "Capture the current browser viewport.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ],
}];

async function run() {
  const apiKey = String(process.env.VYCEAI_API_KEY || process.env.VYCE_API_KEY || "").trim();
  if (!apiKey) throw new Error("VYCEAI_API_KEY or VYCE_API_KEY is missing");

  const home = await mkdtemp(join(tmpdir(), "trebell-vyce-live-"));
  const workspace = await mkdtemp(join(tmpdir(), "trebell-vyce-workspace-"));
  const env = { ...process.env, VYCEAI_API_KEY: apiKey, TREBELL_HOME: home, TREBELL_GUI_DEBUG: "1" };
  const manager = new ProviderManager({ env });

  report.phase = "vyce-model-discovery";
  const catalog = await manager.models("vyceai");
  if (!catalog.models.includes(MODEL)) throw new Error(`Vyce model ${MODEL} is not available. Models: ${catalog.models.join(", ")}`);
  report.modelCatalogCount = catalog.models.length;

  report.phase = "vyce-direct-inference";
  liveGuard.consumeTurn("Vyce direct inference");
  const direct = await liveGuard.withTimeout(manager.directChat("vyceai", {
    model: MODEL,
    prompt: "Answer this validation question concisely: what is 3 + 4?",
  }),"Vyce direct inference");
  if (!String(direct.text || "").trim()) throw new Error("Vyce direct inference returned an empty response");
  report.directInference = { ok: true, responseChars: String(direct.text).trim().length, usage: direct.raw?.usage || null };

  const fixturePort = await freePort();
  const fixtureServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><h1>Trebell live browser validation</h1><button id="reveal" onclick="document.getElementById('proof').textContent='${PROOF}'">Reveal validation token</button><div id="proof"></div></body></html>`);
  });
  await new Promise((resolve, reject) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve).once("error", reject));

  let gui = null;
  let browser = null;
  let ws = null;
  try {
    report.phase = "launch-browser";
    const browserChannel = String(process.env.TREBELL_E2E_BROWSER_CHANNEL || "").trim();
    browser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const browserCalls = [];

    async function browserTool(tool, args = {}) {
      browserCalls.push(tool);
      if (tool === "open") {
        await page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30000 });
        return { ok: true, url: page.url(), title: await page.title() };
      }
      if (tool === "snapshot") {
        return await page.evaluate(() => {
          const selectors = "a,button,input,textarea,select,[role='button'],[contenteditable='true']";
          const nodes = [...document.querySelectorAll(selectors)].filter(el => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
          });
          const elements = nodes.map((el, index) => {
            const ref = "e" + (index + 1);
            el.setAttribute("data-trebell-ref", ref);
            return { ref, tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), role: el.getAttribute("role"), text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || "").trim().slice(0, 300), href: el.href || null, name: el.getAttribute("name"), disabled: Boolean(el.disabled) };
          });
          return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 12000), elements };
        });
      }
      if (tool === "click") {
        const ref = String(args.ref || "");
        const locator = page.locator(`[data-trebell-ref="${ref}"]`);
        if (await locator.count() !== 1) return { ok: false, error: "element_not_found" };
        await locator.click();
        return { ok: true, url: page.url() };
      }
      if (tool === "type") {
        const ref = String(args.ref || "");
        const locator = page.locator(`[data-trebell-ref="${ref}"]`);
        if (await locator.count() !== 1) return { ok: false, error: "element_not_found" };
        await locator.fill(String(args.text ?? ""));
        return { ok: true };
      }
      if (tool === "screenshot") {
        const buffer = await page.screenshot({ type: "png" });
        return { dataUrl: "data:image/png;base64," + buffer.toString("base64"), url: page.url(), title: await page.title() };
      }
      throw new Error("Unknown browser tool: " + tool);
    }

    new TrebellStateStore(env).updateSettings({ modelProvider: "vyceai" });
    const [guiPort, appPort] = await Promise.all([freePort(), freePort()]);
    report.phase = "launch-trebell-codex";
    gui = await createGuiServer({ port: guiPort, appPort, mock: false, env });

    let boot = null;
    for (let i = 0; i < 120; i++) {
      boot = await fetch(gui.url + "/api/bootstrap").then(r => r.json()).catch(() => null);
      if (boot?.appServerReady) break;
      await wait(250);
    }
    if (!boot?.appServerReady) throw new Error("Codex app-server did not become ready");

    report.phase = "codex-rpc";
    ws = new WebSocket(boot.wsUrl, { origin: gui.url });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex relay websocket timed out")), 15000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", reject);
    });

    let assistant = "";
    const rpc = new RpcClient(ws, async msg => {
      if (msg.method === "item/tool/call") {
        const p = msg.params || {};
        if (p.namespace !== "trebell_browser") return { contentItems: [{ type: "inputText", text: "unsupported dynamic tool" }], success: false };
        const args = typeof p.arguments === "string" ? JSON.parse(p.arguments || "{}") : (p.arguments || {});
        const result = await browserTool(p.tool, args);
        if (p.tool === "screenshot") {
          return { contentItems: [{ type: "inputImage", imageUrl: result.dataUrl }, { type: "inputText", text: JSON.stringify({ url: result.url, title: result.title }) }], success: true };
        }
        return { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: true };
      }
      if (msg.method.includes("requestApproval") || msg.method === "applyPatchApproval" || msg.method === "execCommandApproval") return { decision: "accept" };
      if (msg.method === "item/tool/requestUserInput") return { answers: {} };
      return null;
    });
    ws.on("message", data => {
      try {
        const msg = JSON.parse(String(data));
        const p = msg.params || {};
        if (msg.method === "item/agentMessage/delta") assistant += p.delta || p.text || "";
        if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) assistant += p.item.text;
      } catch {}
    });

    await rpc.request("initialize", { clientInfo: { name: "trebell-live-vyce", title: "Trebell Live Vyce Validation", version: "1.0.0-test" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));

    const threadResult = await rpc.request("thread/start", {
      model: MODEL,
      modelProvider: "vyceai",
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      threadSource: "trebell-live-vyce",
      dynamicTools: BROWSER_TOOLS,
      developerInstructions: "This is an automated end-to-end Trebell validation. Browser use is explicitly allowed. Follow the user's browser/tool instructions exactly and do not guess values that can be observed with tools.",
    });
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error("thread/start did not return a thread id");

    report.phase = "live-agent-browser-tool-loop";
    const prompt = [
      "Perform this validation using tools, not guesses.",
      `1. Use trebell_browser.open on http://127.0.0.1:${fixturePort}/`,
      "2. Use trebell_browser.snapshot and find the button labelled Reveal validation token.",
      "3. Click that button with trebell_browser.click.",
      "4. Use trebell_browser.snapshot again and read the newly revealed token.",
      "5. Use your coding/shell tools to create proof.txt in the current workspace containing exactly the revealed token and nothing else.",
      "6. Read proof.txt back to verify it.",
      "7. Reply with only the token.",
    ].join("\n");

    liveGuard.consumeTurn("Vyce agent browser/tool turn");
    const turn = await liveGuard.withTimeout(rpc.request("turn/start", {
      threadId,
      model: MODEL,
      cwd: workspace,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    }),"Vyce agent browser/tool turn");
    const turnId = turn.turn?.id;
    if (!turnId) throw new Error("turn/start did not return a turn id");

    const completed = await rpc.waitFor(msg => msg.method === "turn/completed" && (msg.params?.turn?.id === turnId || msg.params?.turnId === turnId), 180000);
    const proof = decodeText(await readFile(join(workspace, "proof.txt"))).trim();

    if (proof !== PROOF) throw new Error(`proof.txt mismatch: "${proof}"`);
    if (!assistant.includes(PROOF)) throw new Error("assistant did not return the revealed browser proof");
    for (const required of ["open", "snapshot", "click"]) {
      if (!browserCalls.includes(required)) throw new Error(`model never called trebell_browser.${required}`);
    }
    if (browserCalls.filter(x => x === "snapshot").length < 2) throw new Error("model did not snapshot before and after click");

    report = {
      ok: true,
      phase: "complete",
      model: MODEL,
      provider: "vyceai",
      modelCatalogCount: catalog.models.length,
      directInference: report.directInference,
      browserToolCalls: browserCalls,
      proof,
      assistantContainsProof: true,
      turnStatus: completed.params?.turn?.status || completed.params?.status || "completed",
      fingerprint:liveGuard.fingerprint(),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    try { ws?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await gui?.close(); } catch {}
    await new Promise(resolve => fixtureServer.close(resolve));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

async function closeReportServer() {
  if (process.env.TREBELL_VALIDATION_KEEP_ALIVE === "1") return;
  await new Promise(resolve => reportServer.close(resolve));
}

run().then(async () => {
  console.log("TREBELL_LIVE_VALIDATION_OK", JSON.stringify(report, null, 2));
  await closeReportServer();
  if (process.env.TREBELL_VALIDATION_KEEP_ALIVE !== "1") process.exit(0);
}).catch(async error => {
  report = {
    ...report,
    ok: false,
    phase: "failed",
    error: error?.stack || error?.message || String(error),
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
  console.error("TREBELL_LIVE_VALIDATION_FAILED", report.error);
  await closeReportServer();
  if (process.env.TREBELL_VALIDATION_KEEP_ALIVE !== "1") process.exit(1);
  process.exitCode = 1;
});
