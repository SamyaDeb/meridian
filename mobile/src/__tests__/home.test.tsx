// N4b + N7 Home / Add funds / Settings passkey card / tab order, offline: the wallet feed, the account reader's store,
// the activity feed and the alert settings are injected and fed by hand.
jest.mock("@gorhom/bottom-sheet", () => require("@gorhom/bottom-sheet/mock"));
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../auth/AuthProvider";
import type { AuthController } from "../auth/controller";
import { WalletFeedProvider } from "../features/wallet/WalletFeedProvider";
import { ActivityProvider, type ActivityKit } from "../features/activity/ActivityProvider";
import { AccountsReader, mapMeridian, mapPerpl, type AccountsState } from "../features/trade/data/accounts";
import { TradeProvider, type TradeKit } from "../features/trade/TradeProvider";
import { EarnProvider, type EarnKit } from "../features/earn/EarnProvider";
import { LiveProvider } from "../live/LiveProvider";
import { Store } from "../live/store";
import { COUNT_UP_MS, ToastProvider } from "../ui";
import { haptic } from "../ui/haptics";
import type { BalanceState } from "../wallet/balances";
import { WalletFeedStore } from "../wallet/feed";
import { makeAuth } from "./auth/authFixtures";
import { fakeLive } from "./fakeLive";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
  useFocusEffect: () => undefined,
  Redirect: () => null,
  Tabs: Object.assign(() => null, { Screen: () => null }),
}));
jest.mock("../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));
const mockRouter = (jest.requireMock("expo-router") as { router: Record<"replace" | "push" | "navigate", jest.Mock> }).router;

import Home from "../app/(tabs)/portfolio";
import { unstable_settings } from "../app/(tabs)/_layout";
import AddFunds from "../app/fund";
import { PASSKEY_SIGN_OUT, PASSKEY_STATUS, PasskeyCard } from "../features/wallet/PasskeyCard";
import { TABS } from "../features/shell/tabs";

const LABEL = "Test AUSD (Meridian)";
let block = 100n;
const bal = (ausd: bigint | undefined, mon: bigint | undefined = 10n ** 18n): BalanceState => ({
  block: ++block,
  mon,
  tokens: [{ label: LABEL, amount: ausd, decimals: ausd === undefined ? undefined : 6 }],
  error: undefined,
});

async function setup() {
  const { auth } = makeAuth();
  await auth.init();
  await auth.create();
  const feed = new WalletFeedStore();
  return { auth, feed };
}

const WAD = 10n ** 18n;
const NO_POSITIONS: Partial<AccountsState> = { meridian: mapMeridian({ collateral: 0n, size: 0n, entryPrice: 0n, unrealizedPnl: 0n, pendingFunding: 0n, equity: 0n, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 0n }), perpl: null };

/** An account reader whose store the test sets (no chain reads). */
function accountsKit(state: Partial<AccountsState> = NO_POSITIONS): { kit: TradeKit; accounts: AccountsReader } {
  const accounts = new AccountsReader({ client: { multicall: jest.fn() } as never, address: "0x0000000000000000000000000000000000000001", meridian: undefined, perpl: undefined });
  accounts.store.update({ atBlock: 1n, ...state });
  return { accounts, kit: { chart: undefined, accounts, executor: undefined, focus: new Store(0) } };
}

type Extra = { trade?: TradeKit; activity?: ActivityKit; live?: ReturnType<typeof fakeLive>; earn?: EarnKit };

function wrap(auth: AuthController, feed: WalletFeedStore, children: ReactNode, x: Extra = {}) {
  const { live } = x.live ?? fakeLive();
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={live}>
        <AuthProvider controller={auth}>
          <ToastProvider>
            <WalletFeedProvider feed={feed} read={false}>
              <ActivityProvider kit={x.activity ?? { log: undefined, feed: undefined }}>
                <TradeProvider kit={x.trade ?? accountsKit().kit}>{x.earn ? <EarnProvider kit={x.earn}>{children}</EarnProvider> : children}</TradeProvider>
              </ActivityProvider>
            </WalletFeedProvider>
          </ToastProvider>
        </AuthProvider>
      </LiveProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => jest.clearAllMocks());
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

it("tabs: Home · Trade · Earn · Settings, Home (portfolio) first and initial", () => {
  expect(TABS.map((t) => t.title)).toEqual(["Home", "Trade", "Earn", "Settings"]);
  expect(TABS[0]!.name).toBe("portfolio");
  expect(unstable_settings.initialRouteName).toBe("portfolio");
});

it("Home: '—' until balances are known, then the empty state with the next step", async () => {
  const { auth, feed } = await setup();
  await render(wrap(auth, feed, <Home />));
  expect(screen.getByTestId("home-total")).toHaveTextContent("—");
  expect(screen.queryByTestId("home-empty")).toBeNull();
  expect(screen.getByText(`Wallet ••${auth.account().address.slice(-4).toLowerCase()}`)).toBeTruthy();
  expect(screen.queryByText(/0x/)).toBeNull();
  await act(async () => feed.push(bal(0n)));
  expect(screen.getByTestId("home-total")).toHaveTextContent("0.00");
  expect(screen.getByText("Add AUSD to start")).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Get test funds" }))); // testnet build
  expect(mockRouter.push).toHaveBeenCalledWith("/fund");
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Trade" })));
  expect(mockRouter.navigate).toHaveBeenCalledWith("/trade");
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Earn" })));
  expect(mockRouter.navigate).toHaveBeenCalledWith("/earn");
});

it("Home: a deposit arrives → toast '+12.50 AUSD arrived' + success haptic, total counts up to 12.50", async () => {
  const { auth, feed } = await setup();
  await render(wrap(auth, feed, <Home />));
  await act(async () => feed.push(bal(0n)));
  expect(haptic.success).not.toHaveBeenCalled(); // first read is not an arrival
  await act(async () => feed.push(bal(12_500_000n)));
  expect(screen.getByText("+12.50 AUSD arrived")).toBeTruthy();
  expect(haptic.success).toHaveBeenCalledTimes(1);
  await wait(COUNT_UP_MS + 100);
  expect(screen.getByTestId("home-total")).toHaveTextContent("12.50");
  expect(screen.queryByTestId("home-empty")).toBeNull();
});

it("Add funds: full address + QR + copy + share; 'Waiting for your deposit…' → arrival line", async () => {
  const { auth, feed } = await setup();
  const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as never);
  await act(async () => feed.push(bal(0n, 0n)));
  await render(wrap(auth, feed, <AddFunds />));
  const address = auth.account().address;
  expect(screen.getByTestId("wallet-address")).toHaveTextContent(address);
  expect(screen.getByTestId("arrival-line")).toHaveTextContent("Waiting for your deposit…");
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Share" })));
  expect(share).toHaveBeenCalledWith({ message: address });
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Copy address" })));
  expect(screen.getByText("Address copied")).toBeTruthy();
  // testnet: test AUSD needs MON first
  expect(screen.getByTestId("btn-mint")).toBeDisabled();
  await act(async () => feed.push(bal(0n, 10n ** 17n)));
  expect(screen.getByTestId("btn-mint")).toBeEnabled();
  await act(async () => feed.push(bal(12_500_000n, 10n ** 17n)));
  expect(screen.getByTestId("arrival-line")).toHaveTextContent("✓ +12.50 AUSD arrived");
});

