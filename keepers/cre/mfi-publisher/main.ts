// W3 MFI publisher: the Meridian Funding Index onchain under DON consensus (CR-016, docs/MFI.md).
// Cron (5 min) → EVM-read Meridian averageFundingApr(12,000 blocks) + openInterest + markPrice; HTTP-read Perpl's MON
// market (context, funding series, ticker) on every node, aggregated by consensus (identical rate / event / interval,
// median OI) → MFI = OI-weighted mean (rounds neutral) → report MFI_PUBLISH → MeridianKeeperReceiver → MeridianMfiFeed.
import {
  ConsensusAggregationByFields,
  CronCapability,
  HTTPClient,
  Runner,
  handler,
  identical,
  median,
  ok,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { getAddress } from "viem";
import { z } from "zod";
import { clearingHouseAbi, mfiFeedAbi } from "../shared/abi";
import { ReadBudget, deliver, evmClientFor, headBlock, read } from "../shared/cre";
import { WAD, computeMfi, fundingInForce, meridianOiNotionalWad, perplFundingPath, perplOiNotionalWad, perplRateToAprWad, type FundingEvent, type Venue } from "../shared/mfi";
import { mfiPublishReport } from "../shared/report";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const configSchema = z.object({
  chainSelectorName: z.string(),
  receiver: address,
  forwarder: address,
  feed: address,
  clearingHouse: address,
  schedule: z.string(),
  /** MFI §3.1: 1 h = 12,000 blocks at 300 ms; shorter fallbacks while the checkpoint ring is young */
  windowsBlocks: z.array(z.string()).min(1).max(4),
  perplBaseUrl: z.string(),
  perplMarketId: z.number().int(),
  perplSymbol: z.string(),
  forwarderOverheadGas: z.string(),
  fallbackGas: z.string(),
  maxGas: z.string(),
});
type Config = z.infer<typeof configSchema>;

type PerplRead = {
  ok: boolean;
  rateMicros: number;
  intervalSec: number;
  feb: number;
  fundingBlock: number;
  /** OI notional in whole AUSD (median across nodes; weights only) */
  oiAusd: number;
};
const NONE: PerplRead = { ok: false, rateMicros: 0, intervalSec: 0, feb: 0, fundingBlock: 0, oiAusd: 0 };

/** One node's Perpl read (MFI §2): market by id + symbol check, interval and decimals from /v1/pub/context. */
function fetchPerpl(s: HTTPSendRequester, base: string, marketId: number, symbol: string, nowMs: number): PerplRead {
  const get = (path: string): unknown => {
    const r = s.sendRequest({ url: `${base}${path}`, method: "GET", timeout: "5s" }).result();
    if (!ok(r)) throw new Error(`perpl ${path}: HTTP ${r.statusCode}`);
    return JSON.parse(new TextDecoder().decode(r.body)) as unknown;
  };
  const ctx = get("/v1/pub/context") as { markets?: Array<{ id: number; symbol: string; name: string; funding_interval_sec: number; config: { price_decimals: number; size_decimals: number } }> };
  const m = ctx.markets?.find((x) => x.id === marketId);
  if (!m || (m.symbol || m.name).toUpperCase() !== symbol.toUpperCase()) return NONE;
  const series = get(perplFundingPath(marketId, nowMs, m.funding_interval_sec)) as { m?: number; d?: FundingEvent[] };
  if (series.m !== marketId || !Array.isArray(series.d)) return NONE;
  const ev = fundingInForce(series.d, nowMs);
  if (!ev) return NONE;
  const tick = get(`/v1/market-data/${marketId}/ticker`) as { d?: Record<string, { oi: number; mrk: number }> };
  const st = tick.d?.[String(marketId)];
  if (!st) return NONE;
  const oiWad = perplOiNotionalWad(BigInt(st.oi), m.config.size_decimals, BigInt(st.mrk), m.config.price_decimals);
  return { ok: true, rateMicros: ev.rate, intervalSec: m.funding_interval_sec, feb: ev.feb, fundingBlock: ev.at.b ?? 0, oiAusd: Number(oiWad / WAD) };
}

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const evm = evmClientFor(cfg.chainSelectorName);
  const budget = new ReadBudget();
  const head = headBlock(runtime, evm, budget);
  const ch = getAddress(cfg.clearingHouse);
  const venues: Venue[] = [];

  // Meridian (EVM reads at the head block)
  let meridianApr: bigint | null = null;
  for (const w of cfg.windowsBlocks) {
    try {
      meridianApr = read<bigint>(runtime, evm, budget, ch, clearingHouseAbi, "averageFundingApr", [BigInt(w)], head);
      runtime.log(`meridian: averageFundingApr(${w}) = ${meridianApr}`);
      break;
    } catch (e) {
      runtime.log(`meridian: averageFundingApr(${w}) unavailable (${String(e).slice(0, 80)})`);
    }
  }
  if (meridianApr !== null) {
    const [longOI] = read<readonly [bigint, bigint]>(runtime, evm, budget, ch, clearingHouseAbi, "openInterest", [], head);
    const mark = read<bigint>(runtime, evm, budget, ch, clearingHouseAbi, "markPrice", [], head);
    venues.push({ aprWad: meridianApr, oiWad: meridianOiNotionalWad(longOI, mark) });
  }

  // Perpl (HTTP on every node, DON consensus)
  const nowMs = runtime.now().getTime();
  const p = new HTTPClient()
    .sendRequest(
      runtime,
      fetchPerpl,
      ConsensusAggregationByFields<PerplRead>({ ok: identical, rateMicros: identical, intervalSec: identical, feb: identical, fundingBlock: identical, oiAusd: median }).withDefault(NONE),
    )(cfg.perplBaseUrl, cfg.perplMarketId, cfg.perplSymbol, nowMs)
    .result();
  let perplApr: bigint | null = null;
  if (p.ok && p.intervalSec > 0) {
    perplApr = perplRateToAprWad(BigInt(p.rateMicros), BigInt(p.intervalSec));
    venues.push({ aprWad: perplApr, oiWad: BigInt(p.oiAusd) * WAD });
    runtime.log(`perpl: market ${cfg.perplMarketId} rate ${p.rateMicros} micros / ${p.intervalSec} s = ${perplApr} APR WAD, event ${p.feb}, OI ≈ ${p.oiAusd} AUSD`);
  } else runtime.log("perpl: not included (unavailable or no consensus)");

  const mfi = computeMfi(venues);
  if (mfi === null) return "no venue available";
  const [, , , lastBlock] = read<readonly [bigint, bigint, bigint, bigint, bigint]>(runtime, evm, budget, getAddress(cfg.feed), mfiFeedAbi, "latest", [], head);
  if (head <= lastBlock) return `feed already at ${lastBlock}`;
  const report = mfiPublishReport(getAddress(cfg.feed), {
    mfiAprWad: mfi,
    meridianAprWad: meridianApr ?? mfi, // an excluded venue is passed equal to the index (IMeridianMfiFeed.publish)
    perplAprWad: perplApr ?? mfi,
    blockNumber: head,
    perplFundingBlock: perplApr === null ? 0n : BigInt(p.fundingBlock),
  });
  const r = deliver(runtime, evm, budget, { receiver: getAddress(cfg.receiver), forwarder: getAddress(cfg.forwarder), report, forwarderOverheadGas: BigInt(cfg.forwarderOverheadGas), fallbackGas: BigInt(cfg.fallbackGas), maxGas: BigInt(cfg.maxGas) });
  runtime.log(`MFI_PUBLISH mfi ${mfi} (meridian ${meridianApr}, perpl ${perplApr}) at ${head} tx ${r.txHash} gasLimit ${r.gasLimit} ${r.status}`);
  runtime.log(`reads used ${budget.used}/${budget.limit}`);
  return `mfi:${mfi}:${r.txHash}`;
};

function initWorkflow(cfg: Config) {
  return [handler(new CronCapability().trigger({ schedule: cfg.schedule }), onCron)];
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
