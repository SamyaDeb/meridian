// CRE SDK glue shared by the three workflows: EVM reads under the 15-reads-per-run quota, report delivery to
// MeridianKeeperReceiver with gas limit = estimate × 1.2. Not unit-tested (needs the WASM runtime); exercised by
// `cre workflow simulate` (keepers/cre/evidence/).
import {
  EVMClient,
  LATEST_BLOCK_NUMBER,
  TxStatus,
  blockNumber as bn,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  prepareReportRequest,
  protoBigIntToBigint,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { gasLimitFor } from "./report";

/** CRE quota PerWorkflow.ChainRead.CallLimit (service quotas). The workflows budget their reads against it. */
export const CHAIN_READ_LIMIT = 15;
/** CRE quota PerWorkflow.ChainRead.LogQueryBlockLimit. */
export const LOG_QUERY_BLOCK_LIMIT = 100n;

export function evmClientFor(chainSelectorName: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName, isTestnet: chainSelectorName.includes("testnet") });
  if (!network) throw new Error(`network not found: ${chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
}

/** Counts EVM reads so a run never exceeds the quota (a quota breach fails the whole execution). */
export class ReadBudget {
  used = 0;
  constructor(readonly limit = CHAIN_READ_LIMIT) {}
  get left(): number {
    return this.limit - this.used;
  }
  take(n = 1): void {
    if (this.used + n > this.limit) throw new Error(`read budget exceeded (${this.used + n} > ${this.limit})`);
    this.used += n;
  }
}

function big(x: unknown): bigint {
  if (typeof x === "bigint") return x;
  if (x && typeof x === "object" && "absVal" in x) return protoBigIntToBigint(x as Parameters<typeof protoBigIntToBigint>[0]);
  return 0n;
}

export function headBlock(runtime: Runtime<unknown>, evm: EVMClient, budget: ReadBudget): bigint {
  budget.take();
  const h = evm.headerByNumber(runtime, { blockNumber: LATEST_BLOCK_NUMBER }).result();
  return big(h.header?.blockNumber);
}

/** eth_call a view at `atBlock` and decode it with viem. */
export function read<T>(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  budget: ReadBudget,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  atBlock: bigint | "latest",
): T {
  budget.take();
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const blockNumber = atBlock === "latest" ? LATEST_BLOCK_NUMBER : bn(atBlock);
  const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber }).result();
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(reply.data) } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

export type RawLog = { topics: Hex[]; data: Hex; blockNumber: bigint };

/** Logs of `address` with topic0 = `topic0` in [from, to] (≤ LOG_QUERY_BLOCK_LIMIT blocks). */
export function logs(runtime: Runtime<unknown>, evm: EVMClient, budget: ReadBudget, address: Address, topic0: Hex, from: bigint, to: bigint): RawLog[] {
  if (to < from) return [];
  if (to - from + 1n > LOG_QUERY_BLOCK_LIMIT) from = to - LOG_QUERY_BLOCK_LIMIT + 1n;
  budget.take();
  const reply = evm
    .filterLogs(runtime, {
      filterQuery: { fromBlock: bn(from), toBlock: bn(to), addresses: [hexToBase64(address)], topics: [{ topic: [hexToBase64(topic0)] }] },
    })
    .result();
  return reply.logs.map((l) => ({ topics: l.topics.map((t) => bytesToHex(t)), data: bytesToHex(l.data), blockNumber: big(l.blockNumber) }));
}

export type DeliverResult = { txHash: Hex; gasLimit: bigint; status: string };

/**
 * Sign `report` with the DON and deliver it to the receiver through the forwarder. Gas limit: the receiver's own
 * execution estimated as an `onReport` call from the forwarder, plus the forwarder's overhead, × 1.2 (Monad bills the
 * limit). A failed estimate (e.g. the report would revert) falls back to `fallbackGas` so the write still reports why.
 */
export function deliver(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  budget: ReadBudget,
  opts: { receiver: Address; forwarder: Address; report: Hex; forwarderOverheadGas: bigint; fallbackGas: bigint; maxGas: bigint },
): DeliverResult {
  let estimate: bigint;
  try {
    budget.take();
    const data = encodeFunctionData({
      abi: [{ type: "function", name: "onReport", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "bytes" }], outputs: [] }],
      functionName: "onReport",
      args: ["0x", opts.report],
    });
    estimate = evm.estimateGas(runtime, { msg: encodeCallMsg({ from: opts.forwarder, to: opts.receiver, data }) }).result().gas;
    estimate += opts.forwarderOverheadGas;
  } catch {
    estimate = opts.fallbackGas;
  }
  let gasLimit = gasLimitFor(estimate);
  if (gasLimit > opts.maxGas) gasLimit = opts.maxGas;
  const signed = runtime.report(prepareReportRequest(opts.report)).result();
  const w = evm.writeReport(runtime, { receiver: opts.receiver, report: signed, gasConfig: { gasLimit: gasLimit.toString() } }).result();
  const txHash = bytesToHex(w.txHash ?? new Uint8Array(32));
  const status = w.txStatus === TxStatus.SUCCESS ? "success" : `${String(w.txStatus)}${w.errorMessage ? `: ${w.errorMessage}` : ""}`;
  return { txHash, gasLimit, status };
}