it("Settings passkey card: where it lives and what sign-out does, as visible text", async () => {
  await render(<PasskeyCard />);
  expect(screen.getByText(PASSKEY_STATUS)).toBeTruthy();
  expect(PASSKEY_STATUS).toBe("Passkey · Google Password Manager · active");
  expect(screen.getByText(/saved in Google Password Manager on your Google account/)).toBeTruthy();
  expect(screen.getByText(PASSKEY_SIGN_OUT)).toBeTruthy();
  expect(PASSKEY_SIGN_OUT).toMatch(/only forgets this wallet on this phone/);
});

// ── N7 ──

import { Linking } from "react-native";
import { ActivityList } from "../features/activity/ActivityList";
import { ActivityFeed } from "../features/activity/feed";
import { ActivityLog } from "../features/activity/log";
import { AlertsCard, ALERTS_SCOPE } from "../features/alerts/AlertsCard";
import { AlertSettings, AlertsProvider } from "../features/alerts/AlertsProvider";
import { receiptStore, type Receipt } from "../features/trade/exec/receipt";
import Settings from "../app/(tabs)/settings";

const P = { exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc" as const, perpId: 64n, priceDecimals: 5, lotDecimals: 0, collateralDecimals: 6 };
// the recorded K3 hedge account (packages/core/fixtures/perpl/chain/account-10143-k3-hedge.json)
const K3 = mapPerpl({ accountId: 969n, balanceCNS: 4977468132n, lockedBalanceCNS: 0n, positions: { bank1: 1n << 64n, bank2: 0n, bank3: 0n, bank4: 0n } }, [{ positionType: 0, depositCNS: 22508666n, pricePNS: 2587n, priceResiduePNSQ16: 35288n, lotLNS: 2600n, deltaPnlCNS: -1469999n, premiumPnlCNS: -10530n }, 2530n], 500n, P)!;
const meridianLong = mapMeridian({ collateral: 100n * WAD, size: 300n * WAD, entryPrice: 25n * 10n ** 15n, unrealizedPnl: 2n * WAD, pendingFunding: WAD / 2n, equity: 100n * WAD + 2n * WAD - WAD / 2n, initialMargin: 2n * WAD, maintenanceMargin: WAD, reservedOrderMargin: 0n, liquidationPrice: 2n * 10n ** 16n });

function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

const tradeReceipt: Receipt = { ok: true, venue: "perpl", side: "long", reduceOnly: false, summary: "Long 600 MON on Perpl · worst price $0.02600", filledWad: 600n * WAD, stepWad: WAD, avgPriceWad: 2585n * 10n ** 13n, priceDp: 5, feeWad: 5351n * 10n ** 12n, orderId: 4525855211536, txHash: undefined, explorerTxUrl: undefined, blocksToFill: 2n, error: undefined };

it("Home total = wallet + Meridian equity + Perpl (balance + position); breakdown sheet lists each part", async () => {
  const { auth, feed } = await setup();
  const { kit } = accountsKit({ meridian: meridianLong, perpl: K3 });
  await act(async () => feed.push(bal(12_500_000n)));
  await render(wrap(auth, feed, <Home />, { trade: kit }));
  await wait(COUNT_UP_MS + 100);
  // 12.50 + 101.50 + (4977.468132 + 22.508666 − 1.469999 − 0.010530) = 5,112.496269 → shown rounded down 5,112.49
  expect(screen.getByTestId("home-total")).toHaveTextContent("5,112.49");
  expect(screen.getByText("Wallet and trading accounts")).toBeTruthy();
  const b = screen.getByTestId("home-breakdown");
  expect(within(b).getByTestId("breakdown-wallet")).toHaveTextContent("12.50");
  expect(within(b).getByTestId("breakdown-meridian")).toHaveTextContent("101.50");
  expect(within(b).getByTestId("breakdown-perpl")).toHaveTextContent("4,998.49");
  expect(within(b).getByTestId("breakdown-total")).toHaveTextContent("5,112.49");
  expect(screen.getByRole("button", { name: "See breakdown" })).toBeTruthy(); // the visible way into the sheet
});

it("Home: a part that can't be read ⇒ total '—' and the breakdown says why; open PnL ticks with each account read", async () => {
  const { auth, feed } = await setup();
  const { kit, accounts } = accountsKit({ meridian: meridianLong, perpl: { ...K3, otherMarkets: true, equityWad: undefined } });
  await act(async () => feed.push(bal(12_500_000n)));
  await render(wrap(auth, feed, <Home />, { trade: kit }));
  expect(screen.getByTestId("home-total")).toHaveTextContent("—");
  expect(screen.getByTestId("breakdown-perpl")).toHaveTextContent("—");
  expect(screen.getByTestId("breakdown-perpl-why")).toHaveTextContent(/another Perpl market/);
  expect(screen.getByTestId("home-pnl")).toHaveTextContent("—"); // the Perpl part is unknown too
  await act(async () => accounts.store.update({ atBlock: 2n, perpl: K3 }));
  // Meridian 2 − 0.5 funding, Perpl −1.469999 − 0.010530 ⇒ +0.019471 → "+0.01"
  expect(screen.getByTestId("home-pnl")).toHaveTextContent("+0.01");
  await act(async () => accounts.store.update({ atBlock: 3n, meridian: { ...meridianLong, upnlWad: 5n * WAD } }));
  expect(screen.getByTestId("home-pnl")).toHaveTextContent("+3.01");
});

it("Home positions: visible Close button (swipe fallback) opens the close summary; funding shown; a basis pair is grouped", async () => {
  const { auth, feed } = await setup();
  const live = fakeLive();
  live.meridian.store.update({ tickSizeWad: 10n ** 14n, lotSizeWad: WAD, markWad: 26n * 10n ** 15n, bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n });
  const short = mapMeridian({ collateral: 100n * WAD, size: -2600n * WAD, entryPrice: 25n * 10n ** 15n, unrealizedPnl: 0n, pendingFunding: -WAD, equity: 101n * WAD, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 3n * 10n ** 16n });
  const { kit } = accountsKit({ meridian: short, perpl: K3 });
  await act(async () => feed.push(bal(0n)));
  await render(wrap(auth, feed, <Home />, { trade: kit, live }));
  expect(screen.getByTestId("position-basis")).toHaveTextContent(/Basis trade/);
  expect(screen.getByTestId("position-meridian-funding")).toHaveTextContent("+1.00"); // −pending funding: received
  expect(screen.getByTestId("position-perpl-funding")).toHaveTextContent("−0.01");
  // per card: the swipe action + the always-visible Close button (ui/SwipeRow, WCAG 2.5.1)
  const visible = screen.getAllByRole("button", { name: "Close" }).filter((b) => b.props.hitSlop !== undefined);
  expect(visible).toHaveLength(2);
  await act(async () => fireEvent.press(visible[0]!));
  expect(screen.getByTestId("close-summary")).toHaveTextContent(/^Close short 2,600 MON on Meridian · worst price/);
});

it("Activity: rows newest first; a trade opens its receipt, a deposit its detail; Home shows the latest 3 and 'See all'", async () => {
  const { auth, feed } = await setup();
  const { kv } = memKv();
  const log = new ActivityLog(kv, "k");
  const rest = {
    fills: async () => ({ d: [], np: "" }),
    call: async () => ({ d: [1, 2, 3].map((i) => ({ at: { b: i, t: 1791300000000 + i * 1000, txid: "ab".repeat(32), l: i }, et: 1, a: `${i}000000` })), np: "" }),
  };
  const af = new ActivityFeed({ log, perpl: () => ({ rest, market: { id: 64, priceDecimals: 5, sizeDecimals: 0, collateralDecimals: 6 } }), perplOff: () => "off", meridian: undefined, explorerBase: undefined });
  await log.add({ atMs: 1791400000000, block: 9n, receipt: tradeReceipt });
  await act(async () => feed.push(bal(1_000_000n)));
  await render(wrap(auth, feed, <Home />, { activity: { log, feed: af } }));
  await act(async () => void (await af.refresh()));
  const list = screen.getByTestId("home-activity");
  expect(within(list).getAllByRole("button").map((b) => b.props.accessibilityLabel).filter((l: string) => /on (Perpl|Meridian)/.test(l))).toHaveLength(3);
  expect(within(list).getByText("1 more in Activity")).toBeTruthy();
  await act(async () => fireEvent.press(within(list).getByRole("button", { name: /^Long 600 MON on Perpl/ })));
  expect(receiptStore.get()).toBe(tradeReceipt);
  expect(mockRouter.push).toHaveBeenCalledWith("/receipt");
  await act(async () => fireEvent.press(within(list).getAllByRole("button", { name: /^Deposit to Perpl/ })[0]!));
  expect(mockRouter.push).toHaveBeenCalledWith("/activity-item");
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "See all" })));
  expect(mockRouter.push).toHaveBeenCalledWith("/activity");
});

