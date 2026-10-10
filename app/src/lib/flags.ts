// Remote flags and kill switches (LAUNCH_PLAN §3.3 / P3): served by /api/flags, read by the web WriteGate and the
// native app (mobile/src/features/flags). Env-backed only: Edge Config is > VERIFY on the Vercel plan. To swap it in
// later, replace `readFlagsEnv(process.env)` in the route with an Edge Config read that feeds the same `parseFlags`.
// Turning `writes` off stops new risk everywhere without a rebuild; closes are never gated.

export type Flags = { v: 1; writes: boolean; perpl: boolean; earn: boolean; lock: boolean; minAppVersion: string; message?: string };

export const DEFAULT_FLAGS: Flags = { v: 1, writes: true, perpl: true, earn: true, lock: true, minAppVersion: "0.0.0" };

/** Env names (LAUNCH_PLAN §3.2). Values only in the Vercel env store. */
export const FLAG_ENV = {
  writes: "FLAGS_WRITES",
  perpl: "FLAGS_PERPL",
  earn: "FLAGS_EARN",
  lock: "FLAGS_LOCK",
  minAppVersion: "FLAGS_MIN_APP_VERSION",
  message: "FLAGS_MESSAGE",
} as const;

export const FLAGS_HEADERS: Record<string, string> = {
  "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
  // the native app sends no Origin; harmless for a public read-only GET
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const MESSAGE_MAX = 200;

type Env = Record<string, string | undefined>;
type Warn = (msg: string) => void;

/** Only "true" / "false"; unset ⇒ default; anything else ⇒ default + a server-log warning (never thrown). */
function bool(env: Env, name: string, def: boolean, warn: Warn): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (raw === "true") return true;
  if (raw === "false") return false;
  warn(`${name}="${raw}" is not "true" or "false"; using the default (${def})`);
  return def;
}

export function readFlagsEnv(env: Env, warn: Warn = (m) => console.warn(`[flags] ${m}`)): Flags {
  const f: Flags = {
    v: 1,
    writes: bool(env, FLAG_ENV.writes, DEFAULT_FLAGS.writes, warn),
    perpl: bool(env, FLAG_ENV.perpl, DEFAULT_FLAGS.perpl, warn),
    earn: bool(env, FLAG_ENV.earn, DEFAULT_FLAGS.earn, warn),
    lock: bool(env, FLAG_ENV.lock, DEFAULT_FLAGS.lock, warn),
    minAppVersion: DEFAULT_FLAGS.minAppVersion,
  };
  const min = env[FLAG_ENV.minAppVersion]?.trim();
  if (min) {
    if (SEMVER.test(min)) f.minAppVersion = min;
    else warn(`${FLAG_ENV.minAppVersion}="${min}" is not x.y.z; using the default (${DEFAULT_FLAGS.minAppVersion})`);
  }
  const msg = env[FLAG_ENV.message]?.trim();
  if (msg) f.message = msg.slice(0, MESSAGE_MAX);
  return f;
}

/** Client side: a /api/flags body → Flags, or undefined when it isn't one (then the caller keeps its fail-safe). */
export function parseFlags(body: unknown): Flags | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return undefined;
  for (const k of ["writes", "perpl", "earn", "lock"] as const) if (typeof b[k] !== "boolean") return undefined;
  if (typeof b.minAppVersion !== "string" || !SEMVER.test(b.minAppVersion)) return undefined;
  const f: Flags = { v: 1, writes: b.writes as boolean, perpl: b.perpl as boolean, earn: b.earn as boolean, lock: b.lock as boolean, minAppVersion: b.minAppVersion };
  if (typeof b.message === "string" && b.message.trim()) f.message = b.message.trim().slice(0, MESSAGE_MAX);
  return f;
}

export const PAUSED_TEXT = "Trading is paused for maintenance. You can still close positions.";

/** Web WriteGate's decision for one write. `opens`: the write adds risk (a new / larger order); closes pass `false`. */
export type GateDecision = "restricted" | "paused" | "terms" | "ok";
export function gateDecision(i: { geoRestricted: boolean; opens: boolean; flags: Flags | undefined; termsAccepted: boolean }): GateDecision {
  if (i.geoRestricted) return "restricted";
  // flags unreachable ⇒ allow (the contracts are the real guard; a demo, not a custodian)
  if (i.opens && i.flags && !i.flags.writes) return "paused";
  return i.termsAccepted ? "ok" : "terms";
}

/** Same-origin read for the web app; any failure ⇒ undefined (allow). */
export async function fetchFlags(fetchFn: typeof fetch = fetch): Promise<Flags | undefined> {
  try {
    const r = await fetchFn("/api/flags", { cache: "no-store" });
    if (!r.ok) return undefined;
    return parseFlags(await r.json());
  } catch {
    return undefined;
  }
}
