// N7 Activity: rows from each source, merge (dedupe across sources, newest first), the receipts log, and the feed with a
// failing / off source. Perpl fills are the recorded K3 testnet page (packages/core/fixtures/perpl/testnet/trading/
// history-fills.json); account-history and indexer rows are shaped per rest-endpoints.md / indexer/schema.graphql
// (no recording of those yet). No network.
import fillsRec from "../../../../packages/core/fixtures/perpl/testnet/trading/history-fills.json";
import { PerplHttpError, type Fill } from "@meridian/core/perpl";
import { ActivityFeed, type PerplHistoryRest } from "../../features/activity/feed";
import { ActivityLog, activityLogKey, decodeLog, encodeLog, LOG_MAX } from "../../features/activity/log";
import { fromLog, mergeActivity, meridianActivity, perplAccountEvents, perplTrades, whenText, type ActivityItem, type LoggedReceipt } from "../../features/activity/model";
import type { Receipt } from "../../features/trade/exec/receipt";
import { monadTestnet } from "viem/chains";

const WAD = 10n ** 18n;
const MON = { id: 64, priceDecimals: 5, sizeDecimals: 0, collateralDecimals: 6 };
const FILLS = fillsRec.pages.flatMap((p) => p.d) as Fill[];
const EXPLORER = monadTestnet.blockExplorers!.default.url; // viem/chains, as the app config
const ME = "0x00000000000000000000000000000000000000aa";

function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

const receipt = (o: Partial<Receipt> = {}): Receipt => ({ ok: true, venue: "perpl", side: "long", reduceOnly: false, summary: "Long 600 MON on Perpl · worst price $0.02600", filledWad: 600n * WAD, stepWad: WAD, avgPriceWad: 2585n * 10n ** 13n, priceDp: 5, feeWad: 5351n * 10n ** 12n, orderId: 4525855211536, txHash: undefined, explorerTxUrl: undefined, blocksToFill: 2n, error: undefined, ...o });

describe("Perpl fills → one trade row per order (recorded K3 page)", () => {
  const rows = perplTrades(FILLS, MON, EXPLORER);
  it("two orders, sizes / prices / fees exact from the fills", () => {
    expect(rows.map((r) => r.id).sort()).toEqual(["perpl-order-4525679575056", "perpl-order-4525855211536"]);
    const a = rows.find((r) => r.id === "perpl-order-4525855211536")!;
    expect(a.title).toBe("Long 600 MON");
    expect(a.receipt!.filledWad).toBe(600n * WAD);
    expect(a.receipt!.avgPriceWad).toBe(2585n * 10n ** 13n); // 0.02585
    expect(a.receipt!.feeWad).toBe(5351n * 10n ** 12n); // "5351" CNS = 0.005351 AUSD
    expect(a.atMs).toBe(1791402965000);
    expect(a.block).toBe(69059070n);
    // Perpl's txid is bare hex: the row and the explorer link carry it with 0x
    expect(a.txHash).toBe("0xd4541c865d57605aed973e9df273236fe50cbfcf9e4d9c8f14016465ad964b14");
    expect(a.receipt!.explorerTxUrl).toBe(`${EXPLORER}/tx/0xd4541c865d57605aed973e9df273236fe50cbfcf9e4d9c8f14016465ad964b14`);
    expect(a.receipt!.summary).toBe("Long 600 MON on Perpl");
  });
  it("partial fills of one order are summed, average size-weighted; other markets and non-trade types are skipped", () => {
    const base = FILLS[0]!;
    const rows2 = perplTrades([{ ...base, s: 100, p: 2600 }, { ...base, s: 300, p: 2580, f: "100" }, { ...base, oid: 9, mkt: 16 }, { ...base, oid: 10, t: 5 }], MON);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.receipt!.filledWad).toBe(400n * WAD);
    expect(rows2[0]!.receipt!.avgPriceWad).toBe(((2600n * 100n + 2580n * 300n) * 10n ** 13n) / 400n);
    expect(rows2[0]!.receipt!.feeWad).toBe((5351n + 100n) * 10n ** 12n);
  });
  it("close orders read as closes", () => {
    const [r] = perplTrades([{ ...FILLS[0]!, t: 3 }], MON);
    expect(r!.title).toBe("Closed long 600 MON");
    expect(r!.receipt!.reduceOnly).toBe(true);
  });
});

