// F4.4: hotkeys, command palette, privacy masks (mock data layer, no wallet).
//   APP_URL=http://localhost:3124 npx playwright test e2e/pro-ux.spec.ts
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await expect(page.getByTestId("terminal")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // focus the page, not an input
});

test("hotkeys drive the ticket and never fire while typing", async ({ page }) => {
  const side = page.getByRole("radiogroup", { name: "Side" });
  await page.keyboard.press("s");
  await expect(side.getByRole("radio", { name: /Short/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("l");
  await expect(page.getByRole("tablist", { name: "Order type" }).getByRole("tab", { name: "Limit" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("/");
  await expect(page.getByLabel("Size", { exact: true })).toBeFocused();
  await page.keyboard.type("b300"); // typing: "b" must not flip the side
  await expect(side.getByRole("radio", { name: /Short/ })).toHaveAttribute("aria-checked", "true");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Size", { exact: true })).toHaveValue("");
  await page.keyboard.press("b");
  await expect(side.getByRole("radio", { name: /Long/ })).toHaveAttribute("aria-checked", "true");
});

test("⌘K palette navigates and toggles settings", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const dlg = page.getByRole("dialog", { name: "Commands" });
  await expect(dlg).toBeVisible();
  await page.keyboard.type("go earn");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/earn$/);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("short");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByRole("radiogroup", { name: "Side" }).getByRole("radio", { name: /Short/ })).toHaveAttribute("aria-checked", "true");
});

test("privacy: hide balances / PnL mask the account card", async ({ page }) => {
  const account = page.locator('[data-area="account"]');
  await expect(account).toContainText("Equity", { timeout: 20_000 }); // mock sample account (account strip, 3c26902)
  await page.getByRole("button", { name: "Settings", exact: true }).click(); // navbar gear (the chart has its own "Chart settings")
  await page.getByLabel(/Hide balances/).check();
  await page.getByLabel(/Hide PnL/).check();
  await expect(account.getByLabel("hidden").first()).toBeVisible();
  expect(await account.getByLabel("hidden").count()).toBeGreaterThanOrEqual(2); // strip: equity + free collateral (margin ratio is not a balance)
  await page.reload();
  await expect(account.getByLabel("hidden").first()).toBeVisible(); // persisted per viewer
});
