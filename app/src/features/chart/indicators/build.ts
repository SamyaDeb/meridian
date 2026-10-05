// Turns the chart's bars + chosen indicators into engine overlays / panes (display floats only).
import type { Bar } from "../datafeed/types";
import type { LineOverlay, PaneSpec, Point } from "../engine/types";
import { wadToNum } from "../series";
import type { IndicatorId } from "../store";
import { bollinger, ema, macd, rsi, sma } from ".";
import { adx, atr, ichimoku, obv, stochastic, supertrend, vwap, type Ohlcv } from "./pro";

export const INDICATOR_LABEL: Record<IndicatorId, string> = {
  sma20: "SMA 20",
  ema50: "EMA 50",
  bb20: "Bollinger 20, 2σ",
  rsi14: "RSI 14",
  macd: "MACD 12 26 9",
  vwap: "VWAP (UTC session)",
  atr14: "ATR 14",
  stoch: "Stochastic 14 3",
  adx14: "ADX 14",
  ichimoku: "Ichimoku 9 26 52",
  obv: "OBV",
  supertrend: "Supertrend 10 3",
};
/** Core set first, pro set after (menu sections). */
export const CORE_INDICATORS: readonly IndicatorId[] = ["sma20", "ema50", "bb20", "rsi14", "macd"];
export const PRO_INDICATORS: readonly IndicatorId[] = ["vwap", "atr14", "stoch", "adx14", "ichimoku", "obv", "supertrend"];

const pts = (bars: readonly Bar[], vals: (number | undefined)[]): Point[] =>
  bars.flatMap((b, i) => (vals[i] === undefined ? [] : [{ time: b.time, value: vals[i]! }]));

export function buildIndicators(bars: readonly Bar[], ids: readonly IndicatorId[]): { overlays: LineOverlay[]; panes: PaneSpec[] } {
  const real = bars.filter((b) => !b.gapFill); // gap-fill bars are not prices that traded: keep them out of the maths
  const c = real.map((b) => wadToNum(b.close));
  const o: Ohlcv[] = real.map((b) => ({ time: b.time, open: wadToNum(b.open), high: wadToNum(b.high), low: wadToNum(b.low), close: wadToNum(b.close), volume: wadToNum(b.volumeBaseWad) }));
  const step = real.length > 1 ? real[real.length - 1]!.time - real[real.length - 2]!.time : 60;
  const overlays: LineOverlay[] = [];
  const panes: PaneSpec[] = [];
  for (const id of ids) {
    if (id === "sma20") overlays.push({ id, tone: "brand", points: pts(real, sma(c, 20)) });
    if (id === "ema50") overlays.push({ id, tone: "warn", points: pts(real, ema(c, 50)) });
    if (id === "bb20") {
      const b = bollinger(c, 20, 2);
      overlays.push({ id: "bb20-mid", tone: "muted", points: pts(real, b.middle) }, { id: "bb20-up", tone: "muted", points: pts(real, b.upper) }, { id: "bb20-lo", tone: "muted", points: pts(real, b.lower) });
    }
    if (id === "rsi14") panes.push({ id, title: "RSI 14", guides: [30, 70], series: [{ id: "rsi", kind: "line", tone: "brand", points: pts(real, rsi(c, 14)) }] });
    if (id === "macd") {
      const m = macd(c);
      panes.push({
        id,
        title: "MACD",
        guides: [0],
        series: [
          { id: "hist", kind: "histogram", tone: "muted", signedColors: true, points: pts(real, m.histogram) },
          { id: "line", kind: "line", tone: "brand", points: pts(real, m.line) },
          { id: "signal", kind: "line", tone: "warn", points: pts(real, m.signal) },
        ],
      });
    }
    if (id === "vwap") overlays.push({ id, tone: "text", points: pts(real, vwap(o)) });
    if (id === "supertrend") overlays.push({ id, tone: "warn", width: 2, points: pts(real, supertrend(o).line) });
    if (id === "ichimoku") {
      const r = ichimoku(o);
      // spans plot `displacement` bars ahead
      const ahead = (vals: (number | undefined)[]) => pts(real, vals).map((p) => ({ time: p.time + r.displacement * step, value: p.value }));
      overlays.push(
        { id: "ichi-tenkan", tone: "brand", points: pts(real, r.tenkan) },
        { id: "ichi-kijun", tone: "short", points: pts(real, r.kijun) },
        { id: "ichi-a", tone: "long", points: ahead(r.spanA) },
        { id: "ichi-b", tone: "muted", points: ahead(r.spanB) },
      );
    }
    if (id === "atr14") panes.push({ id, title: "ATR 14", series: [{ id: "atr", kind: "line", tone: "brand", points: pts(real, atr(o, 14)) }] });
    if (id === "stoch") {
      const s = stochastic(o, 14, 3);
      panes.push({ id, title: "Stochastic", guides: [20, 80], series: [{ id: "k", kind: "line", tone: "brand", points: pts(real, s.k) }, { id: "d", kind: "line", tone: "warn", points: pts(real, s.d) }] });
    }
    if (id === "adx14") {
      const a = adx(o, 14);
      panes.push({
        id,
        title: "ADX 14",
        guides: [25],
        series: [
          { id: "adx", kind: "line", tone: "brand", points: pts(real, a.adx) },
          { id: "pdi", kind: "line", tone: "long", points: pts(real, a.plusDi) },
          { id: "mdi", kind: "line", tone: "short", points: pts(real, a.minusDi) },
        ],
      });
    }
    if (id === "obv") {
      const v = obv(o);
      panes.push({ id, title: "OBV", series: [{ id: "obv", kind: "line", tone: "brand", points: real.map((b, i) => ({ time: b.time, value: v[i]! })) }] });
    }
  }
  return { overlays, panes };
}
