// RPC load of one /trade tab against the testnet RPC (read-only):
//   APP_URL=http://localhost:3217 npx playwright test e2e/rpc-load.spec.ts
// Reads are multicalled and batched (app/providers.tsx). Before that, one tab sent ≈ 308 posts in 20 s and the public
// RPC answered 429s (market strip, RPC chip and block stuck on "—"); after: ≈ 125 posts, 0 x 429 (7 Oct 2026).
import { expect, test } from "@playwright/test";

test("one trade tab stays well under the public RPC's per-IP limit", async ({ page }) => {
  let posts = 0;
  let r429 = 0;
  page.on("request", (r) => {
    if (r.url().includes("monad.xyz") && r.method() === "POST") posts++;
  });
  page.on("response", (r) => {
    if (r.url().includes("monad.xyz") && r.status() === 429) r429++;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/trade");
  await page.waitForTimeout(5_000);
  posts = 0;
  r429 = 0;
  await page.waitForTimeout(20_000);
  console.log(`RPC over 20 s: ${posts} HTTP posts, ${r429} x 429`);
  expect(r429).toBe(0);
  expect(posts).toBeLessThan(200);
});
