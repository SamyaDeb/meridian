import { hslToHex, identicon, IDENTICON_SIZE, walletLabel, walletSpoken } from "../../wallet/identity";

const A = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";
const B = "0xFC76000000000000000000000000000000007775";

describe("wallet identity", () => {
  it("label is the last four hex digits, lower case, never the full address", () => {
    expect(walletLabel(A)).toBe("Wallet ••a8f9");
    expect(walletLabel(A)).not.toContain("0x");
    expect(walletSpoken(A)).toBe("Wallet ending a 8 f 9");
  });

  it("identicon is deterministic and ignores checksum casing", () => {
    expect(identicon(A)).toEqual(identicon(A));
    expect(identicon(A.toLowerCase())).toEqual(identicon(A));
  });

  it("identicon is mirrored, non-empty, and differs between wallets", () => {
    const a = identicon(A);
    expect(a.cells).toHaveLength(IDENTICON_SIZE * IDENTICON_SIZE);
    for (let r = 0; r < IDENTICON_SIZE; r++) for (let c = 0; c < IDENTICON_SIZE; c++) expect(a.cells[r * IDENTICON_SIZE + c]).toBe(a.cells[r * IDENTICON_SIZE + (IDENTICON_SIZE - 1 - c)]);
    expect(a.cells.some(Boolean)).toBe(true);
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
    const b = identicon(B);
    expect(b.cells.join() !== a.cells.join() || b.color !== a.color).toBe(true);
  });

  it("hslToHex known points", () => {
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
    expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
    expect(hslToHex(0, 0, 1)).toBe("#ffffff");
  });
});
