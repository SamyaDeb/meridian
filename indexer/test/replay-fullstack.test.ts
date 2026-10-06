// Phase 4 step 6: replay of the FULL-STACK local rehearsal (anvil --chain-id 10143: perp + vault + hedger + funding swaps,
// 97k blocks of history, keeper rebalances, skew cap, crash, maturity), recorded by scripts/record-anvil.mjs, through the
// indexer. Every vault / swap event type must land in its entity, and the entities must equal the contracts' own
// answers recorded at the same block (share price, balances, swap positions, OI, maturity snapshot, realized APR).
// Envio's test simulate() routes only addresses configured in config.test.yaml, so recorded addresses (and address
// params) are mapped onto that config per contract. The labelled demo market and the second (fresh) swap market are
// left out of this replay (one address per contract in the test config); the matured swap market is the one kept.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { A, CHAIN } from "./helpers.js";

type Item = {
  contract: string;
  event: string;
  srcAddress: `0x${string}`;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: `0x${string}` };
  params: Record<string, unknown>;
};
type SwapExpect = {
  positions: Record<string, { size: bigint; fixedAprNotional: bigint }>;
  longOI: bigint;
  shortOI: bigint;
  matured: boolean;
  snapped: boolean;
  fAtM: bigint;
  gAtM: bigint;
  realized8h: bigint | null;
  markApr: bigint;
};
type Fixture = {
  atBlock: number;
  counts: Record<string, number>;
  expected: {
    averageFundingApr: Record<"1h" | "8h" | "24h", bigint | null>;
    vault: { sharePriceAt: Array<{ block: number; sharePrice: bigint }>; balances: Record<string, bigint>; totalSupply: bigint; totalAssets: bigint; sharePrice: bigint };
    swaps: Record<string, SwapExpect>;
  };
  items: Item[];
};

const fx = JSON.parse(readFileSync(new URL("./fixtures/anvil-fullstack-10143.json", import.meta.url), "utf8"), (_, v) =>
  typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
) as Fixture;

const lc = (a: unknown) => String(a).toLowerCase();
// the matured swap market (step 4) is the one replayed: it carries the maturity snapshot and the keeper's history
const SWAP_KEPT = Object.entries(fx.expected.swaps).find(([, s]) => s.snapped)![0];
const swapExp = fx.expected.swaps[SWAP_KEPT]!;
const first = (contract: string, pred: (i: Item) => boolean = () => true) => fx.items.find((i) => i.contract === contract && pred(i))?.srcAddress;
// recorded address (lower-case) → test-config address, per contract (main market only)
const MARKET_REG = fx.items.find((i) => i.event === "MarketRegistered" && i.params.symbol === "MON-PERP")!;
const MAP = new Map<string, `0x${string}`>(
  [
    [MARKET_REG.params.clearingHouse, A.CH],
    [MARKET_REG.params.orderBook, A.OB],
    [MARKET_REG.params.oracle, A.ORACLE],
    [first("InsuranceFund"), A.IF],
    [first("MarketFactory"), A.FACTORY],
    [first("MeridianVault"), A.VAULT],
    [first("KuruHedger"), A.HEDGER],
    [SWAP_KEPT, A.SWAP],
    [first("SwapOrderBook", (i) => fx.items.some((j) => j.contract === "FundingSwapMarket" && j.srcAddress === SWAP_KEPT && j.block.number === i.block.number && j.transaction.hash === i.transaction.hash)), A.SWAP_OB],
  ].map(([k, v]) => [lc(k), v as `0x${string}`]),
);
const remap = (v: unknown): unknown => (typeof v === "string" && MAP.has(lc(v)) ? MAP.get(lc(v)) : v);
const items = fx.items
  .filter((i) => i.event !== "OwnershipTransferred" && MAP.has(lc(i.srcAddress)))
  .map((i) => ({ ...i, srcAddress: MAP.get(lc(i.srcAddress))!, params: Object.fromEntries(Object.entries(i.params).map(([k, v]) => [k, remap(v)])) }));
const of = (contract: string, event: string) => items.filter((i) => i.contract === contract && i.event === event);

let indexer: ReturnType<typeof createTestIndexer>;
beforeAll(async () => {
  indexer = createTestIndexer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await indexer.process({ chains: { [CHAIN]: { simulate: items as any } } });
}, 180_000);