it("Activity list: a source that's off or failed says so under the rows", async () => {
  const { kv } = memKv();
  const log = new ActivityLog(kv, "k");
  const af = new ActivityFeed({ log, perpl: () => undefined, perplOff: () => "Turn on Perpl trading (Settings) to see its history here.", meridian: undefined, explorerBase: undefined });
  await af.refresh();
  await render(<ActivityList store={af.store} />);
  expect(screen.getByTestId("activity-empty")).toHaveTextContent("Nothing yet. Deposits, trades and funding show up here.");
  expect(screen.getAllByTestId("activity-note").map((n) => n.props.children)).toEqual(["Turn on Perpl trading (Settings) to see its history here.", expect.stringMatching(/needs the indexer/)]);
});

it("Settings: alerts are off until turned on, saved, in-app only (no permission prompt); 'Open full terminal' opens the web app", async () => {
  const { auth, feed } = await setup();
  const { kv, map } = memKv();
  const settings = new AlertSettings(kv);
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  await render(
    wrap(
      auth,
      feed,
      <AlertsProvider settings={settings}>
        <AlertsCard />
      </AlertsProvider>,
    ),
  );
  expect(screen.getByText(ALERTS_SCOPE)).toBeTruthy();
  expect(ALERTS_SCOPE).toMatch(/while Meridian is open/);
  const liq = screen.getByTestId("alert-liq");
  expect(liq.props.value).toBe(false);
  expect(screen.getByTestId("alert-funding").props.value).toBe(false);
  await act(async () => fireEvent(liq, "valueChange", true));
  expect(screen.getByTestId("alert-liq").props.value).toBe(true);
  expect(JSON.parse(map.get("meridian.pref.alerts")!)).toEqual({ liq: true, funding: false });
  open.mockClear();
  await render(wrap(auth, feed, <Settings />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Open full terminal" })));
  expect(open).toHaveBeenCalledWith("https://meridian-testnet.vercel.app");
});

import CloseAll from "../app/close-all";
import { CloseAllExecutor, closeAllStore } from "../features/trade/exec/closeAll";

it("Close all: a hedged pair → plain summary → tap → Meridian first, then Perpl → outcome; reachable from Home's positions", async () => {
  const { auth, feed } = await setup();
  const live = fakeLive();
  live.meridian.store.update({ tickSizeWad: 10n ** 14n, lotSizeWad: WAD, markWad: 26n * 10n ** 15n, bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n });
  live.perpl.store.update({ bestBidWad: 2600n * 10n ** 13n, bestAskWad: 2610n * 10n ** 13n });
  const short = mapMeridian({ collateral: 100n * WAD, size: -2600n * WAD, entryPrice: 25n * 10n ** 15n, unrealizedPnl: 0n, pendingFunding: 0n, equity: 100n * WAD, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 0n });
  const { kit } = accountsKit({ meridian: short, perpl: K3 });
  const venues: string[] = [];
  const { kv } = memKv();
  const closeAll = new CloseAllExecutor({
    store: closeAllStore(kv, 10143, auth.account().address),
    legs: () => ({
      legs: {
        prepare: async (leg) => (venues.push(leg.venue), `${leg.venue}-ref`),
        send: async () => undefined,
        confirm: async (leg) => ({ filledWad: leg.sizeWad }),
      },
      findSentPerpl: async () => undefined,
      perplOrderId: () => undefined,
    }),
    busy: () => false,
    explorerBase: undefined,
    sleep: async () => undefined,
    afterTrade: () => undefined,
  });
  await act(async () => feed.push(bal(0n)));
  await render(wrap(auth, feed, <Home />, { trade: kit, live }));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Close all" })));
  expect(mockRouter.push).toHaveBeenCalledWith("/close-all");

  await render(wrap(auth, feed, <CloseAll />, { trade: { ...kit, closeAll }, live }));
  expect(screen.getByTestId("close-all-summary")).toHaveTextContent("Close the basis trade: short 2,600 MON on Meridian first, then the Perpl long for exactly what closed");
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Or tap here to close everything" })));
  await wait(10);
  expect(venues).toEqual(["meridian", "perpl"]);
  expect(screen.getByTestId("close-all-outcome")).toHaveTextContent(/Basis trade closed/);
  expect(screen.getByTestId("close-all-detail")).toHaveTextContent("Meridian closed 2,600 MON, then Perpl closed 2,600 MON. Nothing is left open.");
  expect(haptic.success).toHaveBeenCalled();
});

// ── N6 + N7: an Earn pair is grouped and closed by its record, with its lock first ──
import { SwapReader } from "../features/earn/data/swap";
import { earnReceiptStore, type EarnExecState, type EarnExecutor } from "../features/earn/executor";
import { FLAT, type EarnPosition } from "../features/earn/record";
import type { EarnTimeline } from "../features/earn/timeline";

const lvl = (px: bigint) => [{ priceWad: px, sizeWad: 100_000n * WAD }];
const shortMeridian = mapMeridian({ collateral: 100n * WAD, size: -2600n * WAD, entryPrice: 25n * 10n ** 15n, unrealizedPnl: 0n, pendingFunding: 0n, equity: 100n * WAD, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: 0n });
const CLOSED_T: EarnTimeline = { kind: "close", phase: "CLOSED", outcome: "success", headline: "Closed on both venues", body: "You're flat on both venues.", steps: [] };

function booksLive() {
  const live = fakeLive();
  live.meridian.store.update({ tickSizeWad: 10n ** 14n, lotSizeWad: WAD, markWad: 26n * 10n ** 15n, bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n, bookKnown: true, bids: lvl(26n * 10n ** 15n), asks: lvl(27n * 10n ** 15n), takerFeeWad: 5n * 10n ** 14n });
  live.perpl.store.update({ bestBidWad: 2600n * 10n ** 13n, bestAskWad: 2610n * 10n ** 13n, bookKnown: true, bids: lvl(2600n * 10n ** 13n), asks: lvl(2610n * 10n ** 13n) });
  return live;
}

/** The Earn kit: a record (position store) + a close spy; the wallet's swap account as the swap reader read it. */
function earnKit(pos: EarnPosition, lockWad: bigint | undefined) {
  const close = jest.fn(async () => CLOSED_T);
  const executor = { position: new Store(pos), store: new Store<EarnExecState>({ running: false, timeline: undefined, error: undefined }), close, loadPosition: async () => pos, resume: async () => undefined, noteManualClose: async () => undefined } as unknown as EarnExecutor;
  const swap = new SwapReader({ client: { multicall: jest.fn() } as never, market: "0x0000000000000000000000000000000000000001", book: "0x0000000000000000000000000000000000000002", clearingHouse: "0x0000000000000000000000000000000000000003", address: "0x0000000000000000000000000000000000000004" });
  if (lockWad !== undefined) swap.store.update({ atBlock: 1n, tickSizeWad: 10n ** 14n, lotSizeWad: 1_000n * WAD, bookKnown: true, bids: lvl(111n * 10n ** 16n), asks: lvl(113n * 10n ** 16n), account: { collateralWad: 7n * WAD, sizeWad: lockWad, kWad: 0n, avgFixedAprWad: 12n * 10n ** 16n } });
  return { kit: { executor, history: undefined, swap } as EarnKit, close };
}

it("Home groups an open Earn pair by its record ('Earn · basis'), not the size fallback; a record the venues don't hold says so", async () => {
  const { auth, feed } = await setup();
  const live = booksLive();
  const { kit } = accountsKit({ meridian: shortMeridian, perpl: K3 });
  await act(async () => feed.push(bal(0n)));
  const view = await render(wrap(auth, feed, <Home />, { trade: kit, live, earn: earnKit({ ...FLAT, perplSide: "buy", sizeWad: 2600n * WAD }, 0n).kit }));
  expect(screen.getByTestId("position-earn")).toHaveTextContent(/^Earn · basis · 2,600 MON each side/);
  expect(screen.queryByTestId("position-basis")).toBeNull();
  await act(async () => view.rerender(wrap(auth, feed, <Home />, { trade: kit, live, earn: earnKit({ ...FLAT, perplSide: "buy", sizeWad: 3000n * WAD }, 0n).kit })));
  expect(screen.getByTestId("position-earn-stale")).toHaveTextContent(/3,000 MON each side, but the venues no longer hold all of it\. Close it on Earn\./);
  expect(screen.queryByTestId("position-basis")).toBeNull();
});

it("Close all on a locked Earn pair: one summary (lock first), the Earn executor closes it with the lock order; the Earn receipt opens", async () => {
  const { auth, feed } = await setup();
  const live = booksLive();
  const { kit } = accountsKit({ meridian: shortMeridian, perpl: K3 });
  const venues: string[] = [];
  const closeAll = new CloseAllExecutor({ store: closeAllStore(memKv().kv, 10143, auth.account().address), legs: () => ({ legs: { prepare: async (leg) => (venues.push(leg.venue), "r"), send: async () => undefined, confirm: async (leg) => ({ filledWad: leg.sizeWad }) }, findSentPerpl: async () => undefined, perplOrderId: () => undefined }), busy: () => false, explorerBase: undefined, sleep: async () => undefined, afterTrade: () => undefined });
  const earn = earnKit({ ...FLAT, perplSide: "buy", sizeWad: 2600n * WAD }, -1_000n * WAD);
  await act(async () => feed.push(bal(0n)));
  await render(wrap(auth, feed, <CloseAll />, { trade: { ...kit, closeAll }, live, earn: earn.kit }));
  await wait(10);
  expect(screen.getByTestId("close-all-earn")).toHaveTextContent("Close the fixed-rate lock (1,000 MON) first, then the Earn position: 2,600 MON on Meridian first, then the same on Perpl");
  expect(screen.queryByTestId("close-all-summary")).toBeNull(); // not N7's size-only pair
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Or tap here to close everything" })));
  await wait(10);
  expect(earn.close).toHaveBeenCalledWith(expect.objectContaining({ meridianSide: "buy", perplSide: "sell", sizeWad: 2600n * WAD }), expect.objectContaining({ summary: "Close 2,600 MON on both venues" }), expect.objectContaining({ side: "buy", sizeWad: 1_000n * WAD }));
  expect(venues).toEqual([]); // N7's two-leg executor never saw the Earn pair
  expect(screen.getByTestId("close-all-outcome")).toHaveTextContent(/Closed on both venues/);
  await act(async () => fireEvent.press(screen.getByTestId("close-all-earn-receipt")));
  expect(earnReceiptStore.get()).toBe(CLOSED_T);
  expect(mockRouter.push).toHaveBeenCalledWith("/earn-receipt");
  earnReceiptStore.set(undefined);
});

it("Close all with a lock but no Earn record: refused with the reason and where to close it; nothing is sent", async () => {
  const { auth, feed } = await setup();
  const live = booksLive();
  const { kit } = accountsKit({ meridian: shortMeridian, perpl: K3 });
  const venues: string[] = [];
  const closeAll = new CloseAllExecutor({ store: closeAllStore(memKv().kv, 10143, auth.account().address), legs: () => ({ legs: { prepare: async (leg) => (venues.push(leg.venue), "r"), send: async () => undefined, confirm: async (leg) => ({ filledWad: leg.sizeWad }) }, findSentPerpl: async () => undefined, perplOrderId: () => undefined }), busy: () => false, explorerBase: undefined, sleep: async () => undefined, afterTrade: () => undefined });
  const earn = earnKit(FLAT, -1_000n * WAD);
  await act(async () => feed.push(bal(0n)));
  await render(wrap(auth, feed, <CloseAll />, { trade: { ...kit, closeAll }, live, earn: earn.kit }));
  await wait(10);
  expect(screen.getByTestId("close-all-error")).toHaveTextContent(/fixed-rate lock on 1,000 MON .* no Earn position for it, so Close all won't guess .* sends nothing\. Close the fixed-rate lock first/);
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Or tap here to close everything" })));
  await wait(10);
  expect(venues).toEqual([]);
  expect(earn.close).not.toHaveBeenCalled();
  expect(screen.queryByTestId("close-all-outcome")).toBeNull();
});
