// Home hero total (MOBILE_PLAN §1.2, N7): wallet AUSD + each venue's own account value, bigint WAD. Meridian: the
// ClearingHouse AccountView `equity` (= collateral + unrealized PnL − pending funding, ClearingHouse.sol getAccount, so
// collateral is already inside it). Perpl: account balance + the position's deposit + PnL (data/accounts mapPerpl).
// Unknown anywhere ⇒ undefined ("—"), never a partial sum shown as the total. A venue that isn't on this network is not
// part of the total (the breakdown says so).
import type { AccountsState } from "../trade/data/accounts";

export type VenueEquity = {
  venue: "meridian" | "perpl";
  /** the venue's account value, WAD, floored at 0 (an account can't be worth less than nothing to its owner); undefined while unknown */
  equityWad: bigint | undefined;
  /** why it's unknown, in plain words (breakdown sheet) */
  why?: string;
};

export type HomeTotal = {
  /** AUSD in the wallet, WAD (wallet/arrival walletAusdWad) */
  walletWad: bigint | undefined;
  /** the venues deployed on this network */
  venues: readonly VenueEquity[];
};

export function totalAusdWad(t: HomeTotal): bigint | undefined {
  if (t.walletWad === undefined) return undefined;
  let sum = t.walletWad;
  for (const v of t.venues) {
    if (v.equityWad === undefined) return undefined;
    sum += v.equityWad;
  }
  return sum;
}

const floor0 = (x: bigint) => (x > 0n ? x : 0n);

export const VENUE_LABEL: Record<VenueEquity["venue"], string> = { meridian: "Meridian", perpl: "Perpl" };

/** Each deployed venue's part of the total from the account reader (one multicall per block, data/accounts). */
export function venueEquities(acc: AccountsState | undefined, deployed: { meridian: boolean; perpl: boolean }): VenueEquity[] {
  const out: VenueEquity[] = [];
  const reading = acc?.error ? `Couldn't read it: ${acc.error}` : "Reading…";
  if (deployed.meridian) {
    const m = acc?.meridian;
    out.push(m ? { venue: "meridian", equityWad: floor0(m.equityWad) } : { venue: "meridian", equityWad: undefined, why: reading });
  }
  if (deployed.perpl) {
    const p = acc?.perpl;
    if (p === null) out.push({ venue: "perpl", equityWad: 0n }); // no exchange account: nothing held there
    else if (p === undefined) out.push({ venue: "perpl", equityWad: undefined, why: reading });
    else if (p.equityWad === undefined) out.push({ venue: "perpl", equityWad: undefined, why: p.otherMarkets ? "You hold a position on another Perpl market; see it in Perpl." : "Your Perpl position couldn't be read yet." });
    else out.push({ venue: "perpl", equityWad: p.equityWad });
  }
  return out;
}

export type OpenPnl = {
  /** unrealized PnL across both venues, funding included (Meridian: uPnL − pending funding; Perpl: delta + premium); undefined while any part is unknown */
  pnlWad: bigint | undefined;
  /** at least one open position */
  open: boolean;
};

/** Live open PnL for the hero (ticks per block with the account reader). */
export function openPnl(acc: AccountsState | undefined, deployed: { meridian: boolean; perpl: boolean }): OpenPnl {
  let sum = 0n;
  let known = true;
  let open = false;
  if (deployed.meridian) {
    const m = acc?.meridian;
    if (!m) known = false;
    else if (m.sizeWad !== 0n) {
      open = true;
      sum += m.upnlWad - m.pendingFundingWad;
    }
  }
  if (deployed.perpl) {
    const p = acc?.perpl;
    if (p === undefined || (p !== null && p.equityWad === undefined)) known = false;
    else if (p?.position) {
      open = true;
      sum += p.position.unrealizedPnlWad;
    } else if (p?.held) known = false; // held, but its risk view isn't built yet (margin fractions still loading)
  }
  return { pnlWad: known ? sum : undefined, open };
}
