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
  const blockLabel = page.getByText(/block #\d+/);
  const b1 = await blockLabel.textContent();
  await expect.poll(async () => blockLabel.textContent(), { timeout: 15_000 }).not.toBe(b1);

  await page.getByLabel("Deposit amount").fill("100");
  await page.getByRole("button", { name: "Deposit AUSD" }).click();
  // first write: the terms gate (C3) asks once, then the deposit goes ahead
  const gate = page.getByRole("dialog");
  await expect(gate).toContainText("Before your first transaction");
  await expect(gate.getByRole("button", { name: "Accept" })).toBeDisabled();
  await gate.getByRole("checkbox").check();
  await gate.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("deposit 100 AUSD ✓", { timeout: 30_000 });

  await page.getByRole("button", { name: "Market long" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("✓", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/trade.png`, fullPage: true });

  await page.getByRole("link", { name: /positions/i }).click();
  await expect(page.getByText("Long", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Liq. price")).toBeVisible();
  await expect(page.getByText("Funding (live)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/positions.png`, fullPage: true });

  // close = reduce-only market order for the whole size; the account ends flat (keeps the smoke re-runnable)
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("close ✓", { timeout: 30_000 });
  await expect(page.getByText("No open perp positions.")).toBeVisible({ timeout: 15_000 });
});
