// The haptics map (DESIGN.md). Fire-and-forget: a device without a vibrator just resolves.
import * as Haptics from "expo-haptics";

const swallow = () => undefined;
export const haptic = {
  selection: () => void Haptics.selectionAsync().catch(swallow),
  holdStart: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(swallow),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(swallow),
  error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(swallow),
};
