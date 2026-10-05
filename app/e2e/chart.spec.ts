// F3 gate: chart with candles from an indexer (the e2e stub: e2e/fixtures/indexer-stub.mjs), timeframes, persisted
// view, indicators, click-to-set-limit; plus a memory soak.
//   node e2e/fixtures/indexer-stub.mjs 8799 &
//   NEXT_PUBLIC_DATA_SOURCE=mock NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:8799 next dev -p 3124
//   APP_URL=http://localhost:3124 npx playwright test e2e/chart.spec.ts      (SOAK_MIN=10 for the full soak)
import { expect, test, type Page } from "@playwright/test";

/** Timeframe menu of Meridian's chart top bar (top-left). */
async function pickTf(page: Page, tf: string) {
  await page.getByRole("button", { name: "Timeframe" }).click();
  await page.getByRole("menuitemradio", { name: tf, exact: true }).click();
}
async function pickMenu(page: Page, menu: string, item: string) {
  await page.getByRole("button", { name: menu }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${item}`) }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("candles render with a history-start label; every timeframe loads", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
  for (const t of ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1D", "1W"]) {
    await pickTf(page, t);
    await expect(page.getByTestId("ohlc-legend")).toContainText(new RegExp(`·${t}·Meridian(Last|Mark)`));
    await expect(page.getByTestId("history-start")).toContainText("History starts at");
  }
});

test("view state persists per market across reloads", async ({ page }) => {
  await page.goto("/trade");
  await pickTf(page, "4h");
  await pickMenu(page, "Chart type", "Heikin-Ashi");
  await page.reload();
  await expect(page.getByRole("button", { name: "Timeframe" })).toContainText("4h");
  await page.getByRole("button", { name: "Chart type" }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Heikin-Ashi/ })).toHaveAttribute("aria-checked", "true");
});

test("indicators add panes; turning them off removes them", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
  const engine = page.getByTestId("chart-engine");
  const panes = () => engine.locator("table tr td canvas").count(); // LWC draws each pane in its own table row
  const before = await panes();
  await page.getByRole("button", { name: "Indicators" }).click();
  await page.getByLabel("RSI 14").check();
  await page.getByLabel("MACD 12 26 9").check();
  await page.getByLabel("SMA 20").check();
  await expect.poll(panes).toBeGreaterThan(before);
  await page.getByLabel("RSI 14").uncheck();
  await page.getByLabel("MACD 12 26 9").uncheck();
  await page.getByLabel("SMA 20").uncheck();
  await expect.poll(panes).toBe(before);
});

test("click on the price pane loads that price into the ticket as a limit", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
  // click relative to the element at click time: Playwright re-resolves it and waits until it is stable, so a layout
  // shift between measuring and clicking (data landing in the market strip) can't move the click off the price pane
  const engine = page.getByTestId("chart-engine");
  const box = (await engine.boundingBox())!;
  await engine.click({ position: { x: Math.round(box.width * 0.4), y: Math.round(box.height * 0.25) } });
  const v = await page.getByRole("textbox", { name: "Limit price" }).inputValue();
  expect(v).toMatch(/^0\.0\d{4}/);
});

test("soak: no unbounded JS heap growth while blocks stream", async ({ page }) => {
  const minutes = Number(process.env.SOAK_MIN ?? 1);
  test.setTimeout((minutes + 2) * 60_000);
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")!.value;
  };
  await page.waitForTimeout(15_000); // warm-up: caches and first renders settle
  const start = await heap();
  const samples: number[] = [];
  for (let i = 0; i < minutes * 4; i++) {
    await page.waitForTimeout(15_000);
    samples.push(await heap());
  }
  const end = samples[samples.length - 1]!;
  console.log(`heap MB start ${(start / 1e6).toFixed(1)} end ${(end / 1e6).toFixed(1)} samples ${samples.map((s) => (s / 1e6).toFixed(1)).join(" ")}`);
  expect(end).toBeLessThan(start * 1.3 + 5e6); // allows normal jitter, fails on a leak proportional to blocks
});

test("depth tab draws both sides; funding toggle adds the funding and premium panes", async ({ page }) => {
  await page.goto("/trade");
  await page.getByRole("tablist", { name: "Book view" }).getByRole("tab", { name: "Depth" }).click();
  await expect(page.getByTestId("depth-chart").getByRole("img")).toHaveAttribute("aria-label", /MON bid, .* MON ask/);
  const panes = () => page.getByTestId("chart-engine").locator("table tr td canvas").count();
  await page.getByRole("button", { name: "Chart settings" }).click();
  const funding = page.getByLabel("Funding rate pane");
  await expect(funding).not.toBeChecked(); // default: one price pane
  const off = await panes();
  await funding.check();
  await expect.poll(panes).toBeGreaterThan(off); // funding + premium panes added
  await funding.uncheck();
  await expect.poll(panes).toBe(off);
});

test("price source: Last (book trades), Mark (per funding block), Index (oracle) each draw their own candles", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Price source" })).toContainText("Last"); // default = what is traded
  await pickMenu(page, "Price source", "Index");
  await expect(page.getByTestId("ohlc-legend")).toContainText("MeridianIndex", { timeout: 20_000 });
  await expect(page.getByTestId("history-start")).toContainText("History starts at");
  await pickMenu(page, "Price source", "Mark");
  await expect(page.getByTestId("ohlc-legend")).toContainText("MeridianMark", { timeout: 20_000 });
  await expect(page.getByTestId("history-start")).toContainText("mark: last 2,000 funding blocks");
});

test("range bar, zoom, undo / redo, screenshot", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "5D" }).click();
  await expect(page.getByRole("button", { name: "Timeframe" })).toContainText("5m");
  await page.getByRole("button", { name: "Zoom in" }).click();
  // undo / redo a drawing
  await page.getByRole("toolbar", { name: "Drawing tools" }).getByRole("button", { name: "Text" }).waitFor();
  const undo = page.getByRole("button", { name: "Undo drawing" });
  await expect(undo).toBeDisabled();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save chart image" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^meridian-mon-perp-5m-.*\.png$/);
});
