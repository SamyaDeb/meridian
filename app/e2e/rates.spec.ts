// F5.6 Rates & risk with the TEST-ONLY indexer stub (see chart.spec.ts for the setup).
import { expect, test } from "@playwright/test";

test("rates: oracle APR cards, MFI honest empty state, liquidation-distance histogram, insurance fund", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: "Rates & risk" })).toBeVisible();
  await expect(page.getByText("Not published yet")).toBeVisible(); // MFI never simulated
  const hist = page.getByRole("list", { name: "Positions by distance to liquidation" });
  await expect(hist).toBeVisible({ timeout: 20_000 });
  const counts = await hist.locator("li .num").allTextContents();
  const total = counts.reduce((s, t) => s + Number(t.split("·")[0]!.trim()), 0);
  expect(total).toBe(24); // every stub position lands in exactly one bucket
  await expect(page.getByText("1,000.00 AUSD")).toBeVisible(); // insurance funded
});
