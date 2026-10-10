// Earn screen + receipt (RNTL, fakes, no network): the live hero, the "No edge right now" state with Perpl's next funding
// time, numpad → legs in plain words + ≈ $/day → the VISIBLE tap alternative starts the two-leg run → receipt timeline;
// the dev flag (shown in __DEV__ only) forces the auto-unwind; the hedged position closes Meridian-first; a one-sided
// leftover shows the one-tap close; the receipt fires the success haptic only on DONE / CLOSED.
jest.mock("@gorhom/bottom-sheet", () => require("@gorhom/bottom-sheet/mock"));
jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
  useFocusEffect: () => undefined,
}));
jest.mock("../../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));

import rec from "../../../../packages/core/fixtures/books/testnet-meridian-69059070.json";
import { meridianLevels, perplLevels } from "@meridian/core/route";
import type { LegSpec } from "@meridian/core/exec";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import EarnReceiptModal from "../../app/earn-receipt";
import { AuthProvider } from "../../auth/AuthProvider";
import type { AuthController } from "../../auth/controller";
import { EarnProvider } from "../../features/earn/EarnProvider";
import { FlagsProvider } from "../../features/flags/FlagsProvider";
import type { FlagsClient } from "../../features/flags/client";
import { EarnScreen } from "../../features/earn/EarnScreen";
import { EarnExecutor, earnReceiptStore } from "../../features/earn/executor";
import { SwapReader } from "../../features/earn/data/swap";
import { earnRecordStore, positionStore } from "../../features/earn/record";
import type { EarnTimeline } from "../../features/earn/timeline";
import { AccountsReader } from "../../features/trade/data/accounts";
import { TradeProvider, type TradeKit } from "../../features/trade/TradeProvider";
import { WalletFeedProvider } from "../../features/wallet/WalletFeedProvider";
import { LiveProvider } from "../../live/LiveProvider";
import { Store } from "../../live/store";
import { ToastProvider } from "../../ui";
import { PerplProvider } from "../../venues/perpl/PerplProvider";
import { WalletFeedStore } from "../../wallet/feed";
import { makeAuth } from "../auth/authFixtures";
import { fakeLive } from "../fakeLive";
import { fakeFlags } from "../flags/flagsFixtures";

const WAD = 10n ** 18n;
const pct = (x: number) => (BigInt(x * 100) * WAD) / 10_000n;
const mockRouter = (jest.requireMock("expo-router") as { router: Record<"push", jest.Mock> }).router;
const mockHaptic = (jest.requireMock("../../ui/haptics") as { haptic: Record<"success" | "error", jest.Mock> }).haptic;
const m = rec.meridian;
const tick = BigInt(m.tickSize);
const lot = BigInt(m.lotSize);
const pm = rec.perpl.market;

function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

/** perplApr / meridianApr as APR %; the run's venues answer per `fill` */
async function setup(o: { meridianApr?: number; perplApr?: number; meridianFails?: boolean; lock?: boolean } = {}) {
  const { auth } = makeAuth();
  await auth.init();
  await auth.create();
  const f = fakeLive();
  const blockTime = BigInt(m.fundingParams.blockTimeMs);
  // a cadence equal to the contract's block time ⇒ effective APR = rate · year
  f.blocks.store.update({ block: 69059070n, cadence: { blocks: 1000n, elapsedMs: 1000n * blockTime } });
  const ratePerSec = pct(o.meridianApr ?? 30) / 31_536_000n;
  f.meridian.store.update({
    rateWad: ratePerSec,
    paramBlockTimeMs: blockTime,
    bookKnown: true,
    bids: meridianLevels(m.bids.ticks, m.bids.lots.map(BigInt), tick, lot),
    asks: meridianLevels(m.asks.ticks, m.asks.lots.map(BigInt), tick, lot),
    tickSizeWad: tick,
    lotSizeWad: lot,
    takerFeeWad: BigInt(m.riskParams.takerFee),
    imrWad: BigInt(m.riskParams.imr),
    mmrWad: BigInt(m.riskParams.mmr),
    markWad: BigInt(m.markPrice),
  });
  const ps = 10n ** BigInt(18 - pm.priceDecimals);
  f.perpl.store.update({
    aprNowWad: pct(o.perplApr ?? -15),
    bookKnown: true,
    bids: perplLevels(rec.perpl.book.bid, pm.priceDecimals, pm.sizeDecimals),
    asks: perplLevels(rec.perpl.book.ask, pm.priceDecimals, pm.sizeDecimals),
    bestBidWad: BigInt(rec.perpl.book.bid[0]!.p) * ps,
    bestAskWad: BigInt(rec.perpl.book.ask[0]!.p) * ps,
    takerMicros: 345,
    markWad: 2558n * ps,
    countdown: { nextBlock: 2n, blocksLeft: 1n, secondsLeft: 754n, due: false },
  });
  const address = auth.account().address;
  const accounts = new AccountsReader({ client: { multicall: async () => [] } as never, address, meridian: undefined, perpl: undefined });
  accounts.store.update({ meridian: { collateralWad: 0n, sizeWad: 0n, entryWad: 0n, upnlWad: 0n, pendingFundingWad: 0n, equityWad: 0n, freeWad: 0n, liqWad: 0n, maintenanceWad: 0n }, perpl: { accountId: 7n, freeWad: 0n, balanceWad: 0n, position: undefined, otherMarkets: false, equityWad: 0n, held: false }, perplMargins: { initHdths: 1000n, maintHdths: 500n } });
  const feed = new WalletFeedStore();
  const cfg = f.live.config;
  const tokens = cfg.meridian.status === "deployed" && cfg.perpl.status === "deployed" ? [cfg.meridian.deployment.contracts.AUSD, cfg.perpl.deployment.collateralToken] : [];
  feed.push({ mon: WAD, tokens: tokens.map((_, i) => ({ label: `t${i}`, amount: 1_000_000_000n, decimals: 6 })), block: 1n, error: undefined });

  const sent: LegSpec[] = [];
  const { kv, map } = memKv();
  const executor = new EarnExecutor({
    chainId: 10143,
    address,
    runs: earnRecordStore(kv, 10143, address),
    positions: positionStore(kv, 10143, address),
    legFor: (leg) => ({
      legs: {
        prepare: async (l) => {
          sent.push(l);
          return l.venue === "meridian" ? `0x${"cd".repeat(32)}` : `${100 + sent.length}:1000`;
        },
        send: async () => undefined,
        confirm: async (l) => (l.venue === "meridian" && o.meridianFails ? { failed: "The contract refused: slippage exceeded." } : { filledWad: l.sizeWad, avgPriceWad: 2567n * 10n ** 13n }),
      },
      orderId: () => (leg.venue === "perpl" ? 9001 : undefined),
    }),
    ensureCollateral: async () => undefined,
    head: () => 69059070n,
    explorerBase: "https://testnet.monadexplorer.com",
    sleep: async () => undefined,
    wrapLegs: (legs, meta) => (meta.devFailMeridian ? (require("../../features/earn/devFail") as typeof import("../../features/earn/devFail")).withForcedMeridianFailure(legs) : legs),
  });
  const kit: TradeKit = { chart: undefined, accounts, executor: undefined, focus: new Store(1) };
  const venue = { onboarding: { store: new Store({ view: { ready: true } }) }, socket: { store: new Store({ status: "ready", account: { ft: 0 } }) } };
  // the funding-swap market (Lock): a reader with its store filled as the chain would (no network)
  const swap = new SwapReader({ client: { multicall: async () => [] } as never, market: "0x00000000000000000000000000000000000005a0", book: "0x00000000000000000000000000000000000005b0", clearingHouse: "0x00000000000000000000000000000000000005c0", address });
  if (o.lock) {
    const SLOT = 1_000n * WAD;
    f.meridian.store.update({ indexWad: BigInt(m.markPrice), bids: [{ priceWad: 25848n * tick, sizeWad: 5_000n * WAD }] });
    swap.store.update({ atBlock: 1n, tickSizeWad: 10n ** 14n, lotSizeWad: SLOT, params: { liqHorizonSec: 86_400n, aprMoveBuffer: 5n * 10n ** 16n, imMultiplier: 15n * 10n ** 17n, takerFeeApr: 2n * 10n ** 15n }, maturity: 1_794_000_000n, capAprWad: 555_555_555_556n * 31_536_000n, bids: [{ priceWad: 112n * 10n ** 16n, sizeWad: 3n * SLOT }], asks: [{ priceWad: 1125n * 10n ** 15n, sizeWad: 3n * SLOT }], bookKnown: true, markAprWad: 12n * 10n ** 16n, tauSec: 30n * 86_400n, matured: false, account: undefined });
  }
  return { auth, address, live: f.live, kit, feed, executor, sent, map, kv, accounts, venue, meridian: f.meridian, swap };
}

function wrap(s: Awaited<ReturnType<typeof setup>> & { noReader?: boolean }, children: ReactNode, flags?: FlagsClient) {
  const app = (
    <AuthProvider controller={s.auth as AuthController}>
      <PerplProvider venue={s.venue as never}>
        <ToastProvider>
          <WalletFeedProvider feed={s.feed} read={false}>
            <TradeProvider kit={s.kit}>
              <EarnProvider kit={{ executor: s.executor, history: undefined, swap: s.noReader ? undefined : s.swap }}>{children}</EarnProvider>
            </TradeProvider>
          </WalletFeedProvider>
        </ToastProvider>
      </PerplProvider>
    </AuthProvider>
  );
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={s.live}>{flags ? <FlagsProvider client={flags}>{app}</FlagsProvider> : app}</LiveProvider>
    </SafeAreaProvider>
  );
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function type(keys: string[]) {
  for (const k of keys) await fireEvent.press(screen.getByTestId(`earn-key-${k}`));
  await wait(200); // input debounce 150 ms
}

beforeEach(() => {
  jest.clearAllMocks();
  earnReceiptStore.set(undefined);
});

it("no edge: says so with Perpl's next funding time; nothing to confirm", async () => {
  const s = await setup({ meridianApr: 10, perplApr: 10 });
  await render(wrap(s, <EarnScreen />));
  expect(screen.getByTestId("earn-no-edge")).toHaveTextContent(/No edge right now/);
  expect(screen.getByTestId("earn-no-edge")).toHaveTextContent(/Perpl's next funding in 12m 34s/);
  await type(["1", "0"]);
  expect(screen.getByTestId("earn-confirm-tap")).toBeDisabled();
});

it("$10: hero APR, legs in plain words, ≈ $/day, deposits named; the tap alternative runs both legs → receipt", async () => {
  const s = await setup();
  await render(wrap(s, <EarnScreen />));
  expect(screen.getByTestId("earn-apr")).toHaveTextContent(/^4\d\.\d\d%$/); // 45 % gap minus the 30 d fee drag
  await type(["1", "0"]);
  expect(screen.getByTestId("earn-legs")).toHaveTextContent("Long 300 MON on Perpl · Short 300 MON on Meridian");
  expect(screen.getByTestId("earn-per-day")).toHaveTextContent(/^≈ \$0\.0\d \/ day$/);
  expect(screen.getByTestId("earn-deposits")).toHaveTextContent(/^Adds [\d.]+ AUSD to Meridian and [\d.]+ AUSD to Perpl from your wallet first \(one fingerprint prompt\)\.$/);
  const tap = screen.getByTestId("earn-confirm-tap");
  expect(tap).toHaveProp("accessibilityHint", "Confirms with one tap instead of holding");
  await fireEvent.press(tap);
  await wait(20);
  // Perpl first, then Meridian for exactly the filled size
  expect(s.sent.map((l) => [l.venue, l.side, l.sizeWad, l.reduceOnly])).toEqual([
    ["perpl", "buy", 300n * WAD, false],
    ["meridian", "sell", 300n * WAD, false],
  ]);
  const t = earnReceiptStore.get()!;
  expect(t.phase).toBe("DONE");
  expect(mockRouter.push).toHaveBeenCalledWith("/earn-receipt");
  expect(screen.getByTestId("earn-amount")).toHaveTextContent("0"); // cleared after success
  expect(s.executor.position.get()).toMatchObject({ perplSide: "buy", sizeWad: 300n * WAD });
});

it("a failed hedge: auto-unwound, the receipt says so in plain words, no success haptic", async () => {
  const s = await setup({ meridianFails: true });
  await render(wrap(s, <EarnScreen />));
  await type(["1", "0"]);
  await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
  await wait(20);
  expect(s.sent.map((l) => [l.venue, l.side, l.reduceOnly])).toEqual([
    ["perpl", "buy", false],
    ["meridian", "sell", false],
    ["perpl", "sell", true],
  ]);
  const t = earnReceiptStore.get()!;
  expect(t.phase).toBe("ABORTED_UNWOUND");
  await render(wrap(s, <EarnReceiptModal />));
  expect(screen.getByTestId("earn-receipt-title")).toHaveTextContent("Undone automatically");
  expect(screen.getByTestId("earn-receipt-timeline-leg2-status")).toHaveTextContent(/Didn't fill · The price moved past your worst price/);
  expect(mockHaptic.success).not.toHaveBeenCalled();
});

it("dev flag (__DEV__ only): forces the Meridian leg to fail before sending → Perpl auto-unwound", async () => {
  const s = await setup();
  await render(wrap(s, <EarnScreen />));
  await fireEvent(screen.getByTestId("dev-fail-meridian"), "valueChange", true);
  await type(["1", "0"]);
  await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
  await wait(20);
  expect(s.sent.map((l) => l.venue)).toEqual(["perpl", "perpl"]); // the Meridian leg never reached the venue
  expect(earnReceiptStore.get()!.phase).toBe("ABORTED_UNWOUND");
});

it("the hedged position closes Meridian first, then Perpl for exactly what closed", async () => {
  const s = await setup();
  await render(wrap(s, <EarnScreen />));
  await type(["1", "0"]);
  await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
  await wait(20);
  s.sent.length = 0;
  // enough asks on Meridian for the 300 MON buy-back (the recorded book holds 100)
  await act(async () => s.meridian.store.update({ asks: [{ priceWad: 25864n * tick, sizeWad: 1_000n * WAD }] }));
  await act(async () => s.accounts.store.update({ meridian: { ...s.accounts.store.get().meridian!, sizeWad: -300n * WAD }, perpl: { accountId: 7n, freeWad: 0n, balanceWad: 0n, position: { side: "Long", sizeWad: 300n * WAD } as never, otherMarkets: false, equityWad: 0n, held: true } }));
  expect(screen.getByTestId("earn-position-size")).toHaveTextContent("300 MON each side");
  await fireEvent.press(screen.getByTestId("earn-close"));
  expect(screen.getByTestId("earn-close-summary")).toHaveTextContent(/^Close 300 MON on Meridian first, then the same on Perpl/);
  // the wallet's fixed-rate lock isn't read yet: nothing is sent (a pair closed under an open lock would leave the swap naked)
  await fireEvent.press(screen.getByTestId("earn-close-confirm-tap"));
  await wait(20);
  expect(s.sent).toEqual([]);
  expect(screen.getByTestId("earn-error")).toHaveTextContent("Reading your fixed-rate lock… Try again in a moment.");
  // read: no lock
  await act(async () => s.swap.store.update({ atBlock: 2n, account: { collateralWad: 0n, sizeWad: 0n, kWad: 0n, avgFixedAprWad: 0n } }));
  await fireEvent.press(screen.getByTestId("earn-close-confirm-tap"));
  await wait(20);
  expect(s.sent.map((l) => [l.venue, l.side, l.reduceOnly])).toEqual([
    ["meridian", "buy", true],
    ["perpl", "sell", true],
  ]);
  expect(earnReceiptStore.get()!.phase).toBe("CLOSED");
  expect(s.executor.position.get().sizeWad).toBe(0n);
});

it("a one-sided leftover is shown with the one-tap close (never silent)", async () => {
  const s = await setup();
  // stored by an earlier MANUAL run: survives a relaunch (EarnProvider resumes → loads it)
  await positionStore(s.kv, 10143, s.address).save({ v: 1, perplSide: undefined, sizeWad: 0n, naked: { venue: "perpl", side: "buy", sizeWad: 300n * WAD }, applied: ["e1"] });
  await render(wrap(s, <EarnScreen />));
  await wait(10);
  expect(screen.getByTestId("earn-leftover")).toHaveTextContent(/Action needed/);
  expect(screen.getByTestId("earn-leftover-close")).toHaveTextContent("Close 300 MON on Perpl now");
});

it("Lock: the live fixed rate + why it's unavailable; on ⇒ the swap leg runs after the hedge and its deposit is named", async () => {
  const s = await setup({ lock: true });
  await render(wrap(s, <EarnScreen />));
  await type(["1", "0"]);
  expect(screen.getByTestId("earn-lock-reason")).toHaveTextContent("Lock needs at least 1,000 MON on each side (one swap lot).");
  expect(screen.getByTestId("earn-lock-toggle")).toBeDisabled();
  await type(["back", "back", "8", "0"]);
  expect(screen.getByTestId("earn-lock-quote")).toHaveTextContent(/^Receive 11\.\d\d% fixed \(after the swap fee\) instead of Meridian's floating funding on [\d,]+ MON until /);
  await fireEvent(screen.getByTestId("earn-lock-toggle"), "valueChange", true);
  expect(screen.getByTestId("earn-deposits")).toHaveTextContent(/and [\d.]+ AUSD to the fixed-rate market from your wallet first/);
  await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
  await wait(20);
  expect(s.sent.map((l) => [l.venue, l.side, l.reduceOnly])).toEqual([
    ["perpl", "buy", false],
    ["meridian", "sell", false],
    ["swap", "sell", false],
  ]);
  expect(earnReceiptStore.get()!.steps.map((x) => x.key)).toEqual(["collateral", "leg1", "leg2", "leg3"]);
});

it("N8 D4.1: the swap market is deployed (config) but its reader isn't there yet ⇒ Close waits, nothing sent", async () => {
  const s = await setup();
  // a pair from an earlier session; the swap reader is created a moment after unlock
  await positionStore(s.kv, 10143, s.address).save({ v: 1, perplSide: "buy", sizeWad: 300n * WAD, naked: undefined, applied: ["e0"] });
  await act(async () => s.meridian.store.update({ asks: [{ priceWad: 25864n * tick, sizeWad: 1_000n * WAD }] }));
  await act(async () => s.accounts.store.update({ meridian: { ...s.accounts.store.get().meridian!, sizeWad: -300n * WAD }, perpl: { accountId: 7n, freeWad: 0n, balanceWad: 0n, position: { side: "Long", sizeWad: 300n * WAD } as never, otherMarkets: false, equityWad: 0n, held: true } }));
  await render(wrap({ ...s, noReader: true }, <EarnScreen />));
  await wait(10);
  await fireEvent.press(screen.getByTestId("earn-close"));
  await fireEvent.press(screen.getByTestId("earn-close-confirm-tap"));
  await wait(20);
  expect(s.sent).toEqual([]);
  expect(screen.getByTestId("earn-error")).toHaveTextContent("Reading your fixed-rate lock… Try again in a moment.");
});

describe("remote kill switch (N8 flags)", () => {
  it("writes off: Earn open is refused with the message; the open position still closes; back on ⇒ open returns", async () => {
    const s = await setup();
    const f = fakeFlags();
    await render(wrap(s, <EarnScreen />, f.client));
    await wait(10);
    await type(["1", "0"]);
    await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
    await wait(20);
    expect(s.executor.position.get().sizeWad).toBe(300n * WAD);
    s.sent.length = 0;
    // the kill switch flips while the position is open
    f.set({ writes: false });
    await act(async () => f.client.refresh());
    expect(screen.getByTestId("earn-flags")).toHaveTextContent("Trading is paused for maintenance. You can still close positions.");
    expect(screen.queryByTestId("earn-confirm-tap")).toBeNull();
    // Close is never gated
    await act(async () => s.meridian.store.update({ asks: [{ priceWad: 25864n * tick, sizeWad: 1_000n * WAD }] }));
    await act(async () => s.accounts.store.update({ meridian: { ...s.accounts.store.get().meridian!, sizeWad: -300n * WAD }, perpl: { accountId: 7n, freeWad: 0n, balanceWad: 0n, position: { side: "Long", sizeWad: 300n * WAD } as never, otherMarkets: false, equityWad: 0n, held: true } }));
    await act(async () => s.swap.store.update({ atBlock: 2n, account: { collateralWad: 0n, sizeWad: 0n, kWad: 0n, avgFixedAprWad: 0n } }));
    await fireEvent.press(screen.getByTestId("earn-close"));
    await fireEvent.press(screen.getByTestId("earn-close-confirm-tap"));
    await wait(20);
    expect(s.sent.map((l) => [l.venue, l.reduceOnly])).toEqual([
      ["meridian", true],
      ["perpl", true],
    ]);
    expect(earnReceiptStore.get()!.phase).toBe("CLOSED");
    f.set({});
    await act(async () => f.client.refresh());
    expect(screen.getByTestId("earn-confirm-tap")).toBeTruthy();
  });

  it("earn off: open refused, the reason shown", async () => {
    const s = await setup();
    const f = fakeFlags({ flags: { earn: false } });
    await render(wrap(s, <EarnScreen />, f.client));
    await wait(10);
    expect(screen.getByTestId("earn-flags")).toHaveTextContent("Earn is paused for now. You can still close positions.");
    expect(screen.queryByTestId("earn-confirm-tap")).toBeNull();
  });

  it("a leftover's one-tap close shows whatever the flags say", async () => {
    const s = await setup();
    const f = fakeFlags({ flags: { writes: false } });
    await positionStore(s.kv, 10143, s.address).save({ v: 1, perplSide: undefined, sizeWad: 0n, naked: { venue: "perpl", side: "buy", sizeWad: 300n * WAD }, applied: ["e1"] });
    await render(wrap(s, <EarnScreen />, f.client));
    await wait(10);
    expect(screen.getByTestId("earn-leftover-close")).not.toBeDisabled();
  });

  it("lock off: the Lock toggle is off with the reason; Earn still opens at the floating rate (no swap leg)", async () => {
    const s = await setup({ lock: true });
    const f = fakeFlags({ flags: { lock: false } });
    await render(wrap(s, <EarnScreen />, f.client));
    await wait(10);
    await type(["8", "0"]);
    expect(screen.getByTestId("earn-lock-paused")).toHaveTextContent("Fixed-rate locks are paused for now. Earn still opens at the floating rate.");
    expect(screen.getByTestId("earn-lock-toggle")).toBeDisabled();
    expect(screen.getByTestId("earn-lock-toggle")).toHaveProp("value", false);
    await fireEvent.press(screen.getByTestId("earn-confirm-tap"));
    await wait(20);
    expect(s.sent.map((l) => l.venue)).toEqual(["perpl", "meridian"]);
  });
});

describe("receipt haptics", () => {
  const t = (phase: EarnTimeline["phase"], outcome: EarnTimeline["outcome"]): EarnTimeline => ({ kind: "open", phase, outcome, headline: "h", body: "b", steps: [] });
  it.each([
    ["DONE", "success", "success"],
    ["PARTIAL_DONE", "partial", "none"],
    ["ABORTED_UNWOUND", "flat", "none"],
    ["MANUAL", "action", "error"],
  ] as const)("%s ⇒ %s haptic", async (phase, outcome, want) => {
    const s = await setup();
    earnReceiptStore.set(t(phase, outcome));
    await render(wrap(s, <EarnReceiptModal />));
    expect(mockHaptic.success).toHaveBeenCalledTimes(want === "success" ? 1 : 0);
    expect(mockHaptic.error).toHaveBeenCalledTimes(want === "error" ? 1 : 0);
  });
});
