// Close all (MOBILE_PLAN N7 §2, with N6's Earn + Lock): one confirm for every open position. An open Earn pair closes
// as the Earn screen closes it (the fixed-rate lock first, in full, else nothing else is sent; then Meridian, then Perpl
// for exactly what closed: earn/closeAll.ts on the Earn executor, resumed after a kill, the Earn record updated). Other
// positions keep N7's path, after the Earn pair: a hedged pair as one two-leg close (exec/closeAll.ts on core's close
// machine), the rest one by one, Meridian first, stopping at the first that doesn't fill. A lock without its Earn record
// is refused with the reason. Plain summary → hold (or tap) → the outcome stated exactly, including anything still open.
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAccountAddress } from "../auth/AuthProvider";
import { planCloseAll, runCloseAll, type CloseAllResult, type CloseAllRoute, type RestRoute } from "../features/earn/closeAll";
import { swapMarketDeployed } from "../features/earn/closePair";
import { useEarn } from "../features/earn/EarnProvider";
import { earnReceiptStore, type EarnExecState } from "../features/earn/executor";
import { FLAT, type EarnPosition } from "../features/earn/record";
import { useEarnInputs } from "../features/earn/useEarnQuote";
import { Screen } from "../features/shell/Screen";
import { ConfirmBar } from "../features/trade/ConfirmBar";
import type { CloseAllMarkets, CloseAllState } from "../features/trade/exec/closeAll";
import { positionViews } from "../features/trade/positions/views";
import { useAccountReadsWhileFocused, useTrade } from "../features/trade/TradeProvider";
import { useStartOrder } from "../features/trade/useStartOrder";
import { useLive } from "../live/LiveProvider";
import { useMeridian, usePerpl } from "../live/hooks";
import type { MeridianMarketState } from "../live/meridianMarket";
import type { PerplMarketState } from "../live/perplMarket";
import { Store, useStore } from "../live/store";
import { Button, Card, haptic, space, Text } from "../ui";

const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;
const sel = <T,>(s: T) => s;
const IDLE = new Store<CloseAllState>({ phase: "idle", outcome: undefined, state: undefined });
const NO_EXEC = new Store<EarnExecState>({ running: false, timeline: undefined, error: undefined });
const NO_POS = new Store<EarnPosition>(FLAT);

const PHASE_TEXT: Record<string, string> = {
  CLOSE_MERIDIAN: "Closing on Meridian first…",
  CLOSE_PERPL: "Meridian closed. Closing the same size on Perpl…",
  CLOSE_PERPL_RETRY: "Perpl didn't take it all. Retrying once with more room…",
};

function RestLines({ rest }: { rest: RestRoute | undefined }) {
  if (!rest) return null;
  if (rest.kind === "basis")
    return (
      <>
        <Text bold testID="close-all-summary">
          {rest.plan.summary}
        </Text>
        <Text variant="caption" tone="muted">
          Meridian goes first because its fill is final onchain; Perpl then closes exactly that size, so you&apos;re never left with more on one side than the other. If Perpl falls short twice, the app tells you exactly what&apos;s left.
        </Text>
      </>
    );
  if (rest.kind === "singles")
    return (
      <View style={s.gap}>
        {rest.list.map((c) => (
          <Text key={c.venue} bold testID={`close-all-${c.venue}`}>
            {c.summary}
          </Text>
        ))}
        <Text variant="caption" tone="muted">
          One after the other, Meridian first. If one doesn&apos;t fill, the rest stay open and you&apos;ll see which.
        </Text>
      </View>
    );
  return null;
}

