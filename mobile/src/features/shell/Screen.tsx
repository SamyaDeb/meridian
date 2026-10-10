import type { ReactElement, ReactNode } from "react";
import { ScrollView, StyleSheet, View, type RefreshControlProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space } from "../../ui";

/** Screen frame: dark background, safe areas, 16 pt gutter, scrolls at large font scales; `footer` sits in the thumb zone;
 *  `refreshControl` = pull-to-refresh. */
export function Screen({ children, footer, edges = "both", refreshControl }: { children: ReactNode; footer?: ReactNode; edges?: "both" | "bottom"; refreshControl?: ReactElement<RefreshControlProps> }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.root, { paddingTop: edges === "both" ? insets.top : 0 }]}>
      <ScrollView contentContainerStyle={s.content} contentInsetAdjustmentBehavior="never" {...(refreshControl ? { refreshControl } : {})}>
        {children}
      </ScrollView>
      {footer ? <View style={[s.footer, { paddingBottom: insets.bottom + space.l }]}>{footer}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.l, gap: space.xl },
  footer: { paddingHorizontal: space.l, paddingTop: space.m, gap: space.m, backgroundColor: colors.bg },
});
