// Screenshot tour with automated layout checks: every primary surface in dark and light mode at two
// desktop sizes plus a narrow width. Screenshots land in visual-audit/redesign/ for side-by-side review, and
// layout problems (horizontal overflow, covered controls, unnamed buttons, console errors) fail the run
// when TREBELL_TOUR_STRICT=1 (set once the redesign lands); otherwise they are attached as annotations.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
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
    const scrollParent = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|overlay)/.test(s.overflowX + s.overflowY) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p; } return null; };
    // A point that a clipping ancestor cuts off (a thread row scrolled past the edge of the sidebar list) is out of view, not covered.
    const clippedAt = (el, x, y) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue; const b = p.getBoundingClientRect(); if (x < b.left || x > b.right || y < b.top || y > b.bottom) return true; } return false; };
    // While a modal dialog is open the page behind it is meant to be covered, so only the dialog's own controls are checked.
    // The narrow inspector drawer works the same way: with its scrim showing, the conversation under it is meant to be covered.
    const scrim = document.querySelector("[data-testid=inspector-scrim]");
    const drawer = scrim && visible(scrim) ? document.querySelector("[data-testid=right-panel]") : null;
    const modal = [...document.querySelectorAll("[aria-modal=true]")].filter(visible).pop() || drawer || null;
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
  // Data placeholders clear too (skeleton rows, busy lists and selects, "checking…" and "Loading…" copy), so a shot proves the
  // loaded screen rather than its loading state.
  await expect(page.locator(".tb-skeleton, [aria-busy=true]").filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
  // Text inside a code or diff view is content, not a placeholder: this checkout's own diff can quote "checking…".
  const placeholders = page.getByText(/checking…|^\s*Loading\b/i).and(page.locator("xpath=//*[not(ancestor-or-self::pre)]"));
  await expect(placeholders.filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(250);
  await page.screenshot({animations:"disabled", path: outDir + name + ".png" });
  const issues = await audit(page);
  report.push({ name, issues });
  if (issues.length) testInfo.annotations.push({ type: "layout", description: `${name}: ${issues.join("; ")}` });
  return issues;
}

// Diff lines whose text runs outside their own row, or whose row overlaps the next one: a wrapped line that keeps a one-line row
// paints its continuation over the lines under it.
function overprintedDiffLines(diff) {
  return diff.evaluate(node => [...node.querySelectorAll(".diff-line")].filter((line, index, lines) => {
    const range = document.createRange(); range.selectNodeContents(line);
    const text = range.getBoundingClientRect(), box = line.getBoundingClientRect(), next = lines[index + 1]?.getBoundingClientRect();
    return text.height > 0 && (text.bottom > box.bottom + 1 || Boolean(next && next.top < box.bottom - 1));
  }).length);
}

// A clean checkout has no diff to show, so the Diff tab is served the patch of its latest commit (not a merge) as the working-tree
// diff instead, and the overprint check runs on real code either way. Git's --name-status letters become short-status codes.
function latestCommitChanges(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const commit = git("log", "--no-merges", "--diff-filter=ACDMR", "-n", "1", "--format=%H").trim();
  const status = git("show", "--format=", "--name-status", commit).split(/\r?\n/).filter(Boolean).map(line => {
    const [code, ...paths] = line.split("\t");
    return /^[RC]/.test(code) ? code[0] + "  " + paths.join(" -> ") : ({ A: "A ", D: " D" }[code[0]] || " M") + " " + paths[0];
  }).join("\n");
  return { cwd, isGit: true, status, diff: git("show", "--format=", "--patch", "--no-color", "--no-ext-diff", commit), stderr: "" };
}

// What the Git tab is told of the code host in the tour: GitHub, signed in, with two open pull requests (see the route in the tour).
const TOUR_CAPABILITIES = { create: true, edit: true, comment: true, editComments: true, review: true, merge: true, autoMerge: true, checkout: true, reviewers: true, publish: true };
const TOUR_CODE_HOST = {
  diagnostics: {
    selectedProvider: "github", detectedProvider: "github", git: { version: "git version 2.47.1" },
    providers: { github: { label: "GitHub", installed: true, authenticated: true, version: "gh version 2.63.2" }, gitlab: { label: "GitLab", installed: false, authenticated: false, detail: "Install GitLab CLI (`glab`)." } },
    capabilities: { github: TOUR_CAPABILITIES },
  },
  prs: {
    ok: true, provider: "github", capabilities: TOUR_CAPABILITIES,
    items: [[42, "Tour fixture: keep the composer draft when a send is refused", "tour-fixture-draft"], [41, "Tour fixture: say what a restored project is missing", "tour-fixture-restore"]].map(([number, title, head]) => ({
      provider: "github", number, title, state: "OPEN", isDraft: false, url: "https://example.test/pull/" + number, headRefName: head, baseRefName: "main",
      author: { login: "trebell-tour" }, identity: { provider: "github", host: "github.com", repository: "owner/repo", number },
    })),
  },
};

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

      // The Diff tab shows this checkout's own changes, or its latest commit when it has none (see latestCommitChanges).
      const boot = await (await request.get("/api/bootstrap")).json();
      const changes = await (await request.get("/api/workspace/diff?" + new URLSearchParams({ path: boot.cwd, environmentId: "" }))).json();
      if (!String(changes.diff || "").trim()) {
        const committed = latestCommitChanges(boot.cwd);
        expect(committed.diff, "the latest commit's patch").toContain("diff --git");
        await page.route("**/api/workspace/diff?**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(committed) }));
      }
      // The Git tab's code host answers come from this machine, not from Trebell: which CLIs are installed and signed in (gh, glab,
      // tea, fj and az, each asked its version and sign-in) and the pull requests GitHub lists for this checkout's remote. The tour runs offline, and in
      // a full run those reads took longer than a capture waits (both still loading after 15 s), so they are answered here, as the
      // Diff tab's patch is.
      await page.route("**/api/source-control/diagnostics?**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOUR_CODE_HOST.diagnostics) }));
      await page.route("**/api/source-control/prs?**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOUR_CODE_HOST.prs) }));
      await page.getByTestId("right-panel-toggle").click();
      for (const [index, label] of ["Files", "Diff", "Context", "Browser", "Git", "Agents", "Goal", "Runtime"].entries()) {
        const tab = page.getByTestId("right-panel").getByRole("button", { name: label, exact: true });
        if (!(await tab.count()) || await tab.isDisabled()) continue;
        await tab.click();
        const diff = label === "Diff" ? page.getByTestId("workspace-diff-preview") : null;
        if (diff) await expect(diff).toContainText("diff --git");
        found.push(...await capture(page, `${tag}-4${index}-inspector-${label.toLowerCase()}`, testInfo));
        // Lines wrap by default, and a wrapped line takes the rows its text needs: none paints over the lines under it.
        if (diff) expect(await overprintedDiffLines(diff), "overprinted diff lines").toBe(0);
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

// Mid-size and narrow windows in both modes (a lighter pass): the widths between the narrow overlay and 1280 are where the
// docked inspector, the topbar and the settings rail have to give up room.
const MID_VIEWPORTS = [{ name: "900x800", width: 900, height: 800 }, { name: "1024x768", width: 1024, height: 768 }, { name: "1120x800", width: 1120, height: 800 }];
for (const mode of MODES) {
  for (const viewport of MID_VIEWPORTS) {
    test(`tour ${mode} ${viewport.name} mid-size`, async ({ page, request }, testInfo) => {
      test.setTimeout(150_000);
      const consoleErrors = [];
      page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) consoleErrors.push(message.text().slice(0, 200)); });
      page.on("pageerror", error => consoleErrors.push(String(error).slice(0, 200)));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepare(page, request, mode);
      const tag = `${mode}-${viewport.name}`;
      const found = [];
      found.push(...await capture(page, `${tag}-01-home`, testInfo));
      for (const label of ["Projects", "Settings"]) {
        await nav(page, label).click();
        found.push(...await capture(page, `${tag}-1-${label.toLowerCase()}`, testInfo));
      }
      // Settings with the sidebar collapsed: the rail stays a vertical list, and the page topbar brings the sidebar back.
      await page.keyboard.press("Control+B");
      const reopen = page.getByRole("button", { name: "Open sidebar" });
      await expect(reopen).toBeVisible();
      found.push(...await capture(page, `${tag}-2-settings-sidebar-collapsed`, testInfo));
      await reopen.click();
      await expect(nav(page, "Settings")).toBeVisible();

      await nav(page, "New task").click();
      await page.getByTestId("composer").fill("Show me the project layout.");
      await page.getByTestId("send").click();
      await expect(page.getByText(/Mock (direct|Trebell Native) reply/).first()).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("right-panel-toggle").click();
      const panel = page.getByTestId("right-panel");
      await expect(panel).toBeVisible();
      found.push(...await capture(page, `${tag}-3-inspector-files`, testInfo));
      const box = await panel.boundingBox();
      expect(box.x + box.width, "inspector stays inside the window").toBeLessThanOrEqual(viewport.width + 1);
      if (viewport.width <= 900) {
        // The overlay drawer closes on Escape and on a click on the dimmed conversation, and a page opened from the sidebar
        // closes it too.
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await page.getByTestId("right-panel-toggle").click();
        await expect(panel).toBeVisible();
        await page.getByTestId("inspector-scrim").click({ position: { x: 40, y: 200 } });
        await expect(panel).toBeHidden();
        await page.getByTestId("right-panel-toggle").click();
        await expect(panel).toBeVisible();
        await nav(page, "Projects").click();
        await expect(panel).toBeHidden();
      }
      writeFileSync(outDir + `report-${tag}.json`, JSON.stringify({ report: report.filter(item => item.name.startsWith(tag)), consoleErrors }, null, 1));
      if (strict) {
        expect(consoleErrors, "console errors").toEqual([]);
        expect(found, "layout issues").toEqual([]);
      }
    });
  }
}

// A light-mode user's first frame after a reload is light: the cached appearance applies before the stylesheets load.
test("tour light start paints light from the first frame", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page, request, "light");
  await page.reload({ waitUntil: "domcontentloaded" });
  const first = await page.evaluate(() => document.documentElement.dataset.mode || "");
  await page.waitForTimeout(300);
  await page.screenshot({animations:"disabled", path: outDir + "light-1280x800-00-startup-300ms.png" });
  const settled = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode, background: getComputedStyle(document.body).backgroundColor }));
  expect(first).toBe("light");
  expect(settled.mode).toBe("light");
  expect(settled.background).not.toMatch(/^rgb\((\d|[1-4]\d), (\d|[1-4]\d), (\d|[1-4]\d)\)$/);
});

test("tour narrow width keeps the workspace usable", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await prepare(page, request, "dark");
  const issues = await capture(page, "narrow-900-home", testInfo);
  if (strict) expect(issues.filter(issue => /overflow|outside viewport|covered/.test(issue))).toEqual([]);
});
