// F1 gate: navbar at three widths, active-route highlight, block counter live → stale when reads stop.
//   next dev -p 3120 ; APP_URL=http://localhost:3120 npx playwright test e2e/nav.spec.ts
// Works on the mock layer and on chain mode (testnet RPC): "reads stop" = every non-app request is aborted.
import { expect, test } from "@playwright/test";

const PAGES = ["Trade", "Positions", "Earn", "Fix", "Rates", "Stats"] as const;

test("desktop: pill nav highlights the active route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  for (const label of PAGES) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${label.toLowerCase()}$`));
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
  await expect(page.locator("nav.fixed")).toBeHidden(); // bottom tabs hidden ≥ 1024 px
});

test("phone: compact bar, bottom tabs carry navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/earn");
  await expect(page.locator("header nav")).toBeHidden();
  const tabs = page.locator("nav.fixed");
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Earn" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Meridian home" })).toBeVisible();
});

test("tablet: bar fits, no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/trade");
  await expect(page.getByTestId("block-counter")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("block counter goes live, then stale when the data source stops", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const counter = page.getByTestId("block-counter");
  await expect(counter).toHaveAttribute("data-state", "live", { timeout: 30_000 });
  const origin = new URL(page.url()).origin;
  await page.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  // the mock layer advances its head in-process, so "reads stop" only exists in chain mode
  test.skip(await page.getByText("mock data").isVisible(), "mock layer: no network reads to stop");
  await expect(counter).toHaveAttribute("data-state", "stale", { timeout: 15_000 });
  await expect(counter).toContainText("stale");
});
