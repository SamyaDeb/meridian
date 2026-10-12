// W1 on a local chain: a passkey wallet (Chromium virtual authenticator, PRF on) signs real transactions: test AUSD
// mint → approve → deposit → market long, every tx signed locally by the Mera session and sent raw.
// Prereqs: anvil + DeployLocal + SmokeLocal (book liquidity); app on anvil with the passkey wallet, no Privy, no dev account:
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_LOCAL_RPC_URL=http://127.0.0.1:8545 \
//   NEXT_PUBLIC_MERA_RP_ID=localhost NEXT_PUBLIC_PRIVY_APP_ID= next dev -p 3131
//   APP_URL=http://localhost:3131 npx playwright test e2e/passkey-anvil.spec.ts
import { expect, test } from "@playwright/test";

const ANVIL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result: unknown }).result;
};

test("passkey wallet: test AUSD + deposit + market long on anvil, signed by the passkey session", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  await page.goto("/trade");
  await page.getByRole("button", { name: "Passkey wallet" }).click();
  await page.getByRole("button", { name: "Create a passkey wallet" }).click();
  await page.getByRole("button", { name: "Account" }).click();
  const address = (await page.locator("p.num.break-all").first().innerText()).trim();
  await expect(page.getByText("Passkey wallet · pays its own gas in MON")).toBeVisible();
  await page.keyboard.press("Escape");

  // a fresh passkey wallet has no gas: fund it like a user topping up MON
  await rpc("anvil_setBalance", [address, "0x8AC7230489E80000"]); // 10 native

  const ticket = page.locator('[aria-label="Order ticket"]');
  const cta = page.getByTestId("place-order");
  await expect(cta).toHaveText(/Get 10,000 test AUSD & deposit 1,000/, { timeout: 30_000 });
  const tos = ticket.getByRole("checkbox", { name: /accept the terms and risks/ });
  if (await tos.isVisible()) await tos.check();
  await cta.click();
  const sheet = page.getByRole("dialog", { name: "Setting up your account" });
  for (const step of ["mint", "approve", "deposit"])
    await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute("data-status", /done|skipped/, { timeout: 60_000 });
  await expect(sheet).toBeHidden({ timeout: 10_000 });

  await expect(page.getByLabel("Size", { exact: true })).not.toHaveValue("", { timeout: 20_000 });
  await expect(cta).toHaveText(/^Market long$/, { timeout: 20_000 });
  await cta.click();
  await expect(page.getByRole("status").or(page.locator("[aria-live]")).getByText(/market long \d+ lots confirmed in block/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-area="pos"]')).not.toContainText("No open position", { timeout: 20_000 });

  // the passkey address itself sent the transactions (nonce moved, gas paid from its own balance)
  const nonce = Number(await rpc("eth_getTransactionCount", [address, "latest"]));
  expect(nonce).toBeGreaterThanOrEqual(3);
  expect(BigInt((await rpc("eth_getBalance", [address, "latest"])) as string)).toBeLessThan(10n ** 19n);
  console.log(`[W1] passkey wallet ${address}: ${nonce} txs signed locally and confirmed on anvil`);
});
