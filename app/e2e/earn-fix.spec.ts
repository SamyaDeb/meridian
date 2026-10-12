// Mobile smoke (390×844) for Earn + Fix on the Phase 4 full-stack local rehearsal (contracts/script/README.md):
// anvil --chain-id 10143 + DeployMeridian (vault + swaps) + SmokeFull + 8 h history + keeper (VAULT_REBALANCE=1) + perp and
// swap MMs, and the app built with
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=10143 NEXT_PUBLIC_LOCAL_CHAIN_ID=10143
//   NEXT_PUBLIC_LOCAL_RPC_URL=http://127.0.0.1:8546 NEXT_PUBLIC_DEV_ACCOUNT=<unlocked anvil account holding tAUSD>
//   NEXT_PUBLIC_DEPLOYMENT_OVERRIDE="$(cat deployments/anvil-10143.json)"
import { type Page, expect, test } from "@playwright/test";
import { TERMS_STORAGE_KEY, acceptanceRecord } from "../src/lib/terms";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";

// terms already accepted for this version (the gate itself is exercised in anvil-smoke.spec.ts)
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, record]) => localStorage.setItem(key, record),
    [TERMS_STORAGE_KEY, acceptanceRecord(Date.now())] as const,
  );
});

async function login(page: Page) {
  await page.getByRole("button", { name: "Dev account" }).click();
  await expect(page.getByText(/0x[0-9a-f]{4}…[0-9a-f]{4}/i).first()).toBeVisible();
}

/** Mobile checklist: no horizontal scroll; every enabled button in <main> is ≥ 44 px tall; bottom nav present. */
async function mobileChecks(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal scroll").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button")]
      .map((b) => ({ t: (b.textContent ?? "").trim().slice(0, 30), h: b.getBoundingClientRect().height }))
      .filter((b) => b.h > 0 && b.h < 44),
  );
  expect(small, `tap targets < 44 px: ${JSON.stringify(small)}`).toEqual([]);
  await expect(page.getByRole("link", { name: /earn/i })).toBeVisible();
}

test("Earn: deposit → share price keeps moving (per-block funding)", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.goto("/earn");
  await login(page);
  await expect(page.getByTestId("vault-status")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  await page.getByLabel("Vault deposit amount").fill("50");
  await page.getByRole("button", { name: "Deposit AUSD" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("deposit 50 AUSD ✓", { timeout: 60_000 });
  await expect(page.getByTestId("my-vault-value")).not.toHaveText("—");
  const price = page.getByTestId("share-price");
  const p1 = await price.textContent();
  await expect.poll(async () => price.textContent(), { timeout: 30_000 }).not.toBe(p1);
  await mobileChecks(page);
  await page.screenshot({ path: `${SHOTS}/earn.png`, fullPage: true });
});

test("Fix: margin → pay fixed at the book APR → accrual ticks → close", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.goto("/fix");
  await login(page);
  await page.getByRole("button", { name: "Deposit Margin" }).click();
  await page.getByLabel("Swap collateral amount").fill("100");
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(page.getByTestId("tx-status")).toContainText("deposit 100 AUSD (swap margin) ✓", { timeout: 60_000 });
  await page.getByLabel(/Size/).fill("1");
  await page.getByRole("button", { name: /^Pay fixed/ }).click();
  await expect(page.getByTestId("tx-status")).toContainText("pay fixed 1 lot (market) ✓", { timeout: 60_000 });
  const accrued = page.getByTestId("swap-accrued");
  await expect(accrued).toBeVisible({ timeout: 20_000 });
  const a1 = await accrued.textContent();
  await expect.poll(async () => accrued.textContent(), { timeout: 30_000 }).not.toBe(a1);
  await mobileChecks(page);
  await page.screenshot({ path: `${SHOTS}/fix.png`, fullPage: true });
  await page.getByRole("button", { name: "Close (reduce-only)" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("close swap (reduce-only) ✓", { timeout: 60_000 });
});
