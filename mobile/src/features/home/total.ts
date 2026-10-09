// Home hero total (MOBILE_PLAN §1.2): wallet AUSD now; venue equity joins in N7 through `venues` without changing the
// hero. Unknown anywhere ⇒ undefined ("—"), never a partial sum shown as the total.
export type VenueEquity = {
  venue: "meridian" | "perpl";
  /** collateral + unrealised PnL on that venue, WAD; undefined while unknown */
  equityWad: bigint | undefined;
};

export type HomeTotal = {
  /** AUSD in the wallet, WAD (wallet/arrival walletAusdWad) */
  walletWad: bigint | undefined;
  /** N7 fills this slot (Meridian collateral + equity, Perpl equity); empty until then */
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
