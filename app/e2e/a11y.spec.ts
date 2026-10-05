// axe-core scan (WCAG 2.x A/AA) of every route at phone and desktop width. Gate: 0 serious / critical violations.
//   next dev -p 3120 ; APP_URL=http://localhost:3120 npx playwright test e2e/a11y.spec.ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = (process.env.PAGES ?? "/trade,/positions,/earn,/fix,/stats,/terms,/design").split(",");

for (const width of [390, 1440]) {
  for (const path of PAGES) {
    test(`axe ${path} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1500);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("nextjs-portal").analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      if (bad.length) console.log(JSON.stringify(bad.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })), null, 1));
      expect(bad).toEqual([]);
    });
  }
}
