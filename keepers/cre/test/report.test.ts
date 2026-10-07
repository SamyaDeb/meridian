import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, type Address } from "viem";
import { Action, MAX_BATCH, encodeReport, fundingPokeReport, gasLimitFor, liquidateReport, mfiPublishReport, unwindReport, vaultRebalanceReport } from "../shared/report";

const CH = getAddress("0x1f90b5eb6d59adae2be147b3903c7acb4c16a6ea");
const A = getAddress("0x00000000000000000000000000000000000000a1");

const outer = (r: `0x${string}`) => decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], r);

describe("report encoding (abi.encode(uint8 action, bytes payload))", () => {
  it("action ids match IMeridianKeeperReceiver", () => {
    expect(Action).toEqual({ VAULT_REBALANCE: 1, LIQUIDATE: 2, FUNDING_POKE: 3, ORACLE_UPDATE: 4, UNWIND: 5, MFI_PUBLISH: 6 });
  });

  it("LIQUIDATE round-trips (address, address[])", () => {
    const [action, payload] = outer(liquidateReport(CH, [A]));
    expect(action).toBe(2);
    const [ch, accounts] = decodeAbiParameters([{ type: "address" }, { type: "address[]" }], payload);
    expect(ch).toBe(CH);
    expect(accounts).toEqual([A]);
  });

  it("LIQUIDATE refuses an empty batch and more than MAX_BATCH (the receiver would revert BatchTooLarge)", () => {
    expect(() => liquidateReport(CH, [])).toThrow(RangeError);
    expect(() => liquidateReport(CH, Array<Address>(MAX_BATCH + 1).fill(A))).toThrow(RangeError);
    expect(() => liquidateReport(CH, Array<Address>(MAX_BATCH).fill(A))).not.toThrow();
  });

  it("FUNDING_POKE, VAULT_REBALANCE, UNWIND payloads", () => {
    const [a3, p3] = outer(fundingPokeReport([CH, A]));
    expect(a3).toBe(3);
    expect(decodeAbiParameters([{ type: "address[]" }], p3)[0]).toEqual([CH, A]);
    expect(() => fundingPokeReport([])).toThrow(RangeError);
    const [a1, p1] = outer(vaultRebalanceReport(A));
    expect(a1).toBe(1);
    expect(decodeAbiParameters([{ type: "address" }], p1)[0]).toBe(A);
    const [a5, p5] = outer(unwindReport(CH, 2n ** 255n));
    expect(a5).toBe(5);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p5)).toEqual([CH, 2n ** 255n]);
  });

  it("MFI_PUBLISH carries signed APRs and the two blocks", () => {
    const [a6, p6] = outer(mfiPublishReport(A, { mfiAprWad: -5n, meridianAprWad: -10n, perplAprWad: 3n, blockNumber: 69_000_000n, perplFundingBlock: 68_999_000n }));
    expect(a6).toBe(6);
    const d = decodeAbiParameters(
      [{ type: "address" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "uint64" }, { type: "uint64" }],
      p6,
    );
    expect(d).toEqual([A, -5n, -10n, 3n, 69_000_000n, 68_999_000n]);
  });

  it("matches the Solidity layout byte for byte (abi.encode(uint8(3), abi.encode(address[]([ch]))))", () => {
    // cast abi-encode "f(uint8,bytes)" 3 $(cast abi-encode "f(address[])" "[0x1F90…a6eA]")
    const expected =
      "0x0000000000000000000000000000000000000000000000000000000000000003" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "0000000000000000000000000000000000000000000000000000000000000060" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000001f90b5eb6d59adae2be147b3903c7acb4c16a6ea";
    expect(fundingPokeReport([CH])).toBe(expected);
    expect(encodeReport(3, "0x")).toMatch(/^0x0{63}3/);
  });

  it("gas limit = ceil(estimate × 1.2) (Monad bills the limit)", () => {
    expect(gasLimitFor(100n)).toBe(120n);
    expect(gasLimitFor(101n)).toBe(122n);
    expect(gasLimitFor(2_283_598n)).toBe(2_740_318n);
  });
});
