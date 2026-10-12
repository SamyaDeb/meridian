// Perpl's MON perp as a view-only market in the trade strip's dropdown, against a running app with the flag on:
//   NEXT_PUBLIC_PERPL_REFERENCE=1 next dev -p 3217 ; APP_URL=http://localhost:3217 npx playwright test e2e/perpl-ref.spec.ts
// Reads Perpl's public mainnet API through our routes. Asserts the venue label is shown with the data, that the Perpl
// book has no clickable level, and shoots both views at desktop and phone widths.
import { expect, test } from "@playwright/test";

// BROWSER=webkit runs it in Safari's engine (npx playwright install webkit once).
test.use({ browserName: process.env.BROWSER === "webkit" ? "webkit" : "chromium" });
const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots/widths/perpl-ref";
const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
];

for (const { w, h } of WIDTHS) {
  test(`Perpl market (dropdown): its chart + book, labelled, at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/trade");
    await expect(page.getByRole("region", { name: "Market" })).toContainText(/(Index|Oracle)\s*0\.\d+/, { timeout: 30_000 });

    // Meridian's own market has no separate Perpl chart source or book tab
    await page.getByRole("button", { name: "Price source" }).click();
    await expect(page.getByRole("menuitemradio", { name: /Perpl/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "Perpl", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Market" }).click();
    const perpl = page.getByTestId("menu-market-perpl");
    test.skip((await perpl.count()) === 0, "NEXT_PUBLIC_PERPL_REFERENCE is off");
    await perpl.click();
    await expect(page.getByTestId("reference-label")).toHaveText("Perpl MON-PERP · Monad mainnet · reference, not Meridian trades");
    await expect(page.getByTestId("ohlc-legend")).toContainText("Perpl MON-PERP · Monad mainnet", { timeout: 20_000 });
    await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await page.getByRole("region", { name: "Price chart" }).screenshot({ path: `${SHOTS}/chart-${w}.png`, animations: "disabled" });

    // book: Perpl's, read-only, nothing clickable
    await expect(page.getByTestId("perpl-book-label")).toHaveText("Perpl MON-PERP · Monad mainnet · read-only, can't be traded here");
    const book = page.getByTestId("perpl-book");
    await expect(book).toBeVisible({ timeout: 20_000 });
    await expect(book.locator("button")).toHaveCount(0);
    await expect(book.getByRole("list", { name: "Perpl bids" }).locator("li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/trade-${w}.png`, fullPage: true, animations: "disabled" });

    // back to Meridian's market: the outside labels go
    await page.getByRole("button", { name: "Market" }).click();
    await page.getByTestId("menu-market-main").click();
    await expect(page.getByTestId("perpl-book-label")).toHaveCount(0);
    await expect(page.getByTestId("reference-label")).toHaveCount(0);
  });
}

test("an empty Meridian chart offers Perpl's market in one click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const show = page.getByTestId("show-perpl");
  const offered = await show.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
  test.skip(!offered, "Meridian's chart has data, or the flag is off");
  await show.click();
  expect(new URL(page.url()).searchParams.get("venue")).toBe("perpl");
  await expect(page.getByTestId("perpl-view-only")).toBeVisible();
  await expect(page.getByTestId("ohlc-legend")).toContainText("Perpl MON-PERP · Monad mainnet", { timeout: 20_000 });
});

test("market dropdown opens Perpl as a view-only venue and goes back to Meridian", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await expect(page.getByRole("region", { name: "Market" })).toContainText(/(Index|Oracle)\s*0\.\d+/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Market" }).click();
  const perpl = page.getByTestId("menu-market-perpl");
  test.skip((await perpl.count()) === 0, "NEXT_PUBLIC_PERPL_REFERENCE is off");
  await perpl.click();
  expect(new URL(page.url()).searchParams.get("venue")).toBe("perpl");
  // strip, chart, book and ticket all say it's Perpl, view only
  await expect(page.getByTestId("perpl-venue-chip")).toContainText("view only");
  await expect(page.getByTestId("perpl-strip")).toContainText(/Last\s*0\.\d+/, { timeout: 20_000 });
  await expect(page.getByTestId("reference-label")).toHaveText("Perpl MON-PERP · Monad mainnet · reference, not Meridian trades");
  await expect(page.getByTestId("perpl-book-label")).toBeVisible();
  await expect(page.getByTestId("perpl-view-only")).toBeVisible();
  await expect(page.getByRole("button", { name: /Buy \/ Long/ })).toHaveCount(0);
  // the market bar keeps its height (a deep Perpl book scrolls inside its card)
  expect((await page.locator('[data-area="strip"]').boundingBox())!.height).toBeLessThan(90);
  await page.screenshot({ path: `${SHOTS}/perpl-venue-1440.png`, animations: "disabled" });

  // a deep link opens it directly; "Trade MON-PERP on Meridian" goes back
  await page.goto("/trade?venue=perpl");
  await expect(page.getByTestId("perpl-view-only")).toBeVisible();
  await page.getByTestId("back-to-meridian").click();
  await expect(page.getByTestId("mark-price")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("venue")).toBeNull();
});
