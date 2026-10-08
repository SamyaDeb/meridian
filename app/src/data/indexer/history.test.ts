// K2.4 indexer readers: parse what Hasura returns (BigInt as strings, nulls for unset optionals), refuse garbage,
// and query the right rows (per chain, product entities). Response shapes follow indexer/schema.graphql.
import { describe, expect, it } from "vitest";
import { CROSS_VENUE_QUERY, FUNDING_PAYMENTS_QUERY, FUNDING_WINDOW_QUERY, parseCrossVenue, parseFundingPayments, parseFundingWindow } from "./funding";
import { INSURANCE_QUERY, PROTOCOL_DAILY_QUERY, parseInsurance, parseProtocolDaily } from "./protocol";
import { VAULT_HISTORY_QUERY, parseVaultHistory } from "./vault";
import { PORTFOLIO_QUERY, parsePortfolio, sumTotals } from "./portfolio";
import { parsePerpl, perplMonId, perplQuery } from "./perpl";

const V = "0xe8b38d1115F51Fb036a566C290b6b7d8Ae5692E6" as const;

describe("every K2.4 query is scoped to one chain (the indexer also holds Perpl mainnet rows)", () => {
  it.each([FUNDING_WINDOW_QUERY, CROSS_VENUE_QUERY, FUNDING_PAYMENTS_QUERY, PROTOCOL_DAILY_QUERY, INSURANCE_QUERY, VAULT_HISTORY_QUERY, PORTFOLIO_QUERY, perplQuery(64)])("%#", (q) => {
    expect(q).toContain("$chainId: Int!");
    expect(q.match(/chainId: \{ _eq: \$chainId \}/g)!.length).toBe(q.match(/\(where:/g)!.length);
  });
});

describe("FundingWindow", () => {
  it("parses; null windows stay undefined (never 0)", () => {
    const w = parseFundingWindow({ FundingWindow: [{ block: "68990000", apr1hWad: "-31536000000000000", apr8hWad: null, apr24hWad: null, apr7dWad: null, rateAprWad: "109500000000000000" }] });
    expect(w).toEqual({ block: 68_990_000n, apr1hWad: -31_536_000_000_000_000n, rateAprWad: 109_500_000_000_000_000n });
  });
  it("no row ⇒ undefined; garbled ⇒ throws", () => {
    expect(parseFundingWindow({ FundingWindow: [] })).toBeUndefined();
    expect(() => parseFundingWindow({ FundingWindow: [{ block: "x", rateAprWad: "1" }] })).toThrow(/block/);
    expect(() => parseFundingWindow({})).toThrow(/FundingWindow/);
  });
});

describe("CrossVenueFunding", () => {
  it("oldest first; a venue without data that hour stays undefined", () => {
    const h = parseCrossVenue({
      CrossVenueFunding: [
        { hour: "1791381600", meridianAprWad: "109500000000000000", perplAprWad: "-488930232558139534", spreadAprWad: "598430232558139534" },
        { hour: "1791378000", meridianAprWad: null, perplAprWad: "-366697674418604651", spreadAprWad: null },
      ],
    });
    expect(h.map((x) => x.hour)).toEqual([1_791_378_000, 1_791_381_600]);
    expect(h[0]).toEqual({ hour: 1_791_378_000, perplAprWad: -366_697_674_418_604_651n });
    expect(h[1]!.spreadAprWad).toBe(h[1]!.meridianAprWad! - h[1]!.perplAprWad!);
  });
});

describe("FundingPayment", () => {
  it("keeps the sign convention (+ = paid)", () => {
    expect(parseFundingPayments({ FundingPayment: [{ block: "12", timestamp: "1791380000", payment: "-5", txHash: "0xab" }] })).toEqual([{ block: 12n, timestamp: 1_791_380_000n, payment: -5n, txHash: "0xab" }]);
  });
});

describe("ProtocolDaily", () => {
  it("oldest first, numbers parsed", () => {
    const row = (day: string, trades: number) => ({
      day, perpVolumeQuoteWad: "10", perpVolumeMmQuoteWad: "4", swapVolumeWad: "0", feesWad: "-1", trades, liquidations: 0, newExternalUsers: 2, activeExternalUsers: 3,
      tvlTokenClose: "7000000", vaultNavTokenClose: "0", perpOpenInterestLongWadClose: "1", perpOpenInterestShortWadClose: "1", swapOpenInterestWadClose: "0",
    });
    const d = parseProtocolDaily({ ProtocolDaily: [row("1791417600", 5), row("1791331200", 1)] });
    expect(d.map((x) => [x.day, x.trades])).toEqual([[1_791_331_200, 1], [1_791_417_600, 5]]);
    expect(d[0]!.feesWad).toBe(-1n); // maker rebates can make a day's fees negative
  });
});

describe("InsuranceFundEvent", () => {
  const step = (id: string, flow: string, direction: string, amountWad: string, extra: Record<string, unknown> = {}) => ({
    id, flow, direction, kind: "Perp", market: "0xCH", account: null, amountWad, requestedWad: null, balanceAfterToken: "0", block: id.split("-")[0], timestamp: "1", txHash: "0xt", ...extra,
  });
  it("returns the waterfall in order: IF → fees → uncovered inside one tx", () => {
    const s = parseInsurance({
      InsuranceFundEvent: [step("7-2-1", "Uncovered", "None", "5"), step("7-2-0", "CoveredByFees", "None", "20"), step("7-1-0", "CoveredByInsurance", "Out", "100"), step("5-0-0", "Funded", "In", "100", { kind: null, market: null })],
    });
    expect(s.map((x) => x.flow)).toEqual(["Funded", "CoveredByInsurance", "CoveredByFees", "Uncovered"]);
    expect(s[0]).not.toHaveProperty("kind");
  });
  it("unknown flow / direction ⇒ throws", () => {
    expect(() => parseInsurance({ InsuranceFundEvent: [step("1-0-0", "Socialized", "Out", "1")] })).toThrow(/flow/);
    expect(() => parseInsurance({ InsuranceFundEvent: [step("1-0-0", "Funded", "Up", "1")] })).toThrow(/direction/);
  });
});

describe("Vault history", () => {
  it("totals + snapshots newest first (the chain source's order)", () => {
    const r = parseVaultHistory(
      {
        Vault: [{ id: V, depositedToken: "5000000", withdrawnToken: "0", userCount: 2, apy24hWad: null, apy7dWad: null, pendingRedeemShares: "0", claimableToken: "0" }],
        VaultSnapshot: [{ id: "2-0", navToken: "5000000", totalShares: "5000000000000000000", sharePriceWad: "1000000000000000000", fundingAccruedWad: "0", block: "2", timestamp: "20" }],
      },
      V,
    );
    expect(r.totals).toMatchObject({ depositedToken: 5_000_000n, userCount: 2 });
    expect(r.totals).not.toHaveProperty("apy24hWad");
    expect(r.snapshots[0]).toMatchObject({ vault_id: V, sharePriceWad: 10n ** 18n, block: 2n });
  });
  it("no vault yet ⇒ totals undefined", () => {
    expect(parseVaultHistory({ Vault: [], VaultSnapshot: [] }, V)).toEqual({ snapshots: [] });
  });
});

describe("Portfolio", () => {
  it("per-market totals and redemption lifecycle; sums across markets", () => {
    const p = parsePortfolio({
      AccountMarket: [{ market_id: "0xCH", fundingPaid: "120", realizedPnl: "-30", feesPaid: "4", liquidationCount: 1, depositedToken: "10", withdrawnToken: "0", lastTradeBlock: null }],
      VaultRedeemRequest: [{ requestId: "1", shares: "5", status: "Claimed", assets: "5000000", unwindCost: "1000", requestedAt: "10", fulfilledAt: "20", claimedAt: "30", cancelledAt: null, txHash: "0xr" }],
    });
    expect(sumTotals(p.markets)).toEqual({ fundingPaidWad: 120n, realizedPnlWad: -30n, feesPaidWad: 4n, liquidations: 1 });
    expect(p.redeems[0]).toMatchObject({ status: "Claimed", assets: 5_000_000n, claimedAt: 30n });
    expect(p.redeems[0]).not.toHaveProperty("cancelledAt");
    expect(() => parsePortfolio({ AccountMarket: [], VaultRedeemRequest: [{ ...{ requestId: "1", shares: "1", requestedAt: "1" }, status: "Lost" }] })).toThrow(/status/);
  });
});

describe("Perpl", () => {
  it("MON id per chain comes from deployments/perpl.json", () => {
    expect(perplMonId(10143)).toBe(64);
    expect(perplMonId(143)).toBe(10);
    expect(perplMonId(31337)).toBeUndefined();
    expect(perplQuery(64)).toContain('perpId: { _eq: "64" }');
    expect(() => perplQuery(-1)).toThrow();
  });
  it("parses the MON market, funding oldest first, liquidations; drops other perps", () => {
    const r = parsePerpl(
      {
        PerplMarket: [{ perpId: "64", name: "MON Perp", isMon: true, lastAprWad: "-488930232558139534", lastRatePct100k: "-4", lastFundingEventBlock: "68979408", lastMarkWad: null, liquidations: 0 }],
        PerplFunding: [
          { perpId: "64", fundingEventBlock: "68979408", ratePct100k: "-4", aprWad: "-488930232558139534", fundingPriceWad: "28770000000000000", timestamp: "1791380000" },
          { perpId: "64", fundingEventBlock: "68970837", ratePct100k: "0", aprWad: "0", fundingPriceWad: null, timestamp: "1791377000" },
          { perpId: "16", fundingEventBlock: "68970837", ratePct100k: "1", aprWad: null, fundingPriceWad: null, timestamp: "1791377000" },
        ],
        PerplLiquidation: [{ perpId: "64", accountId: "913", address: null, side: "Long", liqLots: "1741", markPriceWad: null, liqPriceWad: null, block: "9", timestamp: "1", txHash: "0x1" }],
      },
      64,
    );
    expect(r.mon).toMatchObject({ perpId: 64n, name: "MON Perp", lastRatePct100k: -4n });
    expect(r.funding.map((f) => f.fundingEventBlock)).toEqual([68_970_837n, 68_979_408n]);
    expect(r.liquidations[0]).toEqual({ accountId: 913n, side: "Long", liqLots: 1_741n, block: 9n, timestamp: 1n, txHash: "0x1" });
    expect(() => parsePerpl({ PerplMarket: [], PerplFunding: [], PerplLiquidation: [{ perpId: "64", side: "Up" }] }, 64)).toThrow();
  });
});
