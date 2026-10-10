// K6 B1: the Earn queue reader. Response shapes follow indexer/schema.graphql (VaultRedeemRequest; Hasura returns
// BigInt as strings and unset optionals as null).
import { describe, expect, it } from "vitest";
import { REDEEMS_QUERY, parseRedeems } from "./redeem";

const ME = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const row = (o: Record<string, unknown>) => ({
  requestId: "1",
  owner: ME,
  receiver: ME,
  shares: "100000000000000000000",
  status: "Pending",
  assets: null,
  unwindCost: null,
  requestedBlock: "1200",
  txHash: "0xaa",
  fulfilTxHash: null,
  claimTxHash: null,
  ...o,
});

describe("REDEEMS_QUERY", () => {
  it("scopes both root fields to one chain and one vault", () => {
    expect(REDEEMS_QUERY.match(/chainId: \{ _eq: \$chainId \}/g)).toHaveLength(2);
    expect(REDEEMS_QUERY.match(/vault: \{ _ilike: \$vault \}/g)).toHaveLength(2);
    expect(REDEEMS_QUERY).toContain('status: { _eq: "Pending" }');
  });
});

describe("parseRedeems", () => {
  it("parses my rows and the pending queue; nulls stay undefined", () => {
    const r = parseRedeems({
      mine: [
        row({ requestId: "3", status: "Claimed", assets: "99950000", unwindCost: "0", fulfilTxHash: "0xbb", claimTxHash: "0xcc" }),
        row({ requestId: "2", status: "Cancelled" }),
        row({}),
      ],
      queue: [{ requestId: "1" }, { requestId: "4" }],
    });
    expect(r.pendingIds).toEqual([1n, 4n]);
    expect(r.mine.map((x) => [x.id, x.status])).toEqual([
      [3n, "claimed"],
      [2n, "cancelled"],
      [1n, "requested"],
    ]);
    expect(r.mine[0]).toMatchObject({ assets: 99_950_000n, unwindCost: 0n, fulfilTxHash: "0xbb", claimTxHash: "0xcc" });
    expect(r.mine[2]!.assets).toBeUndefined();
    expect(r.mine[2]!.fulfilTxHash).toBeUndefined();
  });
  it("refuses garbage instead of showing zeros", () => {
    expect(() => parseRedeems({ mine: [row({ shares: "x" })], queue: [] })).toThrow(/shares/);
    expect(() => parseRedeems({ mine: [row({ status: "Fulfilled" })], queue: [] })).toThrow(/RedeemStatus/);
    expect(() => parseRedeems({ mine: [] })).toThrow(/queue/);
  });
});