describe("Perpl account history", () => {
  const at = (b: number, t: number) => ({ b, t, txid: "ab".repeat(32), l: 1 });
  it("deposit / withdrawal / funding / liquidation rows; settlement and collateral moves skipped; garbled amounts skipped", () => {
    const rows = perplAccountEvents(
      [
        { at: at(10, 1000), et: 1, a: "150000000" },
        { at: at(11, 2000), et: 8, a: "-1234" },
        { at: at(12, 3000), et: 8, a: "99" },
        { at: at(13, 4000), et: 2, a: "5000000" },
        { at: at(14, 5000), et: 4, a: "777" },
        { at: at(15, 6000), et: 3, a: "-10" },
        { at: at(16, 7000), et: 1, a: "1.5" },
      ],
      6,
    );
    expect(rows.map((r) => [r.kind, r.title, r.amountWad])).toEqual([
      ["deposit", "Deposit to Perpl", 150n * WAD],
      ["funding", "Funding paid", -1234n * 10n ** 12n],
      ["funding", "Funding received", 99n * 10n ** 12n],
      ["withdrawal", "Withdrawal from Perpl", -5n * WAD],
    ]);
    expect(rows[0]!.txHash).toBe(`0x${"ab".repeat(32)}`);
  });
});

describe("Meridian indexer rows", () => {
  const tx = `0x${"cd".repeat(32)}`;
  const data = {
    Trade: [
      { id: "1-1", maker: "0xmaker1", taker: ME.toUpperCase(), takerIsBid: true, priceWad: (25n * 10n ** 15n).toString(), sizeWad: (100n * WAD).toString(), block: "500", timestamp: "1791400000", txHash: tx },
      { id: "1-2", maker: "0xmaker2", taker: ME, takerIsBid: true, priceWad: (26n * 10n ** 15n).toString(), sizeWad: (300n * WAD).toString(), block: "500", timestamp: "1791400000", txHash: tx },
      { id: "2-1", maker: ME, taker: "0xother", takerIsBid: true, priceWad: (27n * 10n ** 15n).toString(), sizeWad: (10n * WAD).toString(), block: "501", timestamp: "1791400001", txHash: `0x${"ef".repeat(32)}` },
    ],
    FundingPayment: [{ id: "3-1", payment: (2n * 10n ** 16n).toString(), block: "502", timestamp: "1791400002", txHash: tx }],
    Liquidation: [],
  };
  it("one row per transaction, the account's side (taker ⇒ takerIsBid, maker ⇒ opposite), VWAP; funding paid is negative", () => {
    const rows = meridianActivity(data, ME, { priceDp: 4, lotSizeWad: WAD, explorerBase: EXPLORER });
    const taker = rows.find((r) => r.id === `meridian-tx-${tx}`)!;
    expect(taker.title).toBe("Bought 400 MON");
    expect(taker.receipt!.avgPriceWad).toBe((100n * 25n * 10n ** 15n + 300n * 26n * 10n ** 15n) / 400n);
    expect(taker.atMs).toBe(1791400000_000);
    expect(rows.find((r) => r.title === "Sold 10 MON")).toBeTruthy();
    expect(rows.find((r) => r.kind === "funding")!.amountWad).toBe(-2n * 10n ** 16n);
  });
  it("garbled numbers throw (the list says the source failed, never shows zeros)", () => {
    expect(() => meridianActivity({ ...data, Trade: [{ ...data.Trade[0], sizeWad: "abc" }] }, ME, { priceDp: 4, lotSizeWad: WAD })).toThrow(/sizeWad/);
    expect(() => meridianActivity({}, ME, { priceDp: 4, lotSizeWad: WAD })).toThrow(/Trade/);
  });
});

describe("merge: dedupe across sources, newest first", () => {
  const item = (id: string, atMs: number | undefined, block?: bigint): ActivityItem => ({ id, kind: "deposit", venue: "perpl", title: id, amountWad: 1n, atMs, block, txHash: undefined, receipt: undefined });
  it("the app's own receipt wins over Perpl's fill row for the same order", () => {
    const log: LoggedReceipt[] = [{ atMs: 1791402966000, block: 69059072n, receipt: receipt() }];
    const merged = mergeActivity(fromLog(log), perplTrades(FILLS, MON));
    expect(merged).toHaveLength(2);
    expect(merged[0]!.receipt!.summary).toBe("Long 600 MON on Perpl · worst price $0.02600"); // the line the user accepted
  });
  it("sorted by time, then block; rows without either last", () => {
    const m = mergeActivity([item("a", 1000), item("b", undefined, 5n), item("c", 3000)], [item("d", 2000), item("a", 9999)], [item("e", undefined)]);
    expect(m.map((x) => x.id)).toEqual(["c", "d", "a", "b", "e"]);
  });
  it("failed orders aren't activity (nothing moved)", () => {
    expect(fromLog([{ atMs: 1, block: undefined, receipt: receipt({ ok: false, error: "No liquidity" }) }])).toEqual([]);
  });
});

