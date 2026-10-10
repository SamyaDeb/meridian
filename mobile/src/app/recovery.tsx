// Export the 24-word recovery phrase (MOBILE_PLAN N3 §5): a fresh passkey prompt, shown once, screenshots blocked,
// hidden as soon as the app leaves the foreground, never copied. The words live in a ref (not React state) and are
// dropped on hide / unmount. (JS strings can't be zeroed; dropping every reference is the most the runtime allows.)
import { router } from "expo-router";
import { usePreventScreenCapture } from "expo-screen-capture";
import { useEffect, useReducer, useRef } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { ErrorLine } from "../features/auth/ErrorLine";
import { useAuthAction } from "../features/auth/useAuthAction";
import { Screen } from "../features/shell/Screen";
import { Button, Card, space, Text } from "../ui";

export default function Recovery() {
  usePreventScreenCapture("recovery-phrase");
  const words = useRef<string[] | undefined>(undefined);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { run, error, busy, auth } = useAuthAction();

  const hide = () => {
    words.current = undefined;
    rerender();
  };
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") hide();
    });
    return () => {
      sub.remove();
      words.current = undefined;
    };
  }, []);

  const shown = words.current;
  return (
    <Screen
      footer={
        shown ? (
          <Button
            title="Hide and close"
            onPress={() => {
              hide();
              router.back();
            }}
          />
        ) : (
          <>
            <Button
              title="Show my recovery phrase"
              accessibilityHint="Asks for your passkey, then shows 24 words"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  words.current = await auth.exportRecoveryPhrase();
                  rerender();
                })
              }
            />
            <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
          </>
        )
      }
    >
      <Text variant="title" accessibilityRole="header">
        Recovery phrase
      </Text>
      <Card>
        <Text tone="warn" bold>
          Anyone with these words owns your wallet
        </Text>
        <Text tone="muted">
          Write them on paper and keep them offline. Never type them into a website or share them, not even with Meridian. They restore the same address in MetaMask or Rabby
          if you lose your passkey. Screenshots are blocked here, and the words hide when you leave the app.
        </Text>
      </Card>
      {shown ? (
        <Card testID="recovery-words">
          <View style={s.grid}>
            {shown.map((w, i) => (
              <View key={i} style={s.cell} accessible accessibilityLabel={`Word ${i + 1}: ${w}`}>
                <Text tone="muted" variant="caption" style={s.n}>
                  {i + 1}
                </Text>
                <Text bold>{w}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
      <ErrorLine message={error} />
    </Screen>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: space.m },
  cell: { width: "50%", flexDirection: "row", gap: space.s, alignItems: "baseline", minHeight: 32 },
  n: { width: 22, textAlign: "right", fontVariant: ["tabular-nums"] },
});
