import { test, expect } from "@playwright/test";

test("Trebell Code harness renders and runs a complete demo turn", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Trebell Code").first()).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeVisible();
  await expect(page.getByTestId("model-picker").locator("option")).toHaveCount(3);
  await expect(page.getByTestId("freebuff-card")).toContainText("86");
  await expect(page.getByTestId("freebuff-card")).toContainText("10 FB/h");

  const composer=page.getByTestId("composer");
  await composer.fill("Build and validate a private local converter.");
  await page.getByTestId("send").click();

  await expect(page.getByText("Mock Freebuff reply: Build and validate a private local converter.")).toBeVisible({timeout:10000});
  await expect(page.getByRole("main").getByText("Freebuff direct path")).toBeVisible();

  await page.getByText("Edit Files").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.screenshot({path:"test-results/trebell-code-ui.png",fullPage:true});
});
