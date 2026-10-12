// F2 gate, write paths on a LOCAL anvil (31337) through the desktop terminal: deposit → post-only limit → edit
// (replaceOrder) → cancel → cancel all (cancelOrders) → market long → close (reduce-only). Prereqs as anvil-smoke
// (DeployLocal + SmokeLocal, tAUSD minted to the dev account), then:
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_LOCAL_RPC_URL=<anvil> NEXT_PUBLIC_DEV_ACCOUNT=<acct> next dev -p 3123
//   APP_URL=http://localhost:3123 npx playwright test e2e/terminal-anvil.spec.ts
import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";
test.setTimeout(Number(process.env.T ?? 180_000));

async function acceptGateIfAsked(page: Page) {
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  if (await gate.isVisible().catch(() => false)) {
    await gate.getByRole("checkbox").check();
    await gate.getByRole("button", { name: "Accept" }).click();
  }
}
const ticketStatus = (page: Page) => page.locator('[aria-label="Order ticket"]').getByTestId("tx-status");
const posStatus = (page: Page) => page.getByTestId("positions-tx-status");
const posTab = (page: Page, name: string) => page.getByRole("tablist", { name: "Account tables" }).getByRole("tab", { name: new RegExp(`^${name}`) });

test("desktop terminal write paths on anvil", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();

  // clean slate on a reused anvil: cancel leftovers, close any position (these use the same buttons under test)
  await posTab(page, "Open orders").click();
  await page.waitForTimeout(2_000);
  if (await page.getByRole("button", { name: "Cancel all" }).isVisible()) {
    await page.getByRole("button", { name: "Cancel all" }).click();
    await acceptGateIfAsked(page);
    await expect(page.locator('[data-area="pos"]')).toContainText("No open orders", { timeout: 30_000 });
  }
  await posTab(page, "Positions").click();
  await page.waitForTimeout(1_000);
  if (await page.getByRole("button", { name: "Close position" }).isVisible()) {
    await page.getByRole("button", { name: "Close position" }).click();
    await page.getByRole("region", { name: "Close position" }).getByRole("button", { name: "100%" }).click();
    await acceptGateIfAsked(page);
    await expect(page.locator('[data-area="pos"]')).toContainText("No open position", { timeout: 30_000 });
  }

  // deposit from the ticket (DeployLocal may already have funded the dev account; this adds 200)
  await page.locator('[aria-label="Account summary"]').getByRole("button", { name: "Deposit", exact: true }).click();
  const funds = page.getByRole("dialog", { name: "Deposit AUSD" });
  await funds.getByLabel("Deposit amount").fill("200");
  await funds.getByRole("button", { name: "Deposit AUSD" }).click();
  await acceptGateIfAsked(page);
  await expect(funds.getByTestId("tx-status")).toContainText("deposit 200 AUSD ✓", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-area="account"]')).toContainText("Equity", { timeout: 20_000 });

  // post-only limit bid well under the book
  await page.getByRole("tablist", { name: "Order type" }).getByRole("tab", { name: "Limit" }).click();
  await page.getByRole("textbox", { name: "Limit price" }).fill("0.024000");
  await page.getByLabel("Size", { exact: true }).fill("100");
  await page.getByText("Post-only").click();
  await page.getByRole("button", { name: "Limit long" }).click();
  await expect(ticketStatus(page)).toContainText("limit long 1 lots ✓", { timeout: 30_000 });
  await posTab(page, "Open orders").click();
  await expect(posTab(page, "Open orders")).toHaveText(/Open orders\s*1$/, { timeout: 15_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("0.024000");
  await expect(page.locator('[data-area="pos"]')).toContainText("post-only");

  // edit → replaceOrder keeps the flags, moves the price
  await page.getByRole("button", { name: /^Edit order/ }).first().click();
  await page.getByLabel("New price").fill("0.024100");
  await page.getByRole("button", { name: "Replace order" }).click();
  await expect(posStatus(page)).toContainText(/edit #\d+ ✓/, { timeout: 30_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("0.024100", { timeout: 15_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("post-only");

  // cancel one
  await page.locator('[data-area="pos"]').getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(posStatus(page)).toContainText(/cancel #\d+ ✓/, { timeout: 30_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("No open orders", { timeout: 15_000 });

  // two more, then cancel all (cancelOrders)
  for (const px of ["0.023000", "0.023500"]) {
    await page.getByRole("textbox", { name: "Limit price" }).fill(px);
    await page.getByRole("button", { name: "Limit long" }).click();
    await expect(ticketStatus(page)).toContainText("✓", { timeout: 30_000 });
    await expect(page.locator('[data-area="pos"]')).toContainText(px, { timeout: 15_000 });
  }
  await page.getByRole("button", { name: "Cancel all" }).click();
  await expect(posStatus(page)).toContainText("cancel all (2) ✓", { timeout: 30_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("No open orders", { timeout: 15_000 });

  // market long, then close 100 % (reduce-only market)
  await page.getByRole("tablist", { name: "Order type" }).getByRole("tab", { name: "Market" }).click();
  await page.getByLabel("Size", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Market long" }).click();
  await expect(ticketStatus(page)).toContainText("market long 1 lots ✓", { timeout: 30_000 });
  await posTab(page, "Positions").click();
  await expect(page.locator('[data-area="pos"]')).toContainText("▲ Long", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/terminal-anvil-position.png` });
  await page.getByRole("button", { name: "Close position" }).click();
  await page.getByRole("region", { name: "Close position" }).getByRole("button", { name: "100%" }).click();
  await expect(posStatus(page)).toContainText("close 100% ✓", { timeout: 30_000 });
  await expect(page.locator('[data-area="pos"]')).toContainText("No open position", { timeout: 15_000 });
});
