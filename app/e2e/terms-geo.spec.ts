// C3 smoke (390×844), no chain needed: the write gate runs before any RPC call. Build + start the app with
//   NEXT_PUBLIC_DEV_ACCOUNT=<any address> next build
//   GEO_COUNTRY_HEADER=x-test-country GEO_BLOCKED_COUNTRIES=XA GEO_BLOCK_MODE=all next start -p 3117
// (x-test-country / XA are test values only; the real header and list come from the platform docs and the founders.)
import { expect, test } from "@playwright/test";
import { TERMS_STORAGE_KEY, TERMS_VERSION } from "../src/lib/terms";

test("terms gate: first write asks, cancel keeps the tx from running, footer links to /terms", async ({ page }) => {
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  // F2: deposit is a dialog opened from the ticket; the gate stacks on top of it (both native modal dialogs)
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  const funds = page.getByRole("dialog", { name: "Deposit AUSD" });
  await funds.getByLabel("Deposit amount").fill("1");
  await funds.getByRole("button", { name: "Deposit AUSD" }).click();
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  await expect(gate).toContainText("Before your first transaction");
  await expect(gate.getByRole("button", { name: "Accept" })).toBeDisabled();
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(funds.getByTestId("tx-status")).toContainText("cancelled");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Terms & risks" }).first().click();
  await expect(page.getByRole("heading", { name: "Terms of use and risk disclosure" })).toBeVisible();
});

test("terms bump (D5, Pulse → Meridian): an acceptance of the old version asks again; accepting stores the new one", async ({ page }) => {
  expect(TERMS_VERSION).not.toBe("2026-09-30-draft");
  await page.addInitScript(
    (k) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(k, JSON.stringify({ version: "2026-09-30-draft", acceptedAt: 1_759_000_000_000 }));
        sessionStorage.setItem("seeded", "1");
      }
    },
    TERMS_STORAGE_KEY,
  );
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  const funds = page.getByRole("dialog", { name: "Deposit AUSD" });
  await funds.getByLabel("Deposit amount").fill("1");
  await funds.getByRole("button", { name: "Deposit AUSD" }).click();
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  await expect(gate).toContainText("Meridian");
  await gate.getByRole("checkbox").check();
  await gate.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}").version, TERMS_STORAGE_KEY)).toBe(TERMS_VERSION);
});

test("geoblock (mode all): restricted viewers get the blocked page; /terms stays readable", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-test-country": "XA" }, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/trade");
  await expect(page.getByRole("heading", { name: /isn.t available in your region/ })).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of use and risk disclosure" })).toBeVisible();
  await ctx.close();
});

test("geoblock: other countries are unaffected", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-test-country": "ZZ" }, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/trade");
  await expect(page.getByTestId("place-order")).toBeVisible();
  await ctx.close();
});
