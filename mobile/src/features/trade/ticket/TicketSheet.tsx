// The ticket sheet (research §5.3): Long / Short, AUSD on the numpad (presets 25 % / 50 % / MAX of the chosen venue's
// available collateral: venue free + wallet), leverage with haptic detents, slippage chips, a live quote from both books
// (core router, per block, input debounced 150 ms), the plain summary line, blockers fixed inline (first Perpl trade:
// the N4 checks; Perpl short of collateral: "Move X AUSD"; Meridian: a permit deposit in the same flow; wallet short:
// Add funds), then hold-to-confirm with a visible tap alternative → receipt. Failure: haptic + a specific message; the
// input stays.
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { formatUnitsExact } from "../../../venues/perpl/amounts";
import { router } from "expo-router";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../../../live/LiveProvider";
import { Store, useStore } from "../../../live/store";
import type { WalletFeed } from "../../../wallet/feed";
import { useWalletFeed } from "../../wallet/WalletFeedProvider";
import type { AccountsState } from "../data/accounts";
import { Button, colors, haptic, HIT, radius, Segmented, Slider, space, Text } from "../../../ui";
import { usePerpl as usePerplVenue } from "../../../venues/perpl/PerplProvider";
import { PerplChecks } from "../../perpl/PerplOnboarding";
import { ConfirmBar } from "../ConfirmBar";
import { owedToken } from "../exec/collateral";
import { plainTradeError } from "../exec/errors";
import { useOpenBlocked } from "../../flags/FlagsProvider";
import { FlagsLine } from "../../flags/FlagsLine";
import type { ExecState } from "../exec/executor";
import { useTrade } from "../TradeProvider";
import { useStartOrder } from "../useStartOrder";
import { amountWadOf, presetText } from "./amountText";
import { Numpad } from "./Numpad";
import { feeText, priceText, summaryText, type Pick, type TicketQuote, type VenueLine } from "./quote";
import { useTicketQuote } from "./useTicketQuote";
import { walletWadFor } from "./venues";

export const LEVERAGES = [1, 2, 5, 10] as const;
export const SLIPPAGES = [
  { value: "50", label: "0.5%", bps: 50n },
  { value: "100", label: "1%", bps: 100n },
  { value: "300", label: "3%", bps: 300n },
] as const;
type SlipKey = (typeof SLIPPAGES)[number]["value"];
const DEBOUNCE_MS = 150;

export type TicketRef = { open(side: "long" | "short"): void };

const PHASE_TEXT: Partial<Record<ExecState["phase"], string>> = {
  preparing: "Preparing your order…",
  sending: "Sending…",
  confirming: "Waiting for the fill…",
  checking: "Checking the order…",
};

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms);
    return () => clearTimeout(h);
  }, [v, ms]);
  return d;
}

function QuoteRow({ l, best, chosen, onPick }: { l: VenueLine; best: boolean; chosen: boolean; onPick: () => void }) {
  return (
    <Pressable onPress={onPick} accessibilityRole="radio" accessibilityState={{ selected: chosen, disabled: !l.eligible }} accessibilityLabel={`${l.label}: ${l.eligible ? `${priceText(l.effectivePriceWad, 6)} after fees${best ? ", best price" : ""}` : (l.reason ?? "unavailable")}`} style={[s.qrow, chosen && s.qrowOn]} testID={`quote-${l.venue}`}>
      <View style={s.qname}>
        <View style={[s.swatch, { backgroundColor: l.venue === "meridian" ? colors.brand : colors.text }]} />
        <Text bold>{l.label}</Text>
        {best ? (
          <Text variant="caption" tone="brand" bold>
            BEST
          </Text>
        ) : null}
      </View>
      {l.eligible && l.quote ? (
        <Text style={s.num}>{priceText(l.effectivePriceWad, 6)}</Text>
      ) : (
        <Text variant="caption" tone="muted" style={s.reason}>
          {l.reason ?? "—"}
        </Text>
      )}
    </Pressable>
  );
}

function Blockers({ q, onMove, moving }: { q: TicketQuote; onMove: (amountWad: bigint) => void; moving: boolean }) {
  const c = q.chosen;
  if (!c) return null;
  return (
    <>
      {c.blockers.map((b) => {
        if (b.kind === "onboard")
          return (
            <View key="onboard" style={s.block} testID="blocker-onboard">
              <Text bold>Set up Perpl (one time)</Text>
              <PerplChecks compact />
            </View>
          );
        if (b.kind === "move")
          return (
            <View key="move" style={s.block} testID="blocker-move">
              <Text>Perpl needs {formatUnitsExact(owedToken(b.amountWad), 6)} more AUSD on your Perpl account for this trade.</Text>
              <Button title={moving ? "Moving…" : `Move ${formatUnitsExact(owedToken(b.amountWad), 6)} AUSD to Perpl`} variant="secondary" disabled={moving} onPress={() => onMove(b.amountWad)} testID="btn-move" />
            </View>
          );
        if (b.kind === "deposit")
          return (
            <Text key="deposit" variant="caption" tone="muted" testID="blocker-deposit">
              Adds {formatUnitsExact(owedToken(b.amountWad), 6)} AUSD from your wallet to Meridian first (one fingerprint prompt).
            </Text>
          );
        return (
          <View key="fund" style={s.block} testID="blocker-fund">
            <Text>You need {formatUnitsExact(owedToken(b.shortWad), 6)} more AUSD in your wallet.</Text>
            <Button title="Add funds" variant="secondary" onPress={() => router.push("/fund")} />
          </View>
        );
      })}
    </>
  );
}

