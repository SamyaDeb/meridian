import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { parseHermesLatest } from "../src/hermes.js";

const ID = "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1" as Hex; // ARCHITECTURE R12
const body = (over: Record<string, unknown> = {}) => ({
  binary: { encoding: "hex", data: ["504e4155aa"] },
  parsed: [{ id: ID.slice(2), price: { price: "2864242", conf: "1500", expo: -8, publish_time: 1_790_000_000 } }],
  ...over,
});

describe("parseHermesLatest", () => {
  it("returns WAD price, publish time and 0x-prefixed update data", () => {
    const u = parseHermesLatest(body(), ID);
    expect(u.point).toEqual({ priceWad: 28_642_420_000_000_000n, publishTime: 1_790_000_000n });
    expect(u.updateData).toEqual(["0x504e4155aa"]);
  });
  it("throws on missing update data, missing feed or unusable price", () => {
    expect(() => parseHermesLatest(body({ binary: { data: [] } }), ID)).toThrow(/binary/);
    expect(() => parseHermesLatest(body({ parsed: [] }), ID)).toThrow(/not in response/);
    const bad = body({ parsed: [{ id: ID.slice(2), price: { price: "-1", expo: -8, publish_time: 1 } }] });
    expect(() => parseHermesLatest(bad, ID)).toThrow(/unusable/);
  });
});
