// Layout screenshots at phone / tablet / desktop widths (FRONTEND_TRADE_PLAN F0–F5 gates). Read-only, mock data layer:
//   next dev -p 3120 ; APP_URL=http://localhost:3120 SHOTS_DIR=e2e/screenshots/widths/<label> npx playwright test e2e/widths.spec.ts
// Each page also asserts no horizontal page scroll at every width.
import { expect, test } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots/widths";
const PAGES = (process.env.PAGES ?? "/trade,/positions,/earn,/fix,/stats,/rates,/terms").split(",");
const WIDTHS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];

for (const { w, h } of WIDTHS) {
  for (const path of PAGES) {
    test(`${path} at ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(path);
      await page.waitForLoadState("load");
      // a live indexer answers slower than the mock: shoot the chart once its data is applied (engine signal)
      if (path === "/trade") await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await page.waitForTimeout(1500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const name = path === "/" ? "home" : path.slice(1).replaceAll("/", "-");
      await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true, animations: "disabled" });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}
