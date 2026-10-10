// MON + AUSD balances of the account, re-read per block. Unknown = "—"; zero = "0.00"; stale reads dim with a note.
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Card, Num, space, Text } from "../../ui";
import { toWad, type BalanceState } from "../../wallet/balances";
import { useBalances } from "../../wallet/hooks";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.row}>
      <Text tone="muted">{label}</Text>
      {children}
    </View>
  );
}

export const BalancesView = memo(function BalancesView({ state }: { state: BalanceState | undefined }) {
  const stale = Boolean(state?.error);
  return (
    <Card>
      <Row label="MON (network fees)">
        <Num value={state?.mon} kind="usd" dp={4} stale={stale} testID="bal-mon" label="MON balance" />
      </Row>
      {(state?.tokens ?? []).map((t) => (
        <Row key={t.label} label={t.label}>
          <Num value={t.amount !== undefined && t.decimals !== undefined ? toWad(t.amount, t.decimals) : undefined} kind="usd" stale={stale} label={`${t.label} balance`} testID={`bal-${t.label}`} />
        </Row>
      ))}
      <Text variant="caption" tone="muted">
        {state?.block !== undefined ? `Block ${state.block.toString()}` : "Waiting for the chain…"}
        {state?.error ? ` · ${state.error}` : ""}
      </Text>
    </Card>
  );
});

export function Balances({ address }: { address: `0x${string}` }) {
  return <BalancesView state={useBalances(address)} />;
}

const s = StyleSheet.create({ row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 44, gap: space.m, flexWrap: "wrap" } });
