// The labelled Perpl reference (chart source + read-only book tab) against a running app with the flag on:
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
  test(`Perpl reference chart + book at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/trade");
    await page.waitForLoadState("load");
    // the chart keeps its view per market address: choose the source only once the market has loaded
    await expect(page.getByRole("region", { name: "Market" })).toContainText(/Index\s*0\.\d+/, { timeout: 30_000 });

    // chart: pick the Perpl source from the price-source menu
    await page.getByRole("button", { name: "Price source" }).click();
    const option = page.getByRole("menuitemradio", { name: /Perpl MON-PERP \(ref\)/ });
    test.skip((await option.count()) === 0, "NEXT_PUBLIC_PERPL_REFERENCE is off");
    await option.click();
    await expect(page.getByTestId("reference-label")).toHaveText("Perpl MON-PERP · Monad mainnet · reference, not Meridian trades");
    await expect(page.getByTestId("ohlc-legend")).toContainText("Perpl MON-PERP · Monad mainnet", { timeout: 20_000 });
    await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const chart = page.getByRole("region", { name: "Price chart" });
    await chart.screenshot({ path: `${SHOTS}/chart-${w}.png`, animations: "disabled" });

    // book: the read-only Perpl tab
    const tab = page.getByRole("tab", { name: "Perpl", exact: true });
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(page.getByTestId("perpl-book-label")).toHaveText("Perpl MON-PERP · Monad mainnet · read-only, can't be traded here");
    const book = page.getByTestId("perpl-book");
    await expect(book).toBeVisible({ timeout: 20_000 });
    await expect(book.locator("button")).toHaveCount(0);
    await expect(book.getByRole("list", { name: "Perpl bids" }).locator("li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/trade-${w}.png`, fullPage: true, animations: "disabled" });

    // switching back to Meridian's own book and source removes the outside labels
    await page.getByRole("tab", { name: "Book", exact: true }).click();
    await expect(page.getByTestId("perpl-book-label")).toHaveCount(0);
    await page.getByRole("button", { name: "Price source" }).click();
    await page.getByRole("menuitemradio", { name: /^Last/ }).click();
    await expect(page.getByTestId("reference-label")).toHaveCount(0);
  });
}

test("an empty Meridian chart offers Perpl in one click, and an early choice survives the market loading", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const show = page.getByTestId("show-perpl");
  const offered = await show.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
  test.skip(!offered, "Meridian's chart has data, or the flag is off");
  await show.click();
  await expect(page.getByTestId("ohlc-legend")).toContainText("Perpl MON-PERP · Monad mainnet", { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Market" })).toContainText(/Index\s*0\.\d+/, { timeout: 30_000 });
  await page.waitForTimeout(2_000); // after the market's address arrived, the source is still Perpl
  await expect(page.getByTestId("reference-label")).toHaveText("Perpl MON-PERP · Monad mainnet · reference, not Meridian trades");
  await page.screenshot({ path: `${SHOTS}/one-click-1440.png`, animations: "disabled" });
});
