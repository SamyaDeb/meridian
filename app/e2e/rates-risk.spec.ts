// K5 Rates & Risk at 390 / 768 / 1440 with mocked routes: /api/perpl/* answer with the recorded chain reads
// (src/features/rates/fixtures), the indexer is the TEST-ONLY stub (synthetic history), the data source is the mock.
//   node e2e/fixtures/indexer-stub.mjs 8799 &
//   NEXT_PUBLIC_DATA_SOURCE=mock NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:8799 next dev -p 3124
//   APP_URL=http://localhost:3124 npx playwright test e2e/rates-risk.spec.ts
import { expect, test, type Page } from "@playwright/test";
import hedge from "../src/features/rates/fixtures/account-10143-k3-hedge.json" with { type: "json" };
import main1076 from "../src/features/rates/fixtures/account-143-1076.json" with { type: "json" };
import none from "../src/features/rates/fixtures/account-10143-none.json" with { type: "json" };
import mkt10143 from "../src/features/rates/fixtures/market-10143.json" with { type: "json" };
import mkt143 from "../src/features/rates/fixtures/market-143.json" with { type: "json" };

const HEDGE = "0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775";
const M1076 = "0xf27732351024f7D9a9da128311e13bFa183bde8e";

async function mockPerpl(page: Page, opts: { down?: boolean } = {}) {
  await page.route("**/api/perpl/market**", (r) => {
    const chain = new URL(r.request().url()).searchParams.get("chain");
    return r.fulfill({ json: { ...(chain === "143" ? mkt143 : mkt10143).expected, stale: false, readAt: Date.now() } });
  });
  await page.route("**/api/perpl/positions**", (r) => {
    if (opts.down) return r.fulfill({ status: 502, json: { error: "Monad testnet RPC unreachable", rpc: "down" } });
    const u = new URL(r.request().url());
    const a = (u.searchParams.get("address") ?? "").toLowerCase();
    const chain = u.searchParams.get("chain");
    const body = a === HEDGE.toLowerCase() && chain === "10143" ? hedge.expected : a === M1076.toLowerCase() && chain === "143" ? main1076.expected : { ...none.expected, chainId: Number(chain), address: u.searchParams.get("address") };
    return r.fulfill({ json: { ...body, stale: false, readAt: Date.now() } });
  });
}

for (const w of [390, 768, 1440]) {
  test(`rates & risk at ${w}px: funding panel, K3 hedge monitored with Perpl's rule, Meridian risk, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await mockPerpl(page);
    await page.goto(`/rates?perpl=${HEDGE}&chain=10143`);
    await expect(page.getByRole("heading", { name: "Rates & Risk", level: 1 })).toBeVisible();
    // funding panel: Perpl's rate in force and the countdown from the recorded market read
    await expect(page.getByText("Perpl now")).toBeVisible();
    await expect(page.getByText("block 69,159,399")).toBeVisible(); // next Perpl funding = 69,150,828 + 8,571
    // monitor: recorded getPositionV2 of account 969, liquidation price with Perpl's own rule
    await expect(page.getByTestId("perpl-liq")).toHaveText("0.02239", { timeout: 20_000 });
    await expect(page.getByText("Perpl account 969")).toBeVisible();
    await expect(page.getByText("2,600 MON")).toBeVisible();
    await expect(page.getByText("liquidated").first()).toBeVisible(); // the −15 % shock
    // Meridian risk from the stub
    await expect(page.getByRole("list", { name: "User positions by distance to liquidation" })).toBeVisible();
    await expect(page.getByText("Liquidation penalty in")).toBeVisible();
    await expect(page.getByText(/^Local test market/).first()).toBeVisible();
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw).toBeLessThanOrEqual(w);
    await page.waitForTimeout(1500); // lazy charts settle before the capture
    await page.screenshot({ path: `e2e/screenshots/widths/rates-${w}.png`, fullPage: true });
  });
}

test("mainnet account by address: liq 0.018084 at 6 price decimals; shareable URL updates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPerpl(page);
  await page.goto("/rates");
  const monitor = page.locator("section", { has: page.getByRole("heading", { name: "Perpl position monitor" }) });
  await monitor.getByRole("tab", { name: "Mainnet" }).click();
  await page.getByLabel("Perpl wallet address").fill(M1076.toLowerCase());
  await page.getByRole("button", { name: "Monitor" }).click();
  await expect(page.getByTestId("perpl-liq")).toHaveText("0.018084", { timeout: 20_000 });
  await expect(page.getByLabel("Perpl wallet address")).toHaveValue(M1076); // EIP-55
  await expect(page).toHaveURL(new RegExp(`perpl=${M1076}&chain=143`));
});

test("no account on this chain, the other chain has one: says so and offers the switch", async ({ page }) => {
  await mockPerpl(page);
  await page.goto(`/rates?perpl=${M1076}&chain=10143`);
  await expect(page.getByText("No Perpl account on Monad testnet")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Show Monad mainnet" }).click();
  await expect(page.getByTestId("perpl-liq")).toHaveText("0.018084");
});

test("RPC down: the route's own reason, no numbers", async ({ page }) => {
  await mockPerpl(page, { down: true });
  await page.goto(`/rates?perpl=${HEDGE}&chain=10143`);
  await expect(page.getByText(/Monad testnet RPC unreachable/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("perpl-liq")).toHaveCount(0);
});

test("bad address is refused before any read", async ({ page }) => {
  await mockPerpl(page);
  await page.goto("/rates");
  await page.getByLabel("Perpl wallet address").fill("0x1234");
  await expect(page.getByText("Not an EVM address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Monitor" })).toBeDisabled();
});

test("offset on Meridian prefills the ticket on the opposite side and opens /trade (no submit)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPerpl(page);
  await page.goto(`/rates?perpl=${HEDGE}&chain=10143`);
  const btn = page.getByRole("button", { name: "Offset on Meridian" });
  await expect(btn).toBeEnabled({ timeout: 20_000 });
  await btn.click();
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByRole("textbox", { name: /size/i }).first()).not.toHaveValue("");
});
