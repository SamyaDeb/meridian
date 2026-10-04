// Restricted-jurisdiction decision (C3). Pure: the proxy (src/proxy.ts) and the tests call it with plain values.
// The list of jurisdictions comes from the founders (GEO_BLOCKED_COUNTRIES); nothing is hard-coded here.

/** Cookie the proxy sets for restricted viewers; the write gate reads it client-side. */
export const GEO_COOKIE = "pulse_geo";
export const GEO_RESTRICTED = "restricted";

/**
 * "writes" (default): restricted viewers can read every page, but every write action is refused in the app.
 * "all": restricted viewers are rewritten to /blocked on every page except the ones in ALWAYS_OPEN.
 */
export type GeoMode = "writes" | "all";
export type GeoDecision = "allow" | "restrict-writes" | "block";

/** Reachable for everyone in every mode (the terms must be readable; the blocked page must not loop). */
export const ALWAYS_OPEN = ["/terms", "/blocked"] as const;

/** "US, cu ,IR" → Set{"US","CU","IR"}. ISO 3166-1 alpha-2 only; anything else is dropped. */
export function parseCountryList(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const c = part.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) out.add(c);
  }
  return out;
}

export function parseMode(raw: string | undefined): GeoMode {
  return raw?.trim().toLowerCase() === "all" ? "all" : "writes";
}

/**
 * @param country the hosting platform's country header value (undefined when absent, e.g. local dev: allowed)
 */
export function geoDecision(args: { country: string | undefined | null; pathname: string; blocked: Set<string>; mode: GeoMode }): GeoDecision {
  const c = args.country?.trim().toUpperCase();
  if (!c || !args.blocked.has(c)) return "allow";
  if (args.mode === "writes") return "restrict-writes";
  const open = ALWAYS_OPEN.some((p) => args.pathname === p || args.pathname.startsWith(`${p}/`));
  return open ? "restrict-writes" : "block";
}

/** Client side: is this viewer flagged by the proxy? (`document.cookie` string in, no DOM access here.) */
export function isGeoRestricted(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((kv) => kv.trim() === `${GEO_COOKIE}=${GEO_RESTRICTED}`);
}
