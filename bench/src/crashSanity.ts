// Sanity checks for the CrashDemo CSV (contracts/script/CrashDemo.s.sol, DEMO_SCRIPT crash segment; Phase 3 P3).
// Every check is an invariant the protocol promises, so a row that breaks one is a finding, not noise:
//  - ≥ 20 blocks after the start row, consecutive block numbers;
//  - the index drops by exactly DROP_BPS at offset 1 (one oracle update) and stays there;
//  - the mark stays inside index ± markBand (5%, PHASES decision 3; MATH_SPEC §2.1), +1 wei rounding;
//  - the IF balance never goes down (no bad debt in this scenario: the liquidatee's equity covers the penalty) and
//    changes only on the liquidation row;
//  - the trader is liquidated exactly once, ≤ 3 blocks after it first becomes liquidatable (B7 target), flat after;
//  - vault NAV (MATH_SPEC §5.4): idle vault ⇒ NAV and share price exactly constant (no market exposure); hedged vault ⇒
//    delta-neutral, so |ΔNAV| / NAV₀ ≤ 0.5% through the −15% move;
//  - swap markApr (PHASES decision 18): the whole window stays within a 20-point range (anchor ± 10 points).
// Money values are bigint (WAD or AUSD token units); CSV comment lines start with "#".

export interface CrashRow {
  offset: number;
  block: bigint;
  index: bigint;
  mark: bigint;
  nav: bigint;
  sharePrice: bigint;
  swapMarkApr: bigint;
  ifBalance: bigint;
  traderSize: bigint;
  liquidatable: boolean;
  liquidatedHere: boolean;
}

export interface CrashCheckOptions {
  vault: "idle" | "hedged";
  dropBps?: bigint; // default 1500 (CrashDemo DROP_BPS)
  minBlocks?: number; // default 20
}

const WAD = 10n ** 18n;
const MARK_BAND_BPS = 500n; // 5%
const B7_MAX_BLOCKS = 3;
const SWAP_BAND = 2n * 10n ** 17n; // anchor ± 10 APR points = 20 points of range

export function parseCrashCsv(text: string): CrashRow[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  const header = lines.shift();
  if (!header?.startsWith("block_offset,block,index_wad,mark_wad")) throw new Error("not a CrashDemo CSV header");
  return lines.map((l) => {
    const c = l.split(",");
    if (c.length !== 11) throw new Error(`bad row: ${l}`);
    return {
      offset: Number(c[0]),
      block: BigInt(c[1]!),
      index: BigInt(c[2]!),
      mark: BigInt(c[3]!),
      nav: BigInt(c[4]!),
      sharePrice: BigInt(c[5]!),
      swapMarkApr: BigInt(c[6]!),
      ifBalance: BigInt(c[7]!),
      traderSize: BigInt(c[8]!),
      liquidatable: c[9] === "1",
      liquidatedHere: c[10] === "1",
    };
  });
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Returns the list of failed checks (empty = pass). */
export function checkCrash(rows: CrashRow[], o: CrashCheckOptions): string[] {
  const f: string[] = [];
  const drop = o.dropBps ?? 1500n;
  const minBlocks = o.minBlocks ?? 20;
  if (rows.length < minBlocks + 1) f.push(`only ${rows.length - 1} blocks after the start row (< ${minBlocks})`);
  if (rows.length < 2) return f;
  rows.forEach((r, i) => {
    if (r.offset !== i) f.push(`row ${i}: offset ${r.offset}`);
    if (i > 0 && r.block !== rows[i - 1]!.block + 1n) f.push(`row ${i}: block ${r.block} not consecutive`);
  });

  const i0 = rows[0]!.index;
  const i1 = (i0 * (10_000n - drop)) / 10_000n; // CrashDemo: p0 * (10_000 − DROP_BPS) / 10_000
  if (rows[1]!.index !== i1) f.push(`offset 1: index ${rows[1]!.index} != ${i1} (−${drop} bps)`);
  rows.slice(2).forEach((r) => {
    if (r.index !== i1) f.push(`offset ${r.offset}: index moved again (${r.index})`);
  });

  for (const r of rows) {
    const band = (r.index * MARK_BAND_BPS) / 10_000n + 1n;
    if (abs(r.mark - r.index) > band) f.push(`offset ${r.offset}: mark ${r.mark} outside index ± 5%`);
  }

  let liqAt = -1;
  let eligibleAt = -1;
  rows.forEach((r, i) => {
    if (r.liquidatable && eligibleAt < 0) eligibleAt = i;
    if (r.liquidatedHere) {
      if (liqAt >= 0) f.push(`offset ${r.offset}: liquidated a second time`);
      liqAt = i;
      if (!r.liquidatable) f.push(`offset ${r.offset}: liquidated while not liquidatable`);
      if (r.traderSize !== 0n) f.push(`offset ${r.offset}: trader still holds ${r.traderSize} after liquidation`);
    }
    if (i > 0) {
      const d = r.ifBalance - rows[i - 1]!.ifBalance;
      if (d < 0n) f.push(`offset ${r.offset}: IF balance fell by ${-d}`);
      if (d !== 0n && !r.liquidatedHere) f.push(`offset ${r.offset}: IF changed without a liquidation`);
    }
  });
  if (liqAt < 0) f.push("trader never liquidated");
  else if (eligibleAt >= 0 && liqAt - eligibleAt > B7_MAX_BLOCKS) f.push(`liquidated ${liqAt - eligibleAt} blocks after eligibility (> ${B7_MAX_BLOCKS})`);
  if (liqAt >= 0) rows.slice(liqAt).forEach((r) => {
    if (r.traderSize !== 0n) f.push(`offset ${r.offset}: trader re-opened`);
  });

  const nav0 = rows[0]!.nav;
  for (const r of rows) {
    if (o.vault === "idle") {
      if (r.nav !== nav0) f.push(`offset ${r.offset}: idle vault NAV changed ${nav0} → ${r.nav}`);
      if (r.sharePrice !== rows[0]!.sharePrice) f.push(`offset ${r.offset}: idle vault share price changed`);
    } else if (abs(r.nav - nav0) * 1000n > nav0 * 5n) {
      f.push(`offset ${r.offset}: hedged vault NAV moved > 0.5% (${nav0} → ${r.nav})`);
    }
  }

  const aprs = rows.map((r) => r.swapMarkApr);
  const hi = aprs.reduce((a, b) => (b > a ? b : a));
  const lo = aprs.reduce((a, b) => (b < a ? b : a));
  if (hi - lo > SWAP_BAND) f.push(`swap markApr range ${hi - lo} > 20 APR points (decision 18 bound)`);
  return f;
}

/** Short comparison line for two runs (fork vs testnet-shaped local). */
export function summarize(rows: CrashRow[]): string {
  const liq = rows.findIndex((r) => r.liquidatedHere);
  const ifDelta = rows.at(-1)!.ifBalance - rows[0]!.ifBalance;
  const navDelta = rows.at(-1)!.nav - rows[0]!.nav;
  const maxMarkGapBps = rows.reduce((m, r) => {
    const g = (abs(r.mark - r.index) * 10_000n) / r.index;
    return g > m ? g : m;
  }, 0n);
  return `blocks ${rows.length - 1}, liquidated at offset ${liq}, IF Δ ${ifDelta} token units, NAV Δ ${navDelta}, max |mark−index| ${maxMarkGapBps} bps, swap markApr ${Number((rows[0]!.swapMarkApr * 10_000n) / WAD) / 100}% → ${Number((rows.at(-1)!.swapMarkApr * 10_000n) / WAD) / 100}%`;
}
