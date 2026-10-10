// N7 Home total + open PnL: aggregation across the wallet and both venues with unknown parts ("—", never a partial
// sum), Perpl equity = balance + position value (dex-sdk: balance excludes open positions), the position bitmap, and
// PnL that matches core's own math. Perpl numbers: the recorded K3 hedge account
// (packages/core/fixtures/perpl/chain/account-10143-k3-hedge.json).
import { perplPositionRisk } from "@meridian/core/route";
import { openPnl, totalAusdWad, venueEquities } from "../../features/home/total";
import { mapMeridian, mapPerpl, perplPerpsWithPosition, type AccountsState, type MeridianAccount } from "../../features/trade/data/accounts";
import { isBasisPair, type PositionView } from "../../features/trade/positions/views";

const WAD = 10n ** 18n;
const CNS = 10n ** 12n;
const P = { exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc" as const, perpId: 64n, priceDecimals: 5, lotDecimals: 0, collateralDecimals: 6 };
// recorded: getAccountByAddr + getPositionV2(64, 969) at block 69,158,851
const K3 = { accountId: 969n, balanceCNS: 4977468132n, lockedBalanceCNS: 0n, positions: { bank1: 18446744073709551616n, bank2: 0n, bank3: 0n, bank4: 0n } };
const K3_POS = [{ positionType: 0, depositCNS: 22508666n, pricePNS: 2587n, priceResiduePNSQ16: 35288n, lotLNS: 2600n, deltaPnlCNS: -1469999n, premiumPnlCNS: -10530n }, 2530n] as const;
const BOTH = { meridian: true, perpl: true };

const meridian = (o: Partial<{ collateral: bigint; size: bigint; upnl: bigint; funding: bigint }> = {}): MeridianAccount => {
  const collateral = o.collateral ?? 100n * WAD;
  const upnl = o.upnl ?? 0n;
  const funding = o.funding ?? 0n;
  return mapMeridian({ collateral, size: o.size ?? 0n, entryPrice: 0n, unrealizedPnl: upnl, pendingFunding: funding, equity: collateral + upnl - funding, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 0n });
};
const acc = (p: Partial<AccountsState>): AccountsState => ({ atBlock: 1n, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined, ...p });

describe("Perpl position bitmap (dex-sdk perpetuals_with_position)", () => {
  it("the recorded K3 account: bank1 = 2^64 ⇔ its one position on perp 64", () => {
    expect(perplPerpsWithPosition(K3.positions)).toEqual([64n]);
  });
  it("bank offsets 0 / 253 / 509 / 765", () => {
    expect(perplPerpsWithPosition({ bank1: 1n, bank2: 1n, bank3: 2n, bank4: 1n << 255n })).toEqual([0n, 253n, 510n, 1020n]);
    expect(perplPerpsWithPosition({ bank1: 0n, bank2: 0n, bank3: 0n, bank4: 0n })).toEqual([]);
  });
});

describe("Perpl equity = balance + position deposit + delta PnL + premium PnL", () => {
  it("K3 hedge account, exact CNS → WAD", () => {
    const a = mapPerpl(K3, K3_POS, 500n, P)!;
    expect(a.balanceWad).toBe(4977468132n * CNS);
    expect(a.equityWad).toBe((4977468132n + 22508666n - 1469999n - 10530n) * CNS);
    expect(a.held).toBe(true);
    expect(a.otherMarkets).toBe(false);
  });
  it("equity doesn't wait for the margin fractions (the risk view does)", () => {
    const a = mapPerpl(K3, K3_POS, undefined, P)!;
    expect(a.position).toBeUndefined();
    expect(a.equityWad).toBe((4977468132n + 21028137n) * CNS);
  });
  it("a position on another market ⇒ unknown, not a partial number", () => {
    const a = mapPerpl({ ...K3, positions: { ...K3.positions, bank1: K3.positions.bank1 | (1n << 16n) } }, K3_POS, 500n, P)!;
    expect(a.otherMarkets).toBe(true);
    expect(a.equityWad).toBeUndefined();
  });
  it("the bitmap says MON is held but the position read failed ⇒ unknown", () => {
    expect(mapPerpl(K3, undefined, 500n, P)!.equityWad).toBeUndefined();
  });
  it("a position worth less than nothing counts as 0 (ADL), the balance stays", () => {
    const sunk = [{ ...K3_POS[0], deltaPnlCNS: -30_000_000n }, 2530n] as const;
    expect(mapPerpl(K3, sunk, 500n, P)!.equityWad).toBe(4977468132n * CNS);
  });
  it("flat account: equity = balance (locked orders included)", () => {
    expect(mapPerpl({ accountId: 5n, balanceCNS: 7_000_000n, lockedBalanceCNS: 2_000_000n }, undefined, 500n, P)!.equityWad).toBe(7n * WAD);
  });
});

describe("Home total", () => {
  const perpl = mapPerpl(K3, K3_POS, 500n, P)!;

  it("wallet + Meridian equity (collateral already inside it) + Perpl equity", () => {
    const m = meridian({ collateral: 100n * WAD, size: 10n * WAD, upnl: 5n * WAD, funding: WAD });
    const v = venueEquities(acc({ meridian: m, perpl }), BOTH);
    expect(v.map((x) => x.equityWad)).toEqual([104n * WAD, perpl.equityWad]);
    expect(totalAusdWad({ walletWad: 12n * WAD, venues: v })).toBe(12n * WAD + 104n * WAD + perpl.equityWad!);
  });

  it("any unknown part ⇒ the total is unknown, and the breakdown says why", () => {
    const reading = venueEquities(acc({ meridian: meridian(), perpl: undefined }), BOTH);
    expect(totalAusdWad({ walletWad: WAD, venues: reading })).toBeUndefined();
    expect(reading[1]).toEqual({ venue: "perpl", equityWad: undefined, why: "Reading…" });
    expect(totalAusdWad({ walletWad: undefined, venues: venueEquities(acc({ meridian: meridian(), perpl: null }), BOTH) })).toBeUndefined();
    const failed = venueEquities(acc({ meridian: undefined, perpl: null, error: "HTTP 429" }), BOTH);
    expect(failed[0]!.why).toBe("Couldn't read it: HTTP 429");
    const other = venueEquities(acc({ meridian: meridian(), perpl: { ...perpl, otherMarkets: true, equityWad: undefined } }), BOTH);
    expect(other[1]!.why).toMatch(/another Perpl market/);
    expect(venueEquities(undefined, BOTH).every((x) => x.equityWad === undefined)).toBe(true);
  });

  it("no Perpl account ⇒ 0 there; a venue not on this network isn't part of it", () => {
    const v = venueEquities(acc({ meridian: meridian({ collateral: 3n * WAD }), perpl: null }), { meridian: true, perpl: true });
    expect(totalAusdWad({ walletWad: WAD, venues: v })).toBe(4n * WAD);
    const noMeridian = venueEquities(acc({ meridian: undefined, perpl: null }), { meridian: false, perpl: true });
    expect(noMeridian.map((x) => x.venue)).toEqual(["perpl"]);
    expect(totalAusdWad({ walletWad: WAD, venues: noMeridian })).toBe(WAD);
  });

  it("Meridian equity below zero shows 0, not a negative balance", () => {
    expect(venueEquities(acc({ meridian: meridian({ collateral: WAD, upnl: -3n * WAD }), perpl: null }), BOTH)[0]!.equityWad).toBe(0n);
  });
});

describe("Open PnL", () => {
  it("Meridian uPnL − pending funding + Perpl delta + premium, equal to core's perplPositionRisk", () => {
    const perpl = mapPerpl(K3, K3_POS, 500n, P)!;
    const core = perplPositionRisk(K3_POS[0], K3_POS[1], { priceDecimals: 5, lotDecimals: 0, maintMarginHdths: 500n });
    const r = openPnl(acc({ meridian: meridian({ size: -WAD, upnl: 2n * WAD, funding: WAD / 2n }), perpl }), BOTH);
    expect(r).toEqual({ pnlWad: 2n * WAD - WAD / 2n + core.unrealizedPnlWad, open: true });
    expect(core.unrealizedPnlWad).toBe((-1469999n - 10530n) * CNS);
  });
  it("flat on both ⇒ 0 and not open; unknown part ⇒ undefined", () => {
    expect(openPnl(acc({ meridian: meridian(), perpl: null }), BOTH)).toEqual({ pnlWad: 0n, open: false });
    expect(openPnl(acc({ meridian: undefined, perpl: null }), BOTH).pnlWad).toBeUndefined();
    // held on Perpl but the risk view isn't built yet (margin fractions loading)
    expect(openPnl(acc({ meridian: meridian(), perpl: mapPerpl(K3, K3_POS, undefined, P) }), BOTH).pnlWad).toBeUndefined();
  });
});

describe("basis pairing (fallback until N6 stores a basisId)", () => {
  const v = (venue: "meridian" | "perpl", sizeWad: bigint) => ({ venue, sizeWad }) as PositionView;
  it("one Meridian + one Perpl, opposite sides, same size", () => {
    expect(isBasisPair([v("meridian", 5n * WAD), v("perpl", -5n * WAD)])).toBe(true);
    expect(isBasisPair([v("meridian", 5n * WAD), v("perpl", 5n * WAD)])).toBe(false);
    expect(isBasisPair([v("meridian", 5n * WAD), v("perpl", -4n * WAD)])).toBe(false);
    expect(isBasisPair([v("perpl", -5n * WAD)])).toBe(false);
  });
});
