// F4.1 drawing layer on the chart (stub indexer for candles; see chart.spec.ts for the setup).
import { expect, test, type Page } from "@playwright/test";

async function pick(page: Page, tool: string) {
  await page.getByRole("button", { name: "Drawing tools" }).click();
  await page.getByRole("button", { name: tool, exact: true }).click();
}
async function clickAt(page: Page, fx: number, fy: number) {
  const b = (await page.getByTestId("drawing-layer").boundingBox())!;
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
}
const count = (page: Page) => page.getByTestId("drawing-layer").getAttribute("aria-label");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await expect(page.getByTestId("history-start")).toContainText("History starts at", { timeout: 20_000 });
  await expect(page.getByTestId("chart-engine")).toHaveAttribute("data-ready", "true"); // data applied (next frame)
});

test("place hline, trend, rect, fib, ruler, position plans; persist; erase; lock", async ({ page }) => {
  // magnet off so a click lands exactly where it was made (erase hits the same screen point)
  await page.getByRole("button", { name: "Magnet: snap to OHLC" }).click();
  await pick(page, "Horizontal line");
  await clickAt(page, 0.5, 0.5);
  await expect.poll(() => count(page)).toBe("1 drawing on the chart");
  // erase right away, at the line's own position (before any rescale)
  await page.getByRole("button", { name: /^Erase/ }).click();
  await clickAt(page, 0.5, 0.5);
  await expect.poll(() => count(page)).toBe("0 drawings on the chart");

  await pick(page, "Horizontal line");
  await clickAt(page, 0.5, 0.5);
  for (const tool of ["Trend line", "Ray", "Rectangle", "Fibonacci retracement", "Ruler"]) {
    await pick(page, tool);
    await clickAt(page, 0.3, 0.3);
    await clickAt(page, 0.6, 0.6);
  }
  await expect.poll(() => count(page)).toBe("6 drawings on the chart");
  await expect(page.getByTestId("drawing-layer")).toContainText("61.8%");
  await expect(page.getByTestId("drawing-layer")).toContainText("bars"); // ruler label

  await pick(page, "Long position (plan)");
  await clickAt(page, 0.4, 0.5); // entry
  await clickAt(page, 0.5, 0.3); // target above
  await clickAt(page, 0.5, 0.7); // stop below
  await expect(page.getByTestId("drawing-layer")).toContainText("Long plan · not an order · R:R");

  await page.reload();
  await expect.poll(() => count(page), { timeout: 20_000 }).toBe("7 drawings on the chart");

  // lock blocks erase and clear; unlock and clear all
  await page.getByRole("button", { name: "Lock drawings" }).click();
  await expect(page.getByRole("button", { name: "Clear all drawings" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Erase/ })).toBeDisabled();
  await page.getByRole("button", { name: "Lock drawings" }).click();
  await page.getByRole("button", { name: "Clear all drawings" }).click();
  await expect.poll(() => count(page)).toBe("0 drawings on the chart");
});

test("brush drag draws a path; magnet toggles", async ({ page }) => {
  await pick(page, "Brush");
  const b = (await page.getByTestId("drawing-layer").boundingBox())!;
  await page.mouse.move(b.x + 100, b.y + 100);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + 100 + i * 10, b.y + 100 + (i % 3) * 8);
  await page.mouse.up();
  await expect.poll(() => count(page)).toBe("1 drawing on the chart");
  const magnet = page.getByRole("button", { name: "Magnet: snap to OHLC" });
  await expect(magnet).toHaveAttribute("aria-pressed", "true");
  await magnet.click();
  await expect(magnet).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Clear all drawings" }).click();
});

test("text label and vertical line", async ({ page }) => {
  page.once("dialog", (d) => void d.accept("breakout"));
  await pick(page, "Text");
  await clickAt(page, 0.4, 0.4);
  await expect(page.getByTestId("drawing-layer")).toContainText("breakout");
  await pick(page, "Vertical line");
  await clickAt(page, 0.7, 0.5);
  await expect.poll(() => count(page)).toBe("2 drawings on the chart");
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/screenshots"}/drawings.png` });
  await page.getByRole("button", { name: "Clear all drawings" }).click();
});
