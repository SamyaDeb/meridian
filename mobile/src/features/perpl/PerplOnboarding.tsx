// (onboarding)/perpl — three resumable checks, each one tap (MOBILE_PLAN N4 §3): ① Enable Perpl trading (API key),
// ② Deposit AUSD (allow exactly the amount + createAccount, fresh passkey prompt), ③ Allow fast orders (allowOrderForwarding).
// Every state shown is detected from Perpl + chain (PerplVenue.refresh on mount, unlock and foreground); killing the
// app at any step resumes at the right one. Numbers: live reads only; unknown shows "—".
import { router } from "expo-router";
import { memo, useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAccountAddress } from "../../auth/AuthProvider";
import { Screen } from "../shell/Screen";
import { AddressActions } from "../wallet/AddressActions";
import { WalletChip } from "../wallet/WalletChip";
import { Button, Card, colors, haptic, Num, radius, space, Text, type, useToast } from "../../ui";
import { toWad } from "../../wallet/balances";
import { useBalances } from "../../wallet/hooks";
import { formatUnitsExact } from "../../venues/perpl/amounts";
import type { OnboardingState, StepTx } from "../../venues/perpl/onboarding";
import { checkOrder, plainStatus, STEP_LABEL, type CheckState, type OnboardingView } from "../../venues/perpl/onboardingModel";
import { usePerpl, usePerplOnboarding } from "../../venues/perpl/PerplProvider";

const selView = (s: OnboardingState | undefined) => s?.view;
const selBusy = (s: OnboardingState | undefined) => s?.busy;
const selError = (s: OnboardingState | undefined) => s?.error;
const selMin = (s: OnboardingState | undefined) => s?.minOpen;
const selWallet = (s: OnboardingState | undefined) => s?.walletBalance;
const selTxs = (s: OnboardingState | undefined) => s?.txs;

/** > VERIFY: replace with 3 measured testnet txs (approve + createAccount + allowOrderForwarding) × current gas price
 *  after the first phone run; until then the plan's figure (MOBILE_PLAN N4 §3). */
const GAS_HINT = "Add a little MON for network fees";
const GAS_AMOUNT = "About 0.5 MON covers these steps.";

const LABEL: Record<CheckState, string> = { done: "Done", next: "Next", waiting: "After the step above", unknown: "Checking…" };

function Chip({ state, testID }: { state: CheckState; testID: string }) {
  const tone = state === "done" ? "long" : state === "next" ? "brand" : "muted";
  return (
    <Text variant="caption" tone={tone} bold testID={testID} accessibilityLabel={`Status: ${LABEL[state]}`}>
      {state === "done" ? "✓ " : ""}
      {LABEL[state]}
    </Text>
  );
}

/** Runs one check. Success is explicit (toast + haptic, never when the step left an error line); errors show on the
 *  screen and leave the input as typed. */
function useStep() {
  const venue = usePerpl();
  const toast = useToast();
  return useCallback(
    (run: (v: NonNullable<typeof venue>) => Promise<void>, success: string) => {
      if (!venue) return;
      run(venue).then(
        () => {
          if (venue.onboarding.store.get().error) return haptic.error();
          haptic.success();
          toast(success, "success");
        },
        () => haptic.error(),
      );
    },
    [venue, toast],
  );
}

const KeyCheck = memo(function KeyCheck({ state, n }: { state: CheckState; n: number }) {
  const busy = usePerplOnboarding(selBusy);
  const step = useStep();
  return (
    <Card testID="check-key">
      <View style={s.head}>
        <Text bold>
          {n}. Enable Perpl trading
        </Text>
        <Chip state={state} testID="chip-key" />
      </View>
      <Text tone="muted">Registers a trading key made from your passkey. Your trading key can trade but can never withdraw, and it never leaves this phone's memory.</Text>
      {state === "next" ? <Button title={busy === "enroll" ? "Enabling…" : "Enable trading"} disabled={busy !== undefined && busy !== "refresh"} onPress={() => step((v) => v.onboarding.enroll().then(() => v.refresh()), "Perpl trading enabled")} testID="btn-enroll" /> : null}
    </Card>
  );
});

