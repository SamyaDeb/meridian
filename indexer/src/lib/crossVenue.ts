// CrossVenueFunding (K2.2): one row per UTC hour comparing Meridian's realized 1 h APR with the Perpl MON funding rate
// in force. Both venues write the hour they see; the other side is carried from that venue's latest value.
import type { CrossVenueFunding } from "envio";
import type { Ctx } from "./common.js";
import { DEPLOYMENTS } from "../deployments.gen.js";
import { perplChain } from "./perpl.js";

export const HOUR = 3_600n;
export const hourStart = (ts: bigint): bigint => ts - (ts % HOUR);

/** Pure: spread = meridian − perpl when both are known. */
export const spreadAprWad = (meridian: bigint | undefined, perpl: bigint | undefined): bigint | undefined =>
  meridian !== undefined && perpl !== undefined ? meridian - perpl : undefined;

const getRow = (context: Ctx, hour: bigint): Promise<CrossVenueFunding> =>
  context.CrossVenueFunding.getOrCreate({
    id: String(hour),
    hour,
    meridianMarket: undefined,
    meridianAprWad: undefined,
    meridianBlock: undefined,
    perplPerpId: undefined,
    perplAprWad: undefined,
    perplFundingEventBlock: undefined,
    spreadAprWad: undefined,
    updatedBlock: 0n,
  });

/** Meridian product market ticked: its trailing 1 h realized APR becomes the hour's Meridian value. */
export async function recordMeridianHour(context: Ctx, market: string, ts: bigint, block: bigint, apr1hWad: bigint | undefined) {
  const row = await getRow(context, hourStart(ts));
  let { perplPerpId, perplAprWad, perplFundingEventBlock } = row;
  const mon = perplChain(context.chain.id)?.monPerpId;
  if (perplAprWad === undefined && mon !== undefined) {
    const pm = await context.PerplMarket.get(String(mon)); // the Perpl rate still in force this hour
    if (pm?.lastAprWad !== undefined) {
      perplPerpId = pm.perpId;
      perplAprWad = pm.lastAprWad;
      perplFundingEventBlock = pm.lastFundingEventBlock;
    }
  }
  const meridianAprWad = apr1hWad ?? row.meridianAprWad;
  context.CrossVenueFunding.set({
    ...row,
    meridianMarket: market,
    meridianAprWad,
    meridianBlock: block,
    perplPerpId,
    perplAprWad,
    perplFundingEventBlock,
    spreadAprWad: spreadAprWad(meridianAprWad, perplAprWad),
    updatedBlock: block,
  });
}

/** Perpl MON funding event: its annualized rate becomes the hour's Perpl value. */
export async function recordPerplHour(context: Ctx, perpId: bigint, ts: bigint, block: bigint, aprWad: bigint | undefined, feb: bigint) {
  if (aprWad === undefined) return;
  const row = await getRow(context, hourStart(ts));
  let { meridianMarket, meridianAprWad, meridianBlock } = row;
  const ch = DEPLOYMENTS[context.chain.id]?.ClearingHouse;
  if (meridianAprWad === undefined && ch) {
    const m = await context.Market.get(ch); // Meridian's latest trailing 1 h APR (no tick yet this hour)
    if (m?.realizedApr1hWad !== undefined) {
      meridianMarket = m.id;
      meridianAprWad = m.realizedApr1hWad;
      meridianBlock = m.lastFundingBlock;
    }
  }
  context.CrossVenueFunding.set({
    ...row,
    meridianMarket,
    meridianAprWad,
    meridianBlock,
    perplPerpId: perpId,
    perplAprWad: aprWad,
    perplFundingEventBlock: feb,
    spreadAprWad: spreadAprWad(meridianAprWad, aprWad),
    updatedBlock: block,
  });
}
