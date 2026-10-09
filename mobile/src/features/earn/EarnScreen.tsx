// Earn (MOBILE_PLAN N6, research §5.4): hero "Earn X % APR on AUSD" net of fees (live, per block) with the 24 h gap
// sparkline, the hedged position (if any) with Close, the one-tap close of a one-sided leftover, the amount on the shared
// numpad (25 % / 50 % / MAX) → "≈ $Y / day", the legs in plain words, "No edge right now" + Perpl's next funding time,
// blockers fixed inline, hold-to-confirm with a visible tap alternative → the receipt timeline, and a 3-step explainer.
// Same money-action pattern as N5: summary → hold / tap → fingerprint (collateral top-up) → receipt; errors keep input.
import { formatDuration, formatFixed } from "@meridian/core/meridian";
import { wadToFloatForDisplay } from "@meridian/core/util";
import { router, useFocusEffect } from "expo-router";
import { memo, useCallback, useEffect, useState, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import { useBlockNumber, useCadence, useFundingSpread, useMeridian, usePerpl } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState } from "../../live/perplMarket";
import { Store, useStore } from "../../live/store";
import { BlockPulse, Button, Card, colors, haptic, Num, radius, space, Sparkline, Text } from "../../ui";
import { formatUnitsExact } from "../../venues/perpl/amounts";
import { PerplChecks } from "../perpl/PerplOnboarding";
import { ConfirmBar } from "../trade/ConfirmBar";
import { owedToken } from "../trade/exec/collateral";
import { plainTradeError } from "../trade/exec/errors";
import { amountWadOf, presetText } from "../trade/ticket/amountText";
import { Numpad } from "../trade/ticket/Numpad";
import { feeText, priceText, sizeText } from "../trade/ticket/quote";
import { useTrade } from "../trade/TradeProvider";
import { useEarn } from "./EarnProvider";
import { earnReceiptStore, type EarnExecState } from "./executor";
import type { GapHistoryState } from "./history";
import { LeftoverClose } from "./LeftoverClose";
import { EARN_LEVERAGE, planEarnClose, type EarnQuote } from "./plan";
import { FLAT, type EarnPosition } from "./record";
import { TimelineView } from "./TimelineView";
import { useEarnInputs, useEarnQuote, type EarnInputs } from "./useEarnQuote";

/** __DEV__ only (release bundles drop the require; check:release greps for its marker) */
const DevFailToggle: ComponentType<{ value: boolean; onChange: (v: boolean) => void }> | undefined = __DEV__ ? (require("./devFail") as typeof import("./devFail")).DevFailToggle : undefined;

const DEBOUNCE_MS = 150;
const NO_EXEC = new Store<EarnExecState>({ running: false, timeline: undefined, error: undefined });
const NO_POS = new Store<EarnPosition>(FLAT);
const NO_HIST = new Store<GapHistoryState>({ points: [], span: undefined });
const sel = <T,>(s: T) => s;
const selCountdown = (s: PerplMarketState | undefined) => s?.countdown;
const selBlockTime = (s: MeridianMarketState | undefined) => s?.paramBlockTimeMs;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms);
    return () => clearTimeout(h);
  }, [v, ms]);
  return d;
}

const venueName = (v: "perpl" | "meridian") => (v === "perpl" ? "Perpl" : "Meridian");

/** "Short 120 MON on Perpl · Long 120 MON on Meridian" */
export function legsText(q: EarnQuote): string | undefined {
  if (!q.legs || !q.stepWad) return undefined;
  const size = `${sizeText(q.sizeWad, q.stepWad)} MON`;
  const word = (side: "buy" | "sell") => (side === "buy" ? "Long" : "Short");
  return `${word(q.legs.perpl.side)} ${size} on Perpl · ${word(q.legs.meridian.side)} ${size} on Meridian`;
}

