// K1.5 Privy path on Monad Testnet (10143): email login (Privy Dashboard TEST ACCOUNT) → embedded wallet → sponsored
// mint / approve / deposit → first market fill, with the embedded wallet holding 0 MON before and after.
// Can't run in CI (real Privy + testnet). Skipped unless E2E_PRIVY=1. Credentials come from the environment (load them
// from a local, uncommitted file), never from this repo:
//   E2E_PRIVY=1 PRIVY_TEST_EMAIL=… PRIVY_TEST_OTP=… APP_URL=http://localhost:3000 npx playwright test e2e/onboarding-privy.spec.ts
// The app must be a Privy build (NEXT_PUBLIC_PRIVY_APP_ID set, NEXT_PUBLIC_CHAIN_ID=10143) on an origin allowed in the Dashboard.
// A test account is one fixed user: after its first run the wallet already holds AUSD and a deposit, so the flow skips
// the steps that are done (idempotent resume) and the tap count is only meaningful on the first run.
import { expect, test } from "@playwright/test";
import { createPublicClient, http, type Address } from "viem";
import { monadTestnet } from "viem/chains";

const ON = process.env.E2E_PRIVY === "1";
const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";
test.skip(!ON, "Privy e2e runs only with E2E_PRIVY=1 (real Privy + Monad Testnet)");
test.setTimeout(240_000);

test("Privy email → sponsored onboarding → first fill with 0 MON", async ({ page }) => {
  const email = process.env.PRIVY_TEST_EMAIL!;
  const otp = process.env.PRIVY_TEST_OTP!;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL) });
  await page.addInitScript(() => {
    (window as unknown as { __taps: number }).__taps = 0;
    document.addEventListener("click", (e) => e.isTrusted && ((window as unknown as { __taps: number }).__taps += 1), true);
  });

  const t0 = Date.now();
  await page.goto("/trade");
  const cta = page.getByTestId("place-order");
  await expect(cta).toHaveText("Start trading", { timeout: 30_000 });
  await cta.click();

  // Privy's modal (its own DOM: > VERIFY these selectors against the installed SDK if Privy changes the modal)
  await page.getByPlaceholder(/email/i).fill(email);
  await page.getByRole("button", { name: /submit/i }).click();
  await page.waitForTimeout(1_500);
  await page.keyboard.type(otp, { delay: 80 }); // the code inputs take focus and submit themselves

  // embedded wallet ready: the account pill shows its address
  const pill = page.getByRole("button", { name: "Account" });
  await expect(pill).toBeVisible({ timeout: 60_000 });
  await pill.click();
  const address = ((await page.locator("p.num.break-all").first().textContent()) ?? "").trim() as Address;
  await page.keyboard.press("Escape");
  const monBefore = await pub.getBalance({ address });
  console.log(`[K1 privy] wallet ${address} MON before: ${monBefore}`);

  if (await cta.textContent().then((t) => /test AUSD/.test(t ?? ""))) {
    const tos = page.getByRole("checkbox", { name: /accept the terms and risks/ });
    if (await tos.isVisible()) await tos.check();
    await cta.click();
    const sheet = page.getByRole("dialog", { name: "Setting up your account" });
    for (const step of ["mint", "approve", "deposit"])
      await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute("data-status", /done|skipped/, { timeout: 90_000 });
    const links = await sheet.getByRole("link", { name: /View transaction/ }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    console.log(`[K1 privy] onboarding txs: ${links.join(" ")}`);
    await page.screenshot({ path: `${SHOTS}/privy-onboard-sheet.png` });
    await expect(sheet).toBeHidden({ timeout: 15_000 });
  }

  await expect(page.getByLabel("Size", { exact: true })).not.toHaveValue("", { timeout: 20_000 });
  await expect(cta).toHaveText(/^Market (long|short)$/, { timeout: 30_000 });
  await cta.click();
  await expect(page.getByText(/market (long|short) \d+ lots confirmed in block/).first()).toBeVisible({ timeout: 60_000 });
  const ms = Date.now() - t0;
  const taps = await page.evaluate(() => (window as unknown as { __taps: number }).__taps);
  const monAfter = await pub.getBalance({ address });
  console.log(`[K1 privy] taps ${taps} (Privy modal clicks included); time to first fill ${(ms / 1000).toFixed(1)} s; MON after: ${monAfter}`);
  await page.screenshot({ path: `${SHOTS}/privy-filled.png` });
  expect(monBefore).toBe(0n);
  expect(monAfter).toBe(0n);
});
