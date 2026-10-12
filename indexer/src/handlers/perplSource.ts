// CR-017: PerplFundingSource.Poked, one per Perpl funding event snapshotted for a Perpl-funding swap market
// (docs/PERPL_SWAPS.md, MATH_SPEC §6.8). F and G exactly as the adapter stores them; the interval APR is display-only.
import { indexer } from "envio";
import { FIELDS, evId, blockOf, tsOf, swapMarketsOf } from "../lib/common.js";
import { realizedAprWad } from "../lib/math.js";

indexer.onEvent({ contract: "PerplFundingSource", event: "Poked", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const source = event.srcAddress;
  const block = blockOf(event);
  const swapMarket = swapMarketsOf(context.chain.id).find((w) => w.source?.toLowerCase() === source.toLowerCase())?.swapMarket;
  const prev = await context.PerplFundingSourceState.get(source);
  // MATH_SPEC §1.8 over one Perpl step (§6.8), rounds neutral
  const apr = prev ? realizedAprWad(prev.cumFunding, prev.cumIndexTime, p.cumFunding, p.cumIndexTime) : undefined;
  context.PerplFundingSnapshot.set({
    id: evId(event),
    source,
    swapMarket,
    cumFunding: p.cumFunding,
    cumIndexTime: p.cumIndexTime,
    fundingEventBlock: p.fundingEventBlock,
    priceWad: p.priceWad,
    rateWad: p.rate,
    intervalAprWad: apr,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  context.PerplFundingSourceState.set({
    id: source,
    swapMarket,
    cumFunding: p.cumFunding,
    cumIndexTime: p.cumIndexTime,
    fundingEventBlock: p.fundingEventBlock,
    priceWad: p.priceWad,
    rateWad: p.rate,
    lastIntervalAprWad: apr ?? prev?.lastIntervalAprWad,
    pokes: (prev?.pokes ?? 0) + 1,
    lastPokeBlock: block,
    lastPokeTx: event.transaction.hash,
  });
});