const Hero = memo(function Hero({ q }: { q: EarnQuote }) {
  const { history } = useEarn();
  const f = useFundingSpread();
  const h = useStore(history?.store ?? NO_HIST, sel);
  const cd = usePerpl(selCountdown);
  const head = useBlockNumber();
  const cadence = useCadence();
  const blockTime = useMeridian(selBlockTime);
  // 24 h of history once per session (needs the head + measured cadence), then one live point a minute
  useEffect(() => {
    if (head !== undefined && cadence && blockTime !== undefined) void history?.load(head, cadence, blockTime);
  }, [history, head, cadence, blockTime]);
  useEffect(() => history?.onLive(f.spreadAprWad), [history, f.spreadAprWad]);
  const noEdge = q.status === "no-edge" || (q.aprOnAusdWad !== undefined && q.aprOnAusdWad <= 0n);
  const pts = h.points.map((p) => wadToFloatForDisplay(p.gapWad) * 100);
  return (
    <Card>
      <View style={s.row}>
        <Text variant="caption" tone="muted">
          Earn the funding gap, MON
        </Text>
        <BlockPulse />
      </View>
      {noEdge ? (
        <View testID="earn-no-edge">
          <Text variant="hero" bold accessibilityRole="header">
            No edge right now
          </Text>
          <Text tone="muted">
            The gap between the venues doesn't cover the fees today.{" "}
            {cd ? (cd.due ? "Perpl's funding is settling now." : `Perpl's next funding in ${formatDuration(Number(cd.secondsLeft))}.`) : "Perpl's next funding time: —"}
          </Text>
        </View>
      ) : (
        <View>
          <Text variant="title" accessibilityRole="header">
            Earn
          </Text>
          <View style={s.heroLine}>
            <Num value={q.aprOnAusdWad} kind="apr" variant="hero" tone="long" label="Earn per year on AUSD, net of fees" testID="earn-apr" />
            <Text variant="title"> APR on AUSD</Text>
          </View>
          <Text variant="caption" tone="muted">
            Net of both venues' fees over 30 days, at today's gap. Funding changes every block; this isn't guaranteed.
          </Text>
        </View>
      )}
      <Sparkline points={pts} height={44} label={pts.length >= 2 ? `Funding gap, ${h.span === "24h" ? "last 24 hours" : "since you opened Earn"}` : "Funding gap history loading"} />
      <Text variant="caption" tone="muted" testID="earn-spark-span">
        Gap {h.span === "24h" ? "over the last 24 h" : "since you opened Earn"} · now <Num value={q.grossAprWad} kind="apr" variant="caption" label="Funding gap now" />
      </Text>
    </Card>
  );
});

