# Chart top bar and bottom bar: behavioural spec

Written 7 Oct 2026 (K0.2) as the input for a clean-room rewrite of Meridian's chart chrome. It describes **behaviour only**: what a trader sees and can do, the accessible names the e2e suite relies on, and the design tokens. It was written from the `ChartCard` call site, the e2e specs (`app/e2e/chart.spec.ts`, `drawings.spec.ts`), the chart view store (`store.ts`) and the rendered app (accessibility tree + screenshots at 390 and 1440 px), not from any previous implementation of the bars.

Why: commit `de40466` (5 Oct) ported a chart top bar from a prior project, which CLAUDE.md rule 2 forbids. The bars are rewritten from this document so that no line of that port, or of files derived from it, remains.

## 1. Where the bars sit

The chart card is a column: **top bar** · (tool rail + chart canvas) · **bottom bar**. Both bars span the card's full width, are separated from the canvas by a 1 px `--border` hairline, and never scroll the page horizontally: when the top bar's controls don't fit (390 px, coarse pointers) its action group wraps onto a second row (a scrolling row would clip the panels that open from it); the bottom bar's range group scrolls horizontally inside itself. No control may be clipped out of reach.

## 2. Top bar

`role="toolbar"`, accessible name **"Chart controls"**, one 44 px row where it fits. Left group: the view controls. Right group (pushed to the end): undo / redo, full screen, save image. A thin vertical divider separates the view controls from each other.

| Control | Accessible name | Trigger content | Behaviour |
|---|---|---|---|
| Timeframe | `Timeframe` | the current timeframe as text (e.g. `15m`) | Opens a panel with three captioned sections: **Minutes** (1m 3m 5m 15m 30m), **Hours** (1h 2h 4h 6h 12h), **Days** (1D 1W). Each option is a `menuitemradio` named exactly its label, `aria-checked` on the current one. Picking one sets `timeframe`, closes the panel. |
| Chart type | `Chart type` | the icon for the current type | Options (`menuitemradio`): Candles, Hollow candles, Bars, Line, Area, Heikin-Ashi. Picking closes the panel. |
| Price source | `Price source` | the current source's short label (`Last`, `Mark`, `Index`, `MON/USD ref (Monad DEX)`) | Options (`menuitemradio`), each with its label and a one-line hint below it. Last = "Trades on Meridian's MON-PERP book"; Mark = "Mark price (drives PnL, liquidation and funding)"; Index = "Oracle MON/USD index (spot reference; nobody trades at it here)"; Reference (only when the reference flag is on) = "MON/USDC on Uniswap v4 (Monad mainnet) via GeckoTerminal. Not Meridian trades." The option's accessible name starts with the label. Picking closes the panel. |
| Indicators | `Indicators` | a chart-line icon, plus the word "Indicators" from `sm` up; a count badge when any are on | Panel with two labelled groups, **Core** (SMA 20, EMA 50, Bollinger 20 2σ, RSI 14, MACD 12 26 9) and **Pro** (VWAP, ATR 14, Stochastic, ADX 14, Ichimoku, OBV, Supertrend), names from `INDICATOR_LABEL`. Each is a checkbox reachable by its label. Toggling keeps the panel open (several can be picked in one go). |
| Undo | `Undo drawing` | undo arrow | Disabled when there is nothing to undo. |
| Redo | `Redo drawing` | redo arrow | Disabled when there is nothing to redo. |
| Full screen | `Full screen` | expand icon | Toggle; `aria-pressed` reflects the state. |
| Save image | `Save chart image` | camera icon | Downloads a PNG of the chart. |

Panels: the shared `Popover` behaviour (labelled region named like its trigger, `aria-expanded` on the trigger, closes on Esc with focus back on the trigger, closes on an outside click). Selecting any of the source / type / timeframe options updates the per-market chart view (persisted per viewer), and the chart refits.

The top bar holds no state of its own beyond what the panels need; it receives the view and reports changes as a partial patch (`{ timeframe }`, `{ chartType }`, `{ source }`, `{ indicators }`).

## 3. Bottom bar

One row, at least 40 px tall, small type (12.5 px), split into:

1. **Range group** (`role="group"`, name `Range`): 1D 5D 1M 3M 6M YTD 1Y 5Y All. Each is a button with `aria-pressed` for the active range. A range picks its own timeframe and visible window (`chrome/ranges.ts`, unchanged), e.g. 5D ⇒ 5m. Choosing a timeframe in the top bar clears the active range.
2. **History note** (`data-testid="history-start"`, truncates, hidden below `sm`): one of
   - reference source: "MON/USDC on Uniswap v4 (Monad) from YYYY-MM-DD HH:MM UTC, via GeckoTerminal";
   - session mode (no indexer): "Session data since HH:MM UTC (indexer not connected: full history appears once it is)";
   - otherwise "History starts at YYYY-MM-DD HH:MM UTC", or "No candle history" when there are no real bars;
   - with the Mark source, appended: " · mark: last N funding blocks" (N grouped, e.g. 2,000).
3. **Status chips + clock + settings** (right): "funding: no update in the log window" when the funding pane is on and no ticks were found; "times ≈ from block height" when any tick lacks a timestamp; the UTC wall clock `HH:MM:SS UTC` (accessible name `UTC time`, hidden below `sm`); and the **Chart settings** popover (gear icon) with checkboxes Volume, Mark price line, Index price line, Funding rate pane, a "Reset chart view" action (restores the default view but keeps the chosen indicators, clears the range), and the line "Lightweight Charts by TradingView" (library attribution, required by its licence).

## 4. Sizing, tokens, a11y

- Controls are 32 px tall on fine pointers and **at least 44 × 44 px on coarse pointers** (`pointer-coarse:` variants). Icon buttons are square.
- Colours only from tokens: `--text`, `--muted`, `--card-2` (hover / active fill), `--border`, `--brand` / `--brand-tint` / `--brand-soft` (Monad violet for the active timeframe and the indicator count). Radius: control 8 px (`rounded-control` scale) or 6 px inside bars.
- Every icon is `aria-hidden`; every icon-only button has an accessible name and a `title` tooltip.
- Visible focus ring on every control (the app's global `:focus-visible` style).
- Numbers (timeframe, clock) use the tabular `num` class.
- axe: no violations on `/trade` at 390 and 1440 px.

## 5. Acceptance

- `app/e2e/chart.spec.ts` and `drawings.spec.ts` pass unchanged (they only use the names above).
- At 390 px every top-bar control is visible and reachable (nothing clipped).
- The top bar and the bottom bar are new files written from this spec; the previous `chrome/TopBar.tsx` (which descends from the ported file) is deleted. The tool rail, icons, ranges and full-screen hook were written for Meridian (not ported) and stay.
