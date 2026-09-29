// IOrderBook events. The same ABI is deployed twice: perp book (OrderBook) and funding-swap book (SwapOrderBook).
import { indexer, type Candle1m } from "envio";
import {
  FIELDS,
  type Ctx,
  type BookKind,
  evId,
  blockOf,
  tsOf,
  getMarket,
  getSwapStats,
  touchAccount,
  updateProtocol,
  resolveBookMarket,
  underlyingPerpMarket,
} from "../lib/common.js";
import { WAD, bucketStart, swapPriceToAprWad, max, min } from "../lib/math.js";

type Base = {
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string };
};
type Placed = Base & {
  readonly params: {
    readonly orderId: bigint;
    readonly maker: string;
    readonly isBid: boolean;
    readonly tick: bigint;
    readonly lots: bigint;
    readonly flags: bigint;
  };
};
type Closed = Base & { readonly params: { readonly orderId: bigint; readonly maker: string; readonly remainingLots: bigint } };
type TradeEv = Base & {
  readonly params: {
    readonly makerOrderId: bigint;
    readonly maker: string;
    readonly taker: string;
    readonly takerIsBid: boolean;
    readonly tick: bigint;
    readonly lots: bigint;
    readonly priceWad: bigint;
    readonly sizeWad: bigint;
  };
};

const orderId = (book: string, id: bigint) => `${book}-${id}`;

async function onPlaced(event: Placed, context: Ctx, kind: BookKind) {
  const p = event.params;
  const block = blockOf(event);
  await touchAccount(context, p.maker, block, tsOf(event));
  context.Order.set({
    id: orderId(event.srcAddress, p.orderId),
    book: event.srcAddress,
    kind,
    market: await resolveBookMarket(context, event.srcAddress, kind),
    orderId: p.orderId,
    maker: p.maker,
    isBid: p.isBid,
    tick: p.tick,
    lots: p.lots,
    remainingLots: p.lots,
    filledLots: 0n,
    flags: Number(p.flags),
    status: "Open",
    placedBlock: block,
    updatedBlock: block,
  });
}

async function onClosed(event: Closed, context: Ctx, status: "Cancelled" | "Evicted") {
  const o = await context.Order.get(orderId(event.srcAddress, event.params.orderId));
  if (!o) return; // placed before the indexer's start block
  context.Order.set({ ...o, status, remainingLots: event.params.remainingLots, updatedBlock: blockOf(event) });
}

async function upsertCandle(
  context: Ctx,
  entity: "Candle1m" | "Candle1h",
  market: string,
  start: bigint,
  price: bigint,
  size: bigint,
  notional: bigint,
) {
  const id = `${market}-${start}`;
  const store = context[entity];
  const c: Candle1m | undefined = await store.get(id);
  store.set(
    c
      ? {
          ...c,
          high: max(c.high, price),
          low: min(c.low, price),
          close: price,
          volumeBaseWad: c.volumeBaseWad + size,
          volumeQuoteWad: c.volumeQuoteWad + notional,
          trades: c.trades + 1,
        }
      : {
          id,
          market,
          bucketStart: start,
          open: price,
          high: price,
          low: price,
          close: price,
          volumeBaseWad: size,
          volumeQuoteWad: notional,
          trades: 1,
        },
  );
}

