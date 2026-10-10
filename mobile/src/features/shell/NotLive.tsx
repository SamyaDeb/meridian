// Production with no mainnet deployment yet (deployments/143.json missing or `deployed: false`, until N9): a calm
// full-screen "Meridian isn't live on mainnet yet" over the app. No crash, and never a testnet fallback: the config keeps
// chain 143 and the production rpId; no order or deposit can start until the deployment exists.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { AppConfig } from "../../config/appConfig";
import { useLive } from "../../live/LiveProvider";
import { colors, space, Text } from "../../ui";

/** Pure: the production build is waiting for Meridian's mainnet deployment. Staging / development never are. */
export function waitingForMainnet(cfg: Pick<AppConfig, "env" | "chainId" | "meridian">): boolean {
  return cfg.env === "production" && cfg.chainId === 143 && cfg.meridian.status !== "deployed";
}

export function NotLiveScreen() {
  return (
    <View style={s.screen} accessibilityViewIsModal testID="not-live">
      <Text variant="title" bold accessibilityRole="header">
        Meridian isn&apos;t live on mainnet yet
      </Text>
      <Text>This build trades on Monad mainnet once Meridian&apos;s contracts are deployed there. No trade or deposit can be sent until then.</Text>
      <Text tone="muted">If you have this app from a tester link, the Meridian team will share the update as soon as mainnet is live.</Text>
    </View>
  );
}

export function NotLiveGate({ children }: { children: ReactNode }) {
  const { config } = useLive();
  const waiting = waitingForMainnet(config);
  return (
    <View style={s.fill}>
      <View style={s.fill} importantForAccessibility={waiting ? "no-hide-descendants" : "auto"} pointerEvents={waiting ? "none" : "auto"}>
        {children}
      </View>
      {waiting ? <NotLiveScreen /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  screen: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, paddingHorizontal: space.l, paddingTop: 96, gap: space.m },
});
