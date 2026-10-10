// Large text (fontScale 2, N8 D4.5): RNTL renders no real layout, so this checks the layout PROPS that would clip a
// value at a large font scale: the text itself (numberOfLines, allowFontScaling={false}, maxFontSizeMultiplier,
// adjustsFontSizeToFit) and every ancestor up to the root (a fixed height / maxHeight, overflow hidden, or a row that
// can't wrap around a sibling). Pass ⇒ the value grows and wraps; the real check on a phone is MOBILE_QA N8-A2.
import { StyleSheet } from "react-native";

type Node = { props: Record<string, unknown>; parent: Node | null; type: unknown };

export function clipRisks(node: Node): string[] {
  const out: string[] = [];
  const p = node.props;
  if (p.numberOfLines !== undefined) out.push(`numberOfLines=${String(p.numberOfLines)} on the value`);
  if (p.allowFontScaling === false) out.push("allowFontScaling={false} on the value");
  if (p.maxFontSizeMultiplier !== undefined) out.push(`maxFontSizeMultiplier=${String(p.maxFontSizeMultiplier)} on the value`);
  if (p.adjustsFontSizeToFit) out.push("adjustsFontSizeToFit on the value");
  for (let n: Node | null = node, depth = 0; n; n = n.parent, depth++) {
    const st = (StyleSheet.flatten(n.props.style as never) ?? {}) as Record<string, unknown>;
    if (typeof st.height === "number") out.push(`fixed height ${st.height} at ancestor ${depth}`);
    if (typeof st.maxHeight === "number") out.push(`maxHeight ${st.maxHeight} at ancestor ${depth}`);
    if (st.overflow === "hidden") out.push(`overflow hidden at ancestor ${depth}`);
    if (depth > 0 && st.flexDirection === "row" && st.flexWrap !== "wrap" && Array.isArray(n.props.children) && n.props.children.filter(Boolean).length > 1)
      out.push(`row without wrap at ancestor ${depth}`);
  }
  return out;
}
