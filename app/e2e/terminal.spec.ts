// Trade terminal gate: Hyperliquid's layout on desktop (chart, book and order form on the first screen, positions
// below), and the phone layout keeps one column without horizontal scroll.
//   next dev -p 3120 ; APP_URL=http://localhost:3120 npx playwright test e2e/terminal.spec.ts
import { expect, test } from "@playwright/test";

for (const vp of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`Hyperliquid layout at ${vp.width}×${vp.height}: first screen = chart, book, order form; positions peek in`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto("/trade");
    await expect(page.getByTestId("terminal")).toBeVisible();
    await page.waitForTimeout(1500);
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
    const box = async (area: string) => {
      const b = await page.locator(`[data-area="${area}"]`).boundingBox();
      expect(b, area).not.toBeNull();
      expect(b!.x, area).toBeGreaterThanOrEqual(4);
      expect(b!.x + b!.width, area).toBeLessThanOrEqual(vp.width - 4);
      return b!;
    };
    const strip = await box("strip");
    const chart = await box("chart");
    const book = await box("book");
    const ticket = await box("ticket");
    const pos = await box("pos");
    const account = await box("account");
    // market bar over the chart only; the book starts at the top beside it; the order form beside the book
    expect(Math.abs(strip.x - chart.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(book.y - strip.y)).toBeLessThanOrEqual(1);
    expect(book.x).toBeGreaterThan(chart.x + chart.width);
    expect(ticket.x).toBeGreaterThan(book.x + book.width);
    // book, chart and order form end together, inside the first screen; positions start below and peek in
    expect(Math.abs(book.y + book.height - (chart.y + chart.height))).toBeLessThanOrEqual(1);
    expect(chart.y + chart.height).toBeLessThan(vp.height);
    expect(pos.y).toBeLessThan(vp.height - 32);
    // positions span chart + book; the account panel sits under the order form
    expect(pos.x + pos.width).toBeGreaterThanOrEqual(book.x + book.width - 1);
    expect(Math.abs(account.x - ticket.x)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("link", { name: "Terms & risks" }).first()).toBeVisible();
  });
}

test("phone: single column, no horizontal scroll, ticket before book", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");
  await expect(page.getByTestId("terminal")).toBeVisible();
  const ticket = await page.locator('[data-area="ticket"]').boundingBox();
  const book = await page.locator('[data-area="book"]').boundingBox();
  expect(ticket!.y).toBeLessThan(book!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("book: click a level → ticket switches to limit at that price; Trades tab renders", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const ladder = page.getByTestId("book-ladder");
  await expect(ladder).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("spread")).toBeVisible();
  const level = ladder.getByRole("button").first();
  const label = (await level.getAttribute("aria-label")) ?? "";
  const price = /(?:Bid|Ask) ([\d.,]+)/.exec(label)?.[1]?.replace(/,/g, "");
  expect(price).toBeTruthy();
  await level.click();
  await expect(page.getByRole("textbox", { name: "Limit price" })).toHaveValue(price!);
  await page.getByRole("tab", { name: "Trades" }).click();
  await expect(page.getByRole("tab", { name: "Trades" })).toHaveAttribute("aria-selected", "true");
});

test("positions card: every tab renders an honest state (no crash, no fake rows)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const tabs = page.getByRole("tablist", { name: "Account tables" });
  for (const name of ["Positions", "Open orders", "Trade history", "Order history", "Funding", "Liquidations"]) {
    await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
    // disconnected viewer: every tab says so (or needs the indexer) instead of showing rows
    await expect(page.locator('[data-area="pos"]')).toContainText(/Not connected|Needs the indexer|Chain data only/);
  }
  expect(errors).toEqual([]);
});

test("funding tab: the Meridian funding card with links to Earn and Fix", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await page.getByRole("tablist", { name: "Chart view" }).getByRole("tab", { name: "Funding" }).click();
  await expect(page.getByTestId("funding-card-apr")).toHaveText(/[+-]?\d+\.\d{3}%|—/, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Earn the rate →" })).toHaveAttribute("href", "/earn");
  await expect(page.getByRole("link", { name: "Fix the rate →" })).toHaveAttribute("href", "/fix");
  await expect(page.getByTestId("funding-per-day")).toBeVisible();
});

test("resizable panels: keyboard and drag change the book width / bottom row, saved across reloads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  const book = page.getByRole("separator", { name: "Resize order book" });
  const before = (await page.locator('[data-area="book"]').boundingBox())!.width;
  await book.focus();
  await page.keyboard.press("Shift+ArrowLeft"); // book grows by 64 px
  await expect.poll(async () => (await page.locator('[data-area="book"]').boundingBox())!.width).toBeGreaterThan(before + 50);
  const pos = page.getByRole("separator", { name: "Resize positions panel" });
  const hb = (await page.locator('[data-area="pos"]').boundingBox())!.height;
  const s = (await pos.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2, s.y - 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('[data-area="pos"]').boundingBox())!.height).toBeGreaterThan(hb + 40);
  const now = (await page.locator('[data-area="book"]').boundingBox())!.width;
  await page.reload();
  await expect.poll(async () => (await page.locator('[data-area="book"]').boundingBox())!.width).toBeCloseTo(now, 0);
  // the page scrolls vertically (Hyperliquid), never sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("reset terminal");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.locator('[data-area="book"]').boundingBox())!.width).toBeCloseTo(before, 0);
});
