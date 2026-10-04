// C3 smoke (390×844), no chain needed: the write gate runs before any RPC call. Build + start the app with
//   NEXT_PUBLIC_DEV_ACCOUNT=<any address> next build
//   GEO_COUNTRY_HEADER=x-test-country GEO_BLOCKED_COUNTRIES=XA GEO_BLOCK_MODE=all next start -p 3117
// (x-test-country / XA are test values only; the real header and list come from the platform docs and the founders.)
import { expect, test } from "@playwright/test";

test("terms gate: first write asks, cancel keeps the tx from running, footer links to /terms", async ({ page }) => {
  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  await page.getByLabel("Deposit amount").fill("1");
  await page.getByRole("button", { name: "Deposit AUSD" }).click();
  const gate = page.getByRole("dialog");
  await expect(gate).toContainText("Before your first transaction");
  await expect(gate.getByRole("button", { name: "Accept" })).toBeDisabled();
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("tx-status")).toContainText("cancelled");
  await page.getByRole("link", { name: "Terms & risks" }).click();
  await expect(page.getByRole("heading", { name: "Terms of use and risk disclosure" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Deposit AUSD" })).toBeVisible();
  await ctx.close();
});
