// Mobile smoke (390×844) on anvil: dev login → deposit → open a long → per-block ticker → position with pending
// funding and liq price. Prereqs: anvil + DeployLocal + SmokeLocal (book liquidity) + keeper, and
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_LOCAL_RPC_URL=<anvil> NEXT_PUBLIC_DEV_ACCOUNT=<unlocked anvil acct> next dev
import { expect, test } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";

test("login → deposit → open → ticker → position", async ({ page }) => {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[browser ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  await expect(page.getByText(/0x90F7…b906/i)).toBeVisible();

  // per-block funding ticker from previewFundingState: block number advances
  const blockLabel = page.getByTestId("funding-ticker").getByText(/block #\d+/); // the funding ticker (the navbar counter shows the block too)
  const b1 = await blockLabel.textContent();
  await expect.poll(async () => blockLabel.textContent(), { timeout: 15_000 }).not.toBe(b1);

  // F2: deposit lives in a dialog opened from the ticket's Deposit button
  await page.locator('[aria-label="Account summary"]').getByRole("button", { name: "Deposit", exact: true }).click();
  const funds = page.getByRole("dialog", { name: "Deposit AUSD" });
  await funds.getByLabel("Deposit amount").fill("100");
  await funds.getByRole("button", { name: "Deposit AUSD" }).click();
  // first write: the terms gate (C3) asks once, on top of the deposit dialog, then the deposit goes ahead
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  await expect(gate).toContainText("Before your first transaction");
  await expect(gate.getByRole("button", { name: "Accept" })).toBeDisabled();
  await gate.getByRole("checkbox").check();
  await gate.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("deposit 100 AUSD ✓", { timeout: 30_000 });

  await page.keyboard.press("Escape"); // close the deposit dialog
  await page.getByLabel("Size", { exact: true }).fill("100"); // 1 lot
  await page.getByRole("button", { name: "Market long" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("✓", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/trade.png`, fullPage: true });

  await page.locator("nav.fixed").getByRole("link", { name: "Portfolio" }).click(); // phone bottom tabs
  await expect(page).toHaveURL(/\/positions$/);
  // F5.1: the Positions page reuses the terminal's positions card (Liq., Funding columns; Close menu)
  await expect(page.getByText("▲ Long").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("columnheader", { name: "Liq." })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Funding" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/positions.png`, fullPage: true });

  // close = reduce-only market order for the whole size; the account ends flat (keeps the smoke re-runnable)
  await page.getByRole("button", { name: "Close position" }).click();
  await page.getByRole("region", { name: "Close position" }).getByRole("button", { name: "100%" }).click();
  await expect(page.getByTestId("positions-tx-status")).toContainText("close 100% ✓", { timeout: 30_000 });
  await expect(page.getByText("No open position")).toBeVisible({ timeout: 15_000 });
});
