// Bottom sheet (@gorhom/bottom-sheet v5): gesture-driven, dark, dynamic height, backdrop closes it. Present with
// ref.current?.present(); needs <BottomSheetModalProvider> (root layout).
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export type SheetRef = BottomSheetModal;

export const Sheet = forwardRef<BottomSheetModal, { title: string; children: ReactNode; onDismiss?: () => void }>(function Sheet({ title, children, onDismiss }, ref) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const backdrop = useCallback((p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} pressBehavior="close" />, []);
  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      backdropComponent={backdrop}
      backgroundStyle={s.bg}
      handleIndicatorStyle={s.handle}
      animateOnMount={!reduced}
      accessible={false}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <BottomSheetView style={[s.body, { paddingBottom: insets.bottom + space.xl }]}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
});

const s = StyleSheet.create({
  bg: { backgroundColor: colors.card, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  handle: { backgroundColor: colors.muted, width: 36 },
  body: { paddingHorizontal: space.l, paddingTop: space.s, gap: space.l },
});
