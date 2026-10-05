// DEMO_SCRIPT dry-run on Monad testnet, READ-ONLY (Phase 4 step 11): the app in chain mode against 10143 over the public
// RPC, each segment screenshotted at 390×844 into e2e/screenshots/demo-<segment>.png. No wallet, no transactions:
// login (0:15) is pending the Privy-vs-Mera decision and the crash (2:25) runs on a local fork (CrashDemo.s.sol).
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=10143 NEXT_PUBLIC_MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz \
//   NEXT_PUBLIC_LOG_SPAN=100 NEXT_PUBLIC_LOG_LOOKBACK=400 next dev -p 3118 ; APP_URL=http://localhost:3118 npx playwright test e2e/demo-dryrun.spec.ts
import { expect, test } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";

test("0:35 Trade: MON-PERP on testnet, per-block funding ticker", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByText("monad testnet", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  // the funding ticker (the navbar counter also shows the block since F1)
  await expect(page.getByTestId("funding-ticker").getByText(/block #\d+/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("block-counter")).toHaveAttribute("data-state", "live", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/demo-trade.png`, fullPage: true });
});

test("1:20 Earn: testnet vault state (hedged, share price, capacity)", async ({ page }) => {
  await page.goto("/earn");
  await expect(page.getByTestId("vault-status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("share-price")).toBeVisible();
  // the badge and the body must agree (dry-run finding, 30 Sep: "Hedged" next to "Waiting for funding")
  if ((await page.getByTestId("vault-status").textContent())?.includes("Hedged")) {
    await expect(page.getByTestId("waiting-for-funding")).toHaveCount(0);
  }
  await page.screenshot({ path: `${SHOTS}/demo-earn.png`, fullPage: true });
});

test("1:45 Fix: testnet swap market (fixed APR, maturity state)", async ({ page }) => {
  await page.goto("/fix");
  await expect(page.getByTestId("swap-mark-apr")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/demo-fix.png`, fullPage: true });
});

test("2:50 Stats", async ({ page }) => {
  await page.goto("/stats");
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: `${SHOTS}/demo-stats.png`, fullPage: true });
});
