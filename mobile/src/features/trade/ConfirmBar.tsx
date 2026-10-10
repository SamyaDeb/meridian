// Hold-to-confirm with a VISIBLE single-tap alternative right under it (WCAG 2.5.1 / research §1.4: a gesture is never
// the only way). The hold also keeps its TalkBack `activate` action (ui/HoldButton).
import { StyleSheet, View } from "react-native";
import { Button, HoldButton, space } from "../../ui";

export function ConfirmBar({ action, onConfirm, disabled, testID = "confirm" }: { action: string; onConfirm: () => void; disabled?: boolean; testID?: string }) {
  return (
    <View style={s.wrap}>
      <HoldButton title={`Hold to ${action}`} onConfirm={onConfirm} {...(disabled !== undefined ? { disabled } : {})} testID={`${testID}-hold`} />
      <Button title={`Or tap here to ${action}`} variant="link" onPress={onConfirm} disabled={disabled} accessibilityHint="Confirms with one tap instead of holding" testID={`${testID}-tap`} />
    </View>
  );
}

const s = StyleSheet.create({ wrap: { gap: space.xs } });
