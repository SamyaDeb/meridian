// (onboarding)/perpl renders what was DETECTED: each state → which check is next, the live minimum, the order switch
// after an enrol 404, READY with the account and free collateral. Offline (fake Perpl + chain, fake passkey).
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Address } from "viem";
import { AuthProvider } from "../../auth/AuthProvider";
import type { AuthController } from "../../auth/controller";
import { LiveProvider } from "../../live/LiveProvider";
import { ToastProvider } from "../../ui";
import { PerplProvider } from "../../venues/perpl/PerplProvider";
import { PerplTokenStore } from "../../venues/perpl/tokenStore";
import { TradingSocketManager } from "../../venues/perpl/tradingSocket";
import { PerplVenue } from "../../venues/perpl/venue";
import { makeAuth, memoryKv } from "../auth/authFixtures";
import { fakeLive } from "../fakeLive";
import { deployment, FakeChain, FakePerpl } from "./perplFixtures";

jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true }, Redirect: () => null }));

import { PerplOnboardingScreen } from "../../features/perpl/PerplOnboarding";

const dep = deployment(10143);

async function setup(profileKnown: boolean) {
  const kv = memoryKv();
  const tokens = new PerplTokenStore(kv);
  const { auth } = makeAuth({ kv, deps: { perpl: { chainId: 10143, rotationFor: async (a: Address) => (await tokens.read(10143, a))?.rotation ?? 0 } } });
  await auth.init();
  await auth.create();
  const address = auth.account().address;
  const perpl = new FakePerpl();
  if (profileKnown) perpl.profiles.add(address.toLowerCase());
  const chain = new FakeChain(perpl, dep);
  chain.balances.set(address.toLowerCase(), 250_000_000n);
  const socket = new TradingSocketManager(() => undefined);
  const venue = new PerplVenue({
    deployment: dep,
    chainId: 10143,
    address,
    wsUrl: "wss://test.invalid",
    auth,
    tokens,
    chain: chain as never,
    sendWith: chain.sendWith,
    fetchFn: perpl.fetch,
    wsFactory: () => {
      throw new Error("no sockets in this test");
    },
    random: (n) => new Uint8Array(n),
    now: () => 1_791_400_000_000,
    socket,
    client: { getContext: async () => ({ chain: { chain_id: 10143 }, markets: [{ id: 64, symbol: "MON", name: "MON Perp", funding_interval_sec: 2580, funding_interval_blocks: 8571, order_ttl_blocks: 20, config: { is_open: true, price_decimals: 5, size_decimals: 0 } }] }) } as never,
  });
  return { auth, venue, chain, perpl };
}

function wrap(auth: AuthController, venue: PerplVenue, children: ReactNode) {
  const { live } = fakeLive();
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={live}>
        <AuthProvider controller={auth}>
          <PerplProvider venue={venue}>
            <ToastProvider>{children}</ToastProvider>
          </PerplProvider>
        </AuthProvider>
      </LiveProvider>
    </SafeAreaProvider>
  );
}

const chips = () => ({ key: screen.getByTestId("chip-key"), deposit: screen.getByTestId("chip-deposit"), fwd: screen.getByTestId("chip-forwarding") });

it("NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → READY, each step one tap, each state detected", async () => {
  const h = await setup(true);
  await act(async () => void (await h.venue.refresh()));
  await render(wrap(h.auth, h.venue, <PerplOnboardingScreen />));
  expect(chips().key).toHaveTextContent("Next");
  expect(chips().deposit).toHaveTextContent("After the step above"); // chain read: no account yet
  expect(screen.getByText(/Add ~0.5 MON for network fees/)).toBeTruthy();

  await act(async () => fireEvent.press(screen.getByTestId("btn-enroll")));
  expect(chips().key).toHaveTextContent("✓ Done");
  expect(chips().deposit).toHaveTextContent("Next");
  expect(screen.getByTestId("deposit-min")).toHaveTextContent("Minimum 100 AUSD (read from Perpl now) · in your wallet 250 AUSD");

  await act(async () => fireEvent.press(screen.getByTestId("btn-min")));
  await act(async () => fireEvent.press(screen.getByTestId("btn-deposit")));
  expect(h.chain.txs.map((t) => t.functionName)).toEqual(["approve", "createAccount"]);
  expect(chips().deposit).toHaveTextContent("✓ Done");
  expect(chips().fwd).toHaveTextContent("Next");
  expect(screen.getByTestId("tx-list")).toHaveTextContent(/approve · block/);

  await act(async () => fireEvent.press(screen.getByTestId("btn-forwarding")));
  expect(screen.getByTestId("perpl-ready")).toHaveTextContent(/Perpl is ready/);
  expect(screen.getByTestId("perpl-ready")).toHaveTextContent(/Account #1000/);
  expect(screen.getByTestId("free-collateral")).toBeTruthy();
  expect(screen.queryByTestId("gas-card")).toBeNull();
  expect(h.venue.socket.store.get().opens).toBe(0); // factory returns nothing in this test: no socket
});

it("enrol 404 (wallet unknown to Perpl) → the deposit check moves to the top and becomes Next", async () => {
  const h = await setup(false);
  await act(async () => void (await h.venue.refresh()));
  await render(wrap(h.auth, h.venue, <PerplOnboardingScreen />));
  await act(async () => fireEvent.press(screen.getByTestId("btn-enroll")));
  expect(screen.getByTestId("perpl-error")).toHaveTextContent(/deposit first/);
  expect(chips().deposit).toHaveTextContent("Next");
  expect(chips().key).toHaveTextContent("After the step above");
  const titles = screen.getAllByText(/^\d\. /).map((n) => (n.props.children as unknown[]).join(""));
  expect(titles[0]).toMatch(/^1\. Deposit AUSD/);
});

it("a deposit below the minimum shows the plain error and sends nothing", async () => {
  const h = await setup(true);
  await act(async () => void (await h.venue.refresh()));
  await h.venue.onboarding.enroll();
  await render(wrap(h.auth, h.venue, <PerplOnboardingScreen />));
  await act(async () => fireEvent.changeText(screen.getByTestId("deposit-input"), "50"));
  await act(async () => fireEvent.press(screen.getByTestId("btn-deposit")));
  expect(screen.getByTestId("perpl-error")).toHaveTextContent("Perpl needs at least 100 AUSD to open your account");
  expect(h.chain.txs).toHaveLength(0);
});

it("memoryKv is the only store touched (no SecureStore in this test)", () => {
  expect(memoryKv().data.size).toBe(0);
});
