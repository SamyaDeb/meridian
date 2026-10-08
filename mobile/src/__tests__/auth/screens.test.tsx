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
import { DEV_CFG, makeAuth, manualClock, memoryKv } from "./authFixtures";

jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() }, Redirect: () => null }));
const mockRouter = (jest.requireMock("expo-router") as { router: Record<"replace" | "push" | "back", jest.Mock> }).router;

import Create from "../../app/(onboarding)/create";
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

it("Create: fingerprint → wallet created → Fund", async () => {
  const { auth } = makeAuth();
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create with fingerprint / face" })));
  expect(auth.store.get().status).toBe("unlocked");
  expect(mockRouter.replace).toHaveBeenCalledWith("/fund");
});

it("Create: cancelled prompt → 'Cancelled. Try again.' and still locked", async () => {
  const { auth } = makeAuth({ fake: { failNext: [{ error: "UserCancelled", message: "The user cancelled the request." }] } });
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create with fingerprint / face" })));
  expect(screen.getByTestId("auth-error")).toHaveTextContent("Cancelled. Try again.");
  expect(auth.store.get().status).toBe("locked");
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it("Create: provider without PRF → plain message", async () => {
  const { auth } = makeAuth({ fake: { noPrf: true } });
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Create with fingerprint / face" })));
  expect(screen.getByTestId("auth-error")).toHaveTextContent(MESSAGES.prfUnavailable);
});

it("Create: 'I already have one' signs in with an existing passkey → Trade", async () => {
  const first = makeAuth();
  await first.auth.init();
  await first.auth.create();
  const auth = new AuthController({ cfg: DEV_CFG, kv: memoryKv(), webAuthnClient: first.fake, clock: manualClock() });
  await render(wrap(auth, <Create />));
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "I already have one" })));
  expect(auth.account().address).toBe(first.auth.account().address);
  expect(mockRouter.replace).toHaveBeenCalledWith("/trade");
});

it("Create: wrong rpId for the build → buttons disabled, nothing asked of the authenticator", async () => {
  const fake = createFakeWebAuthnClient({ seed: "x" });
  const auth = new AuthController({ cfg: { ...DEV_CFG, rpId: "evil.example" }, kv: memoryKv(), webAuthnClient: fake, clock: manualClock() });
  await render(wrap(auth, <Create />));
  expect(screen.getByText("Passkeys are off in this build")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create with fingerprint / face" })).toBeDisabled();
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
  expect(mockRouter.replace).toHaveBeenCalledWith("/trade");
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
  await act(async () => fireEvent.press(screen.getByRole("button", { name: "Unlock" })));
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
