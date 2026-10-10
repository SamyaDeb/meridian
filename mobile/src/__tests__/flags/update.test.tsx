// Forced update (N8, LAUNCH_PLAN §3.3): an app older than minAppVersion gets the full-screen "Update Meridian"; with no
// install link yet it asks people to contact the team; "Close my positions" always reaches the app (Home positions +
// Close all) in close-only mode, with every open refused. The app underneath stays mounted (persisted executors keep
// their state; resume still runs).
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true } }));

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FlagsProvider, useOpenBlocked } from "../../features/flags/FlagsProvider";
import { UPDATE_TEXT } from "../../features/flags/model";
import { UpdateGate } from "../../features/flags/UpdateGate";
import { LiveProvider } from "../../live/LiveProvider";
import type { Live } from "../../live/live";
import { Text } from "../../ui";
import { fakeLive } from "../fakeLive";
import { fakeFlags } from "./flagsFixtures";

const mockRouter = (jest.requireMock("expo-router") as { router: Record<"replace", jest.Mock> }).router;

let mounts = 0;
function App() {
  const why = useOpenBlocked("trade-meridian");
  return <Text testID="app">{why ?? "opens allowed"}</Text>;
}
function Counted() {
  mounts++;
  return <App />;
}

function wrap(live: Live, client: ReturnType<typeof fakeFlags>["client"]) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <LiveProvider live={live}>
        <FlagsProvider client={client}>
          <UpdateGate>
            <Counted />
          </UpdateGate>
        </FlagsProvider>
      </LiveProvider>
    </SafeAreaProvider>
  );
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

beforeEach(() => {
  jest.clearAllMocks();
  mounts = 0;
});

it("current build: no update screen", async () => {
  const f = fakeFlags({ appVersion: "0.2.0", flags: { minAppVersion: "0.2.0" } });
  await render(wrap(fakeLive().live, f.client));
  await settle();
  expect(screen.queryByTestId("update-screen")).toBeNull();
  expect(screen.getByTestId("app")).toHaveTextContent("opens allowed");
});

it("older build: Update Meridian, no install link yet ⇒ ask the team; Close my positions ⇒ the app in close-only mode", async () => {
  const f = fakeFlags({ appVersion: "0.2.0", flags: { minAppVersion: "0.3.0", message: "A fix for Earn closes is out." } });
  await render(wrap(fakeLive().live, f.client));
  await settle();
  expect(screen.getByTestId("update-screen")).toHaveTextContent(/Update Meridian/);
  expect(screen.getByTestId("update-screen")).toHaveTextContent(/A fix for Earn closes is out\./);
  expect(screen.getByTestId("update-versions")).toHaveTextContent(/needed: 0\.3\.0 or newer/);
  // fakeLive's config has no install link (none until the N8 builds exist)
  expect(screen.getByTestId("update-ask")).toHaveTextContent("Ask the Meridian team for the new version.");
  expect(screen.queryByTestId("update-install")).toBeNull();
  // the app stays mounted underneath (executors' state + resume untouched)
  expect(mounts).toBe(1);
  await fireEvent.press(screen.getByTestId("update-close-positions"));
  expect(mockRouter.replace).toHaveBeenCalledWith("/"); // → Unlock, or Home with positions + Close all
  expect(screen.queryByTestId("update-screen")).toBeNull();
  expect(screen.getByTestId("update-banner")).toBeTruthy();
  expect(screen.getByTestId("app")).toHaveTextContent(UPDATE_TEXT); // opens refused, closes never ask
  expect(mounts).toBe(1);
  // the banner brings the update screen back
  await fireEvent.press(screen.getByTestId("update-banner"));
  expect(screen.getByTestId("update-screen")).toBeTruthy();
});

it("with an install link: the button opens it", async () => {
  const f = fakeFlags({ appVersion: "0.2.0", flags: { minAppVersion: "0.3.0" } });
  const { live } = fakeLive();
  const withLink = { ...live, config: { ...live.config, installUrl: "https://example.test/meridian.apk" } } as Live;
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  await render(wrap(withLink, f.client));
  await settle();
  await fireEvent.press(screen.getByTestId("update-install"));
  expect(open).toHaveBeenCalledWith("https://example.test/meridian.apk");
});

it("minAppVersion lowered again ⇒ the update screen goes away on the next read", async () => {
  const f = fakeFlags({ appVersion: "0.2.0", flags: { minAppVersion: "0.3.0" } });
  await render(wrap(fakeLive().live, f.client));
  await settle();
  expect(screen.getByTestId("update-screen")).toBeTruthy();
  f.set({ minAppVersion: "0.1.0" });
  await act(async () => f.client.refresh());
  expect(screen.queryByTestId("update-screen")).toBeNull();
  expect(screen.getByTestId("app")).toHaveTextContent("opens allowed");
});
