// Pure renderers for docs/outputs/BENCHMARKS.md (bench/report.ts does the file I/O). Unit-tested in test/report.test.ts.
// PRD §7.1: every number carries network, block range, commit and date; anvil data is never presented as testnet.

export type Csv = Array<Record<string, string>>;

/** Minimal CSV parser: header row, comma-separated, double-quoted fields may contain commas. */
export function parseCsv(text: string): Csv {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const split = (l: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [head, ...rows] = lines;
  if (head === undefined) return [];
  const cols = split(head);
  return rows.map((r) => Object.fromEntries(split(r).map((v, i) => [cols[i] ?? `c${i}`, v])));
}

export function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
}

/** Nearest-rank percentile (p in 0..100). */
export function pct(xs: readonly number[], p: number): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

const fmt = (n: number | undefined): string => (n === undefined ? "—" : Math.round(n).toLocaleString("en-US"));

export interface GasSources {
  /** contracts/bench-out/real_engine_gas.csv (op, gas, target): Foundry, Ethereum/Cancun schedule */
  foundry: Csv | null;
  /** bench/out/gas_onchain_<network>_<date>.csv rows of ONE non-anvil network */
  onchain: Csv;
  network: string;
  /** Allowance baked into this file's limits when the CSV predates the touchAllowance column (Found #19). */
  legacyTouchAllowance?: number;
}

/**
 * Gas table: Foundry execution gas vs the testnet's execution estimate and billed limit (Monad receipts report the limit
 * as gasUsed; limit = ⌈estimate × 1.2⌉ + touch allowance). The estimate is the recorded `gasEstimate` column, else
 * derived as (limit − allowance) / 1.2 with the allowance from the `touchAllowance` column or `legacyTouchAllowance`.
 * Targets from the Foundry CSV. Place + cancel is summed.
 */
export function renderGasTable(g: GasSources): string {
  const foundry = new Map((g.foundry ?? []).map((r) => [r.op ?? "", r]));
  const lim = new Map<string, number[]>();
  const est = new Map<string, number[]>();
  const touch = new Map<string, number[]>();
  for (const r of g.onchain) {
    const op = r.op ?? "";
    const l = Number(r.gasLimit);
    const t = r.touchAllowance !== undefined && r.touchAllowance !== "" ? Number(r.touchAllowance) : (g.legacyTouchAllowance ?? 0);
    const e = r.gasEstimate !== undefined && r.gasEstimate !== "" ? Number(r.gasEstimate) : (l - t) / 1.2;
    lim.set(op, [...(lim.get(op) ?? []), l]);
    est.set(op, [...(est.get(op) ?? []), e]);
    touch.set(op, [...(touch.get(op) ?? []), t]);
  }
  const m = (src: Map<string, number[]>, op: string) => median(src.get(op) ?? []);
  const sum = (src: Map<string, number[]>) => {
    const a = m(src, "place");
    const b = m(src, "cancel");
    return a !== undefined && b !== undefined ? a + b : undefined;
  };
  const ops: Array<[string, string, string]> = [
    ["place", "place", "place"],
    ["cancel", "cancel", "cancel"],
    ["place+cancel", "place+cancel", "+"],
    ["replace", "replace", "replace"],
    ["match 1 fill", "match_1_fill", "match_1_fill"],
    ["close 1 fill", "close_1", "close_1_fill"],
    ["funding first-touch tx", "funding_first_touch_tx", "funding_first_touch_tx"],
  ];
  const out = [
    `| op | Foundry execution gas (Cancun schedule) | ${g.network} execution estimate (median) | touch allowance | ${g.network} billed limit (median) | target |`,
    "|---|---|---|---|---|---|",
  ];
  for (const [label, fkey, op] of ops) {
    const f = foundry.get(fkey);
    const [e, t, l] = op === "+" ? [sum(est), sum(touch), sum(lim)] : [m(est, op), m(touch, op), m(lim, op)];
    out.push(`| ${label} | ${fmt(f ? Number(f.gas) : undefined)} | ${fmt(e)} | ${fmt(t)} | ${fmt(l)} | ${f?.target ? `< ${fmt(Number(f.target))}` : ""} |`);
  }
  return out.join("\n");
}

/** B7 rows (bench/out/b7_liquidation_latency.csv) grouped by network: n, p50, p95, max of blocks after eligibility. */
export function renderB7(rows: Csv): string {
  const nets = [...new Set(rows.map((r) => r.network ?? ""))];
  const out = ["| network | n | p50 (blocks after eligible) | p95 | max | blocks after the oracle push (p50) | target |", "|---|---|---|---|---|---|---|"];
  for (const n of nets) {
    const r = rows.filter((x) => x.network === n);
    const e = r.map((x) => Number(x.blocks_after_eligible));
    const p = r.map((x) => Number(x.blocks_after_push));
    out.push(`| ${n} | ${r.length} | ${fmt(pct(e, 50))} | ${fmt(pct(e, 95))} | ${fmt(Math.max(...e))} | ${fmt(pct(p, 50))} | ≤ 3 |`);
  }
  return out.join("\n");
}

/** Block range + commit + date line for a set of onchain rows. */
export function provenance(rows: Csv): string {
  const blocks = rows.map((r) => Number(r.block)).filter((b) => b > 0);
  const commits = [...new Set(rows.map((r) => r.commit).filter(Boolean))];
  const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))];
  const bt = [...new Set(rows.map((r) => r.blockTimeMs).filter(Boolean))];
  return `blocks ${Math.min(...blocks)}–${Math.max(...blocks)}, commit ${commits.join(", ")}, ${dates.join(", ")}, measured block time ${bt.join(", ")} ms`;
}
