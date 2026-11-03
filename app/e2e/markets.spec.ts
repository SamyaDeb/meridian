// K7: the terminal switches between MON-PERP and ETH-PERP (mock data layer: ETH-PERP = the MON mock on the ETH grid).
//   next dev -p 3141 ; APP_URL=http://localhost:3141 npx playwright test e2e/markets.spec.ts
import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots/widths";
const WIDTHS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];

/** The trade strip's market dropdown: open it, pick a market. */
const pickMarket = async (page: Page, key: string) => {
  await page.getByRole("button", { name: "Market" }).click();
  await page.getByTestId(`menu-market-${key}`).click();
};

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

for (const { w, h } of WIDTHS) {
  test(`switch to ETH-PERP on /trade at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/trade");
    const switcher = page.getByTestId("market-menu");
    await expect(switcher).toBeVisible();
    await expect(page.getByTestId("market-symbol")).toHaveText("MON-PERP");
    await expect(page.getByTestId("mark-price")).toContainText(/0\.0\d{5}/); // MON tick 1e-6

    await pickMarket(page, "eth");
    await expect(page.getByTestId("market-symbol")).toHaveText("ETH-PERP");
    await page.getByRole("button", { name: "Market" }).click();
    await expect(page.getByTestId("menu-market-eth")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).searchParams.get("market")).toBe("eth");
    // ETH price at its own tick (0.10): thousands with one decimal
    await expect(page.getByTestId("mark-price")).toContainText(/\d,\d{3}\.\d(?!\d)/);
    await expect(page.getByTestId("keeper-fed-chip")).toBeVisible();
    // book sizes and the ticket's lot are in ETH
    await expect(page.getByRole("option", { name: "ETH" }).first()).toBeAttached();
    await expect(page.getByText(/lot 0\.001 ETH/).first()).toBeAttached();
    await noHorizontalScroll(page);
    if (path(w)) {
      await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/trade-eth-${w}.png`, fullPage: true, animations: "disabled" });
    }

    // the choice survives a reload; switching back restores MON-PERP and drops the URL parameter
    await page.reload();
    await expect(page.getByTestId("market-symbol")).toHaveText("ETH-PERP");
    await pickMarket(page, "main");
    await expect(page.getByTestId("market-symbol")).toHaveText("MON-PERP");
    expect(new URL(page.url()).searchParams.get("market")).toBeNull();
    await expect(page.getByTestId("mark-price")).toContainText(/0\.0\d{5}/);
  });
}

const path = (w: number) => WIDTHS.some((x) => x.w === w);

test("?market=eth deep link opens ETH-PERP", async ({ page }) => {
  await page.goto("/trade?market=eth");
  await expect(page.getByTestId("market-symbol")).toHaveText("ETH-PERP");
});

test("/rates lists funding per market and says the MFI is MON-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/rates");
  const table = page.getByTestId("markets-table");
  await expect(table).toBeVisible();
  await expect(page.getByTestId("market-row-main")).toContainText("MON-PERP");
  await expect(page.getByTestId("market-row-eth")).toContainText("ETH-PERP");
  await expect(page.getByTestId("market-row-eth")).toContainText("ETH");
  await expect(table).toContainText("MON-PERP only");
  await page.getByTestId("market-eth").click();
  await expect(page.getByText(/The ETH-PERP funding rate/)).toBeVisible();
  await expect(page.getByText(/Meridian Funding Index and the cross-venue chart below are MON-PERP only/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/rates-markets-1440.png`, fullPage: true, animations: "disabled" });
});

test("/stats shows a row per market", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.getByTestId("market-row-main")).toBeVisible();
  await expect(page.getByTestId("market-row-eth")).toBeVisible();
  await noHorizontalScroll(page);
});

test("Earn stays on MON-PERP when ETH-PERP is selected", async ({ page }) => {
  await page.goto("/trade?market=eth");
  await expect(page.getByTestId("market-symbol")).toHaveText("ETH-PERP");
  await page.goto("/earn");
  await expect(page.getByText(/MON/).first()).toBeVisible();
  await expect(page.getByText("ETH-PERP")).toHaveCount(0);
});
