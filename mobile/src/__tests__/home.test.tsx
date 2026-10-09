// N4b Home / Add funds / Settings passkey card / tab order, offline: the wallet feed is injected and fed by hand.
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../auth/AuthProvider";
import type { AuthController } from "../auth/controller";
import { WalletFeedProvider } from "../features/wallet/WalletFeedProvider";
import { LiveProvider } from "../live/LiveProvider";
import { COUNT_UP_MS, ToastProvider } from "../ui";
import { haptic } from "../ui/haptics";
import type { BalanceState } from "../wallet/balances";
import { WalletFeedStore } from "../wallet/feed";
import { makeAuth } from "./auth/authFixtures";
import { fakeLive } from "./fakeLive";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
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

function wrap(auth: AuthController, feed: WalletFeedStore, children: ReactNode) {
  const { live } = fakeLive();
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={live}>
        <AuthProvider controller={auth}>
          <ToastProvider>
            <WalletFeedProvider feed={feed} read={false}>
              {children}
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
