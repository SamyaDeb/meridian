// In-app alerts (MOBILE_PLAN §1.2 "Alerts": liq distance < 5 %, funding flip). Pure rules with memory so an alert fires
// once when the condition starts, not every block: liquidation re-arms only after the distance is back above
// LIQ_REARM_BPS (hysteresis), a funding flip fires when the sign of a venue's rate in force changes.
// Phone (push) notifications need expo-notifications + a backend that doesn't exist yet (MOBILE_PLAN cut order): these
// run while the app is open, and no OS permission is asked for them.
import type { Venue } from "@meridian/core/route";

export const LIQ_ALERT_BPS = 500n;
export const LIQ_REARM_BPS = 600n;

export type AlertPrefs = { liq: boolean; funding: boolean };
export const NO_ALERTS: AlertPrefs = { liq: false, funding: false };

export type AlertMemory = { liqFired: Partial<Record<Venue, boolean>>; fundingSign: Partial<Record<Venue, -1 | 0 | 1>> };
export const freshMemory = (): AlertMemory => ({ liqFired: {}, fundingSign: {} });

export type Alert = { key: string; text: string };

const VENUE: Record<Venue, string> = { meridian: "Meridian", perpl: "Perpl" };
const pct = (bps: bigint) => (Number(bps) / 100).toFixed(1);

/** Positions' adverse distance to liquidation (bps of the mark; undefined = no position / unknown). */
export function liqAlerts(mem: AlertMemory, distance: Partial<Record<Venue, bigint | undefined>>): Alert[] {
  const out: Alert[] = [];
  for (const v of ["meridian", "perpl"] as const) {
    const d = distance[v];
    if (d === undefined) {
      mem.liqFired[v] = false; // closed (or unknown): the next position starts armed
      continue;
    }
    if (d < LIQ_ALERT_BPS && !mem.liqFired[v]) {
      mem.liqFired[v] = true;
      out.push({ key: `liq-${v}`, text: `Your ${VENUE[v]} position is ${pct(d)}% from liquidation. Reduce or close it to stay clear.` });
    } else if (d >= LIQ_REARM_BPS) mem.liqFired[v] = false;
  }
  return out;
}

const signOf = (x: bigint): -1 | 0 | 1 => (x > 0n ? 1 : x < 0n ? -1 : 0);

/** Funding rate in force per venue (APR or per-block rate, only the sign matters; positive ⇒ longs pay). */
export function fundingAlerts(mem: AlertMemory, rate: Partial<Record<Venue, bigint | undefined>>): Alert[] {
  const out: Alert[] = [];
  for (const v of ["meridian", "perpl"] as const) {
    const r = rate[v];
    if (r === undefined) continue;
    const now = signOf(r);
    const before = mem.fundingSign[v];
    if (now !== 0) mem.fundingSign[v] = now; // a zero rate is no flip; compare against the last non-zero side
    if (before === undefined || before === 0 || now === 0 || now === before) continue;
    out.push({ key: `funding-${v}`, text: `Funding flipped on ${VENUE[v]}: ${now > 0 ? "longs now pay shorts" : "shorts now pay longs"}.` });
  }
  return out;
}

export const ALERTS_KEY = "meridian.pref.alerts";

export function decodePrefs(text: string | null | undefined): AlertPrefs {
  try {
    const o = text ? (JSON.parse(text) as Partial<AlertPrefs>) : {};
    return { liq: o.liq === true, funding: o.funding === true };
  } catch {
    return NO_ALERTS;
  }
}
