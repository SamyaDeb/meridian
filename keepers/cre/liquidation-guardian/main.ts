// W1 liquidation guardian: a Chainlink CRE backstop for Meridian's TS keeper.
// Triggers: EVM log (oracle PriceUpdated on each market's oracle: a price move is when accounts cross maintenance)
// and a cron fallback. Callback: candidates from bounded sources (recent PositionChanged logs ≤ 100 blocks, optional
// indexer query under DON consensus, configured watch list) → EVM-read getAccount to CONFIRM each is liquidatable →
// report LIQUIDATE(ch, accounts ≤ 32) → MeridianKeeperReceiver liquidates (sized to its own headroom onchain) →
// report UNWIND(ch) so the receiver closes what it inherited with a reduce-only IOC at index ± 1%.
import {
  CronCapability,
  HTTPClient,
  Runner,
  consensusIdenticalAggregation,
  bytesToHex,
  handler,
  hexToBase64,
  ok,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeEventLog, getAddress, stringToHex, toEventSelector, type Address, type Hex } from "viem";
import { z } from "zod";
import { clearingHouseAbi, oracleAbi } from "../shared/abi";
import { ReadBudget, deliver, evmClientFor, headBlock, logs, read } from "../shared/cre";
import { indexerQuery, mergeCandidates, openFromPositionChanges, parseIndexerAccounts, selectLiquidations, type AccountSnapshot } from "../shared/liquidation";
import { liquidateReport, unwindReport } from "../shared/report";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const configSchema = z.object({
  chainSelectorName: z.string(),
  receiver: address,
  /** the forwarder the receiver trusts (simulation: MockKeystoneForwarder); used as `from` for the gas estimate */
  forwarder: address,
  /** ≤ 2 markets: 5 log-trigger addresses max, and 15 reads per run shared between them */
  markets: z.array(z.object({ name: z.string(), clearingHouse: address, oracle: address, lotSize: z.string() })).min(1).max(2),
  schedule: z.string(),
  /** PositionChanged lookback (≤ 100 blocks, CRE LogQueryBlockLimit) */
  lookbackBlocks: z.number().int().min(1).max(100),
  /** Envio GraphQL endpoint (public); empty = not used */
  indexerUrl: z.string(),
  watchAccounts: z.array(address),
  /** gas: forwarder overhead added to the receiver estimate; fallback when the estimate fails; cap */
  forwarderOverheadGas: z.string(),
  fallbackGas: z.string(),
  maxGas: z.string(),
  unwind: z.boolean(),
});
type Config = z.infer<typeof configSchema>;

const POSITION_CHANGED = toEventSelector("PositionChanged(address,int256,int256,uint256,int256,int256,bool)");
const PRICE_UPDATED = toEventSelector("PriceUpdated(uint256,uint256,uint8)");

/** Indexer candidates for one market, identical across nodes (sorted) or none. */
function fetchIndexer(sendRequester: HTTPSendRequester, url: string, market: string): string {
  const res = sendRequester
    .sendRequest({ url, method: "POST", body: hexToBase64(stringToHex(indexerQuery(market as Address, 64))), multiHeaders: { "content-type": { values: ["application/json"] } }, timeout: "5s" })
    .result();
  if (!ok(res)) return "";
  const body = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
  return parseIndexerAccounts(body, market as Address)
    .map((a) => a.toLowerCase())
    .sort()
    .join(",");
}

