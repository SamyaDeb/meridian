import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text, ToastProvider, useToast } from "../ui";

jest.mock("../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));

jest.useFakeTimers();

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function Trigger() {
  const toast = useToast();
  return (
    <Pressable accessibilityRole="button" onPress={() => toast("Copied")}>
      <Text>show</Text>
    </Pressable>
  );
}

it("hides after 3 s and leaves no timer behind on unmount", async () => {
  const { unmount } = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    </SafeAreaProvider>,
  );
  await fireEvent.press(screen.getByRole("button"));
  expect(screen.getByText("Copied")).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(3_100));
  expect(screen.queryByText("Copied")).toBeNull();

  const set = jest.spyOn(globalThis, "setTimeout");
  const clear = jest.spyOn(globalThis, "clearTimeout");
  await fireEvent.press(screen.getByRole("button"));
  const hide = set.mock.results[set.mock.calls.findIndex((call) => call[1] === 3_000)]?.value;
  expect(hide).toBeDefined();
  await unmount();
  // the pending 3 s hide is cleared with the provider (a leaked timer kept jest workers alive)
  expect(clear).toHaveBeenCalledWith(hide);
});
