// Position cards under the chart (research §5.2/§5.3): side, size, entry, live PnL, liquidation price + distance meter,
// funding accrued, swipe → Close with a visible Close button (ui/SwipeRow fallback). An open Earn pair is grouped by its
// record ("Earn · basis"); without one, a Meridian + Perpl pair of equal, opposite MON size is shown as one basis trade
// (fallback). Close = reduce-only for the whole size (planClose),
// confirmed with hold-or-tap on a summary sheet, then the receipt. Numbers: Meridian AccountView (contract's own PnL /
// liq), Perpl getPositionV2 via core perplPositionRisk (Perpl's own rule).
import { router } from "expo-router";
import { memo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMeridian, usePerpl } from "../../../live/hooks";
import type { MeridianMarketState } from "../../../live/meridianMarket";
import type { PerplMarketState } from "../../../live/perplMarket";
import { Store, useStore } from "../../../live/store";
import { Button, Card, haptic, Meter, Num, Sheet, space, SwipeRow, Text, type SheetRef } from "../../../ui";
import { plainTradeError } from "../exec/errors";
import { priceText, sizeText } from "../ticket/quote";
import { ConfirmBar } from "../ConfirmBar";
import { useTrade } from "../TradeProvider";
import { useStartOrder } from "../useStartOrder";
import type { AccountsState } from "../data/accounts";
import { planClose } from "./close";
import { groupOf, positionViews, type EarnPair, type PositionView } from "./views";

export { groupOf, isBasisPair, liqDistance, positionViews, type EarnPair, type PositionView } from "./views";

const selAcc = (s: AccountsState) => s;
const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;
const EMPTY_ACC = { atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined } as AccountsState;
const NO_ACC = new Store<AccountsState>(EMPTY_ACC);

/** meter fill: 20 % away or more = full; tone by danger (< 5 % red, < 10 % amber) */
const meterOf = (bps: bigint | undefined): { bps: number | undefined; tone: "long" | "warn" | "short" } => (bps === undefined ? { bps: undefined, tone: "long" } : { bps: Math.min(10_000, Number(bps) * 5), tone: bps < 500n ? "short" : bps < 1_000n ? "warn" : "long" });

function Card1({ v, onClose }: { v: PositionView; onClose: () => void }) {
  const long = v.sizeWad > 0n;
  const abs = long ? v.sizeWad : -v.sizeWad;
  const meter = meterOf(v.distanceBps);
  const label = `${long ? "Long" : "Short"} ${sizeText(abs, v.stepWad)} MON on ${v.label}`;
  return (
    <SwipeRow label={label} actions={[{ key: "close", label: "Close", tone: "short", onPress: onClose }]}>
      <View style={s.body} testID={`position-${v.venue}`}>
        <View style={s.row}>
          <Text bold tone={long ? "long" : "short"}>
            {long ? "Long" : "Short"} {sizeText(abs, v.stepWad)} MON
          </Text>
          <Text variant="caption" tone="muted">
            {v.label}
          </Text>
        </View>
        <View style={s.row}>
          <Text variant="caption" tone="muted">
            Entry {priceText(v.entryWad, v.priceDp)}
          </Text>
          <Num value={v.pnlWad} kind="usd" signed label="Unrealized PnL in AUSD" testID={`position-${v.venue}-pnl`} />
        </View>
        <View style={s.row}>
          <Text variant="caption" tone="muted">
            Funding
          </Text>
          <Num value={v.fundingWad} kind="usd" signed variant="caption" label="Funding on this position in AUSD" testID={`position-${v.venue}-funding`} />
        </View>
        <Text variant="caption" tone="muted" testID={`position-${v.venue}-liq`}>
          Liq {priceText(v.liqWad, v.priceDp)}
          {v.distanceBps !== undefined ? ` · ${(Number(v.distanceBps) / 100).toFixed(1)}% away` : ""}
        </Text>
        <Meter bps={meter.bps} tone={meter.tone} label={`Distance to liquidation${v.distanceBps !== undefined ? `: ${(Number(v.distanceBps) / 100).toFixed(1)} percent` : ", unknown"}`} />
      </View>
    </SwipeRow>
  );
}

