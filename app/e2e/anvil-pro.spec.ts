// F4.5 keyboard-only trade flow + F6 trigger UI (mocked manager) on a LOCAL anvil. Setup as terminal-anvil.spec.ts,
// plus NEXT_PUBLIC_TRIGGERS_MOCK=1 on the dev server (the trigger UI is hidden without a manager or that flag).
import { expect, test, type Page } from "@playwright/test";

test.setTimeout(180_000);

/** Tab forward until `pred` holds for the focused element (bounded). */
async function tabTo(page: Page, pred: (el: Element) => boolean, max = 120) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((src) => new Function("el", `return (${src})(el)`)(document.activeElement), pred.toString())) return;
  }
  throw new Error("focus target not reached by Tab");
}
async function gateByKeyboard(page: Page) {
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  if (await gate.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await tabTo(page, (el) => (el as HTMLInputElement).type === "checkbox");
    await page.keyboard.press("Space");
    await tabTo(page, (el) => el.textContent?.trim() === "Accept");
    await page.keyboard.press("Enter");
  }
}

test("keyboard only: connect, choose side, size, place a market order", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await page.locator("body").click({ position: { x: 2, y: 2 } }); // start focus at the top of the document
  await tabTo(page, (el) => el.textContent?.trim() === "Dev account");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("b"); // long
  await page.keyboard.press("m"); // market
  await page.keyboard.press("/"); // focus size
  await page.keyboard.type("100");
  await tabTo(page, (el) => el.getAttribute("data-testid") === "place-order");
  await expect(page.getByTestId("place-order")).toHaveText("Market long", { timeout: 15_000 });
  await page.keyboard.press("Enter");
  await gateByKeyboard(page);
  await expect(page.locator('[aria-label="Order ticket"]').getByTestId("tx-status")).toContainText("market long 1 lots ✓", { timeout: 30_000 });
});

test("triggers (mocked manager): place a stop, see it in the Triggers tab and on the chart, cancel it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  // a position to protect (the first test may have left one; open one if flat)
  const section = page.getByTestId("trigger-section");
  if (!(await section.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await page.getByLabel("Size", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Market long" }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
    if (await gate.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await gate.getByRole("checkbox").check();
      await gate.getByRole("button", { name: "Accept" }).click();
    }
    await expect(section).toBeVisible({ timeout: 30_000 });
  }
  await expect(section).toContainText("A stop is not liquidation protection");
  await expect(section).toContainText("mock: nothing sent");
  await section.getByLabel("Trigger price").fill("5");
  await expect(section).toContainText("Worst fill price");
  await section.getByTestId("place-trigger").click();
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  if (await gate.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await gate.getByRole("checkbox").check();
    await gate.getByRole("button", { name: "Accept" }).click();
  }
  await expect(section.getByTestId("trigger-tx-status")).toContainText("(mock, nothing sent) ✓ (no transaction sent)", { timeout: 15_000 });
  const tab = page.getByRole("tablist", { name: "Account tables" }).getByRole("tab", { name: /^Triggers/ });
  await tab.click();
  await expect(tab).toContainText("1");
  await expect(page.locator('[data-area="pos"]')).toContainText("Stop-loss");
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/screenshots"}/triggers-mock.png` });
  await page.locator('[data-area="pos"]').getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator('[data-area="pos"]')).toContainText("No triggers", { timeout: 15_000 });
});
