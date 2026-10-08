import { Text } from "../../ui";

export function ErrorLine({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="auth-error">
      {message}
    </Text>
  );
}
