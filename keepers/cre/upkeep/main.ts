// W2 upkeep: a Chainlink CRE backstop for funding pokes and vault rebalances.
// Cron (60 s) → EVM-read each ClearingHouse's fundingState().lastUpdateBlock and the vault's needsRebalance() →
// report FUNDING_POKE(stale markets) and/or VAULT_REBALANCE(vault) → MeridianKeeperReceiver. The TS keeper keeps the
// funding gap ≤ 20 blocks; this fires only when it has fallen behind (maxGapBlocks), so in normal operation W2 costs
// reads only.
import { CronCapability, Runner, handler, type Runtime } from "@chainlink/cre-sdk";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { clearingHouseAbi, vaultAbi } from "../shared/abi";
import { ReadBudget, deliver, evmClientFor, headBlock, read } from "../shared/cre";
import { fundingPokeReport, vaultRebalanceReport } from "../shared/report";
import { fundingStale, rebalanceReasonName } from "../shared/upkeep";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const configSchema = z.object({
  chainSelectorName: z.string(),
  receiver: address,
  forwarder: address,
  clearingHouses: z.array(address).min(1).max(8),
  /** empty = no vault upkeep */
  vault: z.string(),
  schedule: z.string(),
  maxGapBlocks: z.string(),
  /** true: poke every market every run (evidence runs); false: only stale ones */
  forcePoke: z.boolean(),
  forwarderOverheadGas: z.string(),
  fallbackGas: z.string(),
  maxGas: z.string(),
});
type Config = z.infer<typeof configSchema>;

const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const evm = evmClientFor(cfg.chainSelectorName);
  const budget = new ReadBudget();
  const head = headBlock(runtime, evm, budget);
  const gas = { receiver: getAddress(cfg.receiver), forwarder: getAddress(cfg.forwarder), forwarderOverheadGas: BigInt(cfg.forwarderOverheadGas), fallbackGas: BigInt(cfg.fallbackGas), maxGas: BigInt(cfg.maxGas) };
  const out: string[] = [];

  const stale: Address[] = [];
  for (const c of cfg.clearingHouses) {
    const ch = getAddress(c);
    const fs = read<{ lastUpdateBlock: bigint }>(runtime, evm, budget, ch, clearingHouseAbi, "fundingState", [], head);
    const gap = head - fs.lastUpdateBlock;
    runtime.log(`${ch}: last funding update ${fs.lastUpdateBlock}, gap ${gap} blocks`);
    if (cfg.forcePoke || fundingStale(head, fs.lastUpdateBlock, BigInt(cfg.maxGapBlocks))) stale.push(ch);
  }
  if (stale.length > 0) {
    const r = deliver(runtime, evm, budget, { ...gas, report: fundingPokeReport(stale) });
    runtime.log(`FUNDING_POKE ${stale.join(",")} tx ${r.txHash} gasLimit ${r.gasLimit} ${r.status}`);
    out.push(`poke:${r.txHash}`);
  }

  if (cfg.vault !== "") {
    const vault = getAddress(cfg.vault);
    const reason = read<number>(runtime, evm, budget, vault, vaultAbi, "needsRebalance", [], head);
    runtime.log(`vault ${vault}: needsRebalance = ${rebalanceReasonName(reason)}`);
    if (reason !== 0) {
      const r = deliver(runtime, evm, budget, { ...gas, report: vaultRebalanceReport(vault) });
      runtime.log(`VAULT_REBALANCE (${rebalanceReasonName(reason)}) tx ${r.txHash} gasLimit ${r.gasLimit} ${r.status}`);
      out.push(`rebalance:${r.txHash}`);
    }
  }
  runtime.log(`reads used ${budget.used}/${budget.limit}`);
  return out.length === 0 ? "nothing to do" : out.join(" ");
};

function initWorkflow(cfg: Config) {
  return [handler(new CronCapability().trigger({ schedule: cfg.schedule }), onCron)];
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
