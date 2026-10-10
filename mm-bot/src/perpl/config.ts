// Perpl hedge configuration from env (K3, docs/PERPL_HEDGE.md "Configuration"). Pure: `env` is passed in.
// Guardrail: TESTNET ONLY. Chain 10143 and hosts on testnet.perpl.xyz, or startup fails (the owner has not enabled
// mainnet; PERPL_ALLOW_MAINNET=1 is reserved for that written decision and still requires both checks to name mainnet).
import type { HedgeConfig } from "../hedge.js";

export type PerplHedgeEnv = {
  apiUrl: string;
  wsUrl: string;
  chainId: number;
  apiKey: string;
  apiSecretHex: string;
  marketId: number;
  marketSymbol: string;
  accountId: number | undefined;
  evidencePath: string | undefined;
  mfiUrl: string | undefined;
  hedge: Omit<HedgeConfig, "maxInventoryWad">;
};

const WAD = 10n ** 18n;

/** "12.5" → 12.5 × 10^decimals, exact (no floats); rejects anything that isn't a plain non-negative decimal. */
export function parseDecimal(s: string, decimals: number, what: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`${what}: expected a non-negative decimal, got "${s}"`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`${what}: more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals) || "0");
}

function host(url: string, what: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`${what}: not a URL`);
  }
}

/** undefined ⇒ PERPL_HEDGE is off: the MM runs exactly as before (no Perpl code path at all). */
export function perplHedgeFromEnv(env: Record<string, string | undefined>): PerplHedgeEnv | undefined {
  const v = (k: string): string | undefined => (env[k] === undefined || env[k] === "" ? undefined : env[k]);
  if (v("PERPL_HEDGE") !== "1") return undefined;
  const need = (k: string): string => {
    const x = v(k);
    if (x === undefined) throw new Error(`PERPL_HEDGE=1 needs ${k}`);
    return x;
  };
  const chainId = Number(v("PERPL_CHAIN_ID") ?? "10143");
  const apiUrl = v("PERPL_API_URL") ?? "https://testnet.perpl.xyz/api";
  const wsUrl = v("PERPL_WS_URL") ?? "wss://testnet.perpl.xyz";
  const mainnet = v("PERPL_ALLOW_MAINNET") === "1";
  const wantHost = mainnet ? "app.perpl.xyz" : "testnet.perpl.xyz";
  if (chainId !== (mainnet ? 143 : 10143)) throw new Error(`PERPL_CHAIN_ID must be ${mainnet ? 143 : 10143} (testnet only unless the owner enables mainnet in writing)`);
  if (host(apiUrl, "PERPL_API_URL") !== wantHost || !apiUrl.startsWith("https://")) throw new Error(`PERPL_API_URL must be https://${wantHost}/api`);
  if (host(wsUrl, "PERPL_WS_URL") !== wantHost || !wsUrl.startsWith("wss://")) throw new Error(`PERPL_WS_URL must be wss://${wantHost}`);
  const num = (k: string, d: string) => {
    const n = Number(v(k) ?? d);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
    return n;
  };
  const mon = (k: string, d: string) => parseDecimal(v(k) ?? d, 18, k);
  const bias = v("HEDGE_FUNDING_BIAS") === "1";
  const accountId = v("PERPL_ACCOUNT_ID");
  return {
    apiUrl,
    wsUrl,
    chainId,
    apiKey: need("PERPL_API_KEY"),
    apiSecretHex: need("PERPL_API_KEY_SECRET"),
    marketId: num("PERPL_MARKET_ID", "64"),
    marketSymbol: (v("PERPL_MARKET_SYMBOL") ?? "MON").toUpperCase(),
    accountId: accountId === undefined ? undefined : num("PERPL_ACCOUNT_ID", accountId),
    evidencePath: v("HEDGE_EVIDENCE"),
    mfiUrl: v("MFI_URL"),
    hedge: {
      enabled: true,
      bandBps: num("HEDGE_BAND_BPS", "2500"),
      residualWad: mon("HEDGE_RESIDUAL_MON", "0"),
      maxHedgePerOrderWad: mon("HEDGE_MAX_ORDER_MON", "5000"),
      maxPerplNotionalWad: parseDecimal(v("HEDGE_MAX_NOTIONAL_USD") ?? "500", 18, "HEDGE_MAX_NOTIONAL_USD"),
      slippageBps: num("HEDGE_SLIPPAGE_BPS", "50"),
      maxDivergenceBps: num("HEDGE_MAX_DIVERGENCE_BPS", "300"),
      maxDataAgeMs: num("HEDGE_MAX_DATA_AGE_MS", "15000"),
      maxConsecutiveRejects: num("HEDGE_MAX_REJECTS", "3"),
      // collateral token decimals come from /v1/pub/context at startup; this is the human amount (AUSD)
      minCollateral: parseDecimal(v("HEDGE_MIN_COLLATERAL") ?? "50", 6, "HEDGE_MIN_COLLATERAL"),
      cooldownMs: num("HEDGE_COOLDOWN_MS", "15000"),
      leverage: num("HEDGE_LEVERAGE", "500"),
      ...(bias ? { fundingBias: { minSpreadAprWad: parseDecimal(v("HEDGE_FUNDING_BIAS_MIN_SPREAD_APR") ?? "0.2", 18, "HEDGE_FUNDING_BIAS_MIN_SPREAD_APR"), residualWad: mon("HEDGE_FUNDING_BIAS_RESIDUAL_MON", "1000") } } : {}),
    },
  };
}

export { WAD };