async function onTrade(event: TradeEv, context: Ctx, kind: BookKind) {
  const p = event.params;
  const block = blockOf(event);
  const ts = tsOf(event);
  const market = await resolveBookMarket(context, event.srcAddress, kind);
  const notional = (p.sizeWad * p.priceWad) / WAD; // display volume, rounds down

  const o = await context.Order.get(orderId(event.srcAddress, p.makerOrderId));
  if (o) {
    const remaining = o.remainingLots > p.lots ? o.remainingLots - p.lots : 0n;
    context.Order.set({
      ...o,
      remainingLots: remaining,
      filledLots: o.filledLots + p.lots,
      status: remaining === 0n ? "Filled" : "PartiallyFilled",
      updatedBlock: block,
    });
  }

  const aprWad = kind === "Swap" ? swapPriceToAprWad(p.priceWad) : undefined;
  context.Trade.set({
    id: evId(event),
    kind,
    book: event.srcAddress,
    market_id: kind === "Perp" ? market : undefined,
    swapMarket: kind === "Swap" ? market : undefined,
    makerOrderId: p.makerOrderId,
    maker: p.maker,
    taker: p.taker,
    takerIsBid: p.takerIsBid,
    tick: p.tick,
    lots: p.lots,
    priceWad: p.priceWad,
    sizeWad: p.sizeWad,
    notionalWad: notional,
    aprWad,
    block,
    timestamp: ts,
    txHash: event.transaction.hash,
  });

  for (const who of p.maker === p.taker ? [p.maker] : [p.maker, p.taker]) {
    const acc = await touchAccount(context, who, block, ts);
    context.Account.set({ ...acc, volumeQuoteWad: acc.volumeQuoteWad + notional });
  }

  if (kind === "Perp") {
    const m = await getMarket(context, market);
    context.Market.set({
      ...m,
      lastTradePrice: p.priceWad,
      volumeBaseWad: m.volumeBaseWad + p.sizeWad,
      volumeQuoteWad: m.volumeQuoteWad + notional,
      tradeCount: m.tradeCount + 1,
    });
    await upsertCandle(context, "Candle1m", market, bucketStart(ts, 60n), p.priceWad, p.sizeWad, notional);
    await upsertCandle(context, "Candle1h", market, bucketStart(ts, 3_600n), p.priceWad, p.sizeWad, notional);
    await updateProtocol(context, (s) => ({ perpVolumeQuoteWad: s.perpVolumeQuoteWad + notional, trades: s.trades + 1 }));
  } else {
    const st = await getSwapStats(context, market);
    const perp = underlyingPerpMarket(context);
    const pm = perp ? await context.Market.get(perp) : undefined;
    context.SwapStats.set({
      ...st,
      markAprWad: aprWad ?? st.markAprWad,
      lastTradeBlock: block,
      realizedApr8hWad: pm?.realizedApr8hWad ?? st.realizedApr8hWad,
      volumeWad: st.volumeWad + p.sizeWad, // MON notional units (MATH_SPEC §6.1)
      tradeCount: st.tradeCount + 1,
    });
    await updateProtocol(context, (s) => ({ swapVolumeWad: s.swapVolumeWad + p.sizeWad, trades: s.trades + 1 }));
  }
}

indexer.onEvent({ contract: "OrderBook", event: "OrderPlaced", fields: FIELDS }, ({ event, context }) =>
  onPlaced(event, context, "Perp"),
);
indexer.onEvent({ contract: "OrderBook", event: "OrderCancelled", fields: FIELDS }, ({ event, context }) =>
  onClosed(event, context, "Cancelled"),
);
indexer.onEvent({ contract: "OrderBook", event: "OrderEvicted", fields: FIELDS }, ({ event, context }) =>
  onClosed(event, context, "Evicted"),
);
indexer.onEvent({ contract: "OrderBook", event: "Trade", fields: FIELDS }, ({ event, context }) =>
  onTrade(event, context, "Perp"),
);

indexer.onEvent({ contract: "SwapOrderBook", event: "OrderPlaced", fields: FIELDS }, ({ event, context }) =>
  onPlaced(event, context, "Swap"),
);
indexer.onEvent({ contract: "SwapOrderBook", event: "OrderCancelled", fields: FIELDS }, ({ event, context }) =>
  onClosed(event, context, "Cancelled"),
);
indexer.onEvent({ contract: "SwapOrderBook", event: "OrderEvicted", fields: FIELDS }, ({ event, context }) =>
  onClosed(event, context, "Evicted"),
);
indexer.onEvent({ contract: "SwapOrderBook", event: "Trade", fields: FIELDS }, ({ event, context }) =>
  onTrade(event, context, "Swap"),
);
