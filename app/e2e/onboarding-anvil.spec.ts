// K1.4 / K1.5: landing → first filled trade on a phone (390×844), anvil stack, no Privy (dev connector, so sponsorship
// is off and the dev account pays anvil gas). Counts every trusted user click from landing to the fill toast.
// Prereqs: anvil + DeployLocal + SmokeLocal (book liquidity). Use a FRESH dev account (no tAUSD, no deposit), e.g. anvil #7:
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_LOCAL_RPC_URL=<anvil> \
//   NEXT_PUBLIC_DEV_ACCOUNT=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 NEXT_PUBLIC_PRIVY_APP_ID= next dev -p 3131
//   APP_URL=http://localhost:3131 npx playwright test e2e/onboarding-anvil.spec.ts
import { expect, test } from "@playwright/test";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";
const MAX_TAPS = 4;
test.setTimeout(Number(process.env.T ?? 180_000));

test("start trading → test AUSD + deposit → first market fill in ≤ 4 taps", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  // tap counter: trusted clicks only (a script's .click() in the app would not count, a real tap does)
  await page.addInitScript(() => {
    (window as unknown as { __taps: number }).__taps = 0;
    document.addEventListener("click", (e) => e.isTrusted && ((window as unknown as { __taps: number }).__taps += 1), true);
  });
  const taps = () => page.evaluate(() => (window as unknown as { __taps: number }).__taps);

  const t0 = Date.now();
  await page.goto("/trade");
  const ticket = page.locator('[aria-label="Order ticket"]');
  const cta = page.getByTestId("place-order");

  // (1) Start trading → logs in (dev account here; Privy's modal on a Privy build)
  await expect(cta).toHaveText("Start trading");
  await cta.click();
  await expect(cta).toHaveText(/Get 10,000 test AUSD & deposit 1,000/, { timeout: 20_000 });

  // (2) the terms checkbox inline above the CTA (asked once per terms version)
  const tos = ticket.getByRole("checkbox", { name: /accept the terms and risks/ });
  if (await tos.isVisible()) await tos.check();

  // (3) one tap: mint → approve → deposit, one progress sheet
  await cta.click();
  const sheet = page.getByRole("dialog", { name: "Setting up your account" });
  await expect(sheet).toBeVisible();
  for (const step of ["mint", "approve", "deposit"])
    await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute("data-status", /done|skipped/, { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/onboard-sheet-390.png` });
  await expect(sheet).toBeHidden({ timeout: 10_000 }); // closes itself

  // (4) the ticket is prefilled (≈ $50 notional, market): one tap to buy
  await expect(page.getByLabel("Size", { exact: true })).not.toHaveValue("", { timeout: 20_000 });
  await expect(cta).toHaveText(/^Market long$/, { timeout: 20_000 });
  await cta.click();
  await expect(page.getByRole("status").or(page.locator("[aria-live]")).getByText(/market long \d+ lots confirmed in block/).first()).toBeVisible({ timeout: 30_000 });
  const ms = Date.now() - t0;

  const n = await taps();
  console.log(`[K1] taps landing → fill: ${n}; time to first fill: ${(ms / 1000).toFixed(1)} s`);
  expect(n).toBeLessThanOrEqual(MAX_TAPS);
  await expect(page.locator('[data-area="pos"]')).not.toContainText("No open position", { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/onboard-filled-390.png` });
});
