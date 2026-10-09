// One toast at a time, top of the screen under the safe area; error toasts buzz. Announced to screen readers.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "./haptics";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export type ToastKind = "info" | "success" | "error";
type ToastMsg = { id: number; kind: ToastKind; text: string };

const Ctx = createContext<((text: string, kind?: ToastKind) => void) | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useRef(0);
  const insets = useSafeAreaInsets();

  const show = useCallback((text: string, kind: ToastKind = "info") => {
    if (kind === "error") haptic.error();
    AccessibilityInfo.announceForAccessibility(text);
    clearTimeout(timer.current);
    setMsg({ id: ++id.current, kind, text });
    timer.current = setTimeout(() => setMsg(undefined), kind === "error" ? 5_000 : 3_000);
  }, []);

  // a pending hide must not outlive the provider (it would set state after unmount and keep jest workers alive)
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo(() => show, [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {msg ? (
        <Animated.View key={msg.id} entering={FadeInUp.duration(200)} exiting={FadeOutUp.duration(200)} style={[s.toast, { top: insets.top + space.s }, msg.kind === "error" && s.error, msg.kind === "success" && s.success]} accessibilityLiveRegion="polite">
          <Text>{msg.text}</Text>
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}

export function useToast(): (text: string, kind?: ToastKind) => void {
  const t = useContext(Ctx);
  if (!t) throw new Error("useToast outside <ToastProvider>");
  return t;
}

const s = StyleSheet.create({
  toast: { position: "absolute", left: space.l, right: space.l, padding: space.l, borderRadius: radius.inner, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  error: { borderColor: colors.short },
  success: { borderColor: colors.long },
});
