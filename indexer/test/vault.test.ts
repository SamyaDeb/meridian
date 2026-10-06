import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, KEEPER, CHAIN, ZERO, WAD } from "./helpers.js";
import { annualizedChangeWad } from "../src/lib/math.js";

const T0 = 1_790_000_000;
const at = (number: number, ts: number) => ({ number, timestamp: ts });
const nav = (number: number, ts: number, sp: bigint, navToken = 10_000_000_000n) => ({
  contract: "MeridianVault" as const,
  event: "NavSnapshot" as const,
  srcAddress: A.VAULT,
  block: at(number, ts),
  params: { nav: navToken, totalShares: 10_000n * WAD, sharePriceWad: sp, fundingAccruedWad: 0n },
});

describe("MeridianVault", () => {
  it("deposit/withdraw flows, share balances from Transfer only, users", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "MeridianVault", event: "Deposit", srcAddress: A.VAULT, block: at(1, T0), params: { sender: ALICE, owner: ALICE, assets: 1_000_000_000n, shares: 1_000n * WAD } },
            { contract: "MeridianVault", event: "Transfer", srcAddress: A.VAULT, block: at(1, T0), params: { from: ZERO, to: ALICE, value: 1_000n * WAD } },
            { contract: "MeridianVault", event: "Transfer", srcAddress: A.VAULT, block: at(2, T0 + 1), params: { from: ALICE, to: BOB, value: 100n * WAD } },
            { contract: "MeridianVault", event: "Withdraw", srcAddress: A.VAULT, block: at(3, T0 + 2), params: { sender: ALICE, receiver: ALICE, owner: ALICE, assets: 400_000_000n, shares: 400n * WAD } },
            { contract: "MeridianVault", event: "Transfer", srcAddress: A.VAULT, block: at(3, T0 + 2), params: { from: ALICE, to: ZERO, value: 400n * WAD } },
          ],
        },
      },
    });
    expect(await indexer.VaultUser.getOrThrow(`${A.VAULT}-${ALICE}`)).toMatchObject({ shares: 500n * WAD, depositedToken: 1_000_000_000n, withdrawnToken: 400_000_000n });
    expect((await indexer.VaultUser.getOrThrow(`${A.VAULT}-${BOB}`)).shares).toBe(100n * WAD);
    expect(await indexer.Vault.getOrThrow(A.VAULT)).toMatchObject({ depositedToken: 1_000_000_000n, withdrawnToken: 400_000_000n, userCount: 2 });
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).users).toBe(1); // BOB only received shares
  });

  it("NavSnapshot → VaultSnapshot, TVL, and 24 h / 7 d APY from the hourly share price", async () => {
    const indexer = createTestIndexer();
    const sp0 = WAD;
    const sp1 = WAD + WAD / 1_000n; // +0.1% after 1 day
    const sp7 = WAD + WAD / 100n;
    await indexer.process({ chains: { [CHAIN]: { simulate: [nav(10, T0, sp0)] } } });
    expect((await indexer.Vault.getOrThrow(A.VAULT)).apy24hWad).toBeUndefined(); // "waiting", never a fake APY
    await indexer.process({ chains: { [CHAIN]: { simulate: [nav(20, T0 + 86_400, sp1)] } } });
    const v1 = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v1.apy24hWad).toBe(annualizedChangeWad(sp0, sp1, 86_400n));
    expect(v1.apy24hWad).toBe((365n * WAD) / 1_000n);
    await indexer.process({ chains: { [CHAIN]: { simulate: [nav(30, T0 + 7 * 86_400, sp7, 12_000_000_000n)] } } });
    const v7 = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v7.apy7dWad).toBe(annualizedChangeWad(sp0, sp7, 7n * 86_400n));
    expect(v7).toMatchObject({ navToken: 12_000_000_000n, sharePriceWad: sp7 });
    expect(await indexer.VaultSnapshot.getAll()).toHaveLength(3);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).tvlToken).toBe(12_000_000_000n);
  });

  it("rebalance, hedge state, params, keepers, and Kuru hedger fills", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "MeridianVault", event: "Rebalanced", srcAddress: A.VAULT, block: at(1, T0), params: { reason: 5n, spotDeltaBase: 10n * WAD, perpDeltaBase: -10n * WAD, navAfter: 999n, sharePriceWad: WAD } },
            { contract: "MeridianVault", event: "HedgeEntered", srcAddress: A.VAULT, block: at(1, T0), params: { navAfter: 999n } },
            { contract: "MeridianVault", event: "KeeperUpdated", srcAddress: A.VAULT, block: at(2, T0), params: { keeper: KEEPER, allowed: true } },
            { contract: "KuruHedger", event: "SpotBought", srcAddress: A.HEDGER, block: at(3, T0), params: { vault: A.VAULT, quoteInToken: 290_000n, baseOut: 10n * WAD, avgPriceWad: 29n * 10n ** 15n } },
            { contract: "KuruHedger", event: "SpotSold", srcAddress: A.HEDGER, block: at(4, T0), params: { vault: A.VAULT, baseIn: 5n * WAD, quoteOutToken: 140_000n, avgPriceWad: 28n * 10n ** 15n } },
          ],
        },
      },
    });
    let v = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v).toMatchObject({ hedged: true, lastRebalanceReason: "EnterHedge", lastRebalanceBlock: 1n, keepers: [KEEPER] });
    expect((await indexer.VaultRebalance.getAll())[0]).toMatchObject({ reason: "EnterHedge", perpDeltaBase: -10n * WAD });
    const ht = await indexer.HedgeTrade.getAll();
    expect(ht.map((h) => [h.isBuy, h.quoteToken, h.baseWad])).toEqual(expect.arrayContaining([[true, 290_000n, 10n * WAD], [false, 140_000n, 5n * WAD]]));
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "MeridianVault", event: "HedgeExited", srcAddress: A.VAULT, block: at(5, T0), params: { navAfter: 998n } },
            { contract: "MeridianVault", event: "KeeperUpdated", srcAddress: A.VAULT, block: at(5, T0), params: { keeper: KEEPER, allowed: false } },
          ],
        },
      },
    });
    v = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v).toMatchObject({ hedged: false, keepers: [] });
  });
});
