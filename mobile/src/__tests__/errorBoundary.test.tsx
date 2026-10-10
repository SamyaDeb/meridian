// N8 D4.2: the calm error screen, mounted by expo-router's own boundary (`Try`, what an `ErrorBoundary` export becomes)
// at the root and on every tab. A throwing child shows "Something went wrong" with Retry (re-renders the route) and a
// Home path; nothing in storage is touched, so persisted runs still resume on the next unlock.
jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("expo-splash-screen", () => ({ hideAsync: jest.fn(async () => undefined), preventAutoHideAsync: jest.fn() }));

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Try } from "expo-router/build/views/Try";
import { ErrorScreen } from "../features/shell/ErrorScreen";
import { Text } from "../ui";
import { fs, path, SRC_DIR } from "./node";

const mockRouter = (jest.requireMock("expo-router") as { router: Record<"replace", jest.Mock> }).router;

let fail = true;
function Flaky() {
  if (fail) throw new Error("boom: undefined is not an object");
  return <Text testID="route">route content</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  fail = true;
  jest.spyOn(console, "error").mockImplementation(() => undefined); // React logs the caught error
});
afterEach(() => jest.restoreAllMocks());

it("a throwing child ⇒ the calm screen; Retry re-renders the route once it works", async () => {
  await render(
    <Try catch={ErrorScreen}>
      <Flaky />
    </Try>,
  );
  expect(screen.getByTestId("error-screen")).toHaveTextContent(/Something went wrong/);
  expect(screen.getByTestId("error-screen")).toHaveTextContent(/Your funds and any order in progress are safe/);
  // __DEV__ in jest: the message helps the developer; release bundles don't render it
  expect(screen.getByTestId("error-detail")).toHaveTextContent("boom: undefined is not an object");
  fail = false;
  await act(async () => void fireEvent.press(screen.getByTestId("error-retry")));
  expect(screen.queryByTestId("error-screen")).toBeNull();
  expect(screen.getByTestId("route")).toHaveTextContent("route content");
});

it("Retry while it still fails keeps the calm screen; Home goes to the anchor route (Unlock or Home)", async () => {
  await render(
    <Try catch={ErrorScreen}>
      <Flaky />
    </Try>,
  );
  await act(async () => void fireEvent.press(screen.getByTestId("error-retry")));
  expect(screen.getByTestId("error-screen")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("error-home"));
  expect(mockRouter.replace).toHaveBeenCalledWith("/");
});

it("the screen imports nothing that can touch storage: persisted runs survive a crash and resume on the next unlock", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "features", "shell", "ErrorScreen.tsx"), "utf8");
  const imports = src.split("\n").filter((l) => l.startsWith("import "));
  expect(imports).toEqual(['import type { ErrorBoundaryProps } from "expo-router";', 'import { router } from "expo-router";', 'import { StyleSheet, View } from "react-native";', 'import { Button, colors, space, Text } from "../../ui";']);
});

it("the root layout and every tab export the boundary", () => {
  for (const f of [["_layout.tsx"], ["(tabs)", "portfolio.tsx"], ["(tabs)", "trade.tsx"], ["(tabs)", "earn.tsx"], ["(tabs)", "settings.tsx"]]) {
    const src = fs.readFileSync(path.join(SRC_DIR, "app", ...f), "utf8");
    expect(src).toMatch(/export \{ ErrorScreen as ErrorBoundary \} from "[./]+features\/shell\/ErrorScreen";/);
  }
});