function guard(runtime: Runtime<Config>, why: string): string {
  const cfg = runtime.config;
  const evm = evmClientFor(cfg.chainSelectorName);
  const budget = new ReadBudget();
  const receiver = getAddress(cfg.receiver);
  const head = headBlock(runtime, evm, budget);
  runtime.log(`guardian: ${why} at block ${head}`);
  const out: string[] = [];
  // Reads per market: 1 PositionChanged query + up to `perMarket` getAccount + 1 receiver read + estimates (≤ 2).
  const perMarketReads = Math.floor((budget.left - 3 * cfg.markets.length) / cfg.markets.length);
  for (const m of cfg.markets) {
    const ch = getAddress(m.clearingHouse);
    const changes = logs(runtime, evm, budget, ch, POSITION_CHANGED, head - BigInt(cfg.lookbackBlocks) + 1n, head).map((l) => {
      const d = decodeEventLog({ abi: clearingHouseAbi, eventName: "PositionChanged", topics: l.topics as [Hex, ...Hex[]], data: l.data });
      return { account: d.args.account, newSize: d.args.newSize };
    });
    let fromIndexer: string[] = [];
    if (cfg.indexerUrl !== "") {
      const joined = new HTTPClient().sendRequest(runtime, fetchIndexer, consensusIdenticalAggregation<string>().withDefault(""))(cfg.indexerUrl, ch).result();
      fromIndexer = joined === "" ? [] : joined.split(",");
    }
    const candidates = mergeCandidates([cfg.watchAccounts, openFromPositionChanges(changes), fromIndexer], receiver, Math.max(0, perMarketReads));
    const snaps: AccountSnapshot[] = [];
    for (const a of candidates) {
      const v = read<{ size: bigint; equity: bigint; maintenanceMargin: bigint; liquidatable: boolean }>(runtime, evm, budget, ch, clearingHouseAbi, "getAccount", [a], head);
      snaps.push({ account: a, size: v.size, equity: v.equity, maintenanceMargin: v.maintenanceMargin, liquidatable: v.liquidatable });
    }
    const picks = selectLiquidations(snaps);
    runtime.log(`${m.name}: ${candidates.length} candidates (${changes.length} PositionChanged, ${fromIndexer.length} indexer), ${picks.length} liquidatable`);
    if (picks.length > 0) {
      const r = deliver(runtime, evm, budget, { receiver, forwarder: getAddress(cfg.forwarder), report: liquidateReport(ch, picks), forwarderOverheadGas: BigInt(cfg.forwarderOverheadGas), fallbackGas: BigInt(cfg.fallbackGas), maxGas: BigInt(cfg.maxGas) });
      runtime.log(`${m.name}: LIQUIDATE ${picks.join(",")} tx ${r.txHash} gasLimit ${r.gasLimit} ${r.status}`);
      out.push(`${m.name}:liquidate:${r.txHash}`);
    }
    if (cfg.unwind && budget.left >= 2) {
      const mine = read<{ size: bigint }>(runtime, evm, budget, ch, clearingHouseAbi, "getAccount", [receiver], "latest");
      const lot = BigInt(m.lotSize);
      if ((mine.size < 0n ? -mine.size : mine.size) >= lot) {
        const r = deliver(runtime, evm, budget, { receiver, forwarder: getAddress(cfg.forwarder), report: unwindReport(ch, 2n ** 255n), forwarderOverheadGas: BigInt(cfg.forwarderOverheadGas), fallbackGas: BigInt(cfg.fallbackGas), maxGas: BigInt(cfg.maxGas) });
        runtime.log(`${m.name}: UNWIND ${mine.size} tx ${r.txHash} gasLimit ${r.gasLimit} ${r.status}`);
        out.push(`${m.name}:unwind:${r.txHash}`);
      }
    }
  }
  runtime.log(`reads used ${budget.used}/${budget.limit}`);
  return out.length === 0 ? "nothing to do" : out.join(" ");
}

const onPrice = (runtime: Runtime<Config>, log: EVMLog): string => {
  const d = decodeEventLog({ abi: oracleAbi, eventName: "PriceUpdated", topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]], data: bytesToHex(log.data) });
  return guard(runtime, `PriceUpdated ${d.args.priceWad}`);
};
const onCron = (runtime: Runtime<Config>): string => guard(runtime, "cron");

function initWorkflow(cfg: Config) {
  const evm = evmClientFor(cfg.chainSelectorName);
  return [
    handler(
      evm.logTrigger({
        addresses: cfg.markets.map((m) => hexToBase64(m.oracle as Hex)),
        topics: [{ values: [hexToBase64(PRICE_UPDATED)] }],
        confidence: "CONFIDENCE_LEVEL_LATEST",
      }),
      onPrice,
    ),
    handler(new CronCapability().trigger({ schedule: cfg.schedule }), onCron),
  ];
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
