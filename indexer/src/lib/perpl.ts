// Perpl metadata lookup (seeded snapshot, src/perpl.gen.ts): handlers never fetch it or hard-code it.
import { PERPL, PERPL_TEST, type PerplChain, type PerplMarketMeta } from "../perpl.gen.js";

const TEST_CHAIN = 31337; // vitest (config.test.yaml)

export const perplChain = (chainId: number): PerplChain | undefined => PERPL[chainId] ?? (chainId === TEST_CHAIN ? PERPL_TEST : undefined);

export const perplMeta = (chainId: number, perpId: bigint): PerplMarketMeta | undefined => perplChain(chainId)?.markets[String(perpId)];

/** positionType 0 = Long, 1 = Short (verified: a type-0 position is liquidated when mark falls below its liq price). */
export const perplSide = (positionType: bigint | number): "Long" | "Short" => (Number(positionType) === 0 ? "Long" : "Short");
