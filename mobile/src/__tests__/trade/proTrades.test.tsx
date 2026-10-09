// Pro view completion (N5 deliverable 3 + research §5.3): the Trades tab on both venues (Perpl `trades@<id>` frames
// through the real market store; Meridian OrderBook `Trade` logs read only while the tab is visible, bounded ranges),
// the candles view (open/high/low/close per bucket, coloured by direction, gaps dim), and the remembered Pro choices.
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: () => undefined }));

import { orderBookAbi, parseFixed } from "@meridian/core/meridian";
import { parseMarketDataFrame } from "@meridian/core/perpl";
import { act, render, screen } from "@testing-library/react-native";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from "viem";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../../auth/AuthProvider";
import type { AuthController } from "../../auth/controller";
import { candlePaths } from "../../features/trade/chart/PriceChart";
import type { Point } from "../../features/trade/chart/series";
import { MAX_RANGE, MeridianTradesReader, tradeRows } from "../../features/trade/data/trades";
import { CHART_MODE_KEY, loadPref } from "../../features/trade/prefs";
import { mergeTrades, Trades } from "../../features/trade/Trades";
import { TradeProvider, type TradeKit } from "../../features/trade/TradeProvider";
import { LiveProvider } from "../../live/LiveProvider";
import type { TradeRow } from "../../live/perplMarket";
import { Store } from "../../live/store";
import { makeAuth } from "../auth/authFixtures";
import { fakeLive } from "../fakeLive";

const WAD = 10n ** 18n;
const OB = "0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207" as Address;
const ME = "0x00000000000000000000000000000000000000a1" as Address;

function tradeLog(o: { block: bigint; logIndex: number; takerIsBid: boolean; priceWad: bigint; sizeWad: bigint; address?: Address }): Log {
  const topics = encodeEventTopics({ abi: orderBookAbi, eventName: "Trade", args: { makerOrderId: 1n, maker: "0x00000000000000000000000000000000000000b2", taker: ME } });
  const data = encodeAbiParameters([{ type: "bool" }, { type: "uint32" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }], [o.takerIsBid, 25864, o.sizeWad / (100n * WAD), o.priceWad, o.sizeWad]);
  return { address: o.address ?? OB, topics, data, blockNumber: o.block, transactionHash: `0x${o.block.toString(16).padStart(64, "0")}` as Hex, logIndex: o.logIndex, blockHash: "0x" as Hex, transactionIndex: 0, removed: false } as Log;
}

describe("Meridian trades from OrderBook Trade logs", () => {
  it("rows = the taker's side, exact WAD, newest first; other contracts ignored", () => {
    const rows = tradeRows(
      [
        tradeLog({ block: 10n, logIndex: 0, takerIsBid: true, priceWad: 25864n * 10n ** 12n, sizeWad: 300n * WAD }),
        tradeLog({ block: 12n, logIndex: 1, takerIsBid: false, priceWad: 25848n * 10n ** 12n, sizeWad: 100n * WAD }),
        tradeLog({ block: 12n, logIndex: 3, takerIsBid: true, priceWad: 1n, sizeWad: 100n * WAD }),
        tradeLog({ block: 13n, logIndex: 0, takerIsBid: true, priceWad: 1n, sizeWad: WAD, address: "0x0000000000000000000000000000000000000001" }),
      ],
      OB,
    );
    expect(rows.map((r) => [r.block, r.side, r.priceWad])).toEqual([
      [12, "buy", 1n],
      [12, "sell", 25848n * 10n ** 12n],
      [10, "buy", 25864n * 10n ** 12n],
    ]);
    expect(rows[2]).toMatchObject({ venue: "meridian", sizeWad: 300n * WAD });
  });

  it("reads only while active: a 100-block backfill, then from the last block read + 1, never more than MAX_RANGE", async () => {
    const calls: [bigint, bigint][] = [];
    const client = { getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => (calls.push([a.fromBlock, a.toBlock]), a.toBlock === 1000n ? [tradeLog({ block: 999n, logIndex: 0, takerIsBid: true, priceWad: 1n, sizeWad: WAD })] : []) };
    const r = new MeridianTradesReader({ client: client as never, orderBook: OB });
    expect(r.onBlock(1000n)).toBeUndefined(); // tab not visible
    r.active.set(true);
    await r.onBlock(1000n);
    await r.onBlock(1000n); // same block: nothing
    await r.onBlock(1003n);
    await r.onBlock(5000n); // app was away: one capped range
    expect(calls).toEqual([
      [901n, 1000n],
      [1001n, 1003n],
      [5000n - MAX_RANGE + 1n, 5000n],
    ]);
    expect(r.store.get().rows).toHaveLength(1);
    expect(r.store.get().toBlock).toBe(5000n);
  });

  it("an RPC error is kept for the tab and the next block retries", async () => {
    let fail = true;
    const r = new MeridianTradesReader({ client: { getLogs: async () => (fail ? Promise.reject(new Error("block range too large")) : []) } as never, orderBook: OB });
    r.active.set(true);
    await r.onBlock(10n);
    expect(r.store.get().error).toMatch(/block range too large/);
    fail = false;
    await r.onBlock(11n);
    expect(r.store.get()).toMatchObject({ error: undefined, toBlock: 11n });
  });
});

