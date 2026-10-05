import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { billedGasFromCsv, planLoad, rpcTier } from "../src/dryrun.js";
import { loadMix } from "../src/stats.js";

describe("rpcTier: reports name a tier, never the URL", () => {
  it("local, public (R2/R29), private", () => {
    expect(rpcTier("http://127.0.0.1:8545")).toBe("local");
    expect(rpcTier("https://rpc.monad.xyz")).toBe("public");
    expect(rpcTier("https://testnet-rpc.monad.xyz/")).toBe("public");
    expect(rpcTier("https://monad-mainnet.g.example.com/v2/SECRET")).toBe("private");
    expect(rpcTier("not a url")).toBe("private");
  });
});

describe("planLoad mirrors load.ts", () => {
  const billed = billedGasFromCsv(readFileSync(new URL("../out/gas_onchain_10143_2026-09-30.csv", import.meta.url), "utf8"));
  it("reads the measured testnet billed limits", () => {
    expect(billed.get("place")).toBe(230_865n);
    expect(billed.get("cancel")).toBe(140_426n);
    expect(billed.get("match_1_fill")).toBe(281_592n);
  });
  it("per-K op split from loadMix(txs, 42 + k), limits × 2, setup per K", () => {
    const p = planLoad({ ks: [1, 2], txs: 60, wallets: 3, billed, gasPriceWei: 100n * 10n ** 9n });
    for (const r of p.perK) {
      const mix = loadMix(60, 42 + r.k);
      expect(r.place + r.cancel + r.market).toBe(60);
      expect(r.place).toBe(mix.filter((x) => x === "place").length);
      expect(r.gasLimit).toBe(BigInt(r.place) * 461_730n + BigInt(r.cancel) * 280_852n + BigInt(r.market) * 563_184n);
    }
    expect(p.loadTxs).toBe(120);
    expect(p.setupTxs).toBe(3 * 1 * 2 + 3 * 2 * 2);
    expect(p.loadMonMilli).toBe((p.loadGasLimit * 100n * 10n ** 9n * 1000n) / 10n ** 18n);
  });
  it("refuses an op without a measured price", () => {
    expect(() => planLoad({ ks: [1], txs: 10, wallets: 1, billed: new Map(), gasPriceWei: 1n })).toThrow(/no billed gas/);
  });
});
