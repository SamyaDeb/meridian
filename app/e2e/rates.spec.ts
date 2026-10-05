// F5.6 Rates & risk with the TEST-ONLY indexer stub (see chart.spec.ts for the setup).
import { expect, test } from "@playwright/test";

test("rates: oracle APR cards, MFI honest empty state, liquidation-distance histogram, insurance fund", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: "Rates & risk" })).toBeVisible();
  // without NEXT_PUBLIC_MFI_URL the MFI is never simulated (the MFI_STUB build covers the populated card below)
  if (process.env.MFI_STUB !== "1") await expect(page.getByText("MFI service not connected")).toBeVisible();
  const hist = page.getByRole("list", { name: "Positions by distance to liquidation" });
  await expect(hist).toBeVisible({ timeout: 20_000 });
  const counts = await hist.locator("li .num").allTextContents();
  const total = counts.reduce((s, t) => s + Number(t.split("·")[0]!.trim()), 0);
  expect(total).toBe(24); // every stub position lands in exactly one bucket
  await expect(page.getByText("1,000.00 AUSD")).toBeVisible(); // insurance funded
});

// D3 port of T8's MFI chart, against the TEST-ONLY MFI stub (synthetic values):
//   node e2e/fixtures/mfi-stub.mjs 8798 &   build/start the app with NEXT_PUBLIC_MFI_URL=http://127.0.0.1:8798
//   MFI_STUB=1 APP_URL=… npx playwright test e2e/rates.spec.ts
test("rates: MFI card with venues, line chart and table toggle (stub)", async ({ page }) => {
  test.skip(process.env.MFI_STUB !== "1", "needs the MFI stub build (NEXT_PUBLIC_MFI_URL)");
  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: /Meridian Funding Index/ })).toBeVisible();
  await expect(page.getByText("OI-weighted")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("7.3% weight")).toBeVisible(); // Meridian, weightBps 729
  await expect(page.getByText("92.7% weight")).toBeVisible(); // Perpl
  const chart = page.getByRole("img", { name: /Funding APR over time: MFI, Meridian and Perpl/ });
  await expect(chart).toBeVisible();
  await page.getByRole("button", { name: "Show table" }).click();
  await expect(page.getByRole("table").filter({ hasText: "Time" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Show chart" }).click();
  await expect(chart).toBeVisible();
});
