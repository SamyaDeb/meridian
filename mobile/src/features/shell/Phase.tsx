import { Card, Text } from "../../ui";

/** An honest "not built yet" card: which phase fills this, and what it will do. No sample numbers. */
export function Phase({ phase, title, children }: { phase: string; title: string; children: string }) {
  return (
    <Card accessibilityLabel={`${title}. Arrives in ${phase}. ${children}`} accessible>
      <Text variant="caption" tone="brand" bold>
        Arrives in {phase}
      </Text>
      <Text bold>{title}</Text>
      <Text tone="muted">{children}</Text>
    </Card>
  );
}
