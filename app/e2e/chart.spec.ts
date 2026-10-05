// F3 gate: chart with candles from an indexer (the e2e stub: e2e/fixtures/indexer-stub.mjs), timeframes, persisted
// view, indicators, click-to-set-limit; plus a memory soak.
//   node e2e/fixtures/indexer-stub.mjs 8799 &
//   NEXT_PUBLIC_DATA_SOURCE=mock NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:8799 next dev -p 3124
//   APP_URL=http://localhost:3124 npx playwright test e2e/chart.spec.ts      (SOAK_MIN=10 for the full soak)
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("candles render with a history-start label; every timeframe loads", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
  const tf = page.getByRole("tablist", { name: "Timeframe" });
  for (const t of ["1m", "5m", "15m", "1h", "4h", "1D"]) {
    await tf.getByRole("tab", { name: t, exact: true }).click();
    await expect(page.getByTestId("history-start")).toContainText("History starts at");
  }
});

test("view state persists per market across reloads", async ({ page }) => {
  await page.goto("/trade");
  await page.getByRole("tablist", { name: "Timeframe" }).getByRole("tab", { name: "4h" }).click();
  await page.getByLabel("Chart type").selectOption("heikin");
  await page.reload();
  await expect(page.getByRole("tablist", { name: "Timeframe" }).getByRole("tab", { name: "4h" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Chart type")).toHaveValue("heikin");
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
  const funding = page.getByRole("button", { name: "Funding rate pane" });
  await expect(funding).toHaveAttribute("aria-pressed", "true"); // default view
  const on = await panes();
  await funding.click();
  await expect.poll(panes).toBeLessThan(on); // funding + premium panes removed
  await funding.click();
  await expect.poll(panes).toBe(on);
});
