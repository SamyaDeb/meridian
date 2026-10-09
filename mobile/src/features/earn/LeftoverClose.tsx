// The one-tap manual close (MOBILE_PLAN N6: unwind failed twice ⇒ alert + one-tap close): a reduce-only Perpl IOC for the
// one-sided leftover through the N5 Trade executor (same receipt), priced from the side it hits ± the close slippage
// (N5 planClose). The tap is the confirmation (the summary is on screen next to it); on a fill the leftover shrinks.
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { usePerpl } from "../../live/hooks";
import type { PerplMarketState } from "../../live/perplMarket";
import { Button, colors, haptic, radius, space, Text } from "../../ui";
import { plainTradeError } from "../trade/exec/errors";
import { planClose } from "../trade/positions/close";
import { sizeText } from "../trade/ticket/quote";
import { useStartOrder } from "../trade/useStartOrder";
import type { EarnExecutor } from "./executor";
import type { EarnPosition } from "./record";

const selP = (s: PerplMarketState | undefined) => s;

export function LeftoverClose({ naked, executor, testID = "earn-leftover" }: { naked: NonNullable<EarnPosition["naked"]>; executor: EarnExecutor | undefined; testID?: string }) {
  const p = usePerpl(selP);
  const start = useStartOrder();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const step = p ? 10n ** BigInt(18 - p.sizeDecimals) : 1n;
  const size = `${sizeText(naked.sizeWad, step)} MON`;
  const summary = `Close ${size} ${naked.side === "buy" ? "long" : "short"} on Perpl (reduce-only)`;

  const close = () => {
    if (!p || busy) return;
    const plan = planClose({ venue: "perpl", sizeWad: naked.side === "buy" ? naked.sizeWad : -naked.sizeWad, bestBidWad: p.bestBidWad, bestAskWad: p.bestAskWad, priceStepWad: 10n ** BigInt(18 - p.priceDecimals) });
    if ("error" in plan) {
      haptic.error();
      setError(plan.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    start({ venue: "perpl", side: plan.side, sizeWad: plan.sizeWad, reduceOnly: true, limitPriceWad: plan.limitPriceWad, summary, leverage100: 200 })
      .then(
        async (r) => {
          if (r?.ok) {
            await executor?.noteManualClose(r.filledWad, r);
            router.push("/receipt");
          } else {
            haptic.error();
            setError(r?.error ?? "Still checking the order. It will finish on its own.");
          }
        },
        (e: unknown) => {
          haptic.error();
          setError(plainTradeError(e instanceof Error ? e.message : String(e)));
        },
      )
      .finally(() => setBusy(false));
  };

  return (
    <View style={s.card} accessibilityRole="alert" testID={testID}>
      <Text bold tone="warn">
        Action needed
      </Text>
      <Text>
        {size} on Perpl isn't hedged: the automatic close didn't finish (tried twice, the second time at a wider price). Your MON price exposure isn't zero until it's closed.
      </Text>
      <Button title={busy ? "Closing…" : `Close ${size} on Perpl now`} onPress={close} disabled={busy || !p} accessibilityHint={summary} testID={`${testID}-close`} />
      {error ? (
        <Text tone="short" accessibilityLiveRegion="assertive" testID={`${testID}-error`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { gap: space.s, padding: space.l, borderRadius: radius.card, borderWidth: 1, borderColor: colors.warn, backgroundColor: colors.card },
});
