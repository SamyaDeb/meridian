import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { extractPythUpdates, isLocalRpc } from "../scripts/fork-pyth-relay.js";

// Recorded calldata of a real sponsored Pyth MON/USD update on Monad mainnet (block 110,561,461, tx 0x704749f1…db3e,
// sent to the sponsor's wrapper 0x6f6493e3…b480, selector 0xddd031d9). Public chain data, read 5 Oct 2026.
const input = readFileSync(new URL("./fixtures/pyth-sponsored-update-110561461.hex", import.meta.url), "utf8").trim() as Hex;

describe("extractPythUpdates", () => {
  it("finds the one PNAU payload with its ABI length", () => {
    const u = extractPythUpdates(input);
    expect(u).toHaveLength(1);
    expect(u[0]?.slice(0, 10)).toBe("0x504e4155");
    expect((u[0]!.length - 2) / 2).toBe(0x277); // 631 bytes, the length word in the calldata
  });

  it("ignores calldata without a payload and a length word that overruns", () => {
    expect(extractPythUpdates("0xddd031d9")).toEqual([]);
    const word = (n: number) => n.toString(16).padStart(64, "0");
    const overrun = `0x12345678${word(1000)}504e4155${"0".repeat(56)}` as Hex;
    expect(extractPythUpdates(overrun)).toEqual([]);
  });

  it("finds several payloads in one bytes[]", () => {
    const word = (n: number) => n.toString(16).padStart(64, "0");
    const p = `504e4155${"ab".repeat(28)}`; // 32 bytes
    const two = `0x12345678${word(32)}${p}${word(32)}${p}` as Hex;
    expect(extractPythUpdates(two)).toHaveLength(2);
  });
});

describe("isLocalRpc", () => {
  it("accepts only localhost http", () => {
    expect(isLocalRpc("http://127.0.0.1:8545")).toBe(true);
    expect(isLocalRpc("http://localhost:8545")).toBe(true);
    expect(isLocalRpc("https://rpc.monad.xyz")).toBe(false);
    expect(isLocalRpc("http://127.0.0.1.evil.com:8545")).toBe(false);
  });
});