describe("full-stack replay: vault + swap event surface", () => {
  it("the recording covers every vault, hedger and swap event the rehearsal emits", () => {
    for (const k of [
      "MeridianVault.Deposit",
      "MeridianVault.Transfer",
      "MeridianVault.NavSnapshot",
      "MeridianVault.Rebalanced",
      "MeridianVault.HedgeEntered",
      "MeridianVault.VaultParamsUpdated",
      "MeridianVault.KeeperUpdated",
      "KuruHedger.SpotBought",
      "KuruHedger.SpotSold",
      "FundingSwapMarket.Deposited",
      "FundingSwapMarket.SwapPositionChanged",
      "FundingSwapMarket.SwapAccrualSettled",
      "FundingSwapMarket.MaturitySettled",
      "FundingSwapMarket.SwapParamsUpdated",
      "SwapOrderBook.OrderPlaced",
      "SwapOrderBook.OrderCancelled",
      "SwapOrderBook.Trade",
    ]) {
      expect(fx.counts[k], k).toBeGreaterThan(0);
    }
  });

  it("VaultSnapshot per NavSnapshot; share price series = the contract's sharePrice() at those blocks", async () => {
    const snaps = await indexer.VaultSnapshot.getAll();
    expect(snaps.length).toBe(of("MeridianVault", "NavSnapshot").length);
    expect(fx.expected.vault.sharePriceAt.length).toBeGreaterThan(0);
    for (const { block, sharePrice } of fx.expected.vault.sharePriceAt) {
      const inBlock = snaps.filter((s) => Number(s.block) === block).sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(inBlock.length, `block ${block}`).toBeGreaterThan(0);
      // the last snapshot of the block = the view at the end of that block
      expect(inBlock.map((s) => s.sharePriceWad), `block ${block}`).toContain(sharePrice);
    }
    const v = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v.totalShares).toBe(snaps.sort((a, b) => Number(a.block - b.block))[snaps.length - 1]!.totalShares);
  });

  it("VaultUser shares = balanceOf at the recording block; Σ shares = totalSupply", async () => {
    const users = await indexer.VaultUser.getAll();
    let sum = 0n;
    for (const [holder, bal] of Object.entries(fx.expected.vault.balances)) {
      const u = users.find((x) => lc(x.user) === lc(holder));
      expect(u?.shares ?? 0n, holder).toBe(bal);
      sum += bal;
    }
    expect(users.reduce((s, u) => s + u.shares, 0n)).toBe(fx.expected.vault.totalSupply);
    expect(sum).toBe(fx.expected.vault.totalSupply);
  });

  it("VaultRebalance per Rebalanced (EnterHedge / SkewCap reasons), hedged flag", async () => {
    const reb = await indexer.VaultRebalance.getAll();
    expect(reb.length).toBe(of("MeridianVault", "Rebalanced").length);
    const v = await indexer.Vault.getOrThrow(A.VAULT);
    expect(v.hedged).toBe(true);
    expect(reb.map((r) => r.reason)).toEqual(expect.arrayContaining(["EnterHedge", "SkewCap"]));
  });

  it("SwapPosition q and K = the contract's getPosition; Σq = ΣK = 0; OI = the contract's", async () => {
    const pos = (await indexer.SwapPosition.getAll()).filter((p) => p.swapMarket === A.SWAP);
    let sq = 0n;
    let sk = 0n;
    let longs = 0n;
    for (const [acct, want] of Object.entries(swapExp.positions)) {
      const p = pos.find((x) => lc(x.account_id) === lc(acct));
      expect(p?.size ?? 0n, acct).toBe(want.size);
      expect(p?.fixedAprNotional ?? 0n, acct).toBe(want.fixedAprNotional);
    }
    for (const p of pos) {
      sq += p.size;
      sk += p.fixedAprNotional;
      if (p.size > 0n) longs += p.size;
    }
    expect(sq).toBe(0n);
    expect(sk).toBe(0n);
    expect(longs).toBe(swapExp.longOI);
    expect((await indexer.SwapStats.getOrThrow(A.SWAP)).openInterestWad).toBe(swapExp.longOI);
  });

  it("SwapTrade per SwapPositionChanged (maker + taker legs, SCHEMA.md), book Trade kind Swap; maturity snapshot = the contract's", async () => {
    expect((await indexer.SwapTrade.getAll()).length).toBe(of("FundingSwapMarket", "SwapPositionChanged").length);
    const bookTrades = (await indexer.Trade.getAll()).filter((t) => t.kind === "Swap");
    expect(bookTrades.length).toBe(of("SwapOrderBook", "Trade").length);
    const st = await indexer.SwapStats.getOrThrow(A.SWAP);
    expect(swapExp.snapped).toBe(true);
    expect(st.matured).toBe(true);
    expect(st.cumFundingAtMaturity).toBe(swapExp.fAtM);
    expect(st.cumIndexTimeAtMaturity).toBe(swapExp.gAtM);
    expect(Number(st.maturityBlock)).toBe(of("FundingSwapMarket", "MaturitySettled")[0]!.block.number);
  });

  it("swap realized APR = the perp oracle's: FundingSwapMarket.realizedApr(8 h) = averageFundingApr(96,000) = the indexer's 8 h APR", async () => {
    expect(swapExp.realized8h).not.toBeNull();
    expect(swapExp.realized8h).toBe(fx.expected.averageFundingApr["8h"]);
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m.realizedApr8hWad).toBe(fx.expected.averageFundingApr["8h"]);
    expect(m.realizedApr1hWad).toBe(fx.expected.averageFundingApr["1h"]);
  });

  it("Market.testMarket: the main market is not a test market (the demo market is excluded from this replay)", async () => {
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m.testMarket ?? false).toBe(false);
    expect(fx.items.some((i) => i.event === "MarketRegistered" && i.params.symbol === "MON-PERP-DEMO")).toBe(true);
  });
});
