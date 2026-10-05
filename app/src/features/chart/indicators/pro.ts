// Pro indicators (FRONTEND_TRADE_PLAN §4.3). Display-only floats on OHLCV; written from the textbook definitions.
export type Ohlcv = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Out = (number | undefined)[];

/** True range: max(H − L, |H − prevC|, |L − prevC|); first bar = H − L. */
export function trueRange(b: readonly Ohlcv[]): number[] {
  return b.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1]!.close), Math.abs(x.low - b[i - 1]!.close))));
}

/** Wilder smoothing: first value = mean of the first n inputs, then (prev·(n−1) + x)/n. */
export function wilder(v: readonly number[], n: number, start = 0): Out {
  const out: Out = v.map(() => undefined);
  if (v.length - start < n) return out;
  let s = 0;
  for (let i = start; i < start + n; i++) s += v[i]!;
  let prev = s / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < v.length; i++) {
    prev = (prev * (n - 1) + v[i]!) / n;
    out[i] = prev;
  }
  return out;
}

/** ATR(n), Wilder. */
export const atr = (b: readonly Ohlcv[], n = 14): Out => wilder(trueRange(b), n);

/** Session VWAP reset at each UTC day: Σ(typical·vol)/Σvol, typical = (H+L+C)/3; undefined until volume trades. */
export function vwap(b: readonly Ohlcv[]): Out {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return b.map((x) => {
    const d = Math.floor(x.time / 86_400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((x.high + x.low + x.close) / 3) * x.volume;
    vol += x.volume;
    return vol > 0 ? pv / vol : undefined;
  });
}

/** Stochastic %K(n) = 100·(C − LL)/(HH − LL) (50 when flat), %D = SMA(d) of %K. */
export function stochastic(b: readonly Ohlcv[], n = 14, d = 3): { k: Out; d: Out } {
  const k: Out = b.map((x, i) => {
    if (i < n - 1) return undefined;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, b[j]!.high);
      ll = Math.min(ll, b[j]!.low);
    }
    return hh === ll ? 50 : (100 * (x.close - ll)) / (hh - ll);
  });
  const dd: Out = k.map((_, i) => {
    if (i < n - 1 + d - 1) return undefined;
    let s = 0;
    for (let j = i - d + 1; j <= i; j++) s += k[j]!;
    return s / d;
  });
  return { k, d: dd };
}

/** On-balance volume: +vol on an up close, −vol on a down close, unchanged on equal; starts at 0. */
export function obv(b: readonly Ohlcv[]): number[] {
  let acc = 0;
  return b.map((x, i) => {
    if (i > 0) acc += x.close > b[i - 1]!.close ? x.volume : x.close < b[i - 1]!.close ? -x.volume : 0;
    return acc;
  });
}

/**
 * ADX(n), Wilder: +DM = up move if > down move and > 0, −DM symmetric; +DI = 100·W(+DM)/W(TR), −DI likewise;
 * DX = 100·|+DI − −DI|/(+DI + −DI); ADX = Wilder(n) of DX. DM/TR start at bar 1.
 */
export function adx(b: readonly Ohlcv[], n = 14): { adx: Out; plusDi: Out; minusDi: Out } {
  const pdm = b.map((x, i) => (i === 0 ? 0 : (() => { const up = x.high - b[i - 1]!.high; const dn = b[i - 1]!.low - x.low; return up > dn && up > 0 ? up : 0; })()));
  const mdm = b.map((x, i) => (i === 0 ? 0 : (() => { const up = x.high - b[i - 1]!.high; const dn = b[i - 1]!.low - x.low; return dn > up && dn > 0 ? dn : 0; })()));
  const tr = trueRange(b);
  const sp = wilder(pdm, n, 1);
  const sm = wilder(mdm, n, 1);
  const st = wilder(tr, n, 1);
  const plusDi: Out = sp.map((v, i) => (v === undefined || !st[i] ? undefined : (100 * v) / st[i]!));
  const minusDi: Out = sm.map((v, i) => (v === undefined || !st[i] ? undefined : (100 * v) / st[i]!));
  const dx = plusDi.map((p, i) => (p === undefined || minusDi[i] === undefined ? undefined : p + minusDi[i]! === 0 ? 0 : (100 * Math.abs(p - minusDi[i]!)) / (p + minusDi[i]!)));
  const first = dx.findIndex((v) => v !== undefined);
  const adxOut: Out = first < 0 ? dx.map(() => undefined) : wilder(dx.map((v) => v ?? 0), n, first);
  return { adx: adxOut, plusDi, minusDi };
}

/**
 * Ichimoku (9, 26, 52): Tenkan = mid of 9-bar range, Kijun = mid of 26, Senkou A = (T+K)/2 and Senkou B = mid of 52,
 * both plotted `displacement` bars ahead (here: returned at their own index; the caller shifts time), Chikou = close.
 */
export function ichimoku(b: readonly Ohlcv[], t = 9, k = 26, s = 52) {
  const mid = (n: number) =>
    b.map((_, i) => {
      if (i < n - 1) return undefined;
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        hh = Math.max(hh, b[j]!.high);
        ll = Math.min(ll, b[j]!.low);
      }
      return (hh + ll) / 2;
    });
  const tenkan = mid(t);
  const kijun = mid(k);
  const spanA: Out = tenkan.map((x, i) => (x === undefined || kijun[i] === undefined ? undefined : (x + kijun[i]!) / 2));
  return { tenkan, kijun, spanA, spanB: mid(s), displacement: k };
}

/**
 * Supertrend(n, m): basic bands = (H+L)/2 ± m·ATR(n); final bands ratchet (upper only falls while price stays below,
 * lower only rises while price stays above); trend flips when the close crosses the active band.
 */
export function supertrend(b: readonly Ohlcv[], n = 10, m = 3): { line: Out; up: (boolean | undefined)[] } {
  const a = atr(b, n);
  const line: Out = b.map(() => undefined);
  const up: (boolean | undefined)[] = b.map(() => undefined);
  let fu = 0;
  let fl = 0;
  let trendUp = true;
  let started = false;
  for (let i = 0; i < b.length; i++) {
    const v = a[i];
    if (v === undefined) continue;
    const hl2 = (b[i]!.high + b[i]!.low) / 2;
    const bu = hl2 + m * v;
    const bl = hl2 - m * v;
    if (!started) {
      fu = bu;
      fl = bl;
      trendUp = b[i]!.close >= hl2;
      started = true;
    } else {
      const pc = b[i - 1]!.close;
      fu = bu < fu || pc > fu ? bu : fu;
      fl = bl > fl || pc < fl ? bl : fl;
      if (trendUp && b[i]!.close < fl) trendUp = false;
      else if (!trendUp && b[i]!.close > fu) trendUp = true;
    }
    line[i] = trendUp ? fl : fu;
    up[i] = trendUp;
  }
  return { line, up };
}