const DepositCheck = memo(function DepositCheck({ state, n, topUp }: { state: CheckState; n: number; topUp: boolean }) {
  const venue = usePerpl();
  const busy = usePerplOnboarding(selBusy);
  const min = usePerplOnboarding(selMin);
  const wallet = usePerplOnboarding(selWallet);
  const step = useStep();
  const dec = venue?.onboarding.collateralDecimals;
  const [amount, setAmount] = useState("");
  const show = state === "next";
  return (
    <Card testID="check-deposit">
      <View style={s.head}>
        <Text bold>
          {n}. {topUp ? "Add AUSD to trade with" : "Deposit AUSD"}
        </Text>
        <Chip state={state} testID="chip-deposit" />
      </View>
      <Text tone="muted">
        {topUp ? "Your Perpl account has no free AUSD yet." : "Opens your Perpl account with a first deposit."} Asks for your fingerprint, then lets Perpl use exactly this amount and deposits it.
      </Text>
      {show ? (
        <>
          <Text testID="deposit-min">
            {topUp ? "Any amount" : `Minimum ${min !== undefined ? formatUnitsExact(min, dec!) : "—"} AUSD (read from Perpl now)`} · in your wallet {wallet !== undefined ? formatUnitsExact(wallet, dec!) : "—"} AUSD
          </Text>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            placeholder={min !== undefined && !topUp ? formatUnitsExact(min, dec!) : "0.00"}
            placeholderTextColor={colors.muted}
            keyboardType="decimal-pad"
            inputMode="decimal"
            style={s.input}
            accessibilityLabel="AUSD amount to deposit"
            testID="deposit-input"
          />
          <View style={s.row}>
            {!topUp && min !== undefined ? <Button title="Use minimum" variant="secondary" onPress={() => setAmount(formatUnitsExact(min, dec!))} testID="btn-min" /> : null}
            {wallet !== undefined && wallet > 0n ? <Button title="MAX" variant="secondary" onPress={() => setAmount(formatUnitsExact(wallet, dec!))} testID="btn-max" /> : null}
          </View>
          <Text tone="muted" testID="deposit-allow">
            Allow Perpl to use exactly {amount.trim() || "—"} AUSD
          </Text>
          <Button
            title={busy === "deposit" ? "Depositing…" : "Deposit"}
            disabled={busy !== undefined && busy !== "refresh"}
            onPress={() => step((v) => v.onboarding.deposit(amount).then(() => v.refresh()), `Deposited ${amount.trim()} AUSD to Perpl`)}
            testID="btn-deposit"
          />
        </>
      ) : null}
    </Card>
  );
});

const ForwardingCheck = memo(function ForwardingCheck({ state, n }: { state: CheckState; n: number }) {
  const busy = usePerplOnboarding(selBusy);
  const step = useStep();
  return (
    <Card testID="check-forwarding">
      <View style={s.head}>
        <Text bold>
          {n}. Allow fast orders
        </Text>
        <Chip state={state} testID="chip-forwarding" />
      </View>
      <Text tone="muted">Lets Perpl send your signed orders for you and pay their network fees. One step, no funds move.</Text>
      {state === "next" ? <Button title={busy === "forwarding" ? "Allowing…" : "Allow fast orders"} disabled={busy !== undefined && busy !== "refresh"} onPress={() => step((v) => v.onboarding.allowForwarding().then(() => v.refresh()), "Fast orders on")} testID="btn-forwarding" /> : null}
    </Card>
  );
});

function GasCard({ address }: { address: `0x${string}` }) {
  const bal = useBalances(address);
  return (
    <Card testID="gas-card">
      <Text bold>{GAS_HINT}</Text>
      <Text tone="muted">{GAS_AMOUNT} The deposit and the fast-orders switch each pay a small MON fee; orders themselves are free.</Text>
      <View style={s.qr}>
        <QRCode value={address} size={136} color={colors.bg} backgroundColor="#ffffff" quietZone={8} />
      </View>
      <WalletChip address={address} caption="Send MON to this wallet" />
      <AddressActions address={address} />
      <View style={s.head}>
        <Text tone="muted">MON now</Text>
        <Num value={bal?.mon} kind="usd" dp={4} label="MON balance" testID="gas-mon" />
      </View>
    </Card>
  );
}