export default function CloseAllModal() {
  const { closeAll } = useTrade();
  const earn = useEarn();
  const { address } = useAccountAddress();
  const live = useLive();
  const inputs = useEarnInputs();
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const run = useStore(closeAll?.store ?? IDLE, sel);
  const earnRun = useStore(earn.executor?.store ?? NO_EXEC, sel);
  const earnPosNow = useStore(earn.executor?.position ?? NO_POS, sel);
  const start = useStartOrder();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseAllResult | undefined>();
  const [earnLoaded, setEarnLoaded] = useState(false);
  useAccountReadsWhileFocused();
  // the wallet's fixed-rate lock is read per block while this is on top (a lock must never be left without its hedge)
  useFocusEffect(useCallback(() => earn.swap?.hold(), [earn.swap]));
  // the Earn record from storage (an app start may not have read it yet)
  useEffect(() => {
    if (!earn.executor) return;
    let alive = true;
    void earn.executor.loadPosition().then(() => alive && setEarnLoaded(true), () => undefined);
    return () => {
      alive = false;
    };
  }, [earn.executor]);

  const views = positionViews(inputs.accounts, m, p);
  const mk: CloseAllMarkets = {
    meridian: { bestBidWad: m?.bestBidWad, bestAskWad: m?.bestAskWad, tickSizeWad: m?.tickSizeWad },
    perpl: { bestBidWad: p?.bestBidWad, bestAskWad: p?.bestAskWad, priceDecimals: p?.priceDecimals ?? 18, sizeDecimals: p?.sizeDecimals ?? 0 },
  };
  const route: CloseAllRoute = planCloseAll({ views, mk, earnPos: !earn.executor ? null : earnLoaded ? earnPosNow : undefined, inputs, swapMarket: swapMarketDeployed(live.config.meridian) });
  const runnable = route.kind === "earn" || route.kind === "plain" ? route : undefined;
  const planError = route.kind === "refused" ? route.error : runnable?.rest?.kind === "error" ? runnable.rest.error : undefined;

  const done = () => {
    closeAll?.reset();
    router.back();
  };

  const confirm = () => {
    if (!runnable || planError || busy) return;
    setBusy(true);
    void runCloseAll(runnable, {
      earn: earn.executor,
      basis: async (plan) => {
        if (!closeAll || !address) throw new Error("Unlock to trade");
        const outcome = await closeAll.start(plan, { chainId: live.config.chainId, address, meridianPriceDp: plan.meridian.priceDp, perplPriceDp: plan.perpl.priceDp, meridianStepWad: plan.meridian.stepWad });
        return { outcome, state: closeAll.store.get().state };
      },
      single: (c) => start({ venue: c.venue, side: c.side, sizeWad: c.sizeWad, reduceOnly: true, limitPriceWad: c.limitPriceWad, summary: c.summary, leverage100: 100 }),
    }).then((r) => {
      if (r.ok) haptic.success();
      else haptic.error();
      setResult(r);
      setBusy(false);
    });
  };

  const progress = earnRun.running && earnRun.timeline ? earnRun.timeline.headline : run.phase === "running" && run.state ? (PHASE_TEXT[run.state.phase] ?? "Closing…") : "Closing…";

  return (
    <Screen footer={<Button title={result ? "Done" : "Cancel"} variant={result ? "primary" : "secondary"} onPress={done} disabled={busy} testID="close-all-done" />}>
      <Text variant="title" accessibilityRole="header">
        Close all
      </Text>
      {result ? (
        <Card testID="close-all-outcome">
          <Text bold tone={result.ok ? "long" : "short"} accessibilityRole="alert">
            {result.title}
          </Text>
          <Text testID="close-all-detail">{result.detail}</Text>
          {result.earn ? (
            <Button
              title="See the Earn receipt"
              variant="link"
              onPress={() => {
                earnReceiptStore.set(result.earn);
                router.push("/earn-receipt");
              }}
              testID="close-all-earn-receipt"
            />
          ) : null}
        </Card>
      ) : route.kind === "empty" ? (
        <Text tone="muted" testID="close-all-empty">
          Nothing is open.
        </Text>
      ) : (
        <>
          <Card>
            {route.kind === "wait" ? (
              <Text tone="muted" testID="close-all-wait">
                {route.reason}
              </Text>
            ) : null}
            {route.kind === "earn" ? (
              <View style={s.gap}>
                <Text bold testID="close-all-earn">
                  {route.summary}
                </Text>
                <Text variant="caption" tone="muted">
                  {route.earn.swap ? "If the lock doesn't close in full, nothing else is sent, so the lock is never left without its hedge. " : ""}Then Perpl closes exactly what Meridian closed, as on the Earn screen.{route.rest ? " Your other positions close after that." : ""}
                </Text>
              </View>
            ) : null}
            {runnable ? <RestLines rest={runnable.rest} /> : null}
            {planError ? (
              <Text tone="short" accessibilityRole="alert" testID="close-all-error">
                {planError}
              </Text>
            ) : null}
          </Card>
          {busy ? (
            <Text tone="muted" accessibilityLiveRegion="polite" testID="close-all-progress">
              {progress}
            </Text>
          ) : null}
          <ConfirmBar action="close everything" onConfirm={confirm} disabled={busy || !runnable || planError !== undefined} testID="close-all" />
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({ gap: { gap: space.s } });
