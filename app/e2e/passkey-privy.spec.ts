// W1 next to Privy: in a Privy build (@privy-io/wagmi replaces wagmi's connector list whenever Privy's wallets change)
// the passkey wallet must connect, stay connected after Privy finishes loading, and send its own (unsponsored) txs.
// Prereqs: anvil + DeployLocal + SmokeLocal; a Privy app ID that allows localhost:
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_LOCAL_RPC_URL=http://127.0.0.1:8545 \
//   NEXT_PUBLIC_MERA_RP_ID=localhost NEXT_PUBLIC_PRIVY_APP_ID=<id> next dev -p 3132
//   APP_URL=http://localhost:3132 npx playwright test e2e/passkey-privy.spec.ts
import { expect, test } from "@playwright/test";

const ANVIL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result: unknown }).result;
};

test("passkey wallet inside a Privy build: connects, survives Privy's wallet sync, sends its own txs", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.goto("/trade");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible({ timeout: 30_000 }); // Privy ready
  await page.getByRole("button", { name: "Passkey wallet" }).click();
  await page.getByRole("button", { name: "Create a passkey wallet" }).click();
  const account = page.getByRole("button", { name: "Account" });
  await expect(account).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(8_000); // let Privy's sync effects run
  await expect(account).toBeVisible();
  await account.click();
  const address = (await page.locator("p.num.break-all").first().innerText()).trim();
  await expect(page.getByText("Passkey wallet · pays its own gas in MON")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show recovery phrase" })).toBeVisible();
  await page.keyboard.press("Escape");

  await rpc("anvil_setBalance", [address, "0x8AC7230489E80000"]);
  const cta = page.getByTestId("place-order");
  await expect(cta).toHaveText(/Get 10,000 test AUSD & deposit 1,000/, { timeout: 30_000 });
  const tos = page.locator('[aria-label="Order ticket"]').getByRole("checkbox", { name: /accept the terms and risks/ });
  if (await tos.isVisible()) await tos.check();
  await cta.click();
  const sheet = page.getByRole("dialog", { name: "Setting up your account" });
  for (const step of ["mint", "approve", "deposit"])
    await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute("data-status", /done|skipped/, { timeout: 60_000 });
  expect(Number(await rpc("eth_getTransactionCount", [address, "latest"]))).toBeGreaterThanOrEqual(2);
});
