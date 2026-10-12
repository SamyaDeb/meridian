// W1 passkey wallet in a real browser: Chromium's virtual authenticator (CDP WebAuthn, PRF on) stands in for Face ID.
//   NEXT_PUBLIC_MERA_RP_ID=localhost pnpm build && pnpm start -p 3117 ; npx playwright test e2e/passkey.spec.ts
// Checks: create → address, storage holds no secret, reload → unlock the same address, the recovery phrase imports as
// that address, lock.
import { expect, test, type Page } from "@playwright/test";
import { mnemonicToAccount } from "viem/accounts";

test.use({ viewport: { width: 1440, height: 900 } });

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
}

async function accountAddress(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Account" }).click();
  const text = await page.locator("p.num.break-all").first().innerText();
  await page.keyboard.press("Escape");
  return text.trim();
}

test("passkey wallet: create, reload + unlock, recovery phrase, lock", async ({ page }) => {
  await virtualAuthenticator(page);
  await page.goto("/trade");
  await page.getByRole("button", { name: "Passkey wallet" }).click();
  await page.getByRole("button", { name: "Create a passkey wallet" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible({ timeout: 20_000 });
  const address = await accountAddress(page);
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

  const storage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(storage).toContain("meridian.passkey.v1");
  const record = await page.evaluate(() => JSON.parse(localStorage.getItem("meridian.passkey.v1")!));
  expect(Object.keys(record).sort()).toEqual(expect.arrayContaining(["addressHint", "createdAt", "credentialId"]));
  expect(Object.keys(record).every((k) => ["addressHint", "createdAt", "credentialId", "transports"].includes(k))).toBe(true);

  // reload: the session is gone (memory only), the passkey is remembered
  await page.reload();
  const short = `${address.slice(0, 6)}`;
  const unlock = page.getByRole("button", { name: "Passkey wallet" });
  await expect(unlock).toContainText(short);
  await unlock.click();
  await page.getByRole("button", { name: /^Unlock 0x/ }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible({ timeout: 20_000 });
  expect(await accountAddress(page)).toBe(address);

  // recovery phrase: fresh prompt, 24 words, same address in any BIP-39 wallet
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Show recovery phrase" }).click();
  const dialog = page.getByRole("dialog", { name: "Recovery phrase" });
  await expect(dialog).toBeVisible();
  const words = (await dialog.locator("ol li").allInnerTexts()).map((t) => t.replace(/^\d+\.\s*/, "").trim());
  expect(words).toHaveLength(24);
  expect(mnemonicToAccount(words.join(" ")).address).toBe(address);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(words.slice(0, 3).join(" "));
  await dialog.getByRole("button", { name: "Done" }).click();

  // lock: back to the unlock button, no account
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("button", { name: "Passkey wallet" })).toContainText(short);
});
