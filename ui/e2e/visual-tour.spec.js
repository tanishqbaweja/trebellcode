// Screenshot tour with automated layout checks: every primary surface in dark and light mode at two
// desktop sizes plus a narrow width. Screenshots land in visual-audit/redesign/ for side-by-side review, and
// layout problems (horizontal overflow, covered controls, unnamed buttons, console errors) fail the run
// when TREBELL_TOUR_STRICT=1 (set once the redesign lands); otherwise they are attached as annotations.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../../visual-audit/redesign/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const strict = String(process.env.TREBELL_TOUR_STRICT || "") === "1";
const VIEWPORTS = [{ name: "1280x800", width: 1280, height: 800 }, { name: "1600x980", width: 1600, height: 980 }];
const MODES = ["dark", "light"];
const report = [];

async function prepare(page, request, mode) {
  await request.post("/api/settings", { data: { onboardingComplete: true, appearance: "dark", appearanceMode: mode, panelAnimationMs: 0, agentRuntime: "native", modelProvider: "openai" } });
  const boot = await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects", { data: { path: boot.cwd, name: "Tour Workspace", activate: true } });
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeEnabled({ timeout: 10_000 });
}

async function audit(page) {
  return page.evaluate(() => {
    const issues = [];
    const describe = el => `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : ""}${el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")}"]` : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) issues.push(`page overflows horizontally (${root.scrollWidth} > ${root.clientWidth})`);
    // Rendered on screen: a box, not hidden, and not inside content the browser skips (a closed <details>, whose menu
    // buttons still report a box, or a transparent ancestor), which checkVisibility() covers.
    const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && (typeof el.checkVisibility !== "function" || el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })); };
    const scrollParent = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX + s.overflowY) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p; } return null; };
    // A point that a clipping ancestor cuts off (a thread row scrolled past the edge of the sidebar list) is out of view, not covered.
    const clippedAt = (el, x, y) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue; const b = p.getBoundingClientRect(); if (x < b.left || x > b.right || y < b.top || y > b.bottom) return true; } return false; };
    // While a modal dialog is open the page behind it is meant to be covered, so only the dialog's own controls are checked.
    const modal = [...document.querySelectorAll("[aria-modal=true]")].filter(visible).pop() || null;
    const controls = [...(modal || document).querySelectorAll("button,[role=button],[role=tab],a[href],input:not([type=hidden]),select,textarea")].filter(visible);
    for (const el of controls) {
      // A placeholder hidden from assistive technology and out of the tab order (a loading skeleton row) has no name to give.
      const presentational = Boolean(el.closest("[aria-hidden=true]")) && (el.disabled || el.tabIndex < 0);
      if (!presentational && (el.tagName === "BUTTON" || el.getAttribute("role") === "button") && !(el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim()) issues.push(`unnamed button ${describe(el)}`);
      const r = el.getBoundingClientRect();
      if (!scrollParent(el) && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1)) issues.push(`control outside viewport ${describe(el)}`);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight || clippedAt(el, cx, cy)) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      const cover = top.closest("button,[role=button],[role=tab],a[href],input,select,textarea");
      if (cover && cover !== el && !cover.contains(el)) issues.push(`covered ${describe(el)} by ${describe(cover)}`);
    }
    return [...new Set(issues)].slice(0, 40);
  });
}

async function capture(page, name, testInfo) {
  // Code-split surfaces show a "Loading …" placeholder until their chunk (and first data) arrives; wait for them so the
  // screenshot and the audit cover the page itself rather than the placeholder.
  await expect(page.locator(".surface-loading")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: outDir + name + ".png" });
  const issues = await audit(page);
  report.push({ name, issues });
  if (issues.length) testInfo.annotations.push({ type: "layout", description: `${name}: ${issues.join("; ")}` });
  return issues;
}

// Destinations live in the sidebar's "Destinations" nav landmark; a page-wide name match would also hit thread rows
// whose titles start with the same word (a "Tools reliability fixture" thread opened instead of the Tools page).
const nav = (page, label) => page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: label, exact: true });

for (const mode of MODES) {
  for (const viewport of VIEWPORTS) {
    test(`tour ${mode} ${viewport.name}`, async ({ page, request }, testInfo) => {
      test.setTimeout(240_000);
      const consoleErrors = [];
      page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) consoleErrors.push(message.text().slice(0, 200)); });
      page.on("pageerror", error => consoleErrors.push(String(error).slice(0, 200)));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepare(page, request, mode);
      const tag = `${mode}-${viewport.name}`;
      const found = [];
      found.push(...await capture(page, `${tag}-01-home`, testInfo));

      for (const [index, label] of ["Projects", "History", "Usage", "Tools", "Environments", "Settings"].entries()) {
        const button = nav(page, label);
        if (!(await button.count())) continue;
        await button.click();
        found.push(...await capture(page, `${tag}-1${index}-${label.toLowerCase()}`, testInfo));
      }
      const sections = ["General", "Agents & models", "Workspace", "Appearance", "Desktop", "Shortcuts", "Diagnostics"];
      for (const [index, label] of sections.entries()) {
        const section = page.locator("button").filter({ hasText: new RegExp("^\\s*" + label.replace(/[&]/g, "\\$&")) }).first();
        if (!(await section.count())) continue;
        await section.click();
        found.push(...await capture(page, `${tag}-2${index}-settings-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`, testInfo));
      }

      await page.goto("/");
      await expect(page.getByTestId("composer")).toBeVisible();
      await page.getByTestId("composer").fill("Show me the project layout.");
      await page.getByTestId("send").click();
      // Mock mode answers through the direct provider route ("Mock direct reply: …"); a native turn says "Mock Trebell Native reply".
      await expect(page.getByText(/Mock (direct|Trebell Native) reply/).first()).toBeVisible({ timeout: 15_000 });
      found.push(...await capture(page, `${tag}-30-conversation`, testInfo));

      await page.getByTestId("right-panel-toggle").click();
      for (const [index, label] of ["Files", "Diff", "Context", "Browser", "Git", "Agents", "Goal", "Runtime"].entries()) {
        const tab = page.getByTestId("right-panel").getByRole("button", { name: label, exact: true });
        if (!(await tab.count()) || await tab.isDisabled()) continue;
        await tab.click();
        found.push(...await capture(page, `${tag}-4${index}-inspector-${label.toLowerCase()}`, testInfo));
      }
      await page.getByTestId("terminal-toggle").click();
      found.push(...await capture(page, `${tag}-50-terminal`, testInfo));
      await page.keyboard.press("Control+K");
      await expect(page.getByTestId("command-palette")).toBeVisible();
      found.push(...await capture(page, `${tag}-51-palette`, testInfo));
      await page.keyboard.press("Escape");

      writeFileSync(outDir + `report-${tag}.json`, JSON.stringify({ report: report.filter(item => item.name.startsWith(tag)), consoleErrors }, null, 1));
      if (strict) {
        expect(consoleErrors, "console errors").toEqual([]);
        expect(found, "layout issues").toEqual([]);
      }
    });
  }
}

test("tour narrow width keeps the workspace usable", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await prepare(page, request, "dark");
  const issues = await capture(page, "narrow-900-home", testInfo);
  if (strict) expect(issues.filter(issue => /overflow|outside viewport|covered/.test(issue))).toEqual([]);
});