const STATUS_TEXT: Record<Exclude<TicketQuote["status"], "ok">, string> = {
  empty: "Enter an amount",
  "no-liquidity": "No liquidity right now",
  "too-small": "Amount too small for one lot. Try more AUSD or more leverage.",
  "no-venue": "Neither book can fill this right now",
  "venue-unavailable": "That venue can't fill this. Tap Best price.",
};

export const TicketSheet = forwardRef<TicketRef>(function TicketSheet(_props, ref) {
  const sheet = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { executor, accounts } = useTrade();
  const venue = usePerplVenue();
  const start = useStartOrder();
  const [side, setSide] = useState<"long" | "short">("long");
  const [text, setText] = useState("");
  const [levIdx, setLevIdx] = useState(1);
  const [slip, setSlip] = useState<SlipKey>("100");
  const [pick, setPick] = useState<Pick>("best");
  const [error, setError] = useState<string | undefined>();
  const [moving, setMoving] = useState(false);
  const exec = useStore(executor?.store ?? NO_EXEC, selExec);
  const busy = exec.phase === "preparing" || exec.phase === "sending" || exec.phase === "confirming" || exec.phase === "checking";

  useImperativeHandle(ref, () => ({
    open(sd) {
      setSide(sd);
      setError(undefined);
      executor?.reset();
      sheet.current?.present();
    },
  }));

  const amountWad = useDebounced(amountWadOf(text), DEBOUNCE_MS);
  const leverage = LEVERAGES[levIdx]!;
  const slippageBps = SLIPPAGES.find((x) => x.value === slip)!.bps;
  const q = useTicketQuote({ side, amountWad, leverage, slippageBps, pick });

  // presets: % of the chosen venue's available collateral (free on the venue + the wallet token that funds it)
  const target = q.chosen?.venue ?? q.best ?? (pick === "best" ? undefined : pick);
  const avail = useAvailable(target);
  const presets = [
    { label: "25%", text: presetText(avail, 25) },
    { label: "50%", text: presetText(avail, 50) },
    { label: "MAX", text: presetText(avail, 100) },
  ];

  const blocked = q.chosen?.blockers.some((b) => b.kind !== "deposit") ?? true;
  // the ticket only opens (closes go through the position cards / Close all): the remote kill switch applies
  const openKind = target === "perpl" ? "trade-perpl" : "trade-meridian";
  const flagsBlocked = useOpenBlocked(openKind);
  const canConfirm = q.status === "ok" && q.chosen !== undefined && !blocked && !busy && flagsBlocked === undefined;
  const summary = q.chosen && q.status === "ok" ? summaryText({ side, chosen: q.chosen }) : undefined;

  const onMove = useCallback(
    (amountWad: bigint) => {
      if (!venue) return;
      setMoving(true);
      setError(undefined);
      venue.onboarding
        .deposit(formatUnitsExact(owedToken(amountWad), 6))
        .then(
          () => {
            haptic.success();
            accounts?.invalidate();
            return venue.refresh();
          },
          (e: unknown) => setError(plainTradeError(e instanceof Error ? e.message : String(e))),
        )
        .finally(() => setMoving(false));
    },
    [venue, accounts],
  );

  const confirm = () => {
    const c = q.chosen;
    if (!c || !summary || !canConfirm) return;
    setError(undefined);
    start({
      venue: c.venue,
      side: side === "long" ? "buy" : "sell",
      sizeWad: c.sizeWad,
      reduceOnly: false,
      limitPriceWad: c.limitPriceWad,
      ...(c.quote.walk.avgPriceWad !== undefined ? { expectedAvgWad: c.quote.walk.avgPriceWad } : {}),
      summary,
      needWad: c.marginWad + c.feeWad,
      leverage100: Math.round(leverage * 100),
    }).then(
      (r) => {
        if (r?.ok) {
          sheet.current?.dismiss();
          setText("");
          router.push("/receipt");
        } else {
          haptic.error();
          setError(r?.error ?? "Still checking the order. It will finish on its own; you'll see the receipt.");
        }
      },
      (e: unknown) => {
        haptic.error();
        setError(plainTradeError(e instanceof Error ? e.message : String(e)));
      },
    );
  };

  const backdrop = useCallback((p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} pressBehavior="close" />, []);

  return (
    <BottomSheetModal ref={sheet} snapPoints={SNAP} enableDynamicSizing={false} backdropComponent={backdrop} backgroundStyle={s.bg} handleIndicatorStyle={s.handle} animateOnMount={!reduced} onDismiss={() => executor?.reset()}>
      <BottomSheetScrollView contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <Segmented
          options={[
            { value: "long", label: "Long" },
            { value: "short", label: "Short" },
          ]}
          value={side}
          onChange={setSide}
          accessibilityLabel="Long or short"
        />
        <Numpad text={text} onChange={setText} presets={presets} caption={target ? `Margin from your ${target === "perpl" ? "Perpl" : "Meridian"} balance + wallet` : "Margin in AUSD"} testID="ticket" />

        <View style={s.group}>
          <View style={s.row}>
            <Text variant="caption" tone="muted">
              Leverage
            </Text>
            <Text bold testID="ticket-leverage">
              {leverage}×
            </Text>
          </View>
          <Slider steps={LEVERAGES} index={levIdx} onChange={setLevIdx} accessibilityLabel="Leverage" describe={(i) => `${LEVERAGES[i]} times`} />
          <View style={s.row}>
            {LEVERAGES.map((l) => (
              <Text key={l} variant="caption" tone="muted">
                {l}×
              </Text>
            ))}
          </View>
        </View>

        <View style={s.group}>
          <Text variant="caption" tone="muted">
            Slippage (worst price vs the book)
          </Text>
          <Segmented options={SLIPPAGES.map((x) => ({ value: x.value, label: x.label }))} value={slip} onChange={setSlip} accessibilityLabel="Slippage" />
        </View>

        <View style={s.group}>
          <View style={s.row}>
            <Text variant="caption" tone="muted">
              Both books, after fees
            </Text>
            <Pressable onPress={() => setPick("best")} accessibilityRole="button" accessibilityLabel="Use the best price" hitSlop={8} testID="pick-best">
              <Text variant="caption" tone={pick === "best" ? "brand" : "muted"} bold>
                {pick === "best" ? "Best price ✓" : "Best price"}
              </Text>
            </Pressable>
          </View>
          {q.lines.map((l) => (
            <QuoteRow key={l.venue} l={l} best={q.best === l.venue} chosen={q.chosen?.venue === l.venue} onPick={() => setPick(l.venue)} />
          ))}
          <Button title="See both books" variant="link" onPress={() => router.push("/route")} testID="btn-route" />
        </View>

        {q.status !== "ok" ? (
          <Text tone="muted" testID="ticket-status">
            {q.chosen?.reason && q.status === "venue-unavailable" ? `${q.chosen.reason}. Tap Best price.` : STATUS_TEXT[q.status]}
          </Text>
        ) : null}
        {summary ? (
          <View style={s.summary}>
            <Text bold testID="ticket-summary">
              {summary}
            </Text>
            <Text variant="caption" tone="muted">
              Margin {feeText(q.chosen!.marginWad)} · Perpl orders are gasless; Meridian needs a little MON for gas.
            </Text>
          </View>
        ) : null}
        <Blockers q={q} onMove={onMove} moving={moving} />
        {error ? (
          <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="ticket-error">
            {error}
          </Text>
        ) : null}
        <FlagsLine kind={openKind} testID="ticket-flags" />
        <ConfirmBar action={side === "long" ? "go long" : "go short"} onConfirm={confirm} disabled={!canConfirm} testID="ticket-confirm" />
        {busy ? (
          <Text variant="caption" tone="muted" accessibilityLiveRegion="polite" testID="ticket-progress">
            {exec.error ?? PHASE_TEXT[exec.phase]}
          </Text>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});


const SNAP = ["94%"];
const NO_EXEC = new Store<ExecState>({ phase: "idle", venue: undefined, error: undefined, receipt: undefined });
const selExec = (s: ExecState) => s;
const selBal = (f: WalletFeed) => f.balances;
const selAcc = (s: AccountsState) => s;
const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });

/** Spendable AUSD for `venue`: free collateral on it + the wallet token that funds it (deposited in the flow). */
function useAvailable(venue: "meridian" | "perpl" | undefined): bigint | undefined {
  const cfg = useLive().config;
  const bal = useWalletFeed(selBal);
  const acc = useStore(useTrade().accounts?.store ?? NO_ACC, selAcc);
  if (!venue) return undefined;
  const wallet = walletWadFor(cfg, bal, venue) ?? 0n;
  const free = venue === "meridian" ? (acc.meridian?.freeWad ?? 0n) : (acc.perpl?.freeWad ?? 0n);
  return wallet + free;
}

const s = StyleSheet.create({
  bg: { backgroundColor: colors.card, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  handle: { backgroundColor: colors.muted, width: 36 },
  body: { paddingHorizontal: space.l, paddingTop: space.s, gap: space.l },
  group: { gap: space.s },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  qrow: { minHeight: HIT, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.m, borderRadius: radius.inner, borderWidth: 1, borderColor: colors.border, gap: space.s },
  qrowOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  qname: { flexDirection: "row", alignItems: "center", gap: space.s },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  num: { fontVariant: ["tabular-nums"] },
  reason: { flexShrink: 1, textAlign: "right" },
  summary: { gap: space.xs, padding: space.m, borderRadius: radius.inner, backgroundColor: colors.bg },
  block: { gap: space.s, padding: space.m, borderRadius: radius.inner, borderWidth: 1, borderColor: colors.border },
});
