import { test, expect } from "@playwright/test";

test("Trebell Code renders the harness and scopes models to the selected provider", async ({ page }) => {
  await page.addInitScript(()=>{
    const snapshot={url:"http://fixture.local",title:"Preview fixture",text:"Checkout",elements:[{ref:"e7",tag:"button",text:"Submit order",href:""}]};
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{navigate:async()=>({ok:true}),show:async()=>({ok:true}),snapshot:async()=>snapshot,screenshot:async()=>({dataUrl:"data:image/png;base64,iVBORw0KGgo="}),importCookies:async()=>({ok:true,imported:2,failed:0}),close:async()=>({ok:true})}}});
  });
  await page.goto("/");
  await expect(page.getByText("Trebell Code").first()).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeVisible();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(3);
  await expect(page.getByRole("button",{name:"New thread"})).toBeVisible();
  await expect(page.getByTestId("right-panel-toggle")).toBeVisible();
  await expect(page.getByTestId("terminal-toggle")).toBeVisible();

  const composer=page.getByTestId("composer");
  await composer.fill("Build and validate a private local converter.");
  await page.getByTestId("send").click();

  await expect(page.getByText("Mock Freebuff reply: Build and validate a private local converter.")).toBeVisible({timeout:10000});
  await expect(page.getByRole("group").getByText("Freebuff direct response")).toBeVisible();

  await page.getByRole("button",{name:"Cite response"}).click();
  await expect(page.getByTestId("context-chips")).toContainText("Assistant citation");

  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.getByTestId("right-panel").getByRole("button",{name:"Diff"}).click();
  await expect(page.getByText("Changes",{exact:true}).first()).toBeVisible();
  await page.getByRole("button",{name:"Close right panel"}).click();
  await expect(page.getByTestId("right-panel")).toBeHidden();

  await page.getByTestId("terminal-toggle").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByRole("button",{name:"Close terminal"}).click();
  await expect(page.getByTestId("drawer")).toBeHidden();

  await page.getByRole("button",{name:"Projects"}).click();
  await expect(page.getByRole("heading",{name:"Projects"})).toBeVisible();
  await expect(page.getByText("Clone repository")).toBeVisible();

  await page.getByRole("button",{name:"Browser"}).click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.getByRole("button",{name:"Open agent browser"}).click();
  await page.getByRole("button",{name:"Import cookies"}).click();
  await expect(page.getByTestId("browser-cookie-status")).toHaveText("Imported 2 cookies");
  await page.getByRole("button",{name:/Submit order/}).click();
  await page.getByTestId("preview-annotation").locator("textarea").fill("Use this button to submit the checkout flow.");
  await page.getByRole("button",{name:"Attach annotation"}).click();
  await expect(page.getByTestId("preview-annotation")).toContainText("Annotation attached");

  await page.getByRole("button",{name:"Freebuff"}).click();
  await expect(page.getByRole("heading",{name:"Freebuff"})).toBeVisible();
  await expect(page.getByText("Freebucks balance")).toBeVisible();

  await page.getByRole("button",{name:"Settings"}).click();
  await expect(page.getByRole("heading",{name:"Settings"})).toBeVisible();
  await expect(page.getByText("Follow-up behavior")).toBeVisible();

  const providerSelector=page.getByTestId("provider-selector");

  await providerSelector.selectOption("justworker");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(1);
  await expect(page.getByTestId("model-picker")).toHaveValue("claude-opus-4-8");

  await page.getByRole("button",{name:"Settings"}).click();
  await providerSelector.selectOption("hcnsec");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(1);
  await expect(page.getByTestId("model-picker")).toHaveValue("glm-5.3");

  await page.getByRole("button",{name:"Settings"}).click();
  await providerSelector.selectOption("vyceai");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(4);
  await expect(page.getByTestId("model-picker").locator("option")).toHaveText([
    "claude-sonnet-4-6",
    "gpt-astra",
    "deepseek-v4-flash",
    "auto",
  ]);

  await page.getByRole("button",{name:"Settings"}).click();
  await providerSelector.selectOption("agentrouter");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(5);
  await expect(page.getByTestId("model-picker").locator("option")).toHaveText([
    "gpt-5.6-sol",
    "gpt-6-astra",
    "claude-opus-4-8",
    "claude-opus-5",
    "deepseek-v4-flash",
  ]);

  await page.getByRole("button",{name:"Settings"}).click();
  await providerSelector.selectOption("freebuff");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(3);
  await expect(page.getByRole("button",{name:"Freebuff"})).toBeVisible();

  await page.screenshot({path:"test-results/trebell-code-ui.png",fullPage:true});
});