function Explainer() {
  const steps = [
    ["Short where longs pay more", "On the venue whose funding is higher, you're short and collect it every block (Meridian) or every funding interval (Perpl)."],
    ["Long the same size on the other", "Equal MON on both venues, so a MON price move nets to zero: you keep the gap, not the price risk."],
    ["Close any time", "Closing does Meridian first, then Perpl for exactly what closed. If a leg can't fill, the app undoes the other one."],
  ] as const;
  return (
    <Card>
      <Text variant="caption" tone="muted">
        How it works
      </Text>
      {steps.map(([t, b], i) => (
        <View key={t} style={s.step} accessible accessibilityLabel={`Step ${i + 1}: ${t}. ${b}`}>
          <View style={s.num}>
            <Text bold>{i + 1}</Text>
          </View>
          <View style={s.flex}>
            <Text bold>{t}</Text>
            <Text variant="caption" tone="muted">
              {b}
            </Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

function PositionCard({ pos, inputs, onClose, busy }: { pos: EarnPosition; inputs: EarnInputs; onClose: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!pos.perplSide || pos.sizeWad === 0n) return null;
  const step = inputs.perpl.stepWad ?? 10n ** 18n;
  const size = `${sizeText(pos.sizeWad, step)} MON`;
  const word = (b: boolean) => (b ? "Long" : "Short");
  const legs = `${word(pos.perplSide === "buy")} on Perpl · ${word(pos.perplSide !== "buy")} on Meridian`;
  return (
    <Card testID="earn-position">
      <Text variant="caption" tone="muted">
        Your Earn position
      </Text>
      <Text bold testID="earn-position-size">
        {size} each side
      </Text>
      <Text tone="muted">{legs}</Text>
      {confirming ? (
        <>
          <Text testID="earn-close-summary">Close {size} on Meridian first, then the same on Perpl. Worst price within 1% of each book.</Text>
          <ConfirmBar action="close both legs" onConfirm={onClose} disabled={busy} testID="earn-close-confirm" />
          <Button title="Keep it open" variant="link" onPress={() => setConfirming(false)} />
        </>
      ) : (
        <Button title="Close" variant="secondary" onPress={() => setConfirming(true)} disabled={busy} testID="earn-close" />
      )}
    </Card>
  );
}

const STATUS_TEXT: Partial<Record<EarnQuote["status"], string>> = {
  loading: "Reading both venues…",
  empty: "Enter an amount",
  "too-small": "Amount too small for one lot on both venues. Try more AUSD.",
  "no-liquidity": "One of the books can't fill this right now.",
};

export function EarnScreen() {
  const { executor } = useEarn();
  const { focus } = useTrade();
  const inputs = useEarnInputs();
  const [text, setText] = useState("");
  const amountWad = useDebounced(amountWadOf(text), DEBOUNCE_MS);
  const q = useEarnQuote(amountWad, inputs);
  const exec = useStore(executor?.store ?? NO_EXEC, sel);
  const pos = useStore(executor?.position ?? NO_POS, sel);
  const [devFail, setDevFail] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // positions / collateral are read per block only while a trading screen is on top; a run whose outcome was still
  // unknown ("Still checking") is picked up again here, not only on the next unlock
  useFocusEffect(
    useCallback(() => {
      focus.set(true);
      void executor?.resume();
      return () => focus.set(false);
    }, [focus, executor]),
  );

  const presets = [
    { label: "25%", text: presetText(inputs.availableWad, 25) },
    { label: "50%", text: presetText(inputs.availableWad, 50) },
    { label: "MAX", text: presetText(inputs.availableWad, 100) },
  ];
  const legs = q.status === "ok" ? legsText(q) : undefined;
  const busy = exec.running;
  const canConfirm = q.status === "ok" && q.exec !== undefined && !busy && executor !== undefined;
  const deposits = q.legs ? [q.legs.meridian, q.legs.perpl].filter((l) => l.depositWad > 0n) : [];

  const finish = (t: Awaited<ReturnType<NonNullable<typeof executor>["open"]>>, clearInput: boolean) => {
    if (!t) {
      haptic.error();
      setError(executor?.store.get().error ?? "Still checking the orders. They'll finish on their own; you'll see the receipt.");
      return;
    }
    if (clearInput && (t.outcome === "success" || t.outcome === "partial")) setText("");
    earnReceiptStore.set(t);
    router.push("/earn-receipt");
  };
  const fail = (e: unknown) => {
    haptic.error();
    setError(plainTradeError(e instanceof Error ? e.message : String(e)));
  };

  const confirm = () => {
    if (!canConfirm || !legs) return;
    setError(undefined);
    executor!
      .open(q.exec!, { summary: legs, perplPriceDp: inputs.perplPriceDp, meridianPriceDp: inputs.meridianPriceDp, leverage100: Number(EARN_LEVERAGE) * 100, ...(__DEV__ && devFail ? { devFailMeridian: true } : {}) })
      .then((t) => finish(t, true), fail);
  };

  const closePair = () => {
    if (!executor || busy) return;
    const a = inputs.accounts;
    const pp = a.perpl?.position;
    const plan = planEarnClose({
      perplSide: pos.perplSide,
      sizeWad: pos.sizeWad,
      meridianSizeWad: a.meridian?.sizeWad,
      perpl: pp ? { side: pp.side, sizeWad: pp.sizeWad } : undefined,
      meridian: inputs.meridian,
      perplBook: inputs.perpl,
    });
    if (!plan.ok) return fail(new Error(plan.error));
    setError(undefined);
    executor.close(plan.plan, { summary: `Close ${sizeText(plan.sizeWad, inputs.perpl.stepWad ?? 1n)} MON on both venues`, perplPriceDp: inputs.perplPriceDp, meridianPriceDp: inputs.meridianPriceDp, leverage100: Number(EARN_LEVERAGE) * 100 }).then((t) => finish(t, false), fail);
  };

  return (
    <>
      <Hero q={q} />
      {pos.naked ? <LeftoverClose naked={pos.naked} executor={executor} /> : null}
      <PositionCard pos={pos} inputs={inputs} onClose={closePair} busy={busy} />

      <Card>
        <Numpad text={text} onChange={setText} presets={presets} caption="Split evenly between Meridian and Perpl" testID="earn" />
        <View style={s.center}>
          <Text bold testID="earn-per-day">
            {q.perDayWad !== undefined && q.status === "ok" ? `≈ $${formatFixed(q.perDayWad > 0n ? q.perDayWad : 0n, 18, 2)} / day` : "≈ $— / day"}
          </Text>
          <Text variant="caption" tone="muted">
            at today's gap, after fees
          </Text>
        </View>
        {legs ? (
          <View style={s.summary}>
            <Text bold testID="earn-legs">
              {legs}
            </Text>
            <Text variant="caption" tone="muted">
              Perpl first (fill or cancel), then Meridian for exactly what filled. Worst prices {priceText(q.legs!.perpl.limitPriceWad, inputs.perplPriceDp)} on Perpl, {priceText(q.legs!.meridian.limitPriceWad, inputs.meridianPriceDp)} on Meridian · fees {feeText(q.legs!.perpl.feeWad + q.legs!.meridian.feeWad)}
            </Text>
            {deposits.length ? (
              <Text variant="caption" tone="muted" testID="earn-deposits">
                Adds {deposits.map((l) => `${formatUnitsExact(owedToken(l.depositWad), 6)} AUSD to ${venueName(l.venue)}`).join(" and ")} from your wallet first (one fingerprint prompt).
              </Text>
            ) : null}
          </View>
        ) : STATUS_TEXT[q.status] ? (
          <Text tone="muted" testID="earn-status">
            {STATUS_TEXT[q.status]}
          </Text>
        ) : null}
        {q.blockers.map((b) =>
          b.kind === "onboard" ? (
            <View key="onboard" style={s.block} testID="earn-blocker-onboard">
              <Text bold>Set up Perpl (one time)</Text>
              <PerplChecks compact />
            </View>
          ) : b.kind === "fund" ? (
            <View key={`fund-${b.venue}`} style={s.block} testID={`earn-blocker-fund-${b.venue}`}>
              <Text>
                You need {formatUnitsExact(owedToken(b.shortWad), 6)} more AUSD in your wallet for the {venueName(b.venue)} leg.
              </Text>
              <Button title="Add funds" variant="secondary" onPress={() => router.push("/fund")} />
            </View>
          ) : (
            <Text key={`lev-${b.venue}`} tone="warn">
              {venueName(b.venue)} allows at most {b.max}× right now; Earn uses {EARN_LEVERAGE.toString()}× per leg.
            </Text>
          ),
        )}
        {DevFailToggle ? <DevFailToggle value={devFail} onChange={setDevFail} /> : null}
        {error ? (
          <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="earn-error">
            {error}
          </Text>
        ) : null}
        <ConfirmBar action="start earning" onConfirm={confirm} disabled={!canConfirm} testID="earn-confirm" />
        {busy && exec.timeline ? (
          <View style={s.summary} accessibilityLiveRegion="polite" testID="earn-progress">
            <Text bold>{exec.timeline.headline}</Text>
            <TimelineView t={exec.timeline} testID="earn-live" />
          </View>
        ) : null}
        {!busy && exec.resumed && exec.timeline ? (
          <View style={s.summary} testID="earn-resumed">
            <Text bold>Finished after the app reopened: {exec.timeline.headline}</Text>
            <Button
              title="See the receipt"
              variant="link"
              onPress={() => {
                earnReceiptStore.set(exec.timeline);
                router.push("/earn-receipt");
              }}
            />
          </View>
        ) : null}
        {!busy && exec.error ? (
          <Text variant="caption" tone="warn" testID="earn-checking">
            {exec.error}
          </Text>
        ) : null}
      </Card>
      <Explainer />
    </>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroLine: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap" },
  center: { alignItems: "center", gap: 2 },
  summary: { gap: space.xs, padding: space.m, borderRadius: radius.inner, backgroundColor: colors.bg },
  block: { gap: space.s, padding: space.m, borderRadius: radius.inner, borderWidth: 1, borderColor: colors.border },
  step: { flexDirection: "row", gap: space.m, alignItems: "flex-start" },
  num: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.brand, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1, gap: 2 },
});
