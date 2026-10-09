// Close all (MOBILE_PLAN N7 §2): one confirm for every open position. A hedged basis pair closes as one two-leg close
// (Meridian first, then Perpl for exactly what closed: exec/closeAll.ts on core's close machine, resumed after a kill);
// unrelated positions close one by one, Meridian first, stopping at the first one that doesn't fill. Plain summary →
// hold (or tap) → the outcome stated exactly, including anything still open.
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAccountAddress } from "../auth/AuthProvider";
import { Screen } from "../features/shell/Screen";
import type { AccountsState } from "../features/trade/data/accounts";
import { ConfirmBar } from "../features/trade/ConfirmBar";
import { planBasisClose, planSingleCloses, type CloseAllMarkets, type CloseAllOutcome, type CloseAllState } from "../features/trade/exec/closeAll";
import { plainTradeError } from "../features/trade/exec/errors";
import { isBasisPair, positionViews } from "../features/trade/positions/views";
import { useAccountReadsWhileFocused, useTrade } from "../features/trade/TradeProvider";
import { useStartOrder } from "../features/trade/useStartOrder";
import { useLive } from "../live/LiveProvider";
import { useMeridian, usePerpl } from "../live/hooks";
import type { MeridianMarketState } from "../live/meridianMarket";
import type { PerplMarketState } from "../live/perplMarket";
import { Store, useStore } from "../live/store";
import { Button, Card, haptic, space, Text } from "../ui";

const selAcc = (s: AccountsState) => s;
const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;
const selRun = (s: CloseAllState) => s;
const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });
const IDLE = new Store<CloseAllState>({ phase: "idle", outcome: undefined, state: undefined });

const PHASE_TEXT: Record<string, string> = {
  CLOSE_MERIDIAN: "Closing on Meridian first…",
  CLOSE_PERPL: "Meridian closed. Closing the same size on Perpl…",
  CLOSE_PERPL_RETRY: "Perpl didn't take it all. Retrying once with more room…",
};

export default function CloseAllModal() {
  const { accounts, closeAll } = useTrade();
  const { address } = useAccountAddress();
  const live = useLive();
  const acc = useStore(accounts?.store ?? NO_ACC, selAcc);
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const run = useStore(closeAll?.store ?? IDLE, selRun);
  const start = useStartOrder();
  const [singles, setSingles] = useState<{ busy: boolean; outcome?: CloseAllOutcome }>({ busy: false });
  useAccountReadsWhileFocused();

  const views = positionViews(acc, m, p);
  const mk: CloseAllMarkets = {
    meridian: { bestBidWad: m?.bestBidWad, bestAskWad: m?.bestAskWad, tickSizeWad: m?.tickSizeWad },
    perpl: { bestBidWad: p?.bestBidWad, bestAskWad: p?.bestAskWad, priceDecimals: p?.priceDecimals ?? 18, sizeDecimals: p?.sizeDecimals ?? 0 },
  };
  const basis = isBasisPair(views) ? planBasisClose(views, mk) : undefined;
  const list = basis ? undefined : planSingleCloses(views, mk);
  const planError = basis && "error" in basis ? basis.error : list && "error" in list ? list.error : undefined;
  const busy = run.phase === "running" || singles.busy;
  const outcome = run.phase === "done" ? run.outcome : singles.outcome;

  const done = () => {
    closeAll?.reset();
    router.back();
  };

  const confirmBasis = () => {
    if (!basis || "error" in basis || !closeAll || !address) return;
    closeAll
      .start(basis, { chainId: live.config.chainId, address, meridianPriceDp: basis.meridian.priceDp, perplPriceDp: basis.perpl.priceDp, meridianStepWad: basis.meridian.stepWad })
      .then((o) => (o?.ok ? haptic.success() : haptic.error()))
      .catch((e: unknown) => {
        haptic.error();
        setSingles({ busy: false, outcome: { ok: false, title: "Nothing closed", detail: plainTradeError(e instanceof Error ? e.message : String(e)) } });
      });
  };

  const confirmSingles = async () => {
    if (!list || "error" in list) return;
    setSingles({ busy: true });
    const closed: string[] = [];
    for (const c of list) {
      try {
        const r = await start({ venue: c.venue, side: c.side, sizeWad: c.sizeWad, reduceOnly: true, limitPriceWad: c.limitPriceWad, summary: c.summary, leverage100: 100 });
        if (!r?.ok) throw new Error(r?.error ?? "Still checking the order…");
        closed.push(c.venue === "meridian" ? "Meridian" : "Perpl");
      } catch (e) {
        haptic.error();
        const left = list.slice(closed.length).map((x) => (x.venue === "meridian" ? "Meridian" : "Perpl"));
        setSingles({ busy: false, outcome: { ok: false, title: closed.length ? "Partly closed" : "Nothing closed", detail: `${closed.length ? `Closed on ${closed.join(" and ")}. ` : ""}${plainTradeError(e instanceof Error ? e.message : String(e))} Still open on ${left.join(" and ")}.` } });
        return;
      }
    }
    haptic.success();
    setSingles({ busy: false, outcome: { ok: true, title: "Everything closed", detail: `Closed on ${closed.join(" and ")}. Nothing is left open.` } });
  };

  return (
    <Screen footer={<Button title={outcome ? "Done" : "Cancel"} variant={outcome ? "primary" : "secondary"} onPress={done} disabled={busy} testID="close-all-done" />}>
      <Text variant="title" accessibilityRole="header">
        Close all
      </Text>
      {outcome ? (
        <Card testID="close-all-outcome">
          <Text bold tone={outcome.ok ? "long" : "short"} accessibilityRole="alert">
            {outcome.title}
          </Text>
          <Text testID="close-all-detail">{outcome.detail}</Text>
        </Card>
      ) : views.length === 0 ? (
        <Text tone="muted" testID="close-all-empty">
          Nothing is open.
        </Text>
      ) : (
        <>
          <Card>
            {basis && !("error" in basis) ? (
              <>
                <Text bold testID="close-all-summary">
                  {basis.summary}
                </Text>
                <Text variant="caption" tone="muted">
                  Meridian goes first because its fill is final onchain; Perpl then closes exactly that size, so you&apos;re never left with more on one side than the other. If Perpl falls short twice, the app tells you exactly what&apos;s left.
                </Text>
              </>
            ) : list && !("error" in list) ? (
              <View style={s.gap}>
                {list.map((c) => (
                  <Text key={c.venue} bold testID={`close-all-${c.venue}`}>
                    {c.summary}
                  </Text>
                ))}
                <Text variant="caption" tone="muted">
                  One after the other, Meridian first. If one doesn&apos;t fill, the rest stay open and you&apos;ll see which.
                </Text>
              </View>
            ) : null}
            {planError ? (
              <Text tone="short" accessibilityRole="alert" testID="close-all-error">
                {planError}
              </Text>
            ) : null}
          </Card>
          {busy ? (
            <Text tone="muted" accessibilityLiveRegion="polite" testID="close-all-progress">
              {run.state ? (PHASE_TEXT[run.state.phase] ?? "Closing…") : "Closing…"}
            </Text>
          ) : null}
          <ConfirmBar action="close everything" onConfirm={() => (basis ? confirmBasis() : void confirmSingles())} disabled={busy || planError !== undefined} testID="close-all" />
        </>
      )}
    </Screen>
  );
}


const s = StyleSheet.create({ gap: { gap: space.s } });
