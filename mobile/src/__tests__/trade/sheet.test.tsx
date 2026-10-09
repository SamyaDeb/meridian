// Ticket sheet flow (RNTL, fakes): numpad → live quote on the recorded Meridian book → plain summary → the VISIBLE tap
// alternative confirms (a11y) → the executor runs a persisted single-leg trade → receipt; a failure keeps the input and
// says why. Plus the Lite/Pro preference and the header's 24 h change.
jest.mock("@gorhom/bottom-sheet", () => require("@gorhom/bottom-sheet/mock"));
jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
  useFocusEffect: () => undefined,
}));
jest.mock("../../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));

import rec from "../../../../packages/core/fixtures/books/testnet-meridian-69059070.json";
import { meridianLevels } from "@meridian/core/route";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createRef, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../../auth/AuthProvider";
import type { AuthController } from "../../auth/controller";
import { AccountsReader } from "../../features/trade/data/accounts";
import { TradeExecutor } from "../../features/trade/exec/executor";
import { receiptStore } from "../../features/trade/exec/receipt";
import { recordStore } from "../../features/trade/exec/record";
import { loadTradeView, saveTradeView, TRADE_VIEW_KEY } from "../../features/trade/prefs";
import { TicketSheet, type TicketRef } from "../../features/trade/ticket/TicketSheet";
import { TradeProvider, type TradeKit } from "../../features/trade/TradeProvider";
import { WalletFeedProvider } from "../../features/wallet/WalletFeedProvider";
import { LiveProvider } from "../../live/LiveProvider";
import { Store } from "../../live/store";
import { ToastProvider } from "../../ui";
import { WalletFeedStore } from "../../wallet/feed";
import { makeAuth } from "../auth/authFixtures";
import { fakeLive } from "../fakeLive";

const WAD = 10n ** 18n;
const mockRouter = (jest.requireMock("expo-router") as { router: Record<"push", jest.Mock> }).router;
const m = rec.meridian;
const tick = BigInt(m.tickSize);
const lot = BigInt(m.lotSize);

function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

async function setup(o: { fail?: string } = {}) {
  const { auth } = makeAuth();
  await auth.init();
  await auth.create();
  const f = fakeLive();
  // the recorded Meridian book + riskParams at block 69,059,070
  f.meridian.store.update({
    bookKnown: true,
    bids: meridianLevels(m.bids.ticks, m.bids.lots.map(BigInt), tick, lot),
    asks: meridianLevels(m.asks.ticks, m.asks.lots.map(BigInt), tick, lot),
    bestBidWad: BigInt(m.bids.ticks[0]!) * tick,
    bestAskWad: BigInt(m.asks.ticks[0]!) * tick,
    tickSizeWad: tick,
    lotSizeWad: lot,
    takerFeeWad: BigInt(m.riskParams.takerFee),
    imrWad: BigInt(m.riskParams.imr),
    mmrWad: BigInt(m.riskParams.mmr),
    markWad: BigInt(m.markPrice),
  });
  const accounts = new AccountsReader({ client: { multicall: async () => [] } as never, address: auth.account().address, meridian: undefined, perpl: undefined });
  accounts.store.update({ meridian: { collateralWad: 100n * WAD, sizeWad: 0n, entryWad: 0n, upnlWad: 0n, pendingFundingWad: 0n, equityWad: 100n * WAD, freeWad: 100n * WAD, liqWad: 0n, maintenanceWad: 0n } });
  const sent: unknown[] = [];
  const { kv, map } = memKv();
  const executor = new TradeExecutor({
    store: recordStore(kv, 10143, auth.account().address),
    venueRun: () => ({
      legs: {
        prepare: async (leg) => {
          sent.push(leg);
          return "0x" + "ab".repeat(32);
        },
        send: async () => undefined,
        confirm: async (leg) => (o.fail ? { failed: o.fail } : { filledWad: leg.sizeWad, avgPriceWad: 25864n * tick }),
      },
      facts: async () => ({ receiptBlock: 69059072n }),
    }),
    head: () => 69059070n,
    explorerBase: "https://testnet.monadexplorer.com",
    collateralDecimals: 6,
    sleep: async () => undefined,
    afterTrade: () => undefined,
  });
  const kit: TradeKit = { chart: undefined, accounts, executor, focus: new Store(true) };
  const feed = new WalletFeedStore();
  return { auth, live: f.live, kit, feed, sent, map };
}

function wrap(s: Awaited<ReturnType<typeof setup>>, children: ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={s.live}>
        <AuthProvider controller={s.auth as AuthController}>
          <ToastProvider>
            <WalletFeedProvider feed={s.feed} read={false}>
              <TradeProvider kit={s.kit}>{children}</TradeProvider>
            </WalletFeedProvider>
          </ToastProvider>
        </AuthProvider>
      </LiveProvider>
    </SafeAreaProvider>
  );
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function type(keys: string[]) {
  for (const k of keys) await fireEvent.press(screen.getByTestId(`ticket-key-${k}`));
}

beforeEach(() => {
  jest.clearAllMocks();
  receiptStore.set(undefined);
});

it("short $5 × 2: numpad → Meridian quote → plain summary → tap alternative confirms → receipt", async () => {
  const s = await setup();
  const ref = createRef<TicketRef>();
  await render(wrap(s, <TicketSheet ref={ref} />));
  await act(async () => ref.current!.open("short"));
  await type(["5"]);
  await wait(200); // input debounce 150 ms
  expect(screen.getByTestId("ticket-amount")).toHaveTextContent("5");
  expect(screen.getByTestId("ticket-summary")).toHaveTextContent(/^Short 300 MON on Meridian · worst price \$0\.025589 · fee \$0\.0\d · liq \$0\.\d+$/);
  // a11y: the visible single-tap alternative sits right under the hold button
  const tap = screen.getByTestId("ticket-confirm-tap");
  expect(tap).toHaveProp("accessibilityHint", "Confirms with one tap instead of holding");
  expect(screen.getByTestId("ticket-confirm-hold")).toBeTruthy();
  await fireEvent.press(tap);
  await wait(20);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toMatchObject({ venue: "meridian", side: "sell", sizeWad: 300n * WAD, limitPriceWad: 25589n * tick, reduceOnly: false });
  const r = receiptStore.get()!;
  expect(r.ok).toBe(true);
  expect(r.explorerTxUrl).toBe(`https://testnet.monadexplorer.com/tx/0x${"ab".repeat(32)}`);
  expect(r.blocksToFill).toBe(2n);
  expect(mockRouter.push).toHaveBeenCalledWith("/receipt");
  expect(s.map.size).toBe(0); // the terminal record is cleared
});

it("a failed fill: error haptic + the specific reason, the amount stays", async () => {
  const s = await setup({ fail: "The contract refused: slippage exceeded." });
  const ref = createRef<TicketRef>();
  await render(wrap(s, <TicketSheet ref={ref} />));
  await act(async () => ref.current!.open("short"));
  await type(["5"]);
  await wait(200);
  await fireEvent.press(screen.getByTestId("ticket-confirm-tap"));
  await wait(20);
  expect(await screen.findByTestId("ticket-error")).toHaveTextContent(/price moved past your worst price/);
  expect(screen.getByTestId("ticket-amount")).toHaveTextContent("5");
  expect(mockRouter.push).not.toHaveBeenCalledWith("/receipt");
});

it("nothing entered ⇒ 'Enter an amount' and confirm disabled; an empty book never shows fake levels", async () => {
  const s = await setup();
  s.live.meridian!.store.update({ bids: [], asks: [] });
  const ref = createRef<TicketRef>();
  await render(wrap(s, <TicketSheet ref={ref} />));
  await act(async () => ref.current!.open("long"));
  expect(screen.getByTestId("ticket-status")).toHaveTextContent("Enter an amount");
  expect(screen.getByTestId("ticket-confirm-tap")).toBeDisabled();
  await type(["5"]);
  await wait(200);
  expect(screen.getByTestId("ticket-status")).toHaveTextContent("No liquidity right now");
  expect(screen.queryByTestId("ticket-summary")).toBeNull();
});

it("Lite by default; Pro remembered; garbage ⇒ Lite", async () => {
  const { kv } = memKv();
  expect(await loadTradeView(kv)).toBe("lite");
  await saveTradeView(kv, "pro");
  expect(await loadTradeView(kv)).toBe("pro");
  await kv.set(TRADE_VIEW_KEY, "???");
  expect(await loadTradeView(kv)).toBe("lite");
  expect(await loadTradeView({ get: async () => Promise.reject(new Error("io")), set: async () => undefined, del: async () => undefined })).toBe("lite");
});
