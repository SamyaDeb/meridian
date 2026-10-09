// Recorded testnet books (packages/core/fixtures/books/testnet-meridian-69059070.json: Meridian OrderBook depth +
// riskParams at block 69,059,070: bids 600 MON deep, asks only 100 MON; Perpl MON market 64 L2 snapshot, deep) as Earn
// venue inputs. Default APRs: Meridian longs pay more ⇒ short Meridian (into its bids), long Perpl.
import rec from "../../../../packages/core/fixtures/books/testnet-meridian-69059070.json";
import { meridianLevels, perplLevels } from "@meridian/core/route";
import type { EarnVenueInput } from "../../features/earn/plan";

export const WAD = 10n ** 18n;
export const pct = (x: number) => (BigInt(Math.round(x * 100)) * WAD) / 10_000n;

const m = rec.meridian;
const tick = BigInt(m.tickSize);
const lot = BigInt(m.lotSize);
const pm = rec.perpl.market;

export const meridianIn = (o: Partial<EarnVenueInput> = {}): EarnVenueInput => ({
  aprWad: pct(30),
  takerFeeWad: BigInt(m.riskParams.takerFee),
  stepWad: lot,
  priceStepWad: tick,
  priceDp: 3,
  bids: meridianLevels(m.bids.ticks, m.bids.lots.map(BigInt), tick, lot),
  asks: meridianLevels(m.asks.ticks, m.asks.lots.map(BigInt), tick, lot),
  markWad: BigInt(m.markPrice),
  freeWad: 0n,
  walletWad: 1_000n * WAD,
  ready: true,
  imrWad: BigInt(m.riskParams.imr),
  maxLeverage: 5,
  ...o,
});

export const perplIn = (o: Partial<EarnVenueInput> = {}): EarnVenueInput => ({
  aprWad: pct(-15),
  takerFeeWad: 345n * 10n ** 12n,
  stepWad: 10n ** BigInt(18 - pm.sizeDecimals),
  priceStepWad: 10n ** BigInt(18 - pm.priceDecimals),
  priceDp: pm.priceDecimals,
  bids: perplLevels(rec.perpl.book.bid, pm.priceDecimals, pm.sizeDecimals),
  asks: perplLevels(rec.perpl.book.ask, pm.priceDecimals, pm.sizeDecimals),
  markWad: BigInt(rec.perpl.ticker.d["64"].mrk) * 10n ** BigInt(18 - pm.priceDecimals),
  freeWad: 0n,
  walletWad: 1_000n * WAD,
  ready: true,
  maxLeverage: 10,
  ...o,
});

export const LOT = lot;
export const TICK = tick;
