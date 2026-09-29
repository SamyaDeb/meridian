import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, WAD, blk } from "./helpers.js";

const placed = (src: `0x${string}`, block: number, orderId: bigint, maker: `0x${string}`, lots = 10n, tick = 300n) => ({
  contract: (src === A.OB ? "OrderBook" : "SwapOrderBook") as "OrderBook",
  event: "OrderPlaced" as const,
  srcAddress: src,
  block: blk(block),
  params: { orderId, maker, isBid: false, tick, lots, flags: 0n },
});
const trade = (src: `0x${string}`, block: number, makerOrderId: bigint, lots: bigint, priceWad: bigint, sizeWad: bigint, taker = BOB) => ({
  contract: (src === A.OB ? "OrderBook" : "SwapOrderBook") as "OrderBook",
  event: "Trade" as const,
  srcAddress: src,
  block: blk(block),
  transaction: { hash: `0x${block.toString(16).padStart(64, "0")}` },
  params: { makerOrderId, maker: ALICE, taker, takerIsBid: true, tick: 300n, lots, priceWad, sizeWad },
});

describe("perp OrderBook", () => {
  it("order lifecycle: placed → partial fill → filled; cancel and evict", async () => {
    const indexer = createTestIndexer();
    const P = 30n * 10n ** 15n;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            placed(A.OB, 10, 1n, ALICE),
            placed(A.OB, 10, 2n, ALICE),
            placed(A.OB, 10, 3n, BOB),
            trade(A.OB, 11, 1n, 4n, P, 400n * WAD),
            trade(A.OB, 12, 1n, 6n, P + 10n ** 14n, 600n * WAD),
            { contract: "OrderBook", event: "OrderCancelled", srcAddress: A.OB, block: blk(13), params: { orderId: 2n, maker: ALICE, remainingLots: 10n } },
            { contract: "OrderBook", event: "OrderEvicted", srcAddress: A.OB, block: blk(13), params: { orderId: 3n, maker: BOB, remainingLots: 10n } },
            { contract: "OrderBook", event: "OrderCancelled", srcAddress: A.OB, block: blk(14), params: { orderId: 99n, maker: BOB, remainingLots: 1n } }, // unknown: ignored
          ],
        },
      },
    });
    expect(await indexer.Order.getOrThrow(`${A.OB}-1`)).toMatchObject({ kind: "Perp", market: A.CH, status: "Filled", remainingLots: 0n, filledLots: 10n, placedBlock: 10n, updatedBlock: 12n });
    expect((await indexer.Order.getOrThrow(`${A.OB}-2`)).status).toBe("Cancelled");
    expect((await indexer.Order.getOrThrow(`${A.OB}-3`)).status).toBe("Evicted");
    expect(await indexer.Order.get(`${A.OB}-99`)).toBeUndefined();

    const trades = await indexer.Trade.getAll();
    expect(trades).toHaveLength(2);
    expect(trades.find((t) => t.block === 11n)).toMatchObject({ kind: "Perp", market_id: A.CH, notionalWad: 12n * WAD, aprWad: undefined });

    const m = await indexer.Market.getOrThrow(A.CH);
    const n2 = (600n * WAD * (P + 10n ** 14n)) / WAD;
    expect(m).toMatchObject({ tradeCount: 2, volumeBaseWad: 1_000n * WAD, volumeQuoteWad: 12n * WAD + n2, lastTradePrice: P + 10n ** 14n });
    expect((await indexer.Account.getOrThrow(BOB)).volumeQuoteWad).toBe(12n * WAD + n2);
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(s).toMatchObject({ users: 2, trades: 2, perpVolumeQuoteWad: 12n * WAD + n2 });
  });

  it("builds 1m and 1h candles (OHLCV)", async () => {
    const indexer = createTestIndexer();
    const px = [30n, 33n, 29n, 31n].map((x) => x * 10n ** 15n);
    // blocks 100..103 fall in the same minute (0.3 s blocks)
    await indexer.process({ chains: { [CHAIN]: { simulate: px.map((p, i) => trade(A.OB, 100 + i, 0n, 1n, p, WAD)) } } });
    const c = await indexer.Candle1m.getAll();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ market: A.CH, open: px[0], high: px[1], low: px[2], close: px[3], volumeBaseWad: 4n * WAD, trades: 4 });
    expect(c[0]!.bucketStart % 60n).toBe(0n);
    const h = await indexer.Candle1h.getAll();
    expect(h[0]).toMatchObject({ open: px[0], close: px[3], trades: 4 });
  });

  it("resolves the market via BookRef (MarketFactory) before static deployments", async () => {
    const indexer = createTestIndexer();
    const other = "0x2000000000000000000000000000000000000002";
    indexer.BookRef.set({ id: A.OB, kind: "Perp", market: other, chainId: CHAIN });
    await indexer.process({ chains: { [CHAIN]: { simulate: [placed(A.OB, 5, 7n, ALICE)] } } });
    expect((await indexer.Order.getOrThrow(`${A.OB}-7`)).market).toBe(other);
  });
});

describe("funding-swap book (SwapOrderBook)", () => {
  it("records swap trades with APR = price − 1 and updates SwapStats", async () => {
    const indexer = createTestIndexer();
    indexer.BookRef.set({ id: A.SWAP_OB, kind: "Swap", market: A.SWAP, chainId: CHAIN });
    const price = WAD + 12n * 10n ** 16n; // 12% fixed
    await indexer.process({ chains: { [CHAIN]: { simulate: [placed(A.SWAP_OB, 50, 1n, ALICE, 5n, 11_200n), trade(A.SWAP_OB, 51, 1n, 2n, price, 2_000n * WAD)] } } });
    expect((await indexer.Order.getOrThrow(`${A.SWAP_OB}-1`))).toMatchObject({ kind: "Swap", market: A.SWAP, status: "PartiallyFilled", remainingLots: 3n });
    const t = (await indexer.Trade.getAll())[0]!;
    expect(t).toMatchObject({ kind: "Swap", swapMarket: A.SWAP, market_id: undefined, aprWad: 12n * 10n ** 16n });
    expect(await indexer.SwapStats.getOrThrow(A.SWAP)).toMatchObject({ markAprWad: 12n * 10n ** 16n, lastTradeBlock: 51n, volumeWad: 2_000n * WAD, tradeCount: 1 });
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).swapVolumeWad).toBe(2_000n * WAD);
    expect(await indexer.Candle1m.getAll()).toHaveLength(0); // candles are perp-only
  });
});
