// Create / sign-in / unlock / recovery screens with the fake WebAuthn client (no device, no network).
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../../auth/AuthProvider";
import { AuthController } from "../../auth/controller";
import { MESSAGES } from "../../auth/errors";
import { createFakeWebAuthnClient } from "../../auth/fakeWebAuthn";
import { LiveProvider } from "../../live/LiveProvider";
import { ToastProvider } from "../../ui";
import { fakeLive } from "../fakeLive";
import { READY_MS } from "../../features/auth/WalletReady";
import { haptic } from "../../ui/haptics";
import { DEV_CFG, makeAuth, manualClock, memoryKv } from "./authFixtures";

jest.mock("../../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));
const waitReady = () => act(async () => void (await new Promise((r) => setTimeout(r, READY_MS + 50))));

jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() }, Redirect: () => null }));
const mockRouter = (jest.requireMock("expo-router") as { router: Record<"replace" | "push" | "back", jest.Mock> }).router;

import Create, { CALM_CREATE, HERO_BODY, HERO_TITLE } from "../../app/(onboarding)/create";
import Welcome, { CALM_EXISTING } from "../../app/(onboarding)/welcome";
import Unlock from "../../app/(onboarding)/unlock";
import Recovery from "../../app/recovery";

function wrap(auth: AuthController, children: ReactNode) {
  const { live } = fakeLive();
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={live}>
        <AuthProvider controller={auth}>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </LiveProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => jest.clearAllMocks());