describe("receipts log", () => {
  it("round-trips bigints, newest first, replaces the same order, keeps LOG_MAX; garbage ⇒ empty", async () => {
    const { kv, map } = memKv();
    const log = new ActivityLog(kv, activityLogKey(10143, ME));
    await log.add({ atMs: 1, block: 7n, receipt: receipt({ orderId: 1 }) });
    await log.add({ atMs: 2, block: 8n, receipt: receipt({ orderId: 2 }) });
    await log.add({ atMs: 3, block: 9n, receipt: receipt({ orderId: 1, filledWad: 5n * WAD }) });
    expect(log.store.get().map((e) => (e as LoggedReceipt).receipt.orderId)).toEqual([1, 2]);
    const again = new ActivityLog(kv, activityLogKey(10143, ME));
    await again.load();
    expect((again.store.get()[0] as LoggedReceipt).receipt.filledWad).toBe(5n * WAD);
    expect(map.has(`meridian.activity.10143.${ME}`)).toBe(true);
    const many = Array.from({ length: LOG_MAX + 5 }, (_, i) => ({ atMs: i, block: undefined, receipt: receipt({ orderId: i }) }));
    expect(decodeLog(encodeLog(many))).toHaveLength(LOG_MAX);
    expect(decodeLog("{not json")).toEqual([]);
    expect(decodeLog(JSON.stringify({ v: 1, e: [{ atMs: 1, receipt: { ok: true } }] }))).toEqual([]);
  });
});

describe("feed", () => {
  const rest = (o: Partial<PerplHistoryRest> = {}): PerplHistoryRest => ({ fills: async () => ({ d: FILLS, np: "" }), call: async () => ({ d: [{ at: { b: 1, t: 1791300000000 }, et: 1, a: "10000000" }], np: "" }), ...o });
  const base = (r: PerplHistoryRest | undefined) => {
    const { kv } = memKv();
    const log = new ActivityLog(kv, "k");
    return { log, feed: new ActivityFeed({ log, perpl: () => (r ? { rest: r, market: MON } : undefined), perplOff: () => "Turn on Perpl trading (Settings) to see its history here.", meridian: undefined, explorerBase: EXPLORER }) };
  };

  it("Perpl rows + the app's receipts merged; no indexer ⇒ says so", async () => {
    const { feed, log } = base(rest());
    await feed.refresh();
    const st = feed.store.get();
    expect(st.items.map((i) => i.title)).toEqual(["Long 600 MON", "Long 2,000 MON", "Deposit to Perpl"]);
    expect(st.meridian.note).toMatch(/needs the indexer/);
    expect(st.refreshing).toBe(false);
    await log.add({ atMs: 1791402999000, block: undefined, receipt: receipt({ venue: "meridian", orderId: undefined, txHash: `0x${"11".repeat(32)}`, summary: "Short 5 MON on Meridian", side: "short", filledWad: 5n * WAD }) });
    expect(feed.store.get().items[0]!.title).toBe("Short 5 MON");
  });

  it("a failing source says so and the rest still shows; 404 = no Perpl account = nothing there", async () => {
    const failing = base(rest({ fills: async () => Promise.reject(new Error("HTTP 503 from https://testnet.perpl.xyz/api")) }));
    await failing.feed.refresh();
    expect(failing.feed.store.get().perpl).toEqual({ state: "error", note: "Perpl history didn't load: HTTP 503 from <url>" });
    const none = base(rest({ fills: async () => Promise.reject(new PerplHttpError(404, "GET", "/v1/trading/fills", "")) }));
    await none.feed.refresh();
    expect(none.feed.store.get().perpl.state).toBe("ok");
    expect(none.feed.store.get().items).toEqual([]);
  });

  it("Perpl not enabled ⇒ the reason instead of an empty list", async () => {
    const { feed } = base(undefined);
    await feed.refresh();
    expect(feed.store.get().perpl).toEqual({ state: "off", note: "Turn on Perpl trading (Settings) to see its history here." });
  });
});

it("when: just now · min · h · date; unknown time falls back to the block", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  expect(whenText(now - 30_000, now)).toBe("just now");
  expect(whenText(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(whenText(now - 3 * 3_600_000, now)).toBe("3 h ago");
  expect(whenText(now - 3 * 86_400_000, now)).toMatch(/^\d{1,2} Oct$/);
  expect(whenText(undefined, now, 42n)).toBe("block 42");
  expect(whenText(undefined, now)).toBe("—");
});
