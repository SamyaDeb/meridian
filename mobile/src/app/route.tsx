// Route (research §5.3): both books for the ticket's current quote, the levels the order would take highlighted, the
// average and effective price (after the taker fee) on each venue, and why a venue can't take it.
import { wadToFloatForDisplay } from "@meridian/core/util";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "../features/shell/Screen";
import { feeText, priceText, sizeText, type TicketQuote } from "../features/trade/ticket/quote";
import { lastQuoteStore } from "../features/trade/ticket/useTicketQuote";
import { useStore } from "../live/store";
import { Button, Card, colors, radius, space, Text } from "../ui";

const sel = (q: TicketQuote | undefined) => q;

export default function RouteModal() {
  const q = useStore(lastQuoteStore, sel);
  return (
    <Screen footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Where your order fills
      </Text>
      {!q || q.status === "empty" ? <Text tone="muted">Enter an amount on the ticket to see the route.</Text> : null}
      {q && q.status !== "empty"
        ? q.lines.map((l) => {
            const w = l.quote?.walk;
            const best = q.best === l.venue;
            return (
              <Card key={l.venue} style={best ? s.best : undefined} testID={`route-${l.venue}`}>
                <View style={s.row}>
                  <Text bold>
                    {l.label}
                    {best ? "  · best" : ""}
                  </Text>
                  <Text tone={l.eligible ? "text" : "muted"} variant="caption">
                    {l.eligible ? `${priceText(l.effectivePriceWad, 6)} after fees` : (l.reason ?? "—")}
                  </Text>
                </View>
                {w && w.fills.length > 0 ? (
                  <>
                    <Text variant="caption" tone="muted">
                      Takes {w.levelsUsed} level{w.levelsUsed === 1 ? "" : "s"} · average {priceText(w.avgPriceWad, 6)} · fee {feeText(l.quote!.feeWad)}
                    </Text>
                    {w.fills.map((f, i) => (
                      <View key={i} style={s.level}>
                        <Text variant="caption" style={s.num}>
                          {wadToFloatForDisplay(f.priceWad).toFixed(6)}
                        </Text>
                        <Text variant="caption" tone="muted" style={s.num}>
                          {sizeText(f.sizeWad, 10n ** 18n)} MON
                        </Text>
                      </View>
                    ))}
                  </>
                ) : (
                  <Text variant="caption" tone="muted">
                    {w ? "No level of this book fills it." : "Reading the book…"}
                  </Text>
                )}
              </Card>
            );
          })
        : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  best: { borderColor: colors.brand },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.s },
  level: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.s, paddingVertical: 2, borderRadius: radius.control, backgroundColor: colors.brandTint },
  num: { fontVariant: ["tabular-nums"] },
});
