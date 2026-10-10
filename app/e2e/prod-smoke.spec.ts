// K6 B4: smoke the PUBLIC production app before testers and judges open it. Opt-in: runs only with APP_URL set to a
// deployed URL (never the local default). Read-only: it opens pages, it never logs in or signs anything.
//   APP_URL=https://<production domain> npx playwright test e2e/prod-smoke.spec.ts
// Checks: /api/health says the required settings are present; each screen renders chain data (no "mock data" chip),
// has no console errors, and the Privy "Log in" button is there.
import { expect, test, type Locator, type Page } from "@playwright/test";

const APP_URL = process.env.APP_URL;
test.skip(!APP_URL || /localhost|127\.0\.0\.1/.test(APP_URL), "set APP_URL to the deployed production URL");

test("production settings are present (booleans only)", async ({ request }) => {
  const r = await request.get("/api/health");
  expect(r.status(), "is the deployment public? (Vercel Authentication answers 401)").toBe(200);
  const h = (await r.json()) as { ready: boolean; required: Record<string, boolean>; unsafe: Record<string, boolean> };
  console.log(`[prod-smoke] health ${JSON.stringify(h)}`);
  expect(h.required, "required settings").toEqual(Object.fromEntries(Object.keys(h.required).map((k) => [k, true])));
  expect(h.unsafe.devAccountSet).toBe(false);
  expect(h.ready).toBe(true);
});

// ready = the page's own h1 (trade has none: its order ticket); main and #3 (Rates & risk) headings
const SCREENS: { path: string; ready: (p: Page) => Locator }[] = [
  { path: "/trade", ready: (p) => p.locator('[aria-label="Order ticket"]').first() },
  { path: "/rates", ready: (p) => p.getByRole("heading", { level: 1, name: /Rates/ }) },
  { path: "/earn", ready: (p) => p.getByRole("heading", { level: 1, name: "Earn the basis" }) },
  { path: "/fix", ready: (p) => p.getByRole("heading", { level: 1, name: "Fix your funding" }) },
  { path: "/stats", ready: (p) => p.getByRole("heading", { level: 1, name: "Stats" }) },
];

for (const s of SCREENS) {
  test(`${s.path} renders chain data with no console errors and a Privy login`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
    // which service failed: host only (an RPC URL can carry a key in its path)
    page.on("response", (r) => r.status() >= 429 && errors.push(`HTTP ${r.status()} from ${new URL(r.url()).host}`));
    const res = await page.goto(s.path);
    expect(res?.status(), "Vercel Authentication or a 404").toBe(200);
    await expect(s.ready(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("mock data", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log in" }).first()).toBeVisible({ timeout: 20_000 });
    if (s.path === "/stats") await expect(page.getByTestId("metrics-block")).toContainText(/As of block #\d+/, { timeout: 30_000 });
    await page.waitForTimeout(3_000); // let the first polls land
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