/** Onchain details (hashes, gas) stay behind "Details": the main path has no hex (MOBILE_UX_RESEARCH principle 4). */
const TxList = memo(function TxList() {
  const txs = usePerplOnboarding(selTxs);
  const [open, setOpen] = useState(false);
  if (!txs?.length) return null;
  return (
    <Card testID="tx-list">
      <Button title={open ? "Hide details" : `Details (${txs.length})`} variant="link" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} testID="btn-details" />
      {open
        ? txs.map((t: StepTx) => (
            <Text key={t.hash} selectable variant="caption" tone="muted">
              {STEP_LABEL[t.step]} · block {t.blockNumber.toString()} · gas {t.gasUsed.toString()} / limit {t.gasLimit.toString()}
              {"\n"}
              {t.hash}
            </Text>
          ))
        : null}
    </Card>
  );
});

function Ready({ view }: { view: OnboardingView }) {
  const a = view.apiAccount;
  const venue = usePerpl();
  const dec = venue?.onboarding.collateralDecimals;
  const free = a ? BigInt(a.b) - BigInt(a.lb) : undefined;
  return (
    <Card testID="perpl-ready">
      <Text bold tone="long">
        Perpl is ready
      </Text>
      <Text>Account #{a?.id ?? "—"}</Text>
      <View style={s.head}>
        <Text tone="muted">Free collateral</Text>
        <Num value={free !== undefined ? toWad(free, dec!) : undefined} kind="usd" label="Free collateral" testID="free-collateral" />
      </View>
    </Card>
  );
}

export function PerplOnboardingScreen() {
  const { address } = useAccountAddress();
  const venue = usePerpl();
  const view = usePerplOnboarding(selView);
  const busy = usePerplOnboarding(selBusy);
  const error = usePerplOnboarding(selError);
  if (!venue) {
    return (
      <Screen footer={<Button title="Back" variant="secondary" onPress={() => router.back()} />}>
        <Text variant="title" accessibilityRole="header">
          Enable Perpl
        </Text>
        <Text tone="muted">Perpl isn't available in this build or the wallet is locked.</Text>
      </Screen>
    );
  }
  const order = view ? checkOrder(view) : (["key", "account", "forwarding"] as const);
  const topUp = view?.next === "top-up";
  return (
    <Screen footer={<Button title={view?.ready ? "Done" : "Later"} variant={view?.ready ? "primary" : "secondary"} onPress={() => (router.canGoBack() ? router.back() : router.replace("/portfolio"))} testID="btn-done" />}>
      <View style={s.head}>
        <Text variant="title" accessibilityRole="header">
          Enable Perpl
        </Text>
        {busy === "refresh" ? <ActivityIndicator color={colors.muted} accessibilityLabel="Checking Perpl" /> : null}
      </View>
      <Text tone="muted" testID="perpl-reason">
        {view ? plainStatus(view) : "Checking your Perpl account…"}
      </Text>
      {error ? (
        <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="perpl-error">
          {error}
        </Text>
      ) : null}
      {view?.ready ? <Ready view={view} /> : null}
      {order.map((c, i) =>
        c === "key" ? (
          <KeyCheck key={c} n={i + 1} state={view?.key ?? "unknown"} />
        ) : c === "account" ? (
          <DepositCheck key={c} n={i + 1} state={topUp ? "next" : (view?.account ?? "unknown")} topUp={topUp} />
        ) : (
          <ForwardingCheck key={c} n={i + 1} state={view?.forwarding ?? "unknown"} />
        ),
      )}
      {view?.next === "retry" ? <Button title="Check again" variant="secondary" onPress={() => void venue.refresh()} testID="btn-retry" /> : null}
      <TxList />
      {!view?.ready && address ? <GasCard address={address} /> : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.s },
  row: { flexDirection: "row", gap: space.s },
  qr: { alignSelf: "center", borderRadius: radius.inner, overflow: "hidden" },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, color: colors.text, fontSize: type.title, paddingHorizontal: space.m, fontVariant: ["tabular-nums"] },
});
