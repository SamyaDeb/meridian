// Dev-only (imported behind __DEV__ from src/app/dev/smoke.tsx, so release bundles drop it).
import type { FetchLike } from "@meridian/core/util";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLive } from "../../live/LiveProvider";
import { Button, Card, colors, space, Text } from "../../ui";
import { Screen } from "../shell/Screen";
import { runSmoke, smokeChecks, type SmokeResult } from "./smoke";

const rnFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export default function SmokeScreen() {
  const live = useLive();
  const [results, setResults] = useState<SmokeResult[] | undefined>(undefined);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setResults(undefined);
    // let the "Running…" frame paint before the synchronous PBKDF2 blocks the JS thread
    await new Promise((r) => setTimeout(r, 50));
    const r = await runSmoke(smokeChecks({ client: live.client, perplApiUrl: live.config.perpl.status === "deployed" ? live.config.perpl.deployment.apiUrl : undefined, fetch: rnFetch, chainId: live.config.chainId }));
    // the numbers N1's README §Open asks for, in Metro's log too
    console.log("[n2-smoke]", JSON.stringify(r.map((x) => ({ name: x.name, ok: x.ok, ms: Math.round(x.ms * 10) / 10, detail: x.detail }))));
    setResults(r);
    setRunning(false);
  };

  const passed = results?.filter((r) => r.ok).length ?? 0;
  return (
    <Screen edges="bottom" footer={<Button title={running ? "Running…" : "Run Hermes smoke"} onPress={run} disabled={running} />}>
      <Text tone="muted">Checks the runtime globals and costs the shared code depends on. Development builds only.</Text>
      {results ? (
        <Text variant="title" tone={passed === results.length ? "long" : "short"}>
          {passed} / {results.length} passed
        </Text>
      ) : null}
      <Card>
        {(results ?? []).map((r) => (
          <View key={r.name} style={s.row} accessible accessibilityLabel={`${r.name}: ${r.ok ? "pass" : "fail"}, ${Math.round(r.ms)} milliseconds, ${r.detail}`}>
            <View style={[s.dot, { backgroundColor: r.ok ? colors.long : colors.short }]} />
            <View style={{ flex: 1 }}>
              <Text bold>{r.name}</Text>
              <Text variant="caption" tone="muted">
                {r.ok ? "pass" : "FAIL"} · {r.detail}
              </Text>
            </View>
            <Text style={{ fontVariant: ["tabular-nums"] }}>{r.ms.toFixed(1)} ms</Text>
          </View>
        ))}
        {!results ? <Text tone="muted">Not run yet.</Text> : null}
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: 44 },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