it("Welcome → passkey hero → OS sheet → 'Wallet ready ✓' (success haptic) → Home after 600 ms", async () => {
  const { auth, fake } = makeAuth();
  await auth.init();
  await render(wrap(auth, <Welcome />));
  // one primary button + a text link, no address anywhere
  expect(screen.getByRole("button", { name: "Continue with passkey" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use an existing passkey" })).toBeTruthy();
  expect(screen.getByTestId("passkey-icon", { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByText(/0x/)).toBeNull();
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Continue with passkey" })));
  expect(mockRouter.push).toHaveBeenCalledWith("/create"); // tap 1
  expect(fake.calls.create).toBe(0); // nothing asked of the authenticator before the hero

  await render(wrap(auth, <Create />));
  expect(screen.getByRole("header", { name: HERO_TITLE })).toBeTruthy();
  expect(screen.getByText(HERO_BODY)).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create my wallet" }))); // tap 2 → OS sheet
  expect(fake.calls.create).toBe(1);
  expect(auth.store.get().status).toBe("unlocked");
  expect(screen.getByTestId("wallet-ready")).toHaveTextContent("Wallet ready ✓");
  expect(screen.queryByText(/0x/)).toBeNull();
  expect(haptic.success).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  await waitReady();
  expect(mockRouter.replace).toHaveBeenCalledWith("/portfolio");
});

it("Create: cancelled OS sheet → calm line (no alert, no error haptic), still on the hero, locked", async () => {
  const { auth } = makeAuth({ fake: { failNext: [{ error: "UserCancelled", message: "The user cancelled the request." }] } });
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create my wallet" })));
  expect(screen.getByTestId("auth-calm")).toHaveTextContent(CALM_CREATE);
  expect(screen.queryByTestId("auth-error")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(haptic.error).not.toHaveBeenCalled();
  expect(auth.store.get().status).toBe("locked");
  expect(screen.getByRole("button", { name: "Create my wallet" })).toBeEnabled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it("Create: provider without PRF → plain message", async () => {
  const { auth } = makeAuth({ fake: { noPrf: true } });
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create my wallet" })));
  expect(screen.getByTestId("auth-error")).toHaveTextContent(MESSAGES.prfUnavailable);
  expect(haptic.error).toHaveBeenCalledTimes(1);
});

it("Welcome: 'Use an existing passkey' signs in right there → 'Wallet ready' → Home", async () => {
  const first = makeAuth();
  await first.auth.init();
  await first.auth.create();
  const auth = new AuthController({ cfg: DEV_CFG, kv: memoryKv(), webAuthnClient: first.fake, clock: manualClock() });
  await auth.init();
  await render(wrap(auth, <Welcome />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Use an existing passkey" })));
  expect(auth.account().address).toBe(first.auth.account().address);
  expect(screen.getByTestId("wallet-ready")).toBeTruthy();
  await waitReady();
  expect(mockRouter.replace).toHaveBeenCalledWith("/portfolio");
});

it("Welcome: cancelling 'Use an existing passkey' → calm line, no red", async () => {
  const { auth } = makeAuth({ fake: { failNext: [{ error: "UserCancelled", message: "cancelled" }] } });
  await auth.init();
  await render(wrap(auth, <Welcome />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Use an existing passkey" })));
  expect(screen.getByTestId("auth-calm")).toHaveTextContent(CALM_EXISTING);
  expect(screen.queryByTestId("auth-error")).toBeNull();
});

it("Welcome: a wallet on this phone → identicon + 'Wallet ••xxxx' and 'Unlock with your fingerprint', never the hex", async () => {
  const kv = memoryKv();
  const first = makeAuth({ kv });
  await first.auth.init();
  await first.auth.create();
  const addr = first.auth.account().address;
  const auth = new AuthController({ cfg: DEV_CFG, kv, webAuthnClient: first.fake, clock: manualClock() });
  await auth.init();
  await render(wrap(auth, <Welcome />));
  expect(screen.getByText(`Wallet ••${addr.slice(-4).toLowerCase()}`)).toBeTruthy();
  expect(screen.getByTestId("identicon", { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByText(/0x/)).toBeNull();
  expect(screen.getByRole("button", { name: "Unlock with your fingerprint" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue with passkey" })).toBeNull();
});

it("Create: wrong rpId for the build → buttons disabled, nothing asked of the authenticator", async () => {
  const fake = createFakeWebAuthnClient({ seed: "x" });
  const auth = new AuthController({ cfg: { ...DEV_CFG, rpId: "evil.example" }, kv: memoryKv(), webAuthnClient: fake, clock: manualClock() });
  await render(wrap(auth, <Create />));
  expect(screen.getByText("Passkeys are off in this build")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create my wallet" })).toBeDisabled();
  expect(fake.calls.create).toBe(0);
});

it("Unlock: a fresh launch prompts once by itself and unlocks the same address", async () => {
  const kv = memoryKv();
  const first = makeAuth({ kv });
  await first.auth.init();
  await first.auth.create();
  const addr = first.auth.account().address;
  const auth = new AuthController({ cfg: DEV_CFG, kv, webAuthnClient: first.fake, clock: manualClock() });
  await render(wrap(auth, <Unlock />));
  await act(async () => undefined);
  expect(auth.account().address).toBe(addr);
  expect(first.fake.calls.get).toBe(1);
  expect(mockRouter.replace).toHaveBeenCalledWith("/portfolio");
  expect(screen.queryByText(/0x/)).toBeNull();
});

it("Unlock: after an idle lock it waits for a tap (no surprise prompt)", async () => {
  const { auth, fake } = makeAuth();
  await auth.init();
  await auth.create();
  auth.lock("idle");
  await render(wrap(auth, <Unlock />));
  await act(async () => undefined);
  expect(fake.calls.get).toBe(0);
  expect(screen.getByText("Locked after 10 minutes without activity.")).toBeTruthy();
  const hint = (auth.store.get() as { addressHint?: string }).addressHint!;
  expect(screen.getByText(`Wallet ••${hint.slice(-4).toLowerCase()}`)).toBeTruthy();
  expect(screen.queryByText(/0x/)).toBeNull();
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Unlock with your fingerprint" })));
  expect(auth.store.get().status).toBe("unlocked");
});

it("Recovery: fresh prompt → 24 words; leaving the app hides them; screenshots blocked", async () => {
  const listeners: ((s: string) => void)[] = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_t, fn) => {
    listeners.push(fn as (s: string) => void);
    return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
  });
  const { auth, fake } = makeAuth();
  await auth.init();
  await auth.create();
  await render(wrap(auth, <Recovery />));
  const { usePreventScreenCapture } = jest.requireMock("expo-screen-capture") as { usePreventScreenCapture: jest.Mock };
  expect(usePreventScreenCapture).toHaveBeenCalledWith("recovery-phrase");
  expect(screen.queryByTestId("recovery-words")).toBeNull();
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Show my recovery phrase" })));
  expect(fake.calls.get).toBe(1);
  expect(screen.getAllByLabelText(/^Word \d+: /)).toHaveLength(24);
  await act(async () => listeners.forEach((l) => l("background")));
  expect(screen.queryByTestId("recovery-words")).toBeNull();
});
