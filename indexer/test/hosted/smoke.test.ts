// Hosted-config smoke (`pnpm test:hosted`): codegen + handlers loaded against config.hosted.testnet.yaml, the file Envio
// Cloud runs. Envio throws at registration for an event the config doesn't list, so this catches a handler set that
// would crash the deployment (the lean Perpl profile leaves positions / mark / collateral out). Both chains, real
// addresses, a recorded Perpl funding event and a Meridian funding tick.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const perpl = JSON.parse(readFileSync(new URL("../../../deployments/perpl.json", import.meta.url), "utf8"));
const dep = JSON.parse(readFileSync(new URL("../../../deployments/10143.json", import.meta.url), "utf8"));
const checksum = (a: string) => a as `0x${string}`;

describe("config.hosted.testnet.yaml", () => {
  it("loads every handler and indexes Meridian (10143) + Perpl (10143, 143)", async () => {
    const indexer = createTestIndexer();
    const funding = (chain: string, perpId: bigint, feb: bigint) => ({
      contract: "PerplExchange" as const,
      event: "FundingEventCompleted" as const,
      srcAddress: checksum(perpl.chains[chain].exchange),
      block: { number: Number(feb) - 78, timestamp: 1_791_380_000 },
      params: { perpId, fundingEventBlock: feb, specifiedRatePct100k: -4n, actualRatePct100k: -4n, fundingPricePNS: 2_877n, fundingPaymentPNS: -115n, fundingSumPNS: -22_301n, allowOverwrite: false },
    });
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            funding("10143", 64n, 68_747_991n),
            {
              contract: "ClearingHouse",
              event: "FundingUpdated",
              srcAddress: checksum(dep.contracts.ClearingHouse),
              block: { number: 68_750_000, timestamp: 1_791_381_000 },
              params: { blockNumber: 68_750_000n, premium: 0n, emaPremium: 0n, rate: 0n, cumFunding: 1n, cumIndexTime: 1n, indexPriceWad: 10n ** 18n, markPriceWad: 10n ** 18n },
            },
          ],
        },
        143: { simulate: [funding("143", 10n, 111_045_877n)] },
      },
    } as never);
    expect((await indexer.PerplFunding.getAll()).map((f) => String(f.perpId)).sort()).toEqual(["10", "64"]);
    expect((await indexer.Market.getAll()).length).toBe(1);
  });
});
