// K6 B1: Earn v2 withdrawal queue on anvil, through the app (390×844): deposit → withdraw beyond idle = request →
// keeper fulfils (script) → claim; and a second request that the owner cancels.
// Prereqs: anvil + DeployLocal (deployments/31337.json: MockMeridianVault with the CR-014 queue and `mockDeploy`, the
// local stand-in for capital deployed into the hedge). The "keeper" here is anvil's unlocked account #0 (no key in this
// file): it mints test AUSD, marks the vault's assets as deployed so idle can't pay, and calls fulfillRedeems.
//   NEXT_PUBLIC_DATA_SOURCE=chain NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_LOCAL_RPC_URL=http://127.0.0.1:8545 \
//   NEXT_PUBLIC_DEV_ACCOUNT=0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f NEXT_PUBLIC_PRIVY_APP_ID= next dev -p 3132
//   APP_URL=http://localhost:3132 RPC_URL=http://127.0.0.1:8545 npx playwright test e2e/earn-queue-anvil.spec.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/screenshots";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const KEEPER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address; // anvil #0, unlocked
const ME = (process.env.DEV_ACCOUNT ?? "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f") as Address; // = NEXT_PUBLIC_DEV_ACCOUNT
const dep = JSON.parse(readFileSync(join(__dirname, "../../deployments/31337.json"), "utf8")) as { contracts: Record<string, Address> };
const VAULT = dep.contracts.MeridianVault!;
const AUSD = dep.contracts.AUSD!;
const abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function mockDeploy(uint256 assets)",
  "function fulfillRedeems(uint256[] ids, bytes spotRoute)",
]);
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const keeper = createWalletClient({ chain: foundry, transport: http(RPC), account: KEEPER });
async function send(fn: "mint" | "mockDeploy" | "fulfillRedeems", address: Address, args: readonly unknown[]) {
  const hash = await keeper.writeContract({ address, abi, functionName: fn, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
}
const ausdOf = (a: Address) => pub.readContract({ address: AUSD, abi, functionName: "balanceOf", args: [a] });
/** leave `idleToken` idle: everything else counts as deployed into the hedge */
async function leaveIdle(idleToken: bigint) {
  const ta = await pub.readContract({ address: VAULT, abi, functionName: "totalAssets" });
  await send("mockDeploy", VAULT, [ta > idleToken ? ta - idleToken : 0n]);
}

async function deposit(page: Page, amount: string) {
  await page.getByLabel("Vault deposit amount").fill(amount);
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  const gate = page.getByRole("dialog").filter({ hasText: "Before your first transaction" });
  if (await gate.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await gate.getByRole("checkbox").check();
    await gate.getByRole("button", { name: "Accept" }).click();
  }
  await expect(page.getByTestId("tx-status")).toContainText(`deposit ${amount} AUSD ✓`, { timeout: 30_000 });
}

/** the newest request row (rows are newest first) */
const newestRow = (page: Page) => page.getByTestId("redeem-requests").locator("li").first();

test.setTimeout(Number(process.env.T ?? 180_000));

test.afterAll(async () => {
  await send("mockDeploy", VAULT, [0n]); // back to an all-idle mock vault for the other specs
});

test("deposit → withdraw beyond idle = request → keeper fulfils → claim; request → cancel", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await send("mint", AUSD, [ME, 1_000_000_000n]); // 1,000 test AUSD
  await send("mockDeploy", VAULT, [0n]);

  await page.goto("/trade");
  await page.getByRole("button", { name: "Dev account" }).click();
  await page.goto("/earn");
  await expect(page.getByRole("heading", { name: "Earn the basis" })).toBeVisible();
  if (await page.getByRole("button", { name: "Dev account" }).isVisible().catch(() => false)) await page.getByRole("button", { name: "Dev account" }).click();

  // 1. deposit 100 AUSD (idle); the vault then "deploys" all but 1 AUSD
  await deposit(page, "100");
  await leaveIdle(1_000_000n);

  // 2. withdraw 100% → idle can't pay → the app offers a request instead of a failing redeem
  await page.locator("#wpct").fill("100");
  await expect(page.getByTestId("withdraw-path")).toContainText("beyond idle AUSD: a request", { timeout: 20_000 });
  await expect(page.getByTestId("withdraw")).toHaveText("Request withdrawal");
  await page.getByTestId("withdraw").click();
  await expect(page.getByTestId("tx-status")).toContainText("request withdrawal of 100% ✓", { timeout: 30_000 });
  const row = newestRow(page);
  await expect(row).toHaveAttribute("data-status", "requested", { timeout: 20_000 });
  await expect(row.getByTestId("queue-position")).toContainText(/^1 of \d+/);
  await expect(row.getByTestId("redeem-estimate")).toContainText(/≈ 99\.9\d AUSD/);
  const id = BigInt((await row.getAttribute("data-testid"))!.replace("redeem-", ""));
  await page.screenshot({ path: `${SHOTS}/earn-queue-requested-390.png`, fullPage: true });

  // 3. keeper fulfils (script); the row turns claimable with a fixed payout
  await send("fulfillRedeems", VAULT, [[id], "0x"]);
  await expect(row).toHaveAttribute("data-status", "claimable", { timeout: 20_000 });
  // the mock prices at plain ERC-4626 (no 5 bps fee), MeridianVault charges it: either is a fixed payout ≤ the deposit
  await expect(row.getByTestId("redeem-assets")).toContainText(/(99\.9\d|100\.00) AUSD/);

  // 4. claim → AUSD back in the wallet
  const before = await ausdOf(ME);
  await row.getByTestId(`claim-${id}`).click();
  await expect(page.getByTestId("tx-status")).toContainText(`claim request #${id} ✓`, { timeout: 30_000 });
  await expect(row).toHaveAttribute("data-status", "claimed", { timeout: 20_000 });
  const got = (await ausdOf(ME)) - before;
  console.log(`[K6 B1] claimed request #${id}: ${Number(got) / 1e6} AUSD for a 100 AUSD deposit (the mock charges no fee and no unwind cost; MeridianVault charges 5 bps + its unwind cost)`);
  expect(got).toBeGreaterThanOrEqual(99_940_000n);
  expect(got).toBeLessThanOrEqual(100_000_000n);
  await page.screenshot({ path: `${SHOTS}/earn-queue-claimed-390.png`, fullPage: true });

  // 5. a second request, cancelled by its owner: the shares come back
  await send("mockDeploy", VAULT, [0n]);
  await deposit(page, "50");
  await leaveIdle(1_000_000n);
  await page.locator("#wpct").fill("100");
  await expect(page.getByTestId("withdraw")).toHaveText("Request withdrawal", { timeout: 20_000 });
  await page.getByTestId("withdraw").click();
  await expect(page.getByTestId("tx-status")).toContainText("request withdrawal of 100% ✓", { timeout: 30_000 });
  const row2 = newestRow(page);
  await expect(row2).toHaveAttribute("data-status", "requested", { timeout: 20_000 });
  const id2 = BigInt((await row2.getAttribute("data-testid"))!.replace("redeem-", ""));
  expect(id2).toBeGreaterThan(id);
  await expect(page.getByTestId("my-vault-value")).toContainText(/^0\.00 AUSD/, { timeout: 20_000 });
  await row2.getByTestId(`cancel-${id2}`).click();
  await expect(page.getByTestId("tx-status")).toContainText(`cancel request #${id2} ✓`, { timeout: 30_000 });
  await expect(row2).toHaveAttribute("data-status", "cancelled", { timeout: 20_000 });
  await expect(page.getByTestId("my-vault-value")).toContainText(/^(49|50)\.\d\d AUSD/, { timeout: 20_000 });
});