describe("Perpl trades through the market store", () => {
  it("a trades@64 snapshot + update land in the store as WAD rows, newest first", () => {
    const f = fakeLive();
    const pd = 10n ** 13n; // priceDecimals 5
    f.perpl.feed.apply(parseMarketDataFrame(JSON.stringify({ mt: 17, sid: 9, d: [{ at: { b: 100, t: 1, txid: "0xaa" }, p: 2567, s: 40, sd: 1 }] })), 1);
    f.perpl.sample();
    const first = f.perpl.store.get().trades;
    expect(first).toEqual([{ venue: "perpl", side: "buy", priceWad: 2567n * pd, sizeWad: 40n * WAD, block: 100, tMs: 1, txHash: "0xaa" }]);
    f.perpl.sample();
    expect(f.perpl.store.get().trades).toBe(first); // no new frame ⇒ same array (no re-render)
    f.perpl.feed.apply(parseMarketDataFrame(JSON.stringify({ mt: 18, sid: 9, d: [{ at: { b: 101 }, p: 2551, s: 5, sd: 2 }] })), 2);
    f.perpl.sample();
    expect(f.perpl.store.get().trades.map((t) => [t.block, t.side])).toEqual([
      [101, "sell"],
      [100, "buy"],
    ]);
  });
});

describe("Trades tab (RNTL)", () => {
  const row = (venue: "perpl" | "meridian", block: number, side: "buy" | "sell", price: string, size: bigint): TradeRow => ({ venue, side, priceWad: parseFixed(price, 18)!, sizeWad: size * WAD, block, tMs: undefined, txHash: undefined });

  it("merges both venues newest first, side in words, and turns the Meridian reader on only while shown", async () => {
    const { auth } = makeAuth();
    await auth.init();
    await auth.create();
    const f = fakeLive();
    f.meridian.store.update({ tickSizeWad: 10n ** 12n, lotSizeWad: 100n * WAD });
    f.perpl.store.update({ trades: [row("perpl", 70, "sell", "0.02551", 5n)] });
    const reader = new MeridianTradesReader({ client: { getLogs: async () => [] } as never, orderBook: OB });
    reader.store.set({ rows: [row("meridian", 72, "buy", "0.025864", 300n)], toBlock: 72n, error: undefined });
    const kit: TradeKit = { chart: undefined, accounts: undefined, executor: undefined, focus: new Store(true), trades: reader };
    const view = await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <LiveProvider live={f.live}>
          <AuthProvider controller={auth as AuthController}>
            <TradeProvider kit={kit}>
              <Trades />
            </TradeProvider>
          </AuthProvider>
        </LiveProvider>
      </SafeAreaProvider>,
    );
    expect(reader.active.get()).toBe(true);
    expect(screen.getByTestId("trade-row-0")).toHaveProp("accessibilityLabel", "Meridian: Buy 300 MON at $0.025864, block 72");
    expect(screen.getByTestId("trade-row-1")).toHaveProp("accessibilityLabel", "Perpl: Sell 5 MON at $0.02551, block 70");
    expect(screen.queryByTestId("trades-none-perpl")).toBeNull();
    await act(async () => view.unmount());
    expect(reader.active.get()).toBe(false);
  });

  it("merging two empty venues gives no rows (nothing invented)", () => {
    expect(mergeTrades([], [])).toEqual([]);
  });
});

describe("candles view", () => {
  const P = (o: number, h: number, l: number, c: number, gap?: true): Point => ({ t: 0, o: BigInt(o) * WAD, h: BigInt(h) * WAD, l: BigInt(l) * WAD, priceWad: BigInt(c) * WAD, ...(gap ? { gap } : {}) });
  it("up / down / carried-gap candles go to their own path; a body spans open↔close, a wick high↔low", () => {
    const p = candlePaths([P(10, 14, 9, 12), P(12, 13, 8, 9), P(9, 9, 9, 9, true)], (i) => i * 10, (v) => 100 - v, 4);
    expect(p.up).toBe("M0.0,86.0V91.0M-2.0,88.0H2.0V90.0H-2.0Z");
    expect(p.down).toBe("M10.0,87.0V92.0M8.0,88.0H12.0V91.0H8.0Z");
    expect(p.gap).toMatch(/^M20\.0,91\.0V91\.0/);
  });
  it("the chosen view is remembered; anything unreadable ⇒ line", async () => {
    const m = new Map<string, string>([[CHART_MODE_KEY, "candles"]]);
    const kv = { get: async (k: string) => m.get(k) ?? null, set: async () => undefined, del: async () => undefined };
    expect(await loadPref(kv, CHART_MODE_KEY, ["line", "candles"], "line")).toBe("candles");
    m.set(CHART_MODE_KEY, "???");
    expect(await loadPref(kv, CHART_MODE_KEY, ["line", "candles"], "line")).toBe("line");
    expect(await loadPref({ ...kv, get: () => Promise.reject(new Error("io")) }, CHART_MODE_KEY, ["line", "candles"], "line")).toBe("line");
  });
});
