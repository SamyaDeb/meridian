// CR-017: the Fix page's funding-source switch and the Perpl fixed-vs-floating card, read-only against the live
// testnet contracts (chain mode):
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=10143 NEXT_PUBLIC_MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz \
//   NEXT_PUBLIC_LOG_SPAN=100 next dev -p 3121 ; APP_URL=http://localhost:3121 npx playwright test e2e/perpl-swaps.spec.ts
// At 390 / 768 / 1440: no horizontal page scroll, screenshots in e2e/screenshots/widths/.
import { expect, test } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots/widths";
const WIDTHS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];

const noHorizontalScroll = async (page: import("@playwright/test").Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test("Fix: the source switch selects the Perpl market and says what is true", async ({ page }) => {
  await page.goto("/fix");
  const tabs = page.getByRole("tablist", { name: "Funding source" });
  await expect(tabs.getByRole("tab", { name: "Meridian funding" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("perpl-settles")).toHaveCount(0);
  await tabs.getByRole("tab", { name: "Perpl funding" }).click();
  await expect(page).toHaveURL(/\?source=perpl/);
  await expect(page.getByTestId("perpl-settles")).toHaveText("Settles on Perpl's onchain funding, once per Perpl funding interval (~43 min). Testnet.");
  // the last poke of PerplFundingSource 0xC008…24cC, read onchain (deployed at 70,443,746)
  await expect(page.getByTestId("perpl-last-poke")).toContainText(/Last poke: block 70,4\d\d,\d\d\d/, { timeout: 30_000 });
  await expect(page.getByText("MON funding · Perpl · 30d")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/overwrite a funding sum/)).toBeVisible();
  // back to Meridian: the Perpl notice goes, the Meridian market row is back
  await tabs.getByRole("tab", { name: "Meridian funding" }).click();
  await expect(page).not.toHaveURL(/source=perpl/);
  await expect(page.getByTestId("perpl-settles")).toHaveCount(0);
  await expect(page.getByText("MON funding · 30d")).toBeVisible({ timeout: 30_000 });
});

test("Rates: the Perpl swap's fixed APR next to Perpl's floating APR", async ({ page }) => {
  await page.goto("/rates");
  const card = page.getByTestId("perpl-swap-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Fixed APR (swap mark, 30d)");
  await expect(card).toContainText("Perpl floating now (onchain rate)");
  await expect(card).toContainText("Testnet");
  await expect(page.getByRole("link", { name: "Trade on Fix" })).toHaveAttribute("href", "/fix?source=perpl");
});

for (const { w, h } of WIDTHS) {
  for (const [path, name, ready] of [
    ["/fix?source=perpl", "fix-perpl", "perpl-last-poke"],
    ["/rates", "rates-perpl", "perpl-swap-card"],
  ] as const) {
    test(`${path} at ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(path);
      await expect(page.getByTestId(ready)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true, animations: "disabled" });
      await noHorizontalScroll(page);
    });
  }
}
