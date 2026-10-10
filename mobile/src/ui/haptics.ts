// The haptics map (DESIGN.md). Fire-and-forget: a device without a vibrator (or a missing native module) never throws.
import * as Haptics from "expo-haptics";

const fire = (f: () => Promise<void>) => {
  try {
    void f().catch(() => undefined);
  } catch {
    // no haptics on this device
  }
};
export const haptic = {
  selection: () => fire(() => Haptics.selectionAsync()),
  holdStart: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