/** `earnPair`: the open Earn pair from its record (earn/EarnProvider useEarnPair); the cards are grouped by it. */
export const PositionCards = memo(function PositionCards({ earnPair }: { earnPair?: EarnPair | undefined }) {
  const { accounts } = useTrade();
  const acc = useStore(accounts?.store ?? NO_ACC, selAcc);
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const start = useStartOrder();
  const sheet = useRef<SheetRef>(null);
  const [closing, setClosing] = useState<{ v: PositionView; error?: string; busy?: boolean } | undefined>();
  const views = positionViews(acc, m, p);
  if (views.length === 0) return null;
  const group = groupOf(views, earnPair);
  const pairStep = views.find((v) => v.venue === "perpl")?.stepWad ?? 1n;

  const plan = closing
    ? planClose({ venue: closing.v.venue, sizeWad: closing.v.sizeWad, bestBidWad: closing.v.venue === "perpl" ? p?.bestBidWad : m?.bestBidWad, bestAskWad: closing.v.venue === "perpl" ? p?.bestAskWad : m?.bestAskWad, priceStepWad: closing.v.venue === "perpl" ? 10n ** BigInt(18 - (p?.priceDecimals ?? 18)) : (m?.tickSizeWad ?? 1n) })
    : undefined;
  const summary = closing && plan && !("error" in plan) ? `Close ${closing.v.sizeWad > 0n ? "long" : "short"} ${sizeText(plan.sizeWad, closing.v.stepWad)} MON on ${closing.v.label} · worst price ${priceText(plan.limitPriceWad, closing.v.priceDp)}` : undefined;

  const confirm = () => {
    if (!closing || !plan || "error" in plan || !summary) return;
    setClosing({ v: closing.v, busy: true });
    start({ venue: plan.venue, side: plan.side, sizeWad: plan.sizeWad, reduceOnly: true, limitPriceWad: plan.limitPriceWad, summary, leverage100: 100 }).then(
      (r) => {
        if (r?.ok) {
          sheet.current?.dismiss();
          setClosing(undefined);
          router.push("/receipt");
        } else {
          haptic.error();
          setClosing((c) => (c ? { ...c, busy: false, error: r?.error ?? "Still checking the order…" } : c));
        }
      },
      (e: unknown) => {
        haptic.error();
        setClosing((c) => (c ? { ...c, busy: false, error: plainTradeError(e instanceof Error ? e.message : String(e)) } : c));
      },
    );
  };

  return (
    <Card style={s.card}>
      <View style={[s.row, s.title]}>
        <Text variant="caption" tone="muted">
          Your positions
        </Text>
        {views.length > 1 ? <Button title="Close all" variant="link" onPress={() => router.push("/close-all")} accessibilityHint="One confirm closes every position; a hedged pair closes Meridian first, then Perpl" testID="btn-close-all" /> : null}
      </View>
      {group === "earn" ? (
        <Text variant="caption" style={s.title} testID="position-earn">
          Earn · basis · {sizeText(earnPair!.sizeWad, pairStep)} MON each side · the two legs hedge each other’s price; the funding gap is the return
        </Text>
      ) : group === "earn-stale" ? (
        <Text variant="caption" tone="warn" style={s.title} testID="position-earn-stale">
          Earn · your Earn position is {sizeText(earnPair!.sizeWad, pairStep)} MON each side, but the venues no longer hold all of it. Close it on Earn.
        </Text>
      ) : group === "basis" ? (
        <Text variant="caption" style={s.title} testID="position-basis">
          Basis trade · the two legs hedge each other’s price; the funding gap is the return
        </Text>
      ) : null}
      {views.map((v) => (
        <Card1
          key={v.venue}
          v={v}
          onClose={() => {
            setClosing({ v });
            sheet.current?.present();
          }}
        />
      ))}
      <Sheet ref={sheet} title="Close position" onDismiss={() => setClosing(undefined)}>
        {plan && "error" in plan ? <Text tone="short">{plan.error}</Text> : null}
        {summary ? (
          <Text bold testID="close-summary">
            {summary}
          </Text>
        ) : null}
        {closing?.error ? (
          <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="close-error">
            {closing.error}
          </Text>
        ) : null}
        <ConfirmBar action="close" onConfirm={confirm} disabled={!summary || closing?.busy === true} testID="close" />
        {closing?.busy ? (
          <Text variant="caption" tone="muted">
            Closing…
          </Text>
        ) : null}
      </Sheet>
    </Card>
  );
});

const s = StyleSheet.create({
  card: { padding: 0, overflow: "hidden" },
  title: { paddingHorizontal: space.l, paddingTop: space.m },
  body: { gap: space.xs, paddingVertical: space.m },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.s },
});
