// Meridian venue read via viem (docs/MFI.md §2, §3.1, §3.3).
import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from "viem";
import { clearingHouseMfiAbi } from "./abi";

const WAD = 10n ** 18n;
/** 1 h at blockTimeMs = 300 (MATH_SPEC §1.1) */
export const MERIDIAN_WINDOW_BLOCKS = 12_000n;
/** fallback windows when the checkpoint ring is younger than 1 h (ring: 1440 × 200 blocks) */
const FALLBACK_WINDOWS = [6_000n, 2_400n, 1_200n, 400n];

export type MeridianRead =
  | { ok: true; aprWad: bigint; windowBlocks: bigint; oiNotionalWad: bigint; markWad: bigint; asOfBlock: bigint; headBlock: bigint }
  | { ok: false; status: "stale" | "unavailable" | "oracle-stale"; reason: string; headBlock?: bigint };

const revertName = (e: unknown): string | undefined => {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
};

type Reader = Pick<PublicClient, "readContract" | "getBlockNumber">;

export async function readMeridianVenue(client: Reader, clearingHouse: Address, opts: { maxLagBlocks?: bigint } = {}): Promise<MeridianRead> {
  const maxLag = opts.maxLagBlocks ?? 200n;
  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch (e) {
    return { ok: false, status: "unavailable", reason: `rpc: ${(e as Error).message.split("\n")[0]}` };
  }
  try {
    const [obs, oi, mark] = await Promise.all([
      client.readContract({ address: clearingHouse, abi: clearingHouseMfiAbi, functionName: "latestObservation", blockNumber: head }),
      client.readContract({ address: clearingHouse, abi: clearingHouseMfiAbi, functionName: "openInterest", blockNumber: head }),
      client.readContract({ address: clearingHouse, abi: clearingHouseMfiAbi, functionName: "markPrice", blockNumber: head }),
    ]);
    const asOfBlock = obs[2];
    if (head - asOfBlock > maxLag) return { ok: false, status: "stale", reason: `observation at ${asOfBlock}, head ${head}`, headBlock: head };
    let aprWad: bigint | undefined;
    let windowBlocks = MERIDIAN_WINDOW_BLOCKS;
    for (const w of [MERIDIAN_WINDOW_BLOCKS, ...FALLBACK_WINDOWS]) {
      try {
        aprWad = await client.readContract({ address: clearingHouse, abi: clearingHouseMfiAbi, functionName: "averageFundingApr", args: [w], blockNumber: head });
        windowBlocks = w;
        break;
      } catch (e) {
        if (revertName(e) !== "ObservationTooOld") throw e;
      }
    }
    if (aprWad === undefined) return { ok: false, status: "stale", reason: "no checkpoint history yet", headBlock: head };
    // MATH_SPEC: OI is per side (long = short); notional floors (weights only, MFI.md §3.3)
    return { ok: true, aprWad, windowBlocks, oiNotionalWad: (oi[0] * mark) / WAD, markWad: mark, asOfBlock, headBlock: head };
  } catch (e) {
    if (revertName(e) === "OracleStale") return { ok: false, status: "oracle-stale", reason: "OracleStale", headBlock: head };
    return { ok: false, status: "unavailable", reason: `read: ${(e as Error).message.split("\n")[0]}`, headBlock: head };
  }
}
